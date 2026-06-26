# Changelog

All notable changes to the Coding Session Todos extension are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.1]

- Fixed the status bar intermittently collapsing to a bare icon while a session
  was clearly running. Reading the **latest** `cwd` (added in 0.0.17) also picked
  up transient excursions into the agent's scratchpad under the OS temp dir, which
  no longer matched the workspace; cwd values inside `os.tmpdir()` are now skipped,
  so a mid-session folder rename is still followed but a scratchpad detour is not.
- Made status-bar/title session selection workspace-shape-aware: it now considers
  **every** folder open in the window (not just the first), so multi-root
  workspaces resolve correctly, and an empty/single-file window reflects the most
  recently active session instead of showing nothing.
- Changed the default for `codingSessionTodos.activeSessionMinutes` from 30 to
  **300 (5 hours)**.

## [0.1.0]

- Restyled the Marketplace icon: the white checklist now sits on a diagonal
  violet→fuchsia gradient (replacing the black background) and is scaled down
  slightly for more padding around the rounded square.

## [0.0.17]

- Fixed sessions being matched to the directory they _started_ in: the extension
  now reads the **latest** `cwd` recorded in a transcript rather than the first.
  A session whose project folder was renamed mid-session (so its original path no
  longer exists) is again matched to its workspace, and its state and context
  show in the status bar instead of collapsing to a bare icon.
- Redesigned the Marketplace icon as a white checklist on a black rounded square,
  matching the activity-bar logo.

## [0.0.16]

- First public release on the Visual Studio Code Marketplace, published under the
  `abslabs` publisher.

## [0.0.15]

- Renamed the extension to **Coding Session Todos** (extension id
  `coding-session-todos`), updating the activity-bar container, view, commands,
  settings key, and context key to match.
- README now calls out cross-window visibility — a single panel shows every Claude
  Code session across all your open windows — and notes that only Claude Code is
  supported for now.
- Grouped the command-palette entries under a **Coding Session Todos** category with
  shorter titles, and broadened the Marketplace keywords (todo, to-do, to do, …).

## [0.0.14]

- Sidebar TreeView mirroring the live `TodoWrite` list for every active Claude
  Code session, sorted most-recent-first.
- Per-session inferred state (active / waiting / idle) with spinner, warning, and
  check icons.
- Context-window usage shown per session and in the status bar, matching Claude
  Code's `/context`.
- Always-visible status-bar widget reflecting the session in the current
  workspace, with a tooltip listing every active session.
- `codingSessionTodos.activeSessionMinutes` setting (default 30) controlling the active
  window.
