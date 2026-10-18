import logger from "../../config/logger";
import { SecretAuditSink, SecretManager } from "./SecretManager";

export * from "./types";
export * from "./environment";
export * from "./catalog";
export * from "./providers";
export * from "./redaction";
export * from "./SecretManager";

const lazyAuditSink: SecretAuditSink = {
  async logEvent(params) {
    if (process.env.NODE_ENV === "test") return;
    const { auditLogService } = await import("../../AuditLog/auditLog.service");
    return auditLogService.logEvent(params);
  },
};

export const secretManager = new SecretManager({ audit: lazyAuditSink });

/**
 * Logs the secret configuration report at startup. In staging and production
 * any problem (placeholder value, environment mismatch, revoked version) is
 * fatal; missing optional secrets are reported but do not stop the process.
 */
export async function verifySecretConfiguration(manager: SecretManager = secretManager): Promise<void> {
  const report = await manager.validateConfiguration();
  logger.info("Secret configuration checked", {
    environment: report.environment,
    missing: report.missing,
    usingLocalDefault: report.usingLocalDefault,
    problems: report.problems,
  });
  if (report.environment !== "local" && report.problems.length > 0) {
    throw new Error(
      `Unsafe secret configuration for ${report.environment}: ${report.problems
        .map((p) => `${p.secretName} (${p.code})`)
        .join(", ")}`
    );
  }
}
