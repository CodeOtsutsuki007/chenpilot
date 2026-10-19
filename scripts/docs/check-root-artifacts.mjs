#!/usr/bin/env node
// Fails when terminal snapshots (command captures such as `_tsc.txt`) are
// tracked at the repository root, or when .gitignore stops ignoring them.
// Local diagnostics belong in the ignored `.artifacts/` directory.
//
// Usage: node scripts/docs/check-root-artifacts.mjs

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitLsFiles, matchesAny, readConfig } from "./markdown.mjs";

function isIgnored(root, relPath) {
  const result = spawnSync(
    "git",
    ["check-ignore", "-q", "--no-index", relPath],
    { cwd: root }
  );
  return result.status === 0;
}

/** Return a sorted list of human-readable problems; empty means clean. */
export function checkRootArtifacts(root, { patterns, artifactDir }) {
  const problems = [];

  const rootFiles = gitLsFiles(root, ["."]).filter(
    (file) => !file.includes("/")
  );
  for (const file of rootFiles.filter((f) => matchesAny(f, patterns))) {
    problems.push(
      `${file}: terminal snapshot in the repository root; move it to ${artifactDir}/ or delete it`
    );
  }

  for (const pattern of patterns) {
    const probe = pattern.replace(/\*/g, "snapshot-probe");
    if (!isIgnored(root, probe)) {
      problems.push(
        `.gitignore: root pattern "/${pattern}" is not ignored (probe: ${probe})`
      );
    }
  }
  const artifactProbe = `${artifactDir}/snapshot-probe.txt`;
  if (!isIgnored(root, artifactProbe)) {
    problems.push(
      `.gitignore: artifact directory "${artifactDir}/" is not ignored`
    );
  }

  return problems;
}

function main() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
  );
  const problems = checkRootArtifacts(root, readConfig(root).rootArtifacts);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} root artifact problem(s). See CONTRIBUTING.md "Local diagnostics".`
    );
    process.exit(1);
  }
  console.log("Root artifacts: OK (no tracked terminal snapshots).");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
