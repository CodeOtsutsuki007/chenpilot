/**
 * Structured, decoded transaction preview.
 *
 * Every surface that asks a user to approve a transaction (bot, web UI, API)
 * renders from this one structure, which is built from the decoded envelope —
 * never from the agent's free-text description of what it *thinks* the
 * transaction does.
 */

export type PreviewNetwork = "public" | "testnet" | "futurenet" | "unknown";

export type RiskSeverity = "info" | "low" | "medium" | "high" | "critical";

/**
 * What the caller must do with the preview:
 *  - proceed: normal confirmation prompt
 *  - confirm_with_warning: show warnings and require an explicit second confirmation
 *  - refuse: do not offer signing at all
 */
export type PreviewDecision = "proceed" | "confirm_with_warning" | "refuse";

export interface RiskFlag {
  code: string;
  severity: RiskSeverity;
  message: string;
  /** Index of the operation that raised the flag; absent for envelope-level flags. */
  operationIndex?: number;
}

export interface PreviewOperation {
  index: number;
  /** Stellar operation type, e.g. "payment", "setOptions". */
  type: string;
  /** One-line human-readable description. */
  summary: string;
  /** Account the operation acts on (operation source or transaction source). */
  sourceAccount: string;
  /** True when the operation acts on an account other than the transaction source. */
  foreignSource: boolean;
  /** True when the operation moves value out of the source account. */
  movesValue: boolean;
  asset?: string;
  amount?: string;
  destination?: string;
  /** Additional decoded fields relevant to this operation type. */
  details: Record<string, string | number | boolean | null>;
}

export interface TransactionIntent {
  /** Free-text description of what the user asked for (kept for the audit trail). */
  description?: string;
  /** Operation types the user's request is expected to produce. */
  operationTypes?: string[];
  /** Asset the user asked to move: "XLM", "USDC" or "USDC:G...". */
  asset?: string;
  /** Maximum amount the user asked to move, as a decimal string. */
  amount?: string;
  /** Destination account the user asked to send to. */
  destination?: string;
  network?: PreviewNetwork;
}

export type IntentMismatchField =
  | "operationType"
  | "asset"
  | "amount"
  | "destination"
  | "network";

export interface IntentMismatch {
  field: IntentMismatchField;
  expected: string;
  actual: string;
  operationIndex?: number;
  severity: RiskSeverity;
}

export interface IntentComparison {
  /** False when no intent was supplied, so nothing could be compared. */
  compared: boolean;
  matches: boolean;
  mismatches: IntentMismatch[];
}

export interface PreviewAuditTrail {
  previewId: string;
  generatedAt: string;
  /** Hash of the transaction as it will be signed (hex). */
  transactionHash: string;
  /** Hash of the normalized user intent; links the request to the preview. */
  intentDigest: string | null;
  /** Hash of the structured preview body; proves what the user was shown. */
  previewDigest: string;
  requestId?: string;
  userId?: string;
  channel?: string;
}

export interface TransactionPreview {
  network: PreviewNetwork;
  networkPassphrase: string;
  sourceAccount: string;
  /** Fee in stroops as a decimal string. */
  fee: string;
  feeXlm: string;
  sequence: string;
  memo: string | null;
  /** ISO timestamp; null when the transaction never expires. */
  validUntil: string | null;
  isFeeBump: boolean;
  feeSource?: string;
  operations: PreviewOperation[];
  riskFlags: RiskFlag[];
  riskLevel: RiskSeverity;
  intent: IntentComparison;
  decision: PreviewDecision;
  /** Short reason for the decision, suitable for showing to the user. */
  decisionReason: string;
  audit: PreviewAuditTrail;
}

export interface BuildPreviewInput {
  /** Base64 transaction envelope XDR. */
  xdr: string;
  networkPassphrase: string;
  intent?: TransactionIntent;
  requestId?: string;
  userId?: string;
  channel?: string;
  /** Override clock for deterministic tests. */
  now?: Date;
}
