# Secret Management

Code reads secrets through `secretManager` (`src/Security/secrets`), not
`process.env`. The manager enforces scope, lifetime, environment separation
and an access trail.

## Model

| Concern | How it is enforced |
| --- | --- |
| Least privilege | Each secret is declared in `SECRET_CATALOG` with the workflows allowed to read it. Undeclared secrets (`unknown_secret`) and other workflows (`scope_denied`) are refused. |
| Bounded exposure | `withSecret(name, scope, fn)` hands `fn` a `SecretBuffer` that is zeroized when `fn` settles or after the descriptor's `maxLeaseMs` (`lease_expired`). |
| Traceability | Every grant and denial is logged and written to the audit log as `policy.secret.accessed` / `policy.secret.access_denied` with secret name, workflow, actor, environment, provider and version fingerprint — never the value. |
| Safe failures | `SecretAccessError` carries only a code and names. Provider error text and parse errors (which can echo their input) are discarded. |
| No plaintext logs | The logger matches secret field names case-insensitively (`privateKey`, `SPONSOR_SECRET`, `accessToken`, ...) and scrubs Stellar seeds, JWTs, bearer tokens, `sk-` API keys, PEM keys and URL credentials from free text, error messages and stack traces. |

## Environment separation

The deployment environment comes from `APP_ENV` (or `DEPLOY_ENV`), falling back
to `NODE_ENV=production` → `production`, otherwise `local`.

In **staging** and **production**:

- `localDefault` values are never used — the secret must be provisioned.
- Known test placeholders (the test-suite `ENCRYPTION_KEY`, `sk-test-placeholder`, old hard-coded dev keys, ...) are rejected as `invalid_value`.
- Plaintext providers and `ALLOW_PLAINTEXT_ACCOUNTS=true` are refused.
- If the deploy pipeline sets `SECRETS_PROVISIONED_FOR`, a mismatch with the running environment is refused (`environment_mismatch`), so a production bundle cannot be loaded by staging or a laptop.

At startup `verifySecretConfiguration()` reports missing secrets and aborts boot in
shared environments when any secret is unsafe.

## Adding a secret

1. Add a descriptor to `src/Security/secrets/catalog.ts` (name, env var, workflows, environments, `maxLeaseMs`, `minLength`).
2. Read it with:
   ```ts
   await secretManager.withSecret("stellar.sponsor-key", { workflow: "sponsorship", actor: userId }, (secret) =>
     secret.consumeString((seed) => Keypair.fromSecret(seed))
   );
   ```
   Use `readEnvSecretSync` only for keys needed at construction time (HMAC signing keys).
3. Adding a workflow to an existing secret widens access — review it like a permission change.

## Rotation runbook

Managed stores implement `RotatableSecretProvider` (`VersionedSecretStore` is the
reference implementation used in tests).

1. **Rotate**: `secretManager.rotate(name, newValue, actor)`. The new version becomes current; the previous one stays readable through the provider for in-flight work. Audited as `policy.secret.rotated`.
2. **Drain**: wait for work that may hold the old version (at most the secret's `maxLeaseMs`, plus any job retry window).
3. **Revoke**: `secretManager.revoke(name, previousVersion, actor)`. Audited as `policy.secret.revoked`.

For secrets supplied through environment variables:

1. Provision the new value in the platform's secret store and redeploy.
2. If the old value leaked, revoke its fingerprint immediately: `secretManager.revoke(name, "env:<fingerprint>", actor)`. Instances refuse the leaked value (`revoked`) until they pick up the new one. The fingerprint is the `version` field in the access log.

Wallet account secrets (`ENCRYPTED_ACCOUNTS_JSON_*`) are encrypted with the data
keys described in [ENCRYPTION_KEY_ROTATION.md](../ENCRYPTION_KEY_ROTATION.md);
decrypted data is dropped from memory after `ACCOUNT_SECRET_CACHE_TTL_MS`
(default 5 minutes).

The workflows above are covered by `src/Security/secrets/__tests__/secretManagement.test.ts`.
