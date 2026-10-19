# Chen Pilot - Implementation Index

This document provides a complete index of major implementations in the Chen Pilot repository.

Curated entries are edited by hand. The Documentation Map at the end is generated: run `npm run docs:index` to regenerate it and `npm run docs:check` to check this index for duplicate sections, duplicate links, and stale paths (see CONTRIBUTING.md, "Documentation checks").

---

## Recent Implementations

### #860 - Timezone-Aware Reporting
**Status**: ✅ **COMPLETE**  
**Feature**: Support user-selected timezone boundaries for daily reports

See detailed documentation:
- **Implementation Summary**: `ISSUE_860_IMPLEMENTATION.md`
- **Architecture & Design**: `TIMEZONE_REPORTING_DESIGN.md`

**Key Files**:
- `src/services/timezoneReporting.service.ts` (550+ lines)
- `src/services/__tests__/timezoneReporting.service.test.ts` (112 tests)
- `src/services/operatorReporting.service.ts` (enhanced)

**Achievement**: Complete timezone-aware reporting solution with 5 period types (DAY, WEEK, MONTH, LAST_N_DAYS, CUSTOM), DST support, and 112 comprehensive tests. Users can now request reports based on their local calendar days rather than UTC boundaries.

---

### #858 - In-Transit Bridge Accounting
**Status**: ✅ **COMPLETE**  
**Feature**: Define in-transit bridge accounting without double-counting holdings

See detailed documentation:
- **Implementation Summary** (archived): `docs/archive/implementation-reports/858-in-transit-bridge-accounting/ISSUE_858_IMPLEMENTATION.md`
- **Architecture & Design**: `BRIDGE_ACCOUNTING_DESIGN.md`
- **Integration Guide**: `docs/BRIDGE_ACCOUNTING_INTEGRATION_GUIDE.md`

**Key Files**:
- `src/domain/execution/bridgeAccountingModel.ts` (358 lines)
- `src/services/__tests__/invariantReconciliation.test.ts` (29 new tests added)

**Achievement**: Comprehensive three-partition accounting model that prevents double-counting during cross-chain transfers, with 29 regression tests and full conservation verification.

---

### #683 - Financial Formatting Security
**Status**: ✅ **COMPLETE & VERIFIED**  
**Feature**: Make financial formatting locale-safe and unambiguous on every confirmation surface

See detailed documentation:
- **Implementation Summary**: `IMPLEMENTATION_SUMMARY.md`
- **Acceptance Criteria & Security Properties**: `E2E_VERIFICATION_REPORT.md`
- **Confirmation Surface Audit**: `FINANCIAL_FORMATTING_AUDIT.md`

**Key Files**:
- `src/utils/SecuritySensitiveFormatter.ts` (`formatAmount()`, `formatAddress()`, `formatTransactionHash()`, `stripFormatting()`, ...)
- `src/utils/__tests__/SecuritySensitiveFormatter.test.ts` (RTL, homoglyph, narrow-screen, and clipboard cases)
- `src/Agents/tools/swap.ts` and `src/Agents/tools/wallet.ts` (integrations)

**Run the tests**: `npm test -- src/utils/__tests__/SecuritySensitiveFormatter.test.ts`

**Achievement**: Unambiguous decimal and grouping separators, BiDi-isolated copyable addresses, homoglyph detection, and no truncation of critical values, so users cannot misread amounts or destinations across locales and screen sizes.

---

## Documentation Map

<!-- BEGIN GENERATED: docs-map (npm run docs:index) -->

- [docs/AGENT_MEMORY_SEEDING.md](docs/AGENT_MEMORY_SEEDING.md) — Agent Memory Seeding Guide
- [docs/AGENT_PLANNER_FAILURE_SEMANTICS.md](docs/AGENT_PLANNER_FAILURE_SEMANTICS.md) — AgentPlanner and PlanExecutor Failure Semantics
- [docs/AGENT_PLAN_COST_MONITORING.md](docs/AGENT_PLAN_COST_MONITORING.md) — Agent plan token and cost monitoring
- [docs/BOT_IDENTITY_LINKING.md](docs/BOT_IDENTITY_LINKING.md) — Bot Identity Linking System
- [docs/BRIDGE_ACCOUNTING_INTEGRATION_GUIDE.md](docs/BRIDGE_ACCOUNTING_INTEGRATION_GUIDE.md) — Bridge Accounting Integration Guide
- [docs/CONTRACT_SECURITY_IMPLEMENTATION_SUMMARY.md](docs/CONTRACT_SECURITY_IMPLEMENTATION_SUMMARY.md) — Contract Security Implementation Summary
- [docs/DIFFERENTIAL_FUZZING.md](docs/DIFFERENTIAL_FUZZING.md) — Differential Fuzzing Between Soroban Contracts and Reference Models
- [docs/DISCORD_MODERATION.md](docs/DISCORD_MODERATION.md) — Discord Scam Detection
- [docs/DOCUMENTATION_ARCHIVAL_POLICY.md](docs/DOCUMENTATION_ARCHIVAL_POLICY.md) — Documentation Archival Policy
- [docs/EGRESS_SECURITY.md](docs/EGRESS_SECURITY.md) — Default-Deny Egress Security
- [docs/EMERGENCY_COORDINATION_IMPLEMENTATION.md](docs/EMERGENCY_COORDINATION_IMPLEMENTATION.md) — Emergency Coordination Implementation Guide
- [docs/ENCRYPTION_KEY_ROTATION.md](docs/ENCRYPTION_KEY_ROTATION.md) — Encryption key rotation runbook
- [docs/EVENT_STANDARD.md](docs/EVENT_STANDARD.md) — Cross-Contract Event Standard
- [docs/MULTI_HOP_ARCHITECTURE.md](docs/MULTI_HOP_ARCHITECTURE.md) — Multi-Hop Trade Path Evaluation - Architecture
- [docs/MULTI_HOP_TRADING.md](docs/MULTI_HOP_TRADING.md) — Multi-Hop Trade Path Evaluation
- [docs/PLATFORM_VALIDATION_CONTRACTS.md](docs/PLATFORM_VALIDATION_CONTRACTS.md) — Platform-Wide Validation Contracts
- [docs/PROMPT_VERSIONING.md](docs/PROMPT_VERSIONING.md) — Prompt Versioning & A/B Testing System
- [docs/PROPERTY_TESTING.md](docs/PROPERTY_TESTING.md) — Property-Based and Invariant Testing for Soroban Contracts
- [docs/REDTEAM_EVALUATION.md](docs/REDTEAM_EVALUATION.md) — Adversarial Red-Team Evaluation Suite (issue #634)
- [docs/RELIABILITY_AND_INDEXING.md](docs/RELIABILITY_AND_INDEXING.md) — Backend Reliability and Indexing Platform
- [docs/RUNBOOK_LOCKS.md](docs/RUNBOOK_LOCKS.md) — Production Runbook: Stuck or Failed Trade Locks
- [docs/SANDBOX_EXECUTION_SECURITY.md](docs/SANDBOX_EXECUTION_SECURITY.md) — Sandbox Execution Security
- [docs/SECURITY_BOUNDARIES_ANALYSIS.md](docs/SECURITY_BOUNDARIES_ANALYSIS.md) — Security Boundaries Analysis: core_vault, rbac, and EmergencyControl.sol
- [docs/SHARED_AUTHORIZATION_FRAMEWORK.md](docs/SHARED_AUTHORIZATION_FRAMEWORK.md) — Shared Authorization Framework: Soroban Contract Security Model
- [docs/STRATEGY_EXECUTION_BOUNDARY.md](docs/STRATEGY_EXECUTION_BOUNDARY.md) — Contract-to-Contract Strategy Execution Boundary: Vault-Managed Capital
- [docs/SYSTEMS_HANDBOOK.md](docs/SYSTEMS_HANDBOOK.md) — ChenPilot Systems Handbook
- [docs/TEMPORAL_SAFETY_BUDGETING.md](docs/TEMPORAL_SAFETY_BUDGETING.md) — Temporal Safety Verification & Economic Budgeting System
- [docs/TOOLS.md](docs/TOOLS.md) — Agent Tools Documentation
- [docs/TRANSACTION_JOURNEY_SLO.md](docs/TRANSACTION_JOURNEY_SLO.md) — Transaction user-journey SLIs, SLOs, and runbook
- [docs/TYPE_SAFETY_CLEANUP.md](docs/TYPE_SAFETY_CLEANUP.md) — Type Safety Cleanup Program
- [docs/VAULT_ACCOUNTING_INVARIANTS.md](docs/VAULT_ACCOUNTING_INVARIANTS.md) — Vault Accounting Invariants: core_vault State Consistency
- [docs/archive/README.md](docs/archive/README.md) — Documentation Archive
- [docs/archive/implementation-reports/858-in-transit-bridge-accounting/ISSUE_858_DELIVERY_SUMMARY.md](docs/archive/implementation-reports/858-in-transit-bridge-accounting/ISSUE_858_DELIVERY_SUMMARY.md) — Issue #858 - Delivery Summary
- [docs/archive/implementation-reports/858-in-transit-bridge-accounting/ISSUE_858_IMPLEMENTATION.md](docs/archive/implementation-reports/858-in-transit-bridge-accounting/ISSUE_858_IMPLEMENTATION.md) — Issue #858 Implementation Summary
- [docs/archive/implementation-reports/858-in-transit-bridge-accounting/ISSUE_858_README.md](docs/archive/implementation-reports/858-in-transit-bridge-accounting/ISSUE_858_README.md) — Issue #858 - In-Transit Bridge Accounting
- [docs/security/README.md](docs/security/README.md) — Agent Security Controls
- [docs/security/SECRET_MANAGEMENT.md](docs/security/SECRET_MANAGEMENT.md) — Secret Management

<!-- END GENERATED: docs-map -->
