import fs from "node:fs";
import path from "node:path";
import { computeWorkspaceFingerprint } from "./fingerprint.ts";
import { ensureDir, getRunsDir, getTasksDir } from "./paths.ts";
import type { RunRecord, TaskRecord } from "./types.ts";

function atomicWriteJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

export function getRunFilePath(runId: string): string {
  return path.join(getRunsDir(), `${runId}.json`);
}

export function getTaskFilePath(taskId: string): string {
  return path.join(getTasksDir(), `${encodeURIComponent(taskId)}.json`);
}

export function saveRun(run: RunRecord): void {
  atomicWriteJson(getRunFilePath(run.run_id), run);
}

export function loadRun(runId: string): RunRecord | null {
  const filePath = getRunFilePath(runId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as RunRecord;
}

export function saveTask(task: TaskRecord): void {
  atomicWriteJson(getTaskFilePath(task.task_id), task);
}

export function loadTask(taskId: string): TaskRecord | null {
  const filePath = getTaskFilePath(taskId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as TaskRecord;
}

export function listRuns(filters?: {
  task_id?: string;
  cwd?: string;
  limit?: number;
}): RunRecord[] {
  const runsDir = getRunsDir();
  if (!fs.existsSync(runsDir)) return [];
  const entries = fs.readdirSync(runsDir, { withFileTypes: true });
  const records: RunRecord[] = [];
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".json") ||
      entry.name.endsWith(".last.json") ||
      entry.name.endsWith(".worker.json")
    ) {
      continue;
    }
    try {
      const rec = JSON.parse(
        fs.readFileSync(path.join(runsDir, entry.name), "utf8")
      ) as RunRecord;
      if (!rec || typeof rec.run_id !== "string" || typeof rec.started_at !== "string") {
        continue;
      }
      if (filters?.task_id && rec.task_id !== filters.task_id) continue;
      if (filters?.cwd && rec.cwd !== filters.cwd) continue;
      records.push(rec);
    } catch {
      // skip corrupt record
    }
  }
  records.sort((a, b) => b.started_at.localeCompare(a.started_at));
  if (filters?.limit && filters.limit > 0) {
    return records.slice(0, filters.limit);
  }
  return records;
}

export function refreshRunFreshness(run: RunRecord): RunRecord {
  if (run.boundary_violation) {
    run.freshness_status = "invalid_boundary";
    run.verdict_valid = false;
    return run;
  }
  if (run.command !== "review-changes") {
    run.freshness_status = "not_applicable";
    return run;
  }
  if (run.execution_status !== "completed") {
    run.verdict_valid = false;
    return run;
  }
  const current = computeWorkspaceFingerprint(run.effective_cwd);
  if (current.digest !== run.pre_fingerprint.digest) {
    run.freshness_status = "stale_by_code_change";
    run.verdict_valid = false;
    run.acceptance_status = "stale";
  } else {
    run.freshness_status = "fresh";
    run.verdict_valid = true;
  }
  return run;
}
