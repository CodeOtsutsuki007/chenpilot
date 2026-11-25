import {
  RecipientGovernanceService,
  RecipientRevocationError,
  StaleRecipientApprovalError,
} from "../recipientGovernance.service";

const T0 = new Date("2026-11-23T09:00:00Z");
const T1 = new Date("2026-11-23T10:00:00Z");
const ADDR_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("Recipient approval revocation (#1104 / payments revocation)", () => {
  it("successfully revokes a verified recipient approval without deleting history", () => {
    const svc = new RecipientGovernanceService();
    const v1 = svc.createRecipient(
      { recipientId: "rcp-rev-1", identityKey: "bob", address: ADDR_A, network: "stellar:testnet", actor: "user-1" },
      T0
    );
    svc.verifyRevision("rcp-rev-1", v1.revisionId, T0, "verifier-1");

    const revoked = svc.revokeRecipientApproval({
      recipientId: "rcp-rev-1",
      revisionId: v1.revisionId,
      actor: "admin-1",
      reason: "Security audit policy update",
    }, T1);

    expect(revoked.status).toBe("revoked");
    expect(revoked.supersededBy).toBe("admin-1");

    // Verify history is fully preserved
    const history = svc.history("rcp-rev-1");
    expect(history.length).toBe(1);
    expect(history[0].status).toBe("revoked");

    // Verify transfers preparing against this revoked revision throw StaleRecipientApprovalError
    expect(() => {
      svc.prepareTransfer({
        recipientId: "rcp-rev-1",
        revisionId: v1.revisionId,
        address: ADDR_A,
        network: "stellar:testnet",
        amount: "10",
        asset: "XLM",
      });
    }).toThrow(StaleRecipientApprovalError);
  });

  it("fails with not_found when recipient or revision does not exist", () => {
    const svc = new RecipientGovernanceService();
    expect(() => {
      svc.revokeRecipientApproval({
        recipientId: "non-existent",
        actor: "admin-1",
      });
    }).toThrow(RecipientRevocationError);

    const v1 = svc.createRecipient(
      { recipientId: "rcp-rev-2", identityKey: "charlie", address: ADDR_A, network: "stellar:testnet", actor: "user-1" },
      T0
    );

    expect(() => {
      svc.revokeRecipientApproval({
        recipientId: "rcp-rev-2",
        revisionId: "non-existent-rev",
        actor: "admin-1",
      });
    }).toThrow(RecipientRevocationError);
  });

  it("fails with already_revoked when attempting to revoke an already revoked or superseded revision", () => {
    const svc = new RecipientGovernanceService();
    const v1 = svc.createRecipient(
      { recipientId: "rcp-rev-3", identityKey: "dave", address: ADDR_A, network: "stellar:testnet", actor: "user-1" },
      T0
    );
    svc.verifyRevision("rcp-rev-3", v1.revisionId, T0, "verifier-1");

    svc.revokeRecipientApproval({
      recipientId: "rcp-rev-3",
      revisionId: v1.revisionId,
      actor: "admin-1",
    }, T1);

    expect(() => {
      svc.revokeRecipientApproval({
        recipientId: "rcp-rev-3",
        revisionId: v1.revisionId,
        actor: "admin-2",
      }, T1);
    }).toThrow(RecipientRevocationError);
  });
});
