import { NextFunction, Request, Response } from "express";
import { AbusePreventionService } from "./AbusePreventionService";
import { defaultAbusePreventionService } from "./serviceInstance";
import { AbuseSubject, AbuseSurface } from "./types";

export function extractClientIp(req: Request): string {
  const forwarded = (req.headers["x-forwarded-for"] as string | undefined)
    ?.split(",")[0]
    ?.trim();

  return forwarded || req.socket?.remoteAddress || req.ip || "unknown";
}

export function normalizeIp(ip: string): string {
  const trimmed = ip.trim();

  if (trimmed.startsWith("::ffff:")) {
    return trimmed.replace("::ffff:", "");
  }

  if (trimmed === "::1") {
    return "127.0.0.1";
  }

  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(trimmed)) {
    return trimmed.slice(0, trimmed.lastIndexOf(":"));
  }

  return trimmed;
}

export interface AbuseMiddlewareOptions {
  /** Surface the route belongs to. Defaults to "api". */
  surface?: AbuseSurface;
  /** Extra subject fields, e.g. the platform user id inside a bot webhook body. */
  subject?: (req: Request) => Partial<AbuseSubject>;
}

export function createAbusePreventionMiddleware(
  action: string,
  service: AbusePreventionService = defaultAbusePreventionService,
  options: AbuseMiddlewareOptions = {}
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ipAddress = normalizeIp(extractClientIp(req));
      req.clientIP = ipAddress;

      const result = await service.evaluate({
        surface: options.surface ?? "api",
        action,
        subject: {
          ipAddress,
          userId: req.user?.userId || req.body?.userId,
          ...options.subject?.(req),
        },
        metadata: {
          method: req.method,
          path: req.path,
        },
      });

      if (result.allowed) {
        next();
        return;
      }

      if (result.retryAfterMs !== undefined) {
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
      }

      res.status(result.decision === "throttle" ? 429 : 403).json({
        success: false,
        error:
          result.decision === "throttle"
            ? "Too many requests"
            : result.decision === "challenge"
              ? "Verification required"
              : "Access denied",
        message: result.reason,
        code: result.policyId,
        retryAfterMs: result.retryAfterMs,
      });
    } catch (error) {
      next(error);
    }
  };
}
