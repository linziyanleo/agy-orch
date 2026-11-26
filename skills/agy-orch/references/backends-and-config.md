# Backends, Models, Effort, and Config Precedence

Reference for configuring roles, models, reasoning effort, timeouts, and custom CLI backends in `agy-orch`.

## Config Precedence and Trust Boundary

`agy-orch` resolves settings in the following order (highest precedence first):

1. Explicit CLI flags: `--backend`, `--model`, `--effort`, `--timeout-sec`.
2. Environment variables: `AGY_ORCH_BACKEND`, `AGY_ORCH_MODEL`, `AGY_ORCH_EFFORT`, `AGY_ORCH_TIMEOUT_SEC`.
3. Project config (`<cwd>/.agy-orch/config.json`): **only** `roles` (`agent`, `backend`, `model`, `effort`, `max_rounds`, `timeout_sec`) and `defaults` (`timeout_sec`, `max_rounds`, `scope`) are honored. Untrusted keys such as `backends`, `binary`, or `commands` are stripped and recorded in `sources.ignored_untrusted_project_keys`.
4. User config (`~/.config/agy-orch/config.json`, or `$AGY_ORCH_CONFIG_DIR/config.json`).
5. Bundled backend defaults (`skills/agy-orch/backends/<name>.json`).

For `timeout_sec`, role-level `timeout_sec` takes precedence over the backend profile's `defaults.timeout_sec`, and top-level `defaults.timeout_sec` acts as the final fallback when neither the role nor the backend profile specifies a timeout. Use `--timeout-sec`, `AGY_ORCH_TIMEOUT_SEC`, or a role's `timeout_sec` to override a bundled backend timeout.

`agy-orch` never reads or writes `~/.codex/config.toml`.

## Default Roles (`~/.config/agy-orch/config.json`)

Running `node "$AGY_ORCH" config init` writes the default user config if it does not exist yet. By default `model` and `effort` are omitted so the underlying CLI uses its own configured defaults:

```json
{
  "roles": {
    "lead": {
      "agent": "agy",
      "backend": "agy"
    },
    "reviewer": {
      "backend": "codex",
      "max_rounds": 2,
      "timeout_sec": 1800
    },
    "implementer": {
      "backend": "codex",
      "timeout_sec": 1800
    }
  },
  "defaults": {
    "timeout_sec": 1800,
    "max_rounds": 2
  }
}
```

### Overriding Model or Reasoning Effort

To pin a specific model or reasoning effort, set `roles.reviewer.model` / `roles.reviewer.effort` (or `implementer`) in `~/.config/agy-orch/config.json`, add project overrides in `.agy-orch/config.json`, set `AGY_ORCH_MODEL` / `AGY_ORCH_EFFORT`, or pass `--model <id>` / `--effort <level>` on the CLI. When `--backend` or `AGY_ORCH_BACKEND` overrides a role's configured backend to a different backend, `agy-orch` does not inherit the previous backend's `model` or `effort`. When a backend rejects a supplied model or effort, `agy-orch` fails explicitly with `failure_kind: "invalid_parameter"` and never falls back silently.

You can also add custom roles (for example `security_reviewer` or `backend_coder`) in `roles` and select them with `--role <name>`.

## Bundled Backends

Run `node "$AGY_ORCH" backends` to inspect discovered backends and binary availability:

- `codex` (active by default, `codex-jsonl`):
  - New run: `codex exec --json --skip-git-repo-check -C <cwd> -s <read-only|workspace-write> -m <model> -c model_reasoning_effort="<effort>" [-i <image> ...] --output-schema <file> -o <file> -`
  - Resume run: `codex exec -C <cwd> -s <sandbox> resume --json --skip-git-repo-check -m <model> -c model_reasoning_effort="<effort>" [-i <image> ...] --output-schema <file> -o <file> <backend_session_id> -` (`-C` and `-s` are placed before `resume` because `codex exec resume` rejects them after the subcommand; `--last` is never used).
  - Non-fatal `item.completed` warning items (`item.type === "error"`) emitted by experimental Codex flags are ignored; only top-level `error` or `turn.failed` events fail the run, and `turn.completed` plus valid schema output are required for `completed`.
- `agy` (`agy`, `jsonl-generic`, `skills/agy-orch/backends/agy.json`):
  - Uses `-p --output-format stream-json --disable-slash-commands --sandbox`, `--model <model>`, `--effort <effort>`, `--mode <plan|accept-edits|auto>`, `--json-schema <file>`, and `--conversation <session_id>` on resume (`cwd` via child process `cwd`).
- `qodercli` (`qodercli`, `jsonl-generic`):
  - Uses `-p -o stream-json --max-model-request-retries 0`, `-w <cwd>`, `-m <model>`, `--reasoning-effort <effort>`, `--permission-mode <dont_ask|accept_edits|bypass_permissions>`, `-- <prompt>`, and `-r <session_id>` on resume (`output_schema: false`).
- `pi` (`pi`, `jsonl-generic`):
  - Uses `-p --mode json`, `--model <model>`, `--thinking <effort>`, `--tools <read,grep,find,ls | read,bash,edit,write>`, and `--session <session_id>` on resume (`cwd` via child process `cwd`).
- `claude-code` (`claude`, `jsonl-generic`):
  - Uses `-p --output-format stream-json --verbose`, `--model <model>`, `--effort <effort>`, `--permission-mode <plan|acceptEdits|bypassPermissions>`, `--json-schema <file>`, and `--resume <session_id>` on resume.

## Adding or Overriding a Backend Profile

Place a JSON profile at `~/.config/agy-orch/backends/<name>.json` (same `name` overrides a bundled profile):

```json
{
  "name": "custom-reviewer",
  "display_name": "Custom Reviewer CLI",
  "active": true,
  "binary": "my-agent-cli",
  "output_protocol": "jsonl-generic",
  "capabilities": {
    "model": true,
    "effort": true,
    "sandbox": true,
    "resume": true,
    "output_schema": false,
    "worktree": false,
    "image": false
  },
  "defaults": {
    "model": "default-model",
    "effort": "high",
    "timeout_sec": 1800
  },
  "exec": {
    "base_args": ["-p", "--output-format", "stream-json"],
    "model_flag": "--model",
    "effort_mode": "flag",
    "effort_flag": "--effort",
    "sandbox_flag": "--permission-mode",
    "sandbox_map": {
      "read-only": "plan",
      "workspace-write": "accept-edits",
      "danger-full-access": "auto"
    },
    "prompt_mode": "arg",
    "prompt_separator": "--"
  },
  "resume": {
    "supported": true,
    "session_mode": "flag",
    "session_flag": "--resume",
    "never_use_last": true
  }
}
```

Supported `output_protocol` values: `codex-jsonl`, `jsonl-generic`, `json`, `text`.
Supported `exec.prompt_mode` values: `stdin-dash` (`-`), `stdin`, `arg` (with optional `prompt_separator`, e.g. `"--"`), `flag` (with `prompt_flag`).
Supported `exec.effort_mode` values: `codex-config` (`-c key="val"`), `flag`, `none`.
Optional image attachment support: set `"capabilities": { ..., "image": true }` and `"exec": { ..., "image_flag": "-i" }` to forward `packet.images` as repeated `<image_flag> <path>` arguments before schema/last-message flags.
Always set `"never_use_last": true` in `resume` so session continuity remains deterministic per `task_id`.
