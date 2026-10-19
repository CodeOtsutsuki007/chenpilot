import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { checkRootArtifacts } from "../../scripts/docs/check-root-artifacts.mjs";
import { readConfig } from "../../scripts/docs/markdown.mjs";
import { REPO_ROOT, makeFixture, removeFixture } from "./helpers.mjs";

const config = readConfig(REPO_ROOT).rootArtifacts;
const gitignore = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");

function ignoredInRepo(relPath) {
  return (
    spawnSync("git", ["check-ignore", "-q", "--no-index", relPath], {
      cwd: REPO_ROOT,
    }).status === 0
  );
}

describe("root terminal snapshots", () => {
  it("the repository has no root snapshots and ignores new ones", () => {
    assert.deepEqual(checkRootArtifacts(REPO_ROOT, config), []);
  });

  it("ignores root snapshots and the artifact directory, but not nested or non-txt files", () => {
    assert.equal(ignoredInRepo("_tsc.txt"), true);
    assert.equal(ignoredInRepo(".artifacts/jest-run.log"), true);
    // Boundary: the rule is anchored to the root; fixtures elsewhere stay trackable.
    assert.equal(ignoredInRepo("tests/fixtures/_sample.txt"), false);
    assert.equal(ignoredInRepo("_notes.md"), false);
  });

  it("reports a snapshot at the root and a .gitignore without the rule", () => {
    const dir = makeFixture(
      { "_gstatus.txt": " M file\n", "README.md": "# x\n" },
      { git: true }
    );
    try {
      assert.deepEqual(checkRootArtifacts(dir, config), [
        "_gstatus.txt: terminal snapshot in the repository root; move it to .artifacts/ or delete it",
        '.gitignore: root pattern "/_*.txt" is not ignored (probe: _snapshot-probe.txt)',
        '.gitignore: artifact directory ".artifacts/" is not ignored',
      ]);
    } finally {
      removeFixture(dir);
    }
  });

  it("accepts nested underscore files when the repository rule is present", () => {
    const dir = makeFixture(
      {
        ".gitignore": gitignore,
        "docs/_notes.txt": "kept\n",
        "_scratch.txt": "ignored\n",
      },
      { git: true }
    );
    try {
      assert.deepEqual(checkRootArtifacts(dir, config), []);
    } finally {
      removeFixture(dir);
    }
  });
});
