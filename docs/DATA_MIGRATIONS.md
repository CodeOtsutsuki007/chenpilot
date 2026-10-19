# Data Migrations: Authoring and Rollback

The lifecycle for a PostgreSQL schema or data change: generate, review, apply,
verify, and, when needed, revert. Migrations use TypeORM and live in
`src/migrations/`.

Every command and result below was run against the configured datasource
(`src/config/migrationDataSource.ts`, which re-exports
`src/config/Datasource.ts`) with TypeORM 0.3.28 and PostgreSQL 15 on
2026-10-19. The example migrations are tested by
`tests/integration/migration_examples.integration.test.ts`.

## Before you start

Run `npm run preflight`. It checks that PostgreSQL is reachable with your
`DB_*` settings and that the configuration `src/config/config.ts` needs at
import time is present. Every migration command loads that configuration, so a
missing `JWT_SECRET` fails a migration as surely as a stopped database.

## Commands

| Command                                                       | What it does                                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `npm run migration:show`                                      | Lists migrations; `[X]` is applied, `[ ]` is pending. Read-only.                                                     |
| `npm run migration:generate -- src/migrations/<Name>`         | Diffs the entities against the database and writes `src/migrations/<timestamp>-<Name>.ts`.                           |
| `npm run migration:run`                                       | Applies every pending migration in one transaction (mode `all`).                                                     |
| `npm run migration:run -- --transaction each`                 | Applies each pending migration in its own transaction. Required when a pending migration sets `transaction = false`. |
| `npm run migration:revert`                                    | Reverts the most recently applied migration, inside a transaction.                                                   |
| `npm run migration:revert -- --transaction none`              | Reverts without a transaction. Required for a migration that sets `transaction = false`.                             |
| `npm run migrations:check`                                    | Checks naming and transaction conventions (also runs in CI).                                                         |
| `npx ts-node --transpile-only scripts/migration-preflight.ts` | Preflight gate: ordering, up/down presence, and drift warnings.                                                      |

`migration:generate` compares against the database you point it at. Generate
against a database that has every existing migration applied, or the diff will
contain the whole schema.

In production (`NODE_ENV` other than `development`) the datasource loads
compiled migrations from `dist/migrations/`, so run `npm run build` before
`migration:run`. The deploy workflow (`.github/workflows/deploy.yml`) does not
run migrations; whoever deploys runs them.

## Naming

- File: `<13-digit epoch milliseconds>-<PascalCaseName>.ts`, for example
  `1792368000000-CreateExampleNote.ts`. `migration:generate` creates this for
  you. For a hand-written migration, get a timestamp with
  `node -e "console.log(Date.now())"`.
- Class: `<PascalCaseName><timestamp>`, for example
  `CreateExampleNote1792368000000`. TypeORM reads the timestamp from the class
  name and refuses a class without one.
- `name` property: set it to the class name.
- One migration class per file, with both `up` and `down`.
- Top level of `src/migrations/` only. Subdirectories such as
  `src/migrations/preflight/` hold tooling and are not loaded as migrations.
- Use a timestamp later than the newest migration on `master`, and never reuse
  one. TypeORM applies pending migrations in timestamp order.
- Never rename or edit a migration that has been applied anywhere. TypeORM
  tracks applied migrations by name, so a renamed migration runs again.

`npm run migrations:check` enforces these rules. Five timestamps were already
shared by two or more migrations when the check was added; they are listed with
a reason in `scripts/migrations/migrations-check.config.json` and must not grow.

## Transactions

`npm run migration:run` uses TypeORM's default mode, `all`: every pending
migration runs in **one** transaction. If any migration fails, all of them roll
back and `migration:show` reports them all as pending again. Write each
migration so it can run in the same transaction as the ones before it.

Some PostgreSQL statements cannot run inside a transaction, most often
`CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY`. For those:

1. Set `transaction = false` on the migration class.
2. Apply with `npm run migration:run -- --transaction each`. In mode `all`,
   TypeORM refuses to run anything while such a migration is pending:

   ```text
   ForbiddenTransactionModeOverrideError: Migrations "IndexExampleNoteAuthor1792368000001" override the transaction mode, but the global transaction mode is "all"
   ```

3. Revert with `npm run migration:revert -- --transaction none`. `migration:revert`
   ignores the class's `transaction = false`, so the default revert fails:

   ```text
   QueryFailedError: DROP INDEX CONCURRENTLY cannot run inside a transaction block
   ```

A migration without a transaction is not atomic. If it fails halfway, the
statements before the failure stay applied, so guard every statement
(`IF NOT EXISTS`, `IF EXISTS`) and make `up` safe to run again. A failed
`CREATE INDEX CONCURRENTLY` leaves an `INVALID` index that `IF NOT EXISTS`
would then skip; the example drops it first.

Do not set `transaction = true`. In mode `all` it also triggers
`ForbiddenTransactionModeOverrideError`, and the check rejects it.

## Compatibility window

During a deploy, the old code (release N) is still serving traffic when the
migration runs, and the old code returns if the deploy is rolled back. Every
migration must therefore work with **both** release N and release N+1. Split
breaking changes across releases (expand, then contract):

| Release        | Schema change                                                                                   | Code change                                        |
| -------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| N+1 (expand)   | Add the new table or a nullable column, or a column with a default. Build indexes concurrently. | Write both old and new shapes; read the old shape. |
| N+1 (backfill) | Backfill in batches, in a separate migration or job.                                            | Read the new shape with a fallback.                |
| N+2 (contract) | Drop the old column or table, or add `NOT NULL`.                                                | Use only the new shape.                            |

Keep at least one full release between expand and contract, so rolling back
one release never meets a schema it cannot read. Destructive operations
(`DROP TABLE`, `DROP COLUMN`, type changes, `NOT NULL` without a default) need
a reviewed waiver; see `src/migrations/preflight/migrationPreflight.ts`.

## Rollback limitations

- **One at a time.** `migration:revert` undoes only the newest applied
  migration. Run it again for each further step, newest first.
- **`down` does not restore data.** Dropping a table or column in `down`
  deletes the rows written since `up` ran. Back up first if that data matters.
- **Data migrations are usually one-way.** A backfill or transformation often
  cannot be undone exactly. Prefer a new forward migration that corrects the
  data over reverting.
- **Revert the code first.** If release N+1 depends on the new schema, roll the
  application back to N before reverting the migration.
- **Non-transactional migrations can be half applied.** Inspect the database
  before reverting one that failed.
- **Anything `down` does not mention stays.** Locks taken, data rewritten, and
  extensions created are not undone automatically.

## Review checklist

- [ ] File, class, and `name` follow the naming rules; `npm run migrations:check` passes.
- [ ] Works with release N and N+1 (compatibility window).
- [ ] Every statement is guarded, or the migration runs in a transaction.
- [ ] `down` reverses `up`, and the pull request states what data `down` loses.
- [ ] Long-running or locking statements (index builds, backfills) are concurrent or batched.
- [ ] The preflight gate passes: `npx ts-node --transpile-only scripts/migration-preflight.ts`.
- [ ] Applied, reverted, and re-applied locally; the output is in the pull request.

## Worked example

The two files in `docs/examples/migrations/` show an expand step and a
concurrent index:

- `docs/examples/migrations/1792368000000-CreateExampleNote.ts` creates a
  table and runs in the shared transaction.
- `docs/examples/migrations/1792368000001-IndexExampleNoteAuthor.ts` builds an
  index with `CREATE INDEX CONCURRENTLY` and sets `transaction = false`.

To walk through the lifecycle against your local database, copy them into
`src/migrations/`, then:

```bash
npm run migration:run                          # refused: ForbiddenTransactionModeOverrideError
npm run migration:run -- --transaction each    # applies both
npm run migration:show                         # [X] CreateExampleNote1792368000000
                                               # [X] IndexExampleNoteAuthor1792368000001
npm run migration:revert                       # refused: DROP INDEX CONCURRENTLY cannot run inside a transaction block
npm run migration:revert -- --transaction none # reverts IndexExampleNoteAuthor1792368000001
npm run migration:revert                       # reverts CreateExampleNote1792368000000
```

Delete the copies when you are done. Do not commit them to `src/migrations/`.

The same sequence runs as an automated test against a real database:

```bash
MIGRATION_EXAMPLES_DB=1 npx jest tests/integration/migration_examples --runInBand
```

It uses the `DB_*` variables, its own migrations table, and drops everything it
creates. Without `MIGRATION_EXAMPLES_DB=1`, only the SQL-level tests run.

## Known issues

- **A fresh database cannot be migrated from scratch.**
  `SecurityGradeAuditLedger1748800000000` creates an index on
  `audit_log.created_at`, but `CreateAuditLogTable1740499200000` creates the
  column as `createdAt`, so `npm run migration:run` on an empty database fails
  there and rolls everything back. Applied migrations must not be edited; the
  fix needs a new migration and a decision about existing environments.
