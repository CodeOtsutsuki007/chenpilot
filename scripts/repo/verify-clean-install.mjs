#!/usr/bin/env node
// Runs the supported clean-install command (installWorkflow.command in
// repo-check.config.json) and fails if it fails, or if it changed a lockfile
// or any other file Git tracks. Run it from a fresh checkout; CI does.
//
// Usage: node scripts/repo/verify-clean-install.mjs

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readRepoConfig } from "./config.mjs";

/** Lockfile hashes plus the working-tree status Git reports. */
export function snapshot(root, lockfiles) {
  const hashes = {};
  for (const file of lockfiles) {
    const abs = path.join(root, file);
    hashes[file] = fs.existsSync(abs)
      ? crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex")
      : null;
  }
  const status = execFileSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    {
      cwd: root,
      encoding: "utf8",
    }
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  return { hashes, status };
}

/** Return a list of human-readable problems describing what changed. */
export function diffSnapshots(before, after) {
  const problems = [];
  for (const [file, hash] of Object.entries(before.hashes)) {
    if (hash === null)
      problems.push(
        `${file}: lockfile is missing; the install cannot be reproducible`
      );
    else if (after.hashes[file] !== hash)
      problems.push(`${file}: the install modified the lockfile`);
  }
  const previous = new Set(before.status);
  for (const entry of after.status.filter((e) => !previous.has(e))) {
    problems.push(
      `${entry.slice(3)}: the install changed the working tree (git status "${entry.slice(0, 2).trim()}")`
    );
  }
  return problems;
}

/** Run `command` in `root`; return problems (empty means the install was clean). */
export function verifyCleanInstall(root, { command, lockfiles }) {
  const before = snapshot(root, lockfiles);
  const [bin, ...args] = command;
  const result = spawnSync(bin, args, { cwd: root, stdio: "inherit" });
  if (result.error)
    return [
      `\`${command.join(" ")}\` could not start: ${result.error.message}`,
    ];
  if (result.status !== 0)
    return [`\`${command.join(" ")}\` exited with status ${result.status}`];
  return diffSnapshots(before, snapshot(root, lockfiles));
}

function main() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
  );
  const config = readRepoConfig(root).installWorkflow;
  const problems = verifyCleanInstall(root, config);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(
      `\nClean install failed. See CONTRIBUTING.md "Getting Started".`
    );
    process.exit(1);
  }
  console.log(
    `Clean install: OK (\`${config.command.join(" ")}\` left the lockfile and tracked files unchanged).`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
