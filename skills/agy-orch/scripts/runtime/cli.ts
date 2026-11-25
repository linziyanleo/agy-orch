import fs from "node:fs";
import {
  discoverBackends,
  initUserConfig,
  loadMergedConfig,
  resolveRunSettings,
} from "./config.ts";
import { canonicalizeCwd } from "./paths.ts";
import {
  cancelRun,
  disposeRun,
  resolveRunByIdOrTask,
  runDetachedWorker,
  runExecutionCommand,
} from "./runner.ts";
import { listRuns, refreshRunFreshness, saveRun } from "./store.ts";
import { triageTask } from "./triage.ts";
import type { CommandKind, FindingDispositionInput } from "./types.ts";

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) {
      positional.push(tok);
      continue;
    }
    const eqIdx = tok.indexOf("=");
    if (eqIdx !== -1) {
      flags[tok.slice(2, eqIdx)] = tok.slice(eqIdx + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (
      key === "resume" ||
      key === "worktree" ||
      key === "background" ||
      key === "json" ||
      key === "help" ||
      key === "await-ready"
    ) {
      flags[key] = true;
      continue;
    }
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

function getStrFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const val = flags[key];
  return typeof val === "string" ? val : undefined;
}

function getNumFlag(flags: Record<string, string | boolean>, key: string): number | undefined {
  const s = getStrFlag(flags, key);
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function getBoolFlag(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}

function printJson(obj: unknown, exitCode = 0): never {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  process.exit(exitCode);
}

function parseDecisionsInput(rawInput: string): FindingDispositionInput[] {
  let content = rawInput;
  if (rawInput === "-") {
    content = fs.readFileSync(0, "utf8");
  } else if (rawInput.startsWith("@")) {
    content = fs.readFileSync(rawInput.slice(1), "utf8");
  }
  const parsed = JSON.parse(content) as unknown;
  if (Array.isArray(parsed)) return parsed as FindingDispositionInput[];
  if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { decisions?: unknown }).decisions)) {
    return (parsed as { decisions: FindingDispositionInput[] }).decisions;
  }
  throw new Error("--decisions must be a JSON array or { decisions: [...] }");
}

function usage() {
  return {
    name: "agy-orch",
    version: "0.1.0",
    commands: [
      "backends",
      "config show | resolve | init",
      "triage --summary <text> [--files <csv>] [--kind <style|copy|logic|arch|...>]",
      "review-plan --packet <file|-> [--cwd <dir>] [--task-id <id>] [--role <role>] [--backend <name>] [--model <model>] [--effort <effort>] [--timeout-sec <n>] [--resume] [--background]",
      "delegate --packet <file|-> [--cwd <dir>] [--task-id <id>] [--role <role>] [--backend <name>] [--model <model>] [--effort <effort>] [--timeout-sec <n>] [--resume] [--worktree] [--background]",
      "review-changes --packet <file|-> [--cwd <dir>] [--task-id <id>] [--role <role>] [--backend <name>] [--model <model>] [--effort <effort>] [--timeout-sec <n>] [--resume] [--background]",
      "start <review-plan|delegate|review-changes> [flags...]",
      "status --run-id <id> | --task-id <id>",
      "result --run-id <id> | --task-id <id>",
      "cancel --run-id <id>",
      "list [--task-id <id>] [--cwd <dir>] [--limit <n>]",
      "check-freshness --task-id <id> [--run-id <id>]",
      "dispose --run-id <id> --decisions <json|@file|->",
    ],
  };
}

export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const cmd = positional[0];

  if (!cmd || cmd === "help" || getBoolFlag(flags, "help")) {
    printJson(usage(), 0);
  }

  if (cmd === "_run-worker") {
    const runId = getStrFlag(flags, "run-id");
    if (!runId) process.exit(1);
    const code = await runDetachedWorker(runId, getBoolFlag(flags, "await-ready"));
    process.exit(code);
  }

  if (cmd === "backends") {
    const backends = discoverBackends().map((b) => ({
      name: b.name,
      display_name: b.display_name,
      active: b.active,
      binary: b.binary,
      resolved_binary: b.resolved_binary,
      available: b.available,
      source: b.source,
      capabilities: b.capabilities,
      identity_flags: {
        model: b.profile.exec.model_flag ?? null,
        effort:
          b.profile.exec.effort_mode === "codex-config"
            ? `${b.profile.exec.effort_flag} ${b.profile.exec.effort_config_key}=<effort>`
            : b.profile.exec.effort_flag ?? null,
        sandbox: b.profile.exec.sandbox_flag ?? null,
        resume: b.profile.resume.supported
          ? b.profile.resume.subcommand
            ? `${b.profile.resume.subcommand.join(" ")} <session_id>`
            : `${b.profile.resume.session_flag} <session_id>`
          : null,
      },
      defaults: b.profile.defaults ?? {},
    }));
    printJson({ backends }, 0);
  }

  if (cmd === "config") {
    const sub = positional[1] ?? "show";
    const cwd = getStrFlag(flags, "cwd") ? canonicalizeCwd(getStrFlag(flags, "cwd")) : canonicalizeCwd();
    if (sub === "init") {
      const res = initUserConfig();
      printJson(res, 0);
    }
    if (sub === "show") {
      printJson(loadMergedConfig(cwd), 0);
    }
    if (sub === "resolve") {
      const resolved = resolveRunSettings({
        cwd,
        role: getStrFlag(flags, "role") ?? "reviewer",
        backend: getStrFlag(flags, "backend"),
        model: getStrFlag(flags, "model"),
        effort: getStrFlag(flags, "effort"),
        timeout_sec: getNumFlag(flags, "timeout-sec"),
      });
      printJson(
        {
          role: resolved.role,
          backend: resolved.backend,
          model: resolved.model,
          effort: resolved.effort,
          timeout_sec: resolved.timeout_sec,
          max_rounds: resolved.max_rounds,
          backend_available: resolved.backend_profile?.available ?? false,
          resolved_binary: resolved.backend_profile?.resolved_binary ?? null,
          sources: resolved.config_sources,
        },
        0
      );
    }
    printJson({ ok: false, error: `Unknown config subcommand '${sub}'` }, 1);
  }

  if (cmd === "triage") {
    const summary = getStrFlag(flags, "summary") ?? "";
    if (!summary.trim()) {
      printJson({ ok: false, error: "--summary is required" }, 1);
    }
    const filesCsv = getStrFlag(flags, "files");
    const files = filesCsv ? filesCsv.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const kind = getStrFlag(flags, "kind");
    printJson(triageTask({ summary, files, kind }), 0);
  }

  if (cmd === "start" || cmd === "review-plan" || cmd === "delegate" || cmd === "review-changes") {
    const execCmd = (cmd === "start" ? positional[1] : cmd) as CommandKind | undefined;
    if (execCmd !== "review-plan" && execCmd !== "delegate" && execCmd !== "review-changes") {
      printJson({ ok: false, error: "start requires <review-plan|delegate|review-changes>" }, 1);
    }
    const res = await runExecutionCommand({
      command: execCmd,
      cwd: getStrFlag(flags, "cwd"),
      task_id: getStrFlag(flags, "task-id"),
      packet_source: getStrFlag(flags, "packet"),
      role: getStrFlag(flags, "role"),
      backend: getStrFlag(flags, "backend"),
      model: getStrFlag(flags, "model"),
      effort: getStrFlag(flags, "effort"),
      timeout_sec: getNumFlag(flags, "timeout-sec"),
      resume: getBoolFlag(flags, "resume"),
      worktree: getBoolFlag(flags, "worktree"),
      background: cmd === "start" || getBoolFlag(flags, "background"),
    });
    if (res.error) {
      printJson(res.error, 1);
    }
    const run = res.run!;
    const exitCode =
      run.execution_status === "completed" || run.execution_status === "running" ? 0 : 1;
    printJson(run, exitCode);
  }

  if (cmd === "status" || cmd === "result") {
    const run = resolveRunByIdOrTask({
      run_id: getStrFlag(flags, "run-id"),
      task_id: getStrFlag(flags, "task-id"),
    });
    if (!run) {
      printJson({ ok: false, error: "Run not found for --run-id / --task-id" }, 1);
    }
    if (run.execution_status !== "running") {
      const prevFresh = run.freshness_status;
      const prevValid = run.verdict_valid;
      const prevAcc = run.acceptance_status;
      refreshRunFreshness(run);
      if (
        run.freshness_status !== prevFresh ||
        run.verdict_valid !== prevValid ||
        run.acceptance_status !== prevAcc
      ) {
        saveRun(run);
      }
    }
    printJson(run, 0);
  }

  if (cmd === "check-freshness") {
    const run = resolveRunByIdOrTask({
      run_id: getStrFlag(flags, "run-id"),
      task_id: getStrFlag(flags, "task-id"),
    });
    if (!run) {
      printJson({ ok: false, error: "Run not found for --task-id / --run-id" }, 1);
    }
    if (run.execution_status !== "running") {
      const prevFresh = run.freshness_status;
      const prevValid = run.verdict_valid;
      const prevAcc = run.acceptance_status;
      refreshRunFreshness(run);
      if (
        run.freshness_status !== prevFresh ||
        run.verdict_valid !== prevValid ||
        run.acceptance_status !== prevAcc
      ) {
        saveRun(run);
      }
    }
    printJson(
      {
        run_id: run.run_id,
        task_id: run.task_id,
        command: run.command,
        execution_status: run.execution_status,
        acceptance_status: run.acceptance_status,
        verdict_valid: run.verdict_valid,
        freshness_status: run.freshness_status,
        pre_fingerprint: run.pre_fingerprint.digest,
      },
      0
    );
  }

  if (cmd === "cancel") {
    const runId = getStrFlag(flags, "run-id");
    if (!runId) {
      printJson({ ok: false, error: "cancel requires --run-id" }, 1);
    }
    const res = await cancelRun(runId);
    if (!res.ok) {
      printJson({ ok: false, error: res.error }, 1);
    }
    printJson({ ...res.run, kill_result: res.kill_result }, 0);
  }

  if (cmd === "list") {
    const cwd = getStrFlag(flags, "cwd") ? canonicalizeCwd(getStrFlag(flags, "cwd")) : undefined;
    const runs = listRuns({
      task_id: getStrFlag(flags, "task-id"),
      cwd,
      limit: getNumFlag(flags, "limit") ?? 20,
    });
    printJson(
      {
        runs: runs.map((r) => ({
          run_id: r.run_id,
          task_id: r.task_id,
          command: r.command,
          backend: r.backend,
          model: r.model,
          effort: r.effort,
          execution_status: r.execution_status,
          acceptance_status: r.acceptance_status,
          verdict_valid: r.verdict_valid,
          freshness_status: r.freshness_status,
          round: r.round,
          max_rounds: r.max_rounds,
          started_at: r.started_at,
          ended_at: r.ended_at,
        })),
      },
      0
    );
  }

  if (cmd === "dispose") {
    const rawDecisions = getStrFlag(flags, "decisions");
    if (!rawDecisions) {
      printJson({ ok: false, error: "dispose requires --decisions <json|@file|->" }, 1);
    }
    let decisions: FindingDispositionInput[];
    try {
      decisions = parseDecisionsInput(rawDecisions);
    } catch (err) {
      printJson(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        1
      );
    }
    const res = disposeRun(
      {
        run_id: getStrFlag(flags, "run-id"),
        task_id: getStrFlag(flags, "task-id"),
      },
      decisions
    );
    if (!res.ok) {
      printJson({ ok: false, error: res.error }, 1);
    }
    printJson(
      {
        run_id: res.run.run_id,
        task_id: res.run.task_id,
        round: res.run.round,
        max_rounds: res.run.max_rounds,
        acceptance_status: res.run.acceptance_status,
        unresolved_blocking_ids: res.unresolved_blocking_ids,
        dispositions: res.run.dispositions,
      },
      0
    );
  }

  printJson({ ok: false, error: `Unknown command '${cmd}'`, usage: usage() }, 1);
}
