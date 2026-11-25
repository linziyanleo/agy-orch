# Contributing to agy-orch

Thank you for contributing to `agy-orch`. This guide covers local development, testing, backend profile additions, and pull request expectations.

## Development Setup

- Node.js `>= 24.0.0` (native TypeScript execution with zero third-party runtime dependencies).
- Python 3 with `pyyaml` if you run `skill-creator` validation (`quick_validate.py`) against `skills/agy-orch/SKILL.md`.
- Git for worktree and workspace fingerprint tests.

Clone the repository and link the skill directory without overwriting any existing local skills:

```bash
git clone https://github.com/linziyanleo/agy-orch.git
cd agy-orch
ln -s "$(pwd)/skills/agy-orch" ~/.gemini/config/skills/agy-orch
```

## Running Checks

Before opening a pull request, verify:

```bash
npm test
node skills/agy-orch/scripts/agy-orch.mjs help
node skills/agy-orch/scripts/agy-orch.mjs backends
```

Keep these invariants intact when changing runtime or skill behavior:

- No third-party runtime dependencies in `skills/agy-orch/scripts/runtime/`.
- Keep `skills/agy-orch/` self-contained so copying `skills/agy-orch/` alone continues to run without external repository files.
- Never load executable paths, binary names, or command templates from target repository `.agy-orch/config.json`.
- Never fall back silently on invalid `--model` or `--effort`, and never reintroduce `--last` for session resumption.
- Keep `SKILL.md` under 500 lines and sync any CLI flag changes with `skills/agy-orch/SKILL.md`, `skills/agy-orch/references/`, `README.md`, and `README.zh-CN.md`.

## Adding or Updating a Backend Profile

Backend definitions live under `skills/agy-orch/backends/*.json`.

1. Verify actual CLI flags and exit/JSONL behavior against the target CLI `--help` output rather than assuming compatibility.
2. Ensure `resume.never_use_last` remains `true` and map `sandbox_map` accurately for `read-only` vs `workspace-write`.
3. Add or update unit tests in `tests/unit.test.ts` and document the profile in `skills/agy-orch/references/backends-and-config.md`.

## Pull Request Guidelines

- Keep changes focused and describe what was tested (clearly separating real CLI runs from mock/unit tests).
- Do not include machine-specific absolute paths (such as `/Users/<name>/...`) or credentials in commits or docs.
- Confirm your contributions are licensed under the project's [MIT License](LICENSE).
