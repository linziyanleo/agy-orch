import { randomUUID } from "node:crypto";
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
    return code !== "ESRCH";
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

const mutationWait = new Int32Array(new SharedArrayBuffer(4));

function readGuardOwner(guardPath: string): { pid: number; stat: fs.BigIntStats } | null {
  try {
    const fd = fs.openSync(guardPath, "r");
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      const parsed = JSON.parse(fs.readFileSync(fd, "utf8")) as { pid?: unknown };
      if (typeof parsed?.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
        return null;
      }
      return { pid: parsed.pid, stat };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function withLockMutation<T>(lockPath: string, mutate: () => T): T {
  // Serializes the ownership check and filesystem mutation across processes using a PID-owned guard file.
  const guardPath = `${lockPath}.guard`;
  const tempGuard = `${guardPath}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tempGuard, "wx");
  let ownStat: fs.BigIntStats;
  try {
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid })}\n`, "utf8");
    ownStat = fs.fstatSync(fd, { bigint: true });
  } finally {
    fs.closeSync(fd);
  }

  let acquired = false;
  try {
    const deadline = performance.now() + 1000;
    for (;;) {
      try {
        fs.linkSync(tempGuard, guardPath);
        acquired = true;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const owner = readGuardOwner(guardPath);
        if (owner && !isPidAlive(owner.pid) && isCurrentLock(guardPath, owner.stat)) {
          try {
            fs.unlinkSync(guardPath);
          } catch (unlinkErr) {
            if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkErr;
          }
          continue;
        }
        if (performance.now() >= deadline) {
          throw new Error(`Writer lock mutation guard is busy: ${guardPath}`);
        }
        Atomics.wait(mutationWait, 0, 0, 10);
      }
    }
  } finally {
    fs.rmSync(tempGuard, { force: true });
  }

  try {
    return mutate();
  } finally {
    if (acquired && isCurrentLock(guardPath, ownStat)) {
      fs.rmSync(guardPath, { force: true });
    }
  }
}

function withLockTemp<T>(lockPath: string, record: WriterLockRecord, use: (tempPath: string) => T): T {
  const tempPath = `${lockPath}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tempPath, "wx");
  try {
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    return use(tempPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function readWriterLock(lockPath: string): { record: WriterLockRecord; stat: fs.BigIntStats } | null {
  try {
    const fd = fs.openSync(lockPath, "r");
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      const record = JSON.parse(fs.readFileSync(fd, "utf8")) as WriterLockRecord;
      if (
        !record || !Number.isInteger(record.pid) || record.pid <= 0 ||
        (record.pgid !== null && !Number.isInteger(record.pgid)) ||
        typeof record.run_id !== "string" || typeof record.task_id !== "string" ||
        typeof record.cwd !== "string" || typeof record.acquired_at !== "string"
      ) {
        throw new Error("Invalid lock record");
      }
      return { record, stat };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Cannot read writer lock at ${lockPath}`, { cause: err });
  }
}

function isCurrentLock(lockPath: string, expected: fs.BigIntStats): boolean {
  const current = fs.lstatSync(lockPath, { bigint: true, throwIfNoEntry: false });
  return current?.dev === expected.dev && current.ino === expected.ino;
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

  return withLockTemp(lockPath, payload, (tempPath) => withLockMutation(lockPath, () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.linkSync(tempPath, lockPath);
        return { acquired: true, lockPath };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }

      const snapshot = readWriterLock(lockPath);
      if (!snapshot) continue;
      const { record: existing, stat } = snapshot;
      if (isPidAlive(existing.pid) || (existing.pgid !== null && isProcessGroupAlive(existing.pgid))) {
        return { acquired: false, existing, lockPath };
      }
      if (isCurrentLock(lockPath, stat)) {
        fs.unlinkSync(lockPath);
      }
    }
    throw new Error(`Writer lock changed repeatedly at ${lockPath}`);
  }));
}

export function updateWriterLockPid(
  effectiveCwd: string,
  runId: string,
  pid: number,
  pgid: number | null
): void {
  const lockPath = getWriterLockPath(effectiveCwd);
  try {
    withLockMutation(lockPath, () => {
      const snapshot = readWriterLock(lockPath);
      if (snapshot?.record.run_id !== runId) return;
      withLockTemp(lockPath, { ...snapshot.record, pid, pgid }, (tempPath) => {
        if (isCurrentLock(lockPath, snapshot.stat)) fs.renameSync(tempPath, lockPath);
      });
    });
  } catch {
    // best-effort update
  }
}

export function releaseWriterLock(effectiveCwd: string, runId: string): void {
  const lockPath = getWriterLockPath(effectiveCwd);
  try {
    withLockMutation(lockPath, () => {
      const snapshot = readWriterLock(lockPath);
      if (snapshot?.record.run_id === runId && isCurrentLock(lockPath, snapshot.stat)) {
        fs.unlinkSync(lockPath);
      }
    });
  } catch {
    // avoid deleting an unknown lock
  }
}
