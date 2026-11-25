# Recipient Address Change History (#1104)

`RecipientGovernanceService` (`src/Contacts/recipientGovernance.service.ts`)
keeps one **address version** per change to a financial recipient.

## What is recorded

Each version (`history(recipientId)`) has:
- `version` and `revisionId`;
- `address` and `network`;
- `status`: `pending_verification`, `verified` or `superseded`;
- `createdAt`/`createdBy`, `verifiedAt`/`verifiedBy` and `supersededAt`/`supersededBy`.

`addressChanges(recipientId)` returns the change log. Each entry has
`fromVersion` → `toVersion`, `fromAddress` → `toAddress`, `network`, `actor`,
`changedAt` and the version's **current** `verificationStatus`.

Updating a recipient to the address and network it already has is a no-op. It
creates no version and no log entry.

## Approvals are bound to a version

`prepareTransfer` binds the approval to the verified revision. It records
`approvedVersion` and an `approvalHash` over the address and network.
`submitTransfer` accepts the approval only if that revision is still the
recipient's **current** version and is verified. Otherwise it throws
`StaleRecipientApprovalError` (`approvedVersion`, `currentVersion`).

This includes changing the address away and **back** to the original. The new
version gets a new revision id, so an approval from before the change can't be
reused, even after re-verification. The transfer must be approved again.

Other rules:
- A new version must be verified before any transfer can be approved for it.
- A superseded version cannot be verified.
- Approvals can be explicitly revoked via `revokeRecipientApproval` without deleting contact history or unrelated versions. Revoking an approval immediately invalidates any prepared transfers bound to that revision (`StaleRecipientApprovalError`), satisfying strict security and compatibility requirements.

Tests: `src/Contacts/__tests__/recipientAddressHistory.test.ts`.
