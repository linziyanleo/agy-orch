import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureDir, getWorktreesDir } from "./paths.ts";
import type { FileSnapshotEntry, WorkspaceFingerprint } from "./types.ts";

function sha256File(fullPath: string): string | null {
  try {
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(fullPath);
      return crypto.createHash("sha256").update(`SYMLINK:${target}`).digest("hex");
    }
    if (!stat.isFile()) {
      return `NONFILE:${stat.mode}`;
    }
    const buf = fs.readFileSync(fullPath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

function shouldIgnoreRelPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return (
    norm === ".git" ||
    norm.startsWith(".git/") ||
    norm === "node_modules" ||
    norm.startsWith("node_modules/") ||
    norm.includes("/node_modules/")
  );
}

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function walkDirFiles(rootDir: string, currentDir: string, out: string[]): void {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(currentDir, entry.name);
    const rel = path.relative(rootDir, full).replace(/\\/g, "/");
    if (shouldIgnoreRelPath(rel)) continue;
    if (entry.isDirectory()) {
      walkDirFiles(rootDir, full, out);
    } else {
      out.push(rel);
    }
  }
}

function parseGitPorcelainZ(raw: string): Array<{ status: string; path: string; oldPath?: string }> {
  const parts = raw.split("\0");
  const results: Array<{ status: string; path: string; oldPath?: string }> = [];
  let i = 0;
  while (i < parts.length) {
    const token = parts[i];
    i += 1;
    if (!token) continue;
    const status = token.slice(0, 2);
    const filePath = token.slice(3);
    const indexCode = status[0];
    let oldPath: string | undefined;
    if ((indexCode === "R" || indexCode === "C") && i < parts.length) {
      oldPath = parts[i];
      i += 1;
    }
    if (!shouldIgnoreRelPath(filePath)) {
      results.push({ status, path: filePath, oldPath });
    }
  }
  return results;
}

export function computeWorkspaceFingerprint(cwd: string): WorkspaceFingerprint {
  const computed_at = new Date().toISOString();
  const insideGit = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  const entries: Record<string, FileSnapshotEntry> = {};

  if (!insideGit.ok || insideGit.stdout.trim() !== "true") {
    const files: string[] = [];
    if (fs.existsSync(cwd)) {
      walkDirFiles(cwd, cwd, files);
    }
    files.sort();
    for (const rel of files) {
      entries[rel] = {
        status: "FS",
        sha256: sha256File(path.join(cwd, rel)),
      };
    }
    const digest = crypto
      .createHash("sha256")
      .update(JSON.stringify({ is_git: false, head: "NON_GIT", entries }))
      .digest("hex");
    return { digest, is_git: false, head: "NON_GIT", entries, computed_at };
  }

  const headRes = runGit(cwd, ["rev-parse", "HEAD"]);
  const head = headRes.ok ? headRes.stdout.trim() : "UNBORN";

  const statusRes = runGit(cwd, ["status", "--porcelain=v1", "-z", "-uall"]);
  const parsed = statusRes.ok ? parseGitPorcelainZ(statusRes.stdout) : [];
  parsed.sort((a, b) => a.path.localeCompare(b.path));

  for (const item of parsed) {
    const full = path.join(cwd, item.path);
    const hash = fs.existsSync(full) ? sha256File(full) : null;
    entries[item.path] = {
      status: item.status,
      sha256: hash,
    };
  }

  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify({ is_git: true, head, entries }))
    .digest("hex");

  return { digest, is_git: true, head, entries, computed_at };
}

export function diffFingerprints(
  pre: WorkspaceFingerprint,
  post: WorkspaceFingerprint,
  cwd: string
): string[] {
  const changed = new Set<string>();

  const allPaths = new Set([...Object.keys(pre.entries), ...Object.keys(post.entries)]);
  for (const rel of allPaths) {
    const a = pre.entries[rel];
    const b = post.entries[rel];
    if (!a || !b) {
      changed.add(rel);
      continue;
    }
    if (a.sha256 !== b.sha256 || a.status !== b.status) {
      changed.add(rel);
    }
  }

  if (pre.is_git && post.is_git && pre.head !== post.head) {
    if (pre.head !== "UNBORN" && post.head !== "UNBORN") {
      const diffRes = runGit(cwd, ["diff", "--name-only", pre.head, post.head]);
      if (diffRes.ok) {
        for (const line of diffRes.stdout.split("\n")) {
          const p = line.trim();
          if (p && !shouldIgnoreRelPath(p)) changed.add(p);
        }
      }
    } else if (post.head !== "UNBORN") {
      const showRes = runGit(cwd, ["ls-tree", "-r", "--name-only", post.head]);
      if (showRes.ok) {
        for (const line of showRes.stdout.split("\n")) {
          const p = line.trim();
          if (p && !shouldIgnoreRelPath(p)) changed.add(p);
        }
      }
    }
  }

  return Array.from(changed).sort();
}

function globToRegex(pattern: string): RegExp {
  const norm = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  let regexStr = "^";
  let i = 0;
  while (i < norm.length) {
    const ch = norm[i];
    if (ch === "*") {
      if (norm[i + 1] === "*") {
        if (norm[i + 2] === "/") {
          regexStr += "(?:.*/)?";
          i += 3;
          continue;
        }
        regexStr += ".*";
        i += 2;
        continue;
      }
      regexStr += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      regexStr += "[^/]";
      i += 1;
      continue;
    }
    if ("\\^$.|+()[]{}".includes(ch)) {
      regexStr += `\\${ch}`;
    } else {
      regexStr += ch;
    }
    i += 1;
  }
  regexStr += "$";
  return new RegExp(regexStr);
}

export function isPathAllowed(filePath: string, allowedPatterns: string[]): boolean {
  const normFile = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const rawPattern of allowedPatterns) {
    const pattern = rawPattern.replace(/\\/g, "/").replace(/^\.\//, "").trim();
    if (!pattern) continue;
    const cleanDir = pattern.replace(/\/+$/, "");
    if (!pattern.includes("*") && !pattern.includes("?")) {
      if (normFile === cleanDir || normFile.startsWith(`${cleanDir}/`)) {
        return true;
      }
      continue;
    }
    if (globToRegex(pattern).test(normFile)) {
      return true;
    }
  }
  return false;
}

export function findBoundaryViolations(
  changedFiles: string[],
  allowedPatterns: string[]
): string[] {
  return changedFiles.filter((file) => !isPathAllowed(file, allowedPatterns));
}

export function createIsolatedWorktree(
  baseCwd: string,
  runId: string
): { ok: true; worktreePath: string } | { ok: false; error: string } {
  const wtRoot = getWorktreesDir();
  ensureDir(wtRoot);
  const worktreePath = path.join(wtRoot, runId);
  try {
    execFileSync("git", ["-C", baseCwd, "worktree", "add", "--detach", worktreePath, "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, worktreePath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export function removeIsolatedWorktree(baseCwd: string, worktreePath: string): void {
  try {
    execFileSync("git", ["-C", baseCwd, "worktree", "remove", "--force", worktreePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // keep cleanup best-effort
  }
}
