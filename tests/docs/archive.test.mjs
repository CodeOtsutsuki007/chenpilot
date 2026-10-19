import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkArchive,
  parseManifest,
} from "../../scripts/docs/check-archive.mjs";
import { gitLsFiles, readConfig } from "../../scripts/docs/markdown.mjs";
import { REPO_ROOT, makeFixture, removeFixture } from "./helpers.mjs";

const archive = { dir: "docs/archive", manifest: "docs/archive/README.md" };
const ARCHIVED = "docs/archive/implementation-reports/1-x/ISSUE_1_REPORT.md";
const MANIFEST = `# Archive\n\n| Archived path | Original path | Issue | Archived on |\n| --- | --- | --- | --- |\n| \`${ARCHIVED}\` | \`ISSUE_1_REPORT.md\` | #1 | 2026-10-19 |\n`;

function check(files) {
  const dir = makeFixture(files);
  try {
    return checkArchive(
      dir,
      archive,
      "INDEX.md",
      Object.keys(files)
        .filter((f) => f.endsWith(".md"))
        .sort()
    );
  } finally {
    removeFixture(dir);
  }
}

const valid = {
  "INDEX.md": `# Index\n- [report](${ARCHIVED})\n`,
  "docs/archive/README.md": MANIFEST,
  // Archived reports keep their sibling references unchanged.
  [ARCHIVED]: "# Report\nSee `ISSUE_1_REPORT.md`.\n",
  "docs/guide.md": `See [report](archive/implementation-reports/1-x/ISSUE_1_REPORT.md).\n`,
};

describe("archive policy check", () => {
  it("passes on the repository archive", () => {
    const config = readConfig(REPO_ROOT);
    assert.deepEqual(
      checkArchive(
        REPO_ROOT,
        config.archive,
        config.index.file,
        gitLsFiles(REPO_ROOT, ["*.md"])
      ),
      []
    );
  });

  it("parses manifest rows and skips the header", () => {
    assert.deepEqual(parseManifest(MANIFEST), [
      { line: 5, archived: ARCHIVED, original: "ISSUE_1_REPORT.md" },
    ]);
  });

  it("accepts a moved, listed, and indexed report", () => {
    assert.deepEqual(check(valid), []);
  });

  it("flags a copy left at the original path and a stale reference to it", () => {
    const problems = check({
      ...valid,
      "ISSUE_1_REPORT.md": "# Report\n",
      "docs/old.md": "Old notes: `ISSUE_1_REPORT.md`\n",
    });
    assert.deepEqual(problems, [
      "docs/archive/README.md:5: original path ISSUE_1_REPORT.md still exists; move it, do not copy it",
      `docs/old.md:1: "ISSUE_1_REPORT.md" was archived; use ${ARCHIVED}`,
    ]);
  });

  it("flags unlisted archive files, missing archived files, and unindexed reports", () => {
    const problems = check({
      "INDEX.md": "# Index\n",
      "docs/archive/README.md": MANIFEST,
      "docs/archive/stray.md": "# Stray\n",
    });
    assert.deepEqual(problems, [
      "docs/archive/stray.md:1: archived file is not listed in docs/archive/README.md",
      `docs/archive/README.md:5: archived file ${ARCHIVED} does not exist`,
      `docs/archive/README.md:5: ${ARCHIVED} is not linked from INDEX.md; run \`npm run docs:index\``,
    ]);
  });

  it("fails when the manifest is missing", () => {
    assert.deepEqual(check({ "INDEX.md": "# Index\n" }), [
      "docs/archive/README.md:1: archive manifest is missing",
    ]);
  });
});
