# claude-todos

VSCode extension. TypeScript 5, `@types/vscode` 1.85, no runtime deps. Renders a sidebar TreeView that mirrors the active Claude Code session's `TodoWrite` list by tailing transcript JSONL files under `~/.claude/projects/`.

## Commands

- **Build:** `npm run build` (compiles to `out/`)
- **Watch:** `npm run watch`
- **Package:** `npm run package` (produces `claude-todos-<version>.vsix` via `vsce`)
- **Run in dev:** Open the folder in VSCode and press `F5` — launches an Extension Development Host with the extension loaded. No test runner.

## Key Paths

- `src/extension.ts` — `TodosProvider` (the single `TreeDataProvider`), file watchers, throttled refresh, state tickers, chrome (title/badge) updates.
- `src/sessionFinder.ts` — Locates `~/.claude/projects/<dir>/*.jsonl`, lists every transcript with mtime inside the active window, reads the tail.
- `src/parser.ts` — Scans JSONL text backwards for the latest `TodoWrite` snapshot, the latest `ai-title`, and computes session state from unresolved `tool_use` ids.
- `media/icon.svg` — Activity bar icon.
- `package.json` `contributes` — View container `claudeTodos`, view `claudeTodos.list`, `claudeTodos.refresh` and `claudeTodos.expandAll` commands, the `claudeTodos.activeSessionMinutes` configuration property, and the `viewsWelcome` gated on the `claudeTodos.state` context key.

## Conventions

- **Never guess the project dir from the cwd.** Claude Code's encoding of cwd → folder name has shifted across versions (originally `/` → `-`, newer also `_` → `-`). `projectDirFor` is a fast-path guess only; always confirm by reading the `cwd` field inside the transcript JSON via `transcriptCwd`.
- **Read the tail, not the whole file.** Transcripts routinely exceed 20MB; `readTail` reads the trailing 1MB and drops the partial first line. `loadEntry` falls back to a full read only if both the latest `TodoWrite` and the `ai-title` are missing from the tail.
- **Multi-session, not single-session.** `findActiveSessions` returns every transcript with mtime within the active window (the `claudeTodos.activeSessionMinutes` setting, default 30 min, max 1440). The view shows all of them, sorted by mtime descending. The workspace-cwd session (if present) drives the view title and badge; the others are still rendered.
- **Session state is inferred, not observed.** Claude Code resolves permission prompts out-of-band, so the parser walks the tail backwards collecting unresolved `tool_use` ids from the latest assistant turn. `AskUserQuestion` is always `waiting`. Anything unresolved past a 5s active window is `waiting` — except `Agent`/`Task`/`Bash`, which stay `active` because they're expected to block long. The session icon (spinner/warning/check) is driven entirely by this.
- **Layered refresh.** Four triggers funnel through `scheduleRescan` (500ms debounce): (1) `fs.watch` on `projectsRoot()` catches brand-new workspace sub-dirs; (2) `fs.watch` per project dir catches new transcript files in known workspaces; (3) per-session expiry `setTimeout` drops aged-out sessions when nothing else writes to them; (4) a 60s `setInterval` safety poll backstops environments where `fs.watch` is unreliable (NFS, exhausted inotify, silent event drops). Orthogonally, the per-session-file watcher feeds `scheduleRefresh` with a `REFRESH_THROTTLE_MS` (5s) coalesce for transcript content updates; while any session is `active`, `syncStateTickers` schedules a one-shot reload `STATE_TICK_MS` (6s) out so the spinner can flip to check/warning even when nothing else writes to the transcript.
- **TodoWrite shape:** `content`, optional `activeForm` (used as label when `status === "in_progress"`), and `status ∈ {pending, in_progress, completed}`. `isValidTodo` enforces this — keep it in sync if upstream adds fields.
- **Tree node identity matters.** `item.id` is set on every `TreeItem` (`session:`, `info:`, `todo:` prefixes) so VSCode preserves expansion state across refreshes. Don't drop these when adding nodes.
- **Chrome diffing.** `updateChrome` compares `lastTitle` / `lastBadgeValue` / `lastState` before mutating the view to avoid flicker; preserve this pattern on any new chrome you wire in.
