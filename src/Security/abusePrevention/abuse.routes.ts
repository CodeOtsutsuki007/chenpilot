import { Router, Request, Response } from "express";
import { authenticateToken } from "../../Auth/auth.middleware";
import { requireAdmin } from "../../Gateway/middleware/rbac.middleware";
import logger from "../../config/logger";
import { requireOperation } from "../authorization/channelAdapters";
import {
  abuseTelemetry,
  defaultAbusePreventionService,
  providerExecutionGate,
  reloadAbusePolicy,
} from "./serviceInstance";

/**
 * Operator endpoints for abuse protection: inspect throttling/blocking,
 * lift a block during incident response, and reload tuned thresholds.
 */
const router = Router();

router.use(authenticateToken, requireAdmin, requireOperation("admin:security"));

router.get("/stats", (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      abuse: defaultAbusePreventionService.getStats(),
      providerGate: providerExecutionGate.getStats(),
    },
  });
});

router.get("/events", (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  res.json({ success: true, data: abuseTelemetry.getRecent(limit) });
});

router.get("/policy", (_req: Request, res: Response) => {
  const { rules, ...tunable } = defaultAbusePreventionService.getPolicy();
  res.json({
    success: true,
    data: { ...tunable, rules: (rules ?? []).map(({ id, surfaces, actions, decision }) => ({ id, surfaces, actions, decision })) },
  });
});

router.post("/unblock", (req: Request, res: Response) => {
  const subjectKey = typeof req.body?.subjectKey === "string" ? req.body.subjectKey : "";
  if (!/^(user|ip|session):.+/.test(subjectKey)) {
    return res.status(400).json({ success: false, message: "subjectKey must look like user:<id>, ip:<addr> or session:<id>" });
  }
  const removed = defaultAbusePreventionService.unblock(subjectKey);
  logger.warn("Abuse block lifted by operator", { subjectKey, operator: req.user?.userId, removed });
  return res.json({ success: true, removed });
});

router.post("/reload", (req: Request, res: Response) => {
  const warnings = reloadAbusePolicy();
  logger.warn("Abuse policy reloaded by operator", { operator: req.user?.userId, warnings });
  res.json({ success: true, warnings });
});

export default router;
