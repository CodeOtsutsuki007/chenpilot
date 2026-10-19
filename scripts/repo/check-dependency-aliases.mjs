#!/usr/bin/env node
// Inventory of packages published under more than one name (for example the
// deprecated `stellar-sdk` and its successor `@stellar/stellar-sdk`). For every
// workspace, compares what its manifest declares with what its source files
// import, and fails when:
//   - a file imports an alias its own workspace does not declare (it only
//     resolves through hoisting, so removing another workspace's copy breaks it);
//   - a manifest declares an alias that nothing in the workspace imports;
//   - a manifest declares more than one alias of the same package.
//
// Usage: node scripts/repo/check-dependency-aliases.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitLsFiles, matchesAny } from "../docs/markdown.mjs";
import { readRepoConfig } from "./config.mjs";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bjest\.(?:mock|doMock|requireActual)\s*\(\s*|\bdeclare\s+module\s+)(["'])([^"'\s]+)\1/g;

/** `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`; null for relative paths. */
export function packageName(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Yield { line, name } for every module specifier in `content`. */
export function* moduleReferences(content) {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(SPECIFIER)) {
      const name = packageName(m[2]);
      if (name) yield { line: i + 1, name };
    }
  }
}

/** The most specific workspace directory that contains `file`. */
export function owningWorkspace(file, workspaces) {
  return workspaces
    .filter((ws) => ws === "." || file.startsWith(`${ws}/`))
    .sort((a, b) => b.length - a.length)[0];
}

/**
 * Per workspace: which aliases the manifest declares (with the field) and
 * where each alias is imported.
 */
export function inventory(root, config, files = gitLsFiles(root, ["."])) {
  const aliases = new Set(config.groups.flatMap((g) => g.packages));
  const result = new Map();
  for (const ws of config.workspaces) {
    const manifestPath = path.posix.join(ws, "package.json");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, manifestPath), "utf8")
    );
    const declared = new Map();
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (aliases.has(name)) declared.set(name, field);
      }
    }
    result.set(ws, { manifest: manifestPath, declared, imports: new Map() });
  }

  // `exclude` covers this checker's own test fixtures, whose import strings are data.
  const sources = files.filter(
    (f) => matchesAny(f, config.sources) && !matchesAny(f, config.exclude ?? [])
  );
  for (const file of sources) {
    if (file.split("/").includes("node_modules")) continue;
    const entry = result.get(owningWorkspace(file, config.workspaces));
    const content = fs.readFileSync(path.join(root, file), "utf8");
    for (const { line, name } of moduleReferences(content)) {
      if (!aliases.has(name)) continue;
      if (!entry.imports.has(name)) entry.imports.set(name, []);
      entry.imports.get(name).push(`${file}:${line}`);
    }
  }
  return result;
}

/** Return a sorted list of human-readable problems; empty means clean. */
export function checkDependencyAliases(root, config, files) {
  const problems = [];
  for (const [ws, { manifest, declared, imports }] of inventory(
    root,
    config,
    files
  )) {
    for (const [name, locations] of imports) {
      if (declared.has(name)) continue;
      for (const location of locations) {
        problems.push(
          `${location}: imports "${name}", which ${manifest} does not declare; it resolves only through another workspace's install`
        );
      }
    }
    for (const [name, field] of declared) {
      if (!imports.has(name)) {
        problems.push(
          `${manifest}: ${field}.${name} is declared but nothing in workspace "${ws}" imports it; remove it`
        );
      }
    }
    for (const group of config.groups) {
      const both = group.packages.filter((name) => declared.has(name));
      if (both.length > 1) {
        problems.push(
          `${manifest}: declares ${both.join(" and ")}, which are aliases of one package; keep one (${group.reason})`
        );
      }
    }
  }
  return problems.sort();
}

function main() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
  );
  const config = readRepoConfig(root).dependencyAliases;
  const problems = checkDependencyAliases(root, config);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} dependency alias problem(s). See CONTRIBUTING.md "Repository checks".`
    );
    process.exit(1);
  }
  for (const [ws, { declared, imports }] of inventory(root, config)) {
    const names = [...new Set([...declared.keys(), ...imports.keys()])].sort();
    const summary = names.map(
      (n) => `${n} (${declared.get(n)}, ${imports.get(n).length} import(s))`
    );
    console.log(`${ws}: ${summary.join(", ") || "none"}`);
  }
  console.log(
    "Dependency aliases: OK (every alias is declared where it is imported, and imported where it is declared)."
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
