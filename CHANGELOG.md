# Changelog

## 0.1.0 - 2026-11-25

- Initial release of `agy-orch` skill and zero-dependency Node 24 TypeScript runtime.
- Core commands: `triage`, `review-plan`, `delegate`, `review-changes`, `start`, `status`, `result`, `list`, `cancel`, `check-freshness`, `dispose`, `backends`, and `config`.
- Bundled backend profiles for `codex`, `agy`, `qodercli`, `pi`, and `claude-code`.
- Workspace fingerprinting, single-writer lock with `--worktree` isolation, process-group cancellation/timeout tracking, anti-overdesign disposition gate, and anti-recursion protection.
