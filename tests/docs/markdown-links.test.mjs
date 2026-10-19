import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findBrokenLinks,
  formatBrokenLink,
  selectFiles,
} from "../../scripts/docs/check-markdown-links.mjs";
import { gitLsFiles, readConfig } from "../../scripts/docs/markdown.mjs";
import { REPO_ROOT, makeFixture, removeFixture } from "./helpers.mjs";

describe("markdown link checker", () => {
  it("passes on the repository's maintained docs", () => {
    const files = selectFiles(
      gitLsFiles(REPO_ROOT, ["*.md"]),
      readConfig(REPO_ROOT).linkCheck
    );
    assert.ok(files.length > 0);
    assert.deepEqual(
      findBrokenLinks(REPO_ROOT, files).map(formatBrokenLink),
      []
    );
  });

  it("reports the source file, line, target, and resolved path of a broken link", () => {
    const dir = makeFixture({
      "README.md":
        "# Readme\n\n[guide](docs/guide.md)\n[gone](docs/moved.md#usage)\n",
      "docs/guide.md":
        "[back](../README.md) [dir](./) [site](https://example.com/x.md) [top](#guide)\n",
    });
    try {
      const broken = findBrokenLinks(dir, ["README.md", "docs/guide.md"]);
      assert.deepEqual(broken, [
        {
          source: "README.md",
          line: 4,
          target: "docs/moved.md#usage",
          resolved: "docs/moved.md",
        },
      ]);
      assert.equal(
        formatBrokenLink(broken[0]),
        'README.md:4: broken link "docs/moved.md#usage" -> docs/moved.md (not found)'
      );
    } finally {
      removeFixture(dir);
    }
  });

  it("reports links that escape the repository root even if the target exists outside it", () => {
    const dir = makeFixture({ "docs/a.md": "[out](../../package.json)\n" });
    try {
      assert.deepEqual(
        findBrokenLinks(dir, ["docs/a.md"]).map((b) => b.resolved),
        ["../package.json"]
      );
    } finally {
      removeFixture(dir);
    }
  });

  it("skips excluded files by explicit rule only", () => {
    const rules = {
      include: ["**/*.md"],
      exclude: [{ glob: "docs/TOOLS.md", reason: "generated" }],
    };
    assert.deepEqual(
      selectFiles(
        ["README.md", "docs/TOOLS.md", "docs/TOOLS.md.bak", "src/x.ts"],
        rules
      ),
      ["README.md"]
    );
  });

  it("documents a reason for every exclusion rule", () => {
    for (const rule of readConfig(REPO_ROOT).linkCheck.exclude) {
      assert.ok(rule.glob && rule.reason, JSON.stringify(rule));
    }
  });
});
