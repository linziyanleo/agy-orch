import fs from "node:fs";
import { getUnresolvedBlockingFindings } from "./schema-validate.ts";
import { asObject, asText, compactText, summarizeEvent } from "./swarm.ts";
import type {
  DelegateOutputSummary,
  EventsTailPayload,
  Finding,
  FindingCategory,
  FindingCounts,
  FindingDispositionRecord,
  FindingIndexItem,
  FingerprintSummary,
  ReviewOutput,
  ReviewOutputSummary,
  RunCancelView,
  RunDetailView,
  RunLiveActivity,
  RunRecord,
  RunStatusView,
  RunSummaryView,
  RunViewBase,
  StatusOutputSummary,
  StderrTailPayload,
  TailEventItem,
  WorkspaceFingerprint,
} from "./types.ts";

const STATUS_CHANGED_FILES_CAP = 20;
const CANCEL_CHANGED_FILES_CAP = 50;
const SUMMARY_CHANGED_FILES_CAP = 20;
const DELEGATE_MODIFIED_FILES_CAP = 20;
const DELEGATE_LIST_CAP = 10;

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

function buildDispositionQueues(
  dispositions: FindingDispositionRecord[]
): Map<string, FindingDispositionRecord[]> {
  const queues = new Map<string, FindingDispositionRecord[]>();
  for (const record of dispositions) {
    const key = `${record.category}:${record.finding_id}`;
    const queue = queues.get(key) ?? [];
    queue.push(record);
    queues.set(key, queue);
  }
  return queues;
}

function summarizeReviewOutput(
  output: ReviewOutput,
  dispositions: FindingDispositionRecord[]
): ReviewOutputSummary {
  const unresolvedSet = new Set(getUnresolvedBlockingFindings(output.findings, dispositions));
  const dispositionQueues = buildDispositionQueues(dispositions);

  const findings: FindingIndexItem[] = output.findings.map((finding) => {
    const disp = dispositionQueues.get(`${finding.category}:${finding.id}`)?.shift();
    const item: FindingIndexItem = {
      id: finding.id,
      category: finding.category,
      blocking: finding.blocking,
      unresolved_blocking: unresolvedSet.has(finding),
      title: finding.title,
      files: finding.files,
    };
    if (finding.insufficient_evidence !== undefined) {
      item.insufficient_evidence = finding.insufficient_evidence;
    }
    if (finding.missing_fields !== undefined) {
      item.missing_fields = finding.missing_fields;
    }
    if (disp) {
      item.disposition = {
        action: disp.action,
        accepted: disp.accepted,
        blocking_after: disp.blocking_after,
      };
    }
    return item;
  });

  return {
    verdict: output.verdict,
    summary: output.summary,
    findings,
  };
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9._:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildSummaryNextActions(run: RunRecord, detailsOmitted: string[]): string[] {
  const actions: string[] = [];
  if (run.parsed_output && "findings" in run.parsed_output) {
    const unresolved = getUnresolvedBlockingFindings(run.parsed_output.findings, run.dispositions);
    if (unresolved.length > 0) {
      actions.push(`agy-orch result --run-id ${run.run_id} --blocking-only`);
    }
    if (run.parsed_output.findings.length > 0) {
      actions.push(`agy-orch result --run-id ${run.run_id} --finding ${shellArg(run.parsed_output.findings[0].id)}`);
    }
  }
  if (run.execution_status !== "completed" || run.failure_kind || run.failure_message) {
    actions.push(`agy-orch result --run-id ${run.run_id} --stderr-tail 40 --events-tail 20`);
  }
  if (detailsOmitted.length > 0) {
    actions.push(`agy-orch result --run-id ${run.run_id} --full`);
  }
  actions.push(`agy-orch swarm-post --run-id ${run.run_id}`);
  return actions;
}

export function formatResultSummaryView(
  run: RunRecord,
  opts: {
    eventsTail?: EventsTailPayload;
    stderrTail?: StderrTailPayload;
  } = {}
): RunSummaryView {
  const detailsOmitted = collectBaseOmittedDetails(run, SUMMARY_CHANGED_FILES_CAP);
  if (run.dispositions.length > 0) {
    detailsOmitted.push("dispositions");
  }

  let findingCounts: FindingCounts | undefined;
  let parsedOutputSummary: ReviewOutputSummary | DelegateOutputSummary | null = null;

  if (run.parsed_output) {
    if ("findings" in run.parsed_output) {
      findingCounts = computeFindingCounts(run.parsed_output, run.dispositions);
      parsedOutputSummary = summarizeReviewOutput(run.parsed_output, run.dispositions);
      if (run.parsed_output.findings.length > 0) {
        detailsOmitted.push(
          "parsed_output.findings[].evidence",
          "parsed_output.findings[].trigger",
          "parsed_output.findings[].impact",
          "parsed_output.findings[].minimal_fix"
        );
      }
    } else {
      const del = run.parsed_output;
      parsedOutputSummary = {
        status: del.status,
        summary: del.summary,
        modified_files: del.modified_files.slice(0, DELEGATE_MODIFIED_FILES_CAP),
        modified_files_count: del.modified_files.length,
        tests_run: del.tests_run.slice(0, DELEGATE_LIST_CAP),
        tests_run_count: del.tests_run.length,
        open_issues: del.open_issues.slice(0, DELEGATE_LIST_CAP),
        open_issues_count: del.open_issues.length,
      };
      if (del.modified_files.length > DELEGATE_MODIFIED_FILES_CAP) {
        detailsOmitted.push("parsed_output.modified_files");
      }
      if (del.tests_run.length > DELEGATE_LIST_CAP) {
        detailsOmitted.push("parsed_output.tests_run");
      }
      if (del.open_issues.length > DELEGATE_LIST_CAP) {
        detailsOmitted.push("parsed_output.open_issues");
      }
    }
  }

  const base = buildRunViewBase(
    run,
    SUMMARY_CHANGED_FILES_CAP,
    "summary",
    detailsOmitted,
    buildSummaryNextActions(run, detailsOmitted)
  );
  const view: RunSummaryView = {
    ...base,
    disclosure_level: "summary",
    dispositions_count: run.dispositions.length,
    ...(findingCounts !== undefined ? { finding_counts: findingCounts } : {}),
    parsed_output: parsedOutputSummary,
  };
  if (opts.eventsTail !== undefined) {
    view.events_tail = opts.eventsTail;
  }
  if (opts.stderrTail !== undefined) {
    view.stderr_tail = opts.stderrTail;
  }
  return view;
}

export function formatResultDetailView(
  run: RunRecord,
  opts: {
    findingIds?: string[];
    blockingOnly?: boolean;
    categories?: FindingCategory[];
    eventsTail?: EventsTailPayload;
    stderrTail?: StderrTailPayload;
  }
): { ok: true; view: RunDetailView } | { ok: false; error: string } {
  if (run.command === "delegate" || !run.parsed_output || !("findings" in run.parsed_output)) {
    return {
      ok: false,
      error: "Finding drill-down filters require a review run with parsed review findings",
    };
  }

  const output = run.parsed_output;
  const knownIds = new Set(output.findings.map((f) => f.id));
  if (opts.findingIds && opts.findingIds.length > 0) {
    const unknown = opts.findingIds.filter((id) => !knownIds.has(id));
    if (unknown.length > 0) {
      return {
        ok: false,
        error: `Unknown finding ID(s) for run '${run.run_id}': ${unknown.join(", ")}`,
      };
    }
  }

  const findingIdSet = opts.findingIds && opts.findingIds.length > 0 ? new Set(opts.findingIds) : null;
  const categorySet = opts.categories && opts.categories.length > 0 ? new Set(opts.categories) : null;
  const unresolvedSet = new Set(getUnresolvedBlockingFindings(output.findings, run.dispositions));
  const dispositionQueues = buildDispositionQueues(run.dispositions);

  const matchedFindings: Finding[] = [];
  const matchedDispositions: FindingDispositionRecord[] = [];
  for (const finding of output.findings) {
    const disp = dispositionQueues.get(`${finding.category}:${finding.id}`)?.shift();
    if (findingIdSet && !findingIdSet.has(finding.id)) continue;
    if (opts.blockingOnly && !unresolvedSet.has(finding)) continue;
    if (categorySet && !categorySet.has(finding.category)) continue;
    matchedFindings.push(finding);
    if (disp) matchedDispositions.push(disp);
  }

  const detailsOmitted = collectBaseOmittedDetails(run, SUMMARY_CHANGED_FILES_CAP);
  if (matchedFindings.length < output.findings.length) {
    detailsOmitted.push("parsed_output.findings");
  }
  if (matchedDispositions.length < run.dispositions.length) {
    detailsOmitted.push("dispositions");
  }

  const filter: RunDetailView["filter"] = {};
  if (opts.findingIds && opts.findingIds.length > 0) filter.finding_ids = opts.findingIds;
  if (opts.blockingOnly) filter.blocking_only = true;
  if (opts.categories && opts.categories.length > 0) filter.categories = opts.categories;

  const nextActions = [
    `agy-orch result --run-id ${run.run_id}`,
    `agy-orch result --run-id ${run.run_id} --full`,
    `agy-orch swarm-post --run-id ${run.run_id}`,
  ];

  const base = buildRunViewBase(
    run,
    SUMMARY_CHANGED_FILES_CAP,
    "detail",
    detailsOmitted,
    nextActions
  );
  const view: RunDetailView = {
    ...base,
    disclosure_level: "detail",
    finding_counts: computeFindingCounts(output, run.dispositions),
    filter,
    matched_count: matchedFindings.length,
    total_findings: output.findings.length,
    parsed_output: {
      verdict: output.verdict,
      summary: output.summary,
      findings: matchedFindings,
    },
    dispositions: matchedDispositions,
  };
  if (opts.eventsTail !== undefined) {
    view.events_tail = opts.eventsTail;
  }
  if (opts.stderrTail !== undefined) {
    view.stderr_tail = opts.stderrTail;
  }

  return { ok: true, view };
}
