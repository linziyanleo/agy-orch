import fs from "node:fs";
import type { CommandKind, HandoffPacket } from "./types.ts";

export function loadPacketFromSource(source: string): unknown {
  const raw =
    source === "-"
      ? fs.readFileSync(0, "utf8")
      : fs.readFileSync(source, "utf8");
  return JSON.parse(raw);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown, requireNonEmpty: boolean): value is string[] {
  if (!Array.isArray(value)) return false;
  if (requireNonEmpty && value.length === 0) return false;
  return value.every((item) => typeof item === "string" && item.trim().length > 0);
}

export function validateHandoffPacket(
  raw: unknown,
  command: CommandKind
): { ok: true; packet: HandoffPacket } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["handoff packet must be a JSON object"] };
  }

  const obj = raw as Record<string, unknown>;
  if (!isNonEmptyString(obj.original_request)) {
    errors.push("original_request must be a non-empty string");
  }
  if (!isNonEmptyString(obj.goal)) {
    errors.push("goal must be a non-empty string");
  }
  if (!isStringArray(obj.acceptance_criteria, true)) {
    errors.push("acceptance_criteria must be a non-empty string[]");
  }
  if (!isStringArray(obj.constraints, false)) {
    errors.push("constraints must be a string[]");
  }
  if (!isStringArray(obj.non_goals, false)) {
    errors.push("non_goals must be a string[]");
  }
  if (!isStringArray(obj.relevant_files, false)) {
    errors.push("relevant_files must be a string[]");
  }
  if (obj.images !== undefined && !isStringArray(obj.images, false)) {
    errors.push("images must be a string[] of non-empty paths");
  }

  if (command === "delegate") {
    const scope = obj.scope;
    if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
      errors.push("delegate requires scope.allowed_paths (non-empty string[])");
    } else {
      const allowed = (scope as Record<string, unknown>).allowed_paths;
      if (!isStringArray(allowed, true)) {
        errors.push("scope.allowed_paths must be a non-empty string[] for delegate");
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, packet: obj as unknown as HandoffPacket };
}

export function buildExecutionPrompt(
  command: CommandKind,
  packet: HandoffPacket,
  runId: string,
  taskId: string,
  depth: number,
  isResume: boolean
): string {
  const lines: string[] = [
    "SYSTEM GOVERNANCE & ANTI-RECURSION RULES:",
    `- You are running inside agy-orch as a bounded specialist worker (run_id=${runId}, task_id=${taskId}, depth=${depth}).`,
    "- NEVER invoke `agy-orch`, `agy-orch.mjs`, or spawn nested agy-orch orchestration loops.",
    "- Stick strictly to the requested role, scope, constraints, and non-goals below.",
  ];

  if (command === "review-plan" || command === "review-changes") {
    lines.push(
      "- You are in READ-ONLY review mode. Do NOT modify any files.",
      "- Classify every finding as one of: requirement_gap | real_defect | engineering_tradeoff | optional_polish.",
      "- Reserve real_defect and requirement_gap strictly for defects or missing requirements reachable through realistic caller or external-input paths within the declared scope and trust boundaries, with concrete evidence (file:line or symbol), trigger condition, user/system impact, and minimal_fix.",
      "- Validate external boundaries (CLI, network, config, storage, untrusted input) once; do NOT flag missing defensive guards, redundant nil/type checks, silent fallbacks, or hypothetical malformed inputs inside internal module boundaries where caller and type invariants already hold. Do NOT invent speculative abstractions, frameworks, or extra dependencies; omit internal-hardening nitpicks or classify genuine boundary tradeoffs at most as engineering_tradeoff or optional_polish (blocking=false).",
      "- optional_polish items MUST have blocking=false."
    );
    if (isResume) {
      lines.push(
        "- RESUME REVIEW SCOPE: Verify whether prior unresolved blockers are resolved and check for regressions introduced by the new changes. Do NOT open new speculative or defensive nitpick rounds on unchanged code or settled design choices."
      );
    }
    lines.push("- Respond with JSON matching the provided review output schema.");
  } else {
    const allowed = packet.scope?.allowed_paths ?? [];
    lines.push(
      "- You are in SCOPED DELEGATION mode. Modify ONLY files matching scope.allowed_paths:",
      ...allowed.map((p) => `  * ${p}`),
      "- Do NOT touch files outside scope.allowed_paths.",
      "- Keep changes minimal and direct; validate external boundaries once and do NOT add unrequested abstractions, extra dependencies, or redundant defensive fallbacks inside trusted internal callers.",
      "- Respond with JSON matching the provided delegate output schema."
    );
  }

  lines.push(
    "",
    isResume ? "=== RESUMED TASK CONTEXT ===" : "=== TASK HANDOFF PACKET ===",
    `original_request: ${packet.original_request}`,
    `goal: ${packet.goal}`,
    "acceptance_criteria:",
    ...packet.acceptance_criteria.map((c) => `- ${c}`),
    "constraints:",
    ...(packet.constraints.length ? packet.constraints.map((c) => `- ${c}`) : ["- (none)"]),
    "non_goals:",
    ...(packet.non_goals.length ? packet.non_goals.map((c) => `- ${c}`) : ["- (none)"]),
    "relevant_files:",
    ...(packet.relevant_files.length ? packet.relevant_files.map((f) => `- ${f}`) : ["- (none)"])
  );

  if (packet.images && packet.images.length > 0) {
    lines.push("attached_images:", ...packet.images.map((img) => `- ${img}`));
  }

  if (packet.plan) {
    lines.push("", "proposed_plan:", packet.plan);
  }
  if (packet.diff_summary) {
    lines.push("", "diff_summary:", packet.diff_summary);
  }
  if (packet.extra_instructions) {
    lines.push("", "extra_instructions:", packet.extra_instructions);
  }

  return `${lines.join("\n")}\n`;
}
