import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkMigrationFile,
  checkMigrations,
  loadMigrationFiles,
  readConfig,
} from "../../scripts/migrations/check-migrations.mjs";
import { REPO_ROOT } from "../docs/helpers.mjs";

const migration = (cls, { name = cls, body = "", extra = "" } = {}) => `
import { MigrationInterface, QueryRunner } from "typeorm";
// export class NotAMigration implements MigrationInterface {} (comment, ignored)
export class ${cls} implements MigrationInterface {
  name = "${name}";
  ${extra}
  public async up(queryRunner: QueryRunner): Promise<void> {
    ${body}
  }
  public async down(queryRunner: QueryRunner): Promise<void> {}
}
`;

const FILE = "src/migrations/1792368000000-AddThing.ts";

describe("migration convention check", () => {
  it("passes on the repository migrations and the documented examples", () => {
    const config = readConfig(REPO_ROOT);
    const files = loadMigrationFiles(REPO_ROOT, config.dirs);
    assert.ok(
      Object.keys(files).some((f) => f.startsWith("docs/examples/migrations/"))
    );
    assert.ok(
      !Object.keys(files).some((f) => f.includes("/preflight/")),
      "subdirectories are not migrations"
    );
    assert.deepEqual(checkMigrations(files, config), []);
  });

  it("accepts a well-formed migration", () => {
    assert.deepEqual(
      checkMigrationFile(FILE, migration("AddThing1792368000000")).problems,
      []
    );
  });

  it("rejects a file name without a 13-digit timestamp", () => {
    const { problems } = checkMigrationFile(
      "src/migrations/179236800000-AddThing.ts",
      migration("AddThing179236800000")
    );
    assert.match(
      problems[0],
      /file name must be `<13-digit epoch ms>-<Name>\.ts`/
    );
  });

  it("rejects a class or name that does not match the timestamp", () => {
    const wrongClass = checkMigrationFile(
      FILE,
      migration("AddThing1792368000001")
    );
    assert.match(
      wrongClass.problems[0],
      /must end with the file timestamp 1792368000000/
    );
    const wrongName = checkMigrationFile(
      FILE,
      migration("AddThing1792368000000", { name: "AddThing" })
    );
    assert.match(
      wrongName.problems[0],
      /name "AddThing" must equal the class name/
    );
  });

  it("requires exactly one migration class and both up and down", () => {
    assert.match(
      checkMigrationFile(FILE, "export const x = 1;").problems[0],
      /exactly one class/
    );
    const noDown = migration("AddThing1792368000000").replace(
      /public async down[^}]*\}/,
      ""
    );
    assert.match(
      checkMigrationFile(FILE, noDown).problems.join("\n"),
      /must define `async down\(queryRunner\)`/
    );
  });

  it("requires transaction = false for CONCURRENTLY and forbids transaction = true", () => {
    const body =
      'await queryRunner.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "i" ON "t" ("c")`);';
    assert.match(
      checkMigrationFile(FILE, migration("AddThing1792368000000", { body }))
        .problems[0],
      /set `transaction = false`/
    );
    assert.deepEqual(
      checkMigrationFile(
        FILE,
        migration("AddThing1792368000000", {
          body,
          extra: "transaction = false;",
        })
      ).problems,
      []
    );
    assert.match(
      checkMigrationFile(
        FILE,
        migration("AddThing1792368000000", { extra: "transaction = true;" })
      ).problems[0],
      /`transaction = true`/
    );
  });

  it("rejects duplicate timestamps unless exempted (boundary: same timestamp, different directory)", () => {
    const files = {
      "src/migrations/1792368000000-A.ts": migration("A1792368000000"),
      "src/migrations/1792368000000-B.ts": migration("B1792368000000"),
      "docs/examples/migrations/1792368000000-C.ts":
        migration("C1792368000000"),
    };
    const problems = checkMigrations(files);
    assert.equal(problems.length, 1);
    assert.match(
      problems[0],
      /^src\/migrations\/1792368000000-B\.ts: timestamp 1792368000000 is already used/
    );
    assert.deepEqual(
      checkMigrations(files, {
        duplicateTimestampExemptions: [
          { timestamp: "1792368000000", reason: "legacy" },
        ],
      }),
      []
    );
  });
});
