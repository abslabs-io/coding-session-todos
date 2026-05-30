import { describe, expect, test } from "vitest";

import {
  findLatestContext,
  findLatestTitle,
  findLatestTodos,
  findSessionState,
  type Todo,
} from "../src/parser";
import {
  aiTitleLine,
  assistantToolUseLine,
  assistantUsageLine,
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

describe("findLatestContext", () => {
  test("returns null when no usage line exists", () => {
    const text = jsonl(userTextLine("hi"), aiTitleLine("Some session"));
    expect(findLatestContext(text)).toBeNull();
  });

  test("sums input + cache_creation + cache_read and captures the model", () => {
    const text = jsonl(
      assistantUsageLine({
        model: "claude-opus-4-8",
        inputTokens: 1287,
        cacheCreationTokens: 21656,
        cacheReadTokens: 311675,
      }),
    );
    expect(findLatestContext(text)).toEqual({ usedTokens: 334618, model: "claude-opus-4-8" });
  });

  test("returns the latest usage when several exist", () => {
    const text = jsonl(
      assistantUsageLine({ inputTokens: 10, cacheReadTokens: 90 }),
      assistantUsageLine({ inputTokens: 5, cacheReadTokens: 495, model: "claude-sonnet-4-6" }),
    );
    expect(findLatestContext(text)).toEqual({ usedTokens: 500, model: "claude-sonnet-4-6" });
  });

  test("skips sidechain (subagent) turns in favour of the main chain", () => {
    const text = jsonl(
      assistantUsageLine({ inputTokens: 1000, model: "claude-opus-4-8" }),
      assistantUsageLine({ isSidechain: true, inputTokens: 50, model: "claude-haiku-4-5" }),
    );
    expect(findLatestContext(text)).toEqual({ usedTokens: 1000, model: "claude-opus-4-8" });
  });

  test("skips <synthetic> model turns", () => {
    const text = jsonl(
      assistantUsageLine({ inputTokens: 2000, model: "claude-opus-4-8" }),
      assistantUsageLine({ inputTokens: 7, model: "<synthetic>" }),
    );
    expect(findLatestContext(text)).toEqual({ usedTokens: 2000, model: "claude-opus-4-8" });
  });

  test("skips zero-usage turns", () => {
    const text = jsonl(assistantUsageLine({ inputTokens: 0, cacheReadTokens: 0 }));
    expect(findLatestContext(text)).toBeNull();
  });

  test("skips non-assistant messages that carry a usage object", () => {
    // A user/tool turn could in principle echo a usage field; only assistant
    // turns count toward context. The most recent line here is a user turn.
    const userWithUsage = {
      type: "user",
      message: { role: "user", usage: { input_tokens: 999 } },
    };
    const text = jsonl(
      assistantUsageLine({ inputTokens: 100, model: "claude-opus-4-8" }),
      userWithUsage,
    );
    expect(findLatestContext(text)).toEqual({ usedTokens: 100, model: "claude-opus-4-8" });
  });

  test("tolerates missing usage subfields", () => {
    const text = jsonl(
      assistantUsageLine({ inputTokens: 100 }), // cache fields default to 0
    );
    expect(findLatestContext(text)).toEqual({ usedTokens: 100, model: "claude-opus-4-8" });
  });

  test("captures null model when the model field is absent", () => {
    const text = jsonl(assistantUsageLine({ model: null, inputTokens: 42 }));
    expect(findLatestContext(text)).toEqual({ usedTokens: 42, model: null });
  });

  test("skips lines that fail to parse (e.g. partial first line from a tail read)", () => {
    const valid = jsonl(assistantUsageLine({ inputTokens: 123 }));
    const text = `{ partial broken json with "usage" inside\n${valid}`;
    expect(findLatestContext(text)).toEqual({ usedTokens: 123, model: "claude-opus-4-8" });
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
