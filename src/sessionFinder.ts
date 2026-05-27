import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Claude Code encodes a project's cwd into a folder name under
// ~/.claude/projects/, but the encoding has shifted across versions
// (originally just "/" → "-"; newer versions also replace "_").
// Rather than guess, we read the cwd field that Claude Code writes
// into every transcript line and match against the workspace cwd.

export function projectsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

// Best-effort guess for fast path / dir watching. Not authoritative —
// callers must verify by inspecting transcript cwd.
export function projectDirFor(cwd: string): string {
  const encoded = cwd.replace(/[/_]/g, "-");
  return path.join(projectsRoot(), encoded);
}

async function latestJsonlIn(dir: string): Promise<string | null> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { path: string; mtimeMs: number } | null = null;
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const p = path.join(dir, e.name);
    try {
      const stat = await fs.promises.stat(p);
      if (!best || stat.mtimeMs > best.mtimeMs) {
        best = { path: p, mtimeMs: stat.mtimeMs };
      }
    } catch {
      // skip unreadable
    }
  }
  return best?.path ?? null;
}

// Reads the head of a transcript file and returns the first cwd field
// it finds. Early lines are often `queue-operation` metadata without a
// cwd, so we scan up to maxLines forward.
async function transcriptCwd(filePath: string, maxLines = 50): Promise<string | null> {
  const fh = await fs.promises.open(filePath, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.slice(0, bytesRead).toString("utf8");
    const lines = text.split("\n");
    const limit = Math.min(lines.length, maxLines);
    for (let i = 0; i < limit; i++) {
      const line = lines[i];
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as { cwd?: unknown };
        if (typeof obj.cwd === "string") return obj.cwd;
      } catch {
        // partial / non-JSON line; keep going
      }
    }
    return null;
  } finally {
    await fh.close();
  }
}

// Locates the project transcript dir matching a workspace cwd. Tries the
// encoded fast-path first; on miss, scans ~/.claude/projects/* and reads
// the cwd field from each dir's latest transcript.
export async function findProjectDir(cwd: string): Promise<string | null> {
  const guess = projectDirFor(cwd);
  const guessLatest = await latestJsonlIn(guess);
  if (guessLatest && (await transcriptCwd(guessLatest)) === cwd) return guess;

  const root = projectsRoot();
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    if (dir === guess) continue;
    const latest = await latestJsonlIn(dir);
    if (!latest) continue;
    if ((await transcriptCwd(latest)) === cwd) return dir;
  }
  return null;
}

export async function findActiveSessionFile(cwd: string): Promise<string | null> {
  const dir = await findProjectDir(cwd);
  return dir ? latestJsonlIn(dir) : null;
}

export interface ActiveSession {
  sessionFile: string;
  cwd: string;
  mtimeMs: number;
}

// Returns every transcript across all project dirs whose mtime is
// within maxAgeMs. Multiple sessions in the same workspace folder each
// get their own entry (one transcript file per session UUID).
export async function findActiveSessions(maxAgeMs: number): Promise<ActiveSession[]> {
  const root = projectsRoot();
  let dirs: fs.Dirent[];
  try {
    dirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const now = Date.now();
  const results: ActiveSession[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let files: fs.Dirent[];
    try {
      files = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const filePath = path.join(dir, f.name);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs > maxAgeMs) continue;
      const sessionCwd = await transcriptCwd(filePath);
      if (!sessionCwd) continue;
      results.push({ sessionFile: filePath, cwd: sessionCwd, mtimeMs: stat.mtimeMs });
    }
  }
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

// Reads only the trailing region of a file as UTF-8. The latest TodoWrite
// is almost always in the last MB; reading the full transcript (which can
// exceed 20MB) on every change would be wasteful.
export async function readTail(filePath: string, maxBytes = 1024 * 1024): Promise<string> {
  const stat = await fs.promises.stat(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const fh = await fs.promises.open(filePath, "r");
  try {
    const length = stat.size - start;
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      // Drop the partial first line so the parser doesn't see truncated JSON.
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return text;
  } finally {
    await fh.close();
  }
}
