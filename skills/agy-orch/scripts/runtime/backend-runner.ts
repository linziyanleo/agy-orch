import fs from "node:fs";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { killProcessGroup } from "./lock.ts";
import { validateDelegateOutput, validateReviewOutput } from "./schema-validate.ts";
import type {
  CommandKind,
  DelegateOutput,
  DiscoveredBackend,
  FailureKind,
  ReviewOutput,
  SandboxMode,
} from "./types.ts";

const INVALID_PARAM_RE =
  /invalid[_ ]?model|unknown[_ ]?model|model[_ ]?not[_ ]?found|unsupported[_ ]?model|model['"`\s\w-]*is not supported|is not supported.*model|unsupported[_ ]?value|unknown[_ ]?variant|invalid_enum_value|reasoning\.effort|ReasoningEffortParam|invalid[_ ]?value|model_reasoning_effort|invalid[_ ]?(reasoning|effort)|unrecognized option|unexpected argument|does not support/i;

export interface BackendExecOptions {
  command: CommandKind;
  backend: DiscoveredBackend;
  model: string | null;
  effort: string | null;
  sandbox: SandboxMode;
  effectiveCwd: string;
  prompt: string;
  schemaPath: string;
  lastMessagePath: string;
  rawEventsPath: string;
  stderrPath: string;
  timeoutSec: number;
  runId: string;
  resumeSessionId: string | null;
  onSpawn?: (pid: number, pgid: number) => void;
}

export interface BackendExecResult {
  ok: boolean;
  timed_out: boolean;
  exit_code: number | null;
  signal: string | null;
  backend_session_id: string | null;
  failure_kind: FailureKind | null;
  failure_message: string | null;
  parsed_output: ReviewOutput | DelegateOutput | null;
  insufficient_evidence_ids: string[];
}

export function buildBackendArgs(opts: {
  backend: DiscoveredBackend;
  model: string | null;
  effort: string | null;
  sandbox: SandboxMode;
  effectiveCwd: string;
  prompt: string;
  schemaPath: string;
  lastMessagePath: string;
  resumeSessionId: string | null;
}): string[] {
  const profile = opts.backend.profile;
  const args: string[] = [];
  const isResume = Boolean(opts.resumeSessionId);

  const pushModelAndEffort = () => {
    if (opts.model && profile.capabilities.model && profile.exec.model_flag) {
      args.push(profile.exec.model_flag, opts.model);
    }
    if (opts.effort && profile.capabilities.effort) {
      if (
        profile.exec.effort_mode === "codex-config" &&
        profile.exec.effort_flag &&
        profile.exec.effort_config_key
      ) {
        args.push(profile.exec.effort_flag, `${profile.exec.effort_config_key}="${opts.effort}"`);
      } else if (profile.exec.effort_mode === "flag" && profile.exec.effort_flag) {
        args.push(profile.exec.effort_flag, opts.effort);
      }
    }
  };

  const pushSandbox = () => {
    const mapped = profile.exec.sandbox_map?.[opts.sandbox];
    if (profile.capabilities.sandbox && profile.exec.sandbox_flag && mapped) {
      args.push(profile.exec.sandbox_flag, mapped);
    }
  };

  const pushCwd = () => {
    if (profile.exec.cwd_flag) {
      args.push(profile.exec.cwd_flag, opts.effectiveCwd);
    }
  };

  const pushSchemaAndLast = () => {
    if (profile.capabilities.output_schema && profile.exec.output_schema_flag && opts.schemaPath) {
      args.push(profile.exec.output_schema_flag, opts.schemaPath);
    }
    if (profile.exec.output_last_message_flag && opts.lastMessagePath) {
      args.push(profile.exec.output_last_message_flag, opts.lastMessagePath);
    }
  };

  const pushPrompt = () => {
    if (profile.exec.prompt_mode === "stdin-dash") {
      args.push("-");
    } else if (profile.exec.prompt_mode === "arg") {
      if (profile.exec.prompt_separator) {
        args.push(profile.exec.prompt_separator);
      }
      args.push(opts.prompt);
    } else if (profile.exec.prompt_mode === "flag" && profile.exec.prompt_flag) {
      args.push(profile.exec.prompt_flag, opts.prompt);
    }
  };

  if (isResume && profile.resume.subcommand && profile.resume.subcommand.length > 0) {
    // e.g. codex: exec [-C <cwd>] [-s <sandbox>] resume [--json] [-m <model>] [-c ...] [--output-schema ...] [-o ...] <session_id> -
    const [headSub, ...restSub] = profile.resume.subcommand;
    args.push(headSub);
    const preFlags = new Set(profile.resume.pre_subcommand_flags ?? []);
    if (preFlags.has(profile.exec.cwd_flag ?? "")) pushCwd();
    if (preFlags.has(profile.exec.sandbox_flag ?? "")) pushSandbox();
    args.push(...restSub);

    for (const baseArg of profile.exec.base_args) {
      if (baseArg !== headSub) args.push(baseArg);
    }
    if (!preFlags.has(profile.exec.cwd_flag ?? "")) pushCwd();
    if (!preFlags.has(profile.exec.sandbox_flag ?? "")) pushSandbox();
    pushModelAndEffort();
    pushSchemaAndLast();
    args.push(opts.resumeSessionId!);
    pushPrompt();
    return args;
  }

  args.push(...profile.exec.base_args);
  pushCwd();
  pushSandbox();
  pushModelAndEffort();
  pushSchemaAndLast();

  if (isResume && profile.resume.session_mode === "flag" && profile.resume.session_flag) {
    args.push(profile.resume.session_flag, opts.resumeSessionId!);
  }

  pushPrompt();
  return args;
}

function extractJsonText(rawText: string): string {
  const trimmed = rawText.trim();
  if (trimmed.startsWith("```")) {
    const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
    if (match) return match[1].trim();
  }
  return trimmed;
}

function parseCodexJsonl(rawStdout: string): {
  threadId: string | null;
  sawTurnCompleted: boolean;
  lastAgentMessage: string | null;
  fatalErrors: string[];
} {
  let threadId: string | null = null;
  let sawTurnCompleted = false;
  let lastAgentMessage: string | null = null;
  const fatalErrors: string[] = [];

  for (const line of rawStdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = typeof event.type === "string" ? event.type : "";
    if (type === "thread.started" && typeof event.thread_id === "string") {
      threadId = event.thread_id;
    } else if (type === "turn.completed") {
      sawTurnCompleted = true;
    } else if (type === "turn.failed") {
      const errObj = event.error as Record<string, unknown> | undefined;
      fatalErrors.push(
        typeof errObj?.message === "string" ? errObj.message : JSON.stringify(event)
      );
    } else if (type === "error") {
      fatalErrors.push(
        typeof event.message === "string" ? event.message : JSON.stringify(event)
      );
    } else if (type === "item.completed" && typeof event.item === "object" && event.item !== null) {
      const item = event.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") {
        lastAgentMessage = item.text;
      }
    }
  }

  return { threadId, sawTurnCompleted, lastAgentMessage, fatalErrors };
}

function parseGenericJsonl(rawStdout: string): {
  sessionId: string | null;
  lastMessage: string | null;
  sawCompleted: boolean;
  fatalErrors: string[];
} {
  let sessionId: string | null = null;
  let lastMessage: string | null = null;
  let sawCompleted = false;
  const fatalErrors: string[] = [];

  for (const line of rawStdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj.session_id === "string") sessionId = obj.session_id;
      if (typeof obj.thread_id === "string") sessionId = obj.thread_id;
      if (obj.type === "turn.completed" || obj.type === "result") {
        sawCompleted = true;
      }
      if (typeof obj.result === "string") lastMessage = obj.result;
      if (typeof obj.text === "string") lastMessage = obj.text;
      if (typeof obj.message === "string" && obj.type === "error") {
        fatalErrors.push(obj.message);
      }
    } catch {
      lastMessage = trimmed;
    }
  }

  return { sessionId, lastMessage, sawCompleted, fatalErrors };
}

export async function executeBackend(opts: BackendExecOptions): Promise<BackendExecResult> {
  const binaryPath = opts.backend.resolved_binary;
  if (!binaryPath) {
    return {
      ok: false,
      timed_out: false,
      exit_code: null,
      signal: null,
      backend_session_id: null,
      failure_kind: "backend_unavailable",
      failure_message: `Backend '${opts.backend.name}' binary '${opts.backend.binary}' not found in PATH`,
      parsed_output: null,
      insufficient_evidence_ids: [],
    };
  }

  const args = buildBackendArgs({
    backend: opts.backend,
    model: opts.model,
    effort: opts.effort,
    sandbox: opts.sandbox,
    effectiveCwd: opts.effectiveCwd,
    prompt: opts.prompt,
    schemaPath: opts.schemaPath,
    lastMessagePath: opts.lastMessagePath,
    resumeSessionId: opts.resumeSessionId,
  });

  const depth = Number(process.env.AGY_ORCH_DEPTH ?? "0") + 1;
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(opts.backend.profile.exec.extra_env ?? {}),
    AGY_ORCH_ACTIVE: "1",
    AGY_ORCH_DEPTH: String(depth),
    AGY_ORCH_RUN_ID: opts.runId,
  };

  let rawStdout = "";
  let rawStderr = "";
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let timedOut = false;
  let timeoutKillResult: { dead: boolean; escalated_to_sigkill: boolean } | null = null;

  const eventsStream = fs.createWriteStream(opts.rawEventsPath, { flags: "w" });
  const stderrStream = fs.createWriteStream(opts.stderrPath, { flags: "w" });

  const child = spawn(binaryPath, args, {
    cwd: opts.effectiveCwd,
    detached: true,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (child.pid && opts.onSpawn) {
    opts.onSpawn(child.pid, child.pid);
  }

  child.stdout.on("data", (chunk: Buffer) => {
    eventsStream.write(chunk);
    rawStdout += stdoutDecoder.write(chunk);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderrStream.write(chunk);
    rawStderr += stderrDecoder.write(chunk);
  });

  if (
    opts.backend.profile.exec.prompt_mode === "stdin-dash" ||
    opts.backend.profile.exec.prompt_mode === "stdin"
  ) {
    child.stdin.write(opts.prompt, "utf8");
  }
  child.stdin.end();

  const exitInfo = await new Promise<{
    code: number | null;
    signal: string | null;
    spawnError: Error | null;
  }>((resolve) => {
    let settled = false;
    let timeoutCleanup: ReturnType<typeof killProcessGroup> | undefined;
    const timeoutMs = Math.max(1, opts.timeoutSec) * 1000;
    const timer = setTimeout(async () => {
      timedOut = true;
      if (child.pid) {
        timeoutCleanup = killProcessGroup(child.pid, 2000);
        timeoutKillResult = await timeoutCleanup;
      }
      if (!settled) {
        settled = true;
        resolve({ code: null, signal: "SIGKILL", spawnError: null });
      }
    }, timeoutMs);

    child.on("error", async (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        if (timeoutCleanup) timeoutKillResult = await timeoutCleanup;
        resolve({ code: null, signal: null, spawnError: err });
      }
    });

    child.on("close", async (code, signal) => {
      rawStdout += stdoutDecoder.end();
      rawStderr += stderrDecoder.end();
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        if (timeoutCleanup) timeoutKillResult = await timeoutCleanup;
        resolve({ code, signal, spawnError: null });
      }
    });
  });

  await Promise.all([
    new Promise<void>((r) => eventsStream.end(() => r())),
    new Promise<void>((r) => stderrStream.end(() => r())),
  ]);

  const protocol = opts.backend.profile.output_protocol;

  if (timedOut) {
    let timedOutSessionId: string | null = null;
    if (protocol === "codex-jsonl") {
      timedOutSessionId = parseCodexJsonl(rawStdout).threadId;
    } else if (protocol === "jsonl-generic") {
      timedOutSessionId = parseGenericJsonl(rawStdout).sessionId;
    }
    return {
      ok: false,
      timed_out: true,
      exit_code: exitInfo.code,
      signal: exitInfo.signal,
      backend_session_id: timedOutSessionId,
      failure_kind: "timed_out",
      failure_message:
        timeoutKillResult && !timeoutKillResult.dead
          ? `Execution timed out after ${opts.timeoutSec}s; process group termination could not be confirmed`
          : `Execution timed out after ${opts.timeoutSec}s and process group was terminated`,
      parsed_output: null,
      insufficient_evidence_ids: [],
    };
  }

  if (exitInfo.spawnError) {
    return {
      ok: false,
      timed_out: false,
      exit_code: null,
      signal: null,
      backend_session_id: null,
      failure_kind: "backend_error",
      failure_message: exitInfo.spawnError.message,
      parsed_output: null,
      insufficient_evidence_ids: [],
    };
  }

  let sessionId: string | null = null;
  let finalMessageText: string | null = null;
  let fatalErrors: string[] = [];
  let sawTerminalEvent = true;

  if (protocol === "codex-jsonl") {
    const parsed = parseCodexJsonl(rawStdout);
    sessionId = parsed.threadId;
    sawTerminalEvent = parsed.sawTurnCompleted;
    fatalErrors = parsed.fatalErrors;
    if (fs.existsSync(opts.lastMessagePath)) {
      const fromFile = fs.readFileSync(opts.lastMessagePath, "utf8");
      if (fromFile.trim().length > 0) {
        finalMessageText = fromFile;
      }
    }
    if (!finalMessageText && parsed.lastAgentMessage) {
      finalMessageText = parsed.lastAgentMessage;
    }
  } else if (protocol === "jsonl-generic") {
    const parsed = parseGenericJsonl(rawStdout);
    sessionId = parsed.sessionId;
    finalMessageText = parsed.lastMessage;
    fatalErrors = parsed.fatalErrors;
    sawTerminalEvent = parsed.sawCompleted || exitInfo.code === 0;
  } else {
    finalMessageText = rawStdout;
  }

  // In codex-jsonl, never scan normal JSONL message bodies for invalid-parameter strings.
  const combinedDiag =
    protocol === "codex-jsonl"
      ? `${fatalErrors.join("\n")}\n${rawStderr}`.trim()
      : `${fatalErrors.join("\n")}\n${rawStderr}\n${rawStdout}`.trim();

  if (exitInfo.code !== 0 || fatalErrors.length > 0) {
    if (INVALID_PARAM_RE.test(combinedDiag)) {
      return {
        ok: false,
        timed_out: false,
        exit_code: exitInfo.code,
        signal: exitInfo.signal,
        backend_session_id: sessionId,
        failure_kind: "invalid_parameter",
        failure_message:
          fatalErrors[0] ||
          rawStderr.trim() ||
          `Backend rejected model '${opts.model}' or effort '${opts.effort ?? ""}'`,
        parsed_output: null,
        insufficient_evidence_ids: [],
      };
    }
    return {
      ok: false,
      timed_out: false,
      exit_code: exitInfo.code,
      signal: exitInfo.signal,
      backend_session_id: sessionId,
      failure_kind: "backend_error",
      failure_message:
        fatalErrors[0] || rawStderr.trim() || `Backend exited with code ${exitInfo.code}`,
      parsed_output: null,
      insufficient_evidence_ids: [],
    };
  }

  if (!sawTerminalEvent) {
    return {
      ok: false,
      timed_out: false,
      exit_code: exitInfo.code,
      signal: exitInfo.signal,
      backend_session_id: sessionId,
      failure_kind: "missing_terminal_event",
      failure_message: "Backend exited 0 without emitting a terminal completion event (turn.completed)",
      parsed_output: null,
      insufficient_evidence_ids: [],
    };
  }

  if (!finalMessageText || finalMessageText.trim().length === 0) {
    return {
      ok: false,
      timed_out: false,
      exit_code: exitInfo.code,
      signal: exitInfo.signal,
      backend_session_id: sessionId,
      failure_kind: "empty_output",
      failure_message: "Backend exited 0 with empty output",
      parsed_output: null,
      insufficient_evidence_ids: [],
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(extractJsonText(finalMessageText));
  } catch (err) {
    return {
      ok: false,
      timed_out: false,
      exit_code: exitInfo.code,
      signal: exitInfo.signal,
      backend_session_id: sessionId,
      failure_kind: "invalid_output_schema",
      failure_message: `Output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      parsed_output: null,
      insufficient_evidence_ids: [],
    };
  }

  if (opts.command === "delegate") {
    const validated = validateDelegateOutput(parsedJson);
    if (!validated.ok) {
      return {
        ok: false,
        timed_out: false,
        exit_code: exitInfo.code,
        signal: exitInfo.signal,
        backend_session_id: sessionId,
        failure_kind: "invalid_output_schema",
        failure_message: `Delegate output failed schema validation: ${validated.errors.join("; ")}`,
        parsed_output: null,
        insufficient_evidence_ids: [],
      };
    }
    return {
      ok: true,
      timed_out: false,
      exit_code: exitInfo.code,
      signal: exitInfo.signal,
      backend_session_id: sessionId,
      failure_kind: null,
      failure_message: null,
      parsed_output: validated.output,
      insufficient_evidence_ids: [],
    };
  }

  const validated = validateReviewOutput(parsedJson);
  if (!validated.ok) {
    return {
      ok: false,
      timed_out: false,
      exit_code: exitInfo.code,
      signal: exitInfo.signal,
      backend_session_id: sessionId,
      failure_kind: "invalid_output_schema",
      failure_message: `Review output failed schema validation: ${validated.errors.join("; ")}`,
      parsed_output: null,
      insufficient_evidence_ids: [],
    };
  }

  return {
    ok: true,
    timed_out: false,
    exit_code: exitInfo.code,
    signal: exitInfo.signal,
    backend_session_id: sessionId,
    failure_kind: null,
    failure_message: null,
    parsed_output: validated.output,
    insufficient_evidence_ids: validated.insufficient_evidence_ids,
  };
}
