#!/usr/bin/env node
// Generates a throwaway ~/.claude/projects fixture for capturing a clean,
// privacy-safe Marketplace screenshot — three fake Claude Code sessions that
// exercise every session state (active / waiting / idle) and a range of
// context %, plus a sample workspace folder for one of them.
//
// The "Screenshot Demo" launch config (.vscode/launch.json) runs this as a
// preLaunchTask and points the Extension Development Host's HOME at the fixture
// (so the extension's os.homedir() resolves here, not your real ~/.claude),
// then opens the sample workspace. After F5, run "Developer: Reload Window"
// only if needed, then screenshot the sidebar + status bar.
//
// Standalone use: `node scripts/make-screenshot-fixture.js [fixtureRoot]`
// (default /tmp/claude-todos-screenshot). It prints the HOME and folder to open.

const fs = require("fs");
const path = require("path");

const FIX = process.argv[2] || "/tmp/claude-todos-screenshot";
const PROJECTS = path.join(FIX, ".claude", "projects");
const WORK = path.join(FIX, "work", "web-dashboard");

const now = Date.now();
const min = (m) => now - m * 60_000;
const iso = (ms) => new Date(ms).toISOString();

// --- session definitions -------------------------------------------------

const sessions = [
  {
    // ACTIVE (spinner) — sits at the opened workspace folder, so it drives the
    // view title/badge and the status-bar widget. Unresolved Bash => active.
    dir: "demo-web-dashboard",
    file: "0a1b2c3d-web.jsonl",
    cwd: WORK,
    ageMin: 1,
    title: "Add dark-mode toggle",
    userText: "Add a dark mode toggle to the dashboard settings panel.",
    model: "claude-opus-4-8", // 1M window
    usage: {
      input_tokens: 12_000,
      cache_creation_input_tokens: 8_000,
      cache_read_input_tokens: 320_000,
    }, // ~34%
    todos: [
      { content: "Audit existing theme tokens", status: "completed" },
      { content: "Add a ThemeProvider context", status: "completed" },
      {
        content: "Wire the toggle into the Settings panel",
        activeForm: "Wiring the toggle into the Settings panel",
        status: "in_progress",
      },
      { content: "Persist the preference to localStorage", status: "pending" },
      { content: "Refresh the docs screenshots", status: "pending" },
    ],
    final: {
      text: "Building to verify the toggle renders in both themes.",
      tool: { name: "Bash", id: "bash-1", input: { command: "npm run build" } },
    },
  },
  {
    // WAITING (warning) — unresolved AskUserQuestion is always "waiting".
    dir: "demo-api-server",
    file: "1b2c3d4e-api.jsonl",
    cwd: "/home/dev/code/api-server",
    ageMin: 4,
    title: "Fix flaky auth test",
    userText: "The auth integration test is flaky in CI.",
    model: "claude-sonnet-4-6", // 200k window
    usage: {
      input_tokens: 9_000,
      cache_creation_input_tokens: 3_000,
      cache_read_input_tokens: 110_000,
    }, // ~61%
    todos: [
      { content: "Reproduce the flake locally", status: "completed" },
      { content: "Trace the race in token refresh", status: "completed" },
      {
        content: "Choose fake-timers vs. an injected clock",
        activeForm: "Choosing fake-timers vs. an injected clock",
        status: "in_progress",
      },
      { content: "Add a regression test", status: "pending" },
    ],
    final: {
      text: "Two ways to make the clock deterministic — which do you prefer?",
      tool: {
        name: "AskUserQuestion",
        id: "ask-1",
        input: { questions: [{ question: "Fake timers or injected clock?" }] },
      },
    },
  },
  {
    // IDLE (check) — final assistant turn is text-only, nothing pending.
    dir: "demo-marketing-site",
    file: "2c3d4e5f-mkt.jsonl",
    cwd: "/home/dev/code/marketing-site",
    ageMin: 9,
    title: "Migrate to Vite",
    userText: "Migrate the build from webpack to Vite.",
    model: "claude-opus-4-8", // 1M window
    usage: {
      input_tokens: 10_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 170_000,
    }, // ~18%
    todos: [
      { content: "Replace the webpack config with Vite", status: "completed" },
      { content: "Port env-var handling to import.meta.env", status: "completed" },
      { content: "Verify the production build", status: "completed" },
    ],
    final: { text: "Done — the Vite migration is complete and the production build passes." },
  },
];

// --- transcript builder --------------------------------------------------

function buildLines(s) {
  const base = min(s.ageMin);
  const t = (i) => iso(base + i * 1000);
  const lines = [];

  // User request (carries cwd, read by transcriptCwd).
  lines.push({
    type: "user",
    cwd: s.cwd,
    sessionId: s.file,
    timestamp: t(0),
    message: { role: "user", content: [{ type: "text", text: s.userText }] },
  });

  // ai-title (read by findLatestTitle).
  lines.push({ type: "ai-title", aiTitle: s.title, cwd: s.cwd, timestamp: t(1) });

  // Assistant turn with the TodoWrite snapshot (read by findLatestTodos).
  lines.push({
    type: "assistant",
    cwd: s.cwd,
    sessionId: s.file,
    timestamp: t(2),
    message: {
      role: "assistant",
      model: s.model,
      usage: s.usage,
      content: [
        { type: "tool_use", name: "TodoWrite", id: "todowrite-1", input: { todos: s.todos } },
      ],
    },
  });

  // Resolve the TodoWrite so it isn't counted as a pending tool by the
  // state scan — otherwise every session would read as "waiting".
  lines.push({
    type: "user",
    cwd: s.cwd,
    timestamp: t(3),
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "todowrite-1", content: "Todos have been modified" },
      ],
    },
  });

  // Final assistant turn — drives both the displayed context % (latest usage)
  // and the inferred session state (its tool_use, if any, is left unresolved).
  const content = [{ type: "text", text: s.final.text }];
  if (s.final.tool) content.push({ type: "tool_use", ...s.final.tool });
  lines.push({
    type: "assistant",
    cwd: s.cwd,
    sessionId: s.file,
    timestamp: t(4),
    message: { role: "assistant", model: s.model, usage: s.usage, content },
  });

  return { lines, mtimeMs: base + 4000 };
}

// --- write the fixture ---------------------------------------------------

fs.rmSync(path.join(FIX, ".claude"), { recursive: true, force: true });
fs.rmSync(path.join(FIX, "work"), { recursive: true, force: true });

for (const s of sessions) {
  const dir = path.join(PROJECTS, s.dir);
  fs.mkdirSync(dir, { recursive: true });
  const { lines, mtimeMs } = buildLines(s);
  const file = path.join(dir, s.file);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const t = mtimeMs / 1000;
  fs.utimesSync(file, t, t);
}

// Sample workspace for the in-workspace (active) session, so the explorer
// looks like a real project and the workspace-cwd chrome populates.
fs.mkdirSync(path.join(WORK, "src"), { recursive: true });
fs.mkdirSync(path.join(WORK, ".vscode"), { recursive: true });
fs.writeFileSync(
  path.join(WORK, "README.md"),
  "# web-dashboard\n\nInternal analytics dashboard. (demo workspace for a screenshot)\n",
);
fs.writeFileSync(
  path.join(WORK, "package.json"),
  JSON.stringify({ name: "web-dashboard", version: "1.4.0", private: true }, null, 2) + "\n",
);
fs.writeFileSync(
  path.join(WORK, "src", "app.tsx"),
  "export function App() {\n  return <Dashboard />;\n}\n",
);
fs.writeFileSync(
  path.join(WORK, "src", "theme.ts"),
  "export const tokens = { bg: 'var(--bg)', fg: 'var(--fg)' };\n",
);
// Widen the active window so all three demo sessions show regardless of the
// user's global setting.
fs.writeFileSync(
  path.join(WORK, ".vscode", "settings.json"),
  JSON.stringify({ "claudeTodos.activeSessionMinutes": 60 }, null, 2) + "\n",
);

console.log("Screenshot fixture written.");
console.log(`  HOME for the EDH : ${FIX}`);
console.log(`  Folder to open   : ${WORK}`);
console.log("  Sessions:");
console.log("    • web-dashboard   active  (spinner)  opus  ~34%  3/5  [in workspace]");
console.log("    • api-server      waiting (warning)  sonnet ~61%  3/4");
console.log("    • marketing-site  idle    (check)    opus  ~18%  3/3");
console.log(
  '\nPress F5 on "Extension: Screenshot Demo", then screenshot the sidebar + status bar.',
);
