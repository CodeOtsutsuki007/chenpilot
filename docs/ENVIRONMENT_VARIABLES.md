# Environment Variables

Every environment variable the backend and the chat bot read, with the module
that owns it, whether it must be set, its default, and whether it is a secret.

The table below is generated from
[`scripts/env/env-registry.json`](../scripts/env/env-registry.json). Edit the
registry, not the table, then run:

```bash
npm run env:docs    # regenerate the table below
npm run env:check   # the CI check (also part of npm run docs:check)
```

## Columns

| Column   | Meaning                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------ |
| Owner    | The module that reads the variable and decides what it means. Ask its maintainers before changing semantics.             |
| Required | `Yes`: startup fails or the service is unusable without it. `Unless`/`When`: required only in that case. `No`: optional. |
| Default  | The value used when the variable is unset. `—` means no default. A default that names another variable falls back to it. |
| Secret   | `Yes`: never commit, log, or paste the value. `npm run preflight` reports secrets by name only.                          |

A name ending in `*` is a family: the code builds the full name at runtime (for
example `DEFI_<ADAPTER>_ENABLED`), so the scanner cannot see each member.

## How the CI check works

`node scripts/env/check-env-docs.mjs` runs in
[`.github/workflows/docs-checks.yml`](../.github/workflows/docs-checks.yml). It
fails when:

- source references a variable that has no registry entry, family, or exemption
  (`file:line: NAME is referenced but not documented`),
- a registry entry is no longer referenced by any scanned source,
- an entry is missing its owner, requiredness, default, secret status, or
  description,
- a required variable is missing from `.env.example`,
- the table below is out of date.

It scans the files listed under `scan.include` in the registry for
`process.env.NAME`, `process.env["NAME"]`, `env.NAME`, the first argument of
helpers such as `requireEnv("NAME")`, and catalog keys such as
`envVar: "NAME"`. Tests are excluded.

When you add a variable, add a registry entry in the same pull request. When a
reference should not be documented as configuration (an example or a manual
test harness), add an `exemptions` entry with a `reason`; exemptions are listed
at the end of the table so reviewers can see them.

<!-- prettier-ignore-start -->
<!-- BEGIN GENERATED: env-vars (npm run env:docs) -->
### Backend API (`src/`, `server.js`)

| Variable | Owner | Required | Default | Secret | Description |
| --- | --- | --- | --- | --- | --- |
| `*_WEBHOOK_SECRET` | Gateway (`src/Gateway/WebhookSecretManager.ts`) | No | — | Yes | Family: per-provider webhook secrets (`STELLAR`, `TELEGRAM`, `DISCORD`, `GITHUB`, `STRIPE`), read by computed name. |
| `*_WEBHOOK_SECRET_PREVIOUS` | Gateway (`src/Gateway/WebhookSecretManager.ts`) | No | — | Yes | Family: previous provider secret accepted during zero-downtime rotation. |
| `ABUSE_POLICY_FILE` | Security (`src/Security/abusePrevention`) | No | — | No | Path to a JSON abuse-policy override file. |
| `ABUSE_POLICY_OVERRIDES` | Security (`src/Security/abusePrevention`) | No | — | No | Inline JSON abuse-policy overrides, applied after the file. |
| `ACCOUNT_SECRET_CACHE_TTL_MS` | Auth (`src/Auth/accountSecretStore.ts`) | No | `300000` | No | Decrypted account cache lifetime. |
| `ACCOUNTS_JSON_PATH` | Auth (`src/Auth/accountSecretStore.ts`) | No | — | No | Plaintext accounts file. Only read when `ALLOW_PLAINTEXT_ACCOUNTS=true` in a local environment. |
| `ADMIN_ALLOWED_IPS` | Gateway (`src/config/config.ts`) | No | empty | No | Comma-separated IPs or CIDRs allowed on admin routes. Empty allows all. |
| `AGENT_EXECUTION_TIMEOUT` | Agents (`src/config/config.ts`) | No | `120000` | No | Agent workflow timeout in ms. |
| `AGENT_LLM_INPUT_COST_PER_MILLION_USD` | Observability (`src/observability/agentPlanMetrics.ts`) | No | `0.8` | No | Input token price used for plan cost metrics. |
| `AGENT_LLM_OUTPUT_COST_PER_MILLION_USD` | Observability (`src/observability/agentPlanMetrics.ts`) | No | `4` | No | Output token price used for plan cost metrics. |
| `AGENT_LLM_TIMEOUT` | Agents (`src/config/config.ts`) | No | `30000` | No | LLM call timeout in ms. |
| `AGENT_PLAN_TIMEOUT` | Agents (`src/config/config.ts`) | No | `180000` | No | Multi-step plan timeout in ms. |
| `AGENT_PLAN_TOKEN_ANOMALY_MULTIPLIER` | Observability (`src/observability/agentPlanMetrics.ts`) | No | `3` | No | Multiple of the baseline that flags a plan as anomalous. |
| `AGENT_PLAN_TYPICAL_TOKENS` | Observability (`src/observability/agentPlanMetrics.ts`) | No | `4096` | No | Typical plan token count used as the anomaly baseline. |
| `AGENT_TOOL_TIMEOUT` | Agents (`src/config/config.ts`) | No | `60000` | No | Tool execution timeout in ms. |
| `ALLOW_PLAINTEXT_ACCOUNTS` | Auth (`src/Auth/accountSecretStore.ts`) | No | `false` | No | Allow the plaintext accounts file. Refused in shared environments. |
| `ALLOWED_ORIGINS` | Gateway (`src/Gateway`) | No | `*` | No | CORS and Socket.IO allowed origins. |
| `ANTHROPIC_API_KEY` | Agents (`src/config/config.ts`) | Yes | — | Yes | Anthropic API key for the agent. |
| `APP_ENV` | Security (`src/Security/secrets`) | No | — | No | Deployment environment (`local`, `staging`, `production`); overrides `NODE_ENV` for secret policy. |
| `CAPABILITY_SECRET_KEY` | Agents (`src/Agents/capability`) | No | `local-only development default` | Yes | HMAC key that signs capability grants (at least 32 characters). Falls back to `JWT_SECRET`; the built-in default is refused outside local. |
| `CORE_VAULT_CONTRACT_ID` | Contracts (`src/services/contracts/contractMetadataRegistry.ts`) | No | — | No | Core vault contract address. The binding is disabled when unset. |
| `DB_HOST` | Data (`src/config/Datasource.ts`) | Yes | — | No | PostgreSQL host. |
| `DB_NAME` | Data (`src/config/Datasource.ts`) | Yes | — | No | PostgreSQL database name. |
| `DB_PASSWORD` | Data (`src/config/Datasource.ts`) | No | — | Yes | PostgreSQL password. Optional for trust or peer authentication. |
| `DB_POOL_ACQUIRE_TIMEOUT_MS` | Data (`src/config/Datasource.ts`) | No | `5000` | No | Wait for a free connection before failing (minimum 500). |
| `DB_POOL_IDLE_TIMEOUT_MS` | Data (`src/config/Datasource.ts`) | No | `30000` | No | Idle connection lifetime (minimum 1000). |
| `DB_POOL_MAX` | Data (`src/config/Datasource.ts`) | No | `10` | No | Connection pool ceiling. |
| `DB_POOL_MIN` | Data (`src/config/Datasource.ts`) | No | `2` | No | Connection pool floor. |
| `DB_PORT` | Data (`src/config/Datasource.ts`) | No | `5432` | No | PostgreSQL port. |
| `DB_USERNAME` | Data (`src/config/Datasource.ts`) | Yes | — | No | PostgreSQL user. |
| `DEFI_*` | DeFi (`src/config/defiAdapters.ts`) | No | `per adapter` | No | Family: `DEFI_<ADAPTER>_{ENABLED,API_URL,RPC_URL,TIMEOUT,RETRY_ATTEMPTS,RETRY_BACKOFF,CAPABILITY_*}` for each adapter. See `.env.example`. |
| `DEPLOY_ENV` | Security (`src/Security/secrets`) | No | — | No | Alias for `APP_ENV`, used when `APP_ENV` is unset. |
| `DISCORD_PUBLIC_KEY` | Gateway (`src/Gateway/platformWebhook.service.ts`) | No | — | No | Discord interaction signature public key. |
| `EMAIL_VERIFICATION_ENABLED` | Email (`src/config/config.ts`) | No | `false` | No | Require email verification on sign-up. |
| `ENCRYPTED_ACCOUNTS_JSON_B64` | Auth (`src/Auth/accountSecretStore.ts`) | No | — | Yes | Encrypted accounts payload, base64. Takes precedence over the path. |
| `ENCRYPTED_ACCOUNTS_JSON_PATH` | Auth (`src/Auth/accountSecretStore.ts`) | No | — | No | Path to the encrypted accounts file. |
| `ENCRYPTION_ACTIVE_KEY_ID` | Security (`src/utils/encryption.ts`) | When `ENCRYPTION_KEYS_JSON` is set | — | No | Keyring entry used for new ciphertext. |
| `ENCRYPTION_KEY` | Security (`src/utils/encryption.ts`) | Unless `ENCRYPTION_KEYS_JSON` is set | — | Yes | Legacy 64-character hex encryption key. Keep it during key rotation so old ciphertext stays readable. |
| `ENCRYPTION_KEYS_JSON` | Security (`src/utils/encryption.ts`) | No | — | Yes | Versioned keyring as JSON (`{"id":"64-hex-key"}`) for online rotation. |
| `ENCRYPTION_REVOKED_KEY_IDS` | Security (`src/utils/encryption.ts`) | No | empty | No | Comma-separated keyring IDs that may no longer decrypt. |
| `EXTERNAL_REQUEST_ATTEMPTS` | Platform (`src/config/config.ts`) | No | `3` | No | Retry budget for outbound provider requests. |
| `EXTERNAL_REQUEST_BYTES` | Platform (`src/config/config.ts`) | No | `5242880` | No | Response size budget for outbound provider requests. |
| `EXTERNAL_REQUEST_DEADLINE_MS` | Platform (`src/config/config.ts`) | No | `10000` | No | Deadline for outbound provider requests. |
| `EXTERNAL_REQUEST_DOWNSTREAM_CALLS` | Platform (`src/config/config.ts`) | No | `10` | No | Downstream call budget per request. |
| `FINALITY_ANCESTRY_CHECK_DEPTH` | Transactions (`src/services/finality`) | No | `network default` | No | Ledger ancestry depth checked for reorgs. |
| `FINALITY_CONFIRMATION_DEPTH` | Transactions (`src/services/finality`) | No | `network default` | No | Ledgers required before a transaction is final. |
| `FINALITY_CONFIRMATION_TIMEOUT_MS` | Transactions (`src/services/finality`) | No | `network default` | No | Confirmation timeout. |
| `FINALITY_MAX_RECONCILIATION_ATTEMPTS` | Transactions (`src/services/finality`) | No | `network default` | No | Reconciliation attempts before escalation. |
| `FINALITY_POLL_INTERVAL_MS` | Transactions (`src/services/finality`) | No | `network default` | No | Confirmation poll interval. |
| `FINALITY_PRIMARY_HORIZON_URL` | Transactions (`src/services/finality`) | No | `STELLAR_HORIZON_URL` | No | Horizon used for finality checks. |
| `FINALITY_RECONCILIATION_HORIZON_URL` | Transactions (`src/services/finality`) | No | `FINALITY_PRIMARY_HORIZON_URL` | No | Independent Horizon used for reconciliation. |
| `FINALITY_RECONCILIATION_RETRY_DELAY_MS` | Transactions (`src/services/finality`) | No | `network default` | No | Delay between reconciliation attempts. |
| `FUTURENET_*` | Contracts (`src/services/contracts/contractMetadataRegistry.ts`) | No | — | No | Family: futurenet overrides, same suffixes as `TESTNET_*`. |
| `HORIZON_URL` | Stellar (`src/services/networkConfig.ts`) | No | `derived from STELLAR_NETWORK` | No | Horizon URL used by `networkConfig` and transaction routes. |
| `HTLC_CONTRACT_ID` | Contracts (`src/services/contracts/contractMetadataRegistry.ts`) | No | — | No | HTLC contract address. |
| `INBOUND_ATTACHMENT_LIMIT_BYTES` | Gateway (`src/config/config.ts`) | No | `26214400` | No | Maximum attachment upload size. |
| `INBOUND_JSON_LIMIT_BYTES` | Gateway (`src/config/config.ts`) | No | `1048576` | No | Maximum JSON request body size. |
| `INBOUND_WEBHOOK_LIMIT_BYTES` | Gateway (`src/config/config.ts`) | No | `1048576` | No | Maximum webhook request body size. |
| `INTERVENTION_SIGNING_SECRET` | Agents (`src/Agents/planner`) | No | — | Yes | HMAC secret for operator interventions. Interventions are disabled when unset. |
| `JWT_ACCESS_SECRET` | Auth (`src/Auth/jwt.service.ts`) | Yes | — | Yes | Signs access tokens. |
| `JWT_REFRESH_SECRET` | Auth (`src/Auth/jwt.service.ts`) | Yes | — | Yes | Signs refresh tokens. |
| `JWT_RESET_EXPIRY` | Auth (`src/config/config.ts`) | No | `1h` | No | Password reset token lifetime. |
| `JWT_SECRET` | Auth (`src/config/config.ts`) | Yes | `secret-token` | Yes | Legacy JWT secret, at least 32 characters. The built-in default is too short and fails startup, so it must be set. |
| `KYC_PROVIDER` | KYC (`src/config/config.ts`) | No | `mock` | No | Registered KYC provider adapter. |
| `LOG_LEVEL` | Platform (`src/config/logger.ts`) | No | `info` | No | Winston log level. |
| `MAINNET_*` | Contracts (`src/services/contracts/contractMetadataRegistry.ts`) | No | — | No | Family: mainnet overrides, same suffixes as `TESTNET_*`. |
| `MANIFEST_DIR` | Contracts (`src/ContractIdentity`) | No | `./deployments` | No | Directory of signed deployment manifests (`<network>/<contract>.manifest.json`). |
| `MANIFEST_ENFORCEMENT` | Contracts (`src/ContractIdentity`) | No | `on` | No | `off` makes the contract identity gate warn-only. Never use `off` for production traffic. |
| `MANIFEST_SIGNING_KEY` | Contracts (`src/ContractIdentity`) | When publishing or rotating a deployment manifest | — | Yes | PEM private key that signs deployment manifests (`scripts/manifest-cli.ts`). |
| `MODEL_DIFFERENTIAL_EVAL_ON_STARTUP` | Agents (`src/config/config.ts`) | No | `false` | No | Run differential model evaluation at startup. |
| `MODEL_FALLBACKS` | Agents (`src/config/config.ts`) | No | `claude-3-5-sonnet-20241022` | No | Comma-separated fallback models in priority order. |
| `MODEL_MAX_RETRIES` | Agents (`src/config/config.ts`) | No | `2` | No | Retry attempts across models. |
| `MODEL_MIN_QUALITY_SCORE` | Agents (`src/config/config.ts`) | No | `0.7` | No | Minimum output quality score (0-1). |
| `MODEL_PRIMARY` | Agents (`src/config/config.ts`) | No | `claude-3-5-haiku-20241022` | No | Primary LLM model. |
| `MODEL_SELECTION_STRATEGY` | Agents (`src/config/config.ts`) | No | `quality_first` | No | `quality_first`, `latency_first`, `cost_first` or `balanced`. |
| `MODEL_VERIFY_EQUIVALENCE` | Agents (`src/config/config.ts`) | No | `true` | No | Verify semantic equivalence before falling back. `false` disables. |
| `MULTI_HOP_SWAP_CONTRACT_ID` | Contracts (`src/services/contracts/contractMetadataRegistry.ts`) | No | — | No | Multi-hop swap contract address. |
| `NETWORK_PASSPHRASE` | Stellar (`src/services/networkConfig.ts`) | No | `derived from STELLAR_NETWORK` | No | Network passphrase used by `networkConfig`. |
| `NODE_ENV` | Platform (`src/config/config.ts`) | No | `development` | No | Runtime mode. `development` loads migrations from `src/`, anything else from `dist/`. |
| `NODE_URL` | Platform (`src/config/config.ts`) | Yes | — | No | Public base URL of this server; also used by Swagger and the Telegram bot. |
| `OPENAI_API_KEY` | Services (`src/services/voiceTranscription.service.ts`) | No | — | Yes | OpenAI key for Whisper voice transcription. Voice messages are rejected when unset. |
| `OPENAI_API_URL` | Services (`src/services/voiceTranscription.service.ts`) | No | `https://api.openai.com/v1/audio/transcriptions` | No | Transcription endpoint. |
| `PLAN_SIGNING_KEY` | Agents (`src/Agents/planner`) | No | — | Yes | Private key that signs plan hashes. Plans are unsigned when unset. |
| `PORT` | Platform (`src/config/config.ts`) | No | `2333` | No | HTTP port. The legacy root `server.js` defaults to `3000`. |
| `PROMPT_CHANGE_APPROVALS_REQUIRED` | Agents (`src/Agents/registry`) | No | `2` | No | Approvals needed to promote a prompt change. |
| `PROMPT_CHANGE_CONTROL_ENV` | Agents (`src/Agents/registry`) | No | `NODE_ENV` | No | Environment used for prompt change-control policy. |
| `PROMPT_CHANGE_CONTROL_SECRET` | Agents (`src/Agents/registry`) | When prompt change control runs in production | — | Yes | Secret that signs prompt change approvals. |
| `PROVIDER_GATE_MAX_CONCURRENT` | Security (`src/Security/abusePrevention`) | No | `20` | No | Concurrent outbound chain/provider calls. |
| `PROVIDER_GATE_MAX_QUEUED` | Security (`src/Security/abusePrevention`) | No | `100` | No | Queued outbound chain/provider calls. |
| `PROVIDER_GATE_QUEUE_TIMEOUT_MS` | Security (`src/Security/abusePrevention`) | No | `10000` | No | Queue wait before an outbound call is rejected. |
| `PUBLIC_*` | Contracts (`src/services/contracts/contractMetadataRegistry.ts`) | No | — | No | Family: public-network overrides, same suffixes as `TESTNET_*`. |
| `RBAC_CONTRACT_ID` | Contracts (`src/services/contracts/contractMetadataRegistry.ts`) | No | — | No | RBAC contract address. |
| `REALTIME_MAX_BUFFERED_EVENTS` | Gateway (`src/Gateway/socketManager.ts`) | No | `100` | No | Per-socket realtime event buffer before slow-consumer handling. |
| `REDIS_DB` | Data (`src/config/config.ts`) | No | `0` | No | Redis logical database index. |
| `REDIS_HOST` | Data (`src/config/config.ts`) | No | `localhost` | No | Redis host for caching and rate limiting. |
| `REDIS_PASSWORD` | Data (`src/config/config.ts`) | No | — | Yes | Redis password, when the server requires `AUTH`. |
| `REDIS_PORT` | Data (`src/config/config.ts`) | No | `6379` | No | Redis port. |
| `REDTEAM_MODEL` | Agents (`src/redteam`) | No | `claude-3-5-haiku-20241022` | No | Model under test for `npm run redteam`. |
| `REVOCATION_SIGNING_KEY` | Security (`src/Security/assetRevocation.service.ts`) | When running in staging or production | `local-only development default` | Yes | HMAC key that signs asset revocation records (at least 32 characters). |
| `SECRETS_PROVISIONED_FOR` | Security (`src/Security/secrets`) | No | — | No | Environment the deployed secret bundle was provisioned for; a mismatch with the running environment is refused. |
| `SHADOW_ENABLED` | Shadow (`src/shadow/shadow.config.ts`) | No | `false` | No | Enable shadow execution (`true` or `1`). |
| `SHADOW_MAX_RECORDS` | Shadow (`src/shadow/shadow.config.ts`) | No | `50000` | No | Shadow record cap. |
| `SHADOW_PROMOTION_MAX_DIVERGENCE_RATE` | Shadow (`src/shadow/shadow.config.ts`) | No | `0.01` | No | Maximum divergence rate allowed for promotion (0-1). |
| `SHADOW_PROMOTION_MIN_EVALUATIONS` | Shadow (`src/shadow/shadow.config.ts`) | No | `50` | No | Evaluations required before promotion. |
| `SHADOW_PROMOTION_REQUIRED_APPROVALS` | Shadow (`src/shadow/shadow.config.ts`) | No | `1` | No | Approvals required for promotion. |
| `SHADOW_RETENTION_DAYS` | Shadow (`src/shadow/shadow.config.ts`) | No | `14` | No | Shadow record retention. |
| `SHADOW_SAMPLE_RATE_PCT` | Shadow (`src/shadow/shadow.config.ts`) | No | `10` | No | Share of traffic shadowed (0-100). |
| `SMTP_FROM` | Email (`src/config/config.ts`) | No | `noreply@chenpilot.com` | No | Sender address. |
| `SMTP_HOST` | Email (`src/config/config.ts`) | No | `smtp.example.com` | No | SMTP host. |
| `SMTP_PASS` | Email (`src/config/config.ts`) | No | empty | Yes | SMTP password. |
| `SMTP_PORT` | Email (`src/config/config.ts`) | No | `587` | No | SMTP port. |
| `SMTP_USER` | Email (`src/config/config.ts`) | No | empty | No | SMTP user. |
| `SOROBAN_RPC_URL` | Stellar (`src/services/networkConfig.ts`) | No | `derived from STELLAR_NETWORK` | No | Soroban RPC endpoint. |
| `SOROBAN_RPC_URL_MAINNET` | Stellar (`src/services/soroban/sdkAdapter.ts`) | No | `https://soroban-mainnet.stellar.org` | No | Soroban RPC for the SDK adapter on mainnet. |
| `SOROBAN_RPC_URL_TESTNET` | Stellar (`src/services/soroban/sdkAdapter.ts`) | No | `https://soroban-testnet.stellar.org` | No | Soroban RPC for the SDK adapter on testnet. |
| `SPONSOR_SECRET_KEY` | Stellar (`src/Gateway/transaction.routes.ts`) | No | — | Yes | Stellar secret that sponsors new accounts. Sponsorship returns 503 when unset. |
| `STELLAR_ALERT_MIN_AMOUNT` | Services (`src/services/horizonOperationStreamer.service.ts`) | No | `1000` | No | Minimum amount that triggers an alert. |
| `STELLAR_ALERT_STREAM_ENABLED` | Services (`src/services/horizonOperationStreamer.service.ts`) | No | `true` | No | Stream Horizon operations for alerts. `false` disables. |
| `STELLAR_ALERT_STREAM_RECONNECT_MS` | Services (`src/services/horizonOperationStreamer.service.ts`) | No | `5000` | No | Reconnect delay for the alert stream. |
| `STELLAR_BASE_RESERVE` | Stellar (`src/config/config.ts`) | No | `0.5` | No | Base reserve in XLM. |
| `STELLAR_HORIZON_URL` | Stellar (`src/config/config.ts`) | No | `derived from STELLAR_NETWORK` | No | Horizon override. Also read by the bot `validate` command. |
| `STELLAR_NETWORK` | Stellar (`src/config/config.ts`) | No | `testnet` | No | `testnet` or `public`. Selects Horizon, passphrase and friendbot. |
| `STELLAR_NETWORK_PASSPHRASE` | Stellar (`src/config/config.ts`) | No | `derived from STELLAR_NETWORK` | No | Network passphrase override. |
| `STELLAR_WEBHOOK_SECRET` | Gateway (`src/Gateway/webhook.service.ts`) | No | — | Yes | Verifies Stellar webhook signatures. |
| `STRATEGY_REGISTRY_CONTRACT_ID` | Contracts (`src/services/contracts/contractMetadataRegistry.ts`) | No | — | No | Strategy registry contract address. |
| `STRATEGY_REGISTRY_EPOCH_MS` | Agents (`src/Agents/tools/strategyRegistry.ts`) | No | `86400000` | No | Voting epoch length. |
| `STRATEGY_REGISTRY_QUORUM` | Agents (`src/Agents/tools/strategyRegistry.ts`) | No | `3` | No | Votes required to register a strategy. |
| `TELEGRAM_BOT_TOKEN` | Gateway (`src/Gateway/platformWebhook.service.ts`) | No | — | Yes | Telegram bot token; also used by the bot service. |
| `TESTNET_*` | Contracts (`src/services/contracts/contractMetadataRegistry.ts`) | No | — | No | Family: testnet-scoped overrides such as `TESTNET_CORE_VAULT_CONTRACT_ID`, `TESTNET_SOROBAN_RPC_URL`, `TESTNET_NETWORK_PASSPHRASE`. |
| `WEBAUTHN_ORIGIN` | Auth (`src/webauthn.js`) | No | `http://localhost:3000` | No | Expected WebAuthn origin. |
| `WEBAUTHN_RP_ID` | Auth (`src/webauthn.js`) | No | `localhost` | No | WebAuthn relying-party ID. |
| `WEBAUTHN_RP_NAME` | Auth (`src/webauthn.js`) | No | `Chen Pilot` | No | WebAuthn relying-party display name. |
| `WEBHOOK_SECRET` | Gateway (`src/Gateway/WebhookSecretManager.ts`) | No | — | Yes | Generic webhook secret for providers without their own. |
| `WORKLOAD_SERVICE_ID` | Auth (`src/Auth/workloadIdentity.service.ts`) | No | — | No | This process's workload identity when issuing tokens. |
| `WORKLOAD_TOKEN_SECRET` | Auth (`src/Auth/workloadIdentity.service.ts`) | When service-to-service tokens are issued or verified | — | Yes | HMAC secret for workload identity tokens (at least 32 characters). |
| `WORKLOAD_TOKEN_SECRET_SECONDARY` | Auth (`src/Auth/workloadIdentity.service.ts`) | No | — | Yes | Previous workload secret accepted during rotation. |

### Chat bot (`packages/bot`)

| Variable | Owner | Required | Default | Secret | Description |
| --- | --- | --- | --- | --- | --- |
| `ADVANCED_ROLE_NAMES` | Bot (`packages/bot/src/adapters/discord.ts`) | No | `admin,moderator` | No | Comma-separated Discord roles with advanced access (legacy adapter). |
| `API_BASE_URL` | Bot (`packages/bot/src/services`) | No | — | No | Legacy alias for `BACKEND_URL` in account linking. |
| `BACKEND_URL` | Bot (`packages/bot`) | No | `http://localhost:3000` | No | Backend API base URL. The account-linking service defaults to `http://localhost:2333`. |
| `BOT_WEBHOOK_PORT` | Bot (`packages/bot/src/index.ts`) | No | `3001` | No | Port for the bot's webhook listener. |
| `DASHBOARD_URL` | Bot (`packages/bot/src/commands`) | No | `BACKEND_URL/dashboard` | No | Dashboard link shown by `/dashboard`. |
| `DISCORD_ADVANCED_ROLES` | Bot (`packages/bot/src/commands/handlers/discover.ts`) | No | `DeFi Pro,Whale,Admin` | No | Comma-separated Discord roles that unlock advanced `/discover` results. |
| `DISCORD_ANNOUNCEMENT_CHANNEL_ID` | Bot (`packages/bot/src/index.ts`) | No | — | No | Channel for release announcements. |
| `DISCORD_AUDIT_LOG_CHANNEL_ID` | Bot (`packages/bot/src/discord`) | No | — | No | Discord audit log channel. |
| `DISCORD_BOT_TOKEN` | Bot (`packages/bot/src/adapters/discord.ts`) | When running the Discord adapter | — | Yes | Discord bot token. |
| `DISCORD_CLIENT_ID` | Bot (`packages/bot/src/adapters/discord.ts`) | No | — | No | Discord application ID. Slash commands are not deployed when unset. |
| `DISCORD_SCAM_DETECTION_ACTION` | Bot (`packages/bot/src/moderation`) | No | — | No | Legacy fallback for `MODERATION_ACTION`. |
| `GITHUB_WEBHOOK_SECRET` | Bot (`packages/bot/src/releaseWebhook.ts`) | No | — | Yes | Verifies GitHub release webhooks. |
| `MARKET_DIGEST_ENABLED` | Bot (`packages/bot/src/services/marketDigestScheduler.ts`) | No | `false` | No | Enable the daily market digest. |
| `MARKET_DIGEST_RETRY_ATTEMPTS` | Bot (`packages/bot/src/services/marketDigestScheduler.ts`) | No | `3` | No | Retries per digest target. |
| `MARKET_DIGEST_RETRY_DELAY_MS` | Bot (`packages/bot/src/services/marketDigestScheduler.ts`) | No | `30000` | No | Delay between digest retries. |
| `MARKET_DIGEST_TIME` | Bot (`packages/bot/src/services/marketDigestScheduler.ts`) | No | `09:00` | No | Daily digest time, `HH:MM` UTC. |
| `MODERATION_ACTION` | Bot (`packages/bot/src/moderation`) | No | `flag` | No | `flag` (warn) or `block` (delete). |
| `MODERATION_ENABLED` | Bot (`packages/bot/src/moderation`) | No | `true` | No | `false` disables moderation. |
| `MODERATION_LOG_CHANNEL_ID` | Bot (`packages/bot/src/discord`) | No | `DISCORD_AUDIT_LOG_CHANNEL_ID` | No | Discord moderation log channel. |
| `MODERATION_LOG_CHAT_ID` | Bot (`packages/bot/src/commands/adapters`) | No | — | No | Telegram moderation log chat. |
| `SCAM_DETECTION_CHANNELS` | Bot (`packages/bot/src/adapters/discord.ts`) | No | empty | No | Channel IDs to monitor. Empty monitors all public channels. |
| `SCAM_DETECTION_ENABLED` | Bot (`packages/bot/src/adapters/discord.ts`) | No | `true` | No | Legacy Discord adapter scam-link detection. |
| `TELEGRAM_ANNOUNCEMENT_CHAT_ID` | Bot (`packages/bot/src/index.ts`) | No | — | No | Chat for release announcements. |

### Exemptions

Referenced in source but intentionally not documented as configuration.

| Pattern | Reason |
| --- | --- |
| `LOCAL_CHAIN_*` | Read only by the `src/simulation/test-local-chain.ts` harness script, not by a running service. |
| `SOCKET_SERVER_URL` | Read only by the `src/Gateway/manualTestClient.ts` manual test client. |
| `PLAN_PUBLIC_KEY` | Read only by the `src/Agents/planner/planHashExample.ts` example. |
<!-- END GENERATED: env-vars -->
<!-- prettier-ignore-end -->
