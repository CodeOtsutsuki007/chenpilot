# Agent Security Controls

| Control | Code | Doc |
| --- | --- | --- |
| Decoded transaction previews (#776) | `src/transactions/preview` | below |
| Abuse protection (#777) | `src/Security/abusePrevention` | below |
| Unified authorization (#779) | `src/Security/authorization` | below |
| Secret management (#780) | `src/Security/secrets` | [SECRET_MANAGEMENT.md](./SECRET_MANAGEMENT.md) |

## Transaction previews

`POST /api/transactions/preview` decodes an envelope with the bounded XDR
decoder and returns a structured preview plus the canonical text used by the
bot (`renderPreviewText`). Previews are built from the decoded operations only.

- **Risk flags** come from fixed rules: account merge, signer added, master key disabled, threshold changes, foreign source accounts, opaque contract calls, issuer-control operations, unknown network, high fee, no expiry, and more.
- **Intent comparison**: callers pass the user's request (`operationTypes`, `asset`, `amount`, `destination`, `network`). A different destination or network is critical, while excess amount, a different asset or unexpected operations are high.
- **Decision**: `refuse` for critical flags the user did not ask for and for critical mismatches; `confirm_with_warning` for high flags or any mismatch; otherwise `proceed`. Undecodable payloads return 422 and are never shown as opaque blobs.
- **Audit trail**: transaction hash, intent digest and preview digest link the request to what the user saw (`execution.transaction.preview_generated` / `_refused`).
- **Bot**: `packages/bot/src/transactionPreview.ts` shows the backend's text and asks for a typed `CONFIRM <hash prefix>` on high-risk previews. Anything it cannot verify is blocked.

## Abuse protection

One `AbusePreventionService` evaluates every surface: `api`, `bot`
(Telegram/Discord webhooks), `realtime` (socket subscriptions), `job` (user job
enqueue) and `provider` (outbound chain calls).

- **Rate limits** per user, session or IP (`defaultPolicy.ts`).
- **Escalation**: repeated violations block the subject. The block doubles on each repeat, up to `maxBlockMs`. Anonymous traffic is never escalated.
- **Anomaly detection**: `recordFailure` (failed logins, unknown accounts on the Horizon proxy) challenges, then blocks, bursts of failures.
- **Execution gate**: `providerExecutionGate` throttles per user, then applies a circuit breaker (provider 4xx responses don't count against it), then a bounded queue, before Horizon is called.
- **Tuning without code changes**: `ABUSE_POLICY_FILE` / `ABUSE_POLICY_OVERRIDES` (JSON):
  ```json
  { "rateLimits": { "bot-command": { "maxRequests": 5, "windowMs": 60000 } },
    "escalation": { "baseBlockMs": 120000 },
    "anomaly": { "challengeThreshold": 5 } }
  ```
  Invalid values are ignored with a warning. Reload with `POST /api/security/abuse/reload`. Gate sizing: `PROVIDER_GATE_MAX_CONCURRENT`, `PROVIDER_GATE_MAX_QUEUED`, `PROVIDER_GATE_QUEUE_TIMEOUT_MS`.
- **Visibility**: every limited request is logged; escalations and anomalies also go to the audit log. Admin endpoints under `/api/security/abuse`: `GET /stats`, `GET /events`, `GET /policy`, `POST /unblock`, `POST /reload`.

## Unified authorization

`OPERATION_CATALOG` (`operationCatalog.ts`) lists every operation with its side
effect and the channels (`http`, `websocket`, `bot`, `job`) it may be invoked
from. `ROLE_GRANTS` maps roles to operations. One `UnifiedAuthorizer` decides
for every channel; adapters only identify the caller and the real channel:

- HTTP: `requireOperation(op)` (bot-identity requests count as `bot`)
- WebSocket: `authorizeSocketOperation`
- Bot: `POST /api/authorization/check`, used by `packages/bot/src/permissions/unifiedPolicy.ts`
- Jobs: handlers declare `operation`. The worker re-authorizes the job as its originating user under the current policy, with fresh role and suspension status, and dead-letters denials.

Rules:

- A channel can only narrow authority. A client claiming a channel that would broaden it (for example a bot-identity request claiming `http`) is refused as `channel_mismatch`.
- Jobs keep their origin channel's restrictions. Grants are recomputed at execution, so a policy or role change also reaches work that is already queued.
- Financial operations given approval evidence are refused if the approval's economic inputs changed (`approval_invalidated`).
- Every denial is audited with reason, channel, resource and `policyVersion`.

### Privilege graph

`docs/security/privilege-graph.json` is generated from the catalog with
channel-scoped resources (`swap:execute@bot`). After changing the catalog or
grants, run `npm run authz:graph` and commit the result. CI
(`npm run authz:graph:check`) fails on drift and lists new privilege edges for
review.
