# Contributing to Claude Todos

Thanks for your interest in improving Claude Todos! This is a small, dependency-free
VS Code extension, so the contribution loop is quick.

## Development setup

```bash
git clone https://github.com/abslabs-io/claude-todos.git
cd claude-todos
npm install        # also wires up the pre-commit hook (typecheck + lint + test)
```

## Running it

Press `F5` in VS Code (or run **Debug: Start Debugging**) to launch an Extension
Development Host with the extension loaded. Open a folder where you use Claude Code
and look for the **Claude Todos** icon in the activity bar.

## Scripts

| Command                | What it does                         |
| ---------------------- | ------------------------------------ |
| `npm run build`        | Compile TypeScript to `out/`         |
| `npm run watch`        | Recompile on change                  |
| `npm run typecheck`    | Type-check `src` + `tests` (no emit) |
| `npm run lint`         | ESLint over `src` + `tests`          |
| `npm run format`       | Format with Prettier                 |
| `npm run format:check` | Verify formatting (what CI runs)     |
| `npm test`             | Run the vitest suite                 |
| `npm run package`      | Build a `.vsix`                      |

## Before you open a PR

1. `npm run typecheck && npm run lint && npm run format:check && npm test` all pass
   (the pre-commit hook runs typecheck, lint, and tests; bypass with
   `git commit --no-verify` only if you must).
2. Add or update tests for any logic change. Pure helpers live in `parser.ts`,
   `format.ts`, and the fs-bound parts of `sessionFinder.ts` — all unit-tested.
   VSCode-bound code in `extension.ts` is exercised via `F5`.
3. Keep changes focused and follow the existing patterns. See
   [AGENTS.md](AGENTS.md) for architecture notes and the project's conventions.

## Conventions

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/) —
  `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`.
- **Branches:** `feat/…`, `fix/…`, `chore/…`.
- **Target branch:** `main`.
- **Types:** strict TypeScript, no `any` (use `unknown` and narrow).

## Reporting issues

Use the [issue templates](https://github.com/abslabs-io/claude-todos/issues/new/choose).
Include your VS Code version, OS, and what you expected vs. what happened.
