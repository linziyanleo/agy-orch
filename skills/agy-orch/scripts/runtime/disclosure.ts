import fs from "node:fs";
import { getUnresolvedBlockingFindings } from "./schema-validate.ts";
import { asObject, asText, compactText, summarizeEvent } from "./swarm.ts";
import type {
  EventsTailPayload,
  FindingCategory,
  FindingCounts,
  FindingDispositionRecord,
  FingerprintSummary,
  ReviewOutput,
  RunCancelView,
  RunLiveActivity,
  RunRecord,
  RunStatusView,
  RunViewBase,
  StatusOutputSummary,
  StderrTailPayload,
  TailEventItem,
  WorkspaceFingerprint,
} from "./types.ts";

const STATUS_CHANGED_FILES_CAP = 20;
const CANCEL_CHANGED_FILES_CAP = 50;

function capLine(line: string, maxLen: number): string {
  if (line.length <= maxLen) return line;
  return `${line.slice(0, maxLen - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

export function summarizeFingerprint(fp: WorkspaceFingerprint): FingerprintSummary {
  const summary: FingerprintSummary = {
    digest: fp.digest,
    is_git: fp.is_git,
    head: fp.head,
    entry_count: Object.keys(fp.entries).length,
    computed_at: fp.computed_at,
  };
  if (fp.status_error !== undefined) {
    summary.status_error = fp.status_error;
  }
  return summary;
}

export function computeFindingCounts(
  output: ReviewOutput,
  dispositions: FindingDispositionRecord[]
): FindingCounts {
  const byCategory: Record<FindingCategory, number> = {
    requirement_gap: 0,
    real_defect: 0,
    engineering_tradeoff: 0,
    optional_polish: 0,
  };
  let blocking = 0;
  let insufficientEvidence = 0;

  for (const finding of output.findings) {
    byCategory[finding.category] += 1;
    if (
      finding.category === "real_defect" ||
      finding.category === "requirement_gap" ||
      finding.blocking === true
    ) {
      blocking += 1;
    }
    if (finding.insufficient_evidence) {
      insufficientEvidence += 1;
    }
  }

  const unresolvedSet = new Set(getUnresolvedBlockingFindings(output.findings, dispositions));
  return {
    total: output.findings.length,
    blocking,
    unresolved_blocking: unresolvedSet.size,
    by_category: byCategory,
    insufficient_evidence: insufficientEvidence,
  };
}

function hasNonLineBreakBytes(buffer: Buffer, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (buffer[i] !== 0x0a && buffer[i] !== 0x0d) return true;
  }
  return false;
}

function readBoundedTailText(
  filePath: string,
  maxTailBytes: number,
  allowPartialFirstLine = false
): { exists: true; truncated: boolean; text: string } | { exists: false } {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) {
        return { exists: false };
      }
      const offset = Math.max(0, stat.size - maxTailBytes);
      const truncated = offset > 0;
      // Include one preceding byte so a tail starting on a newline boundary keeps that line.
      const start = truncated ? offset - 1 : offset;
      const buffer = Buffer.alloc(stat.size - start);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, start);
      const firstNewline = truncated ? buffer.subarray(0, bytesRead).indexOf(0x0a) : -1;
      let textStart = 0;
      if (truncated) {
        if (
          firstNewline !== -1 &&
          (!allowPartialFirstLine || hasNonLineBreakBytes(buffer, firstNewline + 1, bytesRead))
        ) {
          textStart = firstNewline + 1;
        } else if (allowPartialFirstLine) {
          let idx = 1;
          while (idx < bytesRead && (buffer[idx] & 0xc0) === 0x80) {
            idx += 1;
          }
          textStart = idx;
        } else {
          return { exists: true, truncated: true, text: "" };
        }
      }
      return {
        exists: true,
        truncated,
        text: buffer.toString("utf8", textStart, bytesRead),
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { exists: false };
  }
}

export function readEventsTail(
  rawEventsPath: string,
  limit: number,
  maxTailBytes = 256 * 1024
): EventsTailPayload {
  const safeLimit = Math.max(1, Math.floor(limit));
  const tail = readBoundedTailText(rawEventsPath, maxTailBytes);
  if (!tail.exists) {
    return {
      path: rawEventsPath,
      exists: false,
      truncated: false,
      event_count: 0,
      events: [],
    };
  }

  const parsed: TailEventItem[] = [];
  for (const line of tail.text.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown> | undefined;
    try {
      event = asObject(JSON.parse(line));
    } catch {
      continue;
    }
    if (!event) continue;
    const item = asObject(event.item);
    parsed.push({
      type: asText(event.type) ?? null,
      item_type: asText(item?.type) ?? null,
      summary: compactText(summarizeEvent(event, item), 240),
    });
  }

  const events = parsed.slice(-safeLimit);
  return {
    path: rawEventsPath,
    exists: true,
    truncated: tail.truncated || parsed.length > safeLimit,
    event_count: events.length,
    events,
  };
}

export function readStderrTail(
  stderrPath: string,
  limit: number,
  maxTailBytes = 64 * 1024
): StderrTailPayload {
  const safeLimit = Math.max(1, Math.floor(limit));
  const tail = readBoundedTailText(stderrPath, maxTailBytes, true);
  if (!tail.exists) {
    return {
      path: stderrPath,
      exists: false,
      truncated: false,
      line_count: 0,
      lines: [],
    };
  }

  const allLines = tail.text.split(/\r?\n/);
  while (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }

  let anyLineClipped = false;
  const lines = allLines.slice(-safeLimit).map((line) => {
    if (line.length > 500) anyLineClipped = true;
    return capLine(line, 500);
  });
  return {
    path: stderrPath,
    exists: true,
    truncated: tail.truncated || allLines.length > safeLimit || anyLineClipped,
    line_count: lines.length,
    lines,
  };
}

function summarizeOutputForStatus(run: RunRecord): StatusOutputSummary | null {
  if (!run.parsed_output) return null;
  if ("findings" in run.parsed_output) {
    return {
      kind: "review",
      verdict: run.parsed_output.verdict,
      summary: run.parsed_output.summary,
      finding_counts: computeFindingCounts(run.parsed_output, run.dispositions),
      disposition_count: run.dispositions.length,
    };
  }
  return {
    kind: "delegate",
    status: run.parsed_output.status,
    summary: run.parsed_output.summary,
    modified_files_count: run.parsed_output.modified_files.length,
    tests_run_count: run.parsed_output.tests_run.length,
    open_issues_count: run.parsed_output.open_issues.length,
  };
}

function collectBaseOmittedDetails(run: RunRecord, changedFilesCap: number): string[] {
  const omitted: string[] = [];
  if (Object.keys(run.pre_fingerprint.entries).length > 0) {
    omitted.push("pre_fingerprint.entries");
  }
  if (run.post_fingerprint && Object.keys(run.post_fingerprint.entries).length > 0) {
    omitted.push("post_fingerprint.entries");
  }
  if (run.changed_files.length > changedFilesCap) {
    omitted.push("changed_files");
  }
  return omitted;
}

function buildRunViewBase(
  run: RunRecord,
  changedFilesCap: number,
  disclosureLevel: RunViewBase["disclosure_level"],
  detailsOmitted: string[],
  nextActions: string[]
): RunViewBase {
  return {
    run_id: run.run_id,
    task_id: run.task_id,
    command: run.command,
    role: run.role,
    backend: run.backend,
    model: run.model,
    effort: run.effort,
    sandbox: run.sandbox,
    timeout_sec: run.timeout_sec,
    round: run.round,
    max_rounds: run.max_rounds,
    resumed_from_session_id: run.resumed_from_session_id,
    cwd: run.cwd,
    effective_cwd: run.effective_cwd,
    worktree_path: run.worktree_path,
    execution_status: run.execution_status,
    acceptance_status: run.acceptance_status,
    failure_kind: run.failure_kind,
    failure_message: run.failure_message,
    pid: run.pid,
    pgid: run.pgid,
    worker_pid: run.worker_pid,
    exit_code: run.exit_code,
    signal: run.signal,
    backend_session_id: run.backend_session_id,
    pre_fingerprint: summarizeFingerprint(run.pre_fingerprint),
    post_fingerprint: run.post_fingerprint ? summarizeFingerprint(run.post_fingerprint) : null,
    changed_files_count: run.changed_files.length,
    changed_files: run.changed_files.slice(0, changedFilesCap),
    boundary_violation: run.boundary_violation,
    boundary_violations: run.boundary_violations,
    verdict_valid: run.verdict_valid,
    freshness_status: run.freshness_status,
    started_at: run.started_at,
    ended_at: run.ended_at,
    raw_events_path: run.raw_events_path,
    stderr_path: run.stderr_path,
    prompt_path: run.prompt_path,
    last_message_path: run.last_message_path,
    disclosure_level: disclosureLevel,
    details_omitted: detailsOmitted,
    next_actions: nextActions,
  };
}

function buildStatusNextActions(run: RunRecord): string[] {
  if (run.execution_status === "running") {
    return [
      `agy-orch status --run-id ${run.run_id}`,
      `agy-orch status --run-id ${run.run_id} --events-tail 20`,
      `agy-orch cancel --run-id ${run.run_id}`,
    ];
  }
  if (run.execution_status === "completed") {
    const actions = [`agy-orch result --run-id ${run.run_id}`];
    if (run.parsed_output && "findings" in run.parsed_output) {
      const unresolved = getUnresolvedBlockingFindings(run.parsed_output.findings, run.dispositions);
      if (unresolved.length > 0) {
        actions.push(`agy-orch result --run-id ${run.run_id} --blocking-only`);
      } else if (run.parsed_output.findings.length > 0) {
        actions.push(`agy-orch result --run-id ${run.run_id} --full`);
      }
    }
    actions.push(`agy-orch swarm-post --run-id ${run.run_id}`);
    return actions;
  }
  return [
    `agy-orch status --run-id ${run.run_id} --stderr-tail 40 --events-tail 20`,
    `agy-orch result --run-id ${run.run_id}`,
    `agy-orch result --run-id ${run.run_id} --full`,
  ];
}

export function formatStatusView(
  run: RunRecord,
  opts: {
    includeLiveActivity: boolean;
    liveActivity?: RunLiveActivity | null;
    eventsTail?: EventsTailPayload;
    stderrTail?: StderrTailPayload;
  }
): RunStatusView {
  const detailsOmitted = collectBaseOmittedDetails(run, STATUS_CHANGED_FILES_CAP);
  if (run.parsed_output !== null) {
    detailsOmitted.push("parsed_output");
  }
  if (run.dispositions.length > 0) {
    detailsOmitted.push("dispositions");
  }

  const base = buildRunViewBase(
    run,
    STATUS_CHANGED_FILES_CAP,
    "status",
    detailsOmitted,
    buildStatusNextActions(run)
  );
  const view: RunStatusView = {
    ...base,
    disclosure_level: "status",
    output_summary: summarizeOutputForStatus(run),
  };

  if (opts.includeLiveActivity) {
    view.live_activity = opts.liveActivity ?? null;
  }
  if (opts.eventsTail !== undefined) {
    view.events_tail = opts.eventsTail;
  }
  if (opts.stderrTail !== undefined) {
    view.stderr_tail = opts.stderrTail;
  }
  return view;
}

export function formatCancelView(
  run: RunRecord,
  killResult: { dead: boolean; escalated_to_sigkill: boolean } | null
): RunCancelView {
  const detailsOmitted = collectBaseOmittedDetails(run, CANCEL_CHANGED_FILES_CAP);
  if (run.parsed_output !== null) {
    detailsOmitted.push("parsed_output");
  }
  if (run.dispositions.length > 0) {
    detailsOmitted.push("dispositions");
  }

  const nextActions = [
    `agy-orch status --run-id ${run.run_id} --stderr-tail 40`,
    `agy-orch result --run-id ${run.run_id}`,
    `agy-orch result --run-id ${run.run_id} --full`,
  ];

  const base = buildRunViewBase(
    run,
    CANCEL_CHANGED_FILES_CAP,
    "status",
    detailsOmitted,
    nextActions
  );
  return {
    ...base,
    disclosure_level: "status",
    output_summary: summarizeOutputForStatus(run),
    kill_result: killResult,
  };
}
