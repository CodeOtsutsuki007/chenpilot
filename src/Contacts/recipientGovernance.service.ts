import crypto from "crypto";
import {
  canonicalChainIdentity,
  DuplicateRecipientError,
} from "./chainIdentity";
import { auditLogService } from "../AuditLog/auditLog.service";
import { AdminAction, AuditEventSeverity } from "../AuditLog/auditEvent.types";

export type RecipientRevisionStatus = "pending_verification" | "verified" | "superseded";

export interface RecipientRevision {
  revisionId: string;
  recipientId: string;
  identityKey: string;
  address: string;
  network: string;
  version: number;
  status: RecipientRevisionStatus;
  createdAt: string;
  /** Who created this address version (#1104). */
  createdBy: string;
  verifiedAt?: string;
  verifiedBy?: string;
  supersededAt?: string;
  supersededBy?: string;
}

/** One entry per address change, newest last (#1104). */
export interface RecipientAddressChange {
  recipientId: string;
  fromVersion: number | null;
  toVersion: number;
  fromAddress: string | null;
  toAddress: string;
  network: string;
  actor: string;
  changedAt: string;
  /** Verification status of the new version at the time of the change. */
  verificationStatus: RecipientRevisionStatus;
}

/** Thrown when a transfer approval no longer matches the recipient's current verified address version. */
export class RecipientRevocationError extends Error {
  constructor(message: string, public readonly reason: "already_revoked" | "not_found" | "invalid_state") {
    super(message);
    this.name = "RecipientRevocationError";
  }
}

export class StaleRecipientApprovalError extends Error {
  constructor(
    message: string,
    public readonly approvedVersion: number,
    public readonly currentVersion: number
  ) {
    super(message);
    this.name = "StaleRecipientApprovalError";
  }
}

export interface PreparedTransfer {
  transferId: string;
  recipientId: string;
  approvedRevisionId: string;
  /** Address version the approval was granted for; any later change invalidates it. */
  approvedVersion: number;
  approvalHash: string;
}

export class RecipientGovernanceService {
  private readonly revisions = new Map<string, RecipientRevision[]>();
  private readonly changes = new Map<string, RecipientAddressChange[]>();

  createRecipient(input: { recipientId: string; identityKey: string; address: string; network: string; actor?: string }, now = new Date()): RecipientRevision {
    const actor = input.actor ?? "system";
    this.assertNoDuplicateIdentity(input.network, input.address, input.recipientId);
    const revision = this.revision(input, 1, "pending_verification", now, actor);
    this.revisions.set(input.recipientId, [revision]);
    this.changes.set(input.recipientId, [
      {
        recipientId: input.recipientId,
        fromVersion: null,
        toVersion: 1,
        fromAddress: null,
        toAddress: input.address,
        network: input.network,
        actor,
        changedAt: now.toISOString(),
        verificationStatus: revision.status,
      },
    ]);
    auditLogService.log({
      action: AdminAction.CONTACT_RECIPIENT_CREATE,
      severity: AuditEventSeverity.INFO,
      actor,
      target: input.recipientId,
      details: {
        recipientId: input.recipientId,
        address: input.address,
        network: input.network,
        revisionId: revision.revisionId,
      },
    });
    return { ...revision };
  }

  verifyRevision(recipientId: string, revisionId: string, now = new Date(), actor = "system"): RecipientRevision {
    const revision = this.mustFind(recipientId, revisionId);
    if (revision.status === "superseded") {
      throw new Error("Cannot verify a superseded recipient address version");
    }
    revision.status = "verified";
    revision.verifiedAt = now.toISOString();
    revision.verifiedBy = actor;
    return { ...revision };
  }

  updateRecipient(
    input: { recipientId: string; address: string; network: string; actor?: string },
    now = new Date()
  ): RecipientRevision {
    const actor = input.actor ?? "system";
    const history = this.revisions.get(input.recipientId);
    if (!history?.length) {
      throw new Error(`Unknown recipient: ${input.recipientId}`);
    }

    const current = history[history.length - 1];
    if (
      canonicalChainIdentity(current.network, current.address) ===
      canonicalChainIdentity(input.network, input.address)
    ) {
      return { ...current };
    }

    this.assertNoDuplicateIdentity(input.network, input.address, input.recipientId);

    current.status = "superseded";
    current.supersededAt = now.toISOString();
    current.supersededBy = actor;
    const next = this.revision(
      { recipientId: input.recipientId, address: input.address, network: input.network, identityKey: current.identityKey },
      current.version + 1,
      "pending_verification",
      now,
      actor,
    );
    history.push(next);
    this.changes.get(input.recipientId)?.push({
      recipientId: input.recipientId,
      fromVersion: current.version,
      toVersion: next.version,
      fromAddress: current.address,
      toAddress: next.address,
      network: next.network,
      actor,
      changedAt: now.toISOString(),
      verificationStatus: next.status,
    });
    auditLogService.log({
      action: AdminAction.CONTACT_RECIPIENT_UPDATE,
      severity: AuditEventSeverity.WARNING,
      actor,
      target: input.recipientId,
      details: {
        recipientId: input.recipientId,
        fromVersion: current.version,
        toVersion: next.version,
        fromAddress: current.address,
        toAddress: next.address,
        network: next.network,
        revisionId: next.revisionId,
      },
    });
    return { ...next };
  }

  prepareTransfer(input: { transferId: string; recipientId: string; revisionId: string; amount: string; asset: string }): PreparedTransfer {
    const revision = this.mustFind(input.recipientId, input.revisionId);
    if (revision.status !== "verified") {
      throw new Error("Recipient revision must be verified before transfer approval");
    }

    const approvalHash = crypto.createHash("sha256").update(JSON.stringify({ ...input, address: revision.address, network: revision.network })).digest("hex");
    return {
      transferId: input.transferId,
      recipientId: input.recipientId,
      approvedRevisionId: revision.revisionId,
      approvedVersion: revision.version,
      approvalHash,
    };
  }

  /**
   * Accept a prepared transfer only if its approval is for the recipient's
   * current, verified address version (#1104). Any address change after the
   * approval — even back to the same address — requires a new approval.
   */
  submitTransfer(transfer: PreparedTransfer): RecipientRevision {
    const revision = this.mustFind(transfer.recipientId, transfer.approvedRevisionId);
    const current = this.current(transfer.recipientId);
    if (revision.revisionId !== current.revisionId || transfer.approvedVersion !== current.version) {
      throw new StaleRecipientApprovalError(
        `Approval was for address version ${transfer.approvedVersion}; current version is ${current.version}. Re-approve the transfer.`,
        transfer.approvedVersion,
        current.version
      );
    }
    if (revision.status !== "verified") {
      throw new Error("Prepared transfer is bound to a recipient revision that is no longer verified");
    }
    return { ...revision };
  }

  /** Versioned address-change log with actor, time and verification status. */
  addressChanges(recipientId: string): RecipientAddressChange[] {
    const revisions = this.revisions.get(recipientId) ?? [];
    // Report the *current* verification status of each version alongside the change.
    return (this.changes.get(recipientId) ?? []).map((change) => ({
      ...change,
      verificationStatus:
        revisions.find((r) => r.version === change.toVersion)?.status ?? change.verificationStatus,
    }));
  }

  private current(recipientId: string): RecipientRevision {
    const history = this.revisions.get(recipientId);
    if (!history?.length) {
      throw new Error(`Unknown recipient: ${recipientId}`);
    }
    return history[history.length - 1];
  }

  history(recipientId: string): RecipientRevision[] {
    return [...(this.revisions.get(recipientId) || [])];
  }

  /**
   * Revoke approval/verification for a recipient or specific revision.
   * 
   * Failure cases:
   * - Recipient or revision not found: throws RecipientRevocationError("not_found")
   * - Revision already revoked/superseded: throws RecipientRevocationError("already_revoked")
   * - Invalid state / unsupported operation: throws RecipientRevocationError("invalid_state")
   * 
   * Compatibility requirements:
   * - Existing unrevoked revisions remain auditable and their historical records intact.
   * - Any prepared transfer relying on a revoked revision automatically becomes stale and throws StaleRecipientApprovalError.
   */
  revokeRecipientApproval(params: { recipientId: string; revisionId?: string; actor: string; reason?: string }, now = new Date()): RecipientRevision {
    const revs = this.revisions.get(params.recipientId);
    if (!revs || revs.length === 0) {
      throw new RecipientRevocationError(`Recipient not found: ${params.recipientId}`, "not_found");
    }

    let target: RecipientRevision;
    if (params.revisionId) {
      const found = revs.find(r => r.revisionId === params.revisionId);
      if (!found) {
        throw new RecipientRevocationError(`Revision not found: ${params.revisionId}`, "not_found");
      }
      target = found;
    } else {
      // Default to current latest revision
      target = revs[revs.length - 1];
    }

    if (target.status === "superseded" || target.status === "revoked") {
      throw new RecipientRevocationError(`Recipient revision is already ${target.status}: ${target.revisionId}`, "already_revoked");
    }

    target.status = "revoked";
    target.supersededBy = params.actor;
    target.supersededAt = now.toISOString();

    // Record revocation in address changes log as well for complete auditability
    const changes = this.changes.get(params.recipientId) || [];
    changes.push({
      recipientId: params.recipientId,
      fromVersion: target.version,
      toVersion: target.version,
      fromAddress: target.address,
      toAddress: target.address,
      network: target.network,
      actor: params.actor,
      changedAt: now.toISOString(),
      verificationStatus: "revoked",
    });
    this.changes.set(params.recipientId, changes);

    return target;
  }

  /**
   * Reject identities already claimed by a different recipient's latest
   * (non-superseded) revision, comparing canonical chain identity so case
   * and whitespace variants cannot bypass the check.
   */
  private assertNoDuplicateIdentity(
    network: string,
    address: string,
    recipientId: string
  ): void {
    const identity = canonicalChainIdentity(network, address);
    for (const [otherId, history] of this.revisions) {
      if (otherId === recipientId || history.length === 0) {
        continue;
      }
      const latest = history[history.length - 1];
      if (
        canonicalChainIdentity(latest.network, latest.address) === identity
      ) {
        throw new DuplicateRecipientError(identity, latest.revisionId);
      }
    }
  }

  private revision(
    input: { recipientId: string; identityKey: string; address: string; network: string },
    version: number,
    status: RecipientRevisionStatus,
    now: Date,
    actor: string
  ): RecipientRevision {
    const revisionId = crypto.createHash("sha256").update(`${input.recipientId}:${version}:${input.address}:${input.network}`).digest("hex").slice(0, 16);
    return {
      recipientId: input.recipientId,
      identityKey: input.identityKey,
      address: input.address,
      network: input.network,
      revisionId,
      version,
      status,
      createdAt: now.toISOString(),
      createdBy: actor,
    };
  }

  private mustFind(recipientId: string, revisionId: string): RecipientRevision {
    const revision = this.revisions.get(recipientId)?.find((item) => item.revisionId === revisionId);
    if (!revision) {
      throw new Error(`Unknown recipient revision: ${revisionId}`);
    }
    return revision;
  }
}
