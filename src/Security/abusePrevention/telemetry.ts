import logger from "../../config/logger";
import { PolicyAction } from "../../AuditLog/auditEvent.types";
import { AbusePreventionService } from "./AbusePreventionService";
import { AbuseEvent } from "./types";

/**
 * Makes throttled, blocked and escalated requests visible to operators:
 *  - structured log line per event (escalations and anomalies at warn)
 *  - audit-log entry for escalations and anomalies (incident response)
 *  - bounded in-memory buffer of recent events for the admin endpoint
 */

export interface AbuseAuditSink {
  logEvent(params: {
    action: PolicyAction;
    actor?: { userId?: string; ipAddress?: string };
    metadata?: Record<string, unknown>;
    success?: boolean;
  }): Promise<unknown>;
}

export class AbuseTelemetry {
  private recent: AbuseEvent[] = [];

  constructor(
    private readonly maxRecent = 500,
    private readonly auditSink?: () => Promise<AbuseAuditSink | undefined>
  ) {}

  attach(service: AbusePreventionService): () => void {
    return service.onEvent((event) => this.record(event));
  }

  record(event: AbuseEvent): void {
    this.recent.push(event);
    if (this.recent.length > this.maxRecent) this.recent.shift();

    const fields = {
      abuseEvent: event.type,
      surface: event.surface,
      action: event.action,
      subjectKey: event.subjectKey,
      policyId: event.policyId,
      reason: event.reason,
      level: event.level,
      blockedUntil: event.blockedUntil ? new Date(event.blockedUntil).toISOString() : undefined,
    };

    if (event.type === "escalated" || event.type === "anomaly") {
      logger.warn("Abuse safeguard triggered", fields);
      void this.audit(event);
    } else {
      logger.info("Request limited by abuse policy", fields);
    }
  }

  getRecent(limit = 100): AbuseEvent[] {
    return this.recent.slice(-limit).reverse();
  }

  clear(): void {
    this.recent = [];
  }

  private async audit(event: AbuseEvent): Promise<void> {
    try {
      const sink = await this.auditSink?.();
      if (!sink) return;
      const [kind, id] = event.subjectKey.split(":", 2);
      await sink.logEvent({
        action: event.type === "escalated" ? PolicyAction.ABUSE_ESCALATED : PolicyAction.SUSPICIOUS_ACTIVITY,
        actor: { userId: kind === "user" ? id : undefined, ipAddress: kind === "ip" ? id : undefined },
        success: false,
        metadata: { ...event },
      });
    } catch (error) {
      logger.warn("Failed to write abuse audit event", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
