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

export interface ContextInfo {
  // Sum of input-side tokens at the latest assistant turn (input +
  // cache_creation + cache_read), matching what Claude Code's /context
  // counts. Excludes output_tokens.
  usedTokens: number;
  // The model that produced the turn, used downstream to pick the window
  // size (opus → 1M, others → 200k). null if absent.
  model: string | null;
}

interface UsageShape {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ContextLine {
  type?: string;
  isSidechain?: boolean;
  message?: {
    role?: string;
    model?: string;
    usage?: UsageShape;
  };
}

// Scans a transcript tail backwards for the most recent main-chain assistant
// turn and returns its input-context size and model. Sidechain (subagent)
// turns and `<synthetic>` model turns are skipped so the number reflects the
// main session's window. Returns null when no usable usage is found. This
// tracks /compact and /clear automatically, since the next turn's usage drops.
export function findLatestContext(text: string): ContextInfo | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('"usage"') === -1) continue;
    let parsed: ContextLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.isSidechain === true) continue;
    const msg = parsed.message;
    if (!msg || (parsed.type !== "assistant" && msg.role !== "assistant")) continue;
    if (msg.model === "<synthetic>") continue;
    const usage = msg.usage;
    if (!usage) continue;
    const usedTokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0);
    if (usedTokens === 0) continue;
    return { usedTokens, model: typeof msg.model === "string" ? msg.model : null };
  }
  return null;
}

export type SessionState = "active" | "waiting" | "idle";

export interface SessionStateInfo {
  state: SessionState;
  pendingTool?: string;
}

// Tool calls expected to block long enough that the spinner shouldn't flip
// to a "stale, probably needs you" warning. Anything else, if it's been
// sitting unresolved past the active window, is treated as waiting (the
// most common cause being a pending permission prompt the harness doesn't
// echo into the transcript).
const LONG_RUNNING_TOOLS = new Set(["Agent", "Task", "Bash"]);

interface AssistantContentItem {
  type?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
}

// Walks a transcript tail backwards to figure out what the session is doing
// right now. We can't see permission prompts directly — Claude Code resolves
// those out-of-band — so any unresolved tool_use that's been sitting past
// the active window is treated as "waiting on the user".
export function findSessionState(text: string, mtimeMs: number, nowMs: number = Date.now()): SessionStateInfo {
  const lines = text.split("\n");
  const resolvedIds = new Set<string>();
  const pendingToolUses: { id: string; name: string }[] = [];
  let sawAssistant = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let parsed: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const role = parsed.message?.role;
    const content = parsed.message?.content;
    if (!Array.isArray(content)) continue;

    if (!sawAssistant && (parsed.type === "user" || role === "user")) {
      for (const item of content as AssistantContentItem[]) {
        if (item?.type === "tool_result" && typeof item.tool_use_id === "string") {
          resolvedIds.add(item.tool_use_id);
        }
      }
      continue;
    }

    if (parsed.type === "assistant" || role === "assistant") {
      sawAssistant = true;
      for (const item of content as AssistantContentItem[]) {
        if (item?.type === "tool_use" && typeof item.id === "string") {
          pendingToolUses.push({ id: item.id, name: item.name ?? "" });
        }
      }
      break;
    }
  }

  const ageMs = nowMs - mtimeMs;
  const ACTIVE_WINDOW_MS = 5_000;
  const unresolved = pendingToolUses.filter((t) => !resolvedIds.has(t.id));

  if (unresolved.length > 0) {
    const latest = unresolved[unresolved.length - 1];
    if (latest.name === "AskUserQuestion") {
      return { state: "waiting", pendingTool: latest.name };
    }
    if (ageMs < ACTIVE_WINDOW_MS) {
      return { state: "active", pendingTool: latest.name };
    }
    if (LONG_RUNNING_TOOLS.has(latest.name)) {
      return { state: "active", pendingTool: latest.name };
    }
    return { state: "waiting", pendingTool: latest.name };
  }

  if (ageMs < ACTIVE_WINDOW_MS) return { state: "active" };
  return { state: "idle" };
}

function isValidTodo(t: unknown): t is Todo {
  if (!t || typeof t !== "object") return false;
  const r = t as Record<string, unknown>;
  return (
    typeof r.content === "string" &&
    (r.status === "pending" || r.status === "in_progress" || r.status === "completed")
  );
}
