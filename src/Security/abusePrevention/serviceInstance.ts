import logger from "../../config/logger";
import { AbusePreventionService } from "./AbusePreventionService";
import { defaultAbusePolicy } from "./defaultPolicy";
import { ExecutionGate } from "./executionGate";
import { resolveAbusePolicy } from "./policyOverrides";
import { AbuseTelemetry } from "./telemetry";

const resolved = resolveAbusePolicy(defaultAbusePolicy);
for (const warning of resolved.warnings) {
  logger.warn("Ignoring invalid abuse policy override", { warning });
}

export const defaultAbusePreventionService = new AbusePreventionService(
  resolved.policy
);

export const abuseTelemetry = new AbuseTelemetry(500, async () =>
  process.env.NODE_ENV === "test"
    ? undefined
    : (await import("../../AuditLog/auditLog.service")).auditLogService
);
abuseTelemetry.attach(defaultAbusePreventionService);

/** Re-reads ABUSE_POLICY_FILE / ABUSE_POLICY_OVERRIDES without a restart. */
export function reloadAbusePolicy(env: NodeJS.ProcessEnv = process.env): string[] {
  const next = resolveAbusePolicy(defaultAbusePolicy, env);
  defaultAbusePreventionService.updatePolicy(next.policy);
  logger.info("Abuse policy reloaded", { warnings: next.warnings.length });
  return next.warnings;
}

function envInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Shared gate for outbound chain/provider calls made on a user's behalf. */
export const providerExecutionGate = new ExecutionGate({
  name: "chain-provider",
  maxConcurrent: envInt("PROVIDER_GATE_MAX_CONCURRENT", 20),
  maxQueued: envInt("PROVIDER_GATE_MAX_QUEUED", 100),
  queueTimeoutMs: envInt("PROVIDER_GATE_QUEUE_TIMEOUT_MS", 10_000),
  abuse: defaultAbusePreventionService,
  // Provider 4xx responses are caller errors, not provider outages.
  isFailure: (error) => {
    const status =
      (error as { statusCode?: unknown; status?: unknown } | undefined)?.statusCode ??
      (error as { status?: unknown } | undefined)?.status;
    return !(typeof status === "number" && status >= 400 && status < 500);
  },
});
