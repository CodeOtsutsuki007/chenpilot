#!/usr/bin/env node
// Keeps operational runbooks executable. In each configured runbook:
//   - step tables (header `| ID | Step | How | Evidence to record |`): every
//     step is either marked **Manual** or names an `npm run <script>` that
//     exists, an existing repository file, or another step; every step has
//     evidence; IDs are unique and step references resolve,
//   - fact tables (header `| Fact | Value | Source | Check |`): `const NAME`
//     checks that the constant in Source still has Value, and `contains`
//     checks that Source still contains Value.
//
// Usage: node scripts/docs/check-runbooks.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pathExists, proseLines, readConfig } from "./markdown.mjs";

const STEP_ID = /^[A-Z]\d{1,2}$/;
const STEP_REF = /\b([A-Z]\d{1,2})\b/g;
const PATH_LIKE = /^[\w.-]+(?:\/[\w.-]+)+$/;

/** Split a Markdown table row into trimmed cells, honouring code spans and `\|`. */
export function splitRow(line) {
  const cells = [];
  let cell = "";
  let inCode = false;
  const text = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && text[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (c === "`") {
      inCode = !inCode;
      cell += c;
    } else if (c === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += c;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/** Tables as { kind, rows: [{ line, cells }] } for step and fact tables. */
export function parseTables(content) {
  const tables = [];
  let current = null;
  for (const [line, text] of proseLines(content)) {
    if (!text.trim().startsWith("|")) {
      current = null;
      continue;
    }
    const cells = splitRow(text);
    if (current === null) {
      const header = cells.map((c) => c.toLowerCase());
      const kind =
        header[0] === "id" &&
        header.includes("how") &&
        header.some((h) => h.startsWith("evidence"))
          ? "steps"
          : header[0] === "fact" && header[3] === "check"
            ? "facts"
            : "other";
      current = { kind, header, rows: [] };
      tables.push(current);
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    current.rows.push({ line, cells });
  }
  return tables.filter((t) => t.kind !== "other");
}

const codeSpans = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

/**
 * Check one runbook. `scripts` is the set of npm script names; `readSource`
 * returns a repository file's content or null.
 */
export function checkRunbook(file, content, { root, scripts, readSource }) {
  const problems = [];
  const report = (line, msg) => problems.push(`${file}:${line}: ${msg}`);
  const tables = parseTables(content);
  const steps = tables
    .filter((t) => t.kind === "steps")
    .flatMap((t) =>
      t.rows.map(({ line, cells }) => ({
        line,
        id: cells[0],
        how: cells[t.header.indexOf("how")] ?? "",
        evidence:
          cells[t.header.findIndex((h) => h.startsWith("evidence"))] ?? "",
      }))
    );
  if (steps.length === 0)
    report(
      1,
      "no step table found (header `| ID | Step | How | Evidence to record |`)"
    );

  const ids = new Set();
  for (const step of steps) {
    if (!STEP_ID.test(step.id))
      report(
        step.line,
        `step ID "${step.id}" must be a letter followed by a number, like D1`
      );
    if (ids.has(step.id)) report(step.line, `duplicate step ID ${step.id}`);
    ids.add(step.id);
  }

  for (const { line, id, how, evidence } of steps) {
    if (evidence === "" || /^[-—]+$/.test(evidence))
      report(line, `${id}: evidence to record is empty`);

    const manual = how.includes("**Manual**");
    let linked = false;
    for (const span of codeSpans(how)) {
      for (const m of span.matchAll(/\bnpm run ([\w:.-]+)/g)) {
        if (scripts.has(m[1])) linked = true;
        else
          report(
            line,
            `${id}: \`npm run ${m[1]}\` is not a script in package.json`
          );
      }
      if (PATH_LIKE.test(span)) {
        if (pathExists(root, span)) linked = true;
        else report(line, `${id}: \`${span}\` does not exist`);
      }
    }
    const howWithoutCode = how.replace(/`[^`]*`/g, "");
    for (const m of howWithoutCode.matchAll(STEP_REF)) {
      if (m[1] === id) continue;
      if (ids.has(m[1])) linked = true;
      else report(line, `${id}: refers to unknown step ${m[1]}`);
    }
    if (!manual && !linked)
      report(
        line,
        `${id}: name an existing command, file or step, or mark the step **Manual** with the evidence it needs`
      );
  }

  for (const table of tables.filter((t) => t.kind === "facts")) {
    for (const { line, cells } of table.rows) {
      const [fact, valueCell, sourceCell, checkCell] = cells;
      const value = codeSpans(valueCell ?? "")[0];
      const source = codeSpans(sourceCell ?? "")[0];
      const check = codeSpans(checkCell ?? "")[0] ?? "";
      if (!value || !source) {
        report(line, `fact "${fact}": Value and Source must be code spans`);
        continue;
      }
      const text = readSource(source);
      if (text === null) {
        report(line, `fact "${fact}": source ${source} does not exist`);
        continue;
      }
      const constant = check.match(/^const\s+(\w+)$/);
      if (constant) {
        const decl = text.match(
          new RegExp(`\\bconst\\s+${constant[1]}\\b[^=]*=\\s*([^;]+);`)
        );
        if (!decl)
          report(
            line,
            `fact "${fact}": ${constant[1]} is not declared in ${source}`
          );
        else if (decl[1].trim().replace(/_/g, "") !== value.replace(/_/g, ""))
          report(
            line,
            `fact "${fact}": ${constant[1]} is ${decl[1].trim()} in ${source}, but the runbook says ${value}; update the runbook and the steps that depend on it`
          );
      } else if (check === "contains") {
        if (!text.includes(value))
          report(
            line,
            `fact "${fact}": ${source} no longer contains \`${value}\`; update the runbook`
          );
      } else {
        report(
          line,
          `fact "${fact}": Check must be \`const NAME\` or \`contains\``
        );
      }
    }
  }
  return problems;
}

export function checkRunbooks(root, files) {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8")
  );
  const scripts = new Set(Object.keys(pkg.scripts ?? {}));
  const readSource = (rel) =>
    pathExists(root, rel)
      ? fs.readFileSync(path.join(root, rel), "utf8")
      : null;
  const problems = [];
  for (const file of files) {
    const content = readSource(file);
    if (content === null) problems.push(`${file}:1: runbook is missing`);
    else
      problems.push(
        ...checkRunbook(file, content, { root, scripts, readSource })
      );
  }
  return problems;
}

function main() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
  );
  const { files } = readConfig(root).runbooks;
  const problems = checkRunbooks(root, files);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(`\n${problems.length} runbook problem(s).`);
    process.exit(1);
  }
  console.log(`Runbooks: OK (${files.length} checked).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
