import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  computeFindingCounts,
  formatCancelView,
  formatStatusView,
  readEventsTail,
  readStderrTail,
  summarizeFingerprint,
} from "../skills/agy-orch/scripts/runtime/disclosure.ts";
import { applyDispositions } from "../skills/agy-orch/scripts/runtime/schema-validate.ts";
import { inspectRunActivity } from "../skills/agy-orch/scripts/runtime/swarm.ts";
import type { BackendProfile, Finding, ReviewOutput, RunRecord } from "../skills/agy-orch/scripts/runtime/types.ts";

const CLI_PATH = path.resolve("skills/agy-orch/scripts/agy-orch.mjs");
const codexProfile = JSON.parse(
  fs.readFileSync(path.resolve("skills/agy-orch/backends/codex.json"), "utf8")
) as BackendProfile;
const jsonl = (...events: unknown[]) => events.map((e) => `${JSON.stringify(e)}\n`).join("");

function tempDir(t: TestContext, prefix = "agy-pd-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const fp = {
    digest: "dig-1",
    is_git: true,
    head: "abc123",
    entries: { "src/a.ts": { status: "M", sha256: "111" }, "src/b.ts": { status: "M", sha256: "222" } },
    computed_at: "2026-01-01T00:00:00Z",
  };
  return {
    run_id: "run-pd-1",
    task_id: "task-pd-1",
    command: "review-changes",
    role: "reviewer",
    backend: "codex",
    model: "model-test",
    effort: "high",
    sandbox: "read-only",
    timeout_sec: 30,
    round: 1,
    max_rounds: 2,
    resumed_from_session_id: null,
    cwd: "/repo",
    effective_cwd: "/repo",
    worktree_path: null,
    execution_status: "completed",
    acceptance_status: "pending_triage",
    failure_kind: null,
    failure_message: null,
    pid: null,
    pgid: null,
    worker_pid: null,
    exit_code: 0,
    signal: null,
    backend_session_id: "sess-1",
    pre_fingerprint: fp,
    post_fingerprint: fp,
    changed_files: [],
    boundary_violation: false,
    boundary_violations: [],
    verdict_valid: true,
    freshness_status: "fresh",
    parsed_output: null,
    dispositions: [],
    started_at: "2026-01-01T00:00:00Z",
    ended_at: "2026-01-01T00:00:05Z",
    raw_events_path: "/tmp/events.jsonl",
    stderr_path: "/tmp/stderr.log",
    prompt_path: "/tmp/prompt.txt",
    last_message_path: "/tmp/last.json",
    ...overrides,
  };
}

function setupCliFixture(t: TestContext) {
  const root = tempDir(t, "agy-pd-cli-");
  const stateDir = path.join(root, "state");
  const configDir = path.join(root, "config");
  const repoDir = path.join(root, "repo");
  const releasePath = path.join(root, "release");
  const packetPath = path.join(root, "packet.json");
  const fixtureBin = path.join(root, "mock-codex");

  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(configDir, "backends"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });

  execFileSync("git", ["-C", repoDir, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.com"], { stdio: "ignore" });
  execFileSync("git", ["-C", repoDir, "config", "user.name", "Test"], { stdio: "ignore" });
  fs.writeFileSync(path.join(repoDir, "src", "form.ts"), "export const x = 1;\n", "utf8");
  execFileSync("git", ["-C", repoDir, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", repoDir, "commit", "-m", "seed"], { stdio: "ignore" });

  fs.writeFileSync(
    fixtureBin,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.readFileSync(0, "utf8");
const mode = process.env.MOCK_MODE || "wait";
if (mode === "wait") {
  fs.writeSync(1, ${JSON.stringify(jsonl(
    { type: "thread.started", thread_id: "thread-pd-1" },
    { type: "item.started", item: { type: "command_execution", command: "/bin/zsh -lc 'git diff'" } }
  ))});
  fs.writeSync(2, "stderr line one\\nstderr line two\\n");
  const deadline = Date.now() + 10000;
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(releasePath)}) && Date.now() < deadline) return;
    clearInterval(timer);
    fs.writeSync(1, ${JSON.stringify(jsonl(
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ verdict: "approve", summary: "All good", findings: [] }) } },
      { type: "turn.completed" }
    ))});
  }, 15);
}
`,
    { mode: 0o755 }
  );

  fs.writeFileSync(
    path.join(configDir, "backends", "codex.json"),
    JSON.stringify({ ...codexProfile, binary: fixtureBin })
  );
  fs.writeFileSync(
    packetPath,
    JSON.stringify({
      original_request: "Review form",
      goal: "Verify form.ts",
      acceptance_criteria: ["Check form.ts"],
      constraints: [],
      non_goals: [],
      relevant_files: ["src/form.ts"],
      scope: { allowed_paths: ["src/form.ts"] },
    })
  );

  function runCli(args: string[], extraEnv: Record<string, string> = {}) {
    const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGY_ORCH_STATE_DIR: stateDir,
        AGY_ORCH_CONFIG_DIR: configDir,
        ...extraEnv,
      },
      timeout: 8000,
    });
    assert.ifError(res.error);
    return {
      code: res.status ?? 1,
      data: JSON.parse(res.stdout),
      stderr: res.stderr,
    };
  }

  return { root, stateDir, configDir, repoDir, releasePath, packetPath, runCli };
}

test("summarizeFingerprint and computeFindingCounts use object-reference identity on duplicate IDs", () => {
  const fpSummary = summarizeFingerprint({
    digest: "d1",
    is_git: true,
    head: "h1",
    entries: { a: { status: "M", sha256: "1" }, b: { status: "?", sha256: null } },
    computed_at: "2026-01-01",
    status_error: "warn",
  });
  assert.deepEqual(fpSummary, {
    digest: "d1",
    is_git: true,
    head: "h1",
    entry_count: 2,
    computed_at: "2026-01-01",
    status_error: "warn",
  });

  const fDefect: Finding = {
    id: "F1",
    category: "real_defect",
    blocking: true,
    title: "Real defect",
    evidence: "x",
    trigger: "y",
    impact: "z",
    minimal_fix: "fix",
    files: ["a.ts"],
  };
  const fPolish: Finding = {
    id: "F1",
    category: "optional_polish",
    blocking: false,
    title: "Polish with duplicate ID",
    evidence: "x",
    trigger: "y",
    impact: "z",
    minimal_fix: "fix",
    files: ["a.ts"],
  };
  const fInsufficient: Finding = {
    id: "F2",
    category: "requirement_gap",
    blocking: true,
    title: "Missing spec",
    evidence: "",
    trigger: "",
    impact: "",
    minimal_fix: "",
    files: ["b.ts"],
    insufficient_evidence: true,
    missing_fields: ["evidence"],
  };
  const output: ReviewOutput = {
    verdict: "changes_requested",
    summary: "Has duplicate ID",
    findings: [fDefect, fPolish, fInsufficient],
  };
  const run = makeRun({ parsed_output: output });
  const disp = applyDispositions(run, [
    { finding_id: "F1", action: "defer" },
    { finding_id: "F2", action: "accept" },
  ]);
  assert.equal(disp.ok, true);
  if (!disp.ok) return;

  // F1 real_defect remains unresolved blocking even though F1 optional_polish was deferred; F2 accepted.
  const counts = computeFindingCounts(output, disp.dispositions);
  assert.deepEqual(counts, {
    total: 3,
    blocking: 2,
    unresolved_blocking: 1,
    by_category: {
      requirement_gap: 1,
      real_defect: 1,
      engineering_tradeoff: 0,
      optional_polish: 1,
    },
    insufficient_evidence: 1,
  });
});

test("readEventsTail and readStderrTail handle missing files, directories, UTF-8 boundaries, and caps", (t) => {
  const dir = tempDir(t);
  assert.deepEqual(readEventsTail(path.join(dir, "missing.jsonl"), 10), {
    path: path.join(dir, "missing.jsonl"),
    exists: false,
    truncated: false,
    event_count: 0,
    events: [],
  });
  assert.equal(readEventsTail(dir, 10).exists, false);
  assert.equal(readStderrTail(path.join(dir, "missing.log"), 10).exists, false);
  assert.equal(readStderrTail(dir, 10).exists, false);

  const eventsFile = path.join(dir, "events.jsonl");
  const longText = "x".repeat(300);
  const kept = jsonl({ type: "progress", text: `最新 😀 ${longText}` });
  const tailWindow = 1024;
  const padding = "a".repeat(tailWindow - Buffer.byteLength(kept) - 5);
  const bytes = Buffer.from(jsonl({ type: "old" }) + `{"type":"old","text":"😀${padding}"}\n` + kept);
  assert.equal(bytes[bytes.length - tailWindow] & 0xc0, 0x80);
  fs.writeFileSync(eventsFile, bytes);

  const tailEvents = readEventsTail(eventsFile, 5, tailWindow);
  assert.equal(tailEvents.exists, true);
  assert.equal(tailEvents.truncated, true);
  assert.equal(tailEvents.event_count, 1);
  assert.equal(tailEvents.events[0].type, "progress");
  assert.ok(tailEvents.events[0].summary.length <= 240);
  assert.ok(tailEvents.events[0].summary.startsWith("progress · 最新 😀 "));

  const stderrFile = path.join(dir, "stderr.log");
  const longErr = "E".repeat(600);
  fs.writeFileSync(stderrFile, `line1\n${longErr}\nline3 😀\n`);
  const tailStderr = readStderrTail(stderrFile, 2);
  assert.equal(tailStderr.exists, true);
  assert.equal(tailStderr.truncated, true);
  assert.equal(tailStderr.line_count, 2);
  assert.equal(tailStderr.lines[0].length, 500);
  assert.ok(tailStderr.lines[0].endsWith("…"));
  assert.equal(tailStderr.lines[1], "line3 😀");

  // Single long line within limit and maxTailBytes must still set truncated: true
  const singleLongStderr = path.join(dir, "stderr-single-long.log");
  fs.writeFileSync(singleLongStderr, `${longErr}\n`);
  const singleTail = readStderrTail(singleLongStderr, 5);
  assert.equal(singleTail.exists, true);
  assert.equal(singleTail.truncated, true);
  assert.equal(singleTail.line_count, 1);
  assert.equal(singleTail.lines[0].length, 500);

  // Single line exceeding maxTailBytes with no newline decodes valid UTF-8 tail instead of dropping
  const noNewlineStderr = path.join(dir, "stderr-no-newline.log");
  const bigSingle = Buffer.from(`prefix-${"😀".repeat(200)}-${"Z".repeat(600)}`);
  assert.equal(bigSingle[bigSingle.length - 1024] & 0xc0, 0x80);
  fs.writeFileSync(noNewlineStderr, bigSingle);
  const bigTail = readStderrTail(noNewlineStderr, 5, 1024);
  assert.equal(bigTail.exists, true);
  assert.equal(bigTail.truncated, true);
  assert.equal(bigTail.line_count, 1);
  assert.equal(bigTail.lines[0].length, 500);
  assert.ok(!bigTail.lines[0].includes("\uFFFD"));

  // 70 KiB single stderr line ending with \n and \r\n must still be returned (not dropped)
  for (const eol of ["\n", "\r\n"]) {
    const bigLinePath = path.join(dir, `stderr-70k-${eol === "\n" ? "lf" : "crlf"}.log`);
    fs.writeFileSync(bigLinePath, `${"B".repeat(70 * 1024)}${eol}`);
    const bigLineTail = readStderrTail(bigLinePath, 5);
    assert.equal(bigLineTail.exists, true);
    assert.equal(bigLineTail.truncated, true);
    assert.equal(bigLineTail.line_count, 1);
    assert.equal(bigLineTail.lines[0].length, 500);
    assert.ok(bigLineTail.lines[0].startsWith("BBBB"));
  }
});

test("formatStatusView and formatCancelView report truthful details_omitted and caps", () => {
  const emptyFpRun = makeRun({
    pre_fingerprint: { digest: "d", is_git: true, head: "h", entries: {}, computed_at: "2026-01-01" },
    post_fingerprint: null,
    changed_files: ["a.ts", "b.ts"],
    parsed_output: null,
    dispositions: [],
    execution_status: "running",
  });
  const startView = formatStatusView(emptyFpRun, { includeLiveActivity: false });
  assert.equal("live_activity" in startView, false);
  assert.equal(startView.disclosure_level, "status");
  assert.deepEqual(startView.details_omitted, []);
  assert.equal(startView.changed_files_count, 2);
  assert.deepEqual(startView.changed_files, ["a.ts", "b.ts"]);
  assert.ok(startView.next_actions.every((cmd) => cmd.includes(emptyFpRun.run_id)));

  const bigChanged = Array.from({ length: 60 }, (_, i) => `file-${i}.ts`);
  const cancelledRun = makeRun({
    execution_status: "cancelled",
    acceptance_status: "blocked",
    changed_files: bigChanged,
  });
  const cancelView = formatCancelView(cancelledRun, { dead: true, escalated_to_sigkill: false });
  assert.equal(cancelView.disclosure_level, "status");
  assert.equal(cancelView.changed_files_count, 60);
  assert.equal(cancelView.changed_files.length, 50);
  assert.deepEqual(cancelView.details_omitted, [
    "pre_fingerprint.entries",
    "post_fingerprint.entries",
    "changed_files",
  ]);
  assert.deepEqual(cancelView.kill_result, { dead: true, escalated_to_sigkill: false });
});

test("CLI start, status, cancel slim vs --full, tails, and flag validation", async (t) => {
  const ctx = setupCliFixture(t);

  // Invalid tail limits & status filter rejection
  for (const bad of ["--events-tail", "--events-tail=0", "--events-tail=-2", "--events-tail=1.5", "--events-tail=abc", "--events-tail=501"]) {
    const res = ctx.runCli(["status", "--task-id", "nope", ...bad.split("=")]);
    assert.equal(res.code, 1);
    assert.equal(res.data.ok, false);
  }
  const bareTail = ctx.runCli(["status", "--task-id", "nope", "--stderr-tail"]);
  assert.equal(bareTail.code, 1);
  assert.equal(bareTail.data.ok, false);

  for (const forbidden of [["--finding", "F1"], ["--blocking-only"], ["--category", "real_defect"]]) {
    const res = ctx.runCli(["status", "--task-id", "nope", ...forbidden]);
    assert.equal(res.code, 1);
    assert.equal(res.data.ok, false);
  }

  // start returns slim status view without live_activity while storing full RunRecord on disk
  const started = ctx.runCli([
    "start",
    "review-changes",
    "--cwd",
    ctx.repoDir,
    "--task-id",
    "t-pd-start",
    "--packet",
    ctx.packetPath,
  ]);
  assert.equal(started.code, 0);
  assert.equal(started.data.disclosure_level, "status");
  assert.equal("live_activity" in started.data, false);
  assert.equal(typeof started.data.pre_fingerprint.entry_count, "number");
  assert.equal("entries" in started.data.pre_fingerprint, false);

  const onDisk = JSON.parse(
    fs.readFileSync(path.join(ctx.stateDir, "runs", `${started.data.run_id}.json`), "utf8")
  ) as RunRecord;
  assert.ok("entries" in onDisk.pre_fingerprint);

  try {
    await waitFor(
      () => (inspectRunActivity(started.data.raw_events_path)?.event_count ?? 0) >= 2,
      "fixture events"
    );

    const statusSlim = ctx.runCli([
      "status",
      "--run-id",
      started.data.run_id,
      "--events-tail",
      "5",
      "--stderr-tail",
      "5",
    ]);
    assert.equal(statusSlim.code, 0);
    assert.equal(statusSlim.data.disclosure_level, "status");
    assert.equal(statusSlim.data.live_activity.last_item_type, "command_execution");
    assert.equal(statusSlim.data.events_tail.exists, true);
    assert.equal(statusSlim.data.events_tail.event_count, 2);
    assert.equal(statusSlim.data.stderr_tail.exists, true);
    assert.deepEqual(statusSlim.data.stderr_tail.lines, ["stderr line one", "stderr line two"]);

    const statusFull = ctx.runCli([
      "status",
      "--run-id",
      started.data.run_id,
      "--events-tail",
      "1",
      "--full",
    ]);
    assert.equal(statusFull.code, 0);
    assert.equal("disclosure_level" in statusFull.data, false);
    assert.ok("entries" in statusFull.data.pre_fingerprint);
    assert.equal(statusFull.data.events_tail.event_count, 1);

    const cancelled = ctx.runCli(["cancel", "--run-id", started.data.run_id]);
    assert.equal(cancelled.code, 0);
    assert.equal(cancelled.data.disclosure_level, "status");
    assert.equal(cancelled.data.execution_status, "cancelled");
    assert.equal(cancelled.data.kill_result.dead, true);
    assert.equal("entries" in cancelled.data.pre_fingerprint, false);

    const cancelledFull = ctx.runCli(["cancel", "--run-id", started.data.run_id, "--full"]);
    assert.equal(cancelledFull.code, 0);
    assert.equal("disclosure_level" in cancelledFull.data, false);
    assert.ok("entries" in cancelledFull.data.pre_fingerprint);
  } finally {
    fs.writeFileSync(ctx.releasePath, "1");
  }

  // --background --full returns full RunRecord
  const bgFull = ctx.runCli([
    "review-changes",
    "--cwd",
    ctx.repoDir,
    "--task-id",
    "t-pd-bg-full",
    "--packet",
    ctx.packetPath,
    "--background",
    "--full",
  ]);
  assert.equal(bgFull.code, 0);
  assert.equal("disclosure_level" in bgFull.data, false);
  assert.ok("entries" in bgFull.data.pre_fingerprint);
  await waitFor(
    () =>
      JSON.parse(
        fs.readFileSync(path.join(ctx.stateDir, "runs", `${bgFull.data.run_id}.json`), "utf8")
      ).execution_status !== "running",
    "bg full completion"
  );

  // Piped CLI output > 64 KiB (--stderr-tail 500) must flush completely before exit
  const largeStderrRun = makeRun({
    run_id: "run-large-pipe",
    task_id: "task-large-pipe",
    execution_status: "completed",
    stderr_path: path.join(ctx.root, "large-stderr.log"),
  });
  const manyLines = Array.from({ length: 500 }, (_, i) => `err-${i}-${"x".repeat(115)}`).join("\n") + "\n";
  assert.ok(Buffer.byteLength(manyLines) < 64 * 1024);
  fs.writeFileSync(largeStderrRun.stderr_path, manyLines);
  fs.writeFileSync(
    path.join(ctx.stateDir, "runs", `${largeStderrRun.run_id}.json`),
    JSON.stringify(largeStderrRun)
  );
  const largeStatus = ctx.runCli(["status", "--run-id", largeStderrRun.run_id, "--stderr-tail", "500"]);
  assert.equal(largeStatus.code, 0);
  assert.ok(JSON.stringify(largeStatus.data, null, 2).length > 65536);
  assert.equal(largeStatus.data.stderr_tail.line_count, 500);
  assert.equal(largeStatus.data.stderr_tail.lines[499].startsWith("err-499-"), true);
});
