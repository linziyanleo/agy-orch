---
title: Lightweight Watcher Subagent for Non-Swarm Async Runs
date created: "2026-11-26 22:28"
creator: linziyanleo with Coding Agent
background: In normal Antigravity sessions outside /swarm, detached delegate or high-effort review runs often take several minutes. A lightweight watcher subagent isolates periodic status polling from the lead context while preserving lead ownership of handoff, disposition, and session continuity.
references: ["../SKILL.md", "./swarm-bridge.md", "./handoff-and-schemas.md"]
---

# Lightweight Watcher Subagent for Non-Swarm Async Runs

Use a lightweight watcher subagent (`flash_lite`, or `flash` when unavailable) to monitor long-running detached `agy-orch` jobs in normal single-session conversations so the lead agent stays responsive without paying lead-model tokens or cluttering the main context with polling loops.

## When to Use and When to Skip

Use this pattern when:

- Running `start delegate` (especially with `--worktree` while the lead edits independent UI or docs in parallel).
- Running high-effort or large-diff `start review-changes` or `start review-plan` expected to exceed a quick synchronous turn.

Skip this pattern when:

- `triage` returned `skip_heavy_flow` (handle directly in the lead session).
- A quick synchronous check finishes within one turn without blocking parallel work.
- Working inside an active `/swarm` session (use native Swarm proxy members and `swarm-post` per [swarm-bridge.md](./swarm-bridge.md)).

## Ownership Boundaries

The lead agent and the watcher subagent keep strict boundaries so session state and workspace writes stay deterministic:

- The lead always runs `triage`, constructs the handoff packet, and executes `node "$AGY_ORCH" start ...` before launching the watcher. Running `start` in the lead surfaces fast-fail errors (`invalid_packet`, `invalid_parameter`, `writer_lock_held`, missing `images`) immediately and keeps `run_id`, `task_id`, and `worktree_path` in the lead context rather than hiding them inside a subagent.
- On-disk state (`task_id -> backend_session_id` and `runs/<run_id>.json`) remains the source of truth; the watcher never becomes the sole holder of session IDs.
- The watcher is strictly read-only. It only runs `status` and `result` and waits via native `schedule` (`DurationSeconds: 30` or `45`, never shell `sleep`). It never edits repository files, never runs `dispose`, never runs `--resume`, and never calls `cancel` unless the lead explicitly asks it to abort.

## Launching the Watcher (`invoke_subagent`)

Invoke `invoke_subagent` with:

- `TypeName`: `"self"` (the watcher needs `run_command` and `schedule`; `research` lacks shell tools).
- `Model`: `"flash_lite"` (fall back to `"flash"` if `flash_lite` is unavailable).
- `Role`: `"Async Run Watcher"`.
- `Workspace`: `"inherit"`.

Pass this brief after filling in `$AGY_ORCH` and `$RUN_ID` (plus optional `$TASK_ID` and `$WORKTREE_PATH` context):

```text
Monitor detached agy-orch run `$RUN_ID` (read-only observer; do not edit files, do not run dispose/--resume, and do not cancel unless instructed).

1. Immediately run `node "$AGY_ORCH" status --run-id "$RUN_ID"` in a short command call.
2. While `execution_status === "running"`, schedule a timer with `schedule` (`DurationSeconds: 30` or `45`, `TimerCondition: "never"`) and end your turn without calling other tools to wait reactively. On each wakeup, run `node "$AGY_ORCH" status --run-id "$RUN_ID"` and put `live_activity.summary` (or `Waiting for events`) into `toolSummary`.
3. Stall guard: if `live_activity.updated_at` (or `live_activity === null`) does not advance across 6 consecutive polls while `execution_status === "running"`, inspect `node "$AGY_ORCH" status --run-id "$RUN_ID" --events-tail 20 --stderr-tail 40` and report the stall to the lead instead of looping indefinitely.
4. Once `execution_status` leaves `"running"`, run `node "$AGY_ORCH" result --run-id "$RUN_ID"`. If `finding_counts.unresolved_blocking > 0`, also run `node "$AGY_ORCH" result --run-id "$RUN_ID" --blocking-only`. If `execution_status !== "completed"` or `boundary_violation === true`, also run `node "$AGY_ORCH" result --run-id "$RUN_ID" --stderr-tail 40`.
5. Reply to the lead with a concise handback: `run_id`, `task_id`, `backend`/`model`/`effort`, `execution_status`, `acceptance_status`, `worktree_path` (if non-null), `changed_files_count` + key paths, `finding_counts` + blocking IDs/titles (or delegate `summary`/`modified_files`/`tests_run`), and the exact drill-down command from `next_actions`.
```

## Lead Follow-Up After Handback

Once the watcher returns its report:

- Verify cited `file:line` findings locally (or inspect `git -C "$WORKTREE_PATH" diff` for `--worktree` runs), drilling down with `result --finding <ids>` when needed.
- Run `dispose` from the lead session to accept minimal fixes, reject overdesign, or dispute false positives with `counter_evidence`.
- Integrate verified `--worktree` changes back into the target workspace, remove temporary worktrees, and deliver final verification to the user.
