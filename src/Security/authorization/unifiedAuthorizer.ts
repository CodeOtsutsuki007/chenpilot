import { randomUUID } from "crypto";
import { PolicyAction } from "../../AuditLog/auditEvent.types";
import {
  Approval,
  ApprovalDependencies,
  checkApproval,
} from "../../transactions/approvalDependencies";
import { authorize, authorizeJob, Channel, ChannelPolicy, JobAuthContext, Principal } from "./channelPolicy";
import { CATALOG_CHANNEL_POLICIES, getOperationPolicy, POLICY_VERSION } from "./operationCatalog";

/**
 * One authorizer for every entry point. Channel adapters (HTTP middleware,
 * socket guard, bot guard, job worker) translate their transport into an
 * AuthorizationRequest and call `authorizeOperation`; none of them make
 * policy decisions themselves.
 */

export type AuthorizationReason =
  | "allowed"
  | "suspended"
  | "not_granted"
  | "channel_restricted"
  | "missing_origin"
  | "unknown_operation"
  | "channel_mismatch"
  | "approval_invalidated";

export interface ApprovalEvidence {
  approval: Approval;
  payload: unknown;
  /** Dependencies re-read from the source of truth at decision time. */
  current: ApprovalDependencies;
}

export interface AuthorizationRequest {
  operation: string;
  /** Channel the request actually arrived on, derived from its credential/transport. */
  channel: Channel;
  /** Channel the caller claims to be (e.g. an x-client-channel header). */
  claimedChannel?: Channel;
  /** Required for all channels except "job". */
  principal?: Principal;
  /** Required for "job": identity and policy captured at enqueue time. */
  job?: JobAuthContext & { policyVersion?: string };
  approval?: ApprovalEvidence;
  /** Free-form context copied to the audit record (route, event name, command). */
  resource?: string;
}

export interface AuthorizationRecord {
  decisionId: string;
  allowed: boolean;
  reason: AuthorizationReason;
  operation: string;
  channel: Channel;
  claimedChannel?: Channel;
  principalId?: string;
  policyVersion: string;
  evaluatedAt: string;
  resource?: string;
  /** Present for jobs enqueued under an older policy version. */
  enqueuedPolicyVersion?: string;
  /** Human-readable detail (e.g. which approval dependency changed). */
  detail?: string;
}

export interface AuthorizationAuditSink {
  logEvent(params: {
    action: PolicyAction;
    actor?: { userId?: string };
    resource?: { type?: string; id?: string; endpoint?: string };
    metadata?: Record<string, unknown>;
    success?: boolean;
  }): Promise<unknown>;
}

export interface AuthorizerOptions {
  policies?: Record<Channel, ChannelPolicy>;
  policyVersion?: string;
  audit?: AuthorizationAuditSink;
  /** Also audit allowed decisions (denials are always audited). */
  auditAllowed?: boolean;
  now?: () => Date;
}

/**
 * True when evaluating under `claimed` can never grant more than `actual`:
 * every operation `actual` refuses must also be refused by `claimed`.
 */
export function isNarrowingClaim(
  claimed: Channel,
  actual: Channel,
  policies: Record<Channel, ChannelPolicy> = CATALOG_CHANNEL_POLICIES
): boolean {
  if (claimed === actual) return true;
  if (claimed === "job" || actual === "job") return false;
  const claimedDenied = new Set(policies[claimed].denied);
  return policies[actual].denied.every((op) => claimedDenied.has(op));
}

export class UnifiedAuthorizer {
  private readonly policies: Record<Channel, ChannelPolicy>;
  private readonly policyVersion: string;

  constructor(private readonly options: AuthorizerOptions = {}) {
    this.policies = options.policies ?? CATALOG_CHANNEL_POLICIES;
    this.policyVersion = options.policyVersion ?? POLICY_VERSION;
  }

  getPolicyVersion(): string {
    return this.policyVersion;
  }

  /** Pure decision; no audit side effects. */
  evaluate(request: AuthorizationRequest): AuthorizationRecord {
    const record = (reason: AuthorizationReason, detail?: string): AuthorizationRecord => ({
      decisionId: randomUUID(),
      allowed: reason === "allowed",
      reason,
      operation: request.operation,
      channel: request.channel,
      claimedChannel: request.claimedChannel,
      principalId: request.principal?.id ?? request.job?.originPrincipal?.id,
      policyVersion: this.policyVersion,
      evaluatedAt: (this.options.now?.() ?? new Date()).toISOString(),
      resource: request.resource,
      enqueuedPolicyVersion:
        request.job?.policyVersion && request.job.policyVersion !== this.policyVersion
          ? request.job.policyVersion
          : undefined,
      detail,
    });

    const opPolicy = getOperationPolicy(request.operation);
    if (!opPolicy) return record("unknown_operation", "Operation is not in the policy catalog");

    if (request.claimedChannel && !isNarrowingClaim(request.claimedChannel, request.channel, this.policies)) {
      return record(
        "channel_mismatch",
        `Request arrived on ${request.channel} but claimed ${request.claimedChannel}`
      );
    }

    let decision;
    if (request.channel === "job") {
      // Jobs always re-evaluate against the *current* policy as their origin principal.
      decision = authorizeJob(request.job, request.operation, this.policies);
    } else if (!request.principal) {
      return record("missing_origin", "No authenticated principal");
    } else {
      decision = authorize(request.principal, request.operation, request.channel, this.policies);
      if (decision.allowed && request.claimedChannel && request.claimedChannel !== request.channel) {
        decision = authorize(request.principal, request.operation, request.claimedChannel, this.policies);
      }
    }
    if (!decision.allowed) return record(decision.reason);

    if (opPolicy.requiresApproval && request.approval) {
      const check = checkApproval(request.approval.approval, request.approval.payload, request.approval.current);
      if (!check.valid) return record("approval_invalidated", check.reasons.join(" "));
    }

    return record("allowed");
  }

  /** Decision plus audit trail. Denials are always audited. */
  async authorize(request: AuthorizationRequest): Promise<AuthorizationRecord> {
    const result = this.evaluate(request);
    if (this.options.audit && (!result.allowed || this.options.auditAllowed)) {
      try {
        await this.options.audit.logEvent({
          action: result.reason === "channel_mismatch" ? PolicyAction.CHANNEL_MISMATCH : PolicyAction.AUTHORIZATION_DECISION,
          actor: { userId: result.principalId },
          resource: { type: "operation", id: result.operation, endpoint: result.resource },
          success: result.allowed,
          metadata: { ...result },
        });
      } catch {
        // Audit failures must not change the decision.
      }
    }
    return result;
  }
}
