import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkDependencyAliases,
  inventory,
  moduleReferences,
  owningWorkspace,
  packageName,
} from "../../scripts/repo/check-dependency-aliases.mjs";
import { readRepoConfig } from "../../scripts/repo/config.mjs";
import { REPO_ROOT, makeFixture, removeFixture } from "../docs/helpers.mjs";

const repoConfig = readRepoConfig(REPO_ROOT).dependencyAliases;
const config = { ...repoConfig, workspaces: [".", "packages/sdk"] };

function manifest(dependencies, devDependencies = {}) {
  return JSON.stringify({
    name: "x",
    version: "1.0.0",
    dependencies,
    devDependencies,
  });
}

function check(files) {
  const dir = makeFixture(files);
  try {
    return checkDependencyAliases(dir, config, Object.keys(files).sort());
  } finally {
    removeFixture(dir);
  }
}

describe("dependency alias inventory", () => {
  it("passes on the repository", () => {
    assert.deepEqual(checkDependencyAliases(REPO_ROOT, repoConfig), []);
  });

  it("records that the root no longer declares the deprecated alias", () => {
    const root = inventory(REPO_ROOT, repoConfig).get(".");
    assert.deepEqual([...root.declared.keys()], ["@stellar/stellar-sdk"]);
    assert.equal(root.imports.has("stellar-sdk"), false);
  });

  it("normalizes specifiers to package names", () => {
    assert.equal(packageName("stellar-sdk"), "stellar-sdk");
    assert.equal(packageName("stellar-sdk/lib/horizon"), "stellar-sdk");
    assert.equal(
      packageName("@stellar/stellar-sdk/rpc"),
      "@stellar/stellar-sdk"
    );
    assert.equal(packageName("./stellar-sdk"), null);
  });

  it("finds imports, requires, dynamic imports, jest mocks, and module declarations", () => {
    const content = [
      'import { Memo } from "stellar-sdk";',
      "import '@stellar/stellar-sdk';",
      'const sdk = require("stellar-sdk/lib/x");',
      'jest.mock("@stellar/stellar-sdk", () => ({}));',
      'declare module "stellar-sdk" {}',
      'await import("./local");',
    ].join("\n");
    assert.deepEqual(
      [...moduleReferences(content)],
      [
        { line: 1, name: "stellar-sdk" },
        { line: 2, name: "@stellar/stellar-sdk" },
        { line: 3, name: "stellar-sdk" },
        { line: 4, name: "@stellar/stellar-sdk" },
        { line: 5, name: "stellar-sdk" },
      ]
    );
  });

  it("assigns files to the most specific workspace", () => {
    const workspaces = [".", "packages/sdk", "packages/sdk-extra"];
    assert.equal(owningWorkspace("src/a.ts", workspaces), ".");
    assert.equal(
      owningWorkspace("packages/sdk/src/a.ts", workspaces),
      "packages/sdk"
    );
    // Boundary: a sibling directory sharing the prefix is not inside the workspace.
    assert.equal(
      owningWorkspace("packages/sdk-extra/a.ts", workspaces),
      "packages/sdk-extra"
    );
  });

  it("accepts workspaces that declare exactly the alias they import", () => {
    assert.deepEqual(
      check({
        "package.json": manifest({ "@stellar/stellar-sdk": "^14" }),
        "src/a.ts": 'import { Keypair } from "@stellar/stellar-sdk";\n',
        "packages/sdk/package.json": manifest({}, { "stellar-sdk": "^13" }),
        "packages/sdk/src/b.test.ts": 'jest.mock("stellar-sdk");\n',
      }),
      []
    );
  });

  it("reports both aliases declared, one of them unused, and an import resolved only through hoisting", () => {
    assert.deepEqual(
      check({
        "package.json": manifest({
          "@stellar/stellar-sdk": "^14",
          "stellar-sdk": "^13",
        }),
        "src/a.ts": 'import { Keypair } from "@stellar/stellar-sdk";\n',
        "packages/sdk/package.json": manifest({
          "@stellar/stellar-sdk": "^14",
        }),
        "packages/sdk/src/memo.ts":
          '\nimport { Memo } from "stellar-sdk";\nimport { Asset } from "@stellar/stellar-sdk";\n',
      }),
      [
        "package.json: declares @stellar/stellar-sdk and stellar-sdk, which are aliases of one package; keep one (stellar-sdk is the deprecated name of @stellar/stellar-sdk; a workspace declares at most one, and only one it imports.)",
        'package.json: dependencies.stellar-sdk is declared but nothing in workspace "." imports it; remove it',
        'packages/sdk/src/memo.ts:2: imports "stellar-sdk", which packages/sdk/package.json does not declare; it resolves only through another workspace\'s install',
      ]
    );
  });

  it("ignores vendored node_modules and non-source files", () => {
    assert.deepEqual(
      check({
        "package.json": manifest({}),
        "packages/sdk/package.json": manifest({}),
        "node_modules/x/index.js": 'require("stellar-sdk");\n',
        "docs/guide.md": 'import { Server } from "stellar-sdk";\n',
      }),
      []
    );
  });
});
