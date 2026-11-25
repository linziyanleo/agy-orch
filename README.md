# agy-orch

[English](README.md) | [简体中文](README.zh-CN.md)

Lightweight multi-agent orchestration skill and zero-dependency Node 24 CLI for Antigravity (`agy` / Gemini) collaborating with Codex and extensible CLI agents (`qodercli`, `pi`, `claude-code`, or custom JSON profiles).

## Role Split and Workflow

- Lead agent (`agy` / Gemini) handles requirement framing, scope control, visual/UI work, task splitting, adversarial disposition (`dispose`) of review findings, final integration, and all user communication.
- Specialist / reviewer agent (default `codex`, configurable per role) performs read-only `review-plan`, scoped `delegate` implementation/bugfix tasks, and read-only `review-changes` including frontend state races, duplicate submissions, and permission checks.
- Lightweight `triage` gate checks risk first so trivial CSS, copy, or single-component display edits complete directly in the lead session without spawning external review overhead.

## Key Engineering Guarantees

- Complete context handoff packets (`original_request`, `goal`, `acceptance_criteria`, `constraints`, `non_goals`, `relevant_files`, plus `scope.allowed_paths` for `delegate`).
- Explicit session correlation per `task_id` and stored `backend_session_id` on `--resume` (never `--last`).
- Workspace tree fingerprint tracking (`pre_fingerprint` / `post_fingerprint`) so read-only reviews fail on any mutation (`boundary_violation`), `delegate` enforces `allowed_paths`, and post-review edits automatically mark prior verdicts `stale_by_code_change`.
- Single-writer lock (`writer.lock`) per workspace with `--worktree` isolation for parallel `delegate` tasks.
- Cross-process group termination (`-pgid` `SIGTERM` -> 2s -> `SIGKILL`) on `cancel` and `--timeout-sec`, capturing partial file edits before recovery decisions.
- Anti-overdesign `dispose` gate classifying findings into `requirement_gap`, `real_defect`, `engineering_tradeoff`, and `optional_polish` with a default 2-round budget that never auto-approves unresolved defects.
- Anti-recursion guard (`AGY_ORCH_ACTIVE=1`) preventing delegated backends from recursively invoking `agy-orch`.
- Zero external runtime dependencies and self-contained `skills/agy-orch/` layout that works either cloned as a full repository or copied as a standalone skill directory.

## Repository Layout

- `skills/agy-orch/SKILL.md`: skill definition and orchestration rules for Antigravity.
- `skills/agy-orch/scripts/agy-orch.mjs` and `skills/agy-orch/scripts/runtime/`: self-contained Node 24 TypeScript CLI and orchestration runtime.
- `skills/agy-orch/backends/`: bundled backend profiles (`codex.json`, `agy.json`, `qodercli.json`, `pi.json`, `claude-code.json`).
- `skills/agy-orch/schemas/`: JSON schemas (`review-output.schema.json`, `delegate-output.schema.json`).
- `skills/agy-orch/references/`: on-demand reference docs (`handoff-and-schemas.md`, `triage-and-disposition.md`, `backends-and-config.md`).
- `skills/agy-orch/evals/`: `skill-creator` evaluation scenarios and trigger queries.
- `bin/agy-orch.mjs`: repository binary entrypoint.
- `tests/`: unit and CLI E2E test suites.
- `docs/`: research notes, setup guide, and verification reports.

## Installation and Setup

Requires Node.js >= 24.0.0 and at least one configured backend CLI (such as `codex` on `PATH`).

### Option 1: Clone Repository and Symlink (Recommended for Development)

```bash
git clone https://github.com/linziyanleo/agy-orch.git
cd agy-orch
ln -s "$(pwd)/skills/agy-orch" ~/.gemini/config/skills/agy-orch
```

### Option 2: Standalone Skill Directory Install

Because `skills/agy-orch/` bundles its own runtime, backends, and schemas, you can copy or symlink just `skills/agy-orch` into `~/.gemini/config/skills/agy-orch` (global) or `<your-repo>/.agents/skills/agy-orch` (project-scoped).

### Initialize Config and Verify Backends

`config init` creates `~/.config/agy-orch/config.json` only if missing and never modifies `~/.codex/config.toml`:

```bash
node ~/.gemini/config/skills/agy-orch/scripts/agy-orch.mjs config init
node ~/.gemini/config/skills/agy-orch/scripts/agy-orch.mjs backends
node ~/.gemini/config/skills/agy-orch/scripts/agy-orch.mjs config resolve --cwd . --role reviewer
```

Run the test suite from the repository root:

```bash
npm test
```

## Configuration and Common Commands

- Precedence (highest to lowest): CLI flags (`--backend`, `--model`, `--effort`, `--timeout-sec`, `--role`) > environment variables (`AGY_ORCH_BACKEND`, `AGY_ORCH_MODEL`, `AGY_ORCH_EFFORT`, `AGY_ORCH_TIMEOUT_SEC`) > project `<cwd>/.agy-orch/config.json` (only `roles` and `defaults`; untrusted binary/command overrides are stripped) > `~/.config/agy-orch/config.json` > bundled backend defaults.
- Custom agents: drop a JSON profile in `~/.config/agy-orch/backends/<name>.json` and reference it via `--backend <name>` or a custom role in `roles`. When a backend rejects `--model` or `--effort`, `agy-orch` fails with `invalid_parameter` and never silently falls back.
- Common commands:

```bash
# Lightweight triage before starting heavy orchestration
node ~/.gemini/config/skills/agy-orch/scripts/agy-orch.mjs triage \
  --summary "Fix duplicate checkout submission and async response race" \
  --files "src/checkout/submit.ts" \
  --kind logic

# Synchronous review / bounded delegation / background management
node ~/.gemini/config/skills/agy-orch/scripts/agy-orch.mjs review-plan --cwd "$REPO" --task-id feat-auth --packet /tmp/plan.json
node ~/.gemini/config/skills/agy-orch/scripts/agy-orch.mjs delegate --cwd "$REPO" --task-id feat-auth --packet /tmp/delegate.json --worktree
node ~/.gemini/config/skills/agy-orch/scripts/agy-orch.mjs review-changes --cwd "$REPO" --task-id feat-auth --packet /tmp/review.json
node ~/.gemini/config/skills/agy-orch/scripts/agy-orch.mjs check-freshness --task-id feat-auth
node ~/.gemini/config/skills/agy-orch/scripts/agy-orch.mjs status --task-id feat-auth
node ~/.gemini/config/skills/agy-orch/scripts/agy-orch.mjs cancel --run-id "$RUN_ID"
```

Further setup examples and Chinese walkthroughs are in [agy-orch接入配置与使用说明](docs/2026-11-25-14-37%20agy-orch接入配置与使用说明.md).

## Contributing and License

Contributions are welcome; please read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before opening a pull request. Released under the [MIT License](LICENSE).
