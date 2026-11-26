---
name: agy-orch
license: MIT
description: Orchestrate bounded collaboration between the lead agent (Gemini / Antigravity) and external specialist or reviewer CLIs (default Codex, extensible to qodercli, pi, claude-code) via explicit handoff packets, read-only plan/code review, scoped delegation, freshness checks, and adversarial finding disposition. Use when implementing or modifying backend logic, auth/permissions, state machines, async/concurrency flows, APIs, multi-file changes, bug fixes with subtle state races or duplicate-submit risks, or when the user asks to delegate or have Codex review a plan or diff. Do NOT trigger on trivial single-file CSS/copy/typo tweaks, pure UI layout polish with no logic or state risk, or standalone factual questions; run the lightweight triage check first and skip heavy review when risk is trivial.
---

# agy-orch

Coordinate bounded multi-agent engineering work between the lead agent (`agy` / Gemini) and clean-context external specialists (`codex` by default, or `qodercli`, `pi`, `claude-code`, and custom JSON profiles). Keep every orchestration step explicit, traceable, and confined to declared boundaries.

## Setup and Entrypoint

Set `SKILL_DIR` to the directory containing this `SKILL.md` (for example `~/.gemini/config/skills/agy-orch` or `<repo>/skills/agy-orch`), then invoke the bundled zero-dependency Node 24 CLI:

```bash
AGY_ORCH="$SKILL_DIR/scripts/agy-orch.mjs"
node "$AGY_ORCH" help
```

Commands print structured JSON to stdout by default. Inspect available backends and effective configuration before starting work:

```bash
node "$AGY_ORCH" backends
node "$AGY_ORCH" config show --cwd "$REPO"
node "$AGY_ORCH" config resolve --cwd "$REPO" --role reviewer
node "$AGY_ORCH" config init
```

`config init` creates `~/.config/agy-orch/config.json` only if absent and never modifies `~/.codex/config.toml`.

## Role Split

- Lead (`agy` / Gemini): owns requirement framing, scope control, UI/visual/layout/UX authoring, task splitting, skeptical local verification and adversarial triage (`dispose`) of reviewer findings, integration, visual acceptance, and all user communication.
- Specialist / Reviewer (`reviewer` and `implementer`, default `codex`): owns read-only `review-plan`, scoped `delegate` (backend logic, complex state/concurrency logic, bounded bug fixes), and read-only `review-changes` (including frontend state races, duplicate submit, and auth/permission guards).

## Lightweight Triage Gate

Heavy plan and code reviews add latency and token cost on trivial edits. Run `triage` before creating a handoff packet:

```bash
node "$AGY_ORCH" triage \
  --summary "Adjust primary button padding and copy" \
  --files "src/styles/button.css" \
  --kind style
```

- When `decision` is `skip_heavy_flow`, perform the edit directly in the lead session and skip `review-plan`, `delegate`, and `review-changes`.
- When `decision` is `use_agy_orch`, run only `recommended_commands`: `review-changes` for moderate risk, or `review-plan`, `delegate`, and `review-changes` for high-risk or multi-file logic/architecture changes.

## Mandatory Context Handoff

External specialists start with a clean context and cannot see the lead conversation. Passing only a compressed summary causes them to invent requirements or flag intentional tradeoffs as bugs. Always pass a complete handoff packet JSON via `--packet <file>` or `--packet -` containing:

- `original_request` (non-empty string): verbatim user request.
- `goal` (non-empty string): concrete target outcome.
- `acceptance_criteria` (non-empty `string[]`): verifiable pass conditions.
- `constraints` (`string[]`): technical or policy boundaries.
- `non_goals` (`string[]`): explicit exclusions so the specialist does not expand scope.
- `relevant_files` (`string[]`): paths the specialist should read first.
- `scope.allowed_paths` (non-empty `string[]`, required for `delegate`): path prefixes or globs that `delegate` may modify.
- Optional fields: `plan` (for `review-plan`), `diff_summary`, `extra_instructions`.

Read `references/handoff-and-schemas.md` for complete packet templates, output schemas, and status payloads.

## Execution Commands

Run synchronous foreground commands or spawn detached background workers with `start` / `--background`:

```bash
# Plan review (read-only sandbox)
node "$AGY_ORCH" review-plan --cwd "$REPO" --task-id feat-auth --packet /tmp/plan-packet.json

# Bounded implementation (workspace-write sandbox + writer.lock)
node "$AGY_ORCH" delegate --cwd "$REPO" --task-id feat-auth --packet /tmp/delegate-packet.json [--worktree]

# Code review (read-only sandbox)
node "$AGY_ORCH" review-changes --cwd "$REPO" --task-id feat-auth --packet /tmp/review-packet.json
```

Common flags on `review-plan`, `delegate`, `review-changes`, and `start <cmd>`:

- `--cwd <dir>`: target repository path (canonicalized via `realpath`).
- `--task-id <id>`: logical task identifier used for round tracking and explicit `--resume`.
- `--role <name>`, `--backend <name>`, `--model <model>`, `--effort <effort>`, `--timeout-sec <n>`: override resolved role settings.
- `--resume`: resume the exact `backend_session_id` stored for `--task-id` (requires matching `cwd` and `backend`; never falls back to `--last`).
- `--worktree`: create an isolated git worktree under `${AGY_ORCH_STATE_DIR:-~/.local/state/agy-orch}/worktrees/<run_id>` (useful when parallelizing `delegate`).
- `--background` (or `start <review-plan|delegate|review-changes>`): detach execution so `status`, `result`, and `cancel` manage the run across commands.
- `--full`: return the raw `RunRecord` (plus `live_activity` on `status` or `kill_result` on `cancel`) instead of the default slim/summary view. Cannot be combined with `--finding`, `--blocking-only`, or `--category`.

Manage async or completed runs:

```bash
node "$AGY_ORCH" status --run-id "$RUN_ID" [--events-tail 20] [--stderr-tail 40] [--full]
node "$AGY_ORCH" result --task-id feat-auth [--blocking-only] [--finding F1,F2] [--category real_defect] [--events-tail 20] [--stderr-tail 40] [--full]
node "$AGY_ORCH" list --cwd "$REPO" --limit 20
node "$AGY_ORCH" cancel --run-id "$RUN_ID" [--full]
```

Default CLI outputs use progressive disclosure to keep context small:

- `start`, `status`, and `cancel` return a `disclosure_level: "status"` view: `pre_fingerprint` and `post_fingerprint` are summarized without `entries`, `parsed_output` and `dispositions` are replaced by `output_summary`, `changed_files` is capped (20 on `start`/`status`, 50 on `cancel`) alongside `changed_files_count`, and `details_omitted` / `next_actions` are included (`status` includes `live_activity`; `start` omits it).
- `result` and synchronous `review-plan`, `delegate`, and `review-changes` return a `disclosure_level: "summary"` view (never including `live_activity`): review runs return `finding_counts` and index-only `findings` (omitting `evidence`, `trigger`, `impact`, `minimal_fix`), `delegate` runs cap `modified_files` (20), `tests_run` (10), and `open_issues` (10) with `*_count` fields, and `dispositions_count` replaces the top-level `dispositions` array.
- Drill down on `result` with `--blocking-only` (unresolved blocking findings), `--finding <csv>`, or `--category <csv>` (`requirement_gap`, `real_defect`, `engineering_tradeoff`, `optional_polish`) to get `disclosure_level: "detail"` with full finding objects and matched dispositions, or attach `--events-tail <n>` and `--stderr-tail <n>` (`1..500`) on `status` or `result`.

## Swarm Bridge

In Antigravity `/swarm`, assign a native proxy member to run `start` and keep the returned `run_id`. Poll `status --run-id "$RUN_ID"` in short, separate tool calls. Use `live_activity.summary` as the next call's `toolSummary`.

When the run ends, format a board update with `swarm-post --run-id "$RUN_ID" --mention "$LEAD" --done --raw` and send it with native `post_message`. For non-running runs where findings, failures, long summaries (> 160 chars), or truncated lists (> 4 items) omit detail, `swarm-post` appends a `Details · agy-orch result --run-id ...` drill-down hint (`--blocking-only`, `--stderr-tail 40`, or default summary). See [Swarm bridge proxy briefs](references/swarm-bridge.md) for reviewer and implementer templates.

## Anti-Overdesign Disposition Protocol

Review commands enforce `schemas/review-output.schema.json`. Each finding has a `category` (`requirement_gap`, `real_defect`, `engineering_tradeoff`, `optional_polish`), `blocking` boolean, `evidence`, `trigger`, `impact`, `minimal_fix`, and `files`.

- Treat reviewer output as untrusted hypotheses, not a checklist to obey. Before editing code or running `dispose`, inspect the cited `file:line`, trace the real caller chain, and verify locally whether the trigger is reachable under the task's trust boundaries.
- Every `real_defect` or `requirement_gap` must cite concrete `evidence` (`file:line` or symbol), `trigger`, `impact`, and `minimal_fix`. Missing or placeholder fields are flagged `insufficient_evidence: true` by the runtime.
- `optional_polish` is forced to `blocking: false` and never blocks acceptance.
- Record lead decisions on findings via `dispose`:

```bash
node "$AGY_ORCH" dispose --run-id "$RUN_ID" --decisions '[
  {"finding_id":"F1","action":"minimal_fix","reason":"Guard submit button with in-flight ref"},
  {"finding_id":"F2","action":"reject_overdesign","reason":"Speculative retry queue not in acceptance criteria"}
]'
```

`--decisions` accepts inline JSON, `@path/to/decisions.json`, or `-` (stdin). Valid actions are `accept`, `minimal_fix`, `defer`, `request_evidence`, and `reject_overdesign`.

- Validate external boundaries (CLI, network, config, storage, untrusted input) once, and reject internal over-defensive guards (redundant nil/type checks, silent fallbacks, or defending impossible internal inputs where caller invariants already hold) alongside speculative abstractions, extra dependencies, and unrequested retry/plugin layers via `reject_overdesign` or `defer` (with a concrete `reason` on `engineering_tradeoff`).
- Runtime `dispose` blocks `reject_overdesign` and `defer` on substantiated `real_defect` or `requirement_gap` claims (unless `insufficient_evidence: true`). When local code or tests disprove a `real_defect` claim or show its trigger violates established internal invariants, do NOT write appeasement code or run extra review rounds just to force `acceptance_status: "approved"` — stop and report the local counter-evidence (`file:line` or test) to the user.
- Maximum discussion budget defaults to `max_rounds = 2`. If `round >= max_rounds` and any `real_defect` or `requirement_gap` remains unresolved, `dispose` sets `acceptance_status` to `blocked` — never mark unresolved defects as approved.
- Avoid review loops: default to 1 review pass followed by minimal local fixes and local test verification; run Round 2 (`--resume` on the same `--task-id`) only when fixes alter non-trivial state, concurrency, or auth logic (or when the user explicitly asked for a clean post-fix review gate), and never mint new `--task-id` suffixes (such as `-r2` or `-final`) to bypass `max_rounds = 2`.

Read `references/triage-and-disposition.md` for the full triage matrix, anti-overdesign checklist, and disposition state rules.

## Engineering Invariants

- Freshness after edits: whenever files in the workspace change after a `review-changes` run, run `node "$AGY_ORCH" check-freshness --task-id <id>` (or `status`/`result`). Any workspace fingerprint change marks `verdict_valid: false`, `freshness_status: "stale_by_code_change"`, and `acceptance_status: "stale"` so the prior review verdict cannot be cited as certifying post-edit files. After a small deterministic `minimal_fix` verified by local tests, finish directly with local test results; re-run `review-changes` (`--resume` within `max_rounds`) only when the fix modifies non-trivial control flow, state, concurrency, or auth boundaries, or when a clean post-edit review receipt is explicitly required.
- Write boundaries and single-writer lock: `review-plan` and `review-changes` run read-only and fail with `failure_kind: "boundary_violation"` if `post_fingerprint !== pre_fingerprint`. `delegate` holds a per-workspace `writer.lock` (failing fast with `writer_lock_held` on concurrent `delegate` runs in the same `cwd` unless `--worktree` is used) and fails with `boundary_violation` if any file outside `scope.allowed_paths` is modified.
- Trustworthy result and parameter validation: `execution_status` (`running | completed | failed | cancelled | timed_out | partial`) is tracked separately from `acceptance_status` (`pending_triage | approved | changes_requested | blocked | stale`). Exit code `0` without `turn.completed` (for Codex JSONL) or valid schema output fails explicitly (`missing_terminal_event`, `empty_output`, or `invalid_output_schema`). Invalid `--model` or `--effort` fails with `invalid_parameter` and never falls back silently.
- Timeout and cancel inspection before recovery: `cancel` and `--timeout-sec` terminate the child process group (`-pgid` `SIGTERM` -> 2s -> `SIGKILL`) and snapshot `post_fingerprint` plus `changed_files` (marking `execution_status: "partial"` on timeout with edits). Inspect `changed_files` and logs (`raw_events_path`, `stderr_path`) before deciding whether to resume, fix, or revert.
- Anti-recursion guard: spawned backends receive `AGY_ORCH_ACTIVE=1`; nested `agy-orch` invocations fail immediately with `failure_kind: "recursion_blocked"`.
- Extensible backends and config: read `references/backends-and-config.md` to configure models, reasoning effort, roles, and custom agents (`codex`, `qodercli`, `pi`, `claude-code`, etc.) in `~/.config/agy-orch/` without altering `~/.codex/config.toml`.
