import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { executeBackend } from "../skills/agy-orch/scripts/runtime/backend-runner.ts";
import {
  computeWorkspaceFingerprint,
  diffFingerprints,
  findBoundaryViolations,
} from "../skills/agy-orch/scripts/runtime/fingerprint.ts";
import {
  acquireWriterLock,
  getWriterLockPath,
  isPidAlive,
  killProcessGroup,
  releaseWriterLock,
  updateWriterLockPid,
} from "../skills/agy-orch/scripts/runtime/lock.ts";
import { applyDispositions } from "../skills/agy-orch/scripts/runtime/schema-validate.ts";
import { refreshRunFreshness } from "../skills/agy-orch/scripts/runtime/store.ts";
import type { DiscoveredBackend, RunRecord } from "../skills/agy-orch/scripts/runtime/types.ts";

const execFileAsync = promisify(execFile);

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-orch-reliability-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function lockWorkspace(t: TestContext): string {
  const dir = tempDir(t);
  const previous = process.env.AGY_ORCH_STATE_DIR;
  process.env.AGY_ORCH_STATE_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.AGY_ORCH_STATE_DIR;
    else process.env.AGY_ORCH_STATE_DIR = previous;
  });
  return dir;
}

test("writer lock publishes complete JSON and replaces PID updates atomically", (t) => {
  const cwd = lockWorkspace(t);
  const lockPath = getWriterLockPath(cwd);
  const link = fs.linkSync;
  let published: string | undefined;
  t.mock.method(fs, "linkSync", (source: fs.PathLike, destination: fs.PathLike) => {
    link(source, destination);
    if (destination === lockPath) published = fs.readFileSync(destination, "utf8");
  });

  assert.equal(acquireWriterLock(cwd, "owner", "task").acquired, true);
  const initial = fs.readFileSync(lockPath, "utf8");
  const reader = fs.openSync(lockPath, "r");
  try {
    updateWriterLockPid(cwd, "other-run", process.pid, process.pid);
    assert.equal(fs.readFileSync(lockPath, "utf8"), initial);

    updateWriterLockPid(cwd, "owner", process.pid, null);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pgid, null);
    assert.equal(fs.readFileSync(reader, "utf8"), initial, "an open reader must retain its snapshot");
    assert.equal(published, initial, "the new lock must contain complete JSON at publication");
    assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), [path.basename(lockPath)]);
    assert.equal(acquireWriterLock(cwd, "other-run", "task").acquired, false);
    assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), [path.basename(lockPath)]);
  } finally {
    fs.closeSync(reader);
  }
});

test("acquisition preserves unreadable or invalid writer locks", (t) => {
  const cwd = lockWorkspace(t);
  const lockPath = getWriterLockPath(cwd);
  fs.mkdirSync(path.dirname(lockPath));

  for (const raw of ["", '{"pid":0,"run_id":"unknown"}']) {
    fs.writeFileSync(lockPath, raw);
    assert.throws(() => acquireWriterLock(cwd, "contender", "task"), /writer lock/i);
    assert.equal(fs.readFileSync(lockPath, "utf8"), raw);
  }
});

test("stale writer lock reclamation preserves a record replaced during its PID check", (t) => {
  const cwd = lockWorkspace(t);
  const lockPath = getWriterLockPath(cwd);
  const deadPid = Number(execFileSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" }));
  assert.equal(isPidAlive(deadPid), false);
  assert.equal(acquireWriterLock(cwd, "stale", "task", deadPid, null).acquired, true);

  const replacement = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  replacement.pid = process.pid;
  replacement.run_id = "new-owner";
  const replacementPath = `${lockPath}.replacement`;
  fs.writeFileSync(replacementPath, JSON.stringify(replacement));
  const kill = process.kill;
  t.mock.method(process, "kill", (pid: number, signal?: number | NodeJS.Signals) => {
    if (pid === deadPid && signal === 0) fs.renameSync(replacementPath, lockPath);
    return kill(pid, signal);
  });

  const result = acquireWriterLock(cwd, "contender", "task");
  assert.equal(result.acquired, false);
  if (!result.acquired) assert.equal(result.existing.run_id, "new-owner");
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).run_id, "new-owner");
});

test("acquisition reclaims a writer lock after its holder exits", (t) => {
  const cwd = lockWorkspace(t);
  const deadPid = Number(execFileSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" }));
  assert.equal(isPidAlive(deadPid), false);
  assert.equal(acquireWriterLock(cwd, "stale", "task", deadPid, null).acquired, true);
  const result = acquireWriterLock(cwd, "new-owner", "task");
  assert.equal(result.acquired, true);
  releaseWriterLock(cwd, "stale");
  assert.equal(JSON.parse(fs.readFileSync(result.lockPath, "utf8")).run_id, "new-owner");
  releaseWriterLock(cwd, "new-owner");
  assert.equal(fs.existsSync(result.lockPath), false);
});

test("concurrent processes agree on one owner after reclaiming a stale writer lock", async (t) => {
  const cwd = lockWorkspace(t);
  const deadPid = Number(execFileSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" }));
  const lock = acquireWriterLock(cwd, "stale", "task", deadPid, null);
  assert.equal(lock.acquired, true);
  const lockModule = new URL("../skills/agy-orch/scripts/runtime/lock.ts", import.meta.url);
  const script = `
    import { acquireWriterLock } from ${JSON.stringify(lockModule.href)};
    const [, cwd, runId, pid] = process.argv;
    const result = acquireWriterLock(cwd, runId, "task", Number(pid), null);
    console.log(JSON.stringify({ acquired: result.acquired, owner: result.existing?.run_id ?? runId }));
  `;
  const results = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
    const { stdout } = await execFileAsync(process.execPath, [
      "--input-type=module", "-e", script, cwd, `contender-${i}`, String(process.pid),
    ]);
    return JSON.parse(stdout) as { acquired: boolean; owner: string };
  }));
  const owner = JSON.parse(fs.readFileSync(lock.lockPath, "utf8")).run_id;
  assert.deepEqual(results.filter((result) => result.acquired), [{ acquired: true, owner }]);
  assert.deepEqual(new Set(results.map((result) => result.owner)), new Set([owner]));
});

test("backend timeout waits for a SIGTERM-resistant grandchild after its parent exits", async (t) => {
  const cwd = tempDir(t);
  const pidPath = path.join(cwd, "grandchild.pid");
  const parentExitPath = path.join(cwd, "parent-exited");
  const grandchildScript = `
    process.on("SIGTERM", () => {});
    require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    setInterval(() => {}, 1000);
  `;
  const parentScript = `
    process.on("SIGTERM", () => process.exit(0));
    process.on("exit", () => require("node:fs").writeFileSync(${JSON.stringify(parentExitPath)}, ""));
    require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], {
      stdio: "ignore",
    });
    setInterval(() => {}, 1000);
  `;
  const capabilities = {
    model: false, effort: false, sandbox: false, resume: false, output_schema: false, worktree: false,
  };
  const backend: DiscoveredBackend = {
    name: "test-node",
    display_name: "Test Node",
    active: true,
    binary: process.execPath,
    resolved_binary: process.execPath,
    available: true,
    source: "user",
    profile_path: "",
    capabilities,
    profile: {
      name: "test-node",
      display_name: "Test Node",
      active: true,
      binary: process.execPath,
      output_protocol: "text",
      capabilities,
      exec: { base_args: ["-e", parentScript], prompt_mode: "stdin" },
      resume: { supported: false },
    },
  };

  let pgid: number | undefined;
  try {
    const result = await executeBackend({
      command: "delegate",
      backend,
      model: null,
      effort: null,
      sandbox: "workspace-write",
      effectiveCwd: cwd,
      prompt: "",
      schemaPath: "",
      lastMessagePath: path.join(cwd, "last-message.json"),
      rawEventsPath: path.join(cwd, "events.log"),
      stderrPath: path.join(cwd, "stderr.log"),
      timeoutSec: 1,
      runId: "timeout-regression",
      resumeSessionId: null,
      onSpawn: (_pid, group) => { pgid = group; },
    });
    assert.equal(result.failure_kind, "timed_out");
    assert.equal(result.exit_code, 0, "the parent must have exited on SIGTERM");
    assert.equal(fs.existsSync(parentExitPath), true);
    const grandchildPid = Number(fs.readFileSync(pidPath, "utf8"));
    if (!isPidAlive(grandchildPid)) return;
    if (process.platform === "linux") {
      // An orphan can remain as a zombie until PID 1 reaps it on Linux.
      try {
        const stat = fs.readFileSync(`/proc/${grandchildPid}/stat`, "utf8");
        assert.match(stat, /\) Z /, "the grandchild must have stopped before executeBackend resolves");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    } else {
      assert.fail("the grandchild must have stopped before executeBackend resolves");
    }
  } finally {
    if (pgid !== undefined) await killProcessGroup(pgid, 0);
  }
});

test("stale writer lock guard from a crashed process is reclaimed cleanly", (t) => {
  const cwd = lockWorkspace(t);
  const lockPath = getWriterLockPath(cwd);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadPid = Number(execFileSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" }));
  assert.equal(isPidAlive(deadPid), false);

  const guardPath = `${lockPath}.guard`;
  fs.writeFileSync(guardPath, `${JSON.stringify({ pid: deadPid })}\n`, "utf8");

  const acquired = acquireWriterLock(cwd, "after-crash", "task");
  assert.equal(acquired.acquired, true);
  assert.equal(fs.existsSync(guardPath), false);
  releaseWriterLock(cwd, "after-crash");
});

test("git status failure records status_error, blocks disposition, and avoids blaming pre-existing dirty files", (t) => {
  const cwd = tempDir(t);
  execFileSync("git", ["-C", cwd, "init"], { stdio: "ignore" });
  fs.writeFileSync(path.join(cwd, "README.md"), "dirty before run\n", "utf8");
  const preDirty = computeWorkspaceFingerprint(cwd);
  assert.equal(preDirty.is_git, true);
  assert.equal(preDirty.status_error, undefined);
  assert.ok(preDirty.entries["README.md"]);

  fs.writeFileSync(path.join(cwd, ".git", "index"), "invalid git index");
  assert.throws(() => execFileSync(
    "git", ["-C", cwd, "status", "--porcelain=v1", "-z", "-uall"], { stdio: "ignore" }
  ));
  const failed = computeWorkspaceFingerprint(cwd);
  const failedAgain = computeWorkspaceFingerprint(cwd);

  assert.equal(failed.is_git, true);
  assert.ok(failed.status_error && failed.status_error.length > 0, "git status failure must set status_error");
  assert.notEqual(failed.digest, preDirty.digest, "git status failure must invalidate prior fingerprint");
  assert.notEqual(failedAgain.digest, failed.digest);
  assert.deepEqual(failed.entries, {});
  assert.deepEqual(diffFingerprints(preDirty, failed, cwd), []);
  assert.deepEqual(diffFingerprints(failed, preDirty, cwd), []);
  assert.deepEqual(findBoundaryViolations(["<git-status-error>"], ["**"]), []);

  const mockRun = {
    run_id: "r-fresh",
    task_id: "t-fresh",
    command: "review-changes",
    effective_cwd: cwd,
    execution_status: "completed",
    acceptance_status: "approved",
    boundary_violation: false,
    verdict_valid: true,
    freshness_status: "fresh",
    pre_fingerprint: preDirty,
    round: 1,
    max_rounds: 2,
    parsed_output: { verdict: "approve", summary: "ok", findings: [] },
  } as RunRecord;
  refreshRunFreshness(mockRun);
  assert.equal(mockRun.freshness_status, "invalid_boundary");
  assert.equal(mockRun.verdict_valid, false);
  assert.equal(mockRun.acceptance_status, "stale");

  const disp = applyDispositions(mockRun, []);
  assert.equal(disp.ok, true);
  if (disp.ok) {
    assert.equal(disp.acceptance_status, "blocked");
  }
});
