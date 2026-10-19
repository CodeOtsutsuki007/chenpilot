#!/usr/bin/env node
// Validates relative links in maintained Markdown. External URLs and
// same-document anchors are skipped; generated or tool-owned Markdown is
// excluded by the explicit `linkCheck.exclude` rules in docs-check.config.json.
//
// Usage: node scripts/docs/check-markdown-links.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  extractLinks,
  gitLsFiles,
  isExternalOrAnchor,
  matchesAny,
  pathExists,
  readConfig,
  resolveLocalTarget,
} from "./markdown.mjs";

/** Files in scope: matched by `include` and not by any `exclude` glob. */
export function selectFiles(files, { include, exclude }) {
  const excludeGlobs = exclude.map((rule) => rule.glob);
  return files.filter(
    (f) => matchesAny(f, include) && !matchesAny(f, excludeGlobs)
  );
}

/**
 * Check every local link in `files` (repo-relative paths under `root`).
 * Returns broken links as { source, line, target, resolved }.
 */
export function findBrokenLinks(root, files) {
  const broken = [];
  for (const source of files) {
    const content = fs.readFileSync(path.join(root, source), "utf8");
    for (const { line, target } of extractLinks(content)) {
      if (isExternalOrAnchor(target)) continue;
      const resolved = resolveLocalTarget(source, target);
      if (!pathExists(root, resolved))
        broken.push({ source, line, target, resolved });
    }
  }
  return broken;
}

export function formatBrokenLink({ source, line, target, resolved }) {
  return `${source}:${line}: broken link "${target}" -> ${resolved} (not found)`;
}

function main() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
  );
  const files = selectFiles(
    gitLsFiles(root, ["*.md"]),
    readConfig(root).linkCheck
  );
  const broken = findBrokenLinks(root, files);
  for (const link of broken) console.error(formatBrokenLink(link));
  if (broken.length > 0) {
    console.error(
      `\n${broken.length} broken local link(s) in ${files.length} Markdown file(s).`
    );
    process.exit(1);
  }
  console.log(`Markdown links: OK (${files.length} files checked).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
