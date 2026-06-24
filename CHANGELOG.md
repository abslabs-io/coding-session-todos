# Changelog

All notable changes to the Claude Todos extension are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## [0.0.14]

- Sidebar TreeView mirroring the live `TodoWrite` list for every active Claude
  Code session, sorted most-recent-first.
- Per-session inferred state (active / waiting / idle) with spinner, warning, and
  check icons.
- Context-window usage shown per session and in the status bar, matching Claude
  Code's `/context`.
- Always-visible status-bar widget reflecting the session in the current
  workspace, with a tooltip listing every active session.
- `claudeTodos.activeSessionMinutes` setting (default 30) controlling the active
  window.
