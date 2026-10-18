import { createHash } from "crypto";
import { RotatableSecretProvider, SecretDescriptor, SecretProvider, SecretValue } from "./types";

/** Short, non-reversible identifier for a secret value, safe to log. */
export function fingerprint(value: string): string {
  return createHash("sha256").update(`chenpilot-secret-fp:${value}`).digest("hex").slice(0, 12);
}

/** Reads the descriptor's environment variable. Standard for container platforms. */
export class EnvSecretProvider implements SecretProvider {
  readonly name = "env";
  readonly plaintextSource = false;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async get(descriptor: SecretDescriptor): Promise<SecretValue | undefined> {
    const value = descriptor.envVar ? this.env[descriptor.envVar]?.trim() : undefined;
    return value ? { value, version: `env:${fingerprint(value)}` } : undefined;
  }
}

interface StoredVersion {
  version: string;
  value: string;
  state: "current" | "previous" | "revoked";
  createdAt: number;
}

/**
 * Versioned store with rotation and revocation. Reference implementation of
 * RotatableSecretProvider; managed stores (Vault, AWS/GCP secret managers)
 * implement the same interface. Keeps the previous version readable via
 * `getVersion` so in-flight work can finish during a rotation.
 */
export class VersionedSecretStore implements RotatableSecretProvider {
  readonly name: string;
  readonly plaintextSource = false;
  private versions = new Map<string, StoredVersion[]>();

  constructor(name = "versioned-store", private readonly now: () => number = Date.now) {
    this.name = name;
  }

  async get(descriptor: SecretDescriptor): Promise<SecretValue | undefined> {
    const current = this.versions.get(descriptor.name)?.find((v) => v.state === "current");
    return current ? { value: current.value, version: current.version } : undefined;
  }

  async getVersion(descriptor: SecretDescriptor, version: string): Promise<SecretValue | undefined> {
    const match = this.versions.get(descriptor.name)?.find((v) => v.version === version && v.state !== "revoked");
    return match ? { value: match.value, version: match.version } : undefined;
  }

  async rotate(descriptor: SecretDescriptor, newValue: string): Promise<{ version: string; previousVersion?: string }> {
    const list = this.versions.get(descriptor.name) ?? [];
    const version = `${this.name}:${fingerprint(newValue)}:${list.length + 1}`;
    let previousVersion: string | undefined;
    for (const v of list) {
      if (v.state === "current") {
        v.state = "previous";
        previousVersion = v.version;
      }
    }
    list.push({ version, value: newValue, state: "current", createdAt: this.now() });
    this.versions.set(descriptor.name, list);
    return { version, previousVersion };
  }

  async revoke(descriptor: SecretDescriptor, version: string): Promise<boolean> {
    const match = this.versions.get(descriptor.name)?.find((v) => v.version === version);
    if (!match || match.state === "revoked") return false;
    match.state = "revoked";
    match.value = "";
    return true;
  }

  async isRevoked(descriptor: SecretDescriptor, version: string): Promise<boolean> {
    return this.versions.get(descriptor.name)?.find((v) => v.version === version)?.state === "revoked";
  }

  /** Version metadata only — never values. */
  listVersions(descriptor: SecretDescriptor): Array<{ version: string; state: StoredVersion["state"]; createdAt: number }> {
    return (this.versions.get(descriptor.name) ?? []).map(({ version, state, createdAt }) => ({ version, state, createdAt }));
  }
}
