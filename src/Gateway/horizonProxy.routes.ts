import { Router, Request, Response } from "express";
import { authenticateToken } from "../Auth/auth.middleware";
import { validateQuery } from "./middleware/validation";
import { horizonProxyService, HorizonProxyError } from "./horizonProxy.service";
import { HorizonProxyQueryDto } from "../validators/dto/HorizonProxyDto";
import logger from "../config/logger";
import { requireOperation } from "../Security/authorization/channelAdapters";
import {
  createAbusePreventionMiddleware,
  defaultAbusePreventionService,
  ExecutionGateRejectedError,
  providerExecutionGate,
} from "../Security/abusePrevention";

const router = Router();

router.get(
  "/proxy",
  authenticateToken,
  requireOperation("chain:read"),
  createAbusePreventionMiddleware("chain.horizon"),
  validateQuery(HorizonProxyQueryDto),
  async (req: Request, res: Response) => {
    try {
      const query = req.query as HorizonProxyQueryDto;
      const path = query.path;
      const queryParams = { ...req.query } as Record<
        string,
        string | string[] | undefined
      >;
      delete queryParams.path;

      const data = await providerExecutionGate.run(
        { userId: req.user?.userId },
        () => horizonProxyService.proxyGet(path, queryParams),
        "horizon.proxy"
      );

      return res.status(200).json({
        success: true,
        data,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Proxy request failed";

      logger.warn("Horizon proxy request failed", {
        error: message,
        userId: req.user?.userId,
        path: req.query.path,
      });

      if (error instanceof ExecutionGateRejectedError) {
        if (error.retryAfterMs !== undefined) {
          res.setHeader("Retry-After", String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
        }
        return res.status(error.reason === "throttled" ? 429 : 503).json({
          success: false,
          message:
            error.reason === "throttled"
              ? "Too many chain requests"
              : "Chain provider temporarily unavailable",
          code: error.reason,
        });
      }

      if (error instanceof HorizonProxyError) {
        if (error.statusCode === 404) {
          // Repeated lookups of non-existent accounts look like wallet probing.
          defaultAbusePreventionService.recordFailure(
            { surface: "provider", action: "horizon.proxy", subject: { userId: req.user?.userId } },
            "chain_not_found"
          );
        }
        return res.status(error.statusCode).json({
          success: false,
          message: error.message,
        });
      }

      return res.status(500).json({
        success: false,
        message: "Internal proxy error",
      });
    }
  }
);

export default router;
