import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("packaging: skill copy loads under a CommonJS project", (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "agy-orch-commonjs-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.writeFileSync(path.join(project, "package.json"), '{"type": "commonjs"}\n');
  fs.cpSync(path.resolve("skills/agy-orch"), path.join(project, "skills", "agy-orch"), { recursive: true });

  const env = {
    ...process.env,
    AGY_ORCH_CONFIG_DIR: path.join(project, "config"),
    AGY_ORCH_STATE_DIR: path.join(project, "state"),
  };
  function evalModule(source: string, ...args: string[]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source, "--", ...args], {
      cwd: project,
      encoding: "utf8",
      env,
      timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return result.stdout;
  }

  function runCli(...args: string[]) {
    return JSON.parse(evalModule(`
      import { main } from "./skills/agy-orch/scripts/runtime/cli.ts";
      await main(process.argv.slice(1));
    `, ...args));
  }

  assert.equal(runCli("help").name, "agy-orch");
  const { backends } = runCli("backends");
  assert.ok(backends.some((backend: { name: string }) => backend.name === "codex"));
  const triage = runCli("triage", "--summary", "Adjust button padding", "--files", "styles.css", "--kind", "style");
  assert.equal(triage.decision, "skip_heavy_flow");

  evalModule(`
    import assert from "node:assert/strict";
    import { runDetachedWorker } from "./skills/agy-orch/scripts/runtime/runner.ts";
    assert.equal(await runDetachedWorker("missing-run"), 1);
  `);

  const skillManifest = fs.readFileSync(path.join(project, "skills", "agy-orch", "package.json"), "utf8");
  assert.deepEqual(JSON.parse(skillManifest), { type: "module" });
  assert.ok(skillManifest.endsWith("\n"));
});

test("packaging: Antigravity manifest fields and starter prompts match the release", () => {
  const manifest = JSON.parse(fs.readFileSync("plugin.json", "utf8"));
  const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const allowedFields = new Set([
    "name", "displayName", "version", "description", "logo", "author", "homepage", "repository", "suggestedPrompts", "disabled",
  ]);
  for (const field of Object.keys(manifest)) {
    assert.ok(allowedFields.has(field), `Unexpected plugin manifest field: ${field}`);
  }
  assert.equal(manifest.name, "agy-orch");
  assert.equal(manifest.displayName, "agy-orch");
  assert.equal(manifest.version, version);
  assert.equal(manifest.author, "Ziyan Lin");
  assert.equal(manifest.homepage, "https://github.com/linziyanleo/agy-orch");
  assert.equal(manifest.repository, manifest.homepage);
  assert.equal(typeof manifest.description, "string");
  assert.ok(manifest.description.trim());
  assert.ok(Array.isArray(manifest.suggestedPrompts));
  assert.equal(manifest.suggestedPrompts.length, 3);
  for (const prompt of manifest.suggestedPrompts) {
    assert.equal(typeof prompt, "string");
    assert.ok(prompt.trim());
  }
});
