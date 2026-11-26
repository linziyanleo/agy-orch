import fs from "node:fs";
import {
  discoverBackends,
  initUserConfig,
  loadMergedConfig,
  resolveRunSettings,
} from "./config.ts";
import {
  formatCancelView,
  formatResultDetailView,
  formatResultSummaryView,
  formatStatusView,
  readEventsTail,
  readStderrTail,
} from "./disclosure.ts";
import { canonicalizeCwd } from "./paths.ts";
import {
  cancelRun,
  disposeRun,
  resolveRunByIdOrTask,
  runDetachedWorker,
  runExecutionCommand,
} from "./runner.ts";
import { listRuns, refreshRunFreshness, saveRun } from "./store.ts";
import { formatSwarmPost, inspectRunActivity } from "./swarm.ts";
import { triageTask } from "./triage.ts";
import type { CommandKind, FindingCategory, FindingDispositionInput } from "./types.ts";

const VALID_FINDING_CATEGORIES = new Set<FindingCategory>([
  "requirement_gap",
  "real_defect",
  "engineering_tradeoff",
  "optional_polish",
]);

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
      key === "done" ||
      key === "raw" ||
      key === "await-ready" ||
      key === "full" ||
      key === "blocking-only"
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

function parsePositiveIntFlag(
  flags: Record<string, string | boolean>,
  key: string,
  min = 1,
  max = 500
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  const raw = flags[key];
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "string") {
    return { ok: false, error: `--${key} requires an integer between ${min} and ${max}` };
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: `--${key} must be an integer between ${min} and ${max}, got '${raw}'` };
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    return { ok: false, error: `--${key} must be an integer between ${min} and ${max}, got '${raw}'` };
  }
  return { ok: true, value: n };
}

function parseCsvFlag(
  flags: Record<string, string | boolean>,
  key: string
): { ok: true; values: string[] | undefined } | { ok: false; error: string } {
  const raw = flags[key];
  if (raw === undefined) return { ok: true, values: undefined };
  if (typeof raw !== "string") {
    return { ok: false, error: `--${key} requires a comma-separated value` };
  }
  const values = Array.from(
    new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
  if (values.length === 0) {
    return { ok: false, error: `--${key} must not be empty` };
  }
  return { ok: true, values };
}

function parseCategoryFlag(
  flags: Record<string, string | boolean>
): { ok: true; values: FindingCategory[] | undefined } | { ok: false; error: string } {
  const parsed = parseCsvFlag(flags, "category");
  if (!parsed.ok || !parsed.values) return parsed as { ok: true; values: undefined } | { ok: false; error: string };
  for (const cat of parsed.values) {
    if (!VALID_FINDING_CATEGORIES.has(cat as FindingCategory)) {
      return {
        ok: false,
        error: `Invalid category '${cat}'. Must be one of: requirement_gap, real_defect, engineering_tradeoff, optional_polish`,
      };
    }
  }
  return { ok: true, values: parsed.values as FindingCategory[] };
}

function writeStdout(text: string): Promise<void> {
  return new Promise<void>((resolve) => {
    process.stdout.write(text, () => resolve());
  });
}

function printJson(obj: unknown, exitCode = 0): Promise<never> {
  return new Promise<never>(() => {
    process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`, () => {
      process.exit(exitCode);
    });
  });
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
      "review-plan --packet <file|-> [--cwd <dir>] [--task-id <id>] [--role <role>] [--backend <name>] [--model <model>] [--effort <effort>] [--timeout-sec <n>] [--resume] [--background] [--full]",
      "delegate --packet <file|-> [--cwd <dir>] [--task-id <id>] [--role <role>] [--backend <name>] [--model <model>] [--effort <effort>] [--timeout-sec <n>] [--resume] [--worktree] [--background] [--full]",
      "review-changes --packet <file|-> [--cwd <dir>] [--task-id <id>] [--role <role>] [--backend <name>] [--model <model>] [--effort <effort>] [--timeout-sec <n>] [--resume] [--background] [--full]",
      "start <review-plan|delegate|review-changes> [flags...] [--full]",
      "status (--run-id <id> | --task-id <id>) [--events-tail <n>] [--stderr-tail <n>] [--full]",
      "result (--run-id <id> | --task-id <id>) [--finding <csv>] [--blocking-only] [--category <csv>] [--events-tail <n>] [--stderr-tail <n>] [--full]",
      "swarm-post (--run-id <id> | --task-id <id>) [--mention <name>] [--done] [--raw]",
      "cancel --run-id <id> [--full]",
      "list [--task-id <id>] [--cwd <dir>] [--limit <n>]",
      "check-freshness --task-id <id> [--run-id <id>]",
      "dispose --run-id <id> --decisions <json|@file|->",
    ],
  };
}

async function rejectResultFilterFlags(flags: Record<string, string | boolean>): Promise<void> {
  if (
    flags["finding"] !== undefined ||
    flags["blocking-only"] !== undefined ||
    flags["category"] !== undefined
  ) {
    return printJson(
      { ok: false, error: "--finding, --blocking-only, and --category are only supported on 'result'" },
      1
    );
  }
}

export async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const cmd = positional[0];

  if (!cmd || cmd === "help" || getBoolFlag(flags, "help")) {
    return printJson(usage(), 0);
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
        image: b.profile.capabilities.image ? (b.profile.exec.image_flag ?? null) : null,
        resume: b.profile.resume.supported
          ? b.profile.resume.subcommand
            ? `${b.profile.resume.subcommand.join(" ")} <session_id>`
            : `${b.profile.resume.session_flag} <session_id>`
          : null,
      },
      defaults: b.profile.defaults ?? {},
    }));
    return printJson({ backends }, 0);
  }

  if (cmd === "config") {
    const sub = positional[1] ?? "show";
    const cwd = getStrFlag(flags, "cwd") ? canonicalizeCwd(getStrFlag(flags, "cwd")) : canonicalizeCwd();
    if (sub === "init") {
      const res = initUserConfig();
      return printJson(res, 0);
    }
    if (sub === "show") {
      return printJson(loadMergedConfig(cwd), 0);
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
      return printJson(
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
    return printJson({ ok: false, error: `Unknown config subcommand '${sub}'` }, 1);
  }

  if (cmd === "triage") {
    const summary = getStrFlag(flags, "summary") ?? "";
    if (!summary.trim()) {
      return printJson({ ok: false, error: "--summary is required" }, 1);
    }
    const filesCsv = getStrFlag(flags, "files");
    const files = filesCsv ? filesCsv.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const kind = getStrFlag(flags, "kind");
    return printJson(triageTask({ summary, files, kind }), 0);
  }

  if (cmd === "start" || cmd === "review-plan" || cmd === "delegate" || cmd === "review-changes") {
    await rejectResultFilterFlags(flags);
    const execCmd = (cmd === "start" ? positional[1] : cmd) as CommandKind | undefined;
    if (execCmd !== "review-plan" && execCmd !== "delegate" && execCmd !== "review-changes") {
      return printJson({ ok: false, error: "start requires <review-plan|delegate|review-changes>" }, 1);
    }
    const isBackground = cmd === "start" || getBoolFlag(flags, "background");
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
      background: isBackground,
    });
    if (res.error) {
      return printJson(res.error, 1);
    }
    const run = res.run!;
    const exitCode =
      run.execution_status === "completed" || run.execution_status === "running" ? 0 : 1;
    if (getBoolFlag(flags, "full")) {
      return printJson(run, exitCode);
    }
    if (isBackground) {
      return printJson(formatStatusView(run, { includeLiveActivity: false }), exitCode);
    }
    return printJson(formatResultSummaryView(run), exitCode);
  }

  if (cmd === "status" || cmd === "result" || cmd === "swarm-post") {
    if (cmd === "status" || cmd === "swarm-post") {
      await rejectResultFilterFlags(flags);
    }
    const eventsTailLimit = parsePositiveIntFlag(flags, "events-tail");
    if (!eventsTailLimit.ok) {
      return printJson({ ok: false, error: eventsTailLimit.error }, 1);
    }
    const stderrTailLimit = parsePositiveIntFlag(flags, "stderr-tail");
    if (!stderrTailLimit.ok) {
      return printJson({ ok: false, error: stderrTailLimit.error }, 1);
    }

    let findingIds: string[] | undefined;
    let categories: FindingCategory[] | undefined;
    const blockingOnly = getBoolFlag(flags, "blocking-only");
    const isFull = getBoolFlag(flags, "full");
    if (cmd === "result") {
      const findingRes = parseCsvFlag(flags, "finding");
      if (!findingRes.ok) {
        return printJson({ ok: false, error: findingRes.error }, 1);
      }
      findingIds = findingRes.values;

      const categoryRes = parseCategoryFlag(flags);
      if (!categoryRes.ok) {
        return printJson({ ok: false, error: categoryRes.error }, 1);
      }
      categories = categoryRes.values;

      if (isFull && (findingIds !== undefined || blockingOnly || categories !== undefined)) {
        return printJson(
          { ok: false, error: "--full cannot be combined with --finding, --blocking-only, or --category" },
          1
        );
      }
    }

    const run = resolveRunByIdOrTask({
      run_id: getStrFlag(flags, "run-id"),
      task_id: getStrFlag(flags, "task-id"),
    });
    if (!run) {
      return printJson({ ok: false, error: "Run not found for --run-id / --task-id" }, 1);
    }
    if (run.execution_status !== "running") {
      const prevFresh = run.freshness_status;
      const prevValid = run.verdict_valid;
      const prevAcc = run.acceptance_status;
      refreshRunFreshness(run);
      if (
        cmd !== "swarm-post" && (
          run.freshness_status !== prevFresh ||
          run.verdict_valid !== prevValid ||
          run.acceptance_status !== prevAcc
        )
      ) {
        saveRun(run);
      }
    }
    if (cmd === "swarm-post") {
      const payload = formatSwarmPost(run, {
        mention: getStrFlag(flags, "mention"),
        done: getBoolFlag(flags, "done"),
      });
      if (getBoolFlag(flags, "raw")) {
        await writeStdout(`${payload.post}\n`);
        return;
      }
      return printJson(payload, 0);
    }

    const eventsTail =
      eventsTailLimit.value !== undefined
        ? readEventsTail(run.raw_events_path, eventsTailLimit.value)
        : undefined;
    const stderrTail =
      stderrTailLimit.value !== undefined
        ? readStderrTail(run.stderr_path, stderrTailLimit.value)
        : undefined;

    if (cmd === "status") {
      const liveActivity = inspectRunActivity(run.raw_events_path);
      if (isFull) {
        return printJson(
          {
            ...run,
            live_activity: liveActivity,
            ...(eventsTail !== undefined ? { events_tail: eventsTail } : {}),
            ...(stderrTail !== undefined ? { stderr_tail: stderrTail } : {}),
          },
          0
        );
      }
      return printJson(
        formatStatusView(run, {
          includeLiveActivity: true,
          liveActivity,
          eventsTail,
          stderrTail,
        }),
        0
      );
    }

    if (isFull) {
      return printJson(
        {
          ...run,
          ...(eventsTail !== undefined ? { events_tail: eventsTail } : {}),
          ...(stderrTail !== undefined ? { stderr_tail: stderrTail } : {}),
        },
        0
      );
    }

    if (findingIds !== undefined || blockingOnly || categories !== undefined) {
      const detail = formatResultDetailView(run, {
        findingIds,
        blockingOnly,
        categories,
        eventsTail,
        stderrTail,
      });
      if (!detail.ok) {
        return printJson({ ok: false, error: detail.error }, 1);
      }
      return printJson(detail.view, 0);
    }

    return printJson(formatResultSummaryView(run, { eventsTail, stderrTail }), 0);
  }

  if (cmd === "check-freshness") {
    const run = resolveRunByIdOrTask({
      run_id: getStrFlag(flags, "run-id"),
      task_id: getStrFlag(flags, "task-id"),
    });
    if (!run) {
      return printJson({ ok: false, error: "Run not found for --task-id / --run-id" }, 1);
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
    return printJson(
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
    await rejectResultFilterFlags(flags);
    const runId = getStrFlag(flags, "run-id");
    if (!runId) {
      return printJson({ ok: false, error: "cancel requires --run-id" }, 1);
    }
    const res = await cancelRun(runId);
    if (!res.ok) {
      return printJson({ ok: false, error: res.error }, 1);
    }
    if (getBoolFlag(flags, "full")) {
      return printJson({ ...res.run, kill_result: res.kill_result }, 0);
    }
    return printJson(formatCancelView(res.run, res.kill_result), 0);
  }

  if (cmd === "list") {
    const cwd = getStrFlag(flags, "cwd") ? canonicalizeCwd(getStrFlag(flags, "cwd")) : undefined;
    const runs = listRuns({
      task_id: getStrFlag(flags, "task-id"),
      cwd,
      limit: getNumFlag(flags, "limit") ?? 20,
    });
    return printJson(
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
      return printJson({ ok: false, error: "dispose requires --decisions <json|@file|->" }, 1);
    }
    let decisions: FindingDispositionInput[];
    try {
      decisions = parseDecisionsInput(rawDecisions);
    } catch (err) {
      return printJson(
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
      return printJson({ ok: false, error: res.error }, 1);
    }
    return printJson(
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

  return printJson({ ok: false, error: `Unknown command '${cmd}'`, usage: usage() }, 1);
}
