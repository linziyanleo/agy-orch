# Security Policy

## Trust Boundaries

`agy-orch` executes local CLI agents on repositories. Key security boundaries enforced by the runtime:

- Untrusted repository configs: `<cwd>/.agy-orch/config.json` may only set `roles` (`agent`, `backend`, `model`, `effort`, `max_rounds`, `timeout_sec`) and `defaults`. Keys attempting to override `backends`, `binary`, or commands are stripped and ignored.
- User backend definitions: executable backend profiles load only from `skills/agy-orch/backends/` and `${AGY_ORCH_CONFIG_DIR:-~/.config/agy-orch}/backends/`.
- Read-only enforcement: `review-plan` and `review-changes` run with read-only sandbox flags and verify `pre_fingerprint === post_fingerprint`, failing with `boundary_violation` if any file changes.
- Write boundary enforcement: `delegate` enforces `scope.allowed_paths` and a per-workspace `writer.lock` (unless `--worktree` is used).
- Anti-recursion: spawned child environments receive `AGY_ORCH_ACTIVE=1`; nested `agy-orch` calls fail with `recursion_blocked`.
- User config isolation: `agy-orch` never writes to `~/.codex/config.toml` or other external agent global config files.

## Reporting a Vulnerability

If you discover a security issue (for example, command injection, trust-boundary bypass, or symlink escape in path validation), please report it privately via GitHub Security Advisories or contact the maintainer rather than disclosing exploit details in a public issue.
