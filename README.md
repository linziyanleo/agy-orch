<p align="center">
  <img src="assets/logo.png" alt="agy-orch" width="128" />
</p>

<h1 align="center">agy-orch</h1>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/linziyanleo/agy-orch/actions/workflows/ci.yml"><img src="https://github.com/linziyanleo/agy-orch/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen.svg" alt="Node 24+" /></a>
</p>

Call Codex from Antigravity to review plans, catch subtle bugs, and run bounded fixes.

Gemini handles UI, product framing, and user decisions well; Codex is strong at catching state races, permission bugs, and tricky backend logic. `agy-orch` lets Antigravity call your local `codex` CLI inside the same conversation without slowing down simple edits or letting reviewers bloat your PR.

```text
Antigravity (Gemini)
   |
   +--> simple CSS / copy tweak -------> edit directly, skip Codex
   |
   +--> logic / auth / async risk -----> Codex (review-plan / delegate / review-changes)
                                             |
                                             v
                                         dispose findings
                                    (fix real bugs, drop overdesign)
                                             |
                                             v
                                  edit code -> old pass turns stale -> --resume re-review
```

## Why agy-orch works better than a shell wrapper

- Small edits stay fast. A quick `triage` step checks file types and risk first, so tweaking button padding or copy finishes in Gemini right away.
- Reviewers stop bloating your PR. External models in a fresh context love proposing retry queues, plugin layers, and refactors nobody asked for. Every finding must include an exact `file:line`, trigger, impact, and minimal fix. Gemini then runs `dispose` to accept minimal fixes and reject speculative abstractions, while refusing to auto-approve unresolved real bugs after 2 rounds.
- Sessions never get mixed up. Resuming with `codex exec resume --last` grabs the wrong thread as soon as you run two tasks side by side. `agy-orch` binds each `task_id` to its own `backend_session_id` and blocks cross-repo collisions.
- Old approvals expire when code changes. After a `review-changes` pass, editing a file marks the previous verdict stale so you never ship on outdated review feedback.
- Parallel fixes stay isolated. Concurrent edits in the same folder hit a write lock; pass `--worktree` to run multiple Codex tasks in parallel git worktrees, with full process-group (`-pgid`) cleanup if you cancel or hit a timeout.
- Zero npm runtime dependencies. Runs directly on Node 24 and never edits `~/.codex/config.toml`.

## What a real run looks like

Suppose you fix a double-submit bug in checkout and ask Antigravity to have Codex review it:

1. Codex inspects the diff in its read-only sandbox and returns two structured items:
   - `F1` (`real_defect`): `src/checkout/submit.ts:24` sets `inFlight = true` before `validateCart()`. A validation throw leaves the button locked forever.
   - `F2` (`engineering_tradeoff`): Extract a generic retry middleware for future forms.
2. Gemini runs `dispose`: accepts the minimal fix for `F1`, rejects `F2` as `reject_overdesign` ("single form, retry layer out of scope").
3. You apply the 3-line fix. `check-freshness` flips the Round 1 verdict to `stale_by_code_change`.
4. Gemini runs Round 2 with `--resume` on the exact same Codex thread to verify the fix before wrapping up.

## Install

Requires macOS or Linux, Node.js 24+, Git, and a signed-in [Codex CLI](https://github.com/openai/codex) (`codex` on `PATH`).

### Antigravity CLI plugin

```bash
agy plugin install https://github.com/linziyanleo/agy-orch
```

### Agent Skills CLI

```bash
npx skills add linziyanleo/agy-orch --skill agy-orch
```

<details>
<summary>Clone and symlink (local development or single-repo install)</summary>

```bash
git clone https://github.com/linziyanleo/agy-orch.git
cd agy-orch
mkdir -p ~/.gemini/config/skills
ln -s "$(pwd)/skills/agy-orch" ~/.gemini/config/skills/agy-orch
```

`skills/agy-orch/` is self-contained (runtime, local ESM `package.json`, schemas, and backend profiles), so you can also copy it directly into `<your-repo>/.agents/skills/agy-orch`.

</details>

Initialize user config (optional; leaves model and effort unset so Codex uses your existing defaults):

```bash
SKILL_DIR="$HOME/.gemini/config/skills/agy-orch"
node "$SKILL_DIR/scripts/agy-orch.mjs" config init
node "$SKILL_DIR/scripts/agy-orch.mjs" backends
```

## Using it in Antigravity

Just talk to Antigravity normally:

- "Change the submit button padding to 12px in `src/styles/button.css`."
  Triage skips Codex and Gemini makes the edit directly.
- "I fixed double-submit in `src/checkout/submit.ts`. Have Codex review it for async races or stuck state."
  Runs a read-only `review-changes`, triages findings, and reports concrete bugs with `file:line` evidence.
- "Review my refund state-machine plan with Codex first, and push back on anything out of scope."
  Runs `review-plan` and filters speculative suggestions through `dispose`.
- "Delegate the rate-limiter fix in `src/rate-limit/` to Codex in a separate worktree while I keep working here."
  Runs `start delegate --worktree` and checks modified files against `src/rate-limit/` when Codex finishes.

## Direct CLI usage

Every command outputs JSON to stdout.

Triage a task:

```bash
node "$SKILL_DIR/scripts/agy-orch.mjs" triage \
  --summary "Adjust primary button padding and label text" \
  --files "src/styles/button.css" \
  --kind style
```

Run a read-only plan review from the current repo:

```bash
cat <<'EOF' | node "$SKILL_DIR/scripts/agy-orch.mjs" review-plan --cwd "$(pwd)" --task-id demo-plan-1 --packet -
{
  "original_request": "Add an idempotency key check to POST /api/orders.",
  "goal": "Check the plan for concurrency races and unnecessary complexity.",
  "acceptance_criteria": [
    "Replaying the same idempotency key returns the original order without duplicates."
  ],
  "constraints": ["Reuse the existing SQLite transaction helper."],
  "non_goals": ["Adding Redis or an external queue."],
  "relevant_files": ["README.md"],
  "plan": "1. Add UNIQUE constraint on orders.idempotency_key. 2. Catch duplicate insert inside the transaction and return the stored row."
}
EOF
```

Adjudicate findings, check freshness after edits, or run parallel tasks in isolated worktrees:

```bash
node "$SKILL_DIR/scripts/agy-orch.mjs" dispose --run-id "$RUN_ID" --decisions '[{"finding_id":"F1","action":"minimal_fix","reason":"Handle UNIQUE conflict in transaction"}]'
node "$SKILL_DIR/scripts/agy-orch.mjs" check-freshness --run-id "$REVIEW_RUN_ID"
node "$SKILL_DIR/scripts/agy-orch.mjs" review-changes --cwd "$(pwd)" --task-id demo-review-1 --resume --packet /path/to/packet.json
node "$SKILL_DIR/scripts/agy-orch.mjs" start delegate --cwd "$(pwd)" --task-id demo-worker-1 --worktree --packet /path/to/delegate.json
node "$SKILL_DIR/scripts/agy-orch.mjs" status --task-id demo-worker-1
node "$SKILL_DIR/scripts/agy-orch.mjs" cancel --run-id "$RUN_ID"
```

Worktrees are created under `${AGY_ORCH_STATE_DIR:-~/.local/state/agy-orch}/worktrees/<run_id>` so you can inspect `git -C "$WORKTREE_PATH" diff`, apply changes back, and clean up with `git worktree remove "$WORKTREE_PATH"`.

## Configuration and backends

Settings override in order: CLI flags (`--backend`, `--model`, `--effort`, `--timeout-sec`, `--role`) > env vars (`AGY_ORCH_*`) > project `.agy-orch/config.json` (only `roles` and `defaults`; binary/command overrides are ignored) > `~/.config/agy-orch/config.json` > bundled backend profiles. Switching backends drops the previous backend's `model` and `effort`; for timeouts, a role's `timeout_sec` or `--timeout-sec` overrides the backend's built-in timeout.

`agy-orch` is built and end-to-end tested with `codex`. Experimental JSON profiles for `agy`, `qodercli`, `pi`, and `claude-code` are included in `skills/agy-orch/backends/`, and you can add your own CLI under `~/.config/agy-orch/backends/<name>.json`.

More details:
- Packet format and schemas: [handoff-and-schemas.md](skills/agy-orch/references/handoff-and-schemas.md)
- Triage and 2-round disposition rules: [triage-and-disposition.md](skills/agy-orch/references/triage-and-disposition.md)
- Custom backends and config: [backends-and-config.md](skills/agy-orch/references/backends-and-config.md)
- End-to-end walkthrough (Chinese): [agy-orch接入配置与使用说明](docs/2026-11-25-14-37%20agy-orch接入配置与使用说明.md)

## Contributing and license

Run `npm test` before opening a PR. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Released under the [MIT License](LICENSE).
