# Claude Todos

A VSCode sidebar that mirrors the `TodoWrite` list from the active Claude Code
session for the current workspace. Tails the transcript JSONL files under
`~/.claude/projects/` and re-renders on every change.

## Build

```bash
npm install
npm run build
```

This compiles TypeScript into `out/`.

## Run in dev (Extension Development Host)

1. Open this folder in VSCode.
2. Press `F5` (or run "Debug: Start Debugging").
3. A second VSCode window opens with the extension loaded.
4. Open a folder where you use Claude Code, find the **Claude Todos** icon in
   the activity bar.

## Install locally

```bash
npm install -g @vscode/vsce
vsce package        # produces claude-todos-0.0.1.vsix
code --install-extension claude-todos-0.0.1.vsix
```

## How it works

- Resolves the workspace's transcript folder:
  `~/.claude/projects/<cwd-with-slashes-replaced-by-dashes>/`
- Picks the most-recently-modified `*.jsonl` as the active session.
- Reads the trailing ~1MB of that file, scans backward for the latest
  `"name":"TodoWrite"` tool use, and renders `input.todos`.
- Re-reads on file change (debounced) and re-picks the session on directory
  change (in case a new session starts).

## Known limitations (v0.0.1)

- Picks one session per workspace based on mtime. If you have multiple Claude
  conversations open in the same folder, it will follow the most recently
  active one.
- No grouping / filtering / reorder — flat list mirroring inline rendering.
- Activity bar icon is a placeholder SVG.
