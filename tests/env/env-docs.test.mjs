import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkCoverage,
  checkDoc,
  checkEnvDocs,
  checkEnvExample,
  validateRegistry,
} from "../../scripts/env/check-env-docs.mjs";
import {
  applyTable,
  findCoverage,
  parseDotenv,
  renderTable,
  scanReferences,
} from "../../scripts/env/env-registry.mjs";
import { REPO_ROOT } from "../docs/helpers.mjs";

const entry = (name, extra = {}) => ({
  name,
  service: "backend",
  owner: "Owner",
  required: false,
  default: null,
  secret: false,
  description: "Does a thing.",
  ...extra,
});

const registry = {
  doc: { file: "docs/ENV.md", begin: "<!-- B -->", end: "<!-- E -->" },
  services: { backend: "Backend" },
  variables: [
    entry("DB_HOST", { required: true }),
    entry("API_KEY", { required: true, secret: true }),
    entry("DEFI_*"),
  ],
  exemptions: [{ pattern: "EXAMPLE_ONLY", reason: "Example file." }],
};

const refs = (...names) => new Map(names.map((n) => [n, [`src/a.ts:1`]]));

describe("environment variable scan", () => {
  it("finds direct, bracket, injected-env, helper, and catalog-key references", () => {
    const source = [
      "const a = process.env.DB_HOST;",
      'const b = process.env["API_KEY"];',
      "const c = env?.ABUSE_POLICY_FILE;",
      "const d = requireEnv(",
      '  "NODE_URL"',
      ");",
      'const e = { envVar: "SPONSOR_SECRET_KEY" };',
      "const f = process.env[`${prefix}_ENABLED`];",
      "const g = env.storage(); // lower-case is not a variable",
    ].join("\n");
    const found = scanReferences(source, {
      helpers: ["requireEnv"],
      keys: ["envVar"],
    });
    assert.deepEqual(found, [
      { name: "DB_HOST", line: 1 },
      { name: "API_KEY", line: 2 },
      { name: "ABUSE_POLICY_FILE", line: 3 },
      { name: "NODE_URL", line: 4 },
      { name: "SPONSOR_SECRET_KEY", line: 7 },
    ]);
  });

  it("resolves exact entries before families and exemptions", () => {
    assert.equal(findCoverage(registry, "DB_HOST").kind, "variable");
    assert.equal(findCoverage(registry, "DEFI_X_ENABLED").kind, "family");
    assert.equal(findCoverage(registry, "EXAMPLE_ONLY").kind, "exemption");
    assert.equal(
      findCoverage(registry, "DEFI"),
      null,
      "boundary: a family needs its prefix and suffix"
    );
  });
});

describe("environment variable documentation check", () => {
  it("passes on the repository registry, source, .env.example, and doc", () => {
    assert.deepEqual(checkEnvDocs(REPO_ROOT), []);
  });

  it("accepts references covered by entries, families, and exemptions", () => {
    assert.deepEqual(
      checkCoverage(
        registry,
        refs("DB_HOST", "API_KEY", "DEFI_A_URL", "EXAMPLE_ONLY")
      ),
      []
    );
  });

  it("fails on an undocumented reference and on a stale entry", () => {
    const problems = checkCoverage(registry, refs("DB_HOST", "NEW_FLAG"));
    assert.deepEqual(problems, [
      "src/a.ts:1: NEW_FLAG is referenced but not documented in scripts/env/env-registry.json; add an entry or an exemption with a reason",
      "scripts/env/env-registry.json: API_KEY is documented but no scanned source references it; remove the entry or fix the scan",
    ]);
  });

  it("rejects malformed entries and exemptions without reasons", () => {
    const broken = {
      ...registry,
      variables: [
        entry("A", { owner: "", required: "yes" }),
        entry("A", { service: "worker" }),
        {
          name: "B",
          service: "backend",
          owner: "o",
          description: "d",
          required: false,
          secret: false,
        },
        entry("C_*", { required: true }),
      ],
      exemptions: [{ pattern: "X", reason: " " }],
    };
    const problems = validateRegistry(broken).join("\n");
    assert.match(problems, /A: missing owner/);
    assert.match(problems, /A: "required" must be true or false/);
    assert.match(problems, /A: duplicate entry/);
    assert.match(problems, /A: unknown service "worker"/);
    assert.match(problems, /B: missing "default"/);
    assert.match(problems, /C_\*: a family entry cannot be required/);
    assert.match(problems, /exemption X needs a pattern and a reason/);
  });

  it("requires required variables in .env.example, blank values allowed", () => {
    assert.deepEqual(
      checkEnvExample(registry, "DB_HOST=\nAPI_KEY=your_key\n"),
      []
    );
    assert.deepEqual(checkEnvExample(registry, "# DB_HOST=\nAPI_KEY=\n"), [
      ".env.example: required variable DB_HOST is missing; add `DB_HOST=` with a placeholder",
    ]);
  });

  it("detects a stale or marker-less generated table", () => {
    const fresh = applyTable(
      "# Env\n<!-- B -->\n<!-- E -->\n",
      registry.doc,
      renderTable(registry)
    );
    assert.deepEqual(checkDoc(registry, fresh), []);
    assert.match(
      checkDoc(registry, fresh.replace("Does a thing.", "Edited by hand."))[0],
      /out of date/
    );
    assert.match(checkDoc(registry, "# Env\n")[0], /markers are missing/);
  });

  it("renders requiredness, defaults, and secret status", () => {
    const table = renderTable({
      ...registry,
      variables: [
        entry("KEY", { requiredUnless: "KEYRING", secret: true }),
        entry("MODE", { default: "" }),
        entry("PORT", { default: "2333", required: true }),
      ],
    });
    assert.match(
      table,
      /\| `KEY` \| Owner \| Unless `KEYRING` is set \| — \| Yes \|/
    );
    assert.match(table, /\| `MODE` \| Owner \| No \| empty \| No \|/);
    assert.match(table, /\| `PORT` \| Owner \| Yes \| `2333` \| No \|/);
    assert.match(table, /\| `EXAMPLE_ONLY` \| Example file\. \|/);
  });

  it("parses dotenv files without evaluating them", () => {
    const parsed = parseDotenv(
      'A=1\n  export B="two words"\nC=3 # note\n# D=4\nE=\n'
    );
    assert.deepEqual(
      [...parsed],
      [
        ["A", "1"],
        ["B", "two words"],
        ["C", "3"],
        ["E", ""],
      ]
    );
  });
});
