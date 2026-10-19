import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Example migration for docs/DATA_MIGRATIONS.md (non-transactional index).
 *
 * PostgreSQL refuses `CREATE INDEX CONCURRENTLY` inside a transaction, so this
 * migration opts out with `transaction = false`. TypeORM then refuses to run
 * it in the default `all` mode (ForbiddenTransactionModeOverrideError); apply
 * it with `npm run migration:run -- --transaction each`.
 *
 * A failed concurrent build leaves an INVALID index behind. `IF NOT EXISTS`
 * would then skip the rebuild, so `up` drops an invalid leftover first.
 */
export class IndexExampleNoteAuthor1792368000001 implements MigrationInterface {
  name = "IndexExampleNoteAuthor1792368000001";
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const invalid = await queryRunner.query(`
      SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'IDX_example_note_author_id' AND NOT i.indisvalid
    `);
    if (invalid.length > 0) {
      await queryRunner.query(
        `DROP INDEX CONCURRENTLY IF EXISTS "IDX_example_note_author_id"`
      );
    }
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_example_note_author_id" ON "example_note" ("author_id")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "IDX_example_note_author_id"`
    );
  }
}
