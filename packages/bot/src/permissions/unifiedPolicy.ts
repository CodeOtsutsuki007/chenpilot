/**
 * Bot-side bridge to the backend's unified authorization policy.
 *
 * Commands that act on a user's account are mapped to the backend's policy
 * catalog operations and checked via POST /api/authorization/check with the
 * channel set to "bot", so the bot gets exactly the decision the HTTP API,
 * WebSocket gateway and job worker would get for the same user.
 */

export const COMMAND_OPERATIONS: Readonly<Record<string, string>> = {
  swap: "swap:execute",
  send: "wallet:transfer",
  transfer: "wallet:transfer",
  trustline: "transaction:submit",
  sponsor: "transaction:submit",
  multisig: "transaction:submit",
  balance: "chain:read",
  portfolio: "chain:read",
  validate: "chain:read",
  ask: "agent:query",
};

export interface UnifiedDecision {
  allowed: boolean;
  reason: string;
  decisionId?: string;
  policyVersion?: string;
}

export type AuthorizationChecker = (body: { operation: string; channel: "bot"; resource?: string }) => Promise<{
  success: boolean;
  data?: UnifiedDecision;
}>;

export function createHttpAuthorizationChecker(baseUrl: string, accessToken: string): AuthorizationChecker {
  return async (body) => {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/authorization/check`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        "x-client-channel": "bot",
      },
      body: JSON.stringify(body),
    });
    return (await response.json()) as { success: boolean; data?: UnifiedDecision };
  };
}

/**
 * Returns the backend decision for a bot command. Commands without a mapped
 * operation are informational and allowed locally; mapped commands fail
 * closed when the backend cannot be reached.
 */
export async function authorizeBotCommand(
  checker: AuthorizationChecker,
  command: string
): Promise<UnifiedDecision> {
  const operation = COMMAND_OPERATIONS[command.replace(/^[/!]/, "").toLowerCase()];
  if (!operation) return { allowed: true, reason: "unmapped_command" };

  try {
    const response = await checker({ operation, channel: "bot", resource: `bot:${command}` });
    if (!response.success || !response.data) return { allowed: false, reason: "policy_unavailable" };
    return response.data;
  } catch {
    return { allowed: false, reason: "policy_unavailable" };
  }
}
