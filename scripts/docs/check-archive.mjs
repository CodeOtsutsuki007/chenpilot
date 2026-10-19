#!/usr/bin/env node
// Enforces docs/DOCUMENTATION_ARCHIVAL_POLICY.md for archived reports:
//   - every file under the archive directory is listed in the manifest,
//   - every manifest row points at an existing archived file and its
//     original path no longer exists (no duplicate copies),
//   - no maintained Markdown still references an original (pre-archive) path,
//   - every archived report is linked from the index.
//
// Usage: node scripts/docs/check-archive.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  extractCodePathRefs,
  extractLinks,
  gitLsFiles,
  isExternalOrAnchor,
  pathExists,
  proseLines,
  readConfig,
  resolveLocalTarget,
} from "./markdown.mjs";

/** Parse manifest table rows: | `archived` | `original` | issue | date | */
export function parseManifest(content) {
  const rows = [];
  for (const [line, text] of proseLines(content)) {
    if (!text.trim().startsWith("|")) continue;
    const paths = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (paths.length >= 2)
      rows.push({ line, archived: paths[0], original: paths[1] });
  }
  return rows;
}

/**
 * `mdFiles` are the repository Markdown files to scan for stale references.
 * Returns problems as strings prefixed with `file:line`.
 */
export function checkArchive(root, { dir, manifest }, indexFile, mdFiles) {
  const problems = [];
  if (!pathExists(root, manifest))
    return [`${manifest}:1: archive manifest is missing`];

  const rows = parseManifest(
    fs.readFileSync(path.join(root, manifest), "utf8")
  );
  const listed = new Set(rows.map((r) => r.archived));
  const inArchive = (f) => f.startsWith(`${dir}/`);

  for (const file of mdFiles.filter((f) => inArchive(f) && f !== manifest)) {
    if (!listed.has(file))
      problems.push(`${file}:1: archived file is not listed in ${manifest}`);
  }

  for (const { line, archived, original } of rows) {
    if (!inArchive(archived)) {
      problems.push(
        `${manifest}:${line}: archived path ${archived} is outside ${dir}/`
      );
    }
    if (!pathExists(root, archived)) {
      problems.push(
        `${manifest}:${line}: archived file ${archived} does not exist`
      );
    }
    if (pathExists(root, original)) {
      problems.push(
        `${manifest}:${line}: original path ${original} still exists; move it, do not copy it`
      );
    }
  }

  const originals = new Map(rows.map((r) => [r.original, r.archived]));
  for (const source of mdFiles.filter((f) => !inArchive(f))) {
    const content = fs.readFileSync(path.join(root, source), "utf8");
    const links = extractLinks(content)
      .filter((ref) => !isExternalOrAnchor(ref.target))
      .map((ref) => ({
        ...ref,
        candidates: [resolveLocalTarget(source, ref.target)],
      }));
    // Code-span paths are written repo-root-relative by convention, but may
    // also be relative to the file that mentions them.
    const codeRefs = extractCodePathRefs(content).map((ref) => ({
      ...ref,
      candidates: [
        path.posix.normalize(ref.target),
        resolveLocalTarget(source, ref.target),
      ],
    }));
    for (const { line, target, candidates } of [...links, ...codeRefs].sort(
      (a, b) => a.line - b.line
    )) {
      const hit = candidates.find((c) => originals.has(c));
      if (hit)
        problems.push(
          `${source}:${line}: "${target}" was archived; use ${originals.get(hit)}`
        );
    }
  }

  const indexContent = pathExists(root, indexFile)
    ? fs.readFileSync(path.join(root, indexFile), "utf8")
    : "";
  const indexed = new Set(
    extractLinks(indexContent)
      .filter((ref) => !isExternalOrAnchor(ref.target))
      .map((ref) => resolveLocalTarget(indexFile, ref.target))
  );
  for (const { line, archived } of rows) {
    if (!indexed.has(archived)) {
      problems.push(
        `${manifest}:${line}: ${archived} is not linked from ${indexFile}; run \`npm run docs:index\``
      );
    }
  }

  return problems;
}

function main() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
  );
  const config = readConfig(root);
  const problems = checkArchive(
    root,
    config.archive,
    config.index.file,
    gitLsFiles(root, ["*.md"])
  );
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} archive problem(s). See docs/DOCUMENTATION_ARCHIVAL_POLICY.md.`
    );
    process.exit(1);
  }
  console.log("Archive: OK.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
