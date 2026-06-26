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

// Claude Code records a cwd on each message line. It's usually constant, but it
// CAN change mid-session — most notably when the project folder is renamed while
// a session is open: the OS resolves the running process's cwd to the new path,
// and subsequent lines record the new value. So we read the LATEST cwd (scanning
// from the tail), not the first, so a session matches where it currently lives
// rather than where it started. Cache is keyed on file size: a static (inactive)
// transcript stays cached, while a growing (active) one re-reads, picking up a
// cwd change without an extension reload. Misses are left uncached so the next
// pass retries once the head/tail has flushed a cwd line.
const cwdCache = new Map<string, { size: number; cwd: string }>();

// True when `cwd` sits inside the OS temp dir. The agent harness records
// transient cwd excursions into an ephemeral scratchpad under os.tmpdir()
// (e.g. /tmp/.../scratchpad); those are never the session's workspace folder.
// Skipping them keeps "latest cwd" from latching onto a scratchpad excursion and
// collapsing the status bar to a bare icon mid-session. A real workspace under
// the temp dir is vanishingly rare, so excluding the whole subtree is safe.
function isTempCwd(cwd: string): boolean {
  const tmp = os.tmpdir();
  return cwd === tmp || cwd.startsWith(tmp + path.sep);
}

// Scans JSONL text for a top-level string `cwd`, ignoring temp-dir excursions
// (see isTempCwd). With fromEnd, walks lines in reverse to return the most recent
// qualifying value; otherwise the first. Returns null if no line parses a
// non-temp cwd.
function scanForCwd(text: string, fromEnd: boolean): string | null {
  const lines = text.split("\n");
  for (let k = 0; k < lines.length; k++) {
    const line = lines[fromEnd ? lines.length - 1 - k : k];
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as { cwd?: unknown };
      if (typeof obj.cwd === "string" && !isTempCwd(obj.cwd)) return obj.cwd;
    } catch {
      // partial / non-JSON line; keep scanning
    }
  }
  return null;
}

// Returns the transcript's current cwd: the latest value within the tail window,
// falling back to the earliest value in the head when the tail holds no parseable
// cwd (e.g. the final message is a single line larger than the window). Caching:
// see cwdCache above.
async function transcriptCwd(filePath: string, windowBytes = 64 * 1024): Promise<string | null> {
  let size: number;
  try {
    size = (await fs.promises.stat(filePath)).size;
  } catch {
    return null;
  }
  const cached = cwdCache.get(filePath);
  if (cached && cached.size === size) return cached.cwd;

  const fh = await fs.promises.open(filePath, "r");
  try {
    // Tail window: holds the latest cwd unless the final line is enormous.
    const start = Math.max(0, size - windowBytes);
    const tailBuf = Buffer.alloc(size - start);
    await fh.read(tailBuf, 0, tailBuf.length, start);
    let tailText = tailBuf.toString("utf8");
    if (start > 0) {
      // Drop the partial first line so we never parse truncated JSON.
      const nl = tailText.indexOf("\n");
      tailText = nl >= 0 ? tailText.slice(nl + 1) : "";
    }
    let cwd = scanForCwd(tailText, true);

    // Fallback to the head's first cwd when the tail window held none, so a
    // session is never dropped just because its last message is huge.
    if (cwd === null && start > 0) {
      const headBuf = Buffer.alloc(Math.min(windowBytes, size));
      await fh.read(headBuf, 0, headBuf.length, 0);
      cwd = scanForCwd(headBuf.toString("utf8"), false);
    }

    if (cwd !== null) cwdCache.set(filePath, { size, cwd });
    return cwd;
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
