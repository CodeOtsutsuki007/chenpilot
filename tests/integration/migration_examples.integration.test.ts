/**
 * Tests for the example migrations in docs/examples/migrations, which
 * docs/DATA_MIGRATIONS.md walks through.
 *
 * The first block always runs and checks the SQL each step issues. The second
 * block applies and reverts the examples against a real PostgreSQL database
 * and only runs when MIGRATION_EXAMPLES_DB=1, using DB_HOST, DB_PORT,
 * DB_USERNAME, DB_PASSWORD and DB_NAME:
 *
 *   MIGRATION_EXAMPLES_DB=1 npx jest tests/integration/migration_examples --runInBand
 *
 * It uses its own migrations table and drops everything it creates.
 */
import "reflect-metadata";
import { DataSource, QueryRunner } from "typeorm";
import { CreateExampleNote1792368000000 } from "../../docs/examples/migrations/1792368000000-CreateExampleNote";
import { IndexExampleNoteAuthor1792368000001 } from "../../docs/examples/migrations/1792368000001-IndexExampleNoteAuthor";

function recordingRunner(results: unknown[][] = []) {
  const queries: string[] = [];
  const runner = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql.replace(/\s+/g, " ").trim());
      return results.shift() ?? [];
    }),
  } as unknown as QueryRunner;
  return { runner, queries };
}

describe("example migrations (SQL)", () => {
  it("creates the table idempotently and drops it on down", async () => {
    const migration = new CreateExampleNote1792368000000();
    const { runner, queries } = recordingRunner();
    await migration.up(runner);
    await migration.down(runner);
    expect(migration.name).toBe("CreateExampleNote1792368000000");
    expect(
      (migration as { transaction?: boolean }).transaction
    ).toBeUndefined();
    expect(queries[0]).toMatch(/^CREATE TABLE IF NOT EXISTS "example_note"/);
    expect(queries[1]).toBe('DROP TABLE IF EXISTS "example_note"');
  });

  it("builds the index concurrently outside a transaction", async () => {
    const migration = new IndexExampleNoteAuthor1792368000001();
    const { runner, queries } = recordingRunner();
    await migration.up(runner);
    expect(migration.transaction).toBe(false);
    expect(queries).toHaveLength(2);
    expect(queries[1]).toMatch(
      /^CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_example_note_author_id"/
    );
  });

  it("drops an INVALID leftover index before rebuilding it (failure recovery)", async () => {
    const migration = new IndexExampleNoteAuthor1792368000001();
    const { runner, queries } = recordingRunner([[{ "?column?": 1 }]]);
    await migration.up(runner);
    expect(queries[1]).toBe(
      'DROP INDEX CONCURRENTLY IF EXISTS "IDX_example_note_author_id"'
    );
    expect(queries[2]).toMatch(/^CREATE INDEX CONCURRENTLY/);
  });
});

const describeDb =
  process.env.MIGRATION_EXAMPLES_DB === "1" ? describe : describe.skip;

describeDb("example migrations (PostgreSQL)", () => {
  const MIGRATIONS_TABLE = "example_migrations_test";
  let dataSource: DataSource;

  const tableExists = async () =>
    (
      await dataSource.query(`SELECT to_regclass('public.example_note') AS t`)
    )[0].t !== null;
  const indexExists = async () =>
    (
      await dataSource.query(
        `SELECT to_regclass('public."IDX_example_note_author_id"') AS i`
      )
    )[0].i !== null;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: "postgres",
      host: process.env.DB_HOST,
      port: Number.parseInt(process.env.DB_PORT || "5432", 10),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD || undefined,
      database: process.env.DB_NAME,
      migrations: [
        CreateExampleNote1792368000000,
        IndexExampleNoteAuthor1792368000001,
      ],
      migrationsTableName: MIGRATIONS_TABLE,
      logging: false,
    });
    await dataSource.initialize();
    await dataSource.query(`DROP TABLE IF EXISTS "example_note"`);
    await dataSource.query(`DROP TABLE IF EXISTS "${MIGRATIONS_TABLE}"`);
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await dataSource.query(`DROP TABLE IF EXISTS "example_note"`);
    await dataSource.query(`DROP TABLE IF EXISTS "${MIGRATIONS_TABLE}"`);
    await dataSource.destroy();
  });

  it("refuses to run in the default `all` mode because one example opts out of transactions", async () => {
    await expect(
      dataSource.runMigrations({ transaction: "all" })
    ).rejects.toThrow(
      /override the transaction mode, but the global transaction mode is "all"/
    );
    expect(await tableExists()).toBe(false);
  });

  it("applies both examples with --transaction each", async () => {
    const applied = await dataSource.runMigrations({ transaction: "each" });
    expect(applied.map((m) => m.name)).toEqual([
      "CreateExampleNote1792368000000",
      "IndexExampleNoteAuthor1792368000001",
    ]);
    expect(await tableExists()).toBe(true);
    expect(await indexExists()).toBe(true);
    expect(await dataSource.showMigrations()).toBe(false);
  });

  it("cannot revert the concurrent index inside a transaction", async () => {
    await expect(
      dataSource.undoLastMigration({ transaction: "all" })
    ).rejects.toThrow(
      /DROP INDEX CONCURRENTLY cannot run inside a transaction block/
    );
    expect(await indexExists()).toBe(true);
  });

  it("reverts one migration at a time, newest first", async () => {
    await dataSource.undoLastMigration({ transaction: "none" });
    expect(await indexExists()).toBe(false);
    expect(await tableExists()).toBe(true);

    await dataSource.undoLastMigration({ transaction: "all" });
    expect(await tableExists()).toBe(false);
    expect(await dataSource.showMigrations()).toBe(true);
  });
});
