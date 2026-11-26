---
title: Antigravity Swarm bridge
date created: "2026-11-25 17:54"
creator: linziyanleo with Codex
background: The maintainer asked to show Codex specialist progress and results in Antigravity's native Swarm views.
references: ["../SKILL.md", "./handoff-and-schemas.md"]
---

# Antigravity Swarm bridge

The native `/swarm` member is a thin proxy. It starts the external Codex run, polls its status, and posts the result. The CLI owns the run record and logs. Swarm owns member state and board messages through its native tools. Leave `.system_generated/swarm/*` under Swarm's control.

The Members tab `model` field shows the native proxy model. Put the resolved Codex model and effort in each `toolSummary`. The board post reads both values from the run record.

## Worker names

Native Swarm worker names use lowercase `a-z`, digits `0-9`, hyphens (`-`), and underscores (`_`). Start with a letter or digit and use at most 24 characters, including any `-<k>` suffix. The names `all`, `coordinator`, and names beginning with `coordinator-` are reserved.

## Brief for `@codex-reviewer`

Set `workspace: inherit` and name the worker `codex-reviewer` or use a variant that follows the [worker naming rule](#worker-names). Fill in the absolute CLI and packet paths, the task ID, the model, the effort, and the lead member name. Send the brief with the short-step polling procedure.

```text
Review the inherited workspace through Codex. The packet contains the review scope and acceptance criteria.
Start in the inherited working directory and record the returned run_id.

node "$AGY_ORCH" start review-changes --cwd "$PWD" --task-id "$TASK_ID" \
  --backend codex --model "$CODEX_MODEL" --effort "$CODEX_EFFORT" --packet "$PACKET"

For plan review, use review-plan with the plan packet instead.
Follow the short-step polling procedure below. Use the returned run_id for every poll and the final post.
```

## Brief for `@codex-impl`

Set `workspace: share` and name the worker `codex-impl` or use a variant that follows the [worker naming rule](#worker-names). Swarm gives the worker its own isolated working copy at `$PWD`; fix `--cwd` to that worker's share directory across follow-up rounds so edits stay isolated from other workers and preserved on `--resume`. Fill in the CLI and packet paths, the task ID, the model, the effort, and the lead member name. Send the brief with the short-step polling procedure.

```text
Implement the packet's goal in your assigned Swarm share workspace ($PWD). Edit only the paths allowed by the packet.
Start the run and record the returned run_id.

node "$AGY_ORCH" start delegate --cwd "$PWD" --task-id "$TASK_ID" \
  --backend codex --model "$CODEX_MODEL" --effort "$CODEX_EFFORT" --packet "$PACKET"

Keep this exact --cwd ($PWD), task_id, and backend for follow-up rounds. When the lead asks to continue
the stored Codex session, add --resume. For each run, poll and post by its returned run_id.
Follow the short-step polling procedure below.
```

Omit `--worktree` for this brief. Each run with `--worktree` creates a fresh Git worktree from `HEAD`. A later run in a fresh worktree will miss uncommitted edits from the previous worktree. Fixing `--cwd` to the worker's own `workspace: share` directory keeps follow-up rounds in the same working copy until the worker commits and the coordinator lands it. If a follow-up review inspects changes made in a separate `--worktree` or share workspace, pass that target directory explicitly via `--cwd`.

## Short-step polling procedure

- Call `node "$AGY_ORCH" status --run-id "$RUN_ID"` once in a short tool call. `status` returns the slim `disclosure_level: "status"` view with `live_activity` (without `fingerprint.entries` or full `parsed_output`). For the first call, set `toolSummary` to the Codex model and effort plus `Waiting for events`.
- While `execution_status` is `running`, space checks by 30 seconds (for example via `schedule` with `DurationSeconds=30`). In each separate tool call, use the previous `live_activity.summary` alongside the Codex model and effort in `toolSummary`. When `live_activity` is `null`, keep `Waiting for events`. Pass `--events-tail <n>` or `--stderr-tail <n>` (`1..500`) only when inspecting a stalled or failing run.
- Keep each call well below Swarm's 10-minute `STUCK_MS` threshold. Separate calls expose progress in the Members tab. Avoid a single long shell loop.
- When `execution_status` leaves `running`, run `node "$AGY_ORCH" swarm-post --run-id "$RUN_ID" --mention "$LEAD" --done --raw`. Pass the returned text to the native `post_message` tool. `[done]` marks the end of execution. The post reports acceptance separately.

`status` inspects up to the last 64 KiB of the run's JSONL log for `live_activity`. `live_activity.updated_at` comes from the log's last modification time, so repeated polls of an idle run show the same timestamp. `swarm-post` returns JSON (`SwarmPostPayload`: `run_id`, `task_id`, `command`, `backend`, `model`, `effort`, `execution_status`, `acceptance_status`, `post`) by default; use `--raw` to get just the board text.

For non-running runs (`execution_status !== "running"`), `swarm-post` appends a `Details · agy-orch result --run-id <run_id> ...` drill-down line when details were omitted:

- `Details · agy-orch result --run-id <run_id> --blocking-only` when unresolved blocking findings remain.
- `Details · agy-orch result --run-id <run_id> --stderr-tail 40` when `failure_kind`, `failure_message`, `boundary_violation`, or `execution_status === "partial"` is present and no unresolved blocking findings remain.
- `Details · agy-orch result --run-id <run_id>` when a review run has findings, `summary` exceeds 160 characters, or any displayed list exceeds 4 items.
- Runs still in `running` state and clean `approve` runs with 0 findings and a short summary omit the `Details ·` line.
