#!/usr/bin/env node
// Keeps the maintained implementation index (INDEX.md) from drifting:
//   - flags duplicate section headings and duplicate documentation links,
//   - flags stale paths (links or `path/to/file.ext` references that no longer exist),
//   - verifies the generated "Documentation Map" block is current.
//
// Usage:
//   node scripts/docs/check-doc-index.mjs           # check (CI)
//   node scripts/docs/check-doc-index.mjs --write   # regenerate the docs map

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  extractCodePathRefs,
  extractHeadings,
  extractLinks,
  gitLsFiles,
  isExternalOrAnchor,
  matchesAny,
  pathExists,
  readConfig,
  resolveLocalTarget,
} from "./markdown.mjs";

const REGENERATE = "npm run docs:index";

/** Normalize heading text so "✅ Status" and "status" compare equal. */
export function normalizeHeading(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#]+/gu, " ")
    .trim();
}

/** Locate the generated block; returns line indexes (0-based) or null. */
function findBlock(lines, { begin, end }) {
  const start = lines.indexOf(begin);
  const stop = lines.indexOf(end);
  if (start === -1 || stop === -1 || stop < start) return null;
  return { start, stop };
}

/** Render the generated docs map body for the given Markdown files. */
export function renderDocsMap(root, files) {
  const entries = files.map((file) => {
    const content = fs.readFileSync(path.join(root, file), "utf8");
    const title =
      extractHeadings(content).find((h) => h.level === 1)?.text ??
      path.basename(file);
    return `- [${file}](${file}) — ${title}`;
  });
  return entries.join("\n");
}

/** Return the index content with its generated block replaced (or appended). */
export function applyDocsMap(content, docsMap, body) {
  const lines = content.split("\n");
  const block = findBlock(lines, docsMap);
  const generated = [docsMap.begin, "", body, "", docsMap.end];
  if (block === null) {
    const trimmed = content.replace(/\s+$/, "");
    return `${trimmed}\n\n---\n\n## Documentation Map\n\n${generated.join("\n")}\n`;
  }
  return [
    ...lines.slice(0, block.start),
    ...generated,
    ...lines.slice(block.stop + 1),
  ].join("\n");
}

/**
 * Check an index file. `docsFiles` are the Markdown files the generated map
 * must list. Returns problems as strings prefixed with `file:line`.
 */
export function checkIndex(root, indexFile, docsMap, docsFiles) {
  const content = fs.readFileSync(path.join(root, indexFile), "utf8");
  const lines = content.split("\n");
  const problems = [];

  const block = findBlock(lines, docsMap);
  if (block === null) {
    problems.push(
      `${indexFile}:1: generated docs map markers are missing; run \`${REGENERATE}\``
    );
  } else {
    const expected = applyDocsMap(
      content,
      docsMap,
      renderDocsMap(root, docsFiles)
    );
    if (expected !== content) {
      problems.push(
        `${indexFile}:${block.start + 1}: generated docs map is out of date; run \`${REGENERATE}\``
      );
    }
  }

  // Curated content only: blank the generated block but keep line numbers.
  const curated = lines
    .map((line, i) =>
      block && i >= block.start && i <= block.stop ? "" : line
    )
    .join("\n");

  const seenHeadings = new Map();
  for (const { line, text } of extractHeadings(curated)) {
    const key = normalizeHeading(text);
    if (seenHeadings.has(key)) {
      problems.push(
        `${indexFile}:${line}: duplicate section "${text}" (first at line ${seenHeadings.get(key)})`
      );
    } else {
      seenHeadings.set(key, line);
    }
  }

  const refs = [
    ...extractLinks(curated).filter((ref) => !isExternalOrAnchor(ref.target)),
    ...extractCodePathRefs(curated),
  ].sort((a, b) => a.line - b.line);

  const seenDocs = new Map();
  for (const { line, target } of refs) {
    const resolved = resolveLocalTarget(indexFile, target);
    if (!pathExists(root, resolved)) {
      problems.push(
        `${indexFile}:${line}: stale path "${target}" -> ${resolved} (not found)`
      );
      continue;
    }
    if (!resolved.endsWith(".md")) continue;
    if (seenDocs.has(resolved)) {
      problems.push(
        `${indexFile}:${line}: duplicate link to ${resolved} (first at line ${seenDocs.get(resolved)})`
      );
    } else {
      seenDocs.set(resolved, line);
    }
  }

  return problems;
}

function main() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
  );
  const { file, docsMap } = readConfig(root).index;
  const docsFiles = gitLsFiles(root, ["*.md"]).filter((f) =>
    matchesAny(f, docsMap.include)
  );

  if (process.argv.includes("--write")) {
    const indexPath = path.join(root, file);
    const content = fs.readFileSync(indexPath, "utf8");
    fs.writeFileSync(
      indexPath,
      applyDocsMap(content, docsMap, renderDocsMap(root, docsFiles))
    );
    console.log(
      `Regenerated docs map in ${file} (${docsFiles.length} entries).`
    );
    return;
  }

  const problems = checkIndex(root, file, docsMap, docsFiles);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(`\n${problems.length} index problem(s) in ${file}.`);
    process.exit(1);
  }
  console.log(`Index: OK (${file}).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
