import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import {
  findLatestTitle,
  findLatestTodos,
  findSessionState,
  SessionStateInfo,
  Todo,
  TodoStatus,
  TodosSnapshot,
} from "./parser";
import { ActiveSession, findActiveSessions, projectsRoot, readTail } from "./sessionFinder";

const DEFAULT_ACTIVE_WINDOW_MIN = 30;
const REFRESH_THROTTLE_MS = 5_000;
const RESCAN_DEBOUNCE_MS = 500;
const SAFETY_POLL_MS = 60_000;
// While a session is in the "active" state we re-render shortly after the
// state-detection active window expires so the spinner can flip to check
// or warning even when nothing else is writing to the transcript.
const STATE_TICK_MS = 6_000;

export function activate(context: vscode.ExtensionContext): void {
  const provider = new TodosProvider();
  const view = vscode.window.createTreeView<TreeNode>("claudeTodos.list", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "workbench.view.extension.claudeTodos";
  provider.attachView(view, statusBar);
  context.subscriptions.push(
    view,
    statusBar,
    vscode.window.registerFileDecorationProvider(new TodoDecorationProvider()),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeTodos.refresh", () => provider.refresh()),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeTodos.expandAll", () => provider.expandAll()),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeTodos.collapseAll", () =>
      vscode.commands.executeCommand("workbench.actions.treeView.claudeTodos.list.collapseAll"),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeTodos.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:local.claude-todos"),
    ),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.relocate()),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("claudeTodos.activeSessionMinutes")) {
        void provider.refresh();
      }
    }),
  );

  context.subscriptions.push({ dispose: () => provider.dispose() });

  provider.relocate();
}

export function deactivate(): void {}

type ViewState = "noSessions" | "ready";
type TreeNode = SessionNode | InfoNode | TodoNode;

interface SessionEntry {
  session: ActiveSession;
  snapshot: TodosSnapshot | null;
  title: string | null;
  state: SessionStateInfo;
}

class TodosProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChange = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private view: vscode.TreeView<TreeNode> | null = null;
  private statusBar: vscode.StatusBarItem | null = null;
  private currentCwd: string | null = null;
  private entries: SessionEntry[] = [];
  private fileWatchers: Map<string, fs.FSWatcher> = new Map();
  private dirWatchers: Map<string, fs.FSWatcher> = new Map();
  private rootWatcher: fs.FSWatcher | null = null;
  private refreshTimers: Map<string, NodeJS.Timeout> = new Map();
  private lastRefreshAt: Map<string, number> = new Map();
  private stateTickTimers: Map<string, NodeJS.Timeout> = new Map();
  private expiryTimers: Map<string, NodeJS.Timeout> = new Map();
  private rescanDebounce: NodeJS.Timeout | null = null;
  private safetyPoll: NodeJS.Timeout | null = null;

  attachView(view: vscode.TreeView<TreeNode>, statusBar: vscode.StatusBarItem): void {
    this.view = view;
    this.statusBar = statusBar;
    this.updateChrome();
  }

  getActiveWindowMs(): number {
    const raw = vscode.workspace
      .getConfiguration("claudeTodos")
      .get<number>("activeSessionMinutes", DEFAULT_ACTIVE_WINDOW_MIN);
    const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ACTIVE_WINDOW_MIN;
    return minutes * 60_000;
  }

  async relocate(): Promise<void> {
    this.disposeWatchers();
    this.currentCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    this.ensureRootWatcher();
    this.ensureSafetyPoll();
    await this.rescan();
  }

  async refresh(): Promise<void> {
    await this.rescan();
  }

  async expandAll(): Promise<void> {
    if (!this.view) return;
    for (const entry of this.entries) {
      try {
        await this.view.reveal(new SessionNode(entry), {
          expand: true,
          select: false,
          focus: false,
        });
      } catch {
        // reveal can throw if the node is no longer present; ignore
      }
    }
  }

  dispose(): void {
    this.disposeWatchers();
  }

  private scheduleRescan(): void {
    if (this.rescanDebounce) return;
    this.rescanDebounce = setTimeout(() => {
      this.rescanDebounce = null;
      void this.rescan();
    }, RESCAN_DEBOUNCE_MS);
  }

  private async rescan(): Promise<void> {
    const sessions = await findActiveSessions(this.getActiveWindowMs());
    const entries: SessionEntry[] = [];
    for (const session of sessions) {
      const { snapshot, title, state } = await loadEntry(session.sessionFile, session.mtimeMs);
      entries.push({ session, snapshot, title, state });
    }
    const changed = !sameEntries(this.entries, entries);
    this.entries = entries;
    this.syncFileWatchers();
    this.syncDirWatchers();
    this.syncStateTickers();
    this.syncExpiryTimers();
    if (changed) {
      this.updateChrome();
      this._onDidChange.fire(undefined);
    }
  }

  private ensureRootWatcher(): void {
    if (this.rootWatcher) return;
    try {
      this.rootWatcher = fs.watch(projectsRoot(), { persistent: false }, () =>
        this.scheduleRescan(),
      );
    } catch {
      // projects root may not exist yet; the safety poll will retry
    }
  }

  private ensureSafetyPoll(): void {
    if (this.safetyPoll) return;
    this.safetyPoll = setInterval(() => {
      if (!this.rootWatcher) this.ensureRootWatcher();
      this.scheduleRescan();
    }, SAFETY_POLL_MS);
  }

  private syncDirWatchers(): void {
    const live = new Set(this.entries.map((e) => path.dirname(e.session.sessionFile)));
    for (const [dir, watcher] of this.dirWatchers) {
      if (!live.has(dir)) {
        watcher.close();
        this.dirWatchers.delete(dir);
      }
    }
    for (const dir of live) {
      if (this.dirWatchers.has(dir)) continue;
      try {
        const w = fs.watch(dir, { persistent: false }, () => this.scheduleRescan());
        this.dirWatchers.set(dir, w);
      } catch {
        // ignore; safety poll backstops
      }
    }
  }

  private syncExpiryTimers(): void {
    const live = new Set(this.entries.map((e) => e.session.sessionFile));
    for (const [file, timer] of this.expiryTimers) {
      if (!live.has(file)) {
        clearTimeout(timer);
        this.expiryTimers.delete(file);
      }
    }
    const activeWindow = this.getActiveWindowMs();
    const now = Date.now();
    for (const entry of this.entries) {
      const file = entry.session.sessionFile;
      const existing = this.expiryTimers.get(file);
      if (existing) clearTimeout(existing);
      const delay = Math.max(1_000, entry.session.mtimeMs + activeWindow - now + 1_000);
      const timer = setTimeout(() => {
        this.expiryTimers.delete(file);
        this.scheduleRescan();
      }, delay);
      this.expiryTimers.set(file, timer);
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
    let mtimeMs = prev.session.mtimeMs;
    try {
      const stat = await fs.promises.stat(file);
      mtimeMs = stat.mtimeMs;
    } catch {
      // keep previous mtime
    }
    const { snapshot, title, state } = await loadEntry(file, mtimeMs);
    const changed =
      !sameTodos(prev.snapshot?.todos, snapshot?.todos) ||
      prev.title !== title ||
      !sameState(prev.state, state);
    this.entries[idx] = {
      session: { ...prev.session, mtimeMs },
      snapshot,
      title,
      state,
    };
    this.entries.sort((a, b) => b.session.mtimeMs - a.session.mtimeMs);
    this.syncStateTickers();
    this.syncExpiryTimers();
    if (changed) {
      this.updateChrome();
      this._onDidChange.fire(undefined);
    }
  }

  // While any session is showing the spinner, schedule a one-shot re-render
  // shortly after the active window expires so the icon can flip to check or
  // warning even when nothing else is writing to the transcript.
  private syncStateTickers(): void {
    const live = new Set(this.entries.map((e) => e.session.sessionFile));
    for (const [file, timer] of this.stateTickTimers) {
      if (!live.has(file)) {
        clearTimeout(timer);
        this.stateTickTimers.delete(file);
      }
    }
    for (const entry of this.entries) {
      const file = entry.session.sessionFile;
      if (this.stateTickTimers.has(file)) continue;
      if (entry.state.state !== "active") continue;
      const timer = setTimeout(() => {
        this.stateTickTimers.delete(file);
        void this.reloadOne(file);
      }, STATE_TICK_MS);
      this.stateTickTimers.set(file, timer);
    }
  }

  private lastTitle: string | undefined;
  private lastBadgeValue: number | undefined;
  private lastState: ViewState | undefined;
  private lastStatusBarText: string | undefined;
  private lastStatusBarTooltipKey: string | undefined;
  private lastStatusBarBgId: string | undefined;
  private lastStatusBarVisible = false;

  private updateChrome(): void {
    const state: ViewState = this.entries.length === 0 ? "noSessions" : "ready";
    if (state !== this.lastState) {
      void vscode.commands.executeCommand("setContext", "claudeTodos.state", state);
      this.lastState = state;
    }
    this.updateStatusBar();
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

  private updateStatusBar(): void {
    if (!this.statusBar) return;
    const current = this.entries.find((e) => e.session.cwd === this.currentCwd);
    const todos = current?.snapshot?.todos ?? [];
    const hasTodos = todos.length > 0;
    const stateName = current?.state.state ?? "idle";

    const hide = !current || (stateName === "idle" && !hasTodos);
    if (hide) {
      if (this.lastStatusBarVisible) {
        this.statusBar.hide();
        this.lastStatusBarVisible = false;
      }
      return;
    }

    let glyph: string;
    let bgId: string | undefined;
    if (stateName === "waiting") {
      glyph = "$(warning)";
      bgId = "statusBarItem.warningBackground";
    } else if (stateName === "active") {
      glyph = "$(loading~spin)";
    } else {
      glyph = "$(checklist)";
    }
    const counts = hasTodos
      ? (() => {
          const p = currentPosition(todos);
          return `${p.current}/${p.total}`;
        })()
      : "Claude";
    const text = `${glyph} ${counts}`;

    const now = Date.now();
    const tooltipLines = this.entries.map((e) => {
      const t = e.snapshot?.todos ?? [];
      const ago = relativeTime(e.snapshot?.timestamp ?? "") || timeAgoMs(now - e.session.mtimeMs);
      const c = t.length > 0
        ? (() => {
            const p = currentPosition(t);
            return `${p.current}/${p.total}`;
          })()
        : "no todos";
      const title = e.title ?? path.basename(e.session.cwd) ?? e.session.cwd;
      return `- **${escMd(title)}** · ${c} · ${e.state.state} · ${ago}`;
    });
    const tooltipText = tooltipLines.join("\n");
    const tooltipKey = `${text}|${tooltipText}`;

    if (this.lastStatusBarText !== text) {
      this.statusBar.text = text;
      this.lastStatusBarText = text;
    }
    if (this.lastStatusBarTooltipKey !== tooltipKey) {
      this.statusBar.tooltip = mdString(tooltipText);
      this.lastStatusBarTooltipKey = tooltipKey;
    }
    if (this.lastStatusBarBgId !== bgId) {
      this.statusBar.backgroundColor = bgId ? new vscode.ThemeColor(bgId) : undefined;
      this.lastStatusBarBgId = bgId;
    }
    if (!this.lastStatusBarVisible) {
      this.statusBar.show();
      this.lastStatusBarVisible = true;
    }
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
      const todos = node.entry.snapshot?.todos ?? [];
      return [
        new InfoNode(node.entry),
        ...todos.map((t, i) => new TodoNode(t, file, i)),
      ];
    }
    return [];
  }

  getParent(node: TreeNode): TreeNode | undefined {
    if (node instanceof SessionNode) return undefined;
    const file = node instanceof InfoNode ? node.entry.session.sessionFile : node.sessionFile;
    const entry = this.entries.find((e) => e.session.sessionFile === file);
    return entry ? new SessionNode(entry) : undefined;
  }

  private disposeWatchers(): void {
    for (const w of this.fileWatchers.values()) w.close();
    this.fileWatchers.clear();
    for (const w of this.dirWatchers.values()) w.close();
    this.dirWatchers.clear();
    if (this.rootWatcher) {
      this.rootWatcher.close();
      this.rootWatcher = null;
    }
    for (const t of this.refreshTimers.values()) clearTimeout(t);
    this.refreshTimers.clear();
    for (const t of this.stateTickTimers.values()) clearTimeout(t);
    this.stateTickTimers.clear();
    for (const t of this.expiryTimers.values()) clearTimeout(t);
    this.expiryTimers.clear();
    if (this.rescanDebounce) {
      clearTimeout(this.rescanDebounce);
      this.rescanDebounce = null;
    }
    if (this.safetyPoll) {
      clearInterval(this.safetyPoll);
      this.safetyPoll = null;
    }
    this.lastRefreshAt.clear();
  }
}

async function loadEntry(
  file: string,
  mtimeMs: number,
): Promise<{ snapshot: TodosSnapshot | null; title: string | null; state: SessionStateInfo }> {
  try {
    let text = await readTail(file);
    let snap = findLatestTodos(text);
    let title = findLatestTitle(text);
    if (!snap || !title) {
      text = await fs.promises.readFile(file, "utf8");
      snap = snap ?? findLatestTodos(text);
      title = title ?? findLatestTitle(text);
    }
    const state = findSessionState(text, mtimeMs);
    return { snapshot: snap, title, state };
  } catch {
    return { snapshot: null, title: null, state: { state: "idle" } };
  }
}

class SessionNode {
  constructor(public readonly entry: SessionEntry) {}

  toTreeItem(currentCwd: string | null): vscode.TreeItem {
    const isCurrent = this.entry.session.cwd === currentCwd;
    const folder = path.basename(this.entry.session.cwd) || this.entry.session.cwd;
    const labelText = this.entry.title ?? folder;
    const item = new vscode.TreeItem(labelText, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `session:${this.entry.session.sessionFile}`;
    const stateText = `${this.entry.state.state}${this.entry.state.pendingTool ? ` (${this.entry.state.pendingTool})` : ""}`;
    item.tooltip = mdString(
      `**${escMd(this.entry.title ?? "(no title)")}**\n\n\`${this.entry.session.cwd}\`\n\n\`${path.basename(this.entry.session.sessionFile, ".jsonl")}\` — _${stateText}_`,
    );
    item.iconPath = sessionIconFor(this.entry.state);
    item.contextValue = isCurrent ? "session.current" : "session.other";
    return item;
  }
}

class InfoNode {
  constructor(public readonly entry: SessionEntry) {}

  toTreeItem(_currentCwd: string | null): vscode.TreeItem {
    const todos = this.entry.snapshot?.todos ?? [];
    const folder = path.basename(this.entry.session.cwd) || this.entry.session.cwd;
    const ago =
      relativeTime(this.entry.snapshot?.timestamp ?? "") ||
      timeAgoMs(Date.now() - this.entry.session.mtimeMs);
    const status = todos.length > 0
      ? `${currentPosition(todos).current} / ${currentPosition(todos).total}`
      : "no todos";
    const meta = `${folder} · ${status} · ${ago}`;
    // Empty label + meta in description renders in the dim description
    // color, reading as a caption under the title rather than a sibling row.
    const item = new vscode.TreeItem(" ", vscode.TreeItemCollapsibleState.None);
    item.id = `info:${this.entry.session.sessionFile}`;
    item.description = meta;
    item.tooltip = mdString(`\`${this.entry.session.cwd}\`\n\n${status} · ${ago}`);
    item.contextValue = "session.info";
    return item;
  }
}

class TodoNode {
  constructor(
    private readonly todo: Todo,
    public readonly sessionFile: string,
    private readonly index: number,
  ) {}

  toTreeItem(_currentCwd: string | null): vscode.TreeItem {
    const { status, content, activeForm } = this.todo;
    let label = content;
    let description: string | undefined;
    if (status === "in_progress" && activeForm) {
      label = activeForm;
      if (activeForm !== content) description = content;
    }
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `todo:${this.sessionFile}:${this.index}`;
    item.iconPath = iconFor(status);
    item.resourceUri = vscode.Uri.parse(`claude-todo:/${status}`);
    if (description) item.description = description;
    const tip = activeForm && status === "in_progress" && activeForm !== content
      ? `${escMd(content)}\n\n_${status} — ${escMd(activeForm)}_`
      : `${escMd(content)}\n\n_${status}_`;
    item.tooltip = mdString(tip);
    item.contextValue = `todo.${status}`;
    return item;
  }
}

function sameEntries(a: SessionEntry[], b: SessionEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].session.sessionFile !== b[i].session.sessionFile) return false;
    if (a[i].title !== b[i].title) return false;
    if (!sameTodos(a[i].snapshot?.todos, b[i].snapshot?.todos)) return false;
    if (!sameState(a[i].state, b[i].state)) return false;
  }
  return true;
}

function sameState(a: SessionStateInfo, b: SessionStateInfo): boolean {
  return a.state === b.state && (a.pendingTool ?? "") === (b.pendingTool ?? "");
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
      return new vscode.ThemeIcon("check", new vscode.ThemeColor("disabledForeground"));
    case "in_progress":
      return new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.blue"));
    case "pending":
    default:
      return new vscode.ThemeIcon("circle-large-outline");
  }
}

function sessionIconFor(state: SessionStateInfo): vscode.ThemeIcon {
  switch (state.state) {
    case "active":
      return new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.blue"));
    case "waiting":
      return new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"));
    case "idle":
    default:
      return new vscode.ThemeIcon("check", new vscode.ThemeColor("testing.iconPassed"));
  }
}

class TodoDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "claude-todo") return undefined;
    if (uri.path === "/completed") {
      return { color: new vscode.ThemeColor("disabledForeground") };
    }
    return undefined;
  }
}

function mdString(value: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(value);
  md.isTrusted = false;
  return md;
}

function escMd(s: string): string {
  return s.replace(/[\\`*_{}\[\]()#+\-.!<>|]/g, (c) => `\\${c}`);
}
