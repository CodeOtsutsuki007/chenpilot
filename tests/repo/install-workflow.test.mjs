import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  checkInstallWorkflow,
  documentedCommands,
  pinnedPnpmVersions,
  unsupportedInstall,
} from "../../scripts/repo/check-install-workflow.mjs";
import { readRepoConfig } from "../../scripts/repo/config.mjs";
import {
  diffSnapshots,
  verifyCleanInstall,
} from "../../scripts/repo/verify-clean-install.mjs";
import { REPO_ROOT, makeFixture, removeFixture } from "../docs/helpers.mjs";

const config = readRepoConfig(REPO_ROOT).installWorkflow;
const SUPPORTED = config.command;

const README = "# App\n\n```bash\npnpm install --frozen-lockfile\n```\n";
const WORKFLOW = [
  "jobs:",
  "  build:",
  "    steps:",
  "      - uses: pnpm/action-setup@v3",
  "        with:",
  "          version: 10.13.1",
  "      - uses: actions/setup-node@v4",
  "        with:",
  "          version: 99",
  "",
].join("\n");

function fixture({
  manifest = { packageManager: "pnpm@10.13.1" },
  readme = README,
  workflow = WORKFLOW,
} = {}) {
  return makeFixture({
    "package.json": JSON.stringify(manifest),
    "README.md": readme,
    "CONTRIBUTING.md": README,
    ".github/workflows/ci.yml": workflow,
  });
}

function check(options) {
  const dir = fixture(options);
  try {
    return checkInstallWorkflow(dir, config);
  } finally {
    removeFixture(dir);
  }
}

describe("supported install workflow", () => {
  it("passes on the repository", () => {
    assert.deepEqual(checkInstallWorkflow(REPO_ROOT, config), []);
  });

  it("pins pnpm in package.json and documents the frozen-lockfile install", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
    );
    assert.match(manifest.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
    assert.deepEqual(SUPPORTED, ["pnpm", "install", "--frozen-lockfile"]);
    assert.match(
      manifest.scripts["smoke:clean-checkout"],
      /verify-clean-install\.mjs/
    );
  });

  it("classifies install commands", () => {
    assert.equal(
      unsupportedInstall("pnpm install --frozen-lockfile", SUPPORTED),
      null
    );
    assert.equal(
      unsupportedInstall("pnpm i --frozen-lockfile && pnpm test", SUPPORTED),
      null
    );
    assert.equal(
      unsupportedInstall("pnpm install", SUPPORTED),
      "missing --frozen-lockfile"
    );
    assert.equal(
      unsupportedInstall("npm ci && npm test", SUPPORTED),
      "`npm ci` uses package-lock.json"
    );
    assert.equal(
      unsupportedInstall("cd app && npm install", SUPPORTED),
      "`npm install` uses package-lock.json"
    );
    assert.equal(
      unsupportedInstall("yarn install", SUPPORTED),
      "yarn is not a supported package manager"
    );
    // Boundary: installing a global tool or a named package is not a project install.
    assert.equal(
      unsupportedInstall("npm install -g pnpm@10.13.1", SUPPORTED),
      null
    );
    assert.equal(unsupportedInstall("pnpm add lodash", SUPPORTED), null);
    assert.equal(unsupportedInstall("npm run build", SUPPORTED), null);
  });

  it("reads fenced commands and inline code, but not warnings against a command", () => {
    const content = [
      "Run `pnpm install`.",
      "Do not use `npm ci`.",
      "```bash",
      "npm ci",
      "```",
    ].join("\n");
    assert.deepEqual(documentedCommands(content), [
      [1, "pnpm install"],
      [4, "npm ci"],
    ]);
  });

  it("finds the pnpm version pinned by pnpm/action-setup steps only", () => {
    assert.deepEqual(pinnedPnpmVersions(WORKFLOW), [
      { line: 6, version: "10.13.1" },
    ]);
    assert.deepEqual(
      pinnedPnpmVersions(
        "steps:\n  - uses: pnpm/action-setup@v3\n  - run: x\n    version: 1\n"
      ),
      []
    );
  });

  it("accepts a consistent fixture", () => {
    assert.deepEqual(check(), []);
  });

  it("reports a missing pin, npm installs in scripts and docs, and a mismatched CI pin", () => {
    assert.deepEqual(
      check({
        manifest: { scripts: { smoke: "npm ci && jest" } },
        readme: "# App\n\n```bash\nnpm install\n```\n",
      }),
      [
        'package.json: "packageManager" is undefined, expected "pnpm@<major.minor.patch>"',
        "package.json: scripts.smoke installs dependencies (`npm ci` uses package-lock.json); use `pnpm install --frozen-lockfile`",
        'README.md:4: "npm install" (`npm install` uses package-lock.json); document `pnpm install --frozen-lockfile`',
        "README.md: does not document the supported install command `pnpm install --frozen-lockfile`",
      ]
    );
    assert.deepEqual(check({ manifest: { packageManager: "pnpm@9.15.5" } }), [
      ".github/workflows/ci.yml:6: pnpm/action-setup pins version 10.13.1, but package.json pins pnpm@9.15.5",
    ]);
    assert.deepEqual(check({ manifest: { packageManager: "npm@10.0.0" } }), [
      'package.json: "packageManager" is "npm@10.0.0", expected "pnpm@<major.minor.patch>"',
    ]);
  });
});

describe("clean install verification", () => {
  const git = (cwd, ...args) =>
    execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
      { cwd }
    );
  function withRepo(fn) {
    const dir = makeFixture(
      { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n", "package.json": "{}\n" },
      { git: true }
    );
    try {
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "checkout");
      return fn(dir);
    } finally {
      removeFixture(dir);
    }
  }
  const node = (script) => [process.execPath, "-e", script];
  const lockfiles = ["pnpm-lock.yaml"];

  it("passes when the install leaves the lockfile and tracked files alone", () => {
    withRepo((dir) => {
      // Ignored install output (node_modules) is not a change.
      fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
      git(dir, "add", ".gitignore");
      const command = node(
        "require('fs').mkdirSync('node_modules/x', { recursive: true })"
      );
      assert.deepEqual(verifyCleanInstall(dir, { command, lockfiles }), []);
    });
  });

  it("fails when the install rewrites the lockfile", () => {
    withRepo((dir) => {
      const command = node(
        "require('fs').appendFileSync('pnpm-lock.yaml', 'drift: true\\n')"
      );
      assert.deepEqual(verifyCleanInstall(dir, { command, lockfiles }), [
        "pnpm-lock.yaml: the install modified the lockfile",
        'pnpm-lock.yaml: the install changed the working tree (git status "M")',
      ]);
    });
  });

  it("fails when the install command fails or creates untracked files", () => {
    withRepo((dir) => {
      assert.deepEqual(
        verifyCleanInstall(dir, {
          command: node("process.exit(3)"),
          lockfiles,
        }),
        [`\`${process.execPath} -e process.exit(3)\` exited with status 3`]
      );
      const command = node(
        "require('fs').writeFileSync('package-lock.json', '{}')"
      );
      assert.deepEqual(verifyCleanInstall(dir, { command, lockfiles }), [
        'package-lock.json: the install changed the working tree (git status "??")',
      ]);
    });
  });

  it("fails when the lockfile is missing", () => {
    assert.deepEqual(
      diffSnapshots(
        { hashes: { "pnpm-lock.yaml": null }, status: [] },
        { hashes: { "pnpm-lock.yaml": null }, status: [] }
      ),
      [
        "pnpm-lock.yaml: lockfile is missing; the install cannot be reproducible",
      ]
    );
  });
});
