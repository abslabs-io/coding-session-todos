import { describe, expect, test } from "vitest";

import {
  findLatestTitle,
  findLatestTodos,
  findSessionState,
  type Todo,
} from "../src/parser";
import {
  aiTitleLine,
  assistantToolUseLine,
  jsonl,
  todoWriteLine,
  toolResultLine,
  userTextLine,
} from "./helpers/jsonl";

const NOW = 1_700_000_000_000;

describe("findLatestTodos", () => {
  test("returns null when no TodoWrite line exists", () => {
    const text = jsonl(userTextLine("hi"), aiTitleLine("Some session"));
    expect(findLatestTodos(text)).toBeNull();
  });

  test("returns the latest TodoWrite snapshot when multiple exist", () => {
    const first: Todo[] = [{ content: "one", status: "completed" }];
    const second: Todo[] = [
      { content: "two", status: "in_progress", activeForm: "doing two" },
      { content: "three", status: "pending" },
    ];
    const text = jsonl(
      todoWriteLine({ todos: first, timestamp: "2025-01-01T00:00:00Z" }),
      todoWriteLine({ todos: second, timestamp: "2025-01-01T00:01:00Z", sessionId: "abc" }),
    );

    const snap = findLatestTodos(text);
    expect(snap).not.toBeNull();
    expect(snap!.todos).toEqual(second);
    expect(snap!.sessionId).toBe("abc");
    expect(snap!.timestamp).toBe("2025-01-01T00:01:00Z");
  });

  test("filters out malformed todo entries", () => {
    const mixed: unknown[] = [
      { content: "good", status: "pending" },
      { content: "bad-status", status: "weird" },
      { status: "pending" }, // missing content
      "not an object",
      { content: "also good", status: "in_progress", activeForm: "doing it" },
    ];
    const text = jsonl(todoWriteLine({ todos: mixed as Todo[] }));

    const snap = findLatestTodos(text);
    expect(snap!.todos).toEqual([
      { content: "good", status: "pending" },
      { content: "also good", status: "in_progress", activeForm: "doing it" },
    ]);
  });

  test("skips lines that fail to parse (e.g. partial first line from a tail read)", () => {
    const valid = jsonl(todoWriteLine({ todos: [{ content: "x", status: "pending" }] }));
    const text = `{ partial broken json with "TodoWrite" inside\n${valid}`;
    expect(findLatestTodos(text)).not.toBeNull();
  });

  test("ignores TodoWrite mentions inside non-tool-use content", () => {
    // Text content containing the string "TodoWrite" but no actual tool_use entry.
    const decoy = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I will use TodoWrite later." }],
      },
    };
    expect(findLatestTodos(jsonl(decoy))).toBeNull();
  });
});

describe("findLatestTitle", () => {
  test("returns null when no ai-title line exists", () => {
    expect(findLatestTitle(jsonl(userTextLine("hello")))).toBeNull();
  });

  test("returns the latest ai-title (aiTitle field)", () => {
    const text = jsonl(aiTitleLine("Old title"), aiTitleLine("Newer title"));
    expect(findLatestTitle(text)).toBe("Newer title");
  });

  test("falls back to the `title` field when `aiTitle` is absent", () => {
    const text = jsonl({ type: "ai-title", title: "Legacy title" });
    expect(findLatestTitle(text)).toBe("Legacy title");
  });

  test("ignores ai-title lines with empty strings", () => {
    const text = jsonl({ type: "ai-title", aiTitle: "" }, aiTitleLine("Real title"));
    expect(findLatestTitle(text)).toBe("Real title");
  });

  test("ignores objects that mention ai-title but aren't ai-title type", () => {
    const text = jsonl({ type: "user", note: "the ai-title was set" });
    expect(findLatestTitle(text)).toBeNull();
  });
});

describe("findSessionState", () => {
  test("idle when no assistant turn exists and mtime is stale", () => {
    const text = jsonl(userTextLine("hi"));
    const result = findSessionState(text, NOW - 60_000, NOW);
    expect(result).toEqual({ state: "idle" });
  });

  test("active when no pending tool_use but mtime is within active window", () => {
    const text = jsonl(userTextLine("hi"));
    const result = findSessionState(text, NOW - 1_000, NOW);
    expect(result.state).toBe("active");
  });

  test("active when an unresolved tool_use is fresh (within active window)", () => {
    const text = jsonl(assistantToolUseLine({ name: "Read", id: "tu_1" }));
    const result = findSessionState(text, NOW - 1_000, NOW);
    expect(result).toEqual({ state: "active", pendingTool: "Read" });
  });

  test("waiting when an unresolved short-running tool_use is stale", () => {
    const text = jsonl(assistantToolUseLine({ name: "Read", id: "tu_1" }));
    const result = findSessionState(text, NOW - 60_000, NOW);
    expect(result).toEqual({ state: "waiting", pendingTool: "Read" });
  });

  test("AskUserQuestion is always waiting, even if mtime is fresh", () => {
    const text = jsonl(assistantToolUseLine({ name: "AskUserQuestion", id: "tu_q" }));
    const result = findSessionState(text, NOW - 200, NOW);
    expect(result).toEqual({ state: "waiting", pendingTool: "AskUserQuestion" });
  });

  test("Agent/Task/Bash stay active even when stale (long-running tools)", () => {
    for (const tool of ["Agent", "Task", "Bash"]) {
      const text = jsonl(assistantToolUseLine({ name: tool, id: "tu_long" }));
      const result = findSessionState(text, NOW - 600_000, NOW);
      expect(result, `tool=${tool}`).toEqual({ state: "active", pendingTool: tool });
    }
  });

  test("idle when all tool_uses from latest assistant turn have been resolved", () => {
    const text = jsonl(
      assistantToolUseLine({ name: "Read", id: "tu_1" }),
      toolResultLine("tu_1"),
    );
    const result = findSessionState(text, NOW - 60_000, NOW);
    expect(result).toEqual({ state: "idle" });
  });

  test("picks the latest unresolved tool when several were emitted", () => {
    const multi = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Read", id: "tu_1", input: {} },
          { type: "tool_use", name: "Bash", id: "tu_2", input: {} },
        ],
      },
    };
    const text = jsonl(multi);
    const result = findSessionState(text, NOW - 60_000, NOW);
    expect(result.pendingTool).toBe("Bash");
    expect(result.state).toBe("active"); // Bash is long-running
  });

  test("only the latest assistant turn contributes pending tool_uses", () => {
    // Old assistant turn with Read; later tool_result resolves it; later
    // assistant turn with no tool_use. Should be idle (no pending tool_uses
    // in the latest assistant turn).
    const newerAssistantTextOnly = {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    };
    const text = jsonl(
      assistantToolUseLine({ name: "Read", id: "tu_old" }),
      toolResultLine("tu_old"),
      newerAssistantTextOnly,
    );
    const result = findSessionState(text, NOW - 60_000, NOW);
    expect(result).toEqual({ state: "idle" });
  });
});
