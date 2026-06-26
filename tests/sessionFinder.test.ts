import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  findActiveSessions,
  findProjectDir,
  projectDirFor,
  projectsRoot,
  readTail,
} from "../src/sessionFinder";

let tempHome: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;

beforeEach(async () => {
  tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "coding-session-todos-test-"));
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  await fs.promises.rm(tempHome, { recursive: true, force: true });
});

async function writeJsonl(file: string, lines: unknown[]): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

async function setMtime(file: string, mtimeMs: number): Promise<void> {
  const t = mtimeMs / 1000;
  await fs.promises.utimes(file, t, t);
}

describe("projectDirFor", () => {
  test("encodes / as -", () => {
    expect(projectDirFor("/home/user/code/app")).toBe(
      path.join(projectsRoot(), "-home-user-code-app"),
    );
  });

  test("encodes _ as - (newer Claude Code versions)", () => {
    expect(projectDirFor("/home/user/code/my_app")).toBe(
      path.join(projectsRoot(), "-home-user-code-my-app"),
    );
  });

  test("handles cwd with mixed / and _", () => {
    expect(projectDirFor("/srv/some_repo/app_dir")).toBe(
      path.join(projectsRoot(), "-srv-some-repo-app-dir"),
    );
  });
});

describe("readTail", () => {
  test("returns the full content when the file is smaller than maxBytes", async () => {
    const file = path.join(tempHome, "small.jsonl");
    await fs.promises.writeFile(file, "line1\nline2\n");
    expect(await readTail(file, 1024)).toBe("line1\nline2\n");
  });

  test("drops the partial first line when the file exceeds maxBytes", async () => {
    const file = path.join(tempHome, "big.jsonl");
    const padding = "x".repeat(90);
    const lines = Array.from(
      { length: 20 },
      (_, i) => `line${i.toString().padStart(2, "0")}-${padding}`,
    );
    await fs.promises.writeFile(file, lines.join("\n") + "\n");

    const tail = await readTail(file, 500);
    // Tail must start at a line boundary — never mid-line.
    expect(tail.startsWith("line")).toBe(true);
    // Final newline preserved.
    expect(tail.endsWith("\n")).toBe(true);
    // Only the trailing lines survive (well under 20).
    const tailLines = tail.trim().split("\n");
    expect(tailLines.length).toBeLessThan(20);
    expect(tailLines.length).toBeGreaterThan(0);
    // Last line of the file is preserved verbatim.
    expect(tailLines[tailLines.length - 1]).toBe(lines[lines.length - 1]);
  });
});

describe("findProjectDir", () => {
  test("returns the encoded fast-path when its latest transcript cwd matches", async () => {
    const cwd = "/some/code/dir";
    const projectDir = projectDirFor(cwd);
    await writeJsonl(path.join(projectDir, "abc.jsonl"), [{ cwd }]);
    expect(await findProjectDir(cwd)).toBe(projectDir);
  });

  test("scans other dirs when the fast-path collides with a different cwd", async () => {
    const cwd = "/home/user/code/my_app";
    const collidingDir = projectDirFor(cwd); // same encoding as /home/user/code/my/app
    await writeJsonl(path.join(collidingDir, "wrong.jsonl"), [{ cwd: "/home/user/code/my/app" }]);

    const realDir = path.join(projectsRoot(), "alt-encoding-for-my-app");
    await writeJsonl(path.join(realDir, "right.jsonl"), [{ cwd }]);

    expect(await findProjectDir(cwd)).toBe(realDir);
  });

  test("skips initial metadata lines without cwd to find the first real cwd", async () => {
    const cwd = "/some/code/dir";
    const projectDir = projectDirFor(cwd);
    await writeJsonl(path.join(projectDir, "abc.jsonl"), [
      { type: "queue-operation" },
      { type: "queue-operation" },
      { cwd, type: "user" },
    ]);
    expect(await findProjectDir(cwd)).toBe(projectDir);
  });

  test("matches the workspace by the transcript's latest cwd after a rename", async () => {
    // A session that started under the old folder name, then the folder was
    // renamed: later lines carry the new cwd. Matching must follow the latest.
    const oldCwd = "/code/old-name";
    const newCwd = "/code/new-name";
    const dir = path.join(projectsRoot(), "renamed-project");
    await writeJsonl(path.join(dir, "s.jsonl"), [
      { cwd: oldCwd, type: "user" },
      { cwd: oldCwd, type: "assistant" },
      { cwd: newCwd, type: "user" },
      { cwd: newCwd, type: "assistant" },
    ]);
    expect(await findProjectDir(newCwd)).toBe(dir);
    // The old (now-gone) path must no longer resolve to the session.
    expect(await findProjectDir(oldCwd)).toBeNull();
  });

  test("returns null when no matching transcript dir exists", async () => {
    await fs.promises.mkdir(projectsRoot(), { recursive: true });
    expect(await findProjectDir("/nonexistent")).toBeNull();
  });

  test("returns null when projects root itself doesn't exist", async () => {
    expect(await findProjectDir("/anywhere")).toBeNull();
  });
});

describe("findActiveSessions", () => {
  test("returns transcripts touched within maxAgeMs, skipping stale ones", async () => {
    const cwd = "/code/active";
    const projectDir = projectDirFor(cwd);
    const recent = path.join(projectDir, "recent.jsonl");
    const stale = path.join(projectDir, "stale.jsonl");
    await writeJsonl(recent, [{ cwd }]);
    await writeJsonl(stale, [{ cwd }]);
    await setMtime(stale, Date.now() - 60 * 60_000);

    const sessions = await findActiveSessions(5 * 60_000);
    expect(sessions.map((s) => s.sessionFile)).toEqual([recent]);
  });

  test("returns multiple sessions in the same workspace folder", async () => {
    const cwd = "/code/multi";
    const projectDir = projectDirFor(cwd);
    await writeJsonl(path.join(projectDir, "a.jsonl"), [{ cwd }]);
    await writeJsonl(path.join(projectDir, "b.jsonl"), [{ cwd }]);

    const sessions = await findActiveSessions(60 * 60_000);
    expect(sessions.length).toBe(2);
  });

  test("sorts results by mtime descending", async () => {
    const cwd = "/code/sort";
    const projectDir = projectDirFor(cwd);
    const older = path.join(projectDir, "older.jsonl");
    const newer = path.join(projectDir, "newer.jsonl");
    await writeJsonl(older, [{ cwd }]);
    await writeJsonl(newer, [{ cwd }]);
    await setMtime(older, Date.now() - 60_000);

    const sessions = await findActiveSessions(60 * 60_000);
    expect(sessions[0].sessionFile).toBe(newer);
    expect(sessions[1].sessionFile).toBe(older);
  });

  test("returns [] when projects root doesn't exist", async () => {
    expect(await findActiveSessions(60_000)).toEqual([]);
  });

  test("ignores non-jsonl files and directories without transcripts", async () => {
    const cwd = "/code/clean";
    const projectDir = projectDirFor(cwd);
    await writeJsonl(path.join(projectDir, "real.jsonl"), [{ cwd }]);
    await fs.promises.writeFile(path.join(projectDir, "notes.txt"), "ignore me");
    const emptyDir = path.join(projectsRoot(), "empty-project");
    await fs.promises.mkdir(emptyDir, { recursive: true });

    const sessions = await findActiveSessions(60 * 60_000);
    expect(sessions.map((s) => path.basename(s.sessionFile))).toEqual(["real.jsonl"]);
  });

  test("skips transcripts whose head has no cwd field", async () => {
    const headless = path.join(projectsRoot(), "weird", "no-cwd.jsonl");
    await writeJsonl(headless, [{ type: "queue-operation" }, { type: "user" }]);

    expect(await findActiveSessions(60 * 60_000)).toEqual([]);
  });

  test("reports a session at its latest cwd, not the first (mid-session rename)", async () => {
    const oldCwd = "/code/old-name";
    const newCwd = "/code/new-name";
    const dir = path.join(projectsRoot(), "some-project");
    await writeJsonl(path.join(dir, "s.jsonl"), [
      { cwd: oldCwd, type: "user" },
      { cwd: newCwd, type: "user" },
    ]);

    const sessions = await findActiveSessions(60 * 60_000);
    expect(sessions.map((s) => s.cwd)).toEqual([newCwd]);
  });

  test("ignores transient scratchpad (temp-dir) cwd excursions", async () => {
    // The agent harness records short cwd excursions into a scratchpad under the
    // OS temp dir; reading the literal latest cwd would latch onto it and the
    // session would stop matching its workspace. The workspace cwd must win.
    const workspace = "/code/app";
    const scratchpad = path.join(os.tmpdir(), "claude", "sess-1", "scratchpad");
    const dir = path.join(projectsRoot(), "app-project");
    await writeJsonl(path.join(dir, "s.jsonl"), [
      { cwd: workspace, type: "user" },
      { cwd: workspace, type: "assistant" },
      { cwd: scratchpad, type: "user" }, // excursion is the literal latest line
    ]);

    const sessions = await findActiveSessions(60 * 60_000);
    expect(sessions.map((s) => s.cwd)).toEqual([workspace]);
    // And it must still resolve to its project dir for the single-session path.
    expect(await findProjectDir(workspace)).toBe(dir);
  });

  test("skips a transcript whose only cwd values are temp-dir excursions", async () => {
    const scratchpad = path.join(os.tmpdir(), "claude", "sess-2", "scratchpad");
    const dir = path.join(projectsRoot(), "temp-only");
    await writeJsonl(path.join(dir, "s.jsonl"), [{ cwd: scratchpad, type: "user" }]);

    expect(await findActiveSessions(60 * 60_000)).toEqual([]);
  });
});
