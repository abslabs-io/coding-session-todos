import * as path from "path";

import type { ActiveSession } from "./sessionFinder";
import type { ContextInfo, SessionStateInfo, Todo, TodosSnapshot } from "./parser";

export interface SessionEntry {
  session: ActiveSession;
  snapshot: TodosSnapshot | null;
  title: string | null;
  state: SessionStateInfo;
  context: ContextInfo | null;
}

// True when `cwd` is the workspace `root` itself or a directory nested under
// it. Drives which session the status bar reflects: prefer the session sitting
// exactly at the workspace folder, else the most recent one running inside it
// (e.g. a Claude session started in a subdirectory). Cross-drive or sibling
// paths (relative path escapes with "..") are outside the workspace.
export function isWithinWorkspace(cwd: string, root: string): boolean {
  if (!root || !cwd) return false;
  // "" means the same directory; a ".."-leading or absolute relative path means
  // cwd escaped the root (sibling, ancestor, or a different drive on Windows).
  const rel = path.relative(root, cwd);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Picks the session the status bar reflects: the one sitting exactly at the
// workspace `root`, else the most recently active session running inside it.
// Returns null when no session is within the workspace (the caller then shows
// just the neutral icon). `entries` is assumed sorted most-recent-first — the
// order the provider maintains — so `find` returns the latest match.
export function selectStatusBarSession(
  entries: SessionEntry[],
  root: string | null,
): SessionEntry | null {
  if (!root) return null;
  return (
    entries.find((e) => e.session.cwd === root) ??
    entries.find((e) => isWithinWorkspace(e.session.cwd, root)) ??
    null
  );
}

const WINDOW_200K = 200_000;
const WINDOW_1M = 1_000_000;

// Resolves the context-window size for a model. Opus ships a 1M window by
// default (4.7 and 4.8 in Claude Code); Sonnet/Haiku and anything unknown
// are treated as 200k. Defaulting unknown models to 200k is the conservative
// choice — an unfamiliar model reads as fuller, never falsely reassuring.
export function windowForModel(model: string | null): number {
  if (model && model.toLowerCase().includes("opus")) return WINDOW_1M;
  return WINDOW_200K;
}

// Integer percent of the context window consumed at the latest turn, or null
// when no usage is known (so callers can omit the segment entirely).
export function contextPercent(ctx: ContextInfo | null): number | null {
  if (!ctx) return null;
  const window = windowForModel(ctx.model);
  const pct = Math.round((ctx.usedTokens / window) * 100);
  return Math.max(0, Math.min(100, pct));
}

// Labeled context segment shared by the tooltips, e.g. "22% ctx", or "" when
// usage is unknown so callers can omit it. Centralizing the wording keeps the
// three tooltips identical.
export function contextLabel(ctx: ContextInfo | null): string {
  const pct = contextPercent(ctx);
  return pct === null ? "" : `${pct}% ctx`;
}

export function currentPosition(todos: Todo[]): { current: number; total: number } {
  const total = todos.length;
  if (total === 0) return { current: 0, total: 0 };
  const idx = todos.findIndex((t) => t.status === "in_progress");
  if (idx >= 0) return { current: idx + 1, total };
  const completed = todos.filter((t) => t.status === "completed").length;
  return { current: Math.min(completed + 1, total), total };
}

export function relativeTime(iso: string): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  return timeAgoMs(Date.now() - then);
}

export function timeAgoMs(diff: number): string {
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export function escMd(s: string): string {
  return s.replace(/[\\`*_{}\[\]()#+\-.!<>|]/g, (c) => `\\${c}`);
}

export function sameTodos(a: Todo[] | undefined, b: Todo[] | undefined): boolean {
  const ax = a ?? [];
  const bx = b ?? [];
  if (ax.length !== bx.length) return false;
  for (let i = 0; i < ax.length; i++) {
    if (ax[i].content !== bx[i].content) return false;
    if (ax[i].status !== bx[i].status) return false;
  }
  return true;
}

export function sameState(a: SessionStateInfo, b: SessionStateInfo): boolean {
  return a.state === b.state && (a.pendingTool ?? "") === (b.pendingTool ?? "");
}

export function sameEntries(a: SessionEntry[], b: SessionEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].session.sessionFile !== b[i].session.sessionFile) return false;
    if (a[i].title !== b[i].title) return false;
    if (!sameTodos(a[i].snapshot?.todos, b[i].snapshot?.todos)) return false;
    if (!sameState(a[i].state, b[i].state)) return false;
    // Compare the displayed integer %, not raw tokens, so the view doesn't
    // re-render on every token tick — only when the visible number changes.
    if (contextPercent(a[i].context) !== contextPercent(b[i].context)) return false;
  }
  return true;
}
