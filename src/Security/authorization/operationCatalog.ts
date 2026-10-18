import { createHash } from "crypto";
import { Channel, ChannelPolicy, Principal } from "./channelPolicy";

/**
 * Single source of truth for what can be done, by whom, and from where.
 *
 * Every entry point (HTTP route, WebSocket event, bot command, background
 * job) names one of these operations and is evaluated by the same
 * authorizer, so a policy change here propagates to every surface at once.
 * The privilege graph committed under docs/security is generated from this
 * file and diffed in CI.
 */

export type SideEffect = "read" | "write" | "financial" | "admin" | "system";

export type PolicyRole = "admin" | "moderator" | "user" | "service";

export interface OperationPolicy {
  operation: string;
  description: string;
  sideEffect: SideEffect;
  /** Channels this operation may be invoked from. Anything else is refused. */
  channels: readonly Channel[];
  /** Financial operations whose approval must still match current economic inputs. */
  requiresApproval?: boolean;
}

export const OPERATION_CATALOG: readonly OperationPolicy[] = [
  { operation: "agent:query", description: "Natural-language request to the agent", sideEffect: "read", channels: ["http", "bot", "websocket"] },
  { operation: "transaction:preview", description: "Decode a transaction into a human-safe preview", sideEffect: "read", channels: ["http", "bot", "websocket"] },
  { operation: "transaction:submit", description: "Sign and submit a previewed transaction", sideEffect: "financial", channels: ["http", "bot", "job"], requiresApproval: true },
  { operation: "wallet:transfer", description: "Send funds from the user's wallet", sideEffect: "financial", channels: ["http", "bot", "job"], requiresApproval: true },
  { operation: "swap:execute", description: "Execute a DEX swap", sideEffect: "financial", channels: ["http", "bot", "job"], requiresApproval: true },
  { operation: "funding:deploy", description: "Fund and deploy the user's account", sideEffect: "financial", channels: ["http", "job"] },
  { operation: "chain:read", description: "Read chain state through the provider proxy", sideEffect: "read", channels: ["http", "bot", "websocket", "job"] },
  { operation: "realtime:subscribe", description: "Subscribe to transaction or bot alert streams", sideEffect: "read", channels: ["websocket"] },
  { operation: "bot:session", description: "Manage the user's bot conversation session", sideEffect: "write", channels: ["http", "bot"] },
  { operation: "audit:read", description: "Read audit logs", sideEffect: "read", channels: ["http"] },
  { operation: "admin:security", description: "Operate abuse protection and security controls", sideEffect: "admin", channels: ["http"] },
  { operation: "admin:agents", description: "Administer agents, experiments and workflows", sideEffect: "admin", channels: ["http"] },
  { operation: "admin:users", description: "Administer user accounts and roles", sideEffect: "admin", channels: ["http"] },
  { operation: "system:maintenance", description: "Scheduled maintenance jobs (cleanup, monitoring)", sideEffect: "system", channels: ["job"] },
];

const USER_GRANTS = [
  "agent:query",
  "transaction:preview",
  "transaction:submit",
  "wallet:transfer",
  "swap:execute",
  "funding:deploy",
  "chain:read",
  "realtime:subscribe",
  "bot:session",
] as const;

export const ROLE_GRANTS: Readonly<Record<PolicyRole, readonly string[]>> = {
  user: USER_GRANTS,
  moderator: [...USER_GRANTS, "audit:read"],
  admin: [...USER_GRANTS, "audit:read", "admin:*"],
  service: ["system:maintenance", "chain:read"],
};

export const CHANNELS: readonly Channel[] = ["http", "websocket", "bot", "job"];

const catalogByOperation = new Map(OPERATION_CATALOG.map((p) => [p.operation, p]));

export function getOperationPolicy(operation: string): OperationPolicy | undefined {
  return catalogByOperation.get(operation);
}

/** Per-channel deny lists derived from the catalog's channel metadata. */
export function deriveChannelPolicies(
  catalog: readonly OperationPolicy[] = OPERATION_CATALOG
): Record<Channel, ChannelPolicy> {
  const policies = {} as Record<Channel, ChannelPolicy>;
  for (const channel of CHANNELS) {
    policies[channel] = {
      denied: catalog.filter((p) => !p.channels.includes(channel)).map((p) => p.operation),
    };
  }
  return policies;
}

export const CATALOG_CHANNEL_POLICIES = deriveChannelPolicies();

export function normalizeRole(role: string | undefined): PolicyRole {
  return role === "admin" || role === "moderator" || role === "service" ? role : "user";
}

export function principalForRole(id: string, role: string | undefined, suspended = false): Principal {
  return { id, grants: ROLE_GRANTS[normalizeRole(role)], suspended };
}

/**
 * Content hash of the whole policy. Decisions and job auth contexts record it,
 * so audit logs show which policy produced a decision and deferred work can
 * tell when the policy changed after it was enqueued.
 */
export function computePolicyVersion(
  catalog: readonly OperationPolicy[] = OPERATION_CATALOG,
  grants: Readonly<Record<string, readonly string[]>> = ROLE_GRANTS
): string {
  const body = JSON.stringify({
    catalog: [...catalog]
      .sort((a, b) => a.operation.localeCompare(b.operation))
      .map((p) => ({ ...p, channels: [...p.channels].sort() })),
    grants: Object.fromEntries(Object.entries(grants).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...v].sort()])),
  });
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

export const POLICY_VERSION = computePolicyVersion();
