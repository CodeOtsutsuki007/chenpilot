#!/usr/bin/env node
// Static checks for TypeORM migrations, enforcing the conventions in
// docs/DATA_MIGRATIONS.md:
//   - file name is `<13-digit epoch ms>-<Name>.ts`,
//   - one exported class implementing MigrationInterface whose name ends with
//     the file timestamp, and a `name` property (when set) equal to it,
//   - both `up` and `down` are defined,
//   - `CREATE/DROP INDEX CONCURRENTLY` only in a migration with
//     `transaction = false` (PostgreSQL refuses it inside a transaction),
//   - `transaction = true` is not set (it breaks the default `all` mode),
//   - timestamps are unique, except explicit, reasoned exemptions.
//
// Usage: node scripts/migrations/check-migrations.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CONFIG_FILE = "scripts/migrations/migrations-check.config.json";

const FILE_NAME = /^(\d{13})-([A-Za-z][A-Za-z0-9-]*)\.ts$/;
const CLASS = /export\s+class\s+(\w+)\s+implements\s+MigrationInterface\b/g;
const NAME_PROP = /^\s*(?:public\s+)?name\s*=\s*["'`]([^"'`]+)["'`]/m;
const TX_PROP = /^\s*(?:public\s+)?transaction\s*=\s*(true|false)\b/m;
const CONCURRENTLY =
  /\b(?:CREATE|DROP)\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i;

export function readConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8"));
}

/** Strip comments so documentation inside a migration is not checked as code. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/**
 * Check one migration file. Returns { timestamp, problems } where problems
 * are strings prefixed with the file path.
 */
export function checkMigrationFile(file, source) {
  const problems = [];
  const report = (msg) => problems.push(`${file}: ${msg}`);
  const base = path.posix.basename(file);
  const nameMatch = base.match(FILE_NAME);
  if (!nameMatch) {
    report(
      "file name must be `<13-digit epoch ms>-<Name>.ts`, for example `1792368000000-AddContactNickname.ts`"
    );
    return { timestamp: null, problems };
  }
  const timestamp = nameMatch[1];
  const code = stripComments(source);

  const classes = [...code.matchAll(CLASS)].map((m) => m[1]);
  if (classes.length !== 1) {
    report(
      `must export exactly one class implementing MigrationInterface (found ${classes.length})`
    );
    return { timestamp, problems };
  }
  const className = classes[0];
  if (!className.endsWith(timestamp)) {
    report(`class ${className} must end with the file timestamp ${timestamp}`);
  }
  const nameProp = code.match(NAME_PROP);
  if (nameProp && nameProp[1] !== className) {
    report(`name "${nameProp[1]}" must equal the class name ${className}`);
  }
  for (const method of ["up", "down"]) {
    if (!new RegExp(`\\basync\\s+${method}\\s*\\(`).test(code)) {
      report(`must define \`async ${method}(queryRunner)\``);
    }
  }
  const tx = code.match(TX_PROP)?.[1];
  if (tx === "true") {
    report(
      "`transaction = true` makes the default `npm run migration:run` (mode all) refuse every pending migration; remove it"
    );
  }
  if (CONCURRENTLY.test(code) && tx !== "false") {
    report(
      "uses INDEX CONCURRENTLY, which PostgreSQL refuses inside a transaction; set `transaction = false` and run with `--transaction each`"
    );
  }
  return { timestamp, problems };
}

/** `files` maps repository-relative paths to their source. */
export function checkMigrations(
  files,
  { duplicateTimestampExemptions = [] } = {}
) {
  const problems = [];
  const byTimestamp = new Map();
  for (const [file, source] of Object.entries(files).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const result = checkMigrationFile(file, source);
    problems.push(...result.problems);
    if (!result.timestamp) continue;
    const key = `${path.posix.dirname(file)}|${result.timestamp}`;
    if (!byTimestamp.has(key)) byTimestamp.set(key, []);
    byTimestamp.get(key).push(file);
  }
  const exempt = new Set(duplicateTimestampExemptions.map((e) => e.timestamp));
  for (const [key, group] of byTimestamp) {
    const timestamp = key.split("|")[1];
    if (group.length > 1 && !exempt.has(timestamp)) {
      problems.push(
        `${group[1]}: timestamp ${timestamp} is already used by ${group[0]}; TypeORM orders migrations by timestamp, so use a new one (\`node -e "console.log(Date.now())"\`)`
      );
    }
  }
  return problems;
}

export function loadMigrationFiles(root, dirs) {
  const files = {};
  for (const dir of dirs) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      // Subdirectories (src/migrations/preflight) hold tooling, not migrations.
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const rel = path.posix.join(dir, entry.name);
      files[rel] = fs.readFileSync(path.join(root, rel), "utf8");
    }
  }
  return files;
}

function main() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
  );
  const config = readConfig(root);
  const files = loadMigrationFiles(root, config.dirs);
  const problems = checkMigrations(files, config);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} migration problem(s). See docs/DATA_MIGRATIONS.md.`
    );
    process.exit(1);
  }
  console.log(`Migrations: OK (${Object.keys(files).length} files).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
