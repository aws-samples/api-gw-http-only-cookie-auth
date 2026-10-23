#!/usr/bin/env node
/**
 * Links the tracked hooks in .githooks/ into this clone's hooks directory.
 *
 * Deliberately does NOT change core.hooksPath: a global hooksPath (for example a
 * secret scanner) would otherwise be shadowed and silently disabled for this repo.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

let hooksDir;
try {
  // The repo's own hooks dir (shared by worktrees). Not `--git-path hooks`, which
  // follows core.hooksPath and would point at the global hooks directory.
  hooksDir = path.resolve(git("rev-parse", "--git-common-dir"), "hooks");
} catch {
  console.log("install-git-hooks: not a git repository, skipping");
  process.exit(0);
}

const sourceDir = path.join(__dirname, "..", ".githooks");
fs.mkdirSync(hooksDir, { recursive: true });

for (const name of fs.readdirSync(sourceDir)) {
  const source = path.join(sourceDir, name);
  const target = path.join(hooksDir, name);

  if (fs.existsSync(target) && !fs.lstatSync(target).isSymbolicLink()) {
    console.warn(`install-git-hooks: ${target} already exists and is not a link, leaving it untouched`);
    continue;
  }
  fs.rmSync(target, { force: true });
  try {
    fs.symlinkSync(path.relative(hooksDir, source), target);
  } catch {
    fs.copyFileSync(source, target); // e.g. Windows without symlink permission
  }
  fs.chmodSync(source, 0o755);
  console.log(`install-git-hooks: installed ${name}`);
}
