import fs from "fs";
import os from "os";
import path from "path";
import {
  containsSecret,
  EnvSecretProvider,
  isSensitiveKey,
  redactSecretsInString,
  resolveDeploymentEnvironment,
  SecretAccessError,
  SecretDescriptor,
  SecretManager,
  SecretProvider,
  verifySecretConfiguration,
  VersionedSecretStore,
} from "..";
import { redactSensitiveData } from "../../../config/logger";
import { PolicyAction } from "../../../AuditLog/auditEvent.types";
import { AccountSecretError, AccountSecretStore } from "../../../Auth/accountSecretStore";
import { encrypt } from "../../../utils/encryption";

const STELLAR_SEED = "SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4";
const SIGNING_KEY = "k".repeat(40);

const descriptor = (overrides: Partial<SecretDescriptor> = {}): SecretDescriptor => ({
  name: "test.signing-key",
  description: "test",
  kind: "service",
  envVar: "TEST_SIGNING_KEY",
  workflows: ["signing"],
  environments: ["local", "staging", "production"],
  maxLeaseMs: 1000,
  minLength: 32,
  ...overrides,
});

function manager(opts: {
  env?: NodeJS.ProcessEnv;
  environment?: "local" | "staging" | "production";
  catalog?: SecretDescriptor[];
  providers?: SecretProvider[];
  provisionedFor?: string;
} = {}) {
  const logEvent = jest.fn().mockResolvedValue(undefined);
  const m = new SecretManager({
    catalog: opts.catalog ?? [descriptor()],
    providers: opts.providers ?? [new EnvSecretProvider(opts.env ?? { TEST_SIGNING_KEY: SIGNING_KEY })],
    environment: opts.environment ?? "production",
    provisionedFor: opts.provisionedFor ?? "",
    audit: { logEvent },
  });
  return { m, logEvent };
}

describe("SecretManager scoped access", () => {
  it("grants access within scope, zeroizes afterwards and audits without the value", async () => {
    const { m, logEvent } = manager();
    let leaked: { destroyed: boolean } | undefined;

    const length = await m.withSecret("test.signing-key", { workflow: "signing", actor: "svc" }, (secret, info) => {
      leaked = secret;
      expect(info.version).toMatch(/^env:[0-9a-f]{12}$/);
      return secret.consumeString((v) => v.length);
    });

    expect(length).toBe(40);
    expect(leaked?.destroyed).toBe(true);
    const event = logEvent.mock.calls[0][0];
    expect(event).toMatchObject({ action: PolicyAction.SECRET_ACCESSED, success: true, actor: { serviceId: "svc" } });
    expect(event.metadata).toMatchObject({ secretName: "test.signing-key", workflow: "signing", outcome: "granted", environment: "production" });
    expect(JSON.stringify(event)).not.toContain(SIGNING_KEY);
  });

  it("refuses undeclared secrets and out-of-scope workflows", async () => {
    const { m, logEvent } = manager();
    await expect(m.withSecret("nope", { workflow: "signing" }, () => 1)).rejects.toMatchObject({ code: "unknown_secret" });
    await expect(m.withSecret("test.signing-key", { workflow: "swap" }, () => 1)).rejects.toMatchObject({ code: "scope_denied" });
    expect(logEvent.mock.calls.map((c) => c[0].action)).toEqual([PolicyAction.SECRET_ACCESS_DENIED, PolicyAction.SECRET_ACCESS_DENIED]);
  });

  it("expires the lease so plaintext cannot outlive maxLeaseMs", async () => {
    const { m } = manager({ catalog: [descriptor({ maxLeaseMs: 10 })] });
    const error = await m
      .withSecret("test.signing-key", { workflow: "signing" }, async (secret) => {
        await new Promise((r) => setTimeout(r, 30));
        return secret.consumeString((v) => v);
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(SecretAccessError);
    expect(error.code).toBe("lease_expired");
  });

  it("surfaces failures with codes only, never values or provider error text", async () => {
    const leaking: SecretProvider = {
      name: "broken",
      plaintextSource: false,
      get: async () => {
        throw new Error(`connection failed: token=${SIGNING_KEY}`);
      },
    };
    const { m } = manager({ providers: [leaking] });
    const error = await m.withSecret("test.signing-key", { workflow: "signing" }, () => 1).catch((e) => e);
    expect(error.code).toBe("provider_error");
    expect(error.message).toBe('Secret "test.signing-key" unavailable for workflow "signing": provider_error');
    expect(error.message).not.toContain(SIGNING_KEY);

    const missing = manager({ env: {} }).m;
    await expect(missing.withSecret("test.signing-key", { workflow: "signing" }, () => 1)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("environment separation", () => {
  it("resolves the deployment environment from APP_ENV before NODE_ENV", () => {
    expect(resolveDeploymentEnvironment({ NODE_ENV: "production", APP_ENV: "staging" })).toBe("staging");
    expect(resolveDeploymentEnvironment({ NODE_ENV: "production" })).toBe("production");
    expect(resolveDeploymentEnvironment({ NODE_ENV: "test" })).toBe("local");
    expect(() => resolveDeploymentEnvironment({ APP_ENV: "prodd" })).toThrow(/Unknown APP_ENV/);
  });

  it("uses local defaults only locally", async () => {
    const catalog = [descriptor({ localDefault: "local-dev-value" })];
    const local = manager({ env: {}, environment: "local", catalog }).m;
    expect(await local.withSecret("test.signing-key", { workflow: "signing" }, (s) => s.consumeString((v) => v))).toBe("local-dev-value");

    const prod = manager({ env: {}, environment: "production", catalog }).m;
    await expect(prod.withSecret("test.signing-key", { workflow: "signing" }, () => 1)).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses test placeholders and short values in shared environments", async () => {
    const placeholder = manager({ env: { TEST_SIGNING_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" } }).m;
    await expect(placeholder.withSecret("test.signing-key", { workflow: "signing" }, () => 1)).rejects.toMatchObject({ code: "invalid_value" });

    const short = manager({ env: { TEST_SIGNING_KEY: "short" } }).m;
    await expect(short.withSecret("test.signing-key", { workflow: "signing" }, () => 1)).rejects.toMatchObject({ code: "invalid_value" });
  });

  it("refuses secrets provisioned for another environment and environment-restricted secrets", async () => {
    const staging = manager({ environment: "staging", provisionedFor: "production" }).m;
    await expect(staging.withSecret("test.signing-key", { workflow: "signing" }, () => 1)).rejects.toMatchObject({ code: "environment_mismatch" });

    const prodOnly = manager({ environment: "local", catalog: [descriptor({ environments: ["production"] })] }).m;
    await expect(prodOnly.withSecret("test.signing-key", { workflow: "signing" }, () => 1)).rejects.toMatchObject({ code: "environment_denied" });
  });

  it("skips plaintext providers in shared environments", async () => {
    const plaintext: SecretProvider = { name: "dotenv-file", plaintextSource: true, get: async () => ({ value: SIGNING_KEY, version: "p1" }) };
    const prod = manager({ environment: "production", providers: [plaintext] }).m;
    await expect(prod.withSecret("test.signing-key", { workflow: "signing" }, () => 1)).rejects.toMatchObject({ code: "not_found" });
    const local = manager({ environment: "local", providers: [plaintext] }).m;
    await expect(local.withSecret("test.signing-key", { workflow: "signing" }, () => "ok")).resolves.toBe("ok");
  });

  it("fails startup in shared environments when configuration is unsafe", async () => {
    const bad = manager({ env: { TEST_SIGNING_KEY: "short" } }).m;
    await expect(verifySecretConfiguration(bad)).rejects.toThrow("Unsafe secret configuration for production: test.signing-key (invalid_value)");

    const missing = manager({ env: {} }).m;
    await expect(missing.validateConfiguration()).resolves.toMatchObject({ missing: ["test.signing-key"], problems: [] });
    await expect(verifySecretConfiguration(missing)).resolves.toBeUndefined();
  });
});

describe("rotation and revocation workflow", () => {
  it("rotates to a new version, keeps the previous readable, then revokes it", async () => {
    const store = new VersionedSecretStore("vault");
    const { m, logEvent } = manager({ providers: [store] });
    const read = () => m.withSecret("test.signing-key", { workflow: "signing" }, (s, info) => ({ value: s.consumeString((v) => v), version: info.version }));

    const v1 = await m.rotate("test.signing-key", "a".repeat(40), "operator-1");
    expect((await read()).value).toBe("a".repeat(40));

    const v2 = await m.rotate("test.signing-key", "b".repeat(40), "operator-1");
    expect(v2.previousVersion).toBe(v1.version);
    expect(await read()).toEqual({ value: "b".repeat(40), version: v2.version });
    // Grace period: in-flight work can still verify with the previous version.
    expect(await store.getVersion(descriptor(), v1.version)).toBeDefined();

    await m.revoke("test.signing-key", v1.version, "operator-1");
    expect(await store.getVersion(descriptor(), v1.version)).toBeUndefined();
    expect(store.listVersions(descriptor()).map((v) => v.state)).toEqual(["revoked", "current"]);

    const actions = logEvent.mock.calls.map((c) => c[0].action);
    expect(actions).toEqual(expect.arrayContaining([PolicyAction.SECRET_ROTATED, PolicyAction.SECRET_REVOKED]));
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("b".repeat(40));
  });

  it("deny-lists a leaked env secret until it is replaced", async () => {
    const env = { TEST_SIGNING_KEY: SIGNING_KEY };
    const { m } = manager({ env });
    const version = await m.withSecret("test.signing-key", { workflow: "signing" }, (_s, info) => info.version);

    await m.revoke("test.signing-key", version, "incident-42");
    await expect(m.withSecret("test.signing-key", { workflow: "signing" }, () => 1)).rejects.toMatchObject({ code: "revoked" });
    expect(() => m.readEnvSecretSync("test.signing-key", { workflow: "signing" }, env)).toThrow(/revoked/);

    env.TEST_SIGNING_KEY = "n".repeat(40);
    await expect(m.withSecret("test.signing-key", { workflow: "signing" }, () => "ok")).resolves.toBe("ok");
  });

  it("rejects rotation without a rotatable provider or with an invalid value", async () => {
    const { m } = manager();
    await expect(m.rotate("test.signing-key", "x".repeat(40), "op")).rejects.toMatchObject({ code: "rotation_unsupported" });
    const store = manager({ providers: [new VersionedSecretStore()] }).m;
    await expect(store.rotate("test.signing-key", "short", "op")).rejects.toMatchObject({ code: "invalid_value" });
  });
});

describe("log redaction", () => {
  it("matches secret field names case-insensitively without catching public fields", () => {
    for (const key of ["privateKey", "PRIVATE_KEY", "sponsorSecret", "jwt_secret", "accessToken", "apiKey", "Authorization", "mnemonic"]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    for (const key of ["tokenType", "networkPassphrase", "transactionHash", "userId", "publicKey"]) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });

  it("scrubs secrets embedded in strings but keeps transaction hashes", () => {
    const hash = "a".repeat(64);
    const text = [
      `seed=${STELLAR_SEED}`,
      "auth Bearer abcdefghijklmnop",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLXZhbHVl",
      "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      "db postgres://admin:hunter2@db.internal:5432/app",
      `tx ${hash}`,
    ].join(" | ");
    const out = redactSecretsInString(text);

    expect(out).not.toContain(STELLAR_SEED);
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("sk-ant-api03");
    expect(out).toContain("Bearer [REDACTED]");
    expect(out).toContain(hash);
    expect(containsSecret(text)).toBe(true);
    expect(containsSecret(out)).toBe(false);
  });

  it("redacts nested fields, errors and circular structures in logger metadata", () => {
    const meta: Record<string, unknown> = {
      user: { SECRET_KEY: "x", nested: { message: `failed for ${STELLAR_SEED}` } },
      error: new Error(`decrypt failed: ${STELLAR_SEED}`),
      tokenType: "ERC20",
    };
    meta.self = meta;

    const serialized = JSON.stringify(redactSensitiveData(meta));
    expect(serialized).not.toContain(STELLAR_SEED);
    expect(serialized).toContain('"SECRET_KEY":"[REDACTED]"');
    expect(serialized).toContain('"tokenType":"ERC20"');
    expect(serialized).toContain('"self":"[Circular]"');
  });
});

describe("AccountSecretStore hardening", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  function writeTemp(content: string): string {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "accounts-")), "accounts.json");
    fs.writeFileSync(file, content);
    return file;
  }

  it("never echoes undecryptable or malformed payloads in errors", () => {
    process.env.ENCRYPTED_ACCOUNTS_JSON_B64 = STELLAR_SEED;
    delete process.env.ALLOW_PLAINTEXT_ACCOUNTS;
    const error = (() => {
      try {
        new AccountSecretStore().getAccounts();
      } catch (e) {
        return e as AccountSecretError;
      }
    })();
    expect(error).toBeInstanceOf(AccountSecretError);
    expect(error!.code).toBe("decrypt_failed");
    expect(error!.message).not.toContain(STELLAR_SEED);

    process.env.ENCRYPTED_ACCOUNTS_JSON_B64 = encrypt(`not json ${STELLAR_SEED}`);
    expect(() => new AccountSecretStore().getAccounts()).toThrow("Account secret payload is not valid JSON");
  });

  it("refuses plaintext accounts in shared environments", () => {
    delete process.env.ENCRYPTED_ACCOUNTS_JSON_B64;
    process.env.ALLOW_PLAINTEXT_ACCOUNTS = "true";
    process.env.ACCOUNTS_JSON_PATH = writeTemp(JSON.stringify([{ userId: "u1", secretKey: STELLAR_SEED }]));

    process.env.APP_ENV = "production";
    expect(() => new AccountSecretStore().getAccounts()).toThrow(/not permitted in staging or production/);

    process.env.APP_ENV = "local";
    expect(new AccountSecretStore().getAccountByUserId("u1", "swap").userId).toBe("u1");
  });

  it("drops decrypted data after the cache TTL", () => {
    let now = 0;
    process.env.ENCRYPTED_ACCOUNTS_JSON_B64 = encrypt(JSON.stringify([{ userId: "u1" }]));
    const store = new AccountSecretStore(1000, () => now);
    const first = store.getAccounts();
    expect(store.getAccounts()).toBe(first);
    now = 1001;
    expect(store.getAccounts()).not.toBe(first);
    expect(() => store.getAccountByUserId("missing")).toThrow(AccountSecretError);
  });
});
