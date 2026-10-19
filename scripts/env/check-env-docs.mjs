#!/usr/bin/env node
// Validates the environment variable registry (scripts/env/env-registry.json)
// against the source tree and its generated documentation:
//   - every variable referenced in scanned source has a registry entry, a
//     matching family entry (`DEFI_*`), or an explicit exemption,
//   - every exact registry entry is still referenced somewhere,
//   - entries are well formed (owner, requiredness, secret status, ...),
//   - required variables appear in .env.example so contributors see them,
//   - the generated table in docs/ENVIRONMENT_VARIABLES.md is up to date.
//
// Usage:
//   node scripts/env/check-env-docs.mjs          # check (CI)
//   node scripts/env/check-env-docs.mjs --write  # regenerate the doc table

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  REGISTRY_FILE,
  applyTable,
  collectReferences,
  findCoverage,
  isFamily,
  parseDotenv,
  readRegistry,
  renderTable,
} from "./env-registry.mjs";

const ENV_EXAMPLE = ".env.example";

/** Structural problems in the registry itself. */
export function validateRegistry(registry) {
  const problems = [];
  const seen = new Set();
  const services = Object.keys(registry.services ?? {});
  for (const v of registry.variables) {
    const where = `${REGISTRY_FILE}: ${v.name ?? "<unnamed>"}`;
    if (!v.name) problems.push(`${where}: entry has no name`);
    if (seen.has(v.name)) problems.push(`${where}: duplicate entry`);
    seen.add(v.name);
    if (!services.includes(v.service))
      problems.push(`${where}: unknown service "${v.service}"`);
    for (const field of ["owner", "description"]) {
      if (typeof v[field] !== "string" || v[field].trim() === "")
        problems.push(`${where}: missing ${field}`);
    }
    if (typeof v.required !== "boolean")
      problems.push(`${where}: "required" must be true or false`);
    if (typeof v.secret !== "boolean")
      problems.push(`${where}: "secret" must be true or false`);
    if (!("default" in v))
      problems.push(`${where}: missing "default" (use null for none)`);
    if ((v.required || v.requiredUnless || v.validate) && isFamily(v.name))
      problems.push(`${where}: a family entry cannot be required or validated`);
  }
  for (const e of registry.exemptions ?? []) {
    if (!e.pattern || !e.reason?.trim())
      problems.push(
        `${REGISTRY_FILE}: exemption ${e.pattern ?? "<unnamed>"} needs a pattern and a reason`
      );
  }
  return problems;
}

/**
 * Compare the registry with the references found in source.
 * `refs` is a Map of name -> ["file:line", ...].
 */
export function checkCoverage(registry, refs) {
  const problems = [];
  for (const [name, locations] of refs) {
    if (!findCoverage(registry, name)) {
      problems.push(
        `${locations[0]}: ${name} is referenced but not documented in ${REGISTRY_FILE}; add an entry or an exemption with a reason`
      );
    }
  }
  for (const v of registry.variables) {
    if (!isFamily(v.name) && !refs.has(v.name)) {
      problems.push(
        `${REGISTRY_FILE}: ${v.name} is documented but no scanned source references it; remove the entry or fix the scan`
      );
    }
  }
  return problems;
}

/** Required variables must be present (even if blank) in .env.example. */
export function checkEnvExample(registry, exampleContent) {
  if (exampleContent === null) return [`${ENV_EXAMPLE}: file is missing`];
  const keys = parseDotenv(exampleContent);
  return registry.variables
    .filter((v) => v.required === true && !isFamily(v.name))
    .filter((v) => !keys.has(v.name))
    .map(
      (v) =>
        `${ENV_EXAMPLE}: required variable ${v.name} is missing; add \`${v.name}=\` with a placeholder`
    );
}

export function checkDoc(registry, docContent) {
  const { file, begin, end } = registry.doc;
  if (docContent === null) return [`${file}: file is missing`];
  const expected = applyTable(
    docContent,
    { begin, end },
    renderTable(registry)
  );
  if (expected === null)
    return [`${file}: generated block markers are missing or out of order`];
  if (expected !== docContent)
    return [
      `${file}: generated table is out of date; run \`npm run env:docs\``,
    ];
  return [];
}

function readOrNull(root, rel) {
  const file = path.join(root, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

export function checkEnvDocs(root, registry = readRegistry(root)) {
  const structural = validateRegistry(registry);
  if (structural.length > 0) return structural;
  return [
    ...checkCoverage(registry, collectReferences(root, registry.scan)),
    ...checkEnvExample(registry, readOrNull(root, ENV_EXAMPLE)),
    ...checkDoc(registry, readOrNull(root, registry.doc.file)),
  ];
}

function main() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
  );
  const registry = readRegistry(root);

  if (process.argv.includes("--write")) {
    const { file, begin, end } = registry.doc;
    const current = readOrNull(root, file);
    const next =
      current === null
        ? null
        : applyTable(current, { begin, end }, renderTable(registry));
    if (next === null) {
      console.error(
        `${file}: generated block markers are missing; add them first.`
      );
      process.exit(1);
    }
    fs.writeFileSync(path.join(root, file), next);
    console.log(`Wrote ${file}.`);
    return;
  }

  const problems = checkEnvDocs(root, registry);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} environment variable documentation problem(s). See docs/ENVIRONMENT_VARIABLES.md.`
    );
    process.exit(1);
  }
  console.log(
    `Environment variables: OK (${registry.variables.length} entries, ${(registry.exemptions ?? []).length} exemptions).`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
