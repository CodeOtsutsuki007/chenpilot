import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

/** Create a temporary directory populated with `files` ({ relPath: content }). */
export function makeFixture(files, { git = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-check-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  if (git) execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

export function removeFixture(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
