# Contributing to Chen Pilot

Thank you for your interest in contributing to Chen Pilot! We're building the most intelligent gateway for cross-chain DeFi operations, and we'd love your help.

## 🚀 Getting Started

1.  **Fork the Project**: Create your own copy of the repository.
2.  **Environment Setup**:
    - Install Node.js (18+).
    - Install `pnpm` (`npm install -g pnpm`).
    - Run `pnpm install`.
    - Copy `.env.example` to `.env` and configure your keys. [docs/ENVIRONMENT_VARIABLES.md](docs/ENVIRONMENT_VARIABLES.md) lists every variable, its owner, whether it is required, its default, and whether it is secret.
    - Run `npm run preflight` (see [Local environment preflight](#local-environment-preflight)).
3.  **Run Locally**:
    - `npm run migration:run` (Requires a running PostgreSQL instance; see [docs/DATA_MIGRATIONS.md](docs/DATA_MIGRATIONS.md)).
    - `npm run dev`.

### Local environment preflight

`npm run preflight` checks, before anything else fails later:

| Check | Fails when |
| --- | --- |
| Node.js | The version is older than 18. |
| Package manager | Neither pnpm nor npm is on `PATH` (warns when only npm is). |
| Dependencies | `node_modules` is missing (warns when `package-lock.json` changed since the last install). |
| Configuration | A required backend variable is missing or malformed, for example `JWT_SECRET` shorter than 32 characters (warns when a value is still the `.env.example` placeholder). |
| PostgreSQL | `DB_HOST:DB_PORT` is unreachable, or the credentials or database in `DB_*` are rejected. |
| Redis | `REDIS_HOST:REDIS_PORT` is unreachable, rejects `REDIS_PASSWORD`, or does not answer `PING`. |

Each failure prints a fix, such as the `docker run` command that starts the missing service. It reads configuration the way the backend does (process environment, then `.env.local`, then `.env`) and never prints values, only variable names. It exits with status 1 when a check fails.

Options: `--env-file <path>` (repeatable) reads other files instead of `.env.local` and `.env`, `--skip-services` skips the PostgreSQL and Redis checks, and `--timeout <ms>` sets the connection timeout (default 3000).

## 🛠️ How to Contribute

### 1. Find an Issue

Look at our [Issues list](https://github.com/chen-pilot/chen-pilot-experimental/issues) for tasks labeled `help wanted` or `good first issue`. We have a roadmap of 50 priority issues focused on building a world-class **DeFi Agent on Stellar** (Yield strategies, Portfolio management, and Protocol integrations).

### 2. Your First PR

New to the project? Here's a concrete walkthrough for your first contribution.

#### Environment sanity check

Before picking up an issue, confirm your local environment works:

```bash
pnpm install
npm test                  # runs Jest — all tests should pass
npm run build:check       # runs tsc --noEmit — no type errors
```

If both pass, you're ready to contribute.

#### Suggested first issues

Good starter categories:
- **Docs** — improve README sections, fix typos, clarify API docs
- **Test coverage** — add missing unit tests for existing services
- **Type-safety** — replace `any` with proper types (we've added an ESLint rule `@typescript-eslint/no-explicit-any` to flag these)

Browse all [good first issues](https://github.com/gear5labs/chenpilot/issues?q=label%3A%22good+first+issue%22) for a starting point.

#### What reviewers look for

- **Conventional commit format** — `feat:`, `fix:`, `docs:`, `test:`, `refactor:`
- **Strict typing** — no `any` unless absolutely necessary
- **Tests** — include or update tests for your change
- **Linting** — pre-commit hooks run `lint-staged` automatically; make sure they pass
- **Scope** — keep PRs focused on a single issue

### 3. Creating a Pull Request

- Create a branch from `main`: `git checkout -b feature/your-feature-name`.
- Commit your changes using **Conventional Commits**:
  - `feat: add automated yield farming strategy`
  - `fix: resolve profit calculation bug in portfolio tool`
  - `docs: update strategy contribution guide`
- Push to your fork and submit a PR to `main`.

## 📐 Coding Standards

- **TypeScript**: Use strict typing. Avoid `any` unless absolutely necessary.
- **Tools**: All new tools should extend `BaseTool` and be placed in `src/Agents/tools/`.
- **Testing**: Add unit tests for new logic in the `tests/unit` directory.
- **Linting**: We use Husky and lint-staged. Your code will be automatically formatted and linted on commit.

### Local diagnostics

Save terminal captures and other local diagnostics (for example `tsc` or `jest` output written to a file) in the `.artifacts/` directory, never the repository root. `.artifacts/` and root-level `_*.txt` files are ignored by Git, and CI fails if a root-level `_*.txt` file is committed. If a capture is worth keeping as evidence, summarize it in the pull request description instead.

### Documentation checks

CI runs these checks on every push and pull request (`.github/workflows/docs-checks.yml`). Run them locally before you push:

| Command | What it checks |
| --- | --- |
| `npm run docs:check` | Runs all of the checks below. |
| `node scripts/docs/check-markdown-links.mjs` | Relative links in tracked Markdown resolve to existing files. Failures are reported as `source.md:line: broken link "target" -> resolved/path`. External URLs and `#anchors` are skipped. Generated or tool-owned files are excluded only by the explicit `linkCheck.exclude` rules (each with a reason) in `scripts/docs/docs-check.config.json`. |
| `node scripts/docs/check-doc-index.mjs` | `INDEX.md` has no duplicate section headings, no duplicate links to the same document, and no stale paths, and its generated Documentation Map is up to date. |
| `npm run docs:index` | Regenerates the Documentation Map block in `INDEX.md` from the Markdown files under `docs/`. Run it after you add, move, or retitle a document under `docs/`. Edit the curated entries above the block by hand. |
| `node scripts/docs/check-archive.mjs` | Archived reports follow the [documentation archival policy](docs/DOCUMENTATION_ARCHIVAL_POLICY.md). |
| `node scripts/docs/check-runbooks.mjs` | Every step in the [contract deployment runbook](docs/CONTRACT_DEPLOYMENT_RUNBOOK.md) names an existing `npm run` script, file, or step, or is marked **Manual** with the evidence to record, and its source-checked facts (such as the upgrade delay) still match the code. |
| `npm run env:check` | Every environment variable referenced in source is documented in `scripts/env/env-registry.json` (or explicitly exempted), every entry is still used, required variables appear in `.env.example`, and [docs/ENVIRONMENT_VARIABLES.md](docs/ENVIRONMENT_VARIABLES.md) is up to date. Run `npm run env:docs` to regenerate the table after editing the registry. |
| `npm run migrations:check` | Migrations follow the naming and transaction rules in [docs/DATA_MIGRATIONS.md](docs/DATA_MIGRATIONS.md). |
| `npm run test:docs` | Unit tests for the checkers (`tests/docs/`, `tests/env/`, `tests/migrations/`). |

When an issue's implementation or delivery reports are complete, archive them as described in the [documentation archival policy](docs/DOCUMENTATION_ARCHIVAL_POLICY.md) instead of leaving them in the repository root.

### Configuration file convention

Tool configuration files (ESLint, commitlint, etc.) use the `.mjs` or `.js` extension — not `.mts` or `.ts` — because most tools do not natively resolve TypeScript config files. Keep configs in JavaScript unless the tool explicitly documents TypeScript support.

## 🏛️ Architecture Overview

- **Gateway**: The API entry point (`src/Gateway`).
- **Agents**: The brain of the operation (`src/Agents`).
- **Tools**: Specialized functions the agent can call (`src/Agents/tools`).
- **Registry**: Where tools and prompt templates are managed.

## 💬 Communication

If you have questions, feel free to open an issue or join our community discussions!

---

_Chen Pilot — Automating the Multi-Chain Future._
