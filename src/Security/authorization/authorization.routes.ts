import { Router, Request, Response } from "express";
import { authenticateToken } from "../../Auth/auth.middleware";
import { Channel } from "./channelPolicy";
import { hasBotIdentity, parseClaimedChannel, unifiedAuthorizer } from "./channelAdapters";
import { OPERATION_CATALOG, POLICY_VERSION, principalForRole } from "./operationCatalog";

/**
 * Lets out-of-process surfaces (the Telegram/Discord bot) ask the backend for
 * a decision instead of keeping their own copy of the policy.
 */
const router = Router();

router.get("/policy", authenticateToken, (_req: Request, res: Response) => {
  res.json({ success: true, data: { policyVersion: POLICY_VERSION, operations: OPERATION_CATALOG } });
});

router.post("/check", authenticateToken, async (req: Request, res: Response) => {
  const operation = typeof req.body?.operation === "string" ? req.body.operation : "";
  if (!operation) {
    return res.status(400).json({ success: false, message: "operation is required" });
  }

  const user = req.user as { userId: string; role?: string };
  const channel: Channel = hasBotIdentity(req) ? "bot" : "http";
  const result = await unifiedAuthorizer.authorize({
    operation,
    channel,
    claimedChannel: parseClaimedChannel(req.body?.channel ?? req.headers["x-client-channel"]),
    principal: principalForRole(user.userId, user.role),
    resource: typeof req.body?.resource === "string" ? req.body.resource.slice(0, 200) : undefined,
  });

  return res.json({
    success: true,
    data: {
      allowed: result.allowed,
      reason: result.reason,
      decisionId: result.decisionId,
      policyVersion: result.policyVersion,
    },
  });
});

export default router;
