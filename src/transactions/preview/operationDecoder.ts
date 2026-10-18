import * as StellarSdk from "@stellar/stellar-sdk";
import { PreviewOperation } from "./types";

/**
 * Turns decoded Stellar operations into structured, human-readable preview
 * entries. Only fields read from the decoded XDR are used — nothing here
 * trusts agent-supplied descriptions.
 */

type Field = string | number | boolean | null;
type RawOperation = Record<string, unknown> & { type: string; source?: string };

interface AssetLike {
  isNative?: () => boolean;
  getCode?: () => string;
  getIssuer?: () => string;
  assetA?: AssetLike;
  assetB?: AssetLike;
}

/** "XLM" for the native asset, "CODE:ISSUER" otherwise. */
export function formatAsset(asset: unknown): string {
  const a = asset as AssetLike | undefined;
  if (!a) return "unknown asset";
  if (a.assetA && a.assetB) {
    return `liquidity pool ${formatAsset(a.assetA)} / ${formatAsset(a.assetB)}`;
  }
  if (a.isNative?.()) return "XLM";
  if (a.getCode && a.getIssuer) return `${a.getCode()}:${a.getIssuer()}`;
  return "unknown asset";
}

/** Asset code only, for compact summaries. Issuer is always kept in `asset`. */
function assetCode(asset: unknown): string {
  const formatted = formatAsset(asset);
  return formatted.split(":")[0];
}

function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function signerDescription(signer: Record<string, unknown>): { key: string; kind: string } {
  if (signer.ed25519PublicKey) return { key: String(signer.ed25519PublicKey), kind: "account" };
  if (signer.sha256Hash) return { key: Buffer.from(signer.sha256Hash as Uint8Array).toString("hex"), kind: "hash" };
  if (signer.preAuthTx) return { key: Buffer.from(signer.preAuthTx as Uint8Array).toString("hex"), kind: "pre-authorized tx" };
  if (signer.ed25519SignedPayload) return { key: String(signer.ed25519SignedPayload), kind: "signed payload" };
  return { key: "unknown", kind: "unknown" };
}

function describeHostFunction(func: unknown): Record<string, Field> {
  const fn = func as { switch?: () => { name: string }; invokeContract?: () => unknown } | undefined;
  const kind = fn?.switch?.().name ?? "unknown";
  const details: Record<string, Field> = { hostFunction: kind };

  if (kind === "hostFunctionTypeInvokeContract" && fn?.invokeContract) {
    try {
      const args = fn.invokeContract() as {
        contractAddress: () => StellarSdk.xdr.ScAddress;
        functionName: () => Buffer | string;
        args: () => unknown[];
      };
      details.contract = StellarSdk.Address.fromScAddress(args.contractAddress()).toString();
      details.function = args.functionName().toString();
      details.argumentCount = args.args().length;
    } catch {
      details.contract = "undecodable";
    }
  }
  return details;
}

export function decodeOperation(
  operation: StellarSdk.Operation,
  index: number,
  transactionSource: string
): PreviewOperation {
  const op = operation as unknown as RawOperation;
  const sourceAccount = op.source ?? transactionSource;
  const base = {
    index,
    type: op.type,
    sourceAccount,
    foreignSource: sourceAccount !== transactionSource,
    movesValue: false,
    details: {} as Record<string, Field>,
  };

  switch (op.type) {
    case "payment": {
      const asset = formatAsset(op.asset);
      const amount = str(op.amount);
      const destination = str(op.destination);
      return {
        ...base,
        movesValue: true,
        asset,
        amount,
        destination,
        summary: `Send ${amount} ${assetCode(op.asset)} to ${destination}`,
      };
    }

    case "createAccount": {
      const amount = str(op.startingBalance);
      const destination = str(op.destination);
      return {
        ...base,
        movesValue: true,
        asset: "XLM",
        amount,
        destination,
        summary: `Create account ${destination} funded with ${amount} XLM`,
      };
    }

    case "pathPaymentStrictSend": {
      const amount = str(op.sendAmount);
      const destination = str(op.destination);
      return {
        ...base,
        movesValue: true,
        asset: formatAsset(op.sendAsset),
        amount,
        destination,
        details: {
          receiveAsset: formatAsset(op.destAsset),
          minimumReceived: str(op.destMin) ?? null,
          hops: Array.isArray(op.path) ? op.path.length : 0,
        },
        summary: `Swap-send ${amount} ${assetCode(op.sendAsset)} for at least ${str(op.destMin)} ${assetCode(op.destAsset)}, delivered to ${destination}`,
      };
    }

    case "pathPaymentStrictReceive": {
      const amount = str(op.sendMax);
      const destination = str(op.destination);
      return {
        ...base,
        movesValue: true,
        asset: formatAsset(op.sendAsset),
        amount,
        destination,
        details: {
          receiveAsset: formatAsset(op.destAsset),
          receiveAmount: str(op.destAmount) ?? null,
          hops: Array.isArray(op.path) ? op.path.length : 0,
        },
        summary: `Spend up to ${amount} ${assetCode(op.sendAsset)} so ${destination} receives ${str(op.destAmount)} ${assetCode(op.destAsset)}`,
      };
    }

    case "manageSellOffer":
    case "createPassiveSellOffer": {
      const amount = str(op.amount);
      const isCancel = amount !== undefined && Number(amount) === 0;
      return {
        ...base,
        movesValue: !isCancel,
        asset: formatAsset(op.selling),
        amount,
        details: { buying: formatAsset(op.buying), price: str(op.price) ?? null, offerId: str(op.offerId) ?? null },
        summary: isCancel
          ? `Cancel offer ${str(op.offerId)}`
          : `Offer to sell ${amount} ${assetCode(op.selling)} for ${assetCode(op.buying)} at price ${str(op.price)}`,
      };
    }

    case "manageBuyOffer": {
      const amount = str(op.buyAmount);
      const isCancel = amount !== undefined && Number(amount) === 0;
      return {
        ...base,
        movesValue: !isCancel,
        asset: formatAsset(op.selling),
        details: { buying: formatAsset(op.buying), buyAmount: amount ?? null, price: str(op.price) ?? null, offerId: str(op.offerId) ?? null },
        summary: isCancel
          ? `Cancel offer ${str(op.offerId)}`
          : `Offer to buy ${amount} ${assetCode(op.buying)} paying with ${assetCode(op.selling)} at price ${str(op.price)}`,
      };
    }

    case "changeTrust": {
      const limit = str(op.limit);
      const asset = formatAsset(op.line);
      const removing = limit !== undefined && Number(limit) === 0;
      return {
        ...base,
        asset,
        details: { limit: limit ?? null, removing },
        summary: removing ? `Remove trustline for ${asset}` : `Trust asset ${asset} (limit ${limit})`,
      };
    }

    case "setOptions": {
      const details: Record<string, Field> = {};
      const parts: string[] = [];
      if (op.signer) {
        const signer = op.signer as Record<string, unknown>;
        const { key, kind } = signerDescription(signer);
        const weight = Number(signer.weight ?? 0);
        details.signerKey = key;
        details.signerKind = kind;
        details.signerWeight = weight;
        parts.push(weight === 0 ? `remove signer ${key}` : `ADD ${kind} signer ${key} with weight ${weight}`);
      }
      for (const field of ["masterWeight", "lowThreshold", "medThreshold", "highThreshold"] as const) {
        if (op[field] !== undefined) {
          details[field] = Number(op[field]);
          parts.push(`set ${field} to ${op[field]}`);
        }
      }
      if (op.homeDomain !== undefined) {
        details.homeDomain = String(op.homeDomain);
        parts.push(`set home domain to "${op.homeDomain}"`);
      }
      if (op.inflationDest !== undefined) {
        details.inflationDest = String(op.inflationDest);
        parts.push(`set inflation destination to ${op.inflationDest}`);
      }
      if (op.setFlags !== undefined) {
        details.setFlags = Number(op.setFlags);
        parts.push(`set account flags ${op.setFlags}`);
      }
      if (op.clearFlags !== undefined) {
        details.clearFlags = Number(op.clearFlags);
        parts.push(`clear account flags ${op.clearFlags}`);
      }
      return {
        ...base,
        details,
        summary: parts.length ? `Change account settings: ${parts.join("; ")}` : "Change account settings (no-op)",
      };
    }

    case "accountMerge": {
      const destination = str(op.destination);
      return {
        ...base,
        movesValue: true,
        asset: "XLM",
        destination,
        summary: `CLOSE account ${sourceAccount} and send its entire XLM balance to ${destination}`,
      };
    }

    case "manageData": {
      const name = str(op.name) ?? "";
      const deleting = op.value === undefined || op.value === null;
      return {
        ...base,
        details: { name, deleting },
        summary: deleting ? `Delete account data entry "${name}"` : `Write account data entry "${name}"`,
      };
    }

    case "bumpSequence":
      return { ...base, details: { bumpTo: str(op.bumpTo) ?? null }, summary: `Bump account sequence to ${str(op.bumpTo)}` };

    case "createClaimableBalance": {
      const claimants = Array.isArray(op.claimants) ? op.claimants : [];
      const amount = str(op.amount);
      return {
        ...base,
        movesValue: true,
        asset: formatAsset(op.asset),
        amount,
        details: { claimants: claimants.length },
        summary: `Lock ${amount} ${assetCode(op.asset)} in a claimable balance for ${claimants.length} claimant(s)`,
      };
    }

    case "claimClaimableBalance":
      return { ...base, details: { balanceId: str(op.balanceId) ?? null }, summary: `Claim claimable balance ${str(op.balanceId)}` };

    case "allowTrust":
      return {
        ...base,
        details: { trustor: str(op.trustor) ?? null, assetCode: str(op.assetCode) ?? null, authorize: str(op.authorize) ?? null },
        summary: `Change trust authorization of ${str(op.trustor)} for ${str(op.assetCode)}`,
      };

    case "setTrustLineFlags":
      return {
        ...base,
        asset: formatAsset(op.asset),
        details: { trustor: str(op.trustor) ?? null },
        summary: `Change trustline flags of ${str(op.trustor)} for ${formatAsset(op.asset)}`,
      };

    case "clawback":
      return {
        ...base,
        asset: formatAsset(op.asset),
        amount: str(op.amount),
        details: { from: str(op.from) ?? null },
        summary: `Claw back ${str(op.amount)} ${assetCode(op.asset)} from ${str(op.from)}`,
      };

    case "clawbackClaimableBalance":
      return { ...base, details: { balanceId: str(op.balanceId) ?? null }, summary: `Claw back claimable balance ${str(op.balanceId)}` };

    case "beginSponsoringFutureReserves":
      return {
        ...base,
        details: { sponsoredId: str(op.sponsoredId) ?? null },
        summary: `Start paying reserves for account ${str(op.sponsoredId)}`,
      };

    case "endSponsoringFutureReserves":
      return { ...base, summary: "Stop sponsoring reserves" };

    case "liquidityPoolDeposit":
      return {
        ...base,
        movesValue: true,
        details: {
          liquidityPoolId: str(op.liquidityPoolId) ?? null,
          maxAmountA: str(op.maxAmountA) ?? null,
          maxAmountB: str(op.maxAmountB) ?? null,
        },
        summary: `Deposit up to ${str(op.maxAmountA)} / ${str(op.maxAmountB)} into liquidity pool ${str(op.liquidityPoolId)}`,
      };

    case "liquidityPoolWithdraw":
      return {
        ...base,
        details: { liquidityPoolId: str(op.liquidityPoolId) ?? null, shares: str(op.amount) ?? null },
        summary: `Withdraw ${str(op.amount)} pool shares from liquidity pool ${str(op.liquidityPoolId)}`,
      };

    case "invokeHostFunction": {
      const details = describeHostFunction(op.func);
      const authEntries = Array.isArray(op.auth) ? op.auth.length : 0;
      details.authEntries = authEntries;
      const target = details.contract ? `${details.function ?? "unknown"} on contract ${details.contract}` : String(details.hostFunction);
      return {
        ...base,
        details,
        summary: `Call smart contract: ${target}`,
      };
    }

    case "extendFootprintTtl":
      return { ...base, details: { extendTo: str(op.extendTo) ?? null }, summary: `Extend contract storage lifetime by ${str(op.extendTo)} ledgers` };

    case "restoreFootprint":
      return { ...base, summary: "Restore archived contract storage" };

    default:
      if (op.type.startsWith("revoke")) {
        return { ...base, summary: "Revoke a reserve sponsorship" };
      }
      return { ...base, summary: `Unrecognized operation "${op.type}"` };
  }
}
