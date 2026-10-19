// Shared, dependency-free helpers for the environment variable registry
// (scripts/env/env-registry.json): loading it, scanning source files for
// referenced variables, rendering the documentation table, and reading
// .env files. Used by check-env-docs.mjs and preflight.mjs.

import fs from "node:fs";
import path from "node:path";
import { gitLsFiles, globToRegExp, matchesAny } from "../docs/markdown.mjs";

export const REGISTRY_FILE = "scripts/env/env-registry.json";

const NAME = "[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*";

export function readRegistry(root, file = REGISTRY_FILE) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

/** True when `name` is a wildcard family entry such as `DEFI_*`. */
export function isFamily(name) {
  return name.includes("*");
}

/** Glob-match an environment variable name (`*` matches any run of characters). */
export function matchesName(name, pattern) {
  return globToRegExp(pattern.replace(/\*/g, "**")).test(name);
}

function alternation(identifiers) {
  return identifiers.map((h) => h.replace(/[^\w$]/g, "")).join("|");
}

/**
 * Find environment variable names referenced in `content`:
 * `process.env.NAME`, `process.env["NAME"]`, `env.NAME` (an injected
 * `NodeJS.ProcessEnv`), the first string argument of configured `helpers`
 * such as `requireEnv("NAME")`, and string values of configured object
 * `keys` such as `envVar: "NAME"`. Names built at runtime (template strings,
 * computed keys) cannot be found and belong in a family entry.
 * Returns [{ name, line }] sorted by line.
 */
export function scanReferences(content, { helpers = [], keys = [] } = {}) {
  const quoted = `["'\`](${NAME})["'\`]`;
  const patterns = [
    new RegExp(`\\benv\\??\\.(${NAME})\\b`, "g"),
    new RegExp(`\\bprocess\\.env\\[\\s*${quoted}\\s*\\]`, "g"),
  ];
  if (helpers.length > 0) {
    patterns.push(
      new RegExp(`\\b(?:${alternation(helpers)})\\(\\s*${quoted}`, "g")
    );
  }
  if (keys.length > 0) {
    patterns.push(
      new RegExp(`\\b(?:${alternation(keys)})\\s*:\\s*${quoted}`, "g")
    );
  }
  const lineStarts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") lineStarts.push(i + 1);
  }
  const lineOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const refs = [];
  for (const pattern of patterns) {
    for (const m of content.matchAll(pattern)) {
      refs.push({ name: m[1], line: lineOf(m.index) });
    }
  }
  return refs.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

/** Files the scan covers, repository-relative and sorted. */
export function scanFiles(root, scan) {
  return gitLsFiles(root, ["."]).filter(
    (f) => matchesAny(f, scan.include) && !matchesAny(f, scan.exclude ?? [])
  );
}

/** Map of variable name -> sorted list of `file:line` references. */
export function collectReferences(root, scan, files = scanFiles(root, scan)) {
  const refs = new Map();
  for (const file of files) {
    const content = fs.readFileSync(path.join(root, file), "utf8");
    for (const { name, line } of scanReferences(content, scan)) {
      if (!refs.has(name)) refs.set(name, []);
      refs.get(name).push(`${file}:${line}`);
    }
  }
  return new Map([...refs.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** The entry or exemption that covers `name`, preferring an exact entry. */
export function findCoverage(registry, name) {
  const exact = registry.variables.find((v) => v.name === name);
  if (exact) return { kind: "variable", entry: exact };
  const family = registry.variables.find(
    (v) => isFamily(v.name) && matchesName(name, v.name)
  );
  if (family) return { kind: "family", entry: family };
  const exemption = (registry.exemptions ?? []).find((e) =>
    matchesName(name, e.pattern)
  );
  if (exemption) return { kind: "exemption", entry: exemption };
  return null;
}

function requiredLabel(v) {
  if (v.required === true) return "Yes";
  if (v.requiredUnless) return `Unless \`${v.requiredUnless}\` is set`;
  if (v.requiredWhen) return `When ${v.requiredWhen}`;
  return "No";
}

function cell(text) {
  return String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Render the generated Markdown block (without the begin/end markers). */
export function renderTable(registry) {
  const out = [];
  const services = [...new Set(registry.variables.map((v) => v.service))];
  for (const service of services) {
    out.push(`### ${registry.services?.[service] ?? service}`, "");
    out.push(
      "| Variable | Owner | Required | Default | Secret | Description |",
      "| --- | --- | --- | --- | --- | --- |"
    );
    const rows = registry.variables
      .filter((v) => v.service === service)
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const v of rows) {
      const def =
        v.default === undefined || v.default === null
          ? "—"
          : v.default === ""
            ? "empty"
            : `\`${cell(v.default)}\``;
      out.push(
        `| \`${v.name}\` | ${cell(v.owner)} | ${requiredLabel(v)} | ${def} | ${
          v.secret ? "Yes" : "No"
        } | ${cell(v.description)} |`
      );
    }
    out.push("");
  }
  out.push("### Exemptions", "");
  out.push(
    "Referenced in source but intentionally not documented as configuration.",
    "",
    "| Pattern | Reason |",
    "| --- | --- |"
  );
  for (const e of registry.exemptions ?? []) {
    out.push(`| \`${e.pattern}\` | ${cell(e.reason)} |`);
  }
  return out.join("\n");
}

/** Replace the content between the doc markers; null when a marker is missing. */
export function applyTable(content, { begin, end }, body) {
  const start = content.indexOf(begin);
  const stop = content.indexOf(end);
  if (start === -1 || stop === -1 || stop < start) return null;
  return `${content.slice(0, start + begin.length)}\n${body}\n${content.slice(stop)}`;
}

/**
 * Parse a dotenv-style file into a Map. Supports `KEY=value`, `export KEY=`,
 * quoted values and `#` comments. Values are never logged by callers.
 */
export function parseDotenv(content) {
  const vars = new Map();
  for (const raw of content.split(/\r?\n/)) {
    const m = raw.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/
    );
    if (!m) continue;
    let value = m[2];
    const quote = value[0];
    if (
      (quote === '"' || quote === "'") &&
      value.endsWith(quote) &&
      value.length > 1
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    vars.set(m[1], value);
  }
  return vars;
}
