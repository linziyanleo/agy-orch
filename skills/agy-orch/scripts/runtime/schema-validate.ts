import type {
  AcceptanceStatus,
  DelegateOutput,
  DispositionAction,
  Finding,
  FindingCategory,
  FindingDispositionInput,
  FindingDispositionRecord,
  ReviewOutput,
  RunRecord,
} from "./types.ts";

const VALID_VERDICTS = new Set(["approve", "changes_requested", "blocked"]);
const VALID_CATEGORIES = new Set<FindingCategory>([
  "requirement_gap",
  "real_defect",
  "engineering_tradeoff",
  "optional_polish",
]);
const VALID_DISPOSITION_ACTIONS = new Set<DispositionAction>([
  "accept",
  "minimal_fix",
  "defer",
  "request_evidence",
  "reject_overdesign",
]);

const PLACEHOLDER_RE = /^(n\/a|na|none|null|undefined|-+|tbd|todo|\?+)$/i;

function isConcreteText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return !PLACEHOLDER_RE.test(trimmed);
}

export function validateReviewOutput(
  raw: unknown
): { ok: true; output: ReviewOutput; insufficient_evidence_ids: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["review output must be a JSON object"] };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.verdict !== "string" || !VALID_VERDICTS.has(obj.verdict)) {
    errors.push("verdict must be one of approve | changes_requested | blocked");
  }
  if (typeof obj.summary !== "string" || obj.summary.trim().length === 0) {
    errors.push("summary must be a non-empty string");
  }
  if (!Array.isArray(obj.findings)) {
    errors.push("findings must be an array");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const normalizedFindings: Finding[] = [];
  const insufficientIds: string[] = [];
  const rawFindings = obj.findings as unknown[];

  for (let i = 0; i < rawFindings.length; i++) {
    const f = rawFindings[i];
    if (typeof f !== "object" || f === null || Array.isArray(f)) {
      errors.push(`findings[${i}] must be an object`);
      continue;
    }
    const item = f as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id.trim()) {
      errors.push(`findings[${i}].id must be a non-empty string`);
    }
    if (
      typeof item.category !== "string" ||
      !VALID_CATEGORIES.has(item.category as FindingCategory)
    ) {
      errors.push(`findings[${i}].category invalid`);
    }
    if (typeof item.blocking !== "boolean") {
      errors.push(`findings[${i}].blocking must be boolean`);
    }
    if (typeof item.title !== "string" || !item.title.trim()) {
      errors.push(`findings[${i}].title must be a non-empty string`);
    }
    if (typeof item.evidence !== "string") {
      errors.push(`findings[${i}].evidence must be a string`);
    }
    if (typeof item.trigger !== "string") {
      errors.push(`findings[${i}].trigger must be a string`);
    }
    if (typeof item.impact !== "string") {
      errors.push(`findings[${i}].impact must be a string`);
    }
    if (typeof item.minimal_fix !== "string") {
      errors.push(`findings[${i}].minimal_fix must be a string`);
    }
    if (!Array.isArray(item.files) || !item.files.every((x) => typeof x === "string")) {
      errors.push(`findings[${i}].files must be a string[]`);
    }
    if (errors.length > 0) continue;

    const category = item.category as FindingCategory;
    // Runtime invariant: optional_polish can never block acceptance.
    const blocking = category === "optional_polish" ? false : (item.blocking as boolean);

    const finding: Finding = {
      id: (item.id as string).trim(),
      category,
      blocking,
      title: (item.title as string).trim(),
      evidence: (item.evidence as string).trim(),
      trigger: (item.trigger as string).trim(),
      impact: (item.impact as string).trim(),
      minimal_fix: (item.minimal_fix as string).trim(),
      files: item.files as string[],
    };

    if (category === "real_defect" || category === "requirement_gap") {
      const missing: string[] = [];
      if (!isConcreteText(finding.evidence)) missing.push("evidence");
      if (!isConcreteText(finding.trigger)) missing.push("trigger");
      if (!isConcreteText(finding.impact)) missing.push("impact");
      if (!isConcreteText(finding.minimal_fix)) missing.push("minimal_fix");
      if (missing.length > 0) {
        finding.insufficient_evidence = true;
        finding.missing_fields = missing;
        insufficientIds.push(finding.id);
      }
    }

    normalizedFindings.push(finding);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    output: {
      verdict: obj.verdict as ReviewOutput["verdict"],
      summary: (obj.summary as string).trim(),
      findings: normalizedFindings,
    },
    insufficient_evidence_ids: insufficientIds,
  };
}

export function validateDelegateOutput(
  raw: unknown
): { ok: true; output: DelegateOutput } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["delegate output must be a JSON object"] };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.status !== "completed" && obj.status !== "blocked") {
    errors.push("status must be completed | blocked");
  }
  if (typeof obj.summary !== "string" || !obj.summary.trim()) {
    errors.push("summary must be a non-empty string");
  }
  if (!Array.isArray(obj.modified_files) || !obj.modified_files.every((x) => typeof x === "string")) {
    errors.push("modified_files must be string[]");
  }
  if (!Array.isArray(obj.tests_run) || !obj.tests_run.every((x) => typeof x === "string")) {
    errors.push("tests_run must be string[]");
  }
  if (!Array.isArray(obj.open_issues) || !obj.open_issues.every((x) => typeof x === "string")) {
    errors.push("open_issues must be string[]");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    output: {
      status: obj.status as DelegateOutput["status"],
      summary: (obj.summary as string).trim(),
      modified_files: obj.modified_files as string[],
      tests_run: obj.tests_run as string[],
      open_issues: obj.open_issues as string[],
    },
  };
}

export function applyDispositions(
  run: RunRecord,
  decisions: FindingDispositionInput[]
):
  | {
      ok: true;
      dispositions: FindingDispositionRecord[];
      acceptance_status: AcceptanceStatus;
      unresolved_blocking_ids: string[];
    }
  | { ok: false; errors: string[] } {
  if (run.command === "delegate") {
    return { ok: false, errors: ["dispose applies only to review-plan and review-changes runs"] };
  }
  if (!run.parsed_output || !("findings" in run.parsed_output)) {
    return { ok: false, errors: ["run has no parsed review findings to dispose"] };
  }

  const findings = run.parsed_output.findings;
  const findingMap = new Map<string, Finding>(findings.map((f) => [f.id, f]));
  const decisionMap = new Map<string, FindingDispositionInput>();
  const errors: string[] = [];

  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    if (!d || typeof d.finding_id !== "string" || !findingMap.has(d.finding_id)) {
      errors.push(`decisions[${i}]: unknown finding_id '${d?.finding_id ?? ""}'`);
      continue;
    }
    if (!VALID_DISPOSITION_ACTIONS.has(d.action)) {
      errors.push(`decisions[${i}]: invalid action '${d.action}'`);
      continue;
    }
    decisionMap.set(d.finding_id, d);
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const records: FindingDispositionRecord[] = [];
  const unresolvedBlockingIds: string[] = [];

  for (const finding of findings) {
    const decision = decisionMap.get(finding.id);

    if (!decision) {
      const stillBlocking =
        finding.category === "real_defect" ||
        finding.category === "requirement_gap" ||
        finding.blocking;
      if (stillBlocking) {
        unresolvedBlockingIds.push(finding.id);
      }
      continue;
    }

    const reason = decision.reason?.trim() ?? "";
    let blockingAfter = false;
    let accepted = true;
    let note = "";

    if (finding.category === "optional_polish") {
      blockingAfter = false;
      note =
        decision.action === "reject_overdesign" || decision.action === "defer"
          ? "optional_polish dismissed without blocking"
          : `optional_polish handled via ${decision.action}`;
    } else if (finding.category === "engineering_tradeoff") {
      if (decision.action === "reject_overdesign" || decision.action === "defer") {
        if (!reason) {
          accepted = false;
          blockingAfter = finding.blocking;
          note = "reject_overdesign/defer on engineering_tradeoff requires a justification reason";
        } else {
          blockingAfter = false;
          note = `justified ${decision.action}: ${reason}`;
        }
      } else if (decision.action === "request_evidence") {
        blockingAfter = true;
        note = "evidence requested";
      } else {
        blockingAfter = false;
        note = `resolved via ${decision.action}`;
      }
    } else {
      // real_defect or requirement_gap
      if (decision.action === "accept" || decision.action === "minimal_fix") {
        blockingAfter = false;
        note = `resolved via ${decision.action}`;
      } else if (decision.action === "request_evidence") {
        blockingAfter = true;
        note = "evidence requested before resolution";
      } else if (
        finding.insufficient_evidence &&
        decision.action === "reject_overdesign" &&
        reason.length > 0
      ) {
        // Only if runtime flagged insufficient_evidence can an unsubstantiated defect claim be rejected with reason.
        blockingAfter = false;
        note = `rejected unsubstantiated claim (insufficient_evidence): ${reason}`;
      } else {
        accepted = false;
        blockingAfter = true;
        note = `cannot auto-dismiss substantiated ${finding.category} via ${decision.action}; must resolve via accept or minimal_fix`;
      }
    }

    if (blockingAfter) {
      unresolvedBlockingIds.push(finding.id);
    }

    records.push({
      finding_id: finding.id,
      action: decision.action,
      reason: decision.reason,
      category: finding.category,
      accepted,
      blocking_after: blockingAfter,
      note,
    });
  }

  let acceptance_status: AcceptanceStatus;
  if (run.freshness_status === "stale_by_code_change") {
    acceptance_status = "stale";
  } else if (run.boundary_violation || run.execution_status !== "completed") {
    acceptance_status = "blocked";
  } else if (unresolvedBlockingIds.length > 0) {
    // Round cap NEVER auto-approves an unresolved real_defect or requirement_gap.
    acceptance_status = run.round >= run.max_rounds ? "blocked" : "changes_requested";
  } else {
    acceptance_status = "approved";
  }

  return {
    ok: true,
    dispositions: records,
    acceptance_status,
    unresolved_blocking_ids: unresolvedBlockingIds,
  };
}
