import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { executeBackend } from "./backend-runner.ts";
import { resolveRunSettings } from "./config.ts";
import {
  computeWorkspaceFingerprint,
  createIsolatedWorktree,
  diffFingerprints,
  findBoundaryViolations,
} from "./fingerprint.ts";
import {
  acquireWriterLock,
  killProcessGroup,
  releaseWriterLock,
  updateWriterLockPid,
} from "./lock.ts";
import { buildExecutionPrompt, loadPacketFromSource, validateHandoffPacket } from "./packet.ts";
import {
  BUNDLED_SCHEMAS_DIR,
  CLI_ENTRYPOINT,
  canonicalizeCwd,
  ensureDir,
  getRunsDir,
} from "./paths.ts";
import { applyDispositions } from "./schema-validate.ts";
import {
  createTaskExclusive,
  loadRun,
  loadTask,
  refreshRunFreshness,
  saveRun,
  saveTask,
} from "./store.ts";
import type {
  CommandKind,
  FailureKind,
  FindingDispositionInput,
  HandoffPacket,
  ReviewOutput,
  RunRecord,
  SandboxMode,
  TaskRecord,
} from "./types.ts";

export interface StartRunOptions {
  command: CommandKind;
  cwd?: string;
  task_id?: string;
  packet_source?: string;
  packet_inline?: unknown;
  role?: string;
  backend?: string;
  model?: string;
  effort?: string;
  timeout_sec?: number;
  resume?: boolean;
  worktree?: boolean;
  background?: boolean;
}

function makeId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(3).toString("hex");
  return `${prefix}-${stamp}-${rand}`;
}

export function checkAntiRecursion(): { ok: true } | { ok: false; failure_kind: FailureKind; message: string } {
  if (process.env.AGY_ORCH_ACTIVE === "1") {
    return {
      ok: false,
      failure_kind: "recursion_blocked",
      message: `Refusing nested agy-orch execution (AGY_ORCH_ACTIVE=1, parent run=${process.env.AGY_ORCH_RUN_ID ?? "unknown"})`,
    };
  }
  return { ok: true };
}

function resolvePacketImages(
  images: string[] | undefined,
  baseCwd: string
): { ok: true; images: string[] } | { ok: false; error: string } {
  if (!images || images.length === 0) {
    return { ok: true, images: [] };
  }
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const raw of images) {
    const trimmed = raw.trim();
    const candidate = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(baseCwd, trimmed);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(candidate);
    } catch {
      return { ok: false, error: `Image attachment does not exist or is not accessible: ${trimmed}` };
    }
    if (!stat.isFile()) {
      return { ok: false, error: `Image attachment must be a regular file: ${trimmed}` };
    }
    try {
      fs.accessSync(candidate, fs.constants.R_OK);
    } catch {
      return { ok: false, error: `Image attachment is not readable: ${trimmed}` };
    }
    const real = fs.realpathSync(candidate);
    if (!seen.has(real)) {
      seen.add(real);
      resolved.push(real);
    }
  }
  return { ok: true, images: resolved };
}

function makeErrorResult(failure_kind: FailureKind, failure_message: string) {
  return {
    ok: false,
    execution_status: "failed" as const,
    acceptance_status: "blocked" as const,
    failure_kind,
    failure_message,
  };
}

function computeNextRound(command: CommandKind, existingTask: TaskRecord | null): number {
  if (!existingTask) return command === "delegate" ? 0 : 1;
  if (command === "delegate") return existingTask.round;
  return existingTask.round + 1;
}

function determineReviewAcceptance(output: ReviewOutput): RunRecord["acceptance_status"] {
  const hasRealOrGap = output.findings.some(
    (f) => f.category === "real_defect" || f.category === "requirement_gap"
  );
  const hasBlocking = output.findings.some((f) => f.blocking);
  if (output.verdict === "approve" && !hasRealOrGap && !hasBlocking) {
    return "approved";
  }
  if (output.findings.length > 0) {
    return "pending_triage";
  }
  return output.verdict === "blocked" ? "blocked" : "changes_requested";
}

interface PreparedRunContext {
  run: RunRecord;
  task: TaskRecord;
  packet: HandoffPacket;
  prompt: string;
  schemaPath: string;
  backendDiscovered: NonNullable<ReturnType<typeof resolveRunSettings>["backend_profile"]>;
  lockAcquired: boolean;
}

function prepareRun(opts: StartRunOptions):
  | { ok: true; ctx: PreparedRunContext }
  | { ok: false; error: ReturnType<typeof makeErrorResult> } {
  const recGuard = checkAntiRecursion();
  if (!recGuard.ok) {
    return { ok: false, error: makeErrorResult(recGuard.failure_kind, recGuard.message) };
  }

  const baseCwd = canonicalizeCwd(opts.cwd);
  if (!fs.existsSync(baseCwd)) {
    return {
      ok: false,
      error: makeErrorResult("invalid_parameter", `Working directory does not exist: ${baseCwd}`),
    };
  }

  let rawPacket: unknown;
  try {
    if (opts.packet_inline !== undefined) {
      rawPacket = opts.packet_inline;
    } else if (opts.packet_source) {
      rawPacket = loadPacketFromSource(opts.packet_source);
    } else {
      return {
        ok: false,
        error: makeErrorResult("invalid_packet", "Missing required --packet <json-file|->"),
      };
    }
  } catch (err) {
    return {
      ok: false,
      error: makeErrorResult(
        "invalid_packet",
        `Failed to parse handoff packet JSON: ${err instanceof Error ? err.message : String(err)}`
      ),
    };
  }

  const packetCheck = validateHandoffPacket(rawPacket, opts.command);
  if (!packetCheck.ok) {
    return {
      ok: false,
      error: makeErrorResult("invalid_packet", packetCheck.errors.join("; ")),
    };
  }
  const packet = packetCheck.packet;

  const defaultRole = opts.command === "delegate" ? "implementer" : "reviewer";
  const resolved = resolveRunSettings({
    cwd: baseCwd,
    role: opts.role ?? defaultRole,
    backend: opts.backend,
    model: opts.model,
    effort: opts.effort,
    timeout_sec: opts.timeout_sec,
  });

  const taskId = opts.task_id?.trim() || makeId("task");
  const existingTask = loadTask(taskId);
  if (existingTask) {
    const mismatchKind = opts.resume ? "resume_error" : "invalid_parameter";
    const mismatchPrefix = opts.resume ? "--resume " : "";
    if (existingTask.cwd !== baseCwd) {
      return {
        ok: false,
        error: makeErrorResult(
          mismatchKind,
          `${mismatchPrefix}cwd mismatch for task '${taskId}': expected '${existingTask.cwd}', got '${baseCwd}'`
        ),
      };
    }
    if (existingTask.backend !== resolved.backend) {
      return {
        ok: false,
        error: makeErrorResult(
          mismatchKind,
          `${mismatchPrefix}backend mismatch for task '${taskId}': expected '${existingTask.backend}', got '${resolved.backend}'`
        ),
      };
    }
  }

  if (!resolved.backend_profile) {
    return {
      ok: false,
      error: makeErrorResult(
        "backend_unavailable",
        `Backend '${resolved.backend}' not found in bundled or user backend profiles`
      ),
    };
  }

  if (!resolved.backend_profile.available) {
    return {
      ok: false,
      error: makeErrorResult(
        "backend_unavailable",
        `Backend '${resolved.backend}' binary '${resolved.backend_profile.binary}' is not executable or not in PATH`
      ),
    };
  }

  const imageCheck = resolvePacketImages(packet.images, baseCwd);
  if (!imageCheck.ok) {
    return {
      ok: false,
      error: makeErrorResult("invalid_packet", imageCheck.error),
    };
  }
  if (imageCheck.images.length > 0) {
    const profile = resolved.backend_profile.profile;
    if (!profile.capabilities.image || !profile.exec.image_flag) {
      return {
        ok: false,
        error: makeErrorResult(
          "invalid_parameter",
          `Backend '${resolved.backend}' does not support image attachments (packet.images)`
        ),
      };
    }
  }
  const normalizedPacket: HandoffPacket =
    imageCheck.images.length > 0 ? { ...packet, images: imageCheck.images } : packet;

  if (opts.resume && !opts.task_id) {
    return {
      ok: false,
      error: makeErrorResult("resume_error", "--resume requires an explicit --task-id"),
    };
  }

  let resumeSessionId: string | null = null;

  if (opts.resume) {
    if (!existingTask) {
      return {
        ok: false,
        error: makeErrorResult("resume_error", `No stored task state found for task_id '${taskId}'`),
      };
    }
    if (!existingTask.backend_session_id) {
      return {
        ok: false,
        error: makeErrorResult(
          "resume_error",
          `Task '${taskId}' has no stored backend_session_id (refusing --last fallback)`
        ),
      };
    }
    if (!resolved.backend_profile.profile.resume.supported) {
      return {
        ok: false,
        error: makeErrorResult(
          "resume_error",
          `Backend '${resolved.backend}' does not support explicit session resume`
        ),
      };
    }
    resumeSessionId = existingTask.backend_session_id;
  }

  const runId = makeId("run");
  let effectiveCwd = baseCwd;
  let worktreePath: string | null = null;

  if (opts.worktree) {
    const wt = createIsolatedWorktree(baseCwd, runId);
    if (!wt.ok) {
      return {
        ok: false,
        error: makeErrorResult("git_error", `Failed to create isolated git worktree: ${wt.error}`),
      };
    }
    effectiveCwd = canonicalizeCwd(wt.worktreePath);
    worktreePath = effectiveCwd;
  }

  let lockAcquired = false;
  if (opts.command === "delegate") {
    const lockRes = acquireWriterLock(effectiveCwd, runId, taskId);
    if (!lockRes.acquired) {
      return {
        ok: false,
        error: makeErrorResult(
          "writer_lock_held",
          `Another delegate run (${lockRes.existing.run_id}, task=${lockRes.existing.task_id}, pid=${lockRes.existing.pid}) holds writer lock for ${effectiveCwd}. Use --worktree for isolated parallel execution.`
        ),
      };
    }
    lockAcquired = true;
  }

  const sandbox: SandboxMode = opts.command === "delegate" ? "workspace-write" : "read-only";
  const schemaPath = path.join(
    BUNDLED_SCHEMAS_DIR,
    opts.command === "delegate" ? "delegate-output.schema.json" : "review-output.schema.json"
  );
  const runsDir = getRunsDir();
  ensureDir(runsDir);

  const preFingerprint = computeWorkspaceFingerprint(effectiveCwd);
  const depth = Number(process.env.AGY_ORCH_DEPTH ?? "0") + 1;
  const prompt = buildExecutionPrompt(
    opts.command,
    normalizedPacket,
    runId,
    taskId,
    depth,
    Boolean(resumeSessionId)
  );
  const promptPath = path.join(runsDir, `${runId}.prompt.txt`);
  fs.writeFileSync(promptPath, prompt, "utf8");

  const round = computeNextRound(opts.command, existingTask);
  const now = new Date().toISOString();

  const run: RunRecord = {
    run_id: runId,
    task_id: taskId,
    command: opts.command,
    role: resolved.role,
    backend: resolved.backend,
    model: resolved.model,
    effort: resolved.effort,
    sandbox,
    timeout_sec: resolved.timeout_sec,
    round,
    max_rounds: resolved.max_rounds,
    resumed_from_session_id: resumeSessionId,
    cwd: baseCwd,
    effective_cwd: effectiveCwd,
    worktree_path: worktreePath,
    execution_status: "running",
    acceptance_status: "pending_triage",
    failure_kind: null,
    failure_message: null,
    pid: null,
    pgid: null,
    worker_pid: null,
    exit_code: null,
    signal: null,
    backend_session_id: resumeSessionId,
    pre_fingerprint: preFingerprint,
    post_fingerprint: null,
    changed_files: [],
    boundary_violation: false,
    boundary_violations: [],
    verdict_valid: false,
    freshness_status: opts.command === "review-changes" ? "fresh" : "not_applicable",
    parsed_output: null,
    dispositions: [],
    started_at: now,
    ended_at: null,
    raw_events_path: path.join(runsDir, `${runId}.events.jsonl`),
    stderr_path: path.join(runsDir, `${runId}.stderr.log`),
    prompt_path: promptPath,
    last_message_path: path.join(runsDir, `${runId}.last.json`),
  };

  const task: TaskRecord = existingTask
    ? {
        ...existingTask,
        round,
        max_rounds: resolved.max_rounds,
        latest_run_id: runId,
        run_ids: [...existingTask.run_ids, runId],
        updated_at: now,
      }
    : {
        task_id: taskId,
        cwd: baseCwd,
        backend: resolved.backend,
        backend_session_id: null,
        round,
        max_rounds: resolved.max_rounds,
        latest_run_id: runId,
        run_ids: [runId],
        created_at: now,
        updated_at: now,
      };

  let persistedTask = task;
  if (existingTask) {
    saveTask(persistedTask);
  } else {
    const created = createTaskExclusive(persistedTask);
    if (!created.created) {
      const raced = created.existing;
      if (raced && (raced.cwd !== baseCwd || raced.backend !== resolved.backend)) {
        if (lockAcquired) {
          releaseWriterLock(effectiveCwd, runId);
        }
        const field = raced.cwd !== baseCwd ? "cwd" : "backend";
        const expected = field === "cwd" ? raced.cwd : raced.backend;
        const got = field === "cwd" ? baseCwd : resolved.backend;
        return {
          ok: false,
          error: makeErrorResult(
            opts.resume ? "resume_error" : "invalid_parameter",
            `Concurrent ${field} mismatch for task '${taskId}': expected '${expected}', got '${got}'`
          ),
        };
      }
      if (raced) {
        persistedTask = {
          ...raced,
          round: computeNextRound(opts.command, raced),
          max_rounds: resolved.max_rounds,
          latest_run_id: runId,
          run_ids: [...raced.run_ids, runId],
          updated_at: now,
        };
        run.round = persistedTask.round;
      }
      saveTask(persistedTask);
    }
  }
  saveRun(run);

  return {
    ok: true,
    ctx: {
      run,
      task: persistedTask,
      packet: normalizedPacket,
      prompt,
      schemaPath,
      backendDiscovered: resolved.backend_profile,
      lockAcquired,
    },
  };
}

async function finishRunContext(ctx: PreparedRunContext): Promise<RunRecord> {
  const { run, task, packet, prompt, schemaPath, backendDiscovered, lockAcquired } = ctx;
  let cancelledByCaller = false;

  try {
    const execRes = await executeBackend({
      command: run.command,
      backend: backendDiscovered,
      model: run.model,
      effort: run.effort,
      sandbox: run.sandbox,
      effectiveCwd: run.effective_cwd,
      prompt,
      images: packet.images,
      schemaPath,
      lastMessagePath: run.last_message_path,
      rawEventsPath: run.raw_events_path,
      stderrPath: run.stderr_path,
      timeoutSec: run.timeout_sec,
      runId: run.run_id,
      resumeSessionId: run.resumed_from_session_id,
      onSpawn: (pid, pgid) => {
        const latest = loadRun(run.run_id) ?? run;
        if (latest.execution_status === "cancelled") {
          void killProcessGroup(pgid, 500);
          return;
        }
        latest.pid = pid;
        latest.pgid = pgid;
        saveRun(latest);
        if (lockAcquired) {
          // Keep the coordinator/worker PID as lock owner until post-run snapshot & release finish;
          // store the backend PGID separately so stale-lock recovery still covers orphan child groups.
          updateWriterLockPid(run.effective_cwd, run.run_id, process.pid, pgid);
        }
      },
    });

    // Re-read run in case `cancel` updated it while backend was shutting down.
    const latestRun = loadRun(run.run_id) ?? run;
    if (latestRun.execution_status === "cancelled") {
      // Leave lock release to cancelRun so cleanup and post-snapshot finish before another writer enters.
      cancelledByCaller = true;
      return latestRun;
    }

    const postFingerprint = computeWorkspaceFingerprint(run.effective_cwd);
    const changedFiles = diffFingerprints(run.pre_fingerprint, postFingerprint, run.effective_cwd);

    latestRun.post_fingerprint = postFingerprint;
    latestRun.changed_files = changedFiles;
    latestRun.exit_code = execRes.exit_code;
    latestRun.signal = execRes.signal;
    latestRun.ended_at = new Date().toISOString();
    if (execRes.backend_session_id) {
      latestRun.backend_session_id = execRes.backend_session_id;
    }

    if (execRes.timed_out) {
      latestRun.execution_status = changedFiles.length > 0 ? "partial" : "timed_out";
      latestRun.acceptance_status = "blocked";
      latestRun.failure_kind = "timed_out";
      latestRun.failure_message = execRes.failure_message;
      latestRun.verdict_valid = false;
      saveRun(latestRun);
      if (latestRun.backend_session_id) {
        const latestTask = loadTask(task.task_id) ?? task;
        if (latestTask.cwd === run.cwd && latestTask.backend === run.backend) {
          latestTask.backend_session_id = latestRun.backend_session_id;
          latestTask.updated_at = new Date().toISOString();
          saveTask(latestTask);
        }
      }
      return latestRun;
    }

    const snapshotError = postFingerprint.status_error ?? run.pre_fingerprint.status_error;
    if (snapshotError) {
      latestRun.execution_status = "failed";
      latestRun.acceptance_status = "blocked";
      latestRun.failure_kind = "git_error";
      latestRun.failure_message = `Workspace snapshot failed: ${snapshotError}`;
      latestRun.freshness_status = "invalid_boundary";
      latestRun.verdict_valid = false;
      latestRun.parsed_output = execRes.parsed_output;
      saveRun(latestRun);
      return latestRun;
    }

    if (run.command === "review-plan" || run.command === "review-changes") {
      if (postFingerprint.digest !== run.pre_fingerprint.digest || changedFiles.length > 0) {
        latestRun.boundary_violation = true;
        latestRun.boundary_violations = changedFiles;
        latestRun.execution_status = "failed";
        latestRun.acceptance_status = "blocked";
        latestRun.failure_kind = "boundary_violation";
        latestRun.failure_message = `Read-only ${run.command} mutated workspace files: ${changedFiles.join(", ") || "tree digest changed"}`;
        latestRun.freshness_status = "invalid_boundary";
        latestRun.verdict_valid = false;
        latestRun.parsed_output = execRes.parsed_output;
        saveRun(latestRun);
        return latestRun;
      }
    } else {
      const allowed = packet.scope?.allowed_paths ?? [];
      const violations = findBoundaryViolations(changedFiles, allowed);
      if (violations.length > 0) {
        latestRun.boundary_violation = true;
        latestRun.boundary_violations = violations;
        latestRun.execution_status = "failed";
        latestRun.acceptance_status = "blocked";
        latestRun.failure_kind = "boundary_violation";
        latestRun.failure_message = `Delegate modified files outside scope.allowed_paths: ${violations.join(", ")}`;
        latestRun.verdict_valid = false;
        latestRun.parsed_output = execRes.parsed_output;
        saveRun(latestRun);
        return latestRun;
      }
    }

    if (!execRes.ok || !execRes.parsed_output) {
      latestRun.execution_status = "failed";
      latestRun.acceptance_status = "blocked";
      latestRun.failure_kind = execRes.failure_kind ?? "backend_error";
      latestRun.failure_message = execRes.failure_message ?? "Execution failed";
      latestRun.verdict_valid = false;
      saveRun(latestRun);
      return latestRun;
    }

    latestRun.execution_status = "completed";
    latestRun.parsed_output = execRes.parsed_output;

    if (run.command === "delegate") {
      const delOut = execRes.parsed_output as { status: "completed" | "blocked" };
      latestRun.acceptance_status = delOut.status === "completed" ? "approved" : "blocked";
      latestRun.verdict_valid = true;
    } else {
      const revOut = execRes.parsed_output as ReviewOutput;
      latestRun.acceptance_status = determineReviewAcceptance(revOut);
      latestRun.verdict_valid = true;
      if (run.command === "review-changes") {
        latestRun.freshness_status = "fresh";
      }
    }

    saveRun(latestRun);

    const latestTask = loadTask(task.task_id) ?? task;
    if (latestTask.cwd === run.cwd && latestTask.backend === run.backend) {
      if (latestRun.backend_session_id) {
        latestTask.backend_session_id = latestRun.backend_session_id;
      }
      latestTask.updated_at = new Date().toISOString();
      saveTask(latestTask);
    }

    return latestRun;
  } finally {
    if (lockAcquired && !cancelledByCaller) {
      releaseWriterLock(run.effective_cwd, run.run_id);
    }
  }
}

export async function runExecutionCommand(opts: StartRunOptions): Promise<{
  ok: boolean;
  run?: RunRecord;
  error?: ReturnType<typeof makeErrorResult>;
}> {
  const prep = prepareRun(opts);
  if (!prep.ok) {
    return { ok: false, error: prep.error };
  }

  const { ctx } = prep;
  if (opts.background) {
    const workerMeta = {
      schemaPath: ctx.schemaPath,
      packet: ctx.packet,
      prompt: ctx.prompt,
      lockAcquired: ctx.lockAcquired,
    };
    const metaPath = path.join(getRunsDir(), `${ctx.run.run_id}.worker.json`);
    const readyPath = path.join(getRunsDir(), `${ctx.run.run_id}.ready`);
    fs.writeFileSync(metaPath, `${JSON.stringify(workerMeta, null, 2)}\n`, "utf8");

    const worker = spawn(
      process.execPath,
      [CLI_ENTRYPOINT, "_run-worker", "--run-id", ctx.run.run_id, "--await-ready"],
      {
        cwd: ctx.run.effective_cwd,
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
      }
    );
    if (worker.pid) {
      ctx.run.pid = worker.pid;
      ctx.run.pgid = worker.pid;
      ctx.run.worker_pid = worker.pid;
      saveRun(ctx.run);
      if (ctx.lockAcquired) {
        updateWriterLockPid(ctx.run.effective_cwd, ctx.run.run_id, worker.pid, worker.pid);
      }
    }
    // Signal worker only after parent has finished persisting worker identity and lock owner.
    fs.writeFileSync(readyPath, "1\n", "utf8");
    worker.unref();
    return { ok: true, run: ctx.run };
  }

  const finalRun = await finishRunContext(ctx);
  const succeeded = finalRun.execution_status === "completed";
  return { ok: succeeded, run: finalRun };
}

export async function runDetachedWorker(runId: string, awaitReady = false): Promise<number> {
  if (awaitReady) {
    const readyPath = path.join(getRunsDir(), `${runId}.ready`);
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(readyPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    fs.rmSync(readyPath, { force: true });
  }
  const run = loadRun(runId);
  if (!run) return 1;
  const metaPath = path.join(getRunsDir(), `${runId}.worker.json`);
  if (!fs.existsSync(metaPath)) return 1;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
    schemaPath: string;
    packet: HandoffPacket;
    prompt: string;
    lockAcquired: boolean;
  };
  if (run.execution_status === "cancelled") {
    if (meta.lockAcquired) releaseWriterLock(run.effective_cwd, run.run_id);
    return 0;
  }
  const task = loadTask(run.task_id);
  const resolved = resolveRunSettings({
    cwd: run.cwd,
    role: run.role,
    backend: run.backend,
    model: run.model ?? undefined,
    effort: run.effort ?? undefined,
    timeout_sec: run.timeout_sec,
    max_rounds: run.max_rounds,
  });

  if (!task || !resolved.backend_profile) {
    if (meta.lockAcquired) releaseWriterLock(run.effective_cwd, run.run_id);
    return 1;
  }

  await finishRunContext({
    run,
    task,
    packet: meta.packet,
    prompt: meta.prompt,
    schemaPath: meta.schemaPath,
    backendDiscovered: resolved.backend_profile,
    lockAcquired: meta.lockAcquired,
  });
  return 0;
}

export function resolveRunByIdOrTask(opts: { run_id?: string; task_id?: string }): RunRecord | null {
  if (opts.run_id) {
    return loadRun(opts.run_id);
  }
  if (opts.task_id) {
    const task = loadTask(opts.task_id);
    if (!task?.latest_run_id) return null;
    return loadRun(task.latest_run_id);
  }
  return null;
}

export async function cancelRun(runId: string): Promise<
  | { ok: true; run: RunRecord; kill_result: { dead: boolean; escalated_to_sigkill: boolean } | null }
  | { ok: false; error: string }
> {
  const run = loadRun(runId);
  if (!run) {
    return { ok: false, error: `Run '${runId}' not found` };
  }
  if (run.execution_status !== "running") {
    return { ok: true, run, kill_result: null };
  }

  // Mark cancelled on disk before signaling so an in-flight _run-worker sees it immediately.
  run.execution_status = "cancelled";
  run.acceptance_status = "blocked";
  run.failure_kind = "cancelled";
  run.failure_message = "Run cancelled by caller";
  run.verdict_valid = false;
  saveRun(run);

  const targetPgid = run.pgid ?? run.pid;
  const killRes = targetPgid ? await killProcessGroup(targetPgid, 2000) : null;
  if (run.worker_pid && run.worker_pid !== targetPgid) {
    await killProcessGroup(run.worker_pid, 2000);
  }

  const postFingerprint = computeWorkspaceFingerprint(run.effective_cwd);
  const changedFiles = diffFingerprints(run.pre_fingerprint, postFingerprint, run.effective_cwd);

  run.post_fingerprint = postFingerprint;
  run.changed_files = changedFiles;
  run.ended_at = new Date().toISOString();
  saveRun(run);
  releaseWriterLock(run.effective_cwd, run.run_id);

  return { ok: true, run, kill_result: killRes };
}

export function disposeRun(
  opts: { run_id?: string; task_id?: string },
  decisions: FindingDispositionInput[]
):
  | {
      ok: true;
      run: RunRecord;
      unresolved_blocking_ids: string[];
    }
  | { ok: false; error: string } {
  const run = resolveRunByIdOrTask(opts);
  if (!run) {
    return { ok: false, error: "Run not found for --run-id / --task-id" };
  }

  refreshRunFreshness(run);
  const result = applyDispositions(run, decisions);
  if (!result.ok) {
    return { ok: false, error: result.errors.join("; ") };
  }

  run.dispositions = result.dispositions;
  run.acceptance_status = result.acceptance_status;
  saveRun(run);

  return {
    ok: true,
    run,
    unresolved_blocking_ids: result.unresolved_blocking_ids,
  };
}
