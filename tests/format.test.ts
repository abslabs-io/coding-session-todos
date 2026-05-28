import { describe, expect, test } from "vitest";

import {
  currentPosition,
  escMd,
  relativeTime,
  sameEntries,
  sameState,
  sameTodos,
  timeAgoMs,
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

describe("sameEntries", () => {
  function entry(overrides: Partial<SessionEntry> & { file: string }): SessionEntry {
    return {
      session: { sessionFile: overrides.file, cwd: "/code/x", mtimeMs: 1 },
      snapshot: overrides.snapshot ?? null,
      title: overrides.title ?? null,
      state: overrides.state ?? { state: "idle" },
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

  test("differing mtime alone is NOT a change (only file/title/todos/state)", () => {
    const a: SessionEntry[] = [
      {
        session: { sessionFile: "a", cwd: "/x", mtimeMs: 1 },
        snapshot: null,
        title: "t",
        state: { state: "idle" },
      },
    ];
    const b: SessionEntry[] = [
      {
        session: { sessionFile: "a", cwd: "/x", mtimeMs: 999 },
        snapshot: null,
        title: "t",
        state: { state: "idle" },
      },
    ];
    expect(sameEntries(a, b)).toBe(true);
  });
});
