#!/usr/bin/env node
// Registers .githooks/ as the project's hook directory.
// Runs from the `prepare` npm lifecycle script. Silent no-op when the
// install isn't happening inside a git checkout (e.g., tarball / CI).
const { execSync } = require("child_process");

function silent(cmd) {
  try {
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!silent("git rev-parse --git-dir")) process.exit(0);
silent("git config core.hooksPath .githooks");
