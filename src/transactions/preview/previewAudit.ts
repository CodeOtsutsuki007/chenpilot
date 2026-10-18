import { ExecutionAction } from "../../AuditLog/auditEvent.types";
import { TransactionPreview } from "./types";

/** Minimal audit sink so callers (and tests) can supply their own writer. */
export interface PreviewAuditSink {
  logEvent(params: {
    action: ExecutionAction;
    actor?: { userId?: string };
    resource?: { type?: string; id?: string };
    metadata?: Record<string, unknown>;
    success?: boolean;
    correlationId?: string;
  }): Promise<unknown>;
}

/**
 * Records the link between the user's request and what they were shown.
 * Only digests and decoded summaries are stored — never the raw envelope or
 * any signing material.
 */
export async function recordPreviewAudit(preview: TransactionPreview, sink: PreviewAuditSink): Promise<void> {
  const refused = preview.decision === "refuse";
  await sink.logEvent({
    action: refused
      ? ExecutionAction.TRANSACTION_PREVIEW_REFUSED
      : ExecutionAction.TRANSACTION_PREVIEW_GENERATED,
    actor: { userId: preview.audit.userId },
    resource: { type: "transaction", id: preview.audit.transactionHash },
    correlationId: preview.audit.requestId,
    success: !refused,
    metadata: {
      previewId: preview.audit.previewId,
      previewDigest: preview.audit.previewDigest,
      intentDigest: preview.audit.intentDigest,
      channel: preview.audit.channel,
      network: preview.network,
      decision: preview.decision,
      riskLevel: preview.riskLevel,
      riskCodes: preview.riskFlags.map((f) => f.code),
      operationTypes: preview.operations.map((o) => o.type),
    },
  });
}
