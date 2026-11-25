# Quorum Read Service

The `QuorumReadService` (`quorumRead.service.ts`) provides consensus-based reads for security-critical chain state: account balances, sequence numbers, Soroban contract state, and transaction status.

## Purpose

A single Horizon or Soroban RPC provider can be unavailable, return stale data, or be compromised. Quorum reads query multiple independent providers in parallel and only accept a value when at least `minQuorumSize` providers agree. This prevents any single provider failure — or delayed/stale response — from corrupting the application's view of on-chain state.

---

## Supported Behavior

### Normal path

1. All providers in `getProvidersForQuorum()` are queried concurrently via `Promise.all`.
2. Each individual query races against `providerTimeoutMs` to enforce a per-provider deadline.
3. Responses with `timestamp` older than `maxResponseAgeMs` are discarded before counting toward quorum.
4. The remaining responses are grouped by their normalized value. The **most recent response** (highest `timestamp`) is kept as the representative value for each group.
5. The group with the highest vote count wins. If two groups are tied on vote count, the group whose newest response has the higher `timestamp` wins (fresher data takes precedence).
6. If the winning group has `count >= minQuorumSize`, quorum is achieved and that value is returned.

### Concurrent response ordering (key invariant)

When multiple providers respond concurrently — especially when some are slower than others — their responses arrive out of order. The ordering rule is:

> **Within the winning majority group, the value returned to the caller always comes from the response with the highest `timestamp`. An older observation can never replace a newer one, regardless of the order in which responses arrive.**

This is enforced inside `groupByValue`: as each response is added to a group, the group's representative value is updated only when the incoming response carries a strictly higher `timestamp`.

Tie-breaking on vote count additionally favours the group with the fresher `newestTimestamp`, preventing a large set of stale responses from out-voting a smaller set of fresh ones when counts happen to be equal.

---

## Failure Cases

| Scenario | Behaviour |
|---|---|
| Fewer than `minQuorumSize` providers respond successfully | Throws `QuorumReadException(INSUFFICIENT_PROVIDERS)` when `failClosedOnDivergence=true`; returns `quorumAchieved: false` otherwise |
| All providers fail (timeout, error) | Throws `QuorumReadException(ALL_PROVIDERS_FAILED)` |
| Providers return divergent values, no majority | Throws `QuorumReadException(DIVERGENT_RESPONSES)` when `failClosedOnDivergence=true` |
| Two majority groups are vote-tied with identical `newestTimestamp` | Throws `QuorumReadException(DIVERGENT_RESPONSES)` — this is a genuine split-brain |
| A response's `timestamp` exceeds `maxResponseAgeMs` | The response is discarded (value set to `null`) and the provider's health is penalised |
| A provider exceeds `providerTimeoutMs` | The race resolves with an error; provider health is penalised |
| All timestamps are `0` (clock failure) | Quorum proceeds; ordering within the group falls back to insertion order |

---

## Compatibility Requirements

### Configuration

| Field | Type | Default | Notes |
|---|---|---|---|
| `minQuorumSize` | `number` | `2` | Must be ≤ `totalProviders` |
| `totalProviders` | `number` | `3` | Total providers configured |
| `providerTimeoutMs` | `number` | `5000` | Per-provider deadline |
| `maxResponseAgeMs` | `number` | `30000` | Staleness cutoff |
| `failClosedOnDivergence` | `boolean` | `true` | Throw on divergence (recommended for all protected categories) |
| `protectedCategories` | `ChainStateCategory[]` | all four | Only protected categories perform quorum reads |

### Provider health invariant

Health scoring never reduces the active provider pool below `minQuorumSize`. If fewer than `minQuorumSize` providers are marked healthy, **all** providers (including unhealthy ones) are still queried. This prevents the health system from inadvertently weakening the consensus threshold.

### `ProviderResponse<T>` contract

Every `fetchFn` passed to `readQuorum` must return a `ProviderResponse<T>` where:
- `value` is the actual chain state value, or `null` on failure.
- `timestamp` is the wall-clock time (ms since epoch) at which the response was received. It is used for staleness checks **and** for ordering within a majority group. Providers that do not set `timestamp` will use `0`, which causes them to always lose timestamp-based tie-breaking.

---

## Operational Notes

- Set `failClosedOnDivergence: true` for all production deployments of `balance`, `sequence_number`, `contract_state`, and `transaction_status`.
- Use at least three independent providers in production so a single provider failure still leaves two to form quorum.
- Monitor `ProviderHealthService.getHealthSummary().quorumMaintained`. Alert when this is `false`.
- If a provider's clock is skewed significantly, its responses will carry stale `timestamp` values and may be discarded by the `maxResponseAgeMs` check. Ensure NTP is configured on all provider hosts.

---

## Tests

`tests/unit/quorumRead.test.ts` covers:

- Basic quorum consensus (3/3 and 2/3 agreement)
- Stale response rejection and acceptance within threshold
- Byzantine (conflicting) response handling
- Provider timeouts
- Malformed / null responses
- Health scoring and invariant enforcement
- Category protection
- Normalized value comparison (strings, numbers)
- **Concurrent response ordering** — older observations cannot replace newer cached data:
  - Newest timestamp wins within the majority group
  - Equal timestamp on two agreeing providers does not cause a spurious tie-break error
  - Degenerate case: all timestamps `0` still achieves quorum
