export type CommandKind = "review-plan" | "delegate" | "review-changes";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type ExecutionStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "partial";

export type AcceptanceStatus =
  | "pending_triage"
  | "approved"
  | "changes_requested"
  | "blocked"
  | "stale";

export type FailureKind =
  | "invalid_packet"
  | "invalid_parameter"
  | "backend_unavailable"
  | "writer_lock_held"
  | "recursion_blocked"
  | "resume_error"
  | "boundary_violation"
  | "timed_out"
  | "cancelled"
  | "empty_output"
  | "missing_terminal_event"
  | "invalid_output_schema"
  | "backend_error"
  | "git_error";

export type FindingCategory =
  | "requirement_gap"
  | "real_defect"
  | "engineering_tradeoff"
  | "optional_polish";

export type DispositionAction =
  | "accept"
  | "minimal_fix"
  | "defer"
  | "request_evidence"
  | "reject_overdesign";

export interface PacketScope {
  allowed_paths: string[];
  worktree_required?: boolean;
}

export interface HandoffPacket {
  original_request: string;
  goal: string;
  acceptance_criteria: string[];
  constraints: string[];
  non_goals: string[];
  relevant_files: string[];
  plan?: string;
  diff_summary?: string;
  scope?: PacketScope;
  extra_instructions?: string;
}

export interface RoleConfig {
  agent?: string;
  backend?: string;
  model?: string | null;
  effort?: string;
  max_rounds?: number;
  timeout_sec?: number;
}

export interface ProjectConfig {
  roles?: Record<string, Partial<RoleConfig>>;
  defaults?: {
    timeout_sec?: number;
    max_rounds?: number;
    scope?: Partial<PacketScope>;
  };
}

export interface UserConfig {
  roles?: Record<string, RoleConfig>;
  defaults?: {
    timeout_sec?: number;
    max_rounds?: number;
  };
}

export interface ResolvedConfig {
  roles: Record<string, RoleConfig>;
  defaults: {
    timeout_sec: number;
    max_rounds: number;
  };
  sources: {
    user_config_path: string;
    user_config_exists: boolean;
    project_config_path: string | null;
    project_config_exists: boolean;
    ignored_untrusted_project_keys: string[];
  };
}

export interface BackendCapabilities {
  model: boolean;
  effort: boolean;
  sandbox: boolean;
  resume: boolean;
  output_schema: boolean;
  worktree: boolean;
}

export interface BackendProfile {
  name: string;
  display_name: string;
  active: boolean;
  binary: string;
  output_protocol: "codex-jsonl" | "json" | "jsonl-generic" | "text";
  capabilities: BackendCapabilities;
  defaults?: {
    model?: string;
    effort?: string;
    timeout_sec?: number;
  };
  exec: {
    base_args: string[];
    model_flag?: string;
    effort_mode?: "flag" | "codex-config" | "none";
    effort_flag?: string;
    effort_config_key?: string;
    sandbox_flag?: string;
    sandbox_map?: Partial<Record<SandboxMode, string>>;
    cwd_flag?: string;
    output_schema_flag?: string;
    output_last_message_flag?: string;
    prompt_mode: "stdin-dash" | "stdin" | "arg" | "flag";
    prompt_separator?: string;
    prompt_flag?: string;
    extra_env?: Record<string, string>;
  };
  resume: {
    supported: boolean;
    subcommand?: string[];
    pre_subcommand_flags?: string[];
    session_mode?: "positional-before-prompt" | "flag";
    session_flag?: string;
    never_use_last: true;
  };
}

export interface DiscoveredBackend {
  name: string;
  display_name: string;
  active: boolean;
  binary: string;
  resolved_binary: string | null;
  available: boolean;
  source: "bundled" | "user";
  profile_path: string;
  capabilities: BackendCapabilities;
  profile: BackendProfile;
}

export interface FileSnapshotEntry {
  status: string;
  sha256: string | null;
}

export interface WorkspaceFingerprint {
  digest: string;
  is_git: boolean;
  head: string;
  entries: Record<string, FileSnapshotEntry>;
  computed_at: string;
  status_error?: string;
}

export interface Finding {
  id: string;
  category: FindingCategory;
  blocking: boolean;
  title: string;
  evidence: string;
  trigger: string;
  impact: string;
  minimal_fix: string;
  files: string[];
  insufficient_evidence?: boolean;
  missing_fields?: string[];
}

export interface ReviewOutput {
  verdict: "approve" | "changes_requested" | "blocked";
  summary: string;
  findings: Finding[];
}

export interface DelegateOutput {
  status: "completed" | "blocked";
  summary: string;
  modified_files: string[];
  tests_run: string[];
  open_issues: string[];
}

export interface FindingDispositionInput {
  finding_id: string;
  action: DispositionAction;
  reason?: string;
}

export interface FindingDispositionRecord extends FindingDispositionInput {
  category: FindingCategory;
  accepted: boolean;
  blocking_after: boolean;
  note: string;
}

export interface RunRecord {
  run_id: string;
  task_id: string;
  command: CommandKind;
  role: string;
  backend: string;
  model: string | null;
  effort: string | null;
  sandbox: SandboxMode;
  timeout_sec: number;
  round: number;
  max_rounds: number;
  resumed_from_session_id: string | null;
  cwd: string;
  effective_cwd: string;
  worktree_path: string | null;
  execution_status: ExecutionStatus;
  acceptance_status: AcceptanceStatus;
  failure_kind: FailureKind | null;
  failure_message: string | null;
  pid: number | null;
  pgid: number | null;
  worker_pid: number | null;
  exit_code: number | null;
  signal: string | null;
  backend_session_id: string | null;
  pre_fingerprint: WorkspaceFingerprint;
  post_fingerprint: WorkspaceFingerprint | null;
  changed_files: string[];
  boundary_violation: boolean;
  boundary_violations: string[];
  verdict_valid: boolean;
  freshness_status: "fresh" | "stale_by_code_change" | "invalid_boundary" | "not_applicable";
  parsed_output: ReviewOutput | DelegateOutput | null;
  dispositions: FindingDispositionRecord[];
  started_at: string;
  ended_at: string | null;
  raw_events_path: string;
  stderr_path: string;
  prompt_path: string;
  last_message_path: string;
}

export interface TaskRecord {
  task_id: string;
  cwd: string;
  backend: string;
  backend_session_id: string | null;
  round: number;
  max_rounds: number;
  latest_run_id: string | null;
  run_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface WriterLockRecord {
  pid: number;
  pgid: number | null;
  run_id: string;
  task_id: string;
  cwd: string;
  acquired_at: string;
}

export interface TriageResult {
  decision: "skip_heavy_flow" | "use_agy_orch";
  risk_level: "trivial" | "moderate" | "high";
  recommended_commands: CommandKind[];
  reasons: string[];
}
