import assert from "node:assert/strict";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import {
  checkConfig,
  checkNode,
  checkPackageManager,
  checkPostgres,
  checkRedis,
  formatResults,
  loadEnv,
  runPreflight,
} from "../../scripts/env/preflight.mjs";
import { makeFixture, removeFixture, REPO_ROOT } from "../docs/helpers.mjs";

const SECRET = "super-secret-value-that-must-not-leak-0123456789";

const registry = {
  services: { backend: "Backend" },
  variables: [
    { name: "DB_HOST", service: "backend", required: true, secret: false },
    { name: "API_KEY", service: "backend", required: true, secret: true },
    {
      name: "JWT_SECRET",
      service: "backend",
      required: true,
      secret: true,
      validate: { minLength: 32 },
    },
    {
      name: "ENCRYPTION_KEY",
      service: "backend",
      required: false,
      requiredUnless: "ENCRYPTION_KEYS_JSON",
      secret: true,
      validate: {
        pattern: "^[0-9a-f]{64}$",
        hint: "a 64-character hex string",
      },
    },
    { name: "OPTIONAL", service: "backend", required: false, secret: false },
    { name: "BOT_TOKEN", service: "bot", required: true, secret: true },
  ],
};

const env = (entries) => new Map(Object.entries(entries));
const complete = {
  DB_HOST: "localhost",
  API_KEY: SECRET,
  JWT_SECRET: SECRET,
  ENCRYPTION_KEY: "a".repeat(64),
};

/** A fake Redis that answers each command line with the given reply. */
function fakeRedis(replyFor) {
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      // RESP arrays: *N\r\n then N bulk strings; reply once per full command.
      for (;;) {
        const m = buffer.match(/^\*(\d+)\r\n/);
        if (!m) return;
        const parts = buffer.split("\r\n");
        const needed = 1 + Number(m[1]) * 2;
        if (parts.length <= needed) return;
        const args = [];
        for (let i = 2; i < needed; i += 2) args.push(parts[i]);
        socket.write(`${replyFor(args)}\r\n`);
        buffer = parts.slice(needed).join("\r\n");
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server))
  );
}

/** A port with nothing listening on it. */
async function closedPort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

describe("preflight: toolchain", () => {
  it("accepts the minimum Node.js major and rejects older ones (boundary)", () => {
    assert.equal(checkNode("18.0.0").status, "ok");
    const old = checkNode("17.9.1");
    assert.equal(old.status, "fail");
    assert.match(old.fix, /nvm install 20/);
  });

  it("fails with an install hint when no package manager is on PATH", () => {
    const result = checkPackageManager(REPO_ROOT, () => null);
    assert.equal(result.status, "fail");
    assert.match(result.fix, /npm install -g pnpm/);
  });

  it("warns, but passes, when only npm is available", () => {
    const result = checkPackageManager(REPO_ROOT, (cmd) =>
      cmd === "npm" ? "10.0.0" : null
    );
    assert.equal(result.status, "warn");
  });
});

describe("preflight: configuration", () => {
  it("passes when every required backend variable is set", () => {
    const [result] = checkConfig(registry, env(complete), {
      envFiles: [".env"],
    });
    assert.equal(result.status, "ok");
  });

  it("names missing variables, ignores other services, and suggests copying .env.example", () => {
    const [result] = checkConfig(registry, env({ DB_HOST: "  " }));
    assert.equal(result.status, "fail");
    assert.match(
      result.message,
      /DB_HOST, API_KEY, JWT_SECRET, ENCRYPTION_KEY \(or ENCRYPTION_KEYS_JSON\)/
    );
    assert.doesNotMatch(result.message, /BOT_TOKEN|OPTIONAL/);
    assert.match(result.fix, /cp \.env\.example \.env/);
  });

  it("treats a conditional variable as satisfied by its alternative", () => {
    const rest = { ...complete };
    delete rest.ENCRYPTION_KEY;
    const results = checkConfig(
      registry,
      env({ ...rest, ENCRYPTION_KEYS_JSON: '{"k1":"..."}' })
    );
    assert.deepEqual(
      results.map((r) => r.status),
      ["ok"]
    );
  });

  it("reports invalid values without printing them", () => {
    const results = checkConfig(
      registry,
      env({ ...complete, JWT_SECRET: "x".repeat(31), ENCRYPTION_KEY: SECRET })
    );
    const output = formatResults(results);
    assert.match(output, /JWT_SECRET is shorter than 32 characters/);
    assert.match(output, /ENCRYPTION_KEY is not a 64-character hex string/);
    assert.ok(!output.includes(SECRET), "secret value leaked into output");
    assert.ok(
      !output.includes("x".repeat(31)),
      "invalid value leaked into output"
    );
  });

  it("warns when a value is still the .env.example placeholder", () => {
    const example = new Map([["API_KEY", "your_api_key"]]);
    const results = checkConfig(
      registry,
      env({ ...complete, API_KEY: "your_api_key" }),
      { example }
    );
    assert.deepEqual(
      results.map((r) => r.status),
      ["warn"]
    );
    assert.match(results[0].message, /API_KEY/);
  });
});

describe("preflight: environment loading", () => {
  it("prefers the process environment, then the first file that sets a key", () => {
    const dir = makeFixture({
      ".env.local": "A=local\n",
      ".env": "A=dotenv\nB=dotenv\n# C=commented\nexport D='quoted value'\n",
    });
    try {
      const { env: merged, found } = loadEnv(
        dir,
        [".env.local", ".env", ".env.missing"],
        { B: "process" }
      );
      assert.deepEqual(found, [".env.local", ".env"]);
      assert.equal(merged.get("A"), "local");
      assert.equal(merged.get("B"), "process");
      assert.equal(merged.has("C"), false);
      assert.equal(merged.get("D"), "quoted value");
    } finally {
      removeFixture(dir);
    }
  });
});

describe("preflight: services", () => {
  let server;
  let port;
  const PASSWORD = "redis-password-not-to-print";

  before(async () => {
    server = await fakeRedis(([cmd, arg]) => {
      if (cmd === "AUTH")
        return arg === PASSWORD
          ? "+OK"
          : "-WRONGPASS invalid username-password pair";
      return "+PONG";
    });
    port = server.address().port;
  });
  after(() => server.close());

  it("passes when Redis answers PING after AUTH", async () => {
    const result = await checkRedis(
      env({
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: String(port),
        REDIS_PASSWORD: PASSWORD,
      })
    );
    assert.equal(result.status, "ok");
  });

  it("reports a rejected Redis password without printing it", async () => {
    const result = await checkRedis(
      env({
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: String(port),
        REDIS_PASSWORD: "wrong-password-value",
      })
    );
    assert.equal(result.status, "fail");
    assert.match(result.message, /rejected REDIS_PASSWORD/);
    assert.ok(!formatResults([result]).includes("wrong-password-value"));
  });

  it("asks for REDIS_PASSWORD when the server requires one", async () => {
    const auth = await fakeRedis(() => "-NOAUTH Authentication required.");
    try {
      const result = await checkRedis(
        env({
          REDIS_HOST: "127.0.0.1",
          REDIS_PORT: String(auth.address().port),
        })
      );
      assert.equal(result.status, "fail");
      assert.match(result.fix, /Set REDIS_PASSWORD/);
    } finally {
      auth.close();
    }
  });

  it("explains how to start Redis when nothing is listening", async () => {
    const result = await checkRedis(
      env({ REDIS_HOST: "127.0.0.1", REDIS_PORT: String(await closedPort()) })
    );
    assert.equal(result.status, "fail");
    assert.match(result.message, /ECONNREFUSED/);
    assert.match(result.fix, /docker run .* redis:7/);
  });

  it("fails PostgreSQL early when DB_HOST is unset", async () => {
    const result = await checkPostgres(env({}));
    assert.equal(result.status, "fail");
    assert.match(result.fix, /Set DB_HOST/);
  });

  it("explains how to start PostgreSQL when nothing is listening", async () => {
    const result = await checkPostgres(
      env({ DB_HOST: "127.0.0.1", DB_PORT: String(await closedPort()) })
    );
    assert.equal(result.status, "fail");
    assert.match(result.fix, /postgres:15/);
  });

  it("maps PostgreSQL error codes to fixes without printing the password", async () => {
    // The TCP probe needs a listener; the fake pg client fails authentication.
    const pg = {
      Client: class {
        async connect() {
          throw Object.assign(
            new Error(`password authentication failed: ${SECRET}`),
            { code: "28P01" }
          );
        }
        async end() {}
      },
    };
    const result = await checkPostgres(
      env({
        DB_HOST: "127.0.0.1",
        DB_PORT: String(port),
        DB_USERNAME: "u",
        DB_PASSWORD: SECRET,
        DB_NAME: "d",
      }),
      { pg }
    );
    assert.equal(result.status, "fail");
    assert.match(result.message, /authentication failed/);
    assert.match(result.fix, /DB_USERNAME and DB_PASSWORD/);
    assert.ok(!formatResults([result]).includes(SECRET));
  });

  it("warns when the port is reachable but pg is not installed", async () => {
    const result = await checkPostgres(
      env({ DB_HOST: "127.0.0.1", DB_PORT: String(port) }),
      { pg: null }
    );
    assert.equal(result.status, "warn");
    assert.match(result.fix, /pnpm install/);
  });
});

describe("preflight: runner", () => {
  it("runs against the repository registry and skips services on request", async () => {
    const results = await runPreflight({
      root: REPO_ROOT,
      env: new Map(),
      skipServices: true,
      versionOf: () => "9.0.0",
      nodeVersion: "20.0.0",
    });
    const names = results.map((r) => r.name);
    for (const name of [
      "Node.js",
      "Package manager",
      "Dependencies",
      "Configuration",
      "PostgreSQL",
      "Redis",
    ]) {
      assert.ok(names.includes(name), `missing ${name} check`);
    }
    const config = results.find((r) => r.name === "Configuration");
    assert.equal(config.status, "fail");
    assert.match(config.message, /DB_HOST/);
    assert.match(formatResults(results), /check\(s\) failed/);
  });
});
