import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Example migration for docs/DATA_MIGRATIONS.md (expand phase).
 *
 * - The file name, class name and `name` share the same timestamp.
 * - It does not set `transaction`, so it runs inside the transaction that
 *   `npm run migration:run` opens for all pending migrations.
 * - Every statement is guarded (`IF NOT EXISTS` / `IF EXISTS`) so a partially
 *   applied environment can be re-run safely.
 * - `down` exactly reverses `up`. Dropping the table discards rows written
 *   after `up` ran; see "Rollback limitations" in the guide.
 */
export class CreateExampleNote1792368000000 implements MigrationInterface {
  name = "CreateExampleNote1792368000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "example_note" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "author_id" uuid NOT NULL,
        "body" text NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_example_note_id" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "example_note"`);
  }
}
