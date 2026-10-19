# Generated Files Policy

Generated files and authored files live side by side in this repository. For example, root-level JavaScript such as `server.js` and `config.js` is authored, while JavaScript compiled from TypeScript is not. `packages/sdk/docs/` holds hand-written guides next to TypeDoc's HTML output. A blanket ignore rule such as `*.js` or `packages/sdk/docs/` would hide authored files, and `git clean -X` would delete them. This policy says which generated files may be committed, which are build outputs that must never be committed, and how CI enforces both.

The machine-readable version of this policy is the `generatedFiles` section of [`scripts/repo/repo-check.config.json`](../scripts/repo/repo-check.config.json). `node scripts/repo/check-generated-files.mjs` enforces it, and the `Repository checks` workflow runs it on every push and pull request.

## Generated files that may be tracked

Commit these when the generator changes them, in the same pull request as the change that caused the update. Review them like code.

| Class                       | Allowed paths                                                                                                                  | Generator                                 | Why it is tracked                                                                                                                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lockfile`                  | `pnpm-lock.yaml`, `package-lock.json`, `packages/sdk/package-lock.json`, `packages/sdk/pnpm-lock.yaml`, `contracts/Cargo.lock` | `pnpm install`, `npm install`, `cargo`    | Pins the exact dependency graph. `pnpm-lock.yaml` is the supported lockfile (see [CONTRIBUTING.md](../CONTRIBUTING.md#supported-installation)). The npm lockfiles serve CI jobs that still install with npm. `packages/sdk/pnpm-lock.yaml` is legacy, because pnpm uses the root lockfile in workspace mode. |
| `soroban-test-snapshot`     | `contracts/*/test_snapshots/**/*.json`                                                                                         | `cargo test` (soroban-sdk testutils)      | Golden ledger state that contract tests compare against.                                                                                                                                                                                                                                                     |
| `contract-storage-snapshot` | `contracts/snapshots/*/v*.snapshot.json`                                                                                       | `scripts/extract-storage-schema.ts`       | Released storage layout that upgrade compatibility checks compare against.                                                                                                                                                                                                                                   |
| `generated-doc`             | `docs/TOOLS.md`, `docs/security/privilege-graph.json`                                                                          | `npm run gen:docs`, `npm run authz:graph` | Reviewable reference output. `npm run authz:graph:check` fails when the graph drifts from code.                                                                                                                                                                                                              |

A lockfile or snapshot anywhere else, for example a new `packages/bot/package-lock.json`, is a generated file outside the allowlist, and the check fails.

## Build outputs that must never be tracked

These are reproducible from source, and `.gitignore` ignores all of them. The check fails if one is tracked, and it also fails if `.gitignore` stops ignoring one. It does this by probing sample paths such as `dist/index.js` and `packages/sdk/docs/index.html`.

| Class                     | Paths                                                                                                                                                            | Generator                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `compiled-output`         | `dist/` and `*.tsbuildinfo`, at any depth                                                                                                                        | `tsc` (`npm run build`, `npm run build:sdk`) |
| `emitted-from-typescript` | a `.js`, `.d.ts`, or `.js.map` file next to a `.ts` file with the same name                                                                                      | `tsc` run without an `outDir`                |
| `contract-build-output`   | `contracts/target/`, any `target/`                                                                                                                               | `cargo build`, `cargo test`                  |
| `typedoc-html`            | `packages/sdk/docs/*.html`, `.nojekyll`, and the `assets/`, `classes/`, `enums/`, `functions/`, `interfaces/`, `modules/`, `types/`, `variables/` subdirectories | `npm --prefix packages/sdk run docs`         |
| `test-report`             | `coverage/` at any depth, `redteam-report.json`                                                                                                                  | `jest --coverage`, `npm run redteam`         |
| `packed-artifact`         | `*.tgz`                                                                                                                                                          | `npm pack`, `pnpm pack`                      |

The ignore rules for TypeDoc are deliberately narrow, so the authored Markdown guides in `packages/sdk/docs/` stay tracked.

## Authored files

Everything else is authored. That includes JavaScript with no TypeScript file of the same name, such as `server.js`, `jest.config.js`, and the `scripts/**/*.mjs` checkers, and hand-written declaration files such as `types/*.d.ts`. Authored files must never be matched by `.gitignore`. The check fails for any tracked file that an ignore rule matches, because that file would be lost the next time someone cleans ignored files or re-adds the directory.

## Marked files

A file that says it is generated in its first five lines (for example a `DO NOT EDIT` banner, or Cargo's `@generated` header) is treated as generated, even when no rule above names it. It may be tracked only if it is on the allowlist.

## Adding a new generated file class

1. Decide whether the file is a reviewable artifact (track it) or reproducible output (ignore it).
2. To track it, add an entry to `generatedFiles.tracked` in `scripts/repo/repo-check.config.json`. Give it `detect` globs (what the class looks like anywhere), `allow` globs (where it may live), the `generator`, and a `reason`. Add a row to the first table above.
3. To ignore it, add an entry to `generatedFiles.buildOutputs` with `detect` globs and `probes`. Add a narrow `.gitignore` rule and a row to the second table.
4. Run `node scripts/repo/check-generated-files.mjs` and `npm run test:repo`.
