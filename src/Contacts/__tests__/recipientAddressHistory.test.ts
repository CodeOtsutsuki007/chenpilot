import {
  RecipientGovernanceService,
  StaleRecipientApprovalError,
} from "../recipientGovernance.service";

const T0 = new Date("2026-11-23T09:00:00Z");
const T1 = new Date("2026-11-23T10:00:00Z");
const T2 = new Date("2026-11-23T11:00:00Z");
const T3 = new Date("2026-11-23T12:00:00Z");
const ADDR_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ADDR_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function setup() {
  const svc = new RecipientGovernanceService();
  const v1 = svc.createRecipient(
    { recipientId: "rcp-1", identityKey: "alice", address: ADDR_A, network: "testnet", actor: "user-1" },
    T0
  );
  svc.verifyRevision("rcp-1", v1.revisionId, T0, "verifier-1");
  return { svc, v1 };
}

const transfer = (revisionId: string, transferId = "tx-1") => ({
  transferId,
  recipientId: "rcp-1",
  revisionId,
  amount: "25",
  asset: "XLM",
});

import { auditLogService } from "../../AuditLog/auditLog.service";

describe("recipient address change history (#1104)", () => {
  beforeEach(() => {
    jest.spyOn(auditLogService, "log").mockImplementation(async () => ({ id: "mock-id" } as any));
  });
  it("records each address version with actor, time and verification status", () => {
    const { svc, v1 } = setup();
    const v2 = svc.updateRecipient({ recipientId: "rcp-1", address: ADDR_B, network: "testnet", actor: "user-2" }, T1);

    expect(svc.addressChanges("rcp-1")).toEqual([
      {
        recipientId: "rcp-1",
        fromVersion: null,
        toVersion: 1,
        fromAddress: null,
        toAddress: ADDR_A,
        network: "testnet",
        actor: "user-1",
        changedAt: T0.toISOString(),
        verificationStatus: "superseded",
      },
      {
        recipientId: "rcp-1",
        fromVersion: 1,
        toVersion: 2,
        fromAddress: ADDR_A,
        toAddress: ADDR_B,
        network: "testnet",
        actor: "user-2",
        changedAt: T1.toISOString(),
        verificationStatus: "pending_verification",
      },
    ]);

    const [old, current] = svc.history("rcp-1");
    expect(old).toMatchObject({
      revisionId: v1.revisionId,
      createdBy: "user-1",
      verifiedBy: "verifier-1",
      status: "superseded",
      supersededBy: "user-2",
      supersededAt: T1.toISOString(),
    });
    expect(current).toMatchObject({ revisionId: v2.revisionId, version: 2, createdBy: "user-2" });
    expect(auditLogService.log).toHaveBeenCalledWith(expect.objectContaining({
      action: "RECIPIENT_UPDATED",
      actor: "user-2",
    }));
  });

  it("audits recipient removal with actor and version details", () => {
    const { svc } = setup();
    svc.removeRecipient("rcp-1", "admin-user", T2);
    expect(auditLogService.log).toHaveBeenCalledWith(expect.objectContaining({
      action: "RECIPIENT_REMOVED",
      actor: "admin-user",
      metadata: expect.objectContaining({
        recipientId: "rcp-1",
        version: 1,
      }),
    }));
  });

  it("does not create a new version when the address is unchanged (boundary)", () => {
    const { svc, v1 } = setup();
    const same = svc.updateRecipient({ recipientId: "rcp-1", address: ADDR_A, network: "testnet", actor: "user-2" }, T1);

    expect(same.revisionId).toBe(v1.revisionId);
    expect(svc.addressChanges("rcp-1")).toHaveLength(1);
  });

  it("rejects an approval granted before the address changed", () => {
    const { svc, v1 } = setup();
    const approved = svc.prepareTransfer(transfer(v1.revisionId));
    expect(approved.approvedVersion).toBe(1);

    const v2 = svc.updateRecipient({ recipientId: "rcp-1", address: ADDR_B, network: "testnet", actor: "user-2" }, T1);
    svc.verifyRevision("rcp-1", v2.revisionId, T2, "verifier-1");

    expect(() => svc.submitTransfer(approved)).toThrow(StaleRecipientApprovalError);
    expect(() => svc.submitTransfer(approved)).toThrow(/version 1; current version is 2/);
  });

  it("rejects an old approval even when the address is changed back and re-verified", () => {
    const { svc, v1 } = setup();
    const approved = svc.prepareTransfer(transfer(v1.revisionId));

    svc.updateRecipient({ recipientId: "rcp-1", address: ADDR_B, network: "testnet", actor: "attacker" }, T1);
    const v3 = svc.updateRecipient({ recipientId: "rcp-1", address: ADDR_A, network: "testnet", actor: "user-1" }, T2);
    svc.verifyRevision("rcp-1", v3.revisionId, T3, "verifier-1");

    expect(v3.address).toBe(ADDR_A);
    expect(v3.version).toBe(3);
    expect(() => svc.submitTransfer(approved)).toThrow(StaleRecipientApprovalError);

    // A fresh approval for the current version is accepted.
    const reapproved = svc.prepareTransfer(transfer(v3.revisionId, "tx-2"));
    expect(svc.submitTransfer(reapproved).version).toBe(3);
  });

  it("refuses approval of an unverified new version and verification of a superseded one", () => {
    const { svc, v1 } = setup();
    const v2 = svc.updateRecipient({ recipientId: "rcp-1", address: ADDR_B, network: "testnet", actor: "user-2" }, T1);

    expect(() => svc.prepareTransfer(transfer(v2.revisionId))).toThrow(/must be verified/);
    expect(() => svc.verifyRevision("rcp-1", v1.revisionId, T2)).toThrow(/superseded/);
  });

  it("accepts an approval for the current verified version", () => {
    const { svc, v1 } = setup();
    const approved = svc.prepareTransfer(transfer(v1.revisionId));
    expect(svc.submitTransfer(approved)).toMatchObject({ version: 1, status: "verified" });
  });
});
