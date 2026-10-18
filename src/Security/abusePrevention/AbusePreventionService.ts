import {
  AbuseEvaluationResult,
  AbuseEvent,
  AbusePolicy,
  AbuseRequestContext,
  AbuseSubject,
  RateLimitPolicy,
} from "./types";

interface RateLimitBucket {
  timestamps: number[];
}

interface BlockState {
  until: number;
  level: number;
}

const ALLOW_RESULT: AbuseEvaluationResult = {
  allowed: true,
  decision: "allow",
};

/** Escalation level is forgotten after a subject stays clean for this long. */
const ESCALATION_MEMORY_MS = 24 * 60 * 60 * 1000;
const PRUNE_EVERY = 1000;

export const ESCALATION_POLICY_ID = "abuse-escalation";
export const ANOMALY_POLICY_ID = "abuse-anomaly";

export type AbuseEventListener = (event: AbuseEvent) => void;

export interface AbuseStats {
  decisions: Record<string, number>;
  byPolicy: Record<string, number>;
  bySurface: Record<string, number>;
  activeBlocks: Array<{ subjectKey: string; until: number; level: number }>;
}

/**
 * Stable identity used for escalation and anomaly tracking. Anonymous
 * traffic is never escalated, otherwise one abuser could block everyone
 * sharing the "anonymous" key.
 */
export function abuseSubjectKey(subject: AbuseSubject): string | null {
  if (subject.userId) return `user:${subject.userId}`;
  if (subject.ipAddress && subject.ipAddress !== "unknown") return `ip:${subject.ipAddress}`;
  if (subject.sessionId) return `session:${subject.sessionId}`;
  return null;
}

export class AbusePreventionService {
  private buckets = new Map<string, RateLimitBucket>();
  private violations = new Map<string, number[]>();
  private failures = new Map<string, number[]>();
  private blocks = new Map<string, BlockState>();
  private offenceLevels = new Map<string, { level: number; lastAt: number }>();
  private listeners = new Set<AbuseEventListener>();
  private stats = { decisions: {} as Record<string, number>, byPolicy: {} as Record<string, number>, bySurface: {} as Record<string, number> };
  private evaluations = 0;

  constructor(private policy: AbusePolicy = {}) {}

  /** Swap thresholds at runtime (e.g. after operators change overrides). */
  updatePolicy(policy: AbusePolicy): void {
    this.policy = policy;
  }

  getPolicy(): AbusePolicy {
    return this.policy;
  }

  onEvent(listener: AbuseEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async evaluate(
    context: AbuseRequestContext
  ): Promise<AbuseEvaluationResult> {
    const now = context.now ?? Date.now();
    if (++this.evaluations % PRUNE_EVERY === 0) this.prune(now);

    const subjectKey = abuseSubjectKey(context.subject);

    const block = subjectKey ? this.blocks.get(subjectKey) : undefined;
    if (block && block.until > now) {
      return this.finish(context, subjectKey, {
        allowed: false,
        decision: "deny",
        policyId: ESCALATION_POLICY_ID,
        reason: "Temporarily blocked after repeated abuse",
        retryAfterMs: block.until - now,
        resetAt: block.until,
      }, now, false);
    }

    for (const rule of this.policy.rules || []) {
      if (!this.matchesSurfaceAndAction(rule, context)) {
        continue;
      }

      if (await rule.match(context)) {
        // Rule denials (e.g. the IP blacklist) are authoritative on their own
        // and must stop as soon as the rule stops matching, so they do not
        // feed escalation.
        return this.finish(context, subjectKey, {
          allowed: false,
          decision: rule.decision,
          policyId: rule.id,
          reason: rule.reason,
        }, now, false);
      }
    }

    for (const rateLimit of this.policy.rateLimits || []) {
      if (rateLimit.disabled || !this.matchesSurfaceAndAction(rateLimit, context)) {
        continue;
      }

      const result = this.consumeRateLimit(rateLimit, context, now);
      if (!result.allowed) {
        return this.finish(context, subjectKey, result, now);
      }
    }

    const anomaly = this.policy.anomaly;
    if (anomaly && subjectKey) {
      const recent = this.recentTimestamps(this.failures, subjectKey, now, anomaly.windowMs);
      if (recent.length >= anomaly.challengeThreshold) {
        return this.finish(context, subjectKey, {
          allowed: false,
          decision: "challenge",
          policyId: ANOMALY_POLICY_ID,
          reason: "Too many recent failures; additional verification required",
          retryAfterMs: Math.max(0, recent[0] + anomaly.windowMs - now),
        }, now, false);
      }
    }

    return ALLOW_RESULT;
  }

  /**
   * Records a failed outcome (failed auth, rejected transaction, invalid
   * wallet lookup). Bursts of failures trigger challenges and, past the block
   * threshold, count as an escalation violation.
   */
  recordFailure(context: AbuseRequestContext, kind = "failure"): void {
    const anomaly = this.policy.anomaly;
    const subjectKey = abuseSubjectKey(context.subject);
    if (!anomaly || !subjectKey) return;

    const now = context.now ?? Date.now();
    const recent = this.recentTimestamps(this.failures, subjectKey, now, anomaly.windowMs);
    recent.push(now);
    this.failures.set(subjectKey, recent);

    if (recent.length === anomaly.challengeThreshold || recent.length >= anomaly.blockThreshold) {
      this.emit({
        type: "anomaly",
        surface: context.surface,
        action: context.action,
        subjectKey,
        policyId: ANOMALY_POLICY_ID,
        reason: `${recent.length} ${kind} events in ${anomaly.windowMs}ms`,
        at: now,
      });
    }

    if (recent.length >= anomaly.blockThreshold) {
      this.failures.delete(subjectKey);
      this.registerViolation(context, subjectKey, now, true);
    }
  }

  /** Lifts a block for incident response; returns false when none existed. */
  unblock(subjectKey: string): boolean {
    this.violations.delete(subjectKey);
    this.failures.delete(subjectKey);
    return this.blocks.delete(subjectKey);
  }

  getStats(now = Date.now()): AbuseStats {
    return {
      decisions: { ...this.stats.decisions },
      byPolicy: { ...this.stats.byPolicy },
      bySurface: { ...this.stats.bySurface },
      activeBlocks: [...this.blocks.entries()]
        .filter(([, b]) => b.until > now)
        .map(([subjectKey, b]) => ({ subjectKey, until: b.until, level: b.level })),
    };
  }

  reset(): void {
    this.buckets.clear();
    this.violations.clear();
    this.failures.clear();
    this.blocks.clear();
    this.offenceLevels.clear();
    this.stats = { decisions: {}, byPolicy: {}, bySurface: {} };
  }

  private finish(
    context: AbuseRequestContext,
    subjectKey: string | null,
    result: AbuseEvaluationResult,
    now: number,
    countsAsViolation = true
  ): AbuseEvaluationResult {
    const policyId = result.policyId ?? "unknown";
    this.stats.decisions[result.decision] = (this.stats.decisions[result.decision] ?? 0) + 1;
    this.stats.byPolicy[policyId] = (this.stats.byPolicy[policyId] ?? 0) + 1;
    this.stats.bySurface[context.surface] = (this.stats.bySurface[context.surface] ?? 0) + 1;

    this.emit({
      type: result.decision === "throttle" ? "throttled" : result.decision === "challenge" ? "challenged" : "denied",
      surface: context.surface,
      action: context.action,
      subjectKey: subjectKey ?? "anonymous",
      policyId: result.policyId,
      reason: result.reason,
      at: now,
    });

    if (countsAsViolation && subjectKey) {
      this.registerViolation(context, subjectKey, now, false);
    }
    return result;
  }

  private registerViolation(
    context: AbuseRequestContext,
    subjectKey: string,
    now: number,
    immediate: boolean
  ): void {
    const escalation = this.policy.escalation;
    if (!escalation) return;

    const recent = this.recentTimestamps(this.violations, subjectKey, now, escalation.windowMs);
    recent.push(now);

    if (!immediate && recent.length < escalation.violationThreshold) {
      this.violations.set(subjectKey, recent);
      return;
    }

    this.violations.delete(subjectKey);
    const previous = this.offenceLevels.get(subjectKey);
    const level = previous && now - previous.lastAt < ESCALATION_MEMORY_MS ? previous.level + 1 : 1;
    const blockMs = Math.min(escalation.baseBlockMs * 2 ** (level - 1), escalation.maxBlockMs);
    const until = now + blockMs;

    this.blocks.set(subjectKey, { until, level });
    this.offenceLevels.set(subjectKey, { level, lastAt: now });
    this.emit({
      type: "escalated",
      surface: context.surface,
      action: context.action,
      subjectKey,
      policyId: ESCALATION_POLICY_ID,
      reason: immediate ? "Repeated failures" : "Repeated limit violations",
      at: now,
      level,
      blockedUntil: until,
    });
  }

  private emit(event: AbuseEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Telemetry must never break request handling.
      }
    }
  }

  private recentTimestamps(map: Map<string, number[]>, key: string, now: number, windowMs: number): number[] {
    return (map.get(key) ?? []).filter((t) => t > now - windowMs);
  }

  private prune(now: number): void {
    const maxWindow = Math.max(
      ...(this.policy.rateLimits ?? []).map((r) => r.windowMs),
      this.policy.escalation?.windowMs ?? 0,
      this.policy.anomaly?.windowMs ?? 0,
      0
    );
    for (const [key, bucket] of this.buckets) {
      if (!bucket.timestamps.some((t) => t > now - maxWindow)) this.buckets.delete(key);
    }
    for (const map of [this.violations, this.failures]) {
      for (const [key, ts] of map) {
        if (!ts.some((t) => t > now - maxWindow)) map.delete(key);
      }
    }
    for (const [key, block] of this.blocks) {
      if (block.until <= now) this.blocks.delete(key);
    }
    for (const [key, offence] of this.offenceLevels) {
      if (now - offence.lastAt >= ESCALATION_MEMORY_MS) this.offenceLevels.delete(key);
    }
  }

  private consumeRateLimit(
    policy: RateLimitPolicy,
    context: AbuseRequestContext,
    now: number
  ): AbuseEvaluationResult {
    const key = this.getRateLimitKey(policy, context);
    const bucket = this.buckets.get(key) || { timestamps: [] };
    const windowStart = now - policy.windowMs;
    const timestamps = bucket.timestamps.filter((timestamp) => timestamp > windowStart);

    if (timestamps.length >= policy.maxRequests) {
      const resetAt = timestamps[0] + policy.windowMs;
      this.buckets.set(key, { timestamps });

      return {
        allowed: false,
        decision: "throttle",
        policyId: policy.id,
        reason: "Rate limit exceeded",
        retryAfterMs: Math.max(0, resetAt - now),
        resetAt,
      };
    }

    timestamps.push(now);
    this.buckets.set(key, { timestamps });
    return ALLOW_RESULT;
  }

  private matchesSurfaceAndAction(
    policy: { surfaces: string[]; actions?: string[] },
    context: AbuseRequestContext
  ): boolean {
    const actionMatches =
      !policy.actions || policy.actions.includes(context.action) || policy.actions.includes("*");

    return policy.surfaces.includes(context.surface) && actionMatches;
  }

  private getRateLimitKey(
    policy: RateLimitPolicy,
    context: AbuseRequestContext
  ): string {
    const identity = policy.keyBy
      .map((key) => context.subject[key])
      .filter(Boolean)
      .join(":");

    return [policy.id, context.surface, context.action, identity || "anonymous"].join(":");
  }
}
