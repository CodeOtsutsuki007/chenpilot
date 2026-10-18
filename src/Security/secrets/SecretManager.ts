import logger from "../../config/logger";
import { PolicyAction } from "../../AuditLog/auditEvent.types";
import { SecretBuffer } from "../../utils/secretBuffer";
import { KNOWN_PLACEHOLDER_VALUES, SECRET_CATALOG } from "./catalog";
import { DeploymentEnvironment, isSharedEnvironment, resolveDeploymentEnvironment } from "./environment";
import { EnvSecretProvider, fingerprint } from "./providers";
import {
  RotatableSecretProvider,
  SecretAccessErrorCode,
  SecretAccessOutcome,
  SecretAccessRecord,
  SecretDescriptor,
  SecretProvider,
  SecretScope,
  SecretValue,
} from "./types";

/**
 * Scoped, audited, time-boxed access to secrets.
 *
 *  - Only secrets declared in the catalog can be read, and only from the
 *    workflows the catalog lists (least privilege).
 *  - Plaintext is handed out as a SecretBuffer that is zeroized when the
 *    callback returns or the lease expires, whichever comes first.
 *  - Every access, grant or denial, is recorded without the value.
 *  - Local defaults, plaintext sources and known test placeholders are
 *    refused in staging and production.
 */

export class SecretAccessError extends Error {
  constructor(
    public readonly code: SecretAccessErrorCode,
    public readonly secretName: string,
    public readonly workflow?: string
  ) {
    // Never include values or provider error text — only the code and names.
    super(`Secret "${secretName}" unavailable${workflow ? ` for workflow "${workflow}"` : ""}: ${code}`);
    this.name = "SecretAccessError";
  }
}

export interface SecretAuditSink {
  logEvent(params: {
    action: PolicyAction;
    actor?: { serviceId?: string; userId?: string };
    resource?: { type?: string; id?: string };
    metadata?: Record<string, unknown>;
    success?: boolean;
  }): Promise<unknown>;
}

export interface SecretManagerOptions {
  catalog?: readonly SecretDescriptor[];
  providers?: SecretProvider[];
  environment?: DeploymentEnvironment;
  /** Environment the deployed secret bundle was provisioned for (SECRETS_PROVISIONED_FOR). */
  provisionedFor?: string;
  audit?: SecretAuditSink;
}

export interface SecretConfigurationReport {
  environment: DeploymentEnvironment;
  missing: string[];
  usingLocalDefault: string[];
  problems: Array<{ secretName: string; code: SecretAccessErrorCode }>;
}

export class SecretManager {
  readonly environment: DeploymentEnvironment;
  private readonly catalog: Map<string, SecretDescriptor>;
  private readonly providers: SecretProvider[];
  private readonly revoked = new Map<string, Set<string>>();

  constructor(private readonly options: SecretManagerOptions = {}) {
    this.environment = options.environment ?? resolveDeploymentEnvironment();
    this.catalog = new Map((options.catalog ?? SECRET_CATALOG).map((d) => [d.name, d]));
    this.providers = options.providers ?? [new EnvSecretProvider()];
  }

  /** Catalog metadata for operators. Never includes values. */
  describe(): Array<Omit<SecretDescriptor, "localDefault"> & { hasLocalDefault: boolean }> {
    return [...this.catalog.values()].map(({ localDefault, ...rest }) => ({ ...rest, hasLocalDefault: !!localDefault }));
  }

  /**
   * Runs `fn` with the secret's plaintext in a SecretBuffer. The buffer is
   * destroyed when `fn` settles or after the descriptor's maxLeaseMs.
   */
  async withSecret<T>(
    name: string,
    scope: SecretScope,
    fn: (secret: SecretBuffer, info: { version: string }) => T | Promise<T>
  ): Promise<T> {
    const started = Date.now();
    const descriptor = this.catalog.get(name);
    if (!descriptor) throw await this.deny(name, scope, "unknown_secret");

    const resolved = await this.resolve(descriptor, scope);
    const secret = SecretBuffer.fromString(resolved.value.value, `secret:${name}`);
    let leaseExpired = false;
    const timer = setTimeout(() => {
      leaseExpired = true;
      secret.destroy();
    }, descriptor.maxLeaseMs);

    try {
      const result = await fn(secret, { version: resolved.value.version });
      if (leaseExpired) throw new SecretAccessError("lease_expired", name, scope.workflow);
      await this.record(descriptor.name, scope, "granted", {
        provider: resolved.provider,
        version: resolved.value.version,
        usedLocalDefault: resolved.usedLocalDefault,
        durationMs: Date.now() - started,
      });
      return result;
    } catch (error) {
      if (leaseExpired) {
        await this.record(descriptor.name, scope, "lease_expired", { provider: resolved.provider, version: resolved.value.version });
        throw error instanceof SecretAccessError ? error : new SecretAccessError("lease_expired", name, scope.workflow);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      secret.destroy();
    }
  }

  /**
   * Synchronous read for keys that must be available at construction time
   * (HMAC signing keys). Reads only the descriptor's environment variable,
   * applies the same scope, environment and placeholder checks, and records
   * the access. Prefer `withSecret` everywhere else.
   */
  readEnvSecretSync(name: string, scope: SecretScope, env: NodeJS.ProcessEnv = process.env): string {
    const descriptor = this.requireDescriptor(name);
    const deny = (code: SecretAccessErrorCode): never => {
      void this.record(name, scope, code);
      throw new SecretAccessError(code, name, scope.workflow);
    };

    if (!descriptor.workflows.includes(scope.workflow)) deny("scope_denied");
    if (!descriptor.environments.includes(this.environment)) deny("environment_denied");
    const provisionedFor = this.options.provisionedFor ?? env.SECRETS_PROVISIONED_FOR;
    if (provisionedFor && provisionedFor.trim().toLowerCase() !== this.environment) deny("environment_mismatch");

    const value = descriptor.envVar ? env[descriptor.envVar]?.trim() : undefined;
    if (value) {
      if (this.revoked.get(name)?.has(`env:${fingerprint(value)}`)) deny("revoked");
      try {
        this.validateValue(descriptor, value);
      } catch {
        deny("invalid_value");
      }
      void this.record(name, scope, "granted", { provider: "env", version: `env:${fingerprint(value)}` });
      return value;
    }

    if (!isSharedEnvironment(this.environment) && descriptor.localDefault) {
      logger.warn("Using local development default for secret", { secretName: name });
      void this.record(name, scope, "granted", { provider: "local-default", usedLocalDefault: true });
      return descriptor.localDefault;
    }
    return deny("not_found");
  }

  /**
   * Installs a new value as the current version. Requires a rotatable
   * provider (managed store). The previous version stays readable through
   * the provider until it is revoked.
   */
  async rotate(name: string, newValue: string, actor: string): Promise<{ version: string; previousVersion?: string }> {
    const descriptor = this.requireDescriptor(name);
    this.validateValue(descriptor, newValue);
    const provider = this.providers.find((p): p is RotatableSecretProvider => "rotate" in p);
    if (!provider) throw new SecretAccessError("rotation_unsupported", name);

    const result = await provider.rotate(descriptor, newValue);
    await this.audit(PolicyAction.SECRET_ROTATED, true, actor, {
      secretName: name,
      provider: provider.name,
      version: result.version,
      previousVersion: result.previousVersion,
    });
    logger.warn("Secret rotated", { secretName: name, version: result.version, previousVersion: result.previousVersion, actor });
    return result;
  }

  /**
   * Revokes a version (e.g. after a leak). Works with any provider: the
   * version is deny-listed here and, for managed stores, revoked at source.
   */
  async revoke(name: string, version: string, actor: string): Promise<void> {
    const descriptor = this.requireDescriptor(name);
    const set = this.revoked.get(name) ?? new Set<string>();
    set.add(version);
    this.revoked.set(name, set);
    for (const provider of this.providers) {
      if ("revoke" in provider) await (provider as RotatableSecretProvider).revoke(descriptor, version);
    }
    await this.audit(PolicyAction.SECRET_REVOKED, true, actor, { secretName: name, version });
    logger.warn("Secret version revoked", { secretName: name, version, actor });
  }

  /** Startup check: reports missing or unsafe secrets without reading them into logs. */
  async validateConfiguration(): Promise<SecretConfigurationReport> {
    const report: SecretConfigurationReport = { environment: this.environment, missing: [], usingLocalDefault: [], problems: [] };
    for (const descriptor of this.catalog.values()) {
      if (!descriptor.environments.includes(this.environment)) continue;
      try {
        const resolved = await this.resolve(descriptor, { workflow: descriptor.workflows[0], actor: "startup-check" }, false);
        if (resolved.usedLocalDefault) report.usingLocalDefault.push(descriptor.name);
      } catch (error) {
        if (error instanceof SecretAccessError) {
          if (error.code === "not_found") report.missing.push(descriptor.name);
          else report.problems.push({ secretName: descriptor.name, code: error.code });
        } else {
          report.problems.push({ secretName: descriptor.name, code: "provider_error" });
        }
      }
    }
    return report;
  }

  private requireDescriptor(name: string): SecretDescriptor {
    const descriptor = this.catalog.get(name);
    if (!descriptor) throw new SecretAccessError("unknown_secret", name);
    return descriptor;
  }

  private validateValue(descriptor: SecretDescriptor, value: string): void {
    if (descriptor.minLength && value.length < descriptor.minLength) {
      throw new SecretAccessError("invalid_value", descriptor.name);
    }
    if (isSharedEnvironment(this.environment) && KNOWN_PLACEHOLDER_VALUES.has(value)) {
      throw new SecretAccessError("invalid_value", descriptor.name);
    }
  }

  private async resolve(
    descriptor: SecretDescriptor,
    scope: SecretScope,
    recordDenials = true
  ): Promise<{ value: SecretValue; provider: string; usedLocalDefault: boolean }> {
    const fail = async (code: SecretAccessErrorCode, provider?: string) =>
      recordDenials ? this.deny(descriptor.name, scope, code, provider) : new SecretAccessError(code, descriptor.name, scope.workflow);

    if (!descriptor.workflows.includes(scope.workflow)) throw await fail("scope_denied");
    if (!descriptor.environments.includes(this.environment)) throw await fail("environment_denied");

    const provisionedFor = this.options.provisionedFor ?? process.env.SECRETS_PROVISIONED_FOR;
    if (provisionedFor && provisionedFor.trim().toLowerCase() !== this.environment) {
      throw await fail("environment_mismatch");
    }

    const shared = isSharedEnvironment(this.environment);
    for (const provider of this.providers) {
      if (shared && provider.plaintextSource) continue;
      let value: SecretValue | undefined;
      try {
        value = await provider.get(descriptor);
      } catch {
        throw await fail("provider_error", provider.name);
      }
      if (!value) continue;
      if (this.revoked.get(descriptor.name)?.has(value.version)) throw await fail("revoked", provider.name);
      try {
        this.validateValue(descriptor, value.value);
      } catch {
        throw await fail("invalid_value", provider.name);
      }
      return { value, provider: provider.name, usedLocalDefault: false };
    }

    if (!shared && descriptor.localDefault) {
      return {
        value: { value: descriptor.localDefault, version: `local-default:${fingerprint(descriptor.localDefault)}` },
        provider: "local-default",
        usedLocalDefault: true,
      };
    }

    throw await fail("not_found");
  }

  private async deny(
    name: string,
    scope: SecretScope,
    code: SecretAccessErrorCode,
    provider?: string
  ): Promise<SecretAccessError> {
    await this.record(name, scope, code, { provider });
    return new SecretAccessError(code, name, scope.workflow);
  }

  private async record(
    secret: string,
    scope: SecretScope,
    outcome: SecretAccessOutcome,
    extra: Partial<SecretAccessRecord> = {}
  ): Promise<void> {
    const record: SecretAccessRecord = {
      secretName: secret,
      workflow: scope.workflow,
      actor: scope.actor,
      environment: this.environment,
      outcome,
      at: new Date().toISOString(),
      ...extra,
    };
    const granted = outcome === "granted";
    if (granted) logger.info("Secret accessed", { ...record });
    else logger.warn("Secret access denied", { ...record });
    await this.audit(granted ? PolicyAction.SECRET_ACCESSED : PolicyAction.SECRET_ACCESS_DENIED, granted, scope.actor, { ...record });
  }

  private async audit(action: PolicyAction, success: boolean, actor: string | undefined, metadata: Record<string, unknown>): Promise<void> {
    if (!this.options.audit) return;
    try {
      await this.options.audit.logEvent({
        action,
        success,
        actor: { serviceId: actor },
        resource: { type: "secret", id: String(metadata.secretName) },
        metadata,
      });
    } catch {
      // An audit outage must not take secret-dependent features down with it.
    }
  }
}
