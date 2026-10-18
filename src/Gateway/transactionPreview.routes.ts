import { Router, Request, Response } from "express";
import config from "../config/config";
import logger from "../config/logger";
import { authenticateToken } from "../Auth/auth.middleware";
import { requireOperation } from "../Security/authorization/channelAdapters";
import { auditLogService } from "../AuditLog/auditLog.service";
import {
  buildTransactionPreview,
  recordPreviewAudit,
  renderPreviewText,
  TransactionIntent,
} from "../transactions/preview";
import { XdrSecurityError } from "../utils/xdr";

const router = Router();

const PREVIEW_CHANNELS = new Set(["api", "ui", "bot"]);

/**
 * @swagger
 * /api/transactions/preview:
 *   post:
 *     summary: Decode a transaction envelope into a human-safe preview
 *     description: >
 *       Returns the structured preview (operations, risk flags, intent comparison,
 *       audit trail) together with the canonical text rendering used by the bot.
 *       A `decision` of `refuse` means the client must not offer signing.
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 */
router.post("/", authenticateToken, requireOperation("transaction:preview"), async (req: Request, res: Response) => {
  const { xdr, networkPassphrase, intent } = (req.body ?? {}) as {
    xdr?: unknown;
    networkPassphrase?: unknown;
    intent?: TransactionIntent;
  };

  if (typeof xdr !== "string" || xdr.trim() === "") {
    return res.status(400).json({ success: false, message: "xdr (base64 envelope) is required" });
  }
  if (networkPassphrase !== undefined && typeof networkPassphrase !== "string") {
    return res.status(400).json({ success: false, message: "networkPassphrase must be a string" });
  }
  if (intent !== undefined && (typeof intent !== "object" || intent === null || Array.isArray(intent))) {
    return res.status(400).json({ success: false, message: "intent must be an object" });
  }

  const channelHeader = String(req.headers["x-client-channel"] ?? "api").toLowerCase();
  const channel = PREVIEW_CHANNELS.has(channelHeader) ? channelHeader : "api";

  try {
    const preview = buildTransactionPreview({
      xdr,
      networkPassphrase: networkPassphrase ?? config.stellar.networkPassphrase,
      intent,
      requestId: req.requestId,
      userId: req.user?.userId,
      channel,
    });

    await recordPreviewAudit(preview, auditLogService).catch((error) =>
      logger.warn("Failed to record transaction preview audit", {
        previewId: preview.audit.previewId,
        error: error instanceof Error ? error.message : String(error),
      })
    );

    return res.status(200).json({
      success: true,
      preview,
      text: renderPreviewText(preview),
    });
  } catch (error) {
    if (error instanceof XdrSecurityError) {
      // Undecodable payloads are refused outright — never shown as an opaque blob.
      return res.status(422).json({
        success: false,
        decision: "refuse",
        message: "Transaction could not be decoded and will not be offered for signing.",
      });
    }
    logger.error("Transaction preview failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ success: false, message: "Failed to build transaction preview" });
  }
});

export default router;
