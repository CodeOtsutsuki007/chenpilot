jest.unmock("@stellar/stellar-sdk");
jest.unmock("stellar-sdk");

import * as StellarSdk from "@stellar/stellar-sdk";
import {
  buildTransactionPreview,
  recordPreviewAudit,
  renderPreviewText,
  sanitizeForDisplay,
  toStroops,
} from "..";
import { ExecutionAction } from "../../../AuditLog/auditEvent.types";
import { XdrSecurityError } from "../../../utils/xdr";
import { isConfirmed, previewToReply } from "../../../../packages/bot/src/transactionPreview";

const TESTNET = StellarSdk.Networks.TESTNET;
const source = StellarSdk.Keypair.random();
const recipient = StellarSdk.Keypair.random().publicKey();
const attacker = StellarSdk.Keypair.random().publicKey();
const issuer = StellarSdk.Keypair.random().publicKey();
const USDC = new StellarSdk.Asset("USDC", issuer);
const CONTRACT_ID = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 7));

function buildXdr(
  ops: StellarSdk.xdr.Operation[],
  opts: { fee?: string; timeout?: number; memo?: StellarSdk.Memo; network?: string } = {}
): string {
  const account = new StellarSdk.Account(source.publicKey(), "100");
  const builder = new StellarSdk.TransactionBuilder(account, {
    fee: opts.fee ?? "100",
    networkPassphrase: opts.network ?? TESTNET,
  });
  ops.forEach((op) => builder.addOperation(op));
  if (opts.memo) builder.addMemo(opts.memo);
  if (opts.timeout === 0) builder.setTimeout(StellarSdk.TimeoutInfinite);
  else builder.setTimeout(opts.timeout ?? 300);
  return builder.build().toXDR();
}

const payment = (destination = recipient, amount = "10", asset = StellarSdk.Asset.native()) =>
  StellarSdk.Operation.payment({ destination, asset, amount });

describe("buildTransactionPreview", () => {
  it("decodes a simple payment into a readable, structured preview", () => {
    const preview = buildTransactionPreview({
      xdr: buildXdr([payment()]),
      networkPassphrase: TESTNET,
      intent: { operationTypes: ["payment"], asset: "XLM", amount: "10", destination: recipient },
    });

    expect(preview.network).toBe("testnet");
    expect(preview.sourceAccount).toBe(source.publicKey());
    expect(preview.operations).toHaveLength(1);
    expect(preview.operations[0]).toMatchObject({
      type: "payment",
      asset: "XLM",
      amount: "10.0000000",
      destination: recipient,
      movesValue: true,
    });
    expect(preview.operations[0].summary).toBe(`Send 10.0000000 XLM to ${recipient}`);
    expect(preview.intent).toEqual({ compared: true, matches: true, mismatches: [] });
    expect(preview.decision).toBe("proceed");
  });

  it("refuses when the payment destination differs from the user's request", () => {
    const preview = buildTransactionPreview({
      xdr: buildXdr([payment(attacker)]),
      networkPassphrase: TESTNET,
      intent: { destination: recipient, amount: "10" },
    });

    expect(preview.intent.matches).toBe(false);
    expect(preview.intent.mismatches[0]).toMatchObject({ field: "destination", actual: attacker, severity: "critical" });
    expect(preview.decision).toBe("refuse");
  });

  it("requires explicit confirmation when the total amount exceeds the request", () => {
    const preview = buildTransactionPreview({
      xdr: buildXdr([payment(recipient, "6"), payment(recipient, "6")]),
      networkPassphrase: TESTNET,
      intent: { operationTypes: ["payment"], amount: "10", destination: recipient },
    });

    expect(preview.intent.mismatches).toEqual([
      expect.objectContaining({ field: "amount", expected: "10", actual: "12" }),
    ]);
    expect(preview.decision).toBe("confirm_with_warning");
  });

  it("flags asset issuer and code mismatches", () => {
    const fakeUsdc = new StellarSdk.Asset("USDC", attacker);
    const preview = buildTransactionPreview({
      xdr: buildXdr([payment(recipient, "5", fakeUsdc)]),
      networkPassphrase: TESTNET,
      intent: { asset: `USDC:${issuer}` },
    });
    expect(preview.intent.mismatches[0]).toMatchObject({ field: "asset" });
    expect(preview.decision).toBe("confirm_with_warning");

    const codeOnly = buildTransactionPreview({
      xdr: buildXdr([payment(recipient, "5", fakeUsdc)]),
      networkPassphrase: TESTNET,
      intent: { asset: "USDC" },
    });
    expect(codeOnly.intent.matches).toBe(true);
  });

  it("refuses undeclared account takeover operations (signer added, master key disabled)", () => {
    const preview = buildTransactionPreview({
      xdr: buildXdr([
        payment(),
        StellarSdk.Operation.setOptions({ signer: { ed25519PublicKey: attacker, weight: 1 }, masterWeight: 0 }),
      ]),
      networkPassphrase: TESTNET,
      intent: { operationTypes: ["payment"] },
    });

    const codes = preview.riskFlags.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["SIGNER_ADDED", "MASTER_KEY_DISABLED", "INTENT_OPERATIONTYPE_MISMATCH"]));
    expect(preview.riskLevel).toBe("critical");
    expect(preview.decision).toBe("refuse");
  });

  it("downgrades critical operations the user explicitly asked for to a warning", () => {
    const preview = buildTransactionPreview({
      xdr: buildXdr([StellarSdk.Operation.accountMerge({ destination: recipient })]),
      networkPassphrase: TESTNET,
      intent: { operationTypes: ["accountMerge"], destination: recipient },
    });
    expect(preview.riskFlags.map((f) => f.code)).toContain("ACCOUNT_MERGE");
    expect(preview.decision).toBe("confirm_with_warning");
  });

  it("refuses account merge without an intent", () => {
    const preview = buildTransactionPreview({
      xdr: buildXdr([StellarSdk.Operation.accountMerge({ destination: attacker })]),
      networkPassphrase: TESTNET,
    });
    expect(preview.intent.compared).toBe(false);
    expect(preview.decision).toBe("refuse");
    expect(preview.operations[0].summary).toContain("CLOSE account");
  });

  it("flags operations acting on a foreign source account", () => {
    const preview = buildTransactionPreview({
      xdr: buildXdr([StellarSdk.Operation.payment({ destination: recipient, asset: USDC, amount: "1", source: attacker })]),
      networkPassphrase: TESTNET,
    });
    expect(preview.operations[0].foreignSource).toBe(true);
    expect(preview.riskFlags.map((f) => f.code)).toContain("FOREIGN_SOURCE_ACCOUNT");
    expect(preview.decision).toBe("confirm_with_warning");
  });

  it("reports network context, fees, expiry and memo", () => {
    const preview = buildTransactionPreview({
      xdr: buildXdr([payment()], {
        fee: "5000000",
        timeout: 0,
        memo: StellarSdk.Memo.text("invoice-42"),
        network: StellarSdk.Networks.PUBLIC,
      }),
      networkPassphrase: StellarSdk.Networks.PUBLIC,
    });

    expect(preview.network).toBe("public");
    expect(preview.feeXlm).toBe("0.5");
    expect(preview.memo).toBe("invoice-42");
    expect(preview.validUntil).toBeNull();
    expect(preview.riskFlags.map((f) => f.code)).toEqual(expect.arrayContaining(["MAINNET", "HIGH_FEE", "NO_EXPIRY"]));
  });

  it("refuses when the network differs from the intent", () => {
    const preview = buildTransactionPreview({
      xdr: buildXdr([payment()], { network: StellarSdk.Networks.PUBLIC }),
      networkPassphrase: StellarSdk.Networks.PUBLIC,
      intent: { network: "testnet" },
    });
    expect(preview.decision).toBe("refuse");
  });

  it("decodes trustline, data and contract operations with warnings", () => {
    const preview = buildTransactionPreview({
      xdr: buildXdr([
        StellarSdk.Operation.changeTrust({ asset: USDC }),
        StellarSdk.Operation.manageData({ name: "note", value: "hello" }),
        StellarSdk.Operation.invokeContractFunction({ contract: CONTRACT_ID, function: "transfer", args: [] }),
      ]),
      networkPassphrase: TESTNET,
    });
    expect(preview.operations.map((o) => o.type)).toEqual(["changeTrust", "manageData", "invokeHostFunction"]);
    expect(preview.operations[2].details).toMatchObject({ contract: CONTRACT_ID, function: "transfer", argumentCount: 0 });
    expect(preview.operations[2].summary).toBe(`Call smart contract: transfer on contract ${CONTRACT_ID}`);
    expect(preview.riskFlags.map((f) => f.code)).toEqual(
      expect.arrayContaining(["NEW_TRUSTLINE", "ACCOUNT_DATA_WRITE", "OPAQUE_CONTRACT_CALL"])
    );
  });

  it("produces a stable audit trail linking intent and preview", () => {
    const xdr = buildXdr([payment()]);
    const intent = { destination: recipient, amount: "10" };
    const a = buildTransactionPreview({ xdr, networkPassphrase: TESTNET, intent, requestId: "req-1", userId: "u1", channel: "bot" });
    const b = buildTransactionPreview({ xdr, networkPassphrase: TESTNET, intent, channel: "ui" });

    expect(a.audit.transactionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.audit.transactionHash).toBe(b.audit.transactionHash);
    expect(a.audit.intentDigest).toBe(b.audit.intentDigest);
    // Same transaction → same preview body on every channel.
    expect(a.audit.previewDigest).toBe(b.audit.previewDigest);
    expect(a.audit.previewId).not.toBe(b.audit.previewId);
    expect(a.audit).toMatchObject({ requestId: "req-1", userId: "u1", channel: "bot" });
  });

  it("rejects undecodable payloads instead of showing them", () => {
    expect(() => buildTransactionPreview({ xdr: "not-xdr!!", networkPassphrase: TESTNET })).toThrow(XdrSecurityError);
  });
});

describe("renderPreviewText", () => {
  it("renders the same text for the same preview, with blocked header on refusal", () => {
    const preview = buildTransactionPreview({
      xdr: buildXdr([StellarSdk.Operation.accountMerge({ destination: attacker })]),
      networkPassphrase: TESTNET,
    });
    const text = renderPreviewText(preview);
    expect(text).toBe(renderPreviewText(preview));
    expect(text.startsWith("⛔ TRANSACTION BLOCKED")).toBe(true);
    expect(text).toContain("⛔ CRITICAL (action 1)");
    expect(text).toContain(attacker);
  });

  it("strips bidi-override and control characters from untrusted strings", () => {
    expect(sanitizeForDisplay("pay‮evil\u0007")).toBe("pay�evil�");
  });
});

describe("toStroops", () => {
  it("parses decimals exactly and rejects garbage", () => {
    expect(toStroops("1.5")).toBe(BigInt(15_000_000));
    expect(toStroops("0.0000001")).toBe(BigInt(1));
    expect(() => toStroops("1e5")).toThrow();
  });
});

describe("recordPreviewAudit", () => {
  it("records digests and decisions without the raw envelope", async () => {
    const xdr = buildXdr([StellarSdk.Operation.accountMerge({ destination: attacker })]);
    const preview = buildTransactionPreview({ xdr, networkPassphrase: TESTNET, userId: "u1" });
    const logEvent = jest.fn().mockResolvedValue(undefined);

    await recordPreviewAudit(preview, { logEvent });

    const event = logEvent.mock.calls[0][0];
    expect(event.action).toBe(ExecutionAction.TRANSACTION_PREVIEW_REFUSED);
    expect(event.success).toBe(false);
    expect(event.metadata.riskCodes).toContain("ACCOUNT_MERGE");
    expect(JSON.stringify(event)).not.toContain(xdr);
  });
});

describe("bot preview flow", () => {
  const toResponse = (xdr: string, intent?: Parameters<typeof buildTransactionPreview>[0]["intent"]) => {
    const preview = buildTransactionPreview({ xdr, networkPassphrase: TESTNET, intent, channel: "bot" });
    return { success: true, preview, text: renderPreviewText(preview) };
  };

  it("uses the backend's canonical text and blocks refused transactions", () => {
    const response = toResponse(buildXdr([payment(attacker)]), { destination: recipient });
    const result = previewToReply(response);
    expect(result.blocked).toBe(true);
    expect(result.reply.text).toBe(response.text);
  });

  it("requires an exact confirmation phrase for high-risk previews", () => {
    const response = toResponse(buildXdr([payment(recipient, "20")]), { amount: "10" });
    const result = previewToReply(response);
    expect(result.blocked).toBe(false);
    const phrase = result.pending!.confirmationPhrase!;
    expect(phrase).toMatch(/^CONFIRM [0-9A-F]{6}$/);
    expect(isConfirmed(result.pending!, "yes")).toBe(false);
    expect(isConfirmed(result.pending!, phrase.toLowerCase())).toBe(true);
  });

  it("uses a normal yes/no for low-risk previews and blocks unverifiable responses", () => {
    const ok = previewToReply(toResponse(buildXdr([payment()]), { destination: recipient, amount: "10" }));
    expect(ok.pending?.confirmationPhrase).toBeUndefined();
    expect(isConfirmed(ok.pending!, "yes")).toBe(true);

    expect(previewToReply({ success: false, message: "bad" }).blocked).toBe(true);
  });
});
