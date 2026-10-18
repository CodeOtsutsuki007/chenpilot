export type AbuseSurface = "api" | "bot" | "realtime" | "job" | "provider";

export type AbuseDecision = "allow" | "deny" | "throttle" | "challenge";

export interface AbuseSubject {
  ipAddress?: string;
  userId?: string;
  sessionId?: string;
}

export interface AbuseRequestContext {
  surface: AbuseSurface;
  action: string;
  subject: AbuseSubject;
  metadata?: Record<string, unknown>;
  now?: number;
}

export interface AbusePolicyRule {
  id: string;
  description?: string;
  surfaces: AbuseSurface[];
  actions?: string[];
  decision: Exclude<AbuseDecision, "allow">;
  reason: string;
  match: (context: AbuseRequestContext) => boolean | Promise<boolean>;
}

export interface RateLimitPolicy {
  id: string;
  surfaces: AbuseSurface[];
  actions?: string[];
  maxRequests: number;
  windowMs: number;
  keyBy: Array<keyof AbuseSubject>;
  /** Disabled limits are skipped; lets operators switch a limit off without a deploy. */
  disabled?: boolean;
}

/**
 * Escalating response for subjects that keep tripping limits: after
 * `violationThreshold` violations inside `windowMs` the subject is blocked
 * for `baseBlockMs`, doubling on each repeat offence up to `maxBlockMs`.
 */
export interface EscalationPolicy {
  violationThreshold: number;
  windowMs: number;
  baseBlockMs: number;
  maxBlockMs: number;
}

/**
 * Anomaly detection for repeated failures (failed auth, rejected transactions,
 * wallet probing). `challengeThreshold` failures inside `windowMs` yield a
 * challenge; `blockThreshold` failures count as an escalation violation.
 */
export interface AnomalyPolicy {
  windowMs: number;
  challengeThreshold: number;
  blockThreshold: number;
}

export interface AbusePolicy {
  rules?: AbusePolicyRule[];
  rateLimits?: RateLimitPolicy[];
  escalation?: EscalationPolicy;
  anomaly?: AnomalyPolicy;
}

export interface AbuseEvaluationResult {
  allowed: boolean;
  decision: AbuseDecision;
  policyId?: string;
  reason?: string;
  retryAfterMs?: number;
  resetAt?: number;
}

/** Emitted for every non-allow decision and escalation, for telemetry and incident response. */
export interface AbuseEvent {
  type: "throttled" | "denied" | "challenged" | "escalated" | "anomaly";
  surface: AbuseSurface;
  action: string;
  subjectKey: string;
  policyId?: string;
  reason?: string;
  at: number;
  /** Escalation level (1 = first block). Present on "escalated" events. */
  level?: number;
  blockedUntil?: number;
}
