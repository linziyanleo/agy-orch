import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { discoverBackends, loadMergedConfig, resolveRunSettings } from "../skills/agy-orch/scripts/runtime/config.ts";
import {
  computeWorkspaceFingerprint,
  diffFingerprints,
  findBoundaryViolations,
  isPathAllowed,
} from "../skills/agy-orch/scripts/runtime/fingerprint.ts";
import { acquireWriterLock, getWriterLockPath } from "../skills/agy-orch/scripts/runtime/lock.ts";
import { validateHandoffPacket } from "../skills/agy-orch/scripts/runtime/packet.ts";
import { runDetachedWorker } from "../skills/agy-orch/scripts/runtime/runner.ts";
import { validateReviewOutput, applyDispositions } from "../skills/agy-orch/scripts/runtime/schema-validate.ts";
import { saveRun } from "../skills/agy-orch/scripts/runtime/store.ts";
import { triageTask } from "../skills/agy-orch/scripts/runtime/triage.ts";
import type { RunRecord } from "../skills/agy-orch/scripts/runtime/types.ts";

function makeTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-orch-unit-"));
  execFileSync("git", ["-C", dir, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.name", "Test User"], { stdio: "ignore" });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "app.ts"), "export const x = 1;\n", "utf8");
  fs.writeFileSync(path.join(dir, "styles.css"), ".btn { color: red; }\n", "utf8");
  execFileSync("git", ["-C", dir, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "commit", "-m", "init"], { stdio: "ignore" });
  return dir;
}

test("triageTask skips heavy flow on trivial style/copy edits and triggers on logic/state", () => {
  const trivial = triageTask({
    summary: "Change primary button color from blue to green and update label text",
    files: ["styles.css"],
    kind: "style",
  });
  assert.equal(trivial.decision, "skip_heavy_flow");
  assert.deepEqual(trivial.recommended_commands, []);

  const stateBug = triageTask({
    summary: "Fix duplicate submit async race when user double clicks checkout button",
    files: ["src/checkout.ts"],
    kind: "logic",
  });
  assert.equal(stateBug.decision, "use_agy_orch");
  assert.ok(stateBug.recommended_commands.includes("review-changes"));

  const archTask = triageTask({
    summary: "Design multi-tenant session auth middleware",
    files: ["src/auth.ts", "src/session.ts", "src/middleware.ts", "src/routes.ts"],
    kind: "arch",
  });
  assert.equal(archTask.decision, "use_agy_orch");
  assert.deepEqual(archTask.recommended_commands, ["review-plan", "delegate", "review-changes"]);
});

test("validateHandoffPacket enforces required context fields and delegate scope", () => {
  const incomplete = validateHandoffPacket(
    {
      original_request: "fix bug",
      goal: "",
      acceptance_criteria: [],
    },
    "review-changes"
  );
  assert.equal(incomplete.ok, false);

  const missingScope = validateHandoffPacket(
    {
      original_request: "Implement auth guard",
      goal: "Add auth check to /api/orders",
      acceptance_criteria: ["Returns 401 when unauthenticated"],
      constraints: ["Do not alter public schema"],
      non_goals: ["OAuth UI"],
      relevant_files: ["src/orders.ts"],
    },
    "delegate"
  );
  assert.equal(missingScope.ok, false);

  const validDelegate = validateHandoffPacket(
    {
      original_request: "Implement auth guard",
      goal: "Add auth check to /api/orders",
      acceptance_criteria: ["Returns 401 when unauthenticated"],
      constraints: [],
      non_goals: [],
      relevant_files: ["src/orders.ts"],
      scope: { allowed_paths: ["src/orders.ts", "tests/"] },
    },
    "delegate"
  );
  assert.equal(validDelegate.ok, true);
});

test("fingerprint & diffFingerprints detect exact mutations without blaming pre-existing dirty files", () => {
  const repo = makeTempGitRepo();
  try {
    // Pre-existing dirty file before run starts
    fs.writeFileSync(path.join(repo, "styles.css"), ".btn { color: blue; }\n", "utf8");
    const pre = computeWorkspaceFingerprint(repo);

    // Run modifies src/app.ts and adds untracked file in new subdir, leaves styles.css untouched
    fs.writeFileSync(path.join(repo, "src", "app.ts"), "export const x = 2;\n", "utf8");
    fs.mkdirSync(path.join(repo, "src", "nested"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "nested", "new.ts"), "export const y = 3;\n", "utf8");

    const post = computeWorkspaceFingerprint(repo);
    assert.notEqual(pre.digest, post.digest);

    const changed = diffFingerprints(pre, post, repo);
    assert.deepEqual(changed, ["src/app.ts", "src/nested/new.ts"]);

    assert.equal(isPathAllowed("src/nested/new.ts", ["src/**"]), true);
    assert.equal(isPathAllowed("src/app.ts", ["src/app.ts"]), true);
    assert.equal(isPathAllowed("README.md", ["src/**"]), false);
    assert.deepEqual(findBoundaryViolations(["src/app.ts", "README.md"], ["src/**"]), ["README.md"]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("validateReviewOutput & applyDispositions enforce anti-overdesign and never auto-approve on round cap", () => {
  const validated = validateReviewOutput({
    verdict: "changes_requested",
    summary: "Found 1 real defect, 1 unsubstantiated claim, 1 tradeoff, and 1 polish item",
    findings: [
      {
        id: "F1",
        category: "real_defect",
        blocking: true,
        title: "Duplicate submission race on fast double click",
        evidence: "src/submit.ts:42 sets loading state only after await fetch()",
        trigger: "Click submit twice within 50ms before first request resolves",
        impact: "Creates duplicate order records",
        minimal_fix: "Guard with synchronous inFlight ref before await",
        files: ["src/submit.ts"],
      },
      {
        id: "F2",
        category: "real_defect",
        blocking: true,
        title: "Vague memory leak claim",
        evidence: "N/A",
        trigger: "",
        impact: "Maybe slow",
        minimal_fix: "Rewrite in framework X",
        files: ["src/submit.ts"],
      },
      {
        id: "F3",
        category: "engineering_tradeoff",
        blocking: true,
        title: "Suggest extracting generic retry state-machine package",
        evidence: "src/submit.ts uses plain try/catch",
        trigger: "Future endpoints might want retries",
        impact: "Minor duplication if 5 more forms added later",
        minimal_fix: "Create src/lib/retry-framework.ts",
        files: ["src/submit.ts"],
      },
      {
        id: "F4",
        category: "optional_polish",
        blocking: true, // reviewer wrongly marked polish as blocking!
        title: "Rename variable `res` to `responsePayload`",
        evidence: "src/submit.ts:45",
        trigger: "Code reading",
        impact: "None",
        minimal_fix: "Rename variable",
        files: ["src/submit.ts"],
      },
    ],
  });

  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  assert.deepEqual(validated.insufficient_evidence_ids, ["F2"]);
  const f4 = validated.output.findings.find((f) => f.id === "F4")!;
  assert.equal(f4.blocking, false);

  const mockRun: RunRecord = {
    run_id: "run-1",
    task_id: "task-1",
    command: "review-changes",
    role: "reviewer",
    backend: "codex",
    model: "gpt-6.2-sol",
    effort: "xhigh",
    sandbox: "read-only",
    timeout_sec: 600,
    round: 2,
    max_rounds: 2,
    resumed_from_session_id: null,
    cwd: "/tmp",
    effective_cwd: "/tmp",
    worktree_path: null,
    execution_status: "completed",
    acceptance_status: "pending_triage",
    failure_kind: null,
    failure_message: null,
    pid: null,
    pgid: null,
    exit_code: 0,
    signal: null,
    backend_session_id: "sess-1",
    pre_fingerprint: { digest: "a", is_git: true, head: "h", entries: {}, computed_at: "" },
    post_fingerprint: { digest: "a", is_git: true, head: "h", entries: {}, computed_at: "" },
    changed_files: [],
    boundary_violation: false,
    boundary_violations: [],
    verdict_valid: true,
    freshness_status: "fresh",
    parsed_output: validated.output,
    dispositions: [],
    started_at: "",
    ended_at: "",
    raw_events_path: "",
    stderr_path: "",
    prompt_path: "",
    last_message_path: "",
  };

  // Trying to dismiss F1 via reject_overdesign at round 2/2 MUST stay blocked, never auto-approved!
  const blockedRes = applyDispositions(mockRun, [
    { finding_id: "F1", action: "reject_overdesign", reason: "trying to skip" },
    { finding_id: "F2", action: "reject_overdesign", reason: "no concrete evidence/trigger" },
    { finding_id: "F3", action: "reject_overdesign", reason: "out of scope speculative abstraction" },
    { finding_id: "F4", action: "reject_overdesign" },
  ]);
  assert.equal(blockedRes.ok, true);
  if (!blockedRes.ok) return;
  assert.equal(blockedRes.acceptance_status, "blocked");
  assert.deepEqual(blockedRes.unresolved_blocking_ids, ["F1"]);

  // Resolving F1 via minimal_fix while rejecting F2 (insufficient_evidence), F3 (justified tradeoff), F4 (polish) -> approved!
  const approvedRes = applyDispositions(mockRun, [
    { finding_id: "F1", action: "minimal_fix", reason: "added synchronous inFlight guard" },
    { finding_id: "F2", action: "reject_overdesign", reason: "insufficient evidence" },
    { finding_id: "F3", action: "reject_overdesign", reason: "YAGNI / out of scope" },
    { finding_id: "F4", action: "reject_overdesign" },
  ]);
  assert.equal(approvedRes.ok, true);
  if (!approvedRes.ok) return;
  assert.equal(approvedRes.acceptance_status, "approved");
  assert.deepEqual(approvedRes.unresolved_blocking_ids, []);
});

test("project config strips untrusted binary/backends overrides while honoring safe role prefs", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-orch-cfg-"));
  const cfgDir = path.join(tempRoot, "user-cfg");
  const projDir = path.join(tempRoot, "proj");
  fs.mkdirSync(path.join(projDir, ".agy-orch"), { recursive: true });
  fs.writeFileSync(
    path.join(projDir, ".agy-orch", "config.json"),
    JSON.stringify({
      backends: { codex: { binary: "/tmp/evil.sh" } },
      roles: {
        reviewer: { model: "gpt-6.2-sol", effort: "high", binary: "/tmp/evil2.sh" },
      },
      defaults: { timeout_sec: 120 },
    }),
    "utf8"
  );

  const prevCfgDir = process.env.AGY_ORCH_CONFIG_DIR;
  process.env.AGY_ORCH_CONFIG_DIR = cfgDir;
  try {
    const merged = loadMergedConfig(projDir);
    assert.ok(merged.sources.ignored_untrusted_project_keys.includes("backends"));
    assert.ok(merged.sources.ignored_untrusted_project_keys.includes("roles.reviewer.binary"));
    assert.equal(merged.roles.reviewer.effort, "high");
    assert.equal(merged.defaults.timeout_sec, 120);

    const resolved = resolveRunSettings({ cwd: projDir, role: "reviewer" });
    assert.equal(resolved.effort, "high");
    assert.notEqual(resolved.backend_profile?.resolved_binary, "/tmp/evil.sh");
  } finally {
    if (prevCfgDir === undefined) delete process.env.AGY_ORCH_CONFIG_DIR;
    else process.env.AGY_ORCH_CONFIG_DIR = prevCfgDir;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("discoverBackends includes agy profile aligned with lead role", () => {
  const backends = discoverBackends();
  const agy = backends.find((b) => b.name === "agy");
  assert.ok(agy, "agy backend profile should be discovered");
  assert.equal(agy.capabilities.model, true);
  assert.equal(agy.capabilities.effort, true);
  assert.equal(agy.capabilities.resume, true);
  assert.equal(agy.profile.resume.session_flag, "--conversation");
});

test("runDetachedWorker aborts cleanly and releases lock if already cancelled before execution", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-orch-race-"));
  const stateDir = path.join(tempRoot, "state");
  const repoDir = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(stateDir, "runs"), { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });

  const prevState = process.env.AGY_ORCH_STATE_DIR;
  process.env.AGY_ORCH_STATE_DIR = stateDir;
  try {
    const runId = "run-race-1";
    const lock = acquireWriterLock(repoDir, runId, "task-race");
    assert.equal(lock.acquired, true);

    const cancelledRun: RunRecord = {
      run_id: runId,
      task_id: "task-race",
      command: "delegate",
      role: "implementer",
      backend: "codex",
      model: "gpt-6.2-sol",
      effort: "high",
      sandbox: "workspace-write",
      timeout_sec: 60,
      round: 0,
      max_rounds: 2,
      resumed_from_session_id: null,
      cwd: repoDir,
      effective_cwd: repoDir,
      worktree_path: null,
      execution_status: "cancelled",
      acceptance_status: "blocked",
      failure_kind: "cancelled",
      failure_message: "Run cancelled by caller",
      pid: null,
      pgid: null,
      worker_pid: process.pid,
      exit_code: null,
      signal: null,
      backend_session_id: null,
      pre_fingerprint: { digest: "a", is_git: false, head: "NON_GIT", entries: {}, computed_at: "" },
      post_fingerprint: null,
      changed_files: [],
      boundary_violation: false,
      boundary_violations: [],
      verdict_valid: false,
      freshness_status: "not_applicable",
      parsed_output: null,
      dispositions: [],
      started_at: new Date().toISOString(),
      ended_at: null,
      raw_events_path: path.join(stateDir, "runs", `${runId}.events.jsonl`),
      stderr_path: path.join(stateDir, "runs", `${runId}.stderr.log`),
      prompt_path: path.join(stateDir, "runs", `${runId}.prompt.txt`),
      last_message_path: path.join(stateDir, "runs", `${runId}.last.json`),
    };
    saveRun(cancelledRun);
    fs.writeFileSync(
      path.join(stateDir, "runs", `${runId}.worker.json`),
      JSON.stringify({ schemaPath: "", packet: {}, prompt: "", lockAcquired: true }),
      "utf8"
    );

    const exitCode = await runDetachedWorker(runId);
    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(getWriterLockPath(repoDir)), false);
  } finally {
    if (prevState === undefined) delete process.env.AGY_ORCH_STATE_DIR;
    else process.env.AGY_ORCH_STATE_DIR = prevState;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
