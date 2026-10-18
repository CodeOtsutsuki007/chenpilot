/**
 * Bot-side handling of decoded transaction previews.
 *
 * The bot never renders transactions itself: it asks the backend's
 * POST /api/transactions/preview endpoint, which returns both the structured
 * preview and the canonical text rendering shared with the web UI. This module
 * only turns the backend's decision into the bot's confirmation flow.
 */

import type { CommandReply } from "./commands/types";

export type PreviewDecision = "proceed" | "confirm_with_warning" | "refuse";

export interface PreviewIntent {
  description?: string;
  operationTypes?: string[];
  asset?: string;
  amount?: string;
  destination?: string;
  network?: "public" | "testnet" | "futurenet" | "unknown";
}

/** Subset of the backend preview the bot relies on. */
export interface BackendPreviewResponse {
  success: boolean;
  text?: string;
  message?: string;
  decision?: PreviewDecision;
  preview?: {
    decision: PreviewDecision;
    decisionReason: string;
    audit: { previewId: string; transactionHash: string };
  };
}

export interface PendingConfirmation {
  previewId: string;
  transactionHash: string;
  /** Exact text the user must reply with for high-risk previews; undefined for a normal yes/no. */
  confirmationPhrase?: string;
}

export interface PreviewReply {
  reply: CommandReply;
  /** True when the transaction must not be signed under any circumstances. */
  blocked: boolean;
  pending?: PendingConfirmation;
}

export type PreviewFetcher = (body: {
  xdr: string;
  networkPassphrase?: string;
  intent?: PreviewIntent;
}) => Promise<BackendPreviewResponse>;

/** Default fetcher backed by the global fetch API. */
export function createHttpPreviewFetcher(baseUrl: string, accessToken: string): PreviewFetcher {
  return async (body) => {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/transactions/preview`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        "x-client-channel": "bot",
      },
      body: JSON.stringify(body),
    });
    return (await response.json()) as BackendPreviewResponse;
  };
}

/**
 * Maps a backend preview to the bot reply and confirmation requirement.
 * Anything the bot cannot positively identify as a decoded preview is blocked.
 */
export function previewToReply(response: BackendPreviewResponse): PreviewReply {
  if (!response.success || !response.preview || !response.text) {
    return {
      blocked: true,
      reply: {
        text: `⛔ This transaction could not be verified and will not be signed.\n${response.message ?? ""}`.trim(),
        ephemeral: true,
      },
    };
  }

  const { preview, text } = response;
  const base = { previewId: preview.audit.previewId, transactionHash: preview.audit.transactionHash };

  switch (preview.decision) {
    case "refuse":
      return { blocked: true, reply: { text, ephemeral: true } };

    case "confirm_with_warning": {
      const phrase = `CONFIRM ${preview.audit.transactionHash.slice(0, 6).toUpperCase()}`;
      return {
        blocked: false,
        pending: { ...base, confirmationPhrase: phrase },
        reply: {
          text: `${text}\n\nTo approve anyway, reply exactly: ${phrase}\nAnything else cancels.`,
          ephemeral: true,
        },
      };
    }

    case "proceed":
      return {
        blocked: false,
        pending: base,
        reply: { text: `${text}\n\nReply "yes" to approve or "no" to cancel.`, ephemeral: true },
      };

    default:
      return {
        blocked: true,
        reply: { text: "⛔ Unknown preview decision; transaction will not be signed.", ephemeral: true },
      };
  }
}

/** Checks a user's reply against the pending confirmation. */
export function isConfirmed(pending: PendingConfirmation, userReply: string): boolean {
  const reply = userReply.trim();
  if (pending.confirmationPhrase) {
    return reply.toUpperCase() === pending.confirmationPhrase;
  }
  return ["yes", "y", "approve"].includes(reply.toLowerCase());
}

export async function previewTransactionForBot(
  fetcher: PreviewFetcher,
  xdr: string,
  intent?: PreviewIntent,
  networkPassphrase?: string
): Promise<PreviewReply> {
  try {
    return previewToReply(await fetcher({ xdr, intent, networkPassphrase }));
  } catch (error) {
    return previewToReply({
      success: false,
      message: error instanceof Error ? "Preview service unavailable." : undefined,
    });
  }
}
