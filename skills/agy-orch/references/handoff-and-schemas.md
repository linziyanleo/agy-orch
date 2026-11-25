# Handoff Packets, Schemas, and CLI Payloads

Reference for constructing `agy-orch` handoff packets, interpreting structured specialist outputs, and running `dispose`.

## Required Handoff Fields

Every `review-plan`, `delegate`, and `review-changes` call validates the packet JSON before spawning a backend:

- `original_request` (`string`, non-empty): exact user request, copied verbatim.
- `goal` (`string`, non-empty): bounded objective for this invocation.
- `acceptance_criteria` (`string[]`, non-empty): concrete checks that define completion.
- `constraints` (`string[]`, may be empty `[]`): invariants, compatibility rules, or API boundaries.
- `non_goals` (`string[]`, may be empty `[]`): out-of-scope items the specialist must not change.
- `relevant_files` (`string[]`, may be empty `[]`): repository-relative files to inspect first.

For `delegate`, the packet must also include:

- `scope.allowed_paths` (`string[]`, non-empty): path prefixes or globs (`src/api/**`, `src/auth.ts`) that `delegate` is permitted to create, modify, or delete.

Optional fields:

- `plan` (`string`): proposed implementation plan text (used in `review-plan`).
- `diff_summary` (`string`): summary of edits under review (used in `review-changes`).
- `extra_instructions` (`string`): focused checks such as auth guards, race conditions, or test commands.

## Packet Examples

### 1. `review-plan` Packet

```json
{
  "original_request": "Add an invite redemption endpoint with single-use token consumption.",
  "goal": "Validate the proposed redemption plan for atomicity, auth boundaries, and minimal scope.",
  "acceptance_criteria": [
    "Expired or already-redeemed tokens return 409/410 without mutating user state.",
    "Concurrent redemption requests cannot redeem the same token twice."
  ],
  "constraints": [
    "Reuse existing SQLite transaction helper in src/db/tx.ts.",
    "Do not add external rate-limiter or queue dependencies."
  ],
  "non_goals": [
    "Admin invite creation UI",
    "Bulk email notifications"
  ],
  "relevant_files": [
    "src/routes/invites.ts",
    "src/db/tx.ts"
  ],
  "plan": "1. Add POST /api/invites/redeem handler. 2. Run conditional UPDATE ... WHERE redeemed_at IS NULL inside db.transaction(). 3. Add concurrent test in tests/invites.test.ts."
}
```

### 2. `delegate` Packet

```json
{
  "original_request": "Fix double submission and stale response race on the checkout submit button.",
  "goal": "Prevent duplicate POST /api/orders calls and stale UI error overwrites in src/checkout/submit.ts.",
  "acceptance_criteria": [
    "Clicking submit twice while a request is in flight issues only one network call.",
    "Aborting or superseding an older request prevents it from overwriting newer state.",
    "Unit tests in tests/checkout-submit.test.ts pass."
  ],
  "constraints": [
    "Keep public export signature of submitOrder unchanged.",
    "No new npm dependencies."
  ],
  "non_goals": [
    "Changing button CSS or layout",
    "Global state management rewrite"
  ],
  "relevant_files": [
    "src/checkout/submit.ts",
    "tests/checkout-submit.test.ts"
  ],
  "scope": {
    "allowed_paths": [
      "src/checkout/submit.ts",
      "tests/checkout-submit.test.ts"
    ]
  },
  "extra_instructions": "Run npm test after editing and report exact test names in tests_run."
}
```

### 3. `review-changes` Packet

```json
{
  "original_request": "Fix double submission and stale response race on the checkout submit button.",
  "goal": "Review uncommitted changes in src/checkout/submit.ts for residual concurrency, error-handling, or auth defects.",
  "acceptance_criteria": [
    "No duplicate submission path remains across keyboard and pointer triggers.",
    "Error path resets in-flight guard in finally."
  ],
  "constraints": [
    "Preserve existing error return shape."
  ],
  "non_goals": [
    "Styling changes"
  ],
  "relevant_files": [
    "src/checkout/submit.ts",
    "tests/checkout-submit.test.ts"
  ],
  "diff_summary": "Added inFlight lock and AbortController request sequencing in src/checkout/submit.ts."
}
```

## Specialist Output Schemas

### Review Output (`schemas/review-output.schema.json`)

Used by `review-plan` and `review-changes`:

```json
{
  "verdict": "approve | changes_requested | blocked",
  "summary": "Concise review conclusion",
  "findings": [
    {
      "id": "F1",
      "category": "requirement_gap | real_defect | engineering_tradeoff | optional_polish",
      "blocking": true,
      "title": "In-flight lock not cleared on synchronous validation throw",
      "evidence": "src/checkout/submit.ts:24 sets inFlight = true before validatePayload() without try/finally",
      "trigger": "Call submitOrder() with an empty cart, then fix cart and submit again",
      "impact": "Button stays permanently locked after a validation error",
      "minimal_fix": "Move inFlight = true inside try block or validate before setting the lock",
      "files": ["src/checkout/submit.ts"]
    }
  ]
}
```

Runtime validation behavior:
- `optional_polish` items are normalized to `blocking: false`.
- `real_defect` and `requirement_gap` items with empty or placeholder (`n/a`, `none`, `-`, `todo`) `evidence`, `trigger`, `impact`, or `minimal_fix` are flagged with `"insufficient_evidence": true` and `"missing_fields": [...]`.

### Delegate Output (`schemas/delegate-output.schema.json`)

Used by `delegate`:

```json
{
  "status": "completed | blocked",
  "summary": "Guarded submitOrder against double-submit and added concurrency tests",
  "modified_files": ["src/checkout/submit.ts", "tests/checkout-submit.test.ts"],
  "tests_run": ["npm test -- tests/checkout-submit.test.ts"],
  "open_issues": []
}
```

## `dispose` Input Example

Accepts a JSON array or `{ "decisions": [...] }` via `--decisions <json|@file|->`:

```json
[
  {
    "finding_id": "F1",
    "action": "minimal_fix",
    "reason": "Fixed try/finally placement in src/checkout/submit.ts"
  },
  {
    "finding_id": "F2",
    "action": "reject_overdesign",
    "reason": "Introducing Redux Toolkit for a single submit hook exceeds scope"
  }
]
```

## Key RunRecord Status Fields

`status`, `result`, `check-freshness`, and `cancel` return JSON from `${AGY_ORCH_STATE_DIR:-~/.local/state/agy-orch}/runs/<run_id>.json`:

- `execution_status`: `running | completed | failed | cancelled | timed_out | partial`
- `acceptance_status`: `pending_triage | approved | changes_requested | blocked | stale`
- `failure_kind`: `null | invalid_packet | invalid_parameter | backend_unavailable | writer_lock_held | recursion_blocked | resume_error | boundary_violation | timed_out | cancelled | empty_output | missing_terminal_event | invalid_output_schema | backend_error | git_error`
- `verdict_valid`: `boolean` (`false` when failed, timed out, cancelled, boundary violated, or stale)
- `freshness_status`: `fresh | stale_by_code_change | invalid_boundary | not_applicable`
- `changed_files`: `string[]` (diff between `pre_fingerprint` and `post_fingerprint`)
- `boundary_violation` / `boundary_violations`: `boolean` / `string[]`
- `backend_session_id`: `string | null` (saved per `task_id` for explicit `--resume`)
