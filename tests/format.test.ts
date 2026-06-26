import { describe, expect, test } from "vitest";

import {
  contextLabel,
  contextPercent,
  currentPosition,
  escMd,
  isWithinWorkspace,
  relativeTime,
  sameEntries,
  sameState,
  sameTodos,
  selectWindowSession,
  timeAgoMs,
  windowForModel,
  type SessionEntry,
} from "../src/format";
import type { SessionStateInfo, Todo } from "../src/parser";

describe("currentPosition", () => {
  test("returns 0/0 for empty list", () => {
    expect(currentPosition([])).toEqual({ current: 0, total: 0 });
  });

  test("returns the index+1 of the in_progress todo when one exists", () => {
    const todos: Todo[] = [
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "pending" },
    ];
    expect(currentPosition(todos)).toEqual({ current: 2, total: 3 });
  });

  test("falls back to completed+1 when nothing is in_progress", () => {
    const todos: Todo[] = [
      { content: "a", status: "completed" },
      { content: "b", status: "completed" },
      { content: "c", status: "pending" },
    ];
    expect(currentPosition(todos)).toEqual({ current: 3, total: 3 });
  });

  test("clamps current to total when all are completed", () => {
    const todos: Todo[] = [
      { content: "a", status: "completed" },
      { content: "b", status: "completed" },
    ];
    expect(currentPosition(todos)).toEqual({ current: 2, total: 2 });
  });

  test("returns 1/N when none have started", () => {
    const todos: Todo[] = [
      { content: "a", status: "pending" },
      { content: "b", status: "pending" },
    ];
    expect(currentPosition(todos)).toEqual({ current: 1, total: 2 });
  });
});

describe("isWithinWorkspace", () => {
  test("a session sitting exactly at the workspace folder is within it", () => {
    expect(isWithinWorkspace("/code/app", "/code/app")).toBe(true);
  });

  test("a session in a subdirectory is within the workspace", () => {
    expect(isWithinWorkspace("/code/app/packages/api", "/code/app")).toBe(true);
  });

  test("a sibling directory is not within the workspace (no string-prefix false positives)", () => {
    // "/code/app2" must NOT match workspace "/code/app".
    expect(isWithinWorkspace("/code/app2", "/code/app")).toBe(false);
  });

  test("an ancestor directory is not within the workspace", () => {
    expect(isWithinWorkspace("/code", "/code/app")).toBe(false);
  });

  test("an unrelated path is not within the workspace", () => {
    expect(isWithinWorkspace("/other/place", "/code/app")).toBe(false);
  });

  test("empty root or cwd is never within", () => {
    expect(isWithinWorkspace("/code/app", "")).toBe(false);
    expect(isWithinWorkspace("", "/code/app")).toBe(false);
  });

  test("a trailing slash on either side still matches the same directory", () => {
    expect(isWithinWorkspace("/code/app", "/code/app/")).toBe(true);
    expect(isWithinWorkspace("/code/app/", "/code/app")).toBe(true);
  });

  test("a deeply nested subdirectory is within the workspace", () => {
    expect(isWithinWorkspace("/code/app/a/b/c/d", "/code/app")).toBe(true);
  });

  test("the filesystem root as workspace contains everything", () => {
    expect(isWithinWorkspace("/code/app", "/")).toBe(true);
  });
});

describe("selectWindowSession", () => {
  function entry(file: string, cwd: string, mtimeMs: number): SessionEntry {
    return {
      session: { sessionFile: file, cwd, mtimeMs },
      snapshot: null,
      title: null,
      state: { state: "idle" },
      context: null,
    };
  }

  const ROOT = "/code/app";

  test("returns null when there are no sessions at all", () => {
    expect(selectWindowSession([], [ROOT])).toBeNull();
    expect(selectWindowSession([], [])).toBeNull();
  });

  test("prefers the exact workspace-cwd session", () => {
    const exact = entry("exact", ROOT, 5);
    expect(selectWindowSession([exact], [ROOT])).toBe(exact);
  });

  test("prefers the exact match even when a nested session is more recent", () => {
    // entries are sorted most-recent-first by the provider; the nested session
    // is newer, but the session sitting exactly at the workspace wins.
    const nested = entry("nested", "/code/app/sub", 9);
    const exact = entry("exact", ROOT, 2);
    expect(selectWindowSession([nested, exact], [ROOT])).toBe(exact);
  });

  test("falls back to the most recent session within the workspace", () => {
    // No exact match; the first within-workspace entry wins (newest first).
    const newerSub = entry("newer", "/code/app/api", 9);
    const olderSub = entry("older", "/code/app/web", 4);
    expect(selectWindowSession([newerSub, olderSub], [ROOT])).toBe(newerSub);
  });

  test("ignores sessions outside the workspace when a folder is open", () => {
    const sibling = entry("sibling", "/code/app2", 9);
    const other = entry("other", "/elsewhere", 8);
    expect(selectWindowSession([sibling, other], [ROOT])).toBeNull();
  });

  test("picks the in-workspace session when out-of-workspace sessions are more recent", () => {
    const recentOutsider = entry("outsider", "/elsewhere", 9);
    const inside = entry("inside", "/code/app/pkg", 3);
    expect(selectWindowSession([recentOutsider, inside], [ROOT])).toBe(inside);
  });

  test("multi-root: matches a session sitting at the second workspace folder", () => {
    // The single-folder assumption (workspaceFolders[0]) used to miss this.
    const inSecond = entry("second", "/code/api", 9);
    const roots = ["/code/app", "/code/api"];
    expect(selectWindowSession([inSecond], roots)).toBe(inSecond);
  });

  test("multi-root: matches a session nested inside any workspace folder", () => {
    const nested = entry("nested", "/code/api/pkg", 7);
    const roots = ["/code/app", "/code/api"];
    expect(selectWindowSession([nested], roots)).toBe(nested);
  });

  test("multi-root: an exact root match beats a nested match in another root", () => {
    const nestedNewer = entry("nested", "/code/app/sub", 9);
    const exactSecond = entry("exact", "/code/api", 3);
    const roots = ["/code/app", "/code/api"];
    expect(selectWindowSession([nestedNewer, exactSecond], roots)).toBe(exactSecond);
  });

  test("no folder open: reflects the most recent active session anywhere", () => {
    // An empty/single-file window has no workspace to scope to, so the widget
    // shows the most recently active session rather than collapsing to an icon.
    const newest = entry("newest", "/elsewhere", 9);
    const older = entry("older", "/code/app", 4);
    expect(selectWindowSession([newest, older], [])).toBe(newest);
  });
});

describe("timeAgoMs", () => {
  test("renders sub-minute deltas as 'just now'", () => {
    expect(timeAgoMs(0)).toBe("just now");
    expect(timeAgoMs(59_999)).toBe("just now");
  });

  test("negative diffs (future timestamps) render as 'just now'", () => {
    expect(timeAgoMs(-5_000)).toBe("just now");
  });

  test("renders minutes for < 1h", () => {
    expect(timeAgoMs(60_000)).toBe("1m ago");
    expect(timeAgoMs(59 * 60_000)).toBe("59m ago");
  });

  test("renders hours for < 1d", () => {
    expect(timeAgoMs(60 * 60_000)).toBe("1h ago");
    expect(timeAgoMs(23 * 60 * 60_000)).toBe("23h ago");
  });

  test("renders days otherwise", () => {
    expect(timeAgoMs(24 * 60 * 60_000)).toBe("1d ago");
    expect(timeAgoMs(7 * 24 * 60 * 60_000)).toBe("7d ago");
  });
});

describe("relativeTime", () => {
  test("returns '' for empty and unparseable inputs", () => {
    expect(relativeTime("")).toBe("");
    expect(relativeTime("not a date")).toBe("");
  });

  test("parses ISO timestamps into time-ago strings", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(relativeTime(fiveMinAgo)).toBe("5m ago");
  });
});

describe("escMd", () => {
  test("escapes markdown metacharacters", () => {
    expect(escMd("a*b_c")).toBe("a\\*b\\_c");
    expect(escMd("[link](url)")).toBe("\\[link\\]\\(url\\)");
    expect(escMd("a\\b")).toBe("a\\\\b");
  });

  test("leaves plain text alone", () => {
    expect(escMd("hello world 123")).toBe("hello world 123");
  });
});

describe("sameTodos", () => {
  test("two undefined lists are equal", () => {
    expect(sameTodos(undefined, undefined)).toBe(true);
  });

  test("undefined and empty are equal", () => {
    expect(sameTodos(undefined, [])).toBe(true);
  });

  test("different lengths are unequal", () => {
    expect(sameTodos([{ content: "a", status: "pending" }], [])).toBe(false);
  });

  test("same content + status pairs are equal (activeForm ignored)", () => {
    const a: Todo[] = [{ content: "x", status: "in_progress", activeForm: "doing x" }];
    const b: Todo[] = [{ content: "x", status: "in_progress" }];
    expect(sameTodos(a, b)).toBe(true);
  });

  test("differing status is unequal", () => {
    const a: Todo[] = [{ content: "x", status: "pending" }];
    const b: Todo[] = [{ content: "x", status: "completed" }];
    expect(sameTodos(a, b)).toBe(false);
  });

  test("differing content is unequal", () => {
    const a: Todo[] = [{ content: "x", status: "pending" }];
    const b: Todo[] = [{ content: "y", status: "pending" }];
    expect(sameTodos(a, b)).toBe(false);
  });
});

describe("sameState", () => {
  test("identical state + pendingTool match", () => {
    const a: SessionStateInfo = { state: "active", pendingTool: "Bash" };
    const b: SessionStateInfo = { state: "active", pendingTool: "Bash" };
    expect(sameState(a, b)).toBe(true);
  });

  test("missing pendingTool on both sides matches", () => {
    expect(sameState({ state: "idle" }, { state: "idle" })).toBe(true);
  });

  test("different state values are unequal", () => {
    expect(sameState({ state: "active" }, { state: "waiting" })).toBe(false);
  });

  test("different pendingTool values are unequal", () => {
    const a: SessionStateInfo = { state: "active", pendingTool: "Read" };
    const b: SessionStateInfo = { state: "active", pendingTool: "Bash" };
    expect(sameState(a, b)).toBe(false);
  });
});

describe("windowForModel", () => {
  test("opus models map to the 1M window (4.7 and 4.8 ship 1M in Claude Code)", () => {
    expect(windowForModel("claude-opus-4-8")).toBe(1_000_000);
    expect(windowForModel("claude-opus-4-7")).toBe(1_000_000);
    expect(windowForModel("opus")).toBe(1_000_000);
  });

  test("matching is case-insensitive", () => {
    expect(windowForModel("CLAUDE-OPUS-4-8")).toBe(1_000_000);
    expect(windowForModel("Opus")).toBe(1_000_000);
  });

  test("sonnet and haiku map to 200k", () => {
    expect(windowForModel("claude-sonnet-4-6")).toBe(200_000);
    expect(windowForModel("claude-haiku-4-5")).toBe(200_000);
  });

  test("null and unknown models default to 200k (conservative)", () => {
    expect(windowForModel(null)).toBe(200_000);
    expect(windowForModel("some-future-model")).toBe(200_000);
  });
});

describe("contextPercent", () => {
  test("returns null for null context", () => {
    expect(contextPercent(null)).toBeNull();
  });

  test("rounds used/window to an integer percent", () => {
    // 43,704 / 200,000 = 21.852 → 22
    expect(contextPercent({ usedTokens: 43_704, model: "claude-sonnet-4-6" })).toBe(22);
  });

  test("uses the 1M window for opus", () => {
    // 334,618 / 1,000,000 = 33.46 → 33
    expect(contextPercent({ usedTokens: 334_618, model: "claude-opus-4-8" })).toBe(33);
  });

  test("clamps to 100 when usage exceeds the window", () => {
    expect(contextPercent({ usedTokens: 250_000, model: "claude-sonnet-4-6" })).toBe(100);
  });

  test("reports 100 at exactly the window boundary", () => {
    expect(contextPercent({ usedTokens: 200_000, model: "claude-sonnet-4-6" })).toBe(100);
  });

  test("floors small usage to 0", () => {
    expect(contextPercent({ usedTokens: 100, model: "claude-sonnet-4-6" })).toBe(0);
  });
});

describe("contextLabel", () => {
  test("returns '' for null context", () => {
    expect(contextLabel(null)).toBe("");
  });

  test("formats the percent with a ' ctx' suffix", () => {
    expect(contextLabel({ usedTokens: 43_704, model: "claude-sonnet-4-6" })).toBe("22% ctx");
  });

  test("uses the 1M window for opus", () => {
    expect(contextLabel({ usedTokens: 334_618, model: "claude-opus-4-8" })).toBe("33% ctx");
  });
});

describe("sameEntries", () => {
  function entry(overrides: Partial<SessionEntry> & { file: string }): SessionEntry {
    return {
      session: { sessionFile: overrides.file, cwd: "/code/x", mtimeMs: 1 },
      snapshot: overrides.snapshot ?? null,
      title: overrides.title ?? null,
      state: overrides.state ?? { state: "idle" },
      context: overrides.context ?? null,
    };
  }

  test("two empty lists are equal", () => {
    expect(sameEntries([], [])).toBe(true);
  });

  test("different lengths are unequal", () => {
    expect(sameEntries([entry({ file: "a" })], [])).toBe(false);
  });

  test("reordered sessions are unequal (order matters for the view)", () => {
    const a = [entry({ file: "a" }), entry({ file: "b" })];
    const b = [entry({ file: "b" }), entry({ file: "a" })];
    expect(sameEntries(a, b)).toBe(false);
  });

  test("title changes register as unequal", () => {
    const a = [entry({ file: "a", title: "old" })];
    const b = [entry({ file: "a", title: "new" })];
    expect(sameEntries(a, b)).toBe(false);
  });

  test("state changes register as unequal", () => {
    const a = [entry({ file: "a", state: { state: "idle" } })];
    const b = [entry({ file: "a", state: { state: "active" } })];
    expect(sameEntries(a, b)).toBe(false);
  });

  test("snapshot todo changes register as unequal", () => {
    const a = [
      entry({
        file: "a",
        snapshot: { todos: [{ content: "x", status: "pending" }] },
      }),
    ];
    const b = [
      entry({
        file: "a",
        snapshot: { todos: [{ content: "x", status: "completed" }] },
      }),
    ];
    expect(sameEntries(a, b)).toBe(false);
  });

  test("differing mtime alone is NOT a change (only file/title/todos/state/ctx%)", () => {
    const a: SessionEntry[] = [
      {
        session: { sessionFile: "a", cwd: "/x", mtimeMs: 1 },
        snapshot: null,
        title: "t",
        state: { state: "idle" },
        context: null,
      },
    ];
    const b: SessionEntry[] = [
      {
        session: { sessionFile: "a", cwd: "/x", mtimeMs: 999 },
        snapshot: null,
        title: "t",
        state: { state: "idle" },
        context: null,
      },
    ];
    expect(sameEntries(a, b)).toBe(true);
  });

  test("gaining a context reading (null → value) registers as unequal", () => {
    const a = [entry({ file: "a", context: null })];
    const b = [entry({ file: "a", context: { usedTokens: 60_000, model: "claude-sonnet-4-6" } })];
    expect(sameEntries(a, b)).toBe(false);
  });

  test("a change in the displayed context % registers as unequal", () => {
    const a = [entry({ file: "a", context: { usedTokens: 44_000, model: "claude-sonnet-4-6" } })];
    const b = [entry({ file: "a", context: { usedTokens: 60_000, model: "claude-sonnet-4-6" } })];
    expect(sameEntries(a, b)).toBe(false); // 22% vs 30%
  });

  test("token drift that rounds to the same % is NOT a change", () => {
    const a = [entry({ file: "a", context: { usedTokens: 43_000, model: "claude-sonnet-4-6" } })];
    const b = [entry({ file: "a", context: { usedTokens: 43_800, model: "claude-sonnet-4-6" } })];
    expect(sameEntries(a, b)).toBe(true); // both round to 22%
  });
});
