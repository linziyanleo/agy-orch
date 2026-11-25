import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const CLI_PATH = path.resolve("skills/agy-orch/scripts/agy-orch.mjs");

function setupTestEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-orch-e2e-"));
  const stateDir = path.join(root, "state");
  const configDir = path.join(root, "config");
  const fakeBinDir = path.join(root, "bin");
  const repoDir = path.join(root, "repo");
  const argvLog = path.join(root, "mock-argv.log");

  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(configDir, "backends"), { recursive: true });
  fs.mkdirSync(fakeBinDir, { recursive: true });
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });

  execFileSync("git", ["-C", repoDir, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.com"], { stdio: "ignore" });
  execFileSync("git", ["-C", repoDir, "config", "user.name", "Test"], { stdio: "ignore" });
  fs.writeFileSync(path.join(repoDir, "src", "form.ts"), "export function submit() { return true; }\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "styles.css"), ".btn { color: red; }\n", "utf8");
  execFileSync("git", ["-C", repoDir, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", repoDir, "commit", "-m", "seed"], { stdio: "ignore" });

  // Create fake codex binary controlled by MOCK_CODEX_MODE env var
  const fakeCodexPath = path.join(fakeBinDir, "mock-codex");
  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv) + "\\n", "utf8");

// Consume stdin
fs.readFileSync(0, "utf8");

const mode = process.env.MOCK_CODEX_MODE || "review_defect";
let outPath = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "-o") outPath = argv[i + 1];
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

if (mode === "invalid_model") {
  emit({ type: "thread.started", thread_id: "thread-bad-1" });
  emit({ type: "item.completed", item: { id: "item_0", type: "error", message: "Under-development features warning" } });
  emit({ type: "turn.started" });
  emit({ type: "error", message: "The 'bad-model' model is not supported when using Codex with a ChatGPT account." });
  emit({ type: "turn.failed", error: { message: "The 'bad-model' model is not supported." } });
  process.exit(1);
}

if (mode === "invalid_effort") {
  emit({ type: "thread.started", thread_id: "thread-badeffort-1" });
  emit({ type: "turn.started" });
  emit({
    type: "error",
    message: "[ReasoningEffortParam] [reasoning.effort] [invalid_enum_value] Invalid value: 'bogus_effort_xyz'. Supported values are: 'low', 'medium', 'high', 'xhigh'.",
  });
  emit({
    type: "turn.failed",
    error: {
      message: "[ReasoningEffortParam] [reasoning.effort] [invalid_enum_value] Invalid value: 'bogus_effort_xyz'.",
    },
  });
  process.exit(1);
}

if (mode === "missing_terminal") {
  emit({ type: "thread.started", thread_id: "thread-miss-1" });
  emit({ type: "turn.started" });
  process.exit(0);
}

if (mode === "empty_output") {
  emit({ type: "thread.started", thread_id: "thread-empty-1" });
  emit({ type: "turn.started" });
  emit({ type: "turn.completed" });
  process.exit(0);
}

if (mode === "invalid_schema") {
  emit({ type: "thread.started", thread_id: "thread-badschema-1" });
  emit({ type: "turn.started" });
  emit({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "not-json" } });
  emit({ type: "turn.completed" });
  process.exit(0);
}

if (mode === "review_mutate_violation") {
  fs.writeFileSync(path.join(process.cwd(), "src", "form.ts"), "// mutated by read-only reviewer\\n", "utf8");
}

if (mode === "slow_with_child_and_edit") {
  emit({ type: "thread.started", thread_id: process.env.MOCK_THREAD_ID || "thread-slow-1" });
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  if (process.env.MOCK_PID_FILE) {
    fs.writeFileSync(process.env.MOCK_PID_FILE, String(child.pid), "utf8");
  }
  fs.writeFileSync(path.join(process.cwd(), "src", "form.ts"), "// partial edit before hang\\n", "utf8");
  setInterval(() => {}, 1000);
  return;
}

if (mode === "backend_fail_with_param_words_in_body") {
  emit({ type: "thread.started", thread_id: "thread-bodywords-1" });
  emit({ type: "turn.started" });
  emit({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "agent_message",
      text: "The widget does not support model_reasoning_effort in its UI config.",
    },
  });
  emit({ type: "turn.failed", error: { message: "Upstream network timeout" } });
  process.exit(1);
}

if (mode === "slow_no_edit") {
  setInterval(() => {}, 1000);
  return;
}

if (mode === "delegate_ok" || mode === "delegate_violation") {
  const targetFile = mode === "delegate_violation" ? "styles.css" : path.join("src", "form.ts");
  fs.writeFileSync(path.join(process.cwd(), targetFile), "// edited by delegate\\n", "utf8");
  const payload = {
    status: "completed",
    summary: "Implemented requested fix",
    modified_files: [targetFile],
    tests_run: ["node --test"],
    open_issues: [],
  };
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(payload), "utf8");
  emit({ type: "thread.started", thread_id: process.env.MOCK_THREAD_ID || "thread-del-1" });
  emit({ type: "turn.started" });
  emit({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: JSON.stringify(payload) } });
  emit({ type: "turn.completed" });
  process.exit(0);
}

// Default: review_defect (also emits non-fatal item.completed error warning like real Codex v0.172.0)
const reviewPayload = {
  verdict: "changes_requested",
  summary: "Found duplicate submit defect and one polish suggestion",
  findings: [
    {
      id: "F1",
      category: "real_defect",
      blocking: true,
      title: "Missing in-flight guard allows duplicate submit",
      evidence: "src/form.ts:1 has no lock flag",
      trigger: "Double click submit before async call finishes",
      impact: "Duplicate request sent",
      minimal_fix: "Add synchronous pending guard",
      files: ["src/form.ts"]
    },
    {
      id: "F2",
      category: "optional_polish",
      blocking: true,
      title: "Consider adding JSDoc comment",
      evidence: "src/form.ts:1",
      trigger: "Reading code",
      impact: "None",
      minimal_fix: "Add comment",
      files: ["src/form.ts"]
    }
  ]
};
if (outPath) fs.writeFileSync(outPath, JSON.stringify(reviewPayload), "utf8");
emit({ type: "thread.started", thread_id: process.env.MOCK_THREAD_ID || "thread-rev-1" });
emit({ type: "item.completed", item: { id: "item_0", type: "error", message: "Under-development features enabled..." } });
emit({ type: "turn.started" });
emit({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: JSON.stringify(reviewPayload) } });
emit({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 50 } });
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  // Override codex backend profile in isolated AGY_ORCH_CONFIG_DIR to point to fakeCodexPath
  const bundledCodex = JSON.parse(
    fs.readFileSync(path.resolve("skills/agy-orch/backends/codex.json"), "utf8")
  );
  bundledCodex.binary = fakeCodexPath;
  fs.writeFileSync(
    path.join(configDir, "backends", "codex.json"),
    JSON.stringify(bundledCodex, null, 2),
    "utf8"
  );

  const packetPath = path.join(root, "packet.json");
  fs.writeFileSync(
    packetPath,
    JSON.stringify({
      original_request: "Fix duplicate submit in form.ts without touching styles.css",
      goal: "Ensure submit() guards against concurrent calls",
      acceptance_criteria: ["Second concurrent call is ignored", "styles.css unchanged"],
      constraints: ["Keep API signature unchanged"],
      non_goals: ["Rewrite form library"],
      relevant_files: ["src/form.ts"],
      scope: { allowed_paths: ["src/form.ts"] },
    }),
    "utf8"
  );

  function runCli(args: string[], extraEnv: Record<string, string> = {}) {
    try {
      const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          AGY_ORCH_STATE_DIR: stateDir,
          AGY_ORCH_CONFIG_DIR: configDir,
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, data: JSON.parse(stdout) };
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return {
        code: e.status ?? 1,
        data: e.stdout ? JSON.parse(e.stdout) : { stderr: e.stderr },
      };
    }
  }

  return {
    root,
    stateDir,
    configDir,
    repoDir,
    packetPath,
    argvLog,
    runCli,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("CLI E2E: config init is non-destructive, review-changes + dispose + resume + freshness", () => {
  const ctx = setupTestEnv();
  try {
    const init1 = ctx.runCli(["config", "init"]);
    assert.equal(init1.code, 0);
    assert.equal(init1.data.status, "created");

    const init2 = ctx.runCli(["config", "init"]);
    assert.equal(init2.code, 0);
    assert.equal(init2.data.status, "already_exists");

    // Review round 1
    const rev1 = ctx.runCli(
      ["review-changes", "--cwd", ctx.repoDir, "--task-id", "task-a", "--packet", ctx.packetPath],
      { MOCK_CODEX_MODE: "review_defect", MOCK_THREAD_ID: "uuid-task-a-1" }
    );
    assert.equal(rev1.code, 0);
    assert.equal(rev1.data.execution_status, "completed");
    assert.equal(rev1.data.acceptance_status, "pending_triage");
    assert.equal(rev1.data.backend_session_id, "uuid-task-a-1");
    assert.equal(rev1.data.freshness_status, "fresh");
    assert.equal(rev1.data.verdict_valid, true);
    // Verify optional_polish F2 forced non-blocking
    assert.equal(rev1.data.parsed_output.findings[1].blocking, false);

    // Resume task-a -> MUST pass exact uuid-task-a-1, NEVER --last!
    const rev2 = ctx.runCli(
      [
        "review-changes",
        "--cwd",
        ctx.repoDir,
        "--task-id",
        "task-a",
        "--resume",
        "--packet",
        ctx.packetPath,
      ],
      { MOCK_CODEX_MODE: "review_defect", MOCK_THREAD_ID: "uuid-task-a-1" }
    );
    assert.equal(rev2.code, 0);
    assert.equal(rev2.data.round, 2);

    const argvLines = fs
      .readFileSync(ctx.argvLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]);
    const resumeArgv = argvLines[1];
    assert.ok(!resumeArgv.includes("--last"));
    assert.ok(resumeArgv.includes("resume"));
    assert.ok(resumeArgv.includes("uuid-task-a-1"));
    // Verify -C and -s come BEFORE resume
    assert.ok(resumeArgv.indexOf("-s") < resumeArgv.indexOf("resume"));
    assert.ok(resumeArgv.indexOf("-C") < resumeArgv.indexOf("resume"));

    // Dispose round 2 with minimal_fix for F1 and reject_overdesign for F2 -> approved
    const disp = ctx.runCli([
      "dispose",
      "--run-id",
      rev2.data.run_id,
      "--decisions",
      JSON.stringify([
        { finding_id: "F1", action: "minimal_fix", reason: "fixed" },
        { finding_id: "F2", action: "reject_overdesign" },
      ]),
    ]);
    assert.equal(disp.code, 0);
    assert.equal(disp.data.acceptance_status, "approved");

    // Mutate file in repoDir -> check-freshness must invalidate old review verdict
    fs.writeFileSync(path.join(ctx.repoDir, "src", "form.ts"), "export const changed = 1;\n", "utf8");
    const fresh = ctx.runCli(["check-freshness", "--task-id", "task-a"]);
    assert.equal(fresh.code, 0);
    assert.equal(fresh.data.freshness_status, "stale_by_code_change");
    assert.equal(fresh.data.verdict_valid, false);
    assert.equal(fresh.data.acceptance_status, "stale");

    // Resume error checks: missing task-id & cwd mismatch
    const badResume = ctx.runCli([
      "review-changes",
      "--cwd",
      os.tmpdir(),
      "--task-id",
      "task-a",
      "--resume",
      "--packet",
      ctx.packetPath,
    ]);
    assert.equal(badResume.code, 1);
    assert.equal(badResume.data.failure_kind, "resume_error");
  } finally {
    ctx.cleanup();
  }
});

test("CLI E2E: boundary violations, single-writer lock vs worktree, failure modes, and anti-recursion", () => {
  const ctx = setupTestEnv();
  try {
    // 1. Read-only reviewer mutating file -> boundary_violation
    const roViol = ctx.runCli(
      ["review-changes", "--cwd", ctx.repoDir, "--task-id", "t-ro", "--packet", ctx.packetPath],
      { MOCK_CODEX_MODE: "review_mutate_violation" }
    );
    assert.equal(roViol.code, 1);
    assert.equal(roViol.data.failure_kind, "boundary_violation");
    assert.equal(roViol.data.verdict_valid, false);
    execFileSync("git", ["-C", ctx.repoDir, "checkout", "--", "src/form.ts"], { stdio: "ignore" });

    // 2. Delegate modifying out-of-scope file -> boundary_violation
    const delViol = ctx.runCli(
      ["delegate", "--cwd", ctx.repoDir, "--task-id", "t-del-viol", "--packet", ctx.packetPath],
      { MOCK_CODEX_MODE: "delegate_violation" }
    );
    assert.equal(delViol.code, 1);
    assert.equal(delViol.data.failure_kind, "boundary_violation");
    assert.deepEqual(delViol.data.boundary_violations, ["styles.css"]);
    execFileSync("git", ["-C", ctx.repoDir, "checkout", "--", "styles.css"], { stdio: "ignore" });

    // 3. Invalid model / effort -> invalid_parameter (no fallback)
    const badModel = ctx.runCli(
      [
        "review-plan",
        "--cwd",
        ctx.repoDir,
        "--task-id",
        "t-badmodel",
        "--model",
        "bad-model",
        "--packet",
        ctx.packetPath,
      ],
      { MOCK_CODEX_MODE: "invalid_model" }
    );
    assert.equal(badModel.code, 1);
    assert.equal(badModel.data.failure_kind, "invalid_parameter");

    const badEffort = ctx.runCli(
      [
        "review-plan",
        "--cwd",
        ctx.repoDir,
        "--task-id",
        "t-badeffort",
        "--effort",
        "bogus_effort_xyz",
        "--packet",
        ctx.packetPath,
      ],
      { MOCK_CODEX_MODE: "invalid_effort" }
    );
    assert.equal(badEffort.code, 1);
    assert.equal(badEffort.data.failure_kind, "invalid_parameter");

    // 4. Exit 0 missing turn.completed -> missing_terminal_event
    const missTerm = ctx.runCli(
      ["review-plan", "--cwd", ctx.repoDir, "--task-id", "t-miss", "--packet", ctx.packetPath],
      { MOCK_CODEX_MODE: "missing_terminal" }
    );
    assert.equal(missTerm.code, 1);
    assert.equal(missTerm.data.failure_kind, "missing_terminal_event");

    // 5. Exit 0 empty output -> empty_output
    const emptyOut = ctx.runCli(
      ["review-plan", "--cwd", ctx.repoDir, "--task-id", "t-empty", "--packet", ctx.packetPath],
      { MOCK_CODEX_MODE: "empty_output" }
    );
    assert.equal(emptyOut.code, 1);
    assert.equal(emptyOut.data.failure_kind, "empty_output");

    // 6. Exit 0 invalid JSON -> invalid_output_schema
    const badSchema = ctx.runCli(
      ["review-plan", "--cwd", ctx.repoDir, "--task-id", "t-schema", "--packet", ctx.packetPath],
      { MOCK_CODEX_MODE: "invalid_schema" }
    );
    assert.equal(badSchema.code, 1);
    assert.equal(badSchema.data.failure_kind, "invalid_output_schema");

    // 7. Anti-recursion guard
    const rec = ctx.runCli(
      ["review-plan", "--cwd", ctx.repoDir, "--task-id", "t-rec", "--packet", ctx.packetPath],
      { AGY_ORCH_ACTIVE: "1", AGY_ORCH_RUN_ID: "parent-run" }
    );
    assert.equal(rec.code, 1);
    assert.equal(rec.data.failure_kind, "recursion_blocked");

    // 8. Normal JSONL body mentioning 'does not support' / 'model_reasoning_effort' must NOT be misclassified as invalid_parameter
    const bodyWords = ctx.runCli(
      ["review-plan", "--cwd", ctx.repoDir, "--task-id", "t-bodywords", "--packet", ctx.packetPath],
      { MOCK_CODEX_MODE: "backend_fail_with_param_words_in_body" }
    );
    assert.equal(bodyWords.code, 1);
    assert.equal(bodyWords.data.failure_kind, "backend_error");

    // 9. list command works cleanly when .last.json and .worker.json exist in runs/
    const listed = ctx.runCli(["list"]);
    assert.equal(listed.code, 0);
    assert.ok(Array.isArray(listed.data.runs) && listed.data.runs.length >= 5);
  } finally {
    ctx.cleanup();
  }
});

test("CLI E2E: background start + single-writer lock + cancel kills pgid + timeout captures partial edits", async () => {
  const ctx = setupTestEnv();
  const childPidFile = path.join(ctx.root, "grandchild.pid");
  try {
    // Start a slow delegate in background
    const started = ctx.runCli(
      [
        "start",
        "delegate",
        "--cwd",
        ctx.repoDir,
        "--task-id",
        "t-bg",
        "--packet",
        ctx.packetPath,
      ],
      { MOCK_CODEX_MODE: "slow_with_child_and_edit", MOCK_PID_FILE: childPidFile }
    );
    assert.equal(started.code, 0);
    assert.equal(started.data.execution_status, "running");

    // Wait briefly until grandchild pid file appears
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(childPidFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(fs.existsSync(childPidFile), "mock codex should spawn grandchild and edit file");
    const grandchildPid = Number(fs.readFileSync(childPidFile, "utf8").trim());

    // Concurrent delegate in same cwd MUST fail with writer_lock_held
    const locked = ctx.runCli(
      ["delegate", "--cwd", ctx.repoDir, "--task-id", "t-locked", "--packet", ctx.packetPath],
      { MOCK_CODEX_MODE: "delegate_ok" }
    );
    assert.equal(locked.code, 1);
    assert.equal(locked.data.failure_kind, "writer_lock_held");

    // Concurrent delegate WITH --worktree MUST succeed independently
    const wtRun = ctx.runCli(
      [
        "delegate",
        "--cwd",
        ctx.repoDir,
        "--task-id",
        "t-wt",
        "--worktree",
        "--packet",
        ctx.packetPath,
      ],
      { MOCK_CODEX_MODE: "delegate_ok" }
    );
    assert.equal(wtRun.code, 0);
    assert.equal(wtRun.data.execution_status, "completed");
    assert.ok(wtRun.data.worktree_path);

    // Cancel background run -> must kill entire process group and capture partial changed_files
    const cancelled = ctx.runCli(["cancel", "--run-id", started.data.run_id]);
    assert.equal(cancelled.code, 0);
    assert.equal(cancelled.data.execution_status, "cancelled");
    assert.ok(cancelled.data.changed_files.includes("src/form.ts"));
    assert.equal(cancelled.data.kill_result.dead, true);

    // Verify grandchild process is genuinely dead
    let grandchildAlive = true;
    try {
      process.kill(grandchildPid, 0);
    } catch {
      grandchildAlive = false;
    }
    assert.equal(grandchildAlive, false);

    // Reset form.ts and test --timeout-sec 1 capturing partial edits
    execFileSync("git", ["-C", ctx.repoDir, "checkout", "--", "src/form.ts"], { stdio: "ignore" });
    const timedOutPartial = ctx.runCli(
      [
        "delegate",
        "--cwd",
        ctx.repoDir,
        "--task-id",
        "t-timeout-partial",
        "--timeout-sec",
        "1",
        "--packet",
        ctx.packetPath,
      ],
      { MOCK_CODEX_MODE: "slow_with_child_and_edit", MOCK_THREAD_ID: "thread-timeout-keep-1" }
    );
    assert.equal(timedOutPartial.code, 1);
    assert.equal(timedOutPartial.data.execution_status, "partial");
    assert.equal(timedOutPartial.data.failure_kind, "timed_out");
    assert.equal(timedOutPartial.data.backend_session_id, "thread-timeout-keep-1");
    assert.ok(timedOutPartial.data.changed_files.includes("src/form.ts"));

    // Reset form.ts and test --timeout-sec 1 with no edits -> timed_out
    execFileSync("git", ["-C", ctx.repoDir, "checkout", "--", "src/form.ts"], { stdio: "ignore" });
    const timedOutClean = ctx.runCli(
      [
        "delegate",
        "--cwd",
        ctx.repoDir,
        "--task-id",
        "t-timeout-clean",
        "--timeout-sec",
        "1",
        "--packet",
        ctx.packetPath,
      ],
      { MOCK_CODEX_MODE: "slow_no_edit" }
    );
    assert.equal(timedOutClean.code, 1);
    assert.equal(timedOutClean.data.execution_status, "timed_out");
    assert.deepEqual(timedOutClean.data.changed_files, []);

    // Also verify list works even after background runs created .worker.json
    const listed = ctx.runCli(["list"]);
    assert.equal(listed.code, 0);
    assert.ok(listed.data.runs.some((r: { run_id: string }) => r.run_id === started.data.run_id));
  } finally {
    ctx.cleanup();
  }
});

test("standalone copy of skills/agy-orch executes without outer repo", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-orch-standalone-"));
  const copiedSkill = path.join(tmpRoot, "agy-orch");
  const cfgDir = path.join(tmpRoot, "cfg");
  const stateDir = path.join(tmpRoot, "state");
  fs.cpSync(path.resolve("skills/agy-orch"), copiedSkill, { recursive: true });
  try {
    const cliEntry = path.join(copiedSkill, "scripts", "agy-orch.mjs");
    const env = {
      ...process.env,
      AGY_ORCH_CONFIG_DIR: cfgDir,
      AGY_ORCH_STATE_DIR: stateDir,
    };
    const backendsOut = JSON.parse(execFileSync(process.execPath, [cliEntry, "backends"], { env, encoding: "utf8" }));
    assert.ok(Array.isArray(backendsOut.backends));
    assert.ok(backendsOut.backends.some((b: { name: string }) => b.name === "codex"));

    const triageOut = JSON.parse(
      execFileSync(
        process.execPath,
        [cliEntry, "triage", "--summary", "Adjust button padding", "--files", "styles.css", "--kind", "style"],
        { env, encoding: "utf8" }
      )
    );
    assert.equal(triageOut.decision, "skip_heavy_flow");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
