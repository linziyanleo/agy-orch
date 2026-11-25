import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { executeBackend } from "../skills/agy-orch/scripts/runtime/backend-runner.ts";
import { applyDispositions } from "../skills/agy-orch/scripts/runtime/schema-validate.ts";
import { formatSwarmPost, inspectRunActivity } from "../skills/agy-orch/scripts/runtime/swarm.ts";
import type { BackendProfile, Finding, RunRecord } from "../skills/agy-orch/scripts/runtime/types.ts";

const skillDir = path.resolve("skills/agy-orch");
const codexProfile = JSON.parse(fs.readFileSync(path.join(skillDir, "backends/codex.json"), "utf8")) as BackendProfile;
const jsonl = (...events: unknown[]) => events.map((event) => `${JSON.stringify(event)}\n`).join("");

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-bridge-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await delay(20);
  }
}

test("backend preserves split UTF-8 bytes and decodes stdout and stderr across chunks", async (t) => {
  const dir = tempDir(t);
  const stdoutPath = path.join(dir, "stdout.jsonl");
  const stderrPath = path.join(dir, "stderr.log");
  const releasePath = path.join(dir, "release");
  const script = path.join(dir, "backend.cjs");
  const review = { verdict: "approve", summary: "通过 😀", findings: [] };
  const stdout = jsonl(
    { type: "thread.started", thread_id: "会话😀" },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(review) } },
    { type: "turn.completed" },
  );
  const stderr = "警告 😀\n";

  fs.writeFileSync(script, `
    const fs = require("node:fs");
    const stdout = Buffer.from(${JSON.stringify(stdout)});
    const stderr = Buffer.from(${JSON.stringify(stderr)});
    const offset = stdout.indexOf("会") + 1;
    fs.writeSync(1, stdout.subarray(0, offset));
    fs.writeSync(2, stderr.subarray(0, 1));
    const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(releasePath)})) return;
      clearInterval(timer);
      fs.writeSync(1, stdout.subarray(offset));
      fs.writeSync(2, stderr.subarray(1));
      process.exitCode = Number(process.argv[2]);
    }, 10);
  `);

  for (const code of [0, 1]) {
    fs.rmSync(releasePath, { force: true });
    fs.rmSync(stdoutPath, { force: true });
    fs.rmSync(stderrPath, { force: true });
    const profile: BackendProfile = {
      ...codexProfile,
      exec: { base_args: [script, String(code)], prompt_mode: "stdin" },
    };
    const result = executeBackend({
      command: "review-plan",
      backend: {
        name: "codex", display_name: "Fixture", active: true, binary: process.execPath,
        resolved_binary: process.execPath, available: true, source: "user", profile_path: script,
        capabilities: profile.capabilities, profile,
      },
      model: null, effort: null, sandbox: "read-only", effectiveCwd: dir, prompt: "",
      schemaPath: "", lastMessagePath: path.join(dir, "last-message"), rawEventsPath: stdoutPath,
      stderrPath, timeoutSec: 10, runId: "utf8-test", resumeSessionId: null,
    });

    try {
      await waitFor(() => [stdoutPath, stderrPath].every((file) => (fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 0),
        "the first chunk in both raw logs");
      assert.deepEqual(fs.readFileSync(stdoutPath), Buffer.from(stdout).subarray(0, Buffer.from(stdout).indexOf("会") + 1));
      assert.deepEqual(fs.readFileSync(stderrPath), Buffer.from(stderr).subarray(0, 1));
    } finally {
      fs.writeFileSync(releasePath, "");
      await result;
    }

    const finished = await result;
    assert.equal(finished.backend_session_id, "会话😀");
    assert.deepEqual(fs.readFileSync(stdoutPath), Buffer.from(stdout));
    assert.deepEqual(fs.readFileSync(stderrPath), Buffer.from(stderr));
    if (code === 0) assert.deepEqual(finished.parsed_output, review);
    else assert.equal(finished.failure_message, stderr.trim());
  }
});

test("activity summarizes Codex items and terminal events", (t) => {
  const file = path.join(tempDir(t), "events.jsonl");
  const cases = [
    [{ type: "item.started", item: { type: "command_execution", command: "/bin/zsh -lc 'git status --short'" } }, "Command git status --short"],
    [{ type: "item.completed", item: { type: "file_change", changes: [{ path: "src/方案.ts", kind: "update" }] } }, "File changes src/方案.ts"],
    [{ type: "item.completed", item: { type: "agent_message", text: "写入\n通过 😀" } }, "Agent message · 写入 通过 😀"],
    [{ type: "item.started", item: { type: "mcp_tool_call", server: "repo", tool: "read" } }, "MCP tool repo/read"],
    [{ type: "item.completed", item: { type: "reasoning" } }, "Reasoning"],
    [{ type: "item.started", item: { type: "web_search", query: "Node StringDecoder" } }, "Web search · Node StringDecoder"],
    [{ type: "turn.started" }, "turn.started"],
    [{ type: "turn.completed" }, "turn.completed"],
    [{ type: "turn.failed", error: { message: "Upstream timeout" } }, "turn.failed · Upstream timeout"],
    [{ type: "error", message: "Connection closed" }, "error · Connection closed"],
  ] as const;

  for (const [event, summary] of cases) {
    fs.writeFileSync(file, jsonl({ type: "thread.started" }, event));
    assert.deepEqual(inspectRunActivity(file), {
      event_count: 2,
      truncated: false,
      last_event_type: event.type,
      last_item_type: "item" in event ? event.item.type : null,
      summary,
      updated_at: fs.statSync(file).mtime.toISOString(),
    });
  }
});

test("activity skips torn records and an old Codex warning while keeping mtime stable", async (t) => {
  const file = path.join(tempDir(t), "events.jsonl");
  assert.equal(inspectRunActivity(file), null);
  fs.writeFileSync(file, "");
  assert.equal(inspectRunActivity(file)?.event_count, 0);
  fs.appendFileSync(file, jsonl({ type: "item.completed", item: { type: "error", message: "Feature preview" } }));
  assert.equal(inspectRunActivity(file)?.summary, "Warning · Feature preview");
  fs.appendFileSync(file, jsonl({ type: "turn.started" }) + '{"type":"item.started","item":');
  const stamp = new Date("2020-01-02T03:04:05Z");
  fs.utimesSync(file, stamp, stamp);
  const activity = inspectRunActivity(file);
  assert.deepEqual(activity, {
    event_count: 2,
    truncated: false,
    last_event_type: "turn.started",
    last_item_type: null,
    summary: "turn.started",
    updated_at: stamp.toISOString(),
  });
  await delay(10);
  assert.deepEqual(inspectRunActivity(file), activity);
});

test("activity reads generic JSONL text, result, and untyped events", (t) => {
  const file = path.join(tempDir(t), "generic.jsonl");
  fs.writeFileSync(file, jsonl(null, ["ignored"], { type: "progress", text: "正在测试" }));
  assert.equal(inspectRunActivity(file)?.summary, "progress · 正在测试");
  fs.appendFileSync(file, jsonl({ type: "result", result: "passed" }));
  assert.equal(inspectRunActivity(file)?.summary, "result · passed");
  fs.appendFileSync(file, JSON.stringify({ text: "Unicode ✓" }));
  const activity = inspectRunActivity(file);
  assert.equal(activity?.event_count, 3);
  assert.equal(activity?.last_event_type, null);
  assert.equal(activity?.last_item_type, null);
  assert.equal(activity?.summary, "Unicode ✓");
});

test("activity reads a bounded tail and skips a leading partial UTF-8 line", (t) => {
  const file = path.join(tempDir(t), "large.jsonl");
  const kept = jsonl({ type: "progress", text: "最新 😀" });
  const padding = "a".repeat(65536 - Buffer.byteLength(kept) - 5);
  const bytes = Buffer.from(jsonl({ type: "old" }) + `{"type":"old","text":"😀${padding}"}\n` + kept);
  assert.equal(bytes[bytes.length - 65536] & 0xc0, 0x80);
  fs.writeFileSync(file, bytes);
  const activity = inspectRunActivity(file);
  assert.equal(activity?.truncated, true);
  assert.equal(activity?.event_count, 1);
  assert.equal(activity?.summary, "progress · 最新 😀");

  // The next read starts exactly on a line boundary.
  assert.deepEqual(inspectRunActivity(file, Buffer.byteLength(kept)), activity);
  assert.equal(inspectRunActivity(file, 8)?.event_count, 0);
});

function reviewRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const fingerprint = { digest: "seed", is_git: true, head: "seed", entries: {}, computed_at: "2026-01-01" };
  const finding: Finding = {
    id: "F1", category: "real_defect", blocking: false, title: "Duplicate submit",
    evidence: "src/form.ts:1", trigger: "Double click", impact: "Duplicate request",
    minimal_fix: "Set an in-flight guard", files: ["src/form.ts"],
  };
  return {
    run_id: "run-test", task_id: "task-test", command: "review-changes", role: "reviewer",
    backend: "codex", model: "model-test", effort: "high", sandbox: "read-only", timeout_sec: 30,
    round: 1, max_rounds: 2, resumed_from_session_id: null, cwd: "/repo", effective_cwd: "/repo",
    worktree_path: null, execution_status: "completed", acceptance_status: "pending_triage",
    failure_kind: null, failure_message: null, pid: null, pgid: null, worker_pid: null,
    exit_code: 0, signal: null, backend_session_id: "thread-test", pre_fingerprint: fingerprint,
    post_fingerprint: fingerprint, changed_files: [], boundary_violation: false, boundary_violations: [],
    verdict_valid: true, freshness_status: "fresh",
    parsed_output: { verdict: "changes_requested", summary: "Review complete", findings: [finding] },
    dispositions: [], started_at: "2026-01-01", ended_at: "2026-01-01", raw_events_path: "",
    stderr_path: "", prompt_path: "", last_message_path: "", ...overrides,
  };
}

test("Swarm review post shares the disposition rules for blocking findings", () => {
  const run = reviewRun();
  const { post, ...metadata } = formatSwarmPost(run);
  assert.deepEqual(metadata, {
    run_id: "run-test", task_id: "task-test", command: "review-changes", backend: "codex",
    model: "model-test", effort: "high", execution_status: "completed", acceptance_status: "pending_triage",
  });
  assert.match(post, /codex model=model-test effort=high cmd=review-changes round=1\/2 run_id=run-test/);
  assert.match(post, /execution=completed acceptance=pending_triage freshness=fresh verdict_valid=true/);
  assert.match(post, /Blocking findings \(1\).*F1 Duplicate submit/);
  assert.doesNotMatch(post, /\[done\]/);

  const undisposed = applyDispositions(run, []);
  assert.ok(undisposed.ok);
  assert.deepEqual(undisposed.unresolved_blocking_ids, ["F1"]);
  for (const action of ["minimal_fix", "request_evidence"] as const) {
    const result = applyDispositions(run, [{ finding_id: "F1", action }]);
    assert.ok(result.ok);
    const { post } = formatSwarmPost({ ...run, dispositions: result.dispositions });
    if (action === "minimal_fix") {
      assert.deepEqual(result.unresolved_blocking_ids, []);
      assert.match(post, /Blocking findings \(0\)/);
      assert.doesNotMatch(post, /F1/);
    } else {
      assert.deepEqual(result.unresolved_blocking_ids, ["F1"]);
      assert.match(post, /Blocking findings \(1\).*F1/);
    }
  }
});

test("a deferred polish finding cannot hide a blocking defect with the same ID", () => {
  const run = reviewRun();
  const output = run.parsed_output;
  assert.ok(output && "findings" in output);
  output.findings.push({ ...output.findings[0], category: "optional_polish", title: "Polish the form" });

  for (const [round, acceptance] of [[1, "changes_requested"], [2, "blocked"]] as const) {
    const result = applyDispositions({ ...run, round }, [{ finding_id: "F1", action: "defer" }]);
    assert.ok(result.ok);
    assert.deepEqual(result.dispositions.map((record) => record.blocking_after), [true, false]);
    assert.equal(result.acceptance_status, acceptance);
    assert.deepEqual(result.unresolved_blocking_ids, ["F1"]);
    const { post } = formatSwarmPost({ ...run, round, dispositions: result.dispositions });
    assert.match(post, /Blocking findings \(1\).*F1 Duplicate submit/);
    assert.doesNotMatch(post, /Polish the form/);
  }
});

test("Swarm posts summarize delegate results, progress, failures, and partial edits", (t) => {
  const file = path.join(tempDir(t), "events.jsonl");
  fs.writeFileSync(file, jsonl({ type: "progress", text: "Running tests" }));
  const run = reviewRun({ command: "delegate", parsed_output: null, freshness_status: "not_applicable" });
  const running = formatSwarmPost({ ...run, execution_status: "running", raw_events_path: file });
  assert.match(running.post, /Activity · progress · Running tests \(1 event,/);
  assert.doesNotMatch(running.post, /\[done\]/);

  const completed = formatSwarmPost({
    ...run, acceptance_status: "approved",
    parsed_output: {
      status: "completed", summary: "Updated the form\nand verified the guard",
      modified_files: ["src/form.ts", "a.ts", "b.ts", "c.ts", "d.ts"], tests_run: ["npm test"], open_issues: [],
    },
  }, { mention: "  @@lead ", done: true });
  assert.match(completed.post, /^@lead \[done\] codex model=model-test /);
  assert.match(completed.post, /Updated the form and verified the guard/);
  assert.match(completed.post, /Modified files \(5\).*src\/form.ts.*\(\+1 more\)/);
  assert.match(completed.post, /Tests run \(1\).*npm test/);

  const failed = formatSwarmPost({
    ...run, execution_status: "failed", acceptance_status: "blocked", verdict_valid: false,
    boundary_violation: true, boundary_violations: ["styles.css"],
    failure_kind: "boundary_violation", failure_message: "Delegate edited a file outside its scope",
  });
  assert.match(failed.post, /execution=failed acceptance=blocked/);
  assert.match(failed.post, /Failure · boundary_violation · Delegate edited a file outside its scope/);
  assert.match(failed.post, /Boundary violations \(1\).*styles.css/);

  const partial = formatSwarmPost({
    ...run, execution_status: "partial", acceptance_status: "blocked", verdict_valid: false,
    failure_kind: "timed_out", changed_files: ["src/form.ts"],
  });
  assert.match(partial.post, /execution=partial acceptance=blocked/);
  assert.match(partial.post, /Changed files \(1\).*src\/form.ts/);
});

test("standalone CLI bridges start, status and Swarm posts, including stale reviews", async (t) => {
  const dir = tempDir(t);
  const copiedSkill = path.join(dir, "copied-skill");
  const repo = path.join(dir, "repo");
  const state = path.join(dir, "state");
  const config = path.join(dir, "config");
  const releasePath = path.join(dir, "release");
  const packetPath = path.join(dir, "packet.json");
  const fixture = path.join(dir, "mock-codex");
  const cliModule = "./copied-skill/scripts/runtime/cli.ts";
  fs.cpSync(skillDir, copiedSkill, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"commonjs"}\n');
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(config, "backends"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init");
  fs.writeFileSync(path.join(repo, "form.ts"), "export const form = true;\n");
  git("add", "form.ts");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "seed");

  fs.writeFileSync(fixture, `#!/usr/bin/env node
const fs = require("node:fs");
fs.readFileSync(0, "utf8");
fs.writeSync(1, ${JSON.stringify(jsonl(
    { type: "thread.started", thread_id: "bridge-thread" },
    { type: "item.started", item: { type: "command_execution", command: "/bin/bash -lc 'git diff --stat'" } },
  ))});
const deadline = Date.now() + 10000;
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(releasePath)}) && Date.now() < deadline) return;
  clearInterval(timer);
  fs.writeSync(1, ${JSON.stringify(jsonl(
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ verdict: "approve", summary: "Review complete", findings: [] }) } },
    { type: "turn.completed" },
  ))});
}, 15);
`, { mode: 0o755 });
  fs.writeFileSync(path.join(config, "backends", "codex.json"), JSON.stringify({ ...codexProfile, binary: fixture }));
  fs.writeFileSync(packetPath, JSON.stringify({
    original_request: "Review the form", goal: "Confirm form behavior", acceptance_criteria: ["Review form.ts"],
    constraints: [], non_goals: [], relevant_files: ["form.ts"],
  }));

  function runCli(...args: string[]): string {
    const result = spawnSync(process.execPath, [
      "--input-type=module", "--eval", `import { main } from "${cliModule}"; await main(process.argv.slice(1));`, "--", ...args,
    ], {
      cwd: dir,
      env: { ...process.env, AGY_ORCH_CONFIG_DIR: config, AGY_ORCH_STATE_DIR: state },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  }

  const taskId = "bridge-task";
  const start = JSON.parse(runCli(
    "start", "review-changes", "--cwd", repo, "--task-id", taskId, "--packet", packetPath,
    "--backend", "codex", "--model", "model-test", "--effort", "high", "--timeout-sec", "15",
  ));
  assert.equal(start.execution_status, "running");
  const runFile = path.join(state, "runs", `${start.run_id}.json`);
  const readStored = () => JSON.parse(fs.readFileSync(runFile, "utf8"));
  try {
    await waitFor(() => inspectRunActivity(start.raw_events_path)?.event_count === 2, "fixture activity");
    const priorRun = fs.readFileSync(runFile);
    const status = JSON.parse(runCli("status", "--run-id", start.run_id));
    assert.equal(status.execution_status, "running");
    assert.equal(status.live_activity.last_item_type, "command_execution");
    assert.equal(status.live_activity.summary, "Command git diff --stat");
    assert.equal(status.live_activity.updated_at, fs.statSync(start.raw_events_path).mtime.toISOString());
    assert.deepEqual(fs.readFileSync(runFile), priorRun);

    const running = JSON.parse(runCli("swarm-post", "--task-id", taskId));
    assert.equal(running.run_id, start.run_id);
    assert.match(running.post, /Activity · Command git diff --stat/);

    const directoryLogRunId = "run-directory-log";
    fs.writeFileSync(path.join(state, "runs", `${directoryLogRunId}.json`), JSON.stringify({
      ...readStored(), run_id: directoryLogRunId, raw_events_path: dir,
    }));
    assert.equal(inspectRunActivity(dir), null);
    const directoryStatus = JSON.parse(runCli("status", "--run-id", directoryLogRunId));
    assert.equal(directoryStatus.run_id, directoryLogRunId);
    assert.equal(directoryStatus.execution_status, "running");
    assert.equal(directoryStatus.live_activity, null);
    const directoryPost = JSON.parse(runCli("swarm-post", "--run-id", directoryLogRunId));
    assert.match(directoryPost.post, /Activity · Waiting for JSONL events/);
  } finally {
    fs.writeFileSync(releasePath, "");
    await waitFor(() => readStored().execution_status !== "running", "fixture completion");
  }

  assert.equal(readStored().execution_status, "completed");
  assert.equal(readStored().verdict_valid, true);
  assert.equal(readStored().freshness_status, "fresh");
  assert.equal("live_activity" in JSON.parse(runCli("result", "--run-id", start.run_id)), false);

  fs.appendFileSync(path.join(repo, "form.ts"), "// Changed after review\n");
  const storedBeforePosts = fs.readFileSync(runFile);
  const runInodeBeforePosts = fs.statSync(runFile).ino;
  const postFlags = ["--mention", " @lead ", "--done"];
  const post = JSON.parse(runCli("swarm-post", "--run-id", start.run_id, ...postFlags));
  assert.equal(post.task_id, taskId);
  assert.equal(post.acceptance_status, "stale");
  assert.match(post.post, /^@lead \[done\] codex model=model-test /);
  assert.match(post.post, /freshness=stale_by_code_change verdict_valid=false/);
  assert.equal(runCli("swarm-post", "--raw", "--task-id", taskId, ...postFlags), `${post.post}\n`);
  assert.deepEqual(fs.readFileSync(runFile), storedBeforePosts);
  assert.equal(fs.statSync(runFile).ino, runInodeBeforePosts);

  const staleResult = JSON.parse(runCli("result", "--run-id", start.run_id));
  assert.equal(staleResult.verdict_valid, false);
  assert.equal(readStored().freshness_status, "stale_by_code_change");
  assert.equal("live_activity" in readStored(), false);
});
