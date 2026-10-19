# Contract Deployment and Upgrade Runbook

How to deploy a Soroban contract from `contracts/` and how to upgrade
`core_vault`, with the gate each step must pass and the evidence to record.

Every step either names a command or file in this repository, or is marked
**Manual** with the evidence it must leave behind. `node scripts/docs/check-runbooks.mjs`
(part of `npm run docs:check` and the Docs Checks workflow) fails if a step
names a command or file that does not exist, a manual step has no evidence, or
a fact below no longer matches the source.

Record the evidence for each step in the release issue or pull request. A step
without evidence did not happen.

## Facts checked against the source

| Fact                                                                         | Value                                                 | Source                            | Check                    |
| ---------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------- | ------------------------ |
| `core_vault` upgrade delay, in ledgers                                       | `720`                                                 | `contracts/core_vault/src/lib.rs` | `const TIMELOCK_LEDGERS` |
| Only `core_vault` can replace its own code in place                          | `update_current_contract_wasm`                        | `contracts/core_vault/src/lib.rs` | `contains`               |
| Upgrade authorization is still the legacy admin, not the `UpgradeAdmin` role | `// TODO: enforce UpgradeAdmin role via UnifiedAuth.` | `contracts/core_vault/src/lib.rs` | `contains`               |
| Proposals are refused during an emergency                                    | `fail(&env, FailureReason::EmergencyMode);`           | `contracts/core_vault/src/lib.rs` | `contains`               |
| Manifest networks                                                            | `value !== "testnet" && value !== "mainnet"`          | `scripts/manifest-cli.ts`         | `contains`               |

What these mean for operators:

- **Upgrade delay.** 720 ledgers is about one hour at roughly 5 seconds per
  ledger. Ledger close time varies, so wait for the ledger number, not the clock.
- **Upgrade scope.** No other contract calls `update_current_contract_wasm`.
  Every other contract is "upgraded" by deploying a new instance and moving the
  backend to its new contract ID. Its old state stays with the old instance.
- **Authorization.** `propose_upgrade` and `cancel_upgrade` call
  `require_upgrade_admin`, which today checks the legacy `Admin` address set by
  `init` or `transfer_admin`. Granting the `UpgradeAdmin` role in
  `unified_auth` does **not** allow upgrades yet. `apply_upgrade` has no
  authorization: anyone can call it once the delay has passed.
- **Emergency.** `propose_upgrade` fails while an emergency is active. Resolve
  the emergency first, or ship the fix as a new deployment.
- **Network names differ.** The backend uses `STELLAR_NETWORK=testnet|public`.
  Deployment manifests and the `stellar` CLI use `testnet|mainnet`. Production
  is `public` in `.env` and `mainnet` everywhere else.

## Known issues

These block or change steps below. Remove an entry when it is fixed.

- **B4 fails today.** `npm run contracts:build` (the same build as
  `.github/workflows/sbom-provenance.yml`) stops in `contract_failure`:
  `#[contracterror]` panics with `LengthExceedsMax` because `FailureReason` has
  74 variants and a Soroban contract error enum allows at most 50. The host
  build used by `npm run contracts:check` does not generate the contract spec,
  so it passes. Until this is fixed, no release WASM or contract SBOM can be
  produced, and B4 to B6 cannot be completed.
- **`manifest-cli keygen` keys are rejected by `publish`.** See the note under
  D5.

## Before you start

| ID  | Step                                                                                                      | How                                                                                                                   | Evidence to record                                                        |
| --- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| S1  | Read the threat model and authorization matrix for the contract                                           | `contracts/THREAT_MODELS.md`, `contracts/AUTHORIZATION_MATRICES.md`                                                   | Reviewer name and the sections that apply                                 |
| S2  | Install the toolchain: Rust with `wasm32-unknown-unknown`, the `stellar` CLI, and the backend environment | **Manual**: `rustup target add wasm32-unknown-unknown`; install the `stellar` CLI; `npm run preflight`                | `stellar --version`, `rustc --version`, preflight output with no failures |
| S3  | Choose the network. Rehearse every step on testnet before mainnet                                         | **Manual**: pass `--network testnet` or `--network mainnet` to every `stellar` and manifest command                   | Network name, operator, date                                              |
| S4  | Identify the signer. It must be the contract's admin for upgrades                                         | **Manual**: `stellar keys address <signer>`; compare with the `admin` passed to `init` or the latest `adm_xfer` event | Signer public key and the transaction or event that made it admin         |

## Build and provenance

| ID  | Step                                                                                                                                 | How                                                                                                                                                             | Evidence to record                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| B1  | Compile and test the contracts at the release commit                                                                                 | `npm run contracts:check`, `npm run contracts:test`                                                                                                             | Commit SHA and the passing CI run URL                                                           |
| B2  | Pass the storage safety gate: compatibility, upgrade simulation, and release manifest validation                                     | `.github/workflows/contract-storage-safety.yml` (runs `scripts/check-storage-compat.ts`, `scripts/simulate-upgrade.ts`, `scripts/validate-release-manifest.ts`) | Green workflow run; `compat-report.json` and `simulation-report.json` artifacts                 |
| B3  | Declare any storage change in the migration registry                                                                                 | `contracts/migrations/registry.json`, `contracts/STORAGE_RECOVERY.md`                                                                                           | Registry entry ID, or "no storage change" from the compat report                                |
| B4  | Rebuild the WASM locally at the release tag, as a reproducibility check                                                              | `npm run contracts:build`                                                                                                                                       | `sha256sum contracts/target/wasm32-unknown-unknown/release/<contract>.wasm`                     |
| B5  | Verify the published release: signed SBOMs and provenance                                                                            | `scripts/verify-release.sh` (the release WASM, `spdx-contracts.spdx.json` and its signature come from `.github/workflows/sbom-provenance.yml`)                  | Script output for the tag, with all checks passing                                              |
| B6  | Fix the hash you will deploy: the release WASM asset, whose SHA-256 must match its checksum in the signed `spdx-contracts.spdx.json` | **Manual**: `sha256sum <contract>.wasm` on the downloaded asset; compare with the SBOM checksum and with B4                                                     | All three hashes. If B4 differs, the local toolchain differs from CI; resolve it before mainnet |

## Deploy a new contract instance

| ID  | Step                                                                                                           | How                                                                                                                                         | Evidence to record                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| D1  | Upload the WASM                                                                                                | **Manual**: `stellar contract upload --wasm <file> --source-account <signer> --network <net>`                                               | Upload transaction hash; printed WASM hash equals B6                                                     |
| D2  | Deploy an instance                                                                                             | **Manual**: `stellar contract deploy --wasm-hash <hash> --source-account <signer> --network <net>`                                          | Deploy transaction hash and the new contract ID                                                          |
| D3  | Initialize it immediately. `init` is a separate call, so anyone can initialize an uninitialized contract first | **Manual**: `stellar contract invoke --id <C> --source-account <signer> --network <net> -- init ...`                                        | Init transaction hash. If `init` fails with "already initialized", discard the instance and deploy again |
| D4  | Check the on-chain code                                                                                        | **Manual**: `stellar contract fetch --id <C> --network <net> -o onchain.wasm`, then `sha256sum onchain.wasm`                                | Hash equals B6                                                                                           |
| D5  | Publish the signed deployment manifest                                                                         | `npm run contracts:manifest -- publish --network <net> --contract <name> --contract-id <C> --wasm-hash <hash> --interface-version <semver>` | The manifest file under `MANIFEST_DIR` and its signature                                                 |
| D6  | Point the backend at the new contract                                                                          | `docs/ENVIRONMENT_VARIABLES.md` (`*_CONTRACT_ID`, `TESTNET_*`, `PUBLIC_*`)                                                                  | Pull request or deployment change that sets the variable                                                 |
| D7  | Confirm the backend accepts the identity                                                                       | `npm run contracts:manifest -- show --network <net> --contract <name>`; start the backend with `MANIFEST_ENFORCEMENT` unset                 | `show` output; startup log without a manifest error                                                      |

Signing key for D5: generate an Ed25519 key in PKCS#8 PEM format with
`openssl genpkey -algorithm ed25519 -out <file>` and pass its contents in
`MANIFEST_SIGNING_KEY`. Store it in the secret manager, never in the
repository. `manifest-cli keygen` currently writes an OpenSSH-format key that
`publish` rejects, and prints the private key to the terminal; do not use it
for real keys.

## Upgrade `core_vault`

| ID  | Step                                                                          | How                                                                                                                                                               | Evidence to record                                          |
| --- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| U1  | Complete S1 to S4 and B1 to B6 for the new code, then upload it               | **Manual**: D1 for the new WASM                                                                                                                                   | New WASM hash, equal to B6                                  |
| U2  | Record the code being replaced, so you can roll back                          | **Manual**: `stellar contract fetch --id <C> --network <net> -o previous.wasm`, then `sha256sum previous.wasm`                                                    | Previous WASM hash                                          |
| U3  | Propose the upgrade. This starts the delay and puts the vault in upgrade mode | **Manual**: `stellar contract invoke --id <C> --source-account <admin> --network <net> -- propose_upgrade --new_wasm_hash <hash>`                                 | Transaction hash and the `upg_prop` event                   |
| U4  | Record the unlock ledger                                                      | **Manual**: `stellar contract invoke --id <C> --network <net> -- upgrade_unlock_ledger`                                                                           | Unlock ledger number                                        |
| U5  | Review during the delay. Cancel if anything is wrong (R1)                     | **Manual**: a second reviewer checks the proposed hash against B6 and the B2 reports                                                                              | Reviewer sign-off                                           |
| U6  | Wait until the network passes the unlock ledger                               | **Manual**: `stellar ledger latest --network <net>`                                                                                                               | Latest ledger number, at least the unlock ledger            |
| U7  | Apply the upgrade                                                             | **Manual**: `stellar contract invoke --id <C> --source-account <signer> --network <net> -- apply_upgrade`                                                         | Transaction hash and the `upg_done` event with the new hash |
| U8  | Check the on-chain code                                                       | **Manual**: D4                                                                                                                                                    | Hash equals the new WASM hash                               |
| U9  | Run the declared storage migration, if B3 declared one                        | `contracts/migrations/registry.json` (`migrationInvocation`)                                                                                                      | Migration transaction hash                                  |
| U10 | Rotate the deployment manifest                                                | `npm run contracts:manifest -- rotate --network <net> --contract core_vault --contract-id <C> --wasm-hash <hash> --interface-version <semver> --notes "<reason>"` | The new rotation entry                                      |
| U11 | Confirm the backend accepts the new identity                                  | D7                                                                                                                                                                | `show` output; startup log without a manifest error         |

While an upgrade is pending, `is_upgrade_mode` returns `true` and
`set_backend_status` is refused. Deposits and withdrawals keep working.

## Rollback boundaries

| ID  | Step                                                                                                | How                                                                                                       | Evidence to record                                                                |
| --- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| R1  | Abort before U7. Nothing has changed on chain except the pending proposal                           | **Manual**: `stellar contract invoke --id <C> --source-account <admin> --network <net> -- cancel_upgrade` | Transaction hash, the `upg_cncl` event, and `upgrade_unlock_ledger` returning `0` |
| R2  | Roll back after U7 by upgrading again to the previous hash from U2. This takes the full delay again | **Manual**: U3 to U8 with the U2 hash                                                                     | Same evidence as U3 to U8                                                         |
| R3  | Check that the previous code can read the new state before R2                                       | `scripts/simulate-upgrade.ts` with the previous schema as the proposed schema                             | Simulation report for the rollback direction                                      |
| R4  | Point the manifest back at the previous code                                                        | `npm run contracts:manifest -- rotate ...` with the previous hash                                         | The new rotation entry                                                            |
| R5  | Roll back a new deployment (D1 to D7) by moving the backend back to the old contract ID             | `docs/ENVIRONMENT_VARIABLES.md` (`*_CONTRACT_ID`)                                                         | The configuration change                                                          |

What cannot be rolled back:

- **State written by the new code.** R2 restores the code, not the data.
  Entries the new code wrote in a new format stay in that format; R3 is how you
  find out whether the old code can still read them.
- **Storage migrations.** The registry is forward-only. Undo a migration with
  a new forward migration, not by reverting.
- **Funds and events.** Transfers made under the new code and emitted events
  are permanent.
- **A new instance's state.** After R5 the old instance does not see deposits
  made to the new one. Plan how users withdraw from the abandoned instance.
- **Emergencies.** No proposal, including a rollback, can be made while an
  emergency is active.

## Related documents

- [`contracts/AUDIT_README.md`](../contracts/AUDIT_README.md): audit scope
- [`contracts/STORAGE_RECOVERY.md`](../contracts/STORAGE_RECOVERY.md): storage TTL and expiry recovery
- [`DISASTER_RECOVERY.md`](../DISASTER_RECOVERY.md): backend recovery
- [Environment variables](ENVIRONMENT_VARIABLES.md): contract ID and manifest configuration
