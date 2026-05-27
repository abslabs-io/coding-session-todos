export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  activeForm?: string;
  status: TodoStatus;
}

export interface TodosSnapshot {
  todos: Todo[];
  timestamp?: string;
  sessionId?: string;
}

interface TranscriptLine {
  timestamp?: string;
  sessionId?: string;
  message?: {
    content?: Array<{
      type?: string;
      name?: string;
      input?: { todos?: Todo[] };
    }>;
  };
}

// Scans a chunk of JSONL transcript text and returns the most recent
// TodoWrite snapshot, or null if none found. Lines that fail to parse
// are skipped silently — partial lines at the start of a tail chunk
// are normal.
export function findLatestTodos(text: string): TodosSnapshot | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('"TodoWrite"') === -1) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const content = parsed.message?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const item = content[j];
      if (item?.type === "tool_use" && item.name === "TodoWrite") {
        const todos = item.input?.todos;
        if (Array.isArray(todos)) {
          return {
            todos: todos.filter(isValidTodo),
            timestamp: parsed.timestamp,
            sessionId: parsed.sessionId,
          };
        }
      }
    }
  }
  return null;
}

// Returns the most recent ai-title for the session (the same string
// Claude shows in its session picker), or null if none was emitted yet.
export function findLatestTitle(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('"ai-title"') === -1) continue;
    try {
      const obj = JSON.parse(line) as { type?: string; aiTitle?: unknown; title?: unknown };
      if (obj.type !== "ai-title") continue;
      const t = typeof obj.aiTitle === "string" ? obj.aiTitle : obj.title;
      if (typeof t === "string" && t.length > 0) return t;
    } catch {
      // partial line / non-JSON; keep scanning
    }
  }
  return null;
}

function isValidTodo(t: unknown): t is Todo {
  if (!t || typeof t !== "object") return false;
  const r = t as Record<string, unknown>;
  return (
    typeof r.content === "string" &&
    (r.status === "pending" || r.status === "in_progress" || r.status === "completed")
  );
}
