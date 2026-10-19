import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractCodePathRefs,
  extractHeadings,
  extractLinks,
  globToRegExp,
  isExternalOrAnchor,
  resolveLocalTarget,
} from "../../scripts/docs/markdown.mjs";

describe("extractLinks", () => {
  it("finds inline, image, titled, angle-bracket, and reference links with line numbers", () => {
    const md = [
      "See [guide](docs/guide.md) and ![diagram](img/a.png).",
      '[titled](./a.md "Title") <- here',
      "[spaced](<my file.md>)",
      "[ref]: ../other.md",
    ].join("\n");

    assert.deepEqual(extractLinks(md), [
      { line: 1, target: "docs/guide.md" },
      { line: 1, target: "img/a.png" },
      { line: 2, target: "./a.md" },
      { line: 3, target: "my file.md" },
      { line: 4, target: "../other.md" },
    ]);
  });

  it("ignores links inside fenced code blocks and inline code", () => {
    const md = [
      "```md",
      "[fenced](missing.md)",
      "```",
      "`[inline](missing.md)` [real](real.md)",
      "~~~",
      "[tilde](x.md)",
      "~~~",
    ].join("\n");

    assert.deepEqual(extractLinks(md), [{ line: 4, target: "real.md" }]);
  });

  it("treats an unclosed fence as code until end of file", () => {
    assert.deepEqual(extractLinks("```\n[a](b.md)"), []);
  });
});

describe("extractCodePathRefs and extractHeadings", () => {
  it("only treats file-like code spans as paths", () => {
    const md = "`src/a.ts` `formatAmount()` `README.md` `npm test` `x.txt`";
    assert.deepEqual(
      extractCodePathRefs(md).map((r) => r.target),
      ["src/a.ts", "README.md"]
    );
  });

  it("reads ATX headings and skips headings in code", () => {
    const md = "# Title\n```\n# not a heading\n```\n### Sub ###";
    assert.deepEqual(extractHeadings(md), [
      { line: 1, level: 1, text: "Title" },
      { line: 5, level: 3, text: "Sub" },
    ]);
  });
});

describe("isExternalOrAnchor", () => {
  it("skips URLs, protocol-relative links, mailto, and anchors", () => {
    for (const target of [
      "https://x.io/a.md",
      "mailto:a@b.c",
      "//cdn/x",
      "#section",
      "",
    ]) {
      assert.equal(isExternalOrAnchor(target), true, target);
    }
  });

  it("keeps relative and root-relative paths", () => {
    for (const target of [
      "a.md",
      "./a.md",
      "../a.md",
      "/docs/a.md",
      "a.md#frag",
    ]) {
      assert.equal(isExternalOrAnchor(target), false, target);
    }
  });
});

describe("resolveLocalTarget", () => {
  it("resolves relative to the source file and drops fragments and queries", () => {
    assert.equal(resolveLocalTarget("docs/a/b.md", "../c.md#x"), "docs/c.md");
    assert.equal(
      resolveLocalTarget("docs/b.md", "img.png?raw=1"),
      "docs/img.png"
    );
  });

  it("treats a leading slash as the repository root and decodes escapes", () => {
    assert.equal(
      resolveLocalTarget("docs/deep/b.md", "/README.md"),
      "README.md"
    );
    assert.equal(resolveLocalTarget("b.md", "my%20file.md"), "my file.md");
  });

  it("keeps paths that escape the repository so they can be reported", () => {
    assert.equal(
      resolveLocalTarget("docs/b.md", "../../outside.md"),
      "../outside.md"
    );
  });
});

describe("globToRegExp", () => {
  it("matches ** across zero or more directories and * within one segment", () => {
    assert.equal(globToRegExp("**/*.md").test("README.md"), true);
    assert.equal(globToRegExp("**/*.md").test("a/b/c.md"), true);
    assert.equal(globToRegExp("docs/*.md").test("docs/a/b.md"), false);
    assert.equal(globToRegExp(".kiro/**").test(".kiro/specs/x.md"), true);
    assert.equal(globToRegExp("_*.txt").test("_tsc.txt"), true);
    assert.equal(globToRegExp("_*.txt").test("docs/_tsc.txt"), false);
  });
});
