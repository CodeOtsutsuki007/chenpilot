import { NextFunction, Request, Response } from "express";
import logger from "../../config/logger";
import { Channel, Principal } from "./channelPolicy";
import { normalizeRole, POLICY_VERSION, principalForRole } from "./operationCatalog";
import {
  ApprovalEvidence,
  AuthorizationAuditSink,
  AuthorizationRecord,
  UnifiedAuthorizer,
} from "./unifiedAuthorizer";

/**
 * Transport adapters. Each one only works out *who* is calling and *which
 * channel* the call really arrived on, then defers to the shared authorizer.
 */

const lazyAuditSink: AuthorizationAuditSink = {
  async logEvent(params) {
    if (process.env.NODE_ENV === "test") return;
    const { auditLogService } = await import("../../AuditLog/auditLog.service");
    return auditLogService.logEvent(params);
  },
};

export const unifiedAuthorizer = new UnifiedAuthorizer({ audit: lazyAuditSink });

export interface AuthenticatedActor {
  userId: string;
  role?: string;
  suspended?: boolean;
}

function toPrincipal(actor: AuthenticatedActor): Principal {
  return principalForRole(actor.userId, actor.role, actor.suspended);
}

const CHANNEL_ALIASES: Record<string, Channel> = {
  http: "http",
  api: "http",
  ui: "http",
  web: "http",
  bot: "bot",
  telegram: "bot",
  discord: "bot",
  websocket: "websocket",
  ws: "websocket",
  job: "job",
};

/** Maps a client-supplied channel label to a channel; unknown labels count as a claim of "job" (always a mismatch). */
export function parseClaimedChannel(value: unknown): Channel | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return CHANNEL_ALIASES[String(value).toLowerCase()] ?? "job";
}

/** Set by authenticateBotIdentity when the caller authenticated as a linked bot user. */
export function hasBotIdentity(req: Request): boolean {
  return Boolean((req as Request & { botIdentity?: unknown }).botIdentity);
}

declare module "express-serve-static-core" {
  interface Request {
    authorization?: AuthorizationRecord;
  }
}

/**
 * Express guard. Must run after authentication. Requests authenticated via a
 * linked bot identity are on the "bot" channel regardless of what they claim.
 */
export function requireOperation(operation: string, authorizer: UnifiedAuthorizer = unifiedAuthorizer) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user as { userId?: string; role?: string } | undefined;
    const channel: Channel = hasBotIdentity(req) ? "bot" : "http";

    const result = await authorizer.authorize({
      operation,
      channel,
      claimedChannel: parseClaimedChannel(req.headers["x-client-channel"]),
      principal: user?.userId ? toPrincipal({ userId: user.userId, role: user.role }) : undefined,
      resource: `${req.method} ${req.baseUrl}${req.path}`,
    });
    req.authorization = result;

    if (result.allowed) {
      next();
      return;
    }

    res.status(result.reason === "missing_origin" ? 401 : 403).json({
      success: false,
      message: "Not authorized for this operation",
      code: result.reason,
      decisionId: result.decisionId,
    });
  };
}

export function authorizeSocketOperation(
  actor: AuthenticatedActor | undefined,
  operation: string,
  event: string,
  authorizer: UnifiedAuthorizer = unifiedAuthorizer
): Promise<AuthorizationRecord> {
  return authorizer.authorize({
    operation,
    channel: "websocket",
    principal: actor ? toPrincipal(actor) : undefined,
    resource: `socket:${event}`,
  });
}

export function authorizeBotOperation(
  actor: AuthenticatedActor | undefined,
  operation: string,
  command: string,
  approval?: ApprovalEvidence,
  authorizer: UnifiedAuthorizer = unifiedAuthorizer
): Promise<AuthorizationRecord> {
  return authorizer.authorize({
    operation,
    channel: "bot",
    principal: actor ? toPrincipal(actor) : undefined,
    resource: `bot:${command}`,
    approval,
  });
}

/**
 * Serializable job authorization context. Grants are deliberately *not*
 * stored: they are recomputed from the role at execution time so a policy or
 * role change reaches already-queued work.
 */
export interface StoredJobAuthContext {
  originPrincipalId: string;
  originRole: string;
  originChannel: Exclude<Channel, "job">;
  policyVersion: string;
}

export const JOB_AUTH_METADATA_KEY = "authContext";

export function captureJobAuthContext(
  actor: AuthenticatedActor,
  originChannel: Exclude<Channel, "job">
): StoredJobAuthContext {
  return {
    originPrincipalId: actor.userId,
    originRole: normalizeRole(actor.role),
    originChannel,
    policyVersion: POLICY_VERSION,
  };
}

function isStoredJobAuthContext(value: unknown): value is StoredJobAuthContext {
  const v = value as Partial<StoredJobAuthContext> | undefined;
  return (
    typeof v?.originPrincipalId === "string" &&
    typeof v.originRole === "string" &&
    (v.originChannel === "http" || v.originChannel === "websocket" || v.originChannel === "bot")
  );
}

/**
 * Authorizes a job as its originating principal under the current policy.
 * `resolveActor` should re-read the user (role, suspension) from the source
 * of truth; without it the role captured at enqueue time is used.
 */
export async function authorizeJobOperation(
  stored: unknown,
  operation: string,
  jobId: string,
  resolveActor?: (userId: string) => Promise<AuthenticatedActor | undefined>,
  authorizer: UnifiedAuthorizer = unifiedAuthorizer
): Promise<AuthorizationRecord> {
  if (!isStoredJobAuthContext(stored)) {
    return authorizer.authorize({ operation, channel: "job", resource: `job:${jobId}` });
  }

  const actor = resolveActor
    ? await resolveActor(stored.originPrincipalId)
    : { userId: stored.originPrincipalId, role: stored.originRole };

  if (!actor) {
    logger.warn("Job origin principal no longer exists", { jobId, userId: stored.originPrincipalId });
    return authorizer.authorize({ operation, channel: "job", resource: `job:${jobId}` });
  }

  return authorizer.authorize({
    operation,
    channel: "job",
    job: {
      originPrincipal: toPrincipal(actor),
      originChannel: stored.originChannel,
      policyVersion: stored.policyVersion,
    },
    resource: `job:${jobId}`,
  });
}
