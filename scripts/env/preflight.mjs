#!/usr/bin/env node
// Local environment preflight: checks Node.js, the package manager,
// installed dependencies, required configuration, PostgreSQL and Redis before
// `npm run dev`, `npm run migration:run` or the test suite fail later.
//
// Configuration is read the way src/config/config.ts reads it: the process
// environment first, then .env.local, then .env. Values are never printed;
// problems name the variable only.
//
// Usage:
//   npm run preflight
//   node scripts/env/preflight.mjs [--env-file <path>] [--skip-services] [--timeout <ms>]
//
// Exit codes: 0 all required checks passed (warnings allowed), 1 a check failed.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDotenv, readRegistry } from "./env-registry.mjs";

export const MIN_NODE_MAJOR = 18;
const DEFAULT_TIMEOUT_MS = 3000;

const ok = (name, message) => ({ name, status: "ok", message });
const warn = (name, message, fix) => ({ name, status: "warn", message, fix });
const fail = (name, message, fix) => ({ name, status: "fail", message, fix });

// ── Environment loading ─────────────────────────────────────────────────────

/**
 * Merge configuration like dotenv does in src/config/config.ts: values already
 * in `processEnv` win, then the first file that defines a key. Returns the
 * merged map and the files that were found.
 */
export function loadEnv(root, files, processEnv) {
  const merged = new Map();
  const found = [];
  for (const file of files) {
    const full = path.resolve(root, file);
    if (!fs.existsSync(full)) continue;
    found.push(file);
    for (const [key, value] of parseDotenv(fs.readFileSync(full, "utf8"))) {
      if (!merged.has(key)) merged.set(key, value);
    }
  }
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined) merged.set(key, value);
  }
  return { env: merged, found };
}

// ── Toolchain ───────────────────────────────────────────────────────────────

export function checkNode(version = process.versions.node) {
  const major = Number.parseInt(version.split(".")[0], 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    return fail(
      "Node.js",
      `v${version} is older than the supported v${MIN_NODE_MAJOR}`,
      `Install Node.js ${MIN_NODE_MAJOR} or newer (CI uses 20), for example with \`nvm install 20\`.`
    );
  }
  return ok("Node.js", `v${version} (requires >= ${MIN_NODE_MAJOR})`);
}

/** Version string of `cmd`, or null when it is not on PATH. */
export function commandVersion(cmd) {
  try {
    return execFileSync(cmd, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32",
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}

export function checkPackageManager(root, versionOf = commandVersion) {
  const pnpm = versionOf("pnpm");
  const npm = versionOf("npm");
  if (!pnpm && !npm) {
    return fail(
      "Package manager",
      "neither pnpm nor npm is on PATH",
      "Install pnpm (`npm install -g pnpm`) or reinstall Node.js, which ships npm."
    );
  }
  if (!pnpm) {
    return warn(
      "Package manager",
      `npm ${npm} found, pnpm not found`,
      "CONTRIBUTING.md uses pnpm (`npm install -g pnpm`). npm also works with package-lock.json (`npm ci`)."
    );
  }
  const lockfiles = ["pnpm-lock.yaml", "package-lock.json"].filter((f) =>
    fs.existsSync(path.join(root, f))
  );
  return ok(
    "Package manager",
    `pnpm ${pnpm}${npm ? `, npm ${npm}` : ""} (lockfiles: ${lockfiles.join(", ") || "none"})`
  );
}

export function checkDependencies(root) {
  const marker = path.join(root, "node_modules", ".package-lock.json");
  const modules = path.join(root, "node_modules");
  if (!fs.existsSync(modules)) {
    return fail(
      "Dependencies",
      "node_modules is missing",
      "Run `pnpm install` (or `npm ci`)."
    );
  }
  const lock = path.join(root, "package-lock.json");
  if (
    fs.existsSync(marker) &&
    fs.existsSync(lock) &&
    fs.statSync(lock).mtimeMs > fs.statSync(marker).mtimeMs
  ) {
    return warn(
      "Dependencies",
      "package-lock.json changed after the last install",
      "Run `pnpm install` (or `npm ci`) to pick up dependency changes."
    );
  }
  return ok("Dependencies", "node_modules present");
}

// ── Configuration ───────────────────────────────────────────────────────────

const isSet = (env, name) => (env.get(name) ?? "").trim() !== "";

function validationError(value, rule) {
  if (rule.minLength && value.length < rule.minLength)
    return `is shorter than ${rule.minLength} characters`;
  if (rule.pattern && !new RegExp(rule.pattern).test(value))
    return `is not ${rule.hint ?? `in the expected format`}`;
  if (rule.positiveInteger && !/^[1-9]\d*$/.test(value))
    return "is not a positive integer";
  if (rule.oneOf && !rule.oneOf.includes(value))
    return `is not one of ${rule.oneOf.map((v) => `"${v}"`).join(", ")}`;
  return null;
}

/**
 * Check the backend variables the registry marks as required or validated.
 * `example` is the parsed .env.example, used to spot untouched placeholders.
 * Messages contain variable names only, never values.
 */
export function checkConfig(
  registry,
  env,
  { example = new Map(), envFiles = [] } = {}
) {
  const missing = [];
  const invalid = [];
  const placeholders = [];
  const vars = registry.variables.filter(
    (v) =>
      v.service === "backend" &&
      !v.name.includes("*") &&
      (v.required === true || v.requiredUnless || v.validate)
  );
  for (const v of vars) {
    const needed =
      v.required === true ||
      (v.requiredUnless && !isSet(env, v.requiredUnless));
    if (!isSet(env, v.name)) {
      if (needed) missing.push(v);
      continue;
    }
    const value = env.get(v.name).trim();
    const problem = v.validate ? validationError(value, v.validate) : null;
    if (problem) invalid.push(`${v.name} ${problem}`);
    const sample = example.get(v.name);
    if (sample && sample === value && /^your_/i.test(sample))
      placeholders.push(v.name);
  }

  const results = [];
  const source =
    envFiles.length > 0 ? envFiles.join(", ") : "no .env file found";
  if (missing.length > 0) {
    const names = missing.map((v) =>
      v.requiredUnless ? `${v.name} (or ${v.requiredUnless})` : v.name
    );
    results.push(
      fail(
        "Configuration",
        `missing required variable(s): ${names.join(", ")} [${source}]`,
        envFiles.length > 0
          ? "Set them in .env. See docs/ENVIRONMENT_VARIABLES.md for what each one does."
          : "Run `cp .env.example .env` and fill in the values. See docs/ENVIRONMENT_VARIABLES.md."
      )
    );
  }
  if (invalid.length > 0) {
    results.push(
      fail(
        "Configuration",
        `invalid value(s): ${invalid.join("; ")}`,
        "Fix them in .env. See docs/ENVIRONMENT_VARIABLES.md."
      )
    );
  }
  if (placeholders.length > 0) {
    results.push(
      warn(
        "Configuration",
        `still set to the .env.example placeholder: ${placeholders.join(", ")}`,
        "Replace the placeholders with real values before calling the services that use them."
      )
    );
  }
  if (results.length === 0) {
    results.push(
      ok(
        "Configuration",
        `${vars.length} required or validated variable(s) set [${source}]`
      )
    );
  }
  return results;
}

// ── Services ────────────────────────────────────────────────────────────────

/** Resolve when a TCP connection opens; reject with the socket error otherwise. */
export function tcpProbe(host, port, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));
    });
    socket.once("connect", () => {
      socket.end();
      resolve();
    });
    socket.once("error", (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

function networkFix(service, code, start) {
  switch (code) {
    case "ECONNREFUSED":
      return `Nothing is listening there. Start ${service}, for example \`${start}\`, or fix the host/port variables.`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "The host name does not resolve. Check the host variable (use `localhost` for a local server).";
    case "ETIMEDOUT":
      return `The connection timed out. Check that ${service} is running and that no firewall blocks the port.`;
    default:
      return `Check that ${service} is running and reachable.`;
  }
}

const PG_START =
  "docker run -d --name chenpilot-postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:15";
const REDIS_START = "docker run -d --name chenpilot-redis -p 6379:6379 redis:7";

const PG_ERRORS = {
  "28P01": ["authentication failed", "Check DB_USERNAME and DB_PASSWORD."],
  28000: [
    "the server rejected the role or authentication method",
    "Check DB_USERNAME and the server's pg_hba.conf.",
  ],
  "3D000": [
    "the database does not exist",
    "Create it, for example `createdb -h <DB_HOST> -U <DB_USERNAME> <DB_NAME>`, then run `npm run migration:run`.",
  ],
  "57P03": [
    "the server is starting up",
    "Wait a few seconds and run the preflight again.",
  ],
};

/** Load `pg` from the project's dependencies, or null when not installed. */
export function loadPg(root) {
  try {
    return createRequire(path.join(root, "package.json"))("pg");
  } catch {
    return null;
  }
}

export async function checkPostgres(
  env,
  { pg = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}
) {
  const name = "PostgreSQL";
  if (!isSet(env, "DB_HOST")) {
    return fail(
      name,
      "skipped: DB_HOST is not set",
      "Set DB_HOST (and DB_PORT, DB_USERNAME, DB_NAME) in .env."
    );
  }
  const host = env.get("DB_HOST").trim();
  const port = Number.parseInt(env.get("DB_PORT") || "5432", 10);
  const target = `${host}:${port}`;
  try {
    await tcpProbe(host, port, timeoutMs);
  } catch (err) {
    return fail(
      name,
      `cannot connect to ${target} (${err.code ?? "error"})`,
      networkFix(name, err.code, PG_START)
    );
  }
  if (!pg) {
    return warn(
      name,
      `${target} is reachable, but credentials were not checked because the \`pg\` package is not installed`,
      "Run `pnpm install` (or `npm ci`) and run the preflight again."
    );
  }
  const client = new pg.Client({
    host,
    port,
    user: env.get("DB_USERNAME"),
    password: env.get("DB_PASSWORD") || undefined,
    database: env.get("DB_NAME"),
    connectionTimeoutMillis: timeoutMs,
  });
  try {
    await client.connect();
    const { rows } = await client.query("SHOW server_version");
    return ok(
      name,
      `connected to ${target}, database ${env.get("DB_NAME")} (server ${rows[0]?.server_version ?? "unknown"})`
    );
  } catch (err) {
    const [what, fix] = PG_ERRORS[err.code] ?? [
      `connection failed (${err.code ?? "error"})`,
      "Check DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD and DB_NAME.",
    ];
    return fail(name, `${target}: ${what}`, fix);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Send RESP commands and collect one reply line per command. */
function redisExchange(host, port, commands, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const replies = [];
    let buffer = "";
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));
    });
    socket.once("connect", () => {
      for (const args of commands) {
        socket.write(
          `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join("")}`
        );
      }
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\r\n")) !== -1) {
        replies.push(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
        if (replies.length === commands.length) {
          socket.end();
          resolve(replies);
          return;
        }
      }
    });
    socket.once("error", (err) => {
      socket.destroy();
      reject(err);
    });
    socket.once("close", () => {
      if (replies.length < commands.length)
        reject(
          Object.assign(new Error("connection closed"), { code: "ECONNRESET" })
        );
    });
  });
}

export async function checkRedis(env, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const name = "Redis";
  const host = (env.get("REDIS_HOST") || "localhost").trim();
  const port = Number.parseInt(env.get("REDIS_PORT") || "6379", 10);
  const target = `${host}:${port}`;
  const password = env.get("REDIS_PASSWORD");
  const commands = password ? [["AUTH", password], ["PING"]] : [["PING"]];
  let replies;
  try {
    replies = await redisExchange(host, port, commands, timeoutMs);
  } catch (err) {
    return fail(
      name,
      `cannot connect to ${target} (${err.code ?? "error"})`,
      networkFix(name, err.code, REDIS_START)
    );
  }
  const pong = replies[replies.length - 1];
  if (password && !replies[0].startsWith("+OK")) {
    return fail(
      name,
      `${target} rejected REDIS_PASSWORD`,
      "Check REDIS_PASSWORD, or unset it if the server has no password."
    );
  }
  if (pong.startsWith("-NOAUTH")) {
    return fail(
      name,
      `${target} requires a password`,
      "Set REDIS_PASSWORD in .env."
    );
  }
  if (pong !== "+PONG") {
    return fail(
      name,
      `${target} did not answer PING`,
      "Check that REDIS_HOST/REDIS_PORT point at a Redis server."
    );
  }
  return ok(name, `PING answered by ${target}`);
}

// ── Runner ──────────────────────────────────────────────────────────────────

export async function runPreflight({
  root,
  env,
  envFiles = [],
  registry = readRegistry(root),
  skipServices = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  versionOf = commandVersion,
  nodeVersion = process.versions.node,
  pg = loadPg(root),
}) {
  const examplePath = path.join(root, ".env.example");
  const example = fs.existsSync(examplePath)
    ? parseDotenv(fs.readFileSync(examplePath, "utf8"))
    : new Map();
  const results = [
    checkNode(nodeVersion),
    checkPackageManager(root, versionOf),
    checkDependencies(root),
    ...checkConfig(registry, env, { example, envFiles }),
  ];
  if (skipServices) {
    results.push(
      ok("PostgreSQL", "skipped (--skip-services)"),
      ok("Redis", "skipped (--skip-services)")
    );
  } else {
    results.push(
      ...(await Promise.all([
        checkPostgres(env, { pg, timeoutMs }),
        checkRedis(env, { timeoutMs }),
      ]))
    );
  }
  return results;
}

const ICONS = { ok: "ok  ", warn: "warn", fail: "FAIL" };

export function formatResults(results) {
  const lines = ["Chen Pilot local preflight", ""];
  for (const r of results) {
    lines.push(`[${ICONS[r.status]}] ${r.name.padEnd(16)} ${r.message}`);
    if (r.fix) lines.push(`       ${"".padEnd(16)} -> ${r.fix}`);
  }
  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  lines.push(
    "",
    failed > 0
      ? `${failed} check(s) failed, ${warned} warning(s). Fix the failures above, then run \`npm run preflight\` again.`
      : `All required checks passed${warned > 0 ? ` (${warned} warning(s))` : ""}.`
  );
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = {
    envFiles: null,
    skipServices: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env-file") (args.envFiles ??= []).push(argv[++i]);
    else if (argv[i] === "--skip-services") args.skipServices = true;
    else if (argv[i] === "--timeout")
      args.timeoutMs = Number.parseInt(argv[++i], 10);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

async function main() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
  );
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(
      "Usage: node scripts/env/preflight.mjs [--env-file <path>] [--skip-services] [--timeout <ms>]"
    );
    process.exit(2);
  }
  const { env, found } = loadEnv(
    root,
    args.envFiles ?? [".env.local", ".env"],
    process.env
  );
  const results = await runPreflight({
    root,
    env,
    envFiles: found,
    skipServices: args.skipServices,
    timeoutMs: args.timeoutMs,
  });
  console.log(formatResults(results));
  process.exit(results.some((r) => r.status === "fail") ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
