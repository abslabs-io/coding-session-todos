import type { ActiveSession } from "./sessionFinder";
import type { SessionStateInfo, Todo, TodosSnapshot } from "./parser";

export interface SessionEntry {
  session: ActiveSession;
  snapshot: TodosSnapshot | null;
  title: string | null;
  state: SessionStateInfo;
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
  }
  return true;
}
