import fs from "node:fs";
import path from "node:path";
import { ensureDir, getLocksDir, hashString } from "./paths.ts";
import type { WriterLockRecord } from "./types.ts";

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export function isProcessGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function killProcessGroup(
  pgid: number,
  graceMs = 2000
): Promise<{ dead: boolean; escalated_to_sigkill: boolean }> {
  if (!Number.isInteger(pgid) || pgid <= 0) {
    return { dead: true, escalated_to_sigkill: false };
  }
  if (!isProcessGroupAlive(pgid)) {
    return { dead: true, escalated_to_sigkill: false };
  }

  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    // process group may have exited between check and signal
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pgid)) {
      return { dead: true, escalated_to_sigkill: false };
    }
    await sleepMs(50);
  }

  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // ignore ESRCH
  }

  const killDeadline = Date.now() + 500;
  while (Date.now() < killDeadline) {
    if (!isProcessGroupAlive(pgid)) {
      return { dead: true, escalated_to_sigkill: true };
    }
    await sleepMs(25);
  }

  return {
    dead: !isProcessGroupAlive(pgid),
    escalated_to_sigkill: true,
  };
}

export function getWriterLockPath(effectiveCwd: string): string {
  return path.join(getLocksDir(), `${hashString(effectiveCwd)}.writer.lock`);
}

export function acquireWriterLock(
  effectiveCwd: string,
  runId: string,
  taskId: string,
  pid = process.pid,
  pgid: number | null = process.pid
): { acquired: true; lockPath: string } | { acquired: false; existing: WriterLockRecord; lockPath: string } {
  const lockDir = getLocksDir();
  ensureDir(lockDir);
  const lockPath = getWriterLockPath(effectiveCwd);
  const payload: WriterLockRecord = {
    pid,
    pgid,
    run_id: runId,
    task_id: taskId,
    cwd: effectiveCwd,
    acquired_at: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      return { acquired: true, lockPath };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw err;
      }
      try {
        const raw = fs.readFileSync(lockPath, "utf8");
        const existing = JSON.parse(raw) as WriterLockRecord;
        if (existing && isPidAlive(existing.pid)) {
          return { acquired: false, existing, lockPath };
        }
        // Stale lock whose holder PID no longer exists.
        fs.unlinkSync(lockPath);
      } catch {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore race
        }
      }
    }
  }

  const raw = fs.readFileSync(lockPath, "utf8");
  return {
    acquired: false,
    existing: JSON.parse(raw) as WriterLockRecord,
    lockPath,
  };
}

export function updateWriterLockPid(
  effectiveCwd: string,
  runId: string,
  pid: number,
  pgid: number | null
): void {
  const lockPath = getWriterLockPath(effectiveCwd);
  if (!fs.existsSync(lockPath)) return;
  try {
    const existing = JSON.parse(fs.readFileSync(lockPath, "utf8")) as WriterLockRecord;
    if (existing.run_id !== runId) return;
    existing.pid = pid;
    existing.pgid = pgid;
    fs.writeFileSync(lockPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
  } catch {
    // best-effort update
  }
}

export function releaseWriterLock(effectiveCwd: string, runId: string): void {
  const lockPath = getWriterLockPath(effectiveCwd);
  if (!fs.existsSync(lockPath)) return;
  try {
    const existing = JSON.parse(fs.readFileSync(lockPath, "utf8")) as WriterLockRecord;
    if (existing.run_id === runId) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // avoid deleting an unknown lock
  }
}
