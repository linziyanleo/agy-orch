import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_ROOT = path.resolve(THIS_DIR, "../..");
export const BUNDLED_BACKENDS_DIR = path.join(SKILL_ROOT, "backends");
export const BUNDLED_SCHEMAS_DIR = path.join(SKILL_ROOT, "schemas");
export const CLI_ENTRYPOINT = path.join(SKILL_ROOT, "scripts", "agy-orch.mjs");

export function getConfigDir(): string {
  const override = process.env.AGY_ORCH_CONFIG_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".config", "agy-orch");
}

export function getUserConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

export function getUserBackendsDir(): string {
  return path.join(getConfigDir(), "backends");
}

export function getStateDir(): string {
  const override = process.env.AGY_ORCH_STATE_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".local", "state", "agy-orch");
}

export function getTasksDir(): string {
  return path.join(getStateDir(), "tasks");
}

export function getRunsDir(): string {
  return path.join(getStateDir(), "runs");
}

export function getLocksDir(): string {
  return path.join(getStateDir(), "locks");
}

export function getWorktreesDir(): string {
  return path.join(getStateDir(), "worktrees");
}

export function canonicalizeCwd(cwdInput?: string): string {
  const target = cwdInput ? path.resolve(cwdInput) : process.cwd();
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

export function hashString(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}
