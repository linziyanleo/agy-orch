# Triage Rules, Anti-Overdesign, and 2-Round Disposition

Guidance for sizing tasks with `triage`, filtering speculative reviewer suggestions, and enforcing the 2-round disposition protocol.

## Task Sizing and Triage Gate

Run `node "$AGY_ORCH" triage --summary "..." --files "..." --kind "..."` before launching an external specialist.

### Skip Heavy Flow (`decision: "skip_heavy_flow"`)

Handle directly in Gemini without `review-plan`, `delegate`, or `review-changes` when ALL of the following hold:
- Task kind is `style`, `copy`, `css`, `typo`, `docs`, `layout`, or `text` (or a single `.css`/`.scss`/`.less`/`.svg`/`.md`/`.txt` file).
- Touches at most 1–2 files (or only style/doc files).
- Summary has no signals of auth/permissions, state machines, async/concurrency races, duplicate submission, APIs, database/migrations, locks, timeouts, or regressions.

Examples that skip:
- Adjusting CSS spacing, colors, font sizes, or responsive breakpoints.
- Updating UI button labels, error copy, or README wording.
- Tweaking a single presentational component's markup without changing event handlers or async state.

### Use `agy-orch` (`decision: "use_agy_orch"`)

Invoke selective commands based on risk:
- Moderate risk (`["review-changes"]`): single-module logic fix, frontend component with async state/submit handlers, auth guard check, or 2–3 modified files.
- High risk (`["review-plan", "delegate", "review-changes"]`): `kind` in `arch | security | auth | migration | concurrency | schema`, 4+ affected files, or plan/refactor/database migration work.

When the user explicitly requests a Codex plan review or code review, invoke `review-plan` or `review-changes` even if the file count is small.

## Anti-Overdesign Checklist

External reviewers running in clean context tend to suggest defensive layers that were never requested. Reject or defer a suggestion when any of these apply:

- Speculative abstraction: introducing a plugin registry, factory, event bus, or generic wrapper for one call site.
- Unrequested infrastructure: adding retry queues, distributed locks, telemetry pipelines, or caching layers without a demonstrated failure path in `acceptance_criteria`.
- Scope expansion: refactoring untouched modules or renaming public APIs listed under `non_goals` or `constraints`.
- Hypothetical defect: claiming a bug under `real_defect` or `requirement_gap` without citing concrete `evidence` (`file:line` or symbol), `trigger`, `impact`, and `minimal_fix`.

## Disposition Decision Matrix

After `review-plan` or `review-changes` completes, run `dispose` to record the lead's decision for every finding:

- `optional_polish`:
  - `reject_overdesign` or `defer`: dismissed without blocking (`blocking_after: false`).
  - `accept` or `minimal_fix`: handled, non-blocking.
- `engineering_tradeoff`:
  - `reject_overdesign` or `defer`: **must include a non-empty `reason`** explaining why the tradeoff is intentional or out of scope; clears blocking (`blocking_after: false`). Without `reason`, `accepted` is `false` and blocking remains.
  - `accept` or `minimal_fix`: clears blocking.
  - `request_evidence`: stays blocking (`blocking_after: true`).
- `real_defect` or `requirement_gap`:
  - `accept` or `minimal_fix`: clears blocking (`blocking_after: false`) once verified/scheduled for fix.
  - `request_evidence`: keeps `blocking_after: true`.
  - `reject_overdesign` or `defer`: **blocked by runtime** unless the runtime already flagged `insufficient_evidence: true` on that finding AND a non-empty `reason` is provided for `reject_overdesign`. Substantiated defects cannot be dismissed as overdesign.
- Omitted findings: any finding left out of `--decisions` whose category is `real_defect`, `requirement_gap`, or `blocking: true` remains in `unresolved_blocking_ids`.

## 2-Round Budget and Acceptance Outcome

Each `review-plan` or `review-changes` invocation increments `round` on `task_id` (default `max_rounds = 2`):

1. **Round 1**: Run review -> triage findings with `dispose`.
   - If `unresolved_blocking_ids` is empty and no boundary/freshness error exists -> `acceptance_status: "approved"`.
   - If blocking findings remain (`unresolved_blocking_ids.length > 0`) and `round < max_rounds` -> `acceptance_status: "changes_requested"`. Fix the minimal issues (via lead or `delegate`), then run Round 2 using `--task-id <id> --resume` (or a fresh review on the updated diff).
2. **Round 2 (or `round >= max_rounds`)**:
   - If all blocking defects are resolved -> `acceptance_status: "approved"`.
   - If any `real_defect` or `requirement_gap` (or `request_evidence` / missing decision) remains unresolved -> `acceptance_status` becomes **`blocked`**. The runtime never auto-approves unresolved defects when hitting `max_rounds`; surface the blocker and evidence to the user.
3. **Post-fix Freshness Invalidation**:
   - Editing any file after a `review-changes` run invalidates its verdict (`freshness_status: "stale_by_code_change"`, `verdict_valid: false`, `acceptance_status: "stale"`). Run another `review-changes` pass after final edits if verification is required.
