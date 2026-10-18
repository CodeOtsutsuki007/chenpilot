import { DeploymentEnvironment } from "./environment";

export type SecretKind = "wallet" | "provider" | "service" | "token";

/**
 * Declares a secret and the minimum scope it may be used in. Code can only
 * read secrets that are declared here, from the workflows listed here.
 */
export interface SecretDescriptor {
  name: string;
  description: string;
  kind: SecretKind;
  /** Environment variable the default provider reads. */
  envVar?: string;
  /** Workflows allowed to read the secret. */
  workflows: readonly string[];
  /** Environments the secret may be used in. */
  environments: readonly DeploymentEnvironment[];
  /** Upper bound on how long plaintext may stay live per access. */
  maxLeaseMs: number;
  /** Development-only fallback. Refused in staging and production. */
  localDefault?: string;
  /** Minimum length check to catch truncated or placeholder values. */
  minLength?: number;
}

export interface SecretScope {
  workflow: string;
  /** Who/what is asking, for the access trail (user id, job id, service). */
  actor?: string;
}

export interface SecretValue {
  value: string;
  /** Stable, non-reversible identifier of this value (never the value itself). */
  version: string;
}

export interface SecretProvider {
  readonly name: string;
  /** True for providers that read plaintext from the local machine (env files, JSON). */
  readonly plaintextSource: boolean;
  get(descriptor: SecretDescriptor): Promise<SecretValue | undefined>;
}

export interface RotatableSecretProvider extends SecretProvider {
  rotate(descriptor: SecretDescriptor, newValue: string): Promise<{ version: string; previousVersion?: string }>;
  revoke(descriptor: SecretDescriptor, version: string): Promise<boolean>;
  isRevoked(descriptor: SecretDescriptor, version: string): Promise<boolean>;
}

export type SecretAccessErrorCode =
  | "unknown_secret"
  | "scope_denied"
  | "environment_denied"
  | "environment_mismatch"
  | "not_found"
  | "invalid_value"
  | "revoked"
  | "provider_error"
  | "lease_expired"
  | "rotation_unsupported";

export type SecretAccessOutcome = "granted" | SecretAccessErrorCode;

export interface SecretAccessRecord {
  secretName: string;
  workflow: string;
  actor?: string;
  environment: DeploymentEnvironment;
  outcome: SecretAccessOutcome;
  provider?: string;
  version?: string;
  usedLocalDefault?: boolean;
  durationMs?: number;
  at: string;
}
