# Operator Reporting & Orphaned Export Artifact Detection

## Overview
Operator reporting provides deterministic snapshots of agent execution metrics, audit logs, bot sessions, contract inventories, and system health.

## Orphaned Export Artifact Detection
Failed or canceled data exports can leave orphaned artifacts without a visible cleanup outcome. The reporting subsystem queries audit records for `data_export` actions with `failed` or `status` markers and surfaces them under `orphanedExportArtifacts` in the operator report.

### Report Fields
- `orphanedExportArtifacts`: Array of detected artifacts containing `exportId`, `status`, `createdAt`, and `reason`.

## Compatibility & Verification
All reports include a cryptographic SHA-256 `snapshotHash` to verify immutability across requests.
