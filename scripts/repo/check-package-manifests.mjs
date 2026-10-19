#!/usr/bin/env node
// Validates package metadata in the artifacts `npm pack` produces, not just
// the manifests in the working tree: required fields (name, version, license,
// repository, entry point), a repository link that points at this repository
// and the package's own directory, and entry points that are present in the
// tarball. Problems name the exact manifest field that fails.
//
// Usage: node scripts/repo/check-package-manifests.mjs [--require-entry-files]
//
// By default an entry point that has not been built yet is not an error; an
// entry point that exists on disk but is missing from the tarball always is.
// With --require-entry-files (release gates, after building), every entry
// point of a publishable package must be in its tarball.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readRepoConfig } from "./config.mjs";

function getField(manifest, field) {
  return field
    .split(".")
    .reduce((value, key) => (value == null ? undefined : value[key]), manifest);
}

/** Flatten an entry-point field (string, or nested exports/bin object) to [fieldPath, target]. */
export function entryTargets(field, value) {
  if (typeof value === "string") return [[field, value]];
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, inner]) =>
      entryTargets(`${field}["${key}"]`, inner)
    );
  }
  return [];
}

/**
 * Validate one packed manifest. `packedFiles` lists the paths inside the
 * tarball (relative to its `package/` root); `existsOnDisk(relPath)` reports
 * whether a file exists in the package directory.
 */
export function validateManifest(
  manifest,
  { dir, config, packedFiles, existsOnDisk, requireEntryFiles }
) {
  const problems = [];
  for (const field of config.required) {
    const value = getField(manifest, field);
    if (typeof value !== "string" || value.trim() === "") {
      problems.push(`"${field}" is missing or empty`);
    }
  }

  const repository = manifest.repository;
  if (typeof repository === "string") {
    problems.push(
      `"repository" must be an object with "type", "url" and "directory", not the string "${repository}"`
    );
  } else if (repository && typeof repository === "object") {
    if (repository.type !== undefined && repository.type !== "git") {
      problems.push(
        `"repository.type" is "${repository.type}", expected "git"`
      );
    }
    if (
      typeof repository.url === "string" &&
      repository.url !== config.repositoryUrl
    ) {
      problems.push(
        `"repository.url" is "${repository.url}", expected "${config.repositoryUrl}"`
      );
    }
    const expectedDirectory = dir === "." ? undefined : dir;
    if (repository.directory !== expectedDirectory) {
      problems.push(
        expectedDirectory === undefined
          ? `"repository.directory" is "${repository.directory}", expected it to be absent for the repository root`
          : `"repository.directory" is ${JSON.stringify(repository.directory)}, expected "${expectedDirectory}"`
      );
    }
  }

  const packed = new Set(packedFiles);
  for (const field of config.entryPoints) {
    for (const [fieldPath, target] of entryTargets(field, manifest[field])) {
      const rel = path.posix.normalize(target);
      if (
        path.posix.isAbsolute(target) ||
        rel === ".." ||
        rel.startsWith("../")
      ) {
        problems.push(
          `"${fieldPath}" is "${target}", expected a path inside the package`
        );
        continue;
      }
      // Private packages are never published, so their tarball contents do
      // not reach consumers; only the declared metadata is checked.
      if (manifest.private === true || packed.has(rel)) continue;
      if (existsOnDisk(rel)) {
        problems.push(
          `"${fieldPath}" is "${target}", which exists but is not in the packed artifact; check "files"`
        );
      } else if (requireEntryFiles) {
        problems.push(
          `"${fieldPath}" is "${target}", which is not in the packed artifact; build the package first`
        );
      }
    }
  }
  return problems;
}

/** Pack `dir` with npm and return { filename, manifest, files } for the tarball. */
export function packArtifact(root, dir) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-check-"));
  try {
    const output = execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", dest],
      {
        cwd: path.join(root, dir),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const [result] = JSON.parse(output);
    const tarball = path.join(dest, result.filename);
    execFileSync("tar", ["-xzf", tarball, "-C", dest, "package/package.json"]);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dest, "package/package.json"), "utf8")
    );
    return {
      filename: result.filename,
      manifest,
      files: result.files.map((f) => f.path),
    };
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
}

/** Pack and validate every configured package; problems are prefixed with the package and tarball. */
export function checkPackageManifests(
  root,
  config,
  { requireEntryFiles = false } = {}
) {
  const problems = [];
  for (const dir of config.packages) {
    const manifestPath = path.posix.join(dir, "package.json");
    let artifact;
    try {
      artifact = packArtifact(root, dir);
    } catch (error) {
      problems.push(
        `${manifestPath}: npm pack failed: ${String(error.stderr || error.message).trim()}`
      );
      continue;
    }
    const found = validateManifest(artifact.manifest, {
      dir,
      config,
      packedFiles: artifact.files,
      existsOnDisk: (rel) => fs.existsSync(path.join(root, dir, rel)),
      requireEntryFiles,
    });
    for (const problem of found) {
      problems.push(
        `${manifestPath} (packed ${artifact.filename}): ${problem}`
      );
    }
  }
  return problems;
}

function main() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
  );
  const config = readRepoConfig(root).packageManifests;
  const requireEntryFiles = process.argv.includes("--require-entry-files");
  const problems = checkPackageManifests(root, config, { requireEntryFiles });
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} package manifest problem(s). See CONTRIBUTING.md "Repository checks".`
    );
    process.exit(1);
  }
  console.log(
    `Package manifests: OK (${config.packages.join(", ")} packed and validated).`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
