import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_USER_CONFIG,
  getBackend,
  resolveRunSettings,
} from "../skills/agy-orch/scripts/runtime/config.ts";
import { disposeRun, runExecutionCommand } from "../skills/agy-orch/scripts/runtime/runner.ts";
import { createTaskExclusive, getTaskFilePath, listRuns, loadTask } from "../skills/agy-orch/scripts/runtime/store.ts";
import type { ReviewOutput } from "../skills/agy-orch/scripts/runtime/types.ts";

function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-orch-promo-"));
  const cwd = path.join(root, "repo");
  const configDir = path.join(root, "config");
  const env = {
    AGY_ORCH_CONFIG_DIR: configDir,
    AGY_ORCH_STATE_DIR: path.join(root, "state"),
    AGY_ORCH_ACTIVE: undefined,
    AGY_ORCH_BACKEND: undefined,
    AGY_ORCH_MODEL: undefined,
    AGY_ORCH_EFFORT: undefined,
  };
  const previousEnv = Object.keys(env).map((key) => [key, process.env[key]] as const);
  function setEnv(key: string, value?: string) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previousEnv) setEnv(key, value);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const [key, value] of Object.entries(env)) setEnv(key, value);
  fs.mkdirSync(path.join(cwd, ".agy-orch"), { recursive: true });
  fs.mkdirSync(path.join(configDir, "backends"), { recursive: true });
  return { root, cwd, configDir };
}

test("F02: bundled roles and backends leave model and effort to the CLI", (t) => {
  const { cwd } = setup(t);
  for (const role of Object.values(DEFAULT_USER_CONFIG.roles ?? {})) {
    assert.deepEqual([role.model ?? null, role.effort ?? null], [null, null]);
  }
  for (const role of ["lead", "reviewer", "implementer"]) {
    const settings = resolveRunSettings({ cwd, role });
    assert.deepEqual([settings.model, settings.effort], [null, null]);
    const defaults = settings.backend_profile?.profile.defaults;
    assert.deepEqual([defaults?.model ?? null, defaults?.effort ?? null], [null, null]);
  }
  fs.writeFileSync(path.join(cwd, ".agy-orch", "config.json"), JSON.stringify({
    roles: { custom: { timeout_sec: 90 } },
  }));
  const custom = resolveRunSettings({ cwd, role: "custom" });
  assert.deepEqual([custom.model, custom.effort], [null, null]);
});

test("F02: an explicit backend override drops model and effort from the configured role", (t) => {
  const { cwd, configDir } = setup(t);
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
    roles: { reviewer: { backend: "codex", model: "user-model" } },
  }));
  fs.writeFileSync(path.join(cwd, ".agy-orch", "config.json"), JSON.stringify({
    roles: { reviewer: { model: "project-model", effort: "project-effort" } },
  }));
  const input = { cwd, role: "reviewer" };
  const sameBackend = resolveRunSettings({ ...input, backend: "codex" });
  assert.deepEqual([sameBackend.model, sameBackend.effort], ["project-model", "project-effort"]);

  const overridden = resolveRunSettings({ ...input, backend: "agy" });
  assert.deepEqual([overridden.backend, overridden.model, overridden.effort], ["agy", null, null]);
});

test("F02: project config switching backend drops user-level model and effort", (t) => {
  const { cwd, configDir } = setup(t);
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
    roles: { reviewer: { backend: "codex", model: "codex-model", effort: "xhigh" } },
  }));
  fs.writeFileSync(path.join(cwd, ".agy-orch", "config.json"), JSON.stringify({
    roles: { reviewer: { backend: "agy" } },
  }));
  const resolved = resolveRunSettings({ cwd, role: "reviewer" });
  assert.deepEqual([resolved.backend, resolved.model, resolved.effort], ["agy", null, null]);
});

test("F02: an environment backend override uses target defaults and honors explicit parameters", (t) => {
  const { cwd, configDir } = setup(t);
  const pi = getBackend("pi");
  assert.ok(pi);
  fs.writeFileSync(path.join(configDir, "backends", "pi.json"), JSON.stringify({
    ...pi.profile,
    defaults: { model: "pi-model", effort: "pi-effort" },
  }));
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
    roles: { reviewer: { backend: "codex", model: "codex-model", effort: "codex-effort" } },
  }));
  process.env.AGY_ORCH_BACKEND = "pi";
  const input = { cwd, role: "reviewer" };
  const overridden = resolveRunSettings(input);
  assert.deepEqual([overridden.backend, overridden.model, overridden.effort], ["pi", "pi-model", "pi-effort"]);

  process.env.AGY_ORCH_MODEL = "env-model";
  process.env.AGY_ORCH_EFFORT = "env-effort";
  const fromEnv = resolveRunSettings(input);
  assert.deepEqual([fromEnv.model, fromEnv.effort], ["env-model", "env-effort"]);
  const fromOptions = resolveRunSettings({ ...input, backend: "agy", model: "cli-model", effort: "cli-effort" });
  assert.deepEqual([fromOptions.backend, fromOptions.model, fromOptions.effort], ["agy", "cli-model", "cli-effort"]);
});

function mockReviewBackend(configDir: string, name: string, verdict: ReviewOutput["verdict"]) {
  const codex = getBackend("codex");
  assert.ok(codex);
  const review: ReviewOutput = { verdict, summary: "Mock review", findings: [] };
  const events = [
    { type: "thread.started", thread_id: "mock-session" },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(review) } },
    { type: "turn.completed" },
  ].map((event) => JSON.stringify(event)).join("\n");
  fs.writeFileSync(path.join(configDir, "backends", `${name}.json`), JSON.stringify({
    ...codex.profile,
    name,
    binary: process.execPath,
    exec: {
      base_args: ["--eval", `process.stdout.write(${JSON.stringify(events)})`, "--"],
      prompt_mode: "arg",
    },
  }));
}

const packet = {
  original_request: "Review the change",
  goal: "Check the submitted change",
  acceptance_criteria: ["Report the review verdict"],
  constraints: [],
  non_goals: [],
  relevant_files: [],
};

for (const [verdict, status] of [
  ["blocked", "blocked"],
  ["changes_requested", "changes_requested"],
  ["approve", "approved"],
] as const) {
  test(`F08: disposing an empty review preserves ${verdict}`, async (t) => {
    const { cwd, configDir } = setup(t);
    mockReviewBackend(configDir, "codex", verdict);
    const result = await runExecutionCommand({ command: "review-plan", cwd, packet_inline: packet });
    assert.ok(result.ok && result.run, result.error?.failure_message ?? result.run?.failure_message ?? undefined);
    assert.equal(result.run.acceptance_status, status);
    const disposed = disposeRun({ run_id: result.run.run_id }, []);
    assert.ok(disposed.ok);
    assert.equal(disposed.run.acceptance_status, status);
  });
}

for (const mismatch of ["cwd", "backend"] as const) {
  test(`F10: rejects task reuse with a different ${mismatch} and preserves the stored task`, async (t) => {
    const { root, cwd, configDir } = setup(t);
    mockReviewBackend(configDir, "codex", "approve");
    mockReviewBackend(configDir, "agy", "approve");
    const otherCwd = fs.mkdtempSync(path.join(root, "other-repo-"));
    const input = { command: "review-plan", cwd, task_id: "shared-id", packet_inline: packet } as const;
    const initial = await runExecutionCommand(input);
    assert.ok(initial.ok && initial.run, initial.error?.failure_message ?? initial.run?.failure_message ?? undefined);
    assert.equal(initial.run.backend_session_id, "mock-session");
    const taskPath = getTaskFilePath(input.task_id);
    const originalTask = fs.readFileSync(taskPath, "utf8");
    const override = mismatch === "cwd" ? { cwd: otherCwd } : { backend: "agy" };

    for (const [resume, failureKind] of [[true, "resume_error"], [false, "invalid_parameter"]] as const) {
      const rejected = await runExecutionCommand({ ...input, ...override, resume });
      assert.equal(rejected.error?.failure_kind, failureKind);
      assert.match(rejected.error.failure_message, new RegExp(`${mismatch} mismatch`));
      assert.equal(fs.readFileSync(taskPath, "utf8"), originalTask);
      assert.deepEqual(listRuns({ task_id: input.task_id }).map((run) => run.run_id), [initial.run.run_id]);
    }
  });
}

test("F10: createTaskExclusive binds first creator atomically and exposes collision to contender", (t) => {
  const { cwd } = setup(t);
  const now = new Date().toISOString();
  const first = createTaskExclusive({
    task_id: "race-task-1",
    cwd,
    backend: "codex",
    backend_session_id: null,
    round: 1,
    max_rounds: 2,
    latest_run_id: "run-1",
    run_ids: ["run-1"],
    created_at: now,
    updated_at: now,
  });
  assert.equal(first.created, true);

  const second = createTaskExclusive({
    task_id: "race-task-1",
    cwd: "/tmp/other-project",
    backend: "agy",
    backend_session_id: null,
    round: 1,
    max_rounds: 2,
    latest_run_id: "run-2",
    run_ids: ["run-2"],
    created_at: now,
    updated_at: now,
  });
  assert.equal(second.created, false);
  if (!second.created) {
    assert.equal(second.existing?.cwd, cwd);
    assert.equal(second.existing?.backend, "codex");
  }
  assert.equal(loadTask("race-task-1")?.cwd, cwd);
});
