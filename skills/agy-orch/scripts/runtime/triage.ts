import type { CommandKind, TriageResult } from "./types.ts";

const TRIVIAL_KINDS = new Set(["style", "copy", "css", "typo", "docs", "layout", "text"]);
const HIGH_RISK_KINDS = new Set(["arch", "security", "auth", "migration", "concurrency", "schema"]);
const LOGIC_OR_RISK_PATTERNS = [
  /\b(auth|token|jwt|session|permission|rbac|security)\b/i,
  /\b(state|race|concurrent|concurrency|async|debounce|double[- ]?submit|duplicate)\b/i,
  /\b(api|endpoint|backend|database|sql|migration|schema|transaction|webhook)\b/i,
  /\b(bug|fix|crash|regression|retry|timeout|lock)\b/i,
  /(鉴权|权限|并发|竞态|防重|重复提交|状态机|数据库|迁移|接口|异步|超时|重构|架构)/,
];
const STYLE_ONLY_EXTS = /\.(css|scss|less|svg|md|txt)$/i;

export interface TriageInput {
  summary: string;
  files?: string[];
  kind?: string;
}

export function triageTask(input: TriageInput): TriageResult {
  const summary = input.summary.trim();
  const files = (input.files ?? []).map((f) => f.trim()).filter(Boolean);
  const kind = input.kind?.trim().toLowerCase() ?? "";

  const reasons: string[] = [];
  const hasLogicSignals = LOGIC_OR_RISK_PATTERNS.some((re) => re.test(summary));
  const allStyleOrDocFiles = files.length > 0 && files.every((f) => STYLE_ONLY_EXTS.test(f));

  if (HIGH_RISK_KINDS.has(kind)) {
    reasons.push(`task kind '${kind}' requires architecture/risk review`);
    return {
      decision: "use_agy_orch",
      risk_level: "high",
      recommended_commands: ["review-plan", "delegate", "review-changes"],
      reasons,
    };
  }

  if (
    TRIVIAL_KINDS.has(kind) &&
    !hasLogicSignals &&
    (files.length <= 2 || allStyleOrDocFiles)
  ) {
    reasons.push(`trivial ${kind} change with ${files.length || "unspecified"} file(s) and no logic/state/auth risk`);
    return {
      decision: "skip_heavy_flow",
      risk_level: "trivial",
      recommended_commands: [],
      reasons,
    };
  }

  if (!kind && !hasLogicSignals && files.length === 1 && STYLE_ONLY_EXTS.test(files[0])) {
    reasons.push(`single style/doc file '${files[0]}' with no logic/state risk`);
    return {
      decision: "skip_heavy_flow",
      risk_level: "trivial",
      recommended_commands: [],
      reasons,
    };
  }

  if (hasLogicSignals) {
    reasons.push("summary indicates state, concurrency, auth, API, or logic defect risk");
  }
  if (files.length >= 3) {
    reasons.push(`touches ${files.length} files across scope`);
  }
  if (kind && !TRIVIAL_KINDS.has(kind)) {
    reasons.push(`task kind '${kind}' involves non-trivial behavior`);
  }
  if (reasons.length === 0) {
    reasons.push("defaulting to review-changes verification for non-trivial edit");
  }

  const commands: CommandKind[] =
    files.length >= 4 || /\b(plan|refactor|architecture|migration|multi)\b/i.test(summary)
      ? ["review-plan", "delegate", "review-changes"]
      : ["review-changes"];

  return {
    decision: "use_agy_orch",
    risk_level: commands.length > 1 ? "high" : "moderate",
    recommended_commands: commands,
    reasons,
  };
}
