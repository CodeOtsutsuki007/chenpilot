import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkRunbook,
  checkRunbooks,
  parseTables,
  splitRow,
} from "../../scripts/docs/check-runbooks.mjs";
import { readConfig } from "../../scripts/docs/markdown.mjs";
import { REPO_ROOT, makeFixture, removeFixture } from "./helpers.mjs";

const STEPS_HEADER =
  "| ID | Step | How | Evidence to record |\n| --- | --- | --- | --- |\n";
const FACTS_HEADER =
  "| Fact | Value | Source | Check |\n| --- | --- | --- | --- |\n";
const SOURCE = "const TIMELOCK_LEDGERS: u32 = 720;\n// TODO: enforce role\n";

function check(doc, { scripts = ["contracts:build"], files = {} } = {}) {
  const dir = makeFixture({
    "src/lib.rs": SOURCE,
    "scripts/tool.ts": "",
    ...files,
  });
  try {
    return checkRunbook("RUNBOOK.md", doc, {
      root: dir,
      scripts: new Set(scripts),
      readSource: (rel) => (rel === "src/lib.rs" ? SOURCE : null),
    });
  } finally {
    removeFixture(dir);
  }
}

describe("runbook check", () => {
  it("passes on the repository runbooks", () => {
    assert.deepEqual(
      checkRunbooks(REPO_ROOT, readConfig(REPO_ROOT).runbooks.files),
      []
    );
  });

  it("splits rows on pipes outside code spans", () => {
    assert.deepEqual(splitRow("| a | `x || y` | b \\| c |"), [
      "a",
      "`x || y`",
      "b | c",
    ]);
  });

  it("recognizes step and fact tables and ignores others", () => {
    const tables = parseTables(
      `${STEPS_HEADER}| B1 | s | **Manual** | e |\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n${FACTS_HEADER}| f | \`1\` | \`src/lib.rs\` | \`contains\` |\n`
    );
    assert.deepEqual(
      tables.map((t) => [t.kind, t.rows.length]),
      [
        ["steps", 1],
        ["facts", 1],
      ]
    );
  });

  it("accepts commands, files, step references, and manual steps with evidence", () => {
    const doc =
      STEPS_HEADER +
      "| B1 | Build | `npm run contracts:build` | Hash |\n" +
      "| B2 | Tool | `scripts/tool.ts` | Output |\n" +
      "| B3 | Repeat | B1 | Hash |\n" +
      "| B4 | Deploy | **Manual**: `stellar contract deploy ...` | Tx hash |\n";
    assert.deepEqual(check(doc), []);
  });

  it("fails on unknown scripts, missing files, unknown step references, and unlinked steps", () => {
    const doc =
      STEPS_HEADER +
      "| B1 | Build | `npm run contracts:biuld` | Hash |\n" +
      "| B2 | Tool | `scripts/missing.ts` | Output |\n" +
      "| B3 | Repeat | B9 | Hash |\n" +
      "| B4 | Deploy | deploy the contract | Tx hash |\n";
    const problems = check(doc).join("\n");
    assert.match(
      problems,
      /RUNBOOK\.md:3: B1: `npm run contracts:biuld` is not a script/
    );
    assert.match(problems, /B2: `scripts\/missing\.ts` does not exist/);
    assert.match(problems, /B3: refers to unknown step B9/);
    assert.match(
      problems,
      /B4: name an existing command, file or step, or mark the step \*\*Manual\*\*/
    );
  });

  it("requires evidence, also for manual steps, and unique IDs (boundary: a dash is not evidence)", () => {
    const doc =
      STEPS_HEADER +
      "| B1 | Deploy | **Manual**: deploy | — |\n" +
      "| B1 | Deploy | **Manual**: deploy |  |\n" +
      "| step | Deploy | **Manual** | e |\n";
    const problems = check(doc).join("\n");
    assert.match(problems, /:3: B1: evidence to record is empty/);
    assert.match(problems, /:4: duplicate step ID B1/);
    assert.match(problems, /:4: B1: evidence to record is empty/);
    assert.match(
      problems,
      /step ID "step" must be a letter followed by a number/
    );
  });

  it("fails when there is no step table", () => {
    assert.match(check("# Runbook\n")[0], /no step table found/);
  });

  it("checks constant and contains facts against the source", () => {
    const steps = `${STEPS_HEADER}| B1 | s | **Manual** | e |\n\n`;
    const good =
      FACTS_HEADER +
      "| Delay | `720` | `src/lib.rs` | `const TIMELOCK_LEDGERS` |\n" +
      "| Auth | `// TODO: enforce role` | `src/lib.rs` | `contains` |\n";
    assert.deepEqual(check(steps + good), []);

    const drifted =
      FACTS_HEADER +
      "| Delay | `1_440` | `src/lib.rs` | `const TIMELOCK_LEDGERS` |\n" +
      "| Missing const | `1` | `src/lib.rs` | `const NOPE` |\n" +
      "| Gone | `fn removed` | `src/lib.rs` | `contains` |\n" +
      "| No file | `1` | `src/none.rs` | `contains` |\n" +
      "| Bad check | `1` | `src/lib.rs` | `equals` |\n";
    const problems = check(steps + drifted).join("\n");
    assert.match(
      problems,
      /TIMELOCK_LEDGERS is 720 in src\/lib\.rs, but the runbook says 1_440/
    );
    assert.match(problems, /NOPE is not declared/);
    assert.match(problems, /no longer contains `fn removed`/);
    assert.match(problems, /source src\/none\.rs does not exist/);
    assert.match(problems, /Check must be `const NAME` or `contains`/);
  });
});
