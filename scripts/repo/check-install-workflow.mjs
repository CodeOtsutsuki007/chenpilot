#!/usr/bin/env node
// Keeps the one supported clean-install workflow consistent everywhere it is
// written down. Fails when:
//   - package.json does not pin the package manager in "packageManager";
//   - a pnpm/action-setup step in CI pins a different pnpm version;
//   - contributor docs show an install command other than the supported one
//     (for example `npm ci`, a bare `npm install`, or `pnpm install` without
//     --frozen-lockfile);
//   - a root package.json script installs dependencies with npm.
//
// Usage: node scripts/repo/check-install-workflow.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { proseLines } from "../docs/markdown.mjs";
import { readRepoConfig } from "./config.mjs";

const PACKAGE_MANAGER = /^([a-z]+)@(\d+\.\d+\.\d+)$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
// Prose that warns against a command ("Do not use `npm ci`") is not an instruction.
const NEGATED = /\b(?:do not|don't|never|without|instead of)\b/i;

/**
 * Return the reason `command` is not the supported install command, or null.
 * Only dependency installs of the project are flagged: installing a global
 * tool (`npm install -g pnpm`) or adding a named package is fine.
 */
export function unsupportedInstall(command, supported) {
  const words = command.trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const [tool, verb] = [words[i], words[i + 1]];
    const rest = [];
    for (
      let j = i + 2;
      j < words.length && !["&&", "||", ";", "|"].includes(words[j]);
      j++
    ) {
      rest.push(words[j]);
    }
    const named = rest.filter((w) => !w.startsWith("-"));
    const global = rest.includes("-g") || rest.includes("--global");
    if (tool === "npm" && verb === "ci")
      return "`npm ci` uses package-lock.json";
    if (
      tool === "npm" &&
      (verb === "install" || verb === "i") &&
      !global &&
      named.length === 0
    ) {
      return "`npm install` uses package-lock.json";
    }
    if (tool === "yarn" && (verb === undefined || verb === "install")) {
      return "yarn is not a supported package manager";
    }
    if (
      tool === "pnpm" &&
      (verb === "install" || verb === "i") &&
      named.length === 0
    ) {
      const missing = supported.filter(
        (flag) => flag.startsWith("-") && !rest.includes(flag)
      );
      if (missing.length > 0) return `missing ${missing.join(" ")}`;
    }
  }
  return null;
}

/** Yield [line, text] for lines inside fenced code blocks. */
function* codeLines(content) {
  const prose = new Set([...proseLines(content)].map(([line]) => line));
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!prose.has(i + 1) && !FENCE.test(lines[i])) yield [i + 1, lines[i]];
  }
}

/** [line, command] for every shell command shown in a Markdown file, in line order. */
export function documentedCommands(content) {
  const commands = [...codeLines(content)];
  // Inline code spans in prose, e.g. "Run `pnpm install`."
  for (const [line, text] of proseLines(content)) {
    if (NEGATED.test(text)) continue;
    for (const m of text.matchAll(/`([^`]+)`/g)) commands.push([line, m[1]]);
  }
  return commands.sort((a, b) => a[0] - b[0]);
}

/** pnpm versions pinned by pnpm/action-setup steps: [{ file, line, version }]. */
export function pinnedPnpmVersions(workflow) {
  const lines = workflow.split(/\r?\n/);
  const pins = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/uses:\s*pnpm\/action-setup@/.test(lines[i])) continue;
    const indent = lines[i].search(/\S/);
    for (let j = i + 1; j < lines.length; j++) {
      const lineIndent = lines[j].search(/\S/);
      if (lineIndent !== -1 && lineIndent <= indent && /^\s*-/.test(lines[j]))
        break;
      const m = lines[j].match(/^\s*version:\s*["']?([^"'\s#]+)/);
      if (m) {
        pins.push({ line: j + 1, version: m[1] });
        break;
      }
    }
  }
  return pins;
}

/** Return a list of human-readable problems; empty means clean. */
export function checkInstallWorkflow(root, config) {
  const problems = [];
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8")
  );
  const supported = config.command.join(" ");

  const pin = String(manifest.packageManager ?? "").match(PACKAGE_MANAGER);
  const version = pin && pin[1] === config.packageManager ? pin[2] : null;
  if (!version) {
    problems.push(
      `package.json: "packageManager" is ${JSON.stringify(manifest.packageManager)}, expected "${config.packageManager}@<major.minor.patch>"`
    );
  }

  for (const [name, script] of Object.entries(manifest.scripts ?? {})) {
    const reason = unsupportedInstall(script, config.command);
    if (reason)
      problems.push(
        `package.json: scripts.${name} installs dependencies (${reason}); use \`${supported}\``
      );
  }

  for (const doc of config.docs) {
    const content = fs.readFileSync(path.join(root, doc), "utf8");
    let documented = false;
    for (const [line, command] of documentedCommands(content)) {
      if (command.includes(supported)) documented = true;
      const reason = unsupportedInstall(command, config.command);
      if (reason)
        problems.push(
          `${doc}:${line}: "${command.trim()}" (${reason}); document \`${supported}\``
        );
    }
    if (!documented)
      problems.push(
        `${doc}: does not document the supported install command \`${supported}\``
      );
  }

  const workflowsDir = path.join(root, config.workflowsDir);
  for (const file of fs
    .readdirSync(workflowsDir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()) {
    const rel = path.posix.join(config.workflowsDir, file);
    for (const { line, version: pinned } of pinnedPnpmVersions(
      fs.readFileSync(path.join(workflowsDir, file), "utf8")
    )) {
      if (version && pinned !== version) {
        problems.push(
          `${rel}:${line}: pnpm/action-setup pins version ${pinned}, but package.json pins ${config.packageManager}@${version}`
        );
      }
    }
  }
  return problems;
}

function main() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
  );
  const config = readRepoConfig(root).installWorkflow;
  const problems = checkInstallWorkflow(root, config);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} install workflow problem(s). See CONTRIBUTING.md "Getting Started".`
    );
    process.exit(1);
  }
  console.log(
    `Install workflow: OK (\`${config.command.join(" ")}\` is the one documented clean install).`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
