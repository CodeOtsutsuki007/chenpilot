# Contacts Recipient Governance and Audit Requirements

## Supported Behavior
- Administrative edits to saved payment destinations (recipients) and removals generate attributable audit records.
- Each modification records the actor, target recipient, timestamp, and version/address details via the audit log service.
- Address updates transition the previous version to superseded and create a new version requiring verification.

## Failure Cases
- Attempts to modify or remove recipients without valid attribution default to the system actor or fail when strict actor context is required.
- Stale approvals referencing old recipient address versions are rejected when submitting transfers.

## Compatibility Requirements
- Maintains backward compatibility with existing recipient governance flows while enriching audit trail metadata for compliance and security reviews.
