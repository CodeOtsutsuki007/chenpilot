import { ipBlacklistService } from "../ipBlacklist.service";
import { AbusePolicy } from "./types";

export const defaultAbusePolicy: AbusePolicy = {
  rules: [
    {
      id: "blocked-ip",
      description: "Deny traffic from active IP blacklist entries.",
      surfaces: ["api", "bot", "realtime", "job"],
      actions: ["*"],
      decision: "deny",
      reason: "IP address is blocked",
      match: async ({ subject }) => {
        if (!subject.ipAddress) {
          return false;
        }

        return ipBlacklistService.isBlacklisted(subject.ipAddress);
      },
    },
  ],
  rateLimits: [
    {
      id: "api-sensitive-action",
      surfaces: ["api"],
      actions: ["query", "wallet", "soroban", "kyc.submit"],
      maxRequests: 20,
      windowMs: 60 * 1000,
      keyBy: ["userId", "ipAddress"],
    },
    {
      id: "bot-command",
      surfaces: ["bot"],
      actions: ["*"],
      maxRequests: 10,
      windowMs: 60 * 1000,
      keyBy: ["userId"],
    },
    {
      id: "realtime-subscribe",
      surfaces: ["realtime"],
      actions: ["subscribe:transactions", "subscribe:bot-alerts"],
      maxRequests: 30,
      windowMs: 60 * 1000,
      keyBy: ["userId", "sessionId", "ipAddress"],
    },
    {
      id: "api-auth",
      surfaces: ["api"],
      actions: ["auth.login"],
      maxRequests: 10,
      windowMs: 60 * 1000,
      keyBy: ["ipAddress"],
    },
    {
      // Inbound Telegram/Discord webhooks, keyed by platform user.
      id: "bot-webhook",
      surfaces: ["bot"],
      actions: ["webhook.telegram", "webhook.discord"],
      maxRequests: 30,
      windowMs: 60 * 1000,
      keyBy: ["userId", "ipAddress"],
    },
    {
      // Proxied chain reads (Horizon): stop wallet probing before it reaches the provider.
      id: "api-chain-read",
      surfaces: ["api"],
      actions: ["chain.horizon"],
      maxRequests: 60,
      windowMs: 60 * 1000,
      keyBy: ["userId", "ipAddress"],
    },
    {
      // Background work a single user can schedule.
      id: "job-enqueue",
      surfaces: ["job"],
      actions: ["*"],
      maxRequests: 30,
      windowMs: 60 * 1000,
      keyBy: ["userId"],
    },
    {
      // Expensive outbound provider calls (Horizon, Soroban RPC, LLM) made on a user's behalf.
      id: "provider-call",
      surfaces: ["provider"],
      actions: ["*"],
      maxRequests: 120,
      windowMs: 60 * 1000,
      keyBy: ["userId"],
    },
  ],
  escalation: {
    violationThreshold: 5,
    windowMs: 10 * 60 * 1000,
    baseBlockMs: 60 * 1000,
    maxBlockMs: 60 * 60 * 1000,
  },
  anomaly: {
    windowMs: 5 * 60 * 1000,
    challengeThreshold: 8,
    blockThreshold: 15,
  },
};
