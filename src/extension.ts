import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { findLatestTitle, findLatestTodos, Todo, TodoStatus, TodosSnapshot } from "./parser";
import { ActiveSession, findActiveSessions, readTail } from "./sessionFinder";

const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
const REFRESH_THROTTLE_MS = 5_000;

export function activate(context: vscode.ExtensionContext): void {
  const provider = new TodosProvider();
  const view = vscode.window.createTreeView<TreeNode>("claudeTodos.list", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  provider.attachView(view);
  context.subscriptions.push(view);

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeTodos.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("claudeTodos.openTranscript", async () => {
      const file = provider.currentSessionFile();
      if (!file) {
        vscode.window.showInformationMessage("No Claude transcript found for this workspace yet.");
        return;
      }
      const doc = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.relocate()),
  );

  provider.relocate();
}

export function deactivate(): void {}

type ViewState = "noSessions" | "ready";
type TreeNode = SessionNode | TodoNode;

interface SessionEntry {
  session: ActiveSession;
  snapshot: TodosSnapshot | null;
  title: string | null;
}

class TodosProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChange = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private view: vscode.TreeView<TreeNode> | null = null;
  private currentCwd: string | null = null;
  private entries: SessionEntry[] = [];
  private fileWatchers: Map<string, fs.FSWatcher> = new Map();
  private refreshTimers: Map<string, NodeJS.Timeout> = new Map();
  private lastRefreshAt: Map<string, number> = new Map();

  attachView(view: vscode.TreeView<TreeNode>): void {
    this.view = view;
    this.updateChrome();
  }

  async relocate(): Promise<void> {
    this.disposeWatchers();
    this.currentCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    await this.rescan();
  }

  async refresh(): Promise<void> {
    await this.rescan();
  }

  currentSessionFile(): string | null {
    if (!this.currentCwd) return null;
    return this.entries.find((e) => e.session.cwd === this.currentCwd)?.session.sessionFile ?? null;
  }

  private async rescan(): Promise<void> {
    const sessions = await findActiveSessions(ACTIVE_WINDOW_MS);
    const entries: SessionEntry[] = [];
    for (const session of sessions) {
      const { snapshot, title } = await loadEntry(session.sessionFile);
      entries.push({ session, snapshot, title });
    }
    const changed = !sameEntries(this.entries, entries);
    this.entries = entries;
    this.syncFileWatchers();
    if (changed) {
      this.updateChrome();
      this._onDidChange.fire(undefined);
    }
  }

  private syncFileWatchers(): void {
    const live = new Set(this.entries.map((e) => e.session.sessionFile));
    for (const [file, watcher] of this.fileWatchers) {
      if (!live.has(file)) {
        watcher.close();
        this.fileWatchers.delete(file);
      }
    }
    for (const entry of this.entries) {
      const file = entry.session.sessionFile;
      if (this.fileWatchers.has(file)) continue;
      try {
        const w = fs.watch(file, { persistent: false }, () => this.scheduleRefresh(file));
        this.fileWatchers.set(file, w);
      } catch {
        // ignore; periodic rescan recovers
      }
    }
  }

  private scheduleRefresh(file: string): void {
    const now = Date.now();
    const last = this.lastRefreshAt.get(file) ?? 0;
    const elapsed = now - last;

    if (elapsed >= REFRESH_THROTTLE_MS) {
      this.lastRefreshAt.set(file, now);
      void this.reloadOne(file);
      return;
    }
    if (this.refreshTimers.has(file)) return;
    const delay = REFRESH_THROTTLE_MS - elapsed;
    this.refreshTimers.set(
      file,
      setTimeout(() => {
        this.refreshTimers.delete(file);
        this.lastRefreshAt.set(file, Date.now());
        void this.reloadOne(file);
      }, delay),
    );
  }

  private async reloadOne(file: string): Promise<void> {
    const idx = this.entries.findIndex((e) => e.session.sessionFile === file);
    if (idx === -1) return;
    const prev = this.entries[idx];
    const { snapshot, title } = await loadEntry(file);
    const changed = !sameTodos(prev.snapshot?.todos, snapshot?.todos) || prev.title !== title;
    try {
      const stat = await fs.promises.stat(file);
      this.entries[idx] = {
        session: { ...prev.session, mtimeMs: stat.mtimeMs },
        snapshot,
        title,
      };
    } catch {
      this.entries[idx] = { ...prev, snapshot, title };
    }
    this.entries.sort((a, b) => b.session.mtimeMs - a.session.mtimeMs);
    if (changed) {
      this.updateChrome();
      this._onDidChange.fire(undefined);
    }
  }

  private lastTitle: string | undefined;
  private lastBadgeValue: number | undefined;
  private lastState: ViewState | undefined;

  private updateChrome(): void {
    const state: ViewState = this.entries.length === 0 ? "noSessions" : "ready";
    if (state !== this.lastState) {
      void vscode.commands.executeCommand("setContext", "claudeTodos.state", state);
      this.lastState = state;
    }
    if (!this.view) return;

    const current = this.entries.find((e) => e.session.cwd === this.currentCwd);
    const todos = current?.snapshot?.todos ?? [];
    let nextTitle = "Todos";
    let nextBadgeValue: number | undefined;
    let nextBadgeTip = "";
    if (todos.length > 0) {
      const pos = currentPosition(todos);
      nextTitle = `Todos · ${pos.current} / ${pos.total}`;
      nextBadgeValue = pos.current;
      nextBadgeTip = `Working on ${pos.current} of ${pos.total}`;
    }
    if (nextTitle !== this.lastTitle) {
      this.view.title = nextTitle;
      this.lastTitle = nextTitle;
    }
    if (nextBadgeValue !== this.lastBadgeValue) {
      this.view.badge = nextBadgeValue === undefined
        ? undefined
        : { value: nextBadgeValue, tooltip: nextBadgeTip };
      this.lastBadgeValue = nextBadgeValue;
    }
    this.view.message = undefined;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    return node.toTreeItem(this.currentCwd);
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      return this.entries.map((e) => new SessionNode(e));
    }
    if (node instanceof SessionNode) {
      const file = node.entry.session.sessionFile;
      return (node.entry.snapshot?.todos ?? []).map((t, i) => new TodoNode(t, file, i));
    }
    return [];
  }

  private disposeWatchers(): void {
    for (const w of this.fileWatchers.values()) w.close();
    this.fileWatchers.clear();
    for (const t of this.refreshTimers.values()) clearTimeout(t);
    this.refreshTimers.clear();
    this.lastRefreshAt.clear();
  }
}

async function loadEntry(file: string): Promise<{ snapshot: TodosSnapshot | null; title: string | null }> {
  try {
    let text = await readTail(file);
    let snap = findLatestTodos(text);
    let title = findLatestTitle(text);
    if (!snap || !title) {
      text = await fs.promises.readFile(file, "utf8");
      snap = snap ?? findLatestTodos(text);
      title = title ?? findLatestTitle(text);
    }
    return { snapshot: snap, title };
  } catch {
    return { snapshot: null, title: null };
  }
}

class SessionNode {
  constructor(public readonly entry: SessionEntry) {}

  toTreeItem(currentCwd: string | null): vscode.TreeItem {
    const todos = this.entry.snapshot?.todos ?? [];
    const isCurrent = this.entry.session.cwd === currentCwd;
    const folder = path.basename(this.entry.session.cwd) || this.entry.session.cwd;
    const label = this.entry.title ?? folder;
    const collapsibleState = isCurrent
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(label, collapsibleState);
    item.id = `session:${this.entry.session.sessionFile}`;
    const sid = path.basename(this.entry.session.sessionFile, ".jsonl").slice(0, 8);
    const ago = relativeTime(this.entry.snapshot?.timestamp ?? "") || timeAgoMs(Date.now() - this.entry.session.mtimeMs);
    const status = todos.length > 0
      ? `${currentPosition(todos).current} / ${currentPosition(todos).total}`
      : "no todos";
    item.description = `${folder} · ${sid} · ${status} · ${ago}`;
    item.tooltip = `${this.entry.title ?? "(no title)"}\n${this.entry.session.cwd}\n${path.basename(this.entry.session.sessionFile, ".jsonl")}`;
    item.iconPath = isCurrent
      ? new vscode.ThemeIcon("folder-active")
      : new vscode.ThemeIcon("folder");
    item.contextValue = isCurrent ? "session.current" : "session.other";
    return item;
  }
}

class TodoNode {
  constructor(
    private readonly todo: Todo,
    private readonly sessionFile: string,
    private readonly index: number,
  ) {}

  toTreeItem(_currentCwd: string | null): vscode.TreeItem {
    const label =
      this.todo.status === "in_progress" && this.todo.activeForm
        ? this.todo.activeForm
        : this.todo.content;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `todo:${this.sessionFile}:${this.index}`;
    item.iconPath = iconFor(this.todo.status);
    item.tooltip = this.todo.content;
    item.contextValue = `todo.${this.todo.status}`;
    return item;
  }
}

function sameEntries(a: SessionEntry[], b: SessionEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].session.sessionFile !== b[i].session.sessionFile) return false;
    if (a[i].title !== b[i].title) return false;
    if (!sameTodos(a[i].snapshot?.todos, b[i].snapshot?.todos)) return false;
  }
  return true;
}

function sameTodos(a: Todo[] | undefined, b: Todo[] | undefined): boolean {
  const ax = a ?? [];
  const bx = b ?? [];
  if (ax.length !== bx.length) return false;
  for (let i = 0; i < ax.length; i++) {
    if (ax[i].content !== bx[i].content) return false;
    if (ax[i].status !== bx[i].status) return false;
  }
  return true;
}

function currentPosition(todos: Todo[]): { current: number; total: number } {
  const total = todos.length;
  if (total === 0) return { current: 0, total: 0 };
  const idx = todos.findIndex((t) => t.status === "in_progress");
  if (idx >= 0) return { current: idx + 1, total };
  const completed = todos.filter((t) => t.status === "completed").length;
  return { current: Math.min(completed + 1, total), total };
}

function relativeTime(iso: string): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  return timeAgoMs(Date.now() - then);
}

function timeAgoMs(diff: number): string {
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

function iconFor(status: TodoStatus): vscode.ThemeIcon {
  switch (status) {
    case "completed":
      return new vscode.ThemeIcon("check", new vscode.ThemeColor("testing.iconPassed"));
    case "in_progress":
      return new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.blue"));
    case "pending":
    default:
      return new vscode.ThemeIcon("circle-large-outline");
  }
}
