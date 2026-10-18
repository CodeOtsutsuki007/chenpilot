import { RiskSeverity, TransactionPreview } from "./types";

/**
 * Single text renderer for transaction previews. Bot replies and the web UI's
 * plain-text fallback both call this, so a given preview reads identically on
 * every surface. Rich UIs should render from the structured preview and use
 * `severityLabel` for consistent wording.
 */

const SEVERITY_LABEL: Record<RiskSeverity, string> = {
  info: "ℹ️ Info",
  low: "🔹 Low",
  medium: "⚠️ Medium",
  high: "🚨 HIGH",
  critical: "⛔ CRITICAL",
};

export function severityLabel(severity: RiskSeverity): string {
  return SEVERITY_LABEL[severity];
}

const NETWORK_LABEL: Record<TransactionPreview["network"], string> = {
  public: "Stellar Mainnet (real funds)",
  testnet: "Stellar Testnet",
  futurenet: "Stellar Futurenet",
  unknown: "UNKNOWN NETWORK",
};

// Strip control and bidi-override characters an attacker could use to
// disguise memos, data names or asset codes in chat clients.
const UNSAFE_CHARS = new RegExp(
  // eslint-disable-next-line no-control-regex
  "[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]",
  "g"
);

export function sanitizeForDisplay(value: string): string {
  return value.replace(UNSAFE_CHARS, "\uFFFD");
}

export interface RenderOptions {
  /** Omit info-level flags (e.g. for compact chat replies). Default false. */
  hideInfo?: boolean;
}

export function renderPreviewText(preview: TransactionPreview, options: RenderOptions = {}): string {
  const lines: string[] = [];

  const header =
    preview.decision === "refuse"
      ? "⛔ TRANSACTION BLOCKED"
      : preview.decision === "confirm_with_warning"
        ? "🚨 REVIEW CAREFULLY BEFORE APPROVING"
        : "📝 Transaction preview";
  lines.push(header, "");

  lines.push(`Network: ${NETWORK_LABEL[preview.network]}`);
  lines.push(`Account: ${preview.sourceAccount}`);
  if (preview.isFeeBump && preview.feeSource) lines.push(`Fee paid by: ${preview.feeSource}`);
  lines.push(`Max fee: ${preview.feeXlm} XLM`);
  if (preview.memo !== null) lines.push(`Memo: ${sanitizeForDisplay(preview.memo)}`);
  lines.push(`Expires: ${preview.validUntil ?? "never"}`);
  lines.push("");

  lines.push(`Actions (${preview.operations.length}):`);
  for (const op of preview.operations) {
    lines.push(`${op.index + 1}. ${sanitizeForDisplay(op.summary)}`);
  }

  const flags = preview.riskFlags.filter((f) => !(options.hideInfo && f.severity === "info"));
  if (flags.length) {
    lines.push("", "Warnings:");
    for (const f of flags) {
      const where = f.operationIndex !== undefined ? ` (action ${f.operationIndex + 1})` : "";
      lines.push(`${severityLabel(f.severity)}${where}: ${sanitizeForDisplay(f.message)}`);
    }
  }

  if (preview.intent.compared) {
    lines.push("", preview.intent.matches ? "✅ Matches your request." : "❌ Does NOT match your request.");
  }

  lines.push("", `Decision: ${preview.decisionReason}`);
  lines.push(`Preview ID: ${preview.audit.previewId}`);
  lines.push(`Tx hash: ${preview.audit.transactionHash}`);

  return lines.join("\n");
}
