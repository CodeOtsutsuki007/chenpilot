import { PreviewNetwork, PreviewOperation, RiskFlag, RiskSeverity } from "./types";

/**
 * Risk rules for decoded previews. Each rule looks only at structured,
 * decoded data so the same transaction always produces the same warnings on
 * every surface.
 */

export const SEVERITY_ORDER: Record<RiskSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function maxSeverity(severities: RiskSeverity[]): RiskSeverity {
  return severities.reduce<RiskSeverity>(
    (max, s) => (SEVERITY_ORDER[s] > SEVERITY_ORDER[max] ? s : max),
    "info"
  );
}

/** Fee per operation above this (in stroops) is flagged: 0.1 XLM. */
export const HIGH_FEE_PER_OPERATION_STROOPS = 1_000_000;

/** Operation types an issuer uses against holders; never expected from a user wallet flow. */
const ISSUER_CONTROL_OPERATIONS = new Set([
  "allowTrust",
  "setTrustLineFlags",
  "clawback",
  "clawbackClaimableBalance",
]);

export function assessOperation(op: PreviewOperation): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const flag = (code: string, severity: RiskSeverity, message: string) =>
    flags.push({ code, severity, message, operationIndex: op.index });

  if (op.foreignSource) {
    flag(
      "FOREIGN_SOURCE_ACCOUNT",
      "high",
      `Operation ${op.index + 1} acts on a different account (${op.sourceAccount}) than the one paying for the transaction.`
    );
  }

  switch (op.type) {
    case "accountMerge":
      flag(
        "ACCOUNT_MERGE",
        "critical",
        `This closes the account and transfers ALL of its XLM to ${op.destination}. This cannot be undone.`
      );
      break;

    case "setOptions": {
      const d = op.details;
      if (typeof d.signerWeight === "number" && d.signerWeight > 0) {
        flag(
          "SIGNER_ADDED",
          "critical",
          `Adds ${d.signerKey} as a signer. Whoever controls that key can move your funds.`
        );
      } else if (d.signerKey !== undefined) {
        flag("SIGNER_REMOVED", "high", `Removes signer ${d.signerKey} from the account.`);
      }
      if (d.masterWeight === 0) {
        flag(
          "MASTER_KEY_DISABLED",
          "critical",
          "Disables the account's master key. You may permanently lose control of this account."
        );
      }
      if (["lowThreshold", "medThreshold", "highThreshold"].some((t) => d[t] !== undefined)) {
        flag("THRESHOLDS_CHANGED", "high", "Changes the signature thresholds that protect this account.");
      }
      if (d.setFlags !== undefined || d.clearFlags !== undefined) {
        flag("ACCOUNT_FLAGS_CHANGED", "high", "Changes account authorization flags.");
      }
      if (d.homeDomain !== undefined || d.inflationDest !== undefined) {
        flag("ACCOUNT_METADATA_CHANGED", "medium", "Changes account metadata (home domain or inflation destination).");
      }
      break;
    }

    case "invokeHostFunction":
      flag(
        "OPAQUE_CONTRACT_CALL",
        "high",
        `Calls a smart contract${op.details.contract ? ` (${op.details.contract})` : ""}. Its full effects cannot be decoded from the transaction alone.`
      );
      if (typeof op.details.authEntries === "number" && op.details.authEntries > 0) {
        flag("CONTRACT_AUTH_GRANTED", "high", `Grants the contract ${op.details.authEntries} authorization(s) on your behalf.`);
      }
      break;

    case "changeTrust":
      if (op.details.removing) {
        flag("TRUSTLINE_REMOVED", "medium", `Removes the trustline for ${op.asset}.`);
      } else {
        flag("NEW_TRUSTLINE", "low", `Allows your account to hold ${op.asset}. Verify the issuer is the one you expect.`);
      }
      break;

    case "manageData":
      flag("ACCOUNT_DATA_WRITE", "medium", `Writes data entry "${op.details.name}" to your account.`);
      break;

    case "beginSponsoringFutureReserves":
    case "createClaimableBalance":
      flag("FUNDS_LOCKED", "medium", "Locks funds or reserves for another account.");
      break;

    case "bumpSequence":
      flag("SEQUENCE_BUMP", "medium", "Changes the account sequence number, which invalidates other pending transactions.");
      break;

    default:
      if (ISSUER_CONTROL_OPERATIONS.has(op.type)) {
        flag("ISSUER_CONTROL_OPERATION", "high", `"${op.type}" is an asset-issuer control operation.`);
      } else if (op.type.startsWith("revoke")) {
        flag("SPONSORSHIP_REVOKED", "medium", "Revokes a reserve sponsorship.");
      } else if (op.summary.startsWith("Unrecognized operation")) {
        flag("UNRECOGNIZED_OPERATION", "high", `Operation type "${op.type}" could not be decoded.`);
      }
  }

  if (op.movesValue && op.destination && op.destination === op.sourceAccount) {
    flag("SELF_TRANSFER", "info", "Funds are sent back to the same account.");
  }

  return flags;
}

export interface EnvelopeRiskInput {
  network: PreviewNetwork;
  feeStroops: bigint;
  operationCount: number;
  validUntil: string | null;
}

export function assessEnvelope(input: EnvelopeRiskInput): RiskFlag[] {
  const flags: RiskFlag[] = [];

  if (input.network === "unknown") {
    flags.push({
      code: "UNKNOWN_NETWORK",
      severity: "high",
      message: "The transaction targets an unrecognized network.",
    });
  } else if (input.network === "public") {
    flags.push({
      code: "MAINNET",
      severity: "info",
      message: "This transaction uses real funds on the Stellar public network.",
    });
  }

  const ops = BigInt(Math.max(1, input.operationCount));
  if (input.feeStroops / ops > BigInt(HIGH_FEE_PER_OPERATION_STROOPS)) {
    flags.push({
      code: "HIGH_FEE",
      severity: "medium",
      message: "The maximum fee is unusually high for this transaction.",
    });
  }

  if (input.validUntil === null) {
    flags.push({
      code: "NO_EXPIRY",
      severity: "low",
      message: "This transaction never expires; it can be submitted at any time once signed.",
    });
  }

  return flags;
}
