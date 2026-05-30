import type { Todo } from "../../src/parser";

export function jsonl(...entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

export function todoWriteLine(opts: {
  todos: Todo[];
  timestamp?: string;
  sessionId?: string;
  toolUseId?: string;
}): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp: opts.timestamp,
    sessionId: opts.sessionId,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          name: "TodoWrite",
          id: opts.toolUseId ?? "toolu_todo",
          input: { todos: opts.todos },
        },
      ],
    },
  };
}

export function aiTitleLine(title: string): Record<string, unknown> {
  return { type: "ai-title", aiTitle: title };
}

export function assistantToolUseLine(opts: {
  name: string;
  id: string;
  timestamp?: string;
}): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp: opts.timestamp,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: opts.name, id: opts.id, input: {} }],
    },
  };
}

export function assistantUsageLine(opts: {
  model?: string | null;
  inputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  isSidechain?: boolean;
  timestamp?: string;
}): Record<string, unknown> {
  return {
    type: "assistant",
    isSidechain: opts.isSidechain,
    timestamp: opts.timestamp,
    message: {
      role: "assistant",
      model: opts.model === undefined ? "claude-opus-4-8" : opts.model,
      usage: {
        input_tokens: opts.inputTokens ?? 0,
        cache_creation_input_tokens: opts.cacheCreationTokens ?? 0,
        cache_read_input_tokens: opts.cacheReadTokens ?? 0,
        output_tokens: 0,
      },
    },
  };
}

export function toolResultLine(toolUseId: string): Record<string, unknown> {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
    },
  };
}

export function userTextLine(text: string): Record<string, unknown> {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}
