import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  checkPackageManifests,
  entryTargets,
  validateManifest,
} from "../../scripts/repo/check-package-manifests.mjs";
import { readRepoConfig } from "../../scripts/repo/config.mjs";
import { REPO_ROOT, makeFixture, removeFixture } from "../docs/helpers.mjs";

const config = readRepoConfig(REPO_ROOT).packageManifests;
const URL = config.repositoryUrl;

const sdk = {
  name: "@chen-pilot/sdk-core",
  version: "0.1.0",
  license: "ISC",
  repository: { type: "git", url: URL, directory: "packages/sdk" },
  main: "dist/index.js",
  types: "dist/index.d.ts",
};

function validate(manifest, options = {}) {
  return validateManifest(manifest, {
    dir: "packages/sdk",
    config,
    packedFiles: ["package.json", "dist/index.js", "dist/index.d.ts"],
    existsOnDisk: () => false,
    requireEntryFiles: false,
    ...options,
  });
}

describe("package manifest metadata", () => {
  it("accepts a complete packed manifest", () => {
    assert.deepEqual(validate(sdk), []);
  });

  it("the repository manifests declare the required metadata", () => {
    for (const dir of config.packages) {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, dir, "package.json"), "utf8")
      );
      assert.deepEqual(
        validateManifest(manifest, {
          dir,
          config,
          packedFiles: [],
          existsOnDisk: () => false,
          requireEntryFiles: false,
        }),
        [],
        dir
      );
    }
  });

  it("names each missing or empty required field", () => {
    const sparse = {
      name: sdk.name,
      version: "",
      main: sdk.main,
      types: sdk.types,
    };
    assert.deepEqual(validate(sparse), [
      '"version" is missing or empty',
      '"license" is missing or empty',
      '"repository.type" is missing or empty',
      '"repository.url" is missing or empty',
    ]);
  });

  it("rejects shorthand, foreign, and misplaced repository links", () => {
    assert.deepEqual(validate({ ...sdk, repository: "gear5labs/chenpilot" }), [
      '"repository.type" is missing or empty',
      '"repository.url" is missing or empty',
      '"repository" must be an object with "type", "url" and "directory", not the string "gear5labs/chenpilot"',
    ]);
    assert.deepEqual(
      validate({
        ...sdk,
        repository: { type: "svn", url: "https://github.com/someone/fork.git" },
      }),
      [
        '"repository.type" is "svn", expected "git"',
        `"repository.url" is "https://github.com/someone/fork.git", expected "${URL}"`,
        '"repository.directory" is undefined, expected "packages/sdk"',
      ]
    );
    // Boundary: the root manifest must not claim a subdirectory.
    assert.deepEqual(
      validateManifest(
        { ...sdk, repository: { type: "git", url: URL, directory: "." } },
        {
          dir: ".",
          config,
          packedFiles: ["dist/index.js", "dist/index.d.ts"],
          existsOnDisk: () => false,
        }
      ),
      [
        '"repository.directory" is ".", expected it to be absent for the repository root',
      ]
    );
  });

  it("checks entry points against the packed file list", () => {
    const unbuilt = { packedFiles: ["package.json"] };
    // Not built yet: fine by default, an error when entry files are required.
    assert.deepEqual(validate(sdk, unbuilt), []);
    assert.deepEqual(validate(sdk, { ...unbuilt, requireEntryFiles: true }), [
      '"main" is "dist/index.js", which is not in the packed artifact; build the package first',
      '"types" is "dist/index.d.ts", which is not in the packed artifact; build the package first',
    ]);
    // Built but excluded by "files": always an error.
    assert.deepEqual(
      validate(sdk, {
        ...unbuilt,
        existsOnDisk: (rel) => rel === "dist/index.js",
      }),
      [
        '"main" is "dist/index.js", which exists but is not in the packed artifact; check "files"',
      ]
    );
    // Private packages are not published, so only their metadata is checked.
    assert.deepEqual(
      validate(
        { ...sdk, private: true },
        { ...unbuilt, requireEntryFiles: true }
      ),
      []
    );
  });

  it("flattens nested exports and rejects entry points outside the package", () => {
    assert.deepEqual(
      entryTargets("exports", {
        ".": { require: "./dist/index.js" },
        "./package.json": "./package.json",
      }),
      [
        ['exports["."]["require"]', "./dist/index.js"],
        ['exports["./package.json"]', "./package.json"],
      ]
    );
    assert.deepEqual(
      validate({
        ...sdk,
        exports: { ".": "../shared/index.js" },
        bin: { cli: "/usr/bin/x" },
      }),
      [
        '"exports["."]" is "../shared/index.js", expected a path inside the package',
        '"bin["cli"]" is "/usr/bin/x", expected a path inside the package',
      ]
    );
  });

  it("packs a real artifact and reports the exact failing field", () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({
        name: "manifest-fixture",
        version: "1.0.0",
        repository: { type: "git", url: URL },
        // npm always packs "main", so exercise the "files" exclusion with "types".
        main: "lib/index.js",
        types: "dist/index.d.ts",
        files: ["lib/**"],
      }),
      "lib/index.js": "module.exports = 1;\n",
      "dist/index.d.ts": "export {};\n",
    });
    try {
      assert.deepEqual(
        checkPackageManifests(dir, { ...config, packages: ["."] }),
        [
          'package.json (packed manifest-fixture-1.0.0.tgz): "license" is missing or empty',
          'package.json (packed manifest-fixture-1.0.0.tgz): "types" is "dist/index.d.ts", which exists but is not in the packed artifact; check "files"',
        ]
      );
    } finally {
      removeFixture(dir);
    }
  });

  it("reports a package that cannot be packed", () => {
    const dir = makeFixture({ "package.json": "{ not json" });
    try {
      const [problem, ...rest] = checkPackageManifests(dir, {
        ...config,
        packages: ["."],
      });
      assert.match(problem, /^package\.json: npm pack failed: /);
      assert.deepEqual(rest, []);
    } finally {
      removeFixture(dir);
    }
  });
});
