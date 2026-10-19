import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  applyDocsMap,
  checkIndex,
  normalizeHeading,
  renderDocsMap,
} from "../../scripts/docs/check-doc-index.mjs";
import {
  gitLsFiles,
  matchesAny,
  readConfig,
} from "../../scripts/docs/markdown.mjs";
import { REPO_ROOT, makeFixture, removeFixture } from "./helpers.mjs";

const docsMap = {
  begin: "<!-- BEGIN GENERATED: docs-map (npm run docs:index) -->",
  end: "<!-- END GENERATED: docs-map -->",
};
const DOCS = {
  "docs/a.md": "# Alpha\n",
  "docs/b.md": "no heading\n",
  "src/x.ts": "",
};

function withIndex(curated, files, fn) {
  const dir = makeFixture({ ...DOCS, "INDEX.md": curated });
  try {
    const body = renderDocsMap(dir, files);
    fs.writeFileSync(
      path.join(dir, "INDEX.md"),
      applyDocsMap(curated, docsMap, body)
    );
    return fn(dir);
  } finally {
    removeFixture(dir);
  }
}

describe("documentation index check", () => {
  it("passes on the repository INDEX.md", () => {
    const { file, docsMap: config } = readConfig(REPO_ROOT).index;
    const docsFiles = gitLsFiles(REPO_ROOT, ["*.md"]).filter((f) =>
      matchesAny(f, config.include)
    );
    assert.deepEqual(checkIndex(REPO_ROOT, file, config, docsFiles), []);
  });

  it("accepts a clean index whose generated map also links curated docs", () => {
    const curated =
      "# Index\n\n### #1 - Alpha\n- `docs/a.md`\n- `src/x.ts`\n\n### #2 - Beta\n- `src/x.ts`\n";
    // Boundary: the same source file in two entries and a doc in both the
    // curated part and the generated map are not duplicates.
    withIndex(curated, ["docs/a.md", "docs/b.md"], (dir) => {
      assert.deepEqual(
        checkIndex(dir, "INDEX.md", docsMap, ["docs/a.md", "docs/b.md"]),
        []
      );
    });
  });

  it("flags duplicate sections, duplicate doc links, and stale paths with line numbers", () => {
    const curated = [
      "# Index",
      "## Integration Points",
      "- [A](docs/a.md)",
      "### ✅ Integration points",
      "- `docs/a.md`",
      "- `docs/removed.md`",
      "- [gone](src/gone.ts)",
    ].join("\n");
    withIndex(curated, ["docs/a.md"], (dir) => {
      assert.deepEqual(checkIndex(dir, "INDEX.md", docsMap, ["docs/a.md"]), [
        'INDEX.md:4: duplicate section "✅ Integration points" (first at line 2)',
        "INDEX.md:5: duplicate link to docs/a.md (first at line 3)",
        'INDEX.md:6: stale path "docs/removed.md" -> docs/removed.md (not found)',
        'INDEX.md:7: stale path "src/gone.ts" -> src/gone.ts (not found)',
      ]);
    });
  });

  it("flags a missing or out-of-date generated docs map", () => {
    const dir = makeFixture({ ...DOCS, "INDEX.md": "# Index\n" });
    try {
      assert.deepEqual(checkIndex(dir, "INDEX.md", docsMap, ["docs/a.md"]), [
        "INDEX.md:1: generated docs map markers are missing; run `npm run docs:index`",
      ]);
      const stale = applyDocsMap(
        "# Index\n",
        docsMap,
        renderDocsMap(dir, ["docs/a.md"])
      );
      fs.writeFileSync(path.join(dir, "INDEX.md"), stale);
      const problems = checkIndex(dir, "INDEX.md", docsMap, [
        "docs/a.md",
        "docs/b.md",
      ]);
      assert.equal(problems.length, 1);
      assert.match(
        problems[0],
        /generated docs map is out of date; run `npm run docs:index`/
      );
    } finally {
      removeFixture(dir);
    }
  });

  it("regenerates deterministically and falls back to the file name for untitled docs", () => {
    const dir = makeFixture(DOCS);
    try {
      const body = renderDocsMap(dir, ["docs/a.md", "docs/b.md"]);
      assert.equal(
        body,
        "- [docs/a.md](docs/a.md) — Alpha\n- [docs/b.md](docs/b.md) — b.md"
      );
      const once = applyDocsMap("# Index\n", docsMap, body);
      assert.equal(applyDocsMap(once, docsMap, body), once);
    } finally {
      removeFixture(dir);
    }
  });

  it("normalizes headings ignoring emoji, case, and punctuation", () => {
    assert.equal(
      normalizeHeading("✅ Criterion 1: Separators"),
      normalizeHeading("criterion 1 - separators")
    );
    assert.notEqual(
      normalizeHeading("#683 - Formatting"),
      normalizeHeading("#684 - Formatting")
    );
  });
});
