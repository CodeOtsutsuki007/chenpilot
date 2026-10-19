# Bridge Accounting Integration Guide

**Related Issue**: #858  
**Implementation Files**: See [ISSUE_858_IMPLEMENTATION.md](archive/implementation-reports/858-in-transit-bridge-accounting/ISSUE_858_IMPLEMENTATION.md) (archived report)

This guide helps developers integrate the in-transit bridge accounting model into portfolio services, APIs, and UIs.

## Quick Start

### 1. Basic Usage

```typescript
import { 
  computePartitionedHoldings,
  verifyConservationInvariant,
  BridgeTransferState,
  type BridgeTransferRecord,
  type PartitionedPortfolioHoldings
} from '../src/domain/execution/bridgeAccountingModel';

// Fetch user's balances and active bridge transfers
const stellarBalances = await fetchStellarBalances(userId);
const starknetBalances = await fetchStarknetBalances(userId);
const bridgeTransfers = await fetchActiveBridgeTransfers(userId);

// Compute partitioned holdings
const holdings = computePartitionedHoldings(
  userId,
  stellarBalances,
  starknetBalances,
  bridgeTransfers,
  'USD'
);

// Verify conservation (defensive check)
const check = verifyConservationInvariant(holdings);
if (!check.holds) {
  logger.error('Conservation violated:', check.errors);
}

// Use partitioned data
console.log('Available:', holdings.sourceChainHoldings);
console.log('In-Transit:', holdings.inTransitHoldings);
console.log('Destination:', holdings.destinationChainHoldings);
console.log('Total:', holdings.totalHoldings);
```

### 2. Portfolio Service Integration

Extend the existing `PortfolioService` to include bridge accounting:

```typescript
// src/services/portfolioService.ts

import {
  computePartitionedHoldings,
  verifyConservationInvariant,
  type BridgeTransferRecord,
  type PartitionedPortfolioHoldings
} from '../domain/execution/bridgeAccountingModel';

export interface PortfolioWithBridge extends PortfolioSummary {
  /** Holdings partitioned by accounting location */
  partitioned: PartitionedPortfolioHoldings;
  /** Active bridge transfers */
  activeBridgeTransfers: BridgeTransferRecord[];
  /** Conservation check result */
  conservationValid: boolean;
}

export class PortfolioService {
  // ... existing methods ...

  /**
   * Get portfolio with bridge accounting (prevents double-counting during transfers)
   */
  async getPortfolioWithBridge(
    address: string,
    currency: string = 'USD'
  ): Promise<PortfolioWithBridge> {
    // Fetch base portfolio (existing method)
    const basePortfolio = await this.getPortfolio(address, currency);
    
    // Fetch active bridge transfers for this address
    const activeBridgeTransfers = await this.fetchActiveBridgeTransfers(address);
    
    // Get balances from multiple chains
    const stellarBalances = await this.fetchStellarBalances(address);
    const starknetBalances = await this.fetchStarknetBalances(address);
    
    // Compute partitioned holdings
    const partitioned = computePartitionedHoldings(
      address,
      stellarBalances,
      starknetBalances,
      activeBridgeTransfers,
      currency
    );
    
    // Verify conservation
    const conservationCheck = verifyConservationInvariant(partitioned);
    
    if (!conservationCheck.holds) {
      logger.warn('Portfolio conservation violated', {
        address,
        errors: conservationCheck.errors
      });
    }
    
    return {
      ...basePortfolio,
      partitioned,
      activeBridgeTransfers,
      conservationValid: conservationCheck.holds
    };
  }

  private async fetchActiveBridgeTransfers(
    address: string
  ): Promise<BridgeTransferRecord[]> {
    // TODO: Query bridge_transfers table
    // SELECT * FROM bridge_transfers 
    // WHERE user_address = $1 
    // AND state IN ('locked', 'proof_generated', 'validators_signed')
    return [];
  }
  
  private async fetchStellarBalances(address: string) {
    // Existing Stellar balance fetch logic
    const account = await this.server.accounts().accountId(address).call();
    return account.balances.map(b => ({
      chain: 'stellar',
      assetCode: b.asset_type === 'native' ? 'XLM' : b.asset_code,
      assetIssuer: b.asset_type === 'native' ? '' : b.asset_issuer,
      amount: b.balance
    }));
  }
  
  private async fetchStarknetBalances(address: string) {
    // TODO: Implement StarkNet balance fetch
    return [];
  }
}
```

### 3. API Endpoint Example

```typescript
// routes/portfolio.ts

import { portfolioService } from '../services/portfolioService';

router.get('/portfolio/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const { currency = 'USD', includeBridge = 'true' } = req.query;
    
    if (includeBridge === 'true') {
      const portfolio = await portfolioService.getPortfolioWithBridge(
        address,
        currency as string
      );
      
      res.json({
        address: portfolio.address,
        currency: portfolio.currency,
        totalValue: portfolio.totalValue,
        holdings: {
          source: portfolio.partitioned.sourceChainHoldings,
          inTransit: portfolio.partitioned.inTransitHoldings,
          destination: portfolio.partitioned.destinationChainHoldings,
          total: portfolio.partitioned.totalHoldings
        },
        activeBridgeTransfers: portfolio.activeBridgeTransfers,
        metadata: {
          conservationValid: portfolio.conservationValid,
          fetchedAt: portfolio.fetchedAt
        }
      });
    } else {
      // Existing portfolio endpoint (backwards compatible)
      const portfolio = await portfolioService.getPortfolio(
        address,
        currency as string
      );
      res.json(portfolio);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

### 4. Invariant System Integration

Extend the invariant evaluation to be bridge-aware:

```typescript
// src/services/invariantEngine.ts

import {
  computePartitionedHoldings,
  type BridgeTransferRecord
} from '../domain/execution/bridgeAccountingModel';

export interface BridgeAwareInvariantContext extends InvariantEvaluationContext {
  /** Active bridge transfers for this evaluation */
  bridgeTransfers?: BridgeTransferRecord[];
}

/**
 * Evaluate ASSET_BALANCE_MATCH with bridge transfer awareness.
 * 
 * When bridge transfers are provided, adjusts on-chain balances to exclude
 * in-transit amounts before comparing with backend balances.
 */
function evaluateAssetBalanceMatchWithBridge(
  ctx: BridgeAwareInvariantContext,
  def: InvariantDefinition
): InvariantResult {
  // If no bridge transfers, use standard evaluation
  if (!ctx.bridgeTransfers || ctx.bridgeTransfers.length === 0) {
    return evaluateAssetBalanceMatch(ctx, def);
  }
  
  // Compute partitioned holdings
  const sourceBalances = ctx.onChainBalances.map(b => ({
    chain: 'stellar', // TODO: detect chain from context
    assetCode: b.assetCode,
    assetIssuer: '',
    amount: b.balance
  }));
  
  const partitioned = computePartitionedHoldings(
    'current_user',
    sourceBalances,
    [],
    ctx.bridgeTransfers
  );
  
  // Now compare backend balances against source holdings (not raw on-chain)
  const driftSources: string[] = [];
  let totalDelta = 0;
  let mismatchedAssets = 0;
  
  for (const bb of ctx.backendBalances) {
    const backendAmt = parseFloat(bb.balance);
    const sourceHolding = partitioned.sourceChainHoldings.find(
      h => h.assetCode === bb.assetCode
    );
    
    if (!sourceHolding || !Number.isFinite(backendAmt)) continue;
    
    const delta = Math.abs(backendAmt - sourceHolding.numericAmount);
    if (delta > 0.000001) {
      driftSources.push(bb.assetCode);
      mismatchedAssets++;
      totalDelta += delta;
    }
  }
  
  const holds = mismatchedAssets === 0;
  
  return {
    invariantId: def.id,
    invariantName: def.name + ' (Bridge-Aware)',
    category: def.category,
    holds,
    status: holds ? 'passing' : 'failing',
    dataAvailable: true,
    expectedValue: `Backend balances match source holdings (excluding in-transit)`,
    actualValue: mismatchedAssets > 0
      ? `${mismatchedAssets} asset(s) differ by ${totalDelta.toFixed(8)}`
      : 'All match',
    attributableDifference: totalDelta > 0 ? totalDelta.toFixed(8) : '0',
    lagExceeded: false,
    driftSources,
    evaluatedAt: new Date(ctx.evaluationTimestampMs).toISOString(),
    repairSafety: def.repairSafety
  };
}
```

## Database Schema

Add the following table to track bridge transfers:

```sql
CREATE TABLE bridge_transfers (
  transfer_id VARCHAR(64) PRIMARY KEY,
  bridge_operation_id VARCHAR(64) NOT NULL,
  user_address VARCHAR(128) NOT NULL,
  source_chain VARCHAR(32) NOT NULL,
  destination_chain VARCHAR(32) NOT NULL,
  asset_code VARCHAR(12) NOT NULL,
  asset_issuer VARCHAR(128) DEFAULT '',
  amount DECIMAL(24, 7) NOT NULL,
  state VARCHAR(32) NOT NULL,
  source_transaction_hash VARCHAR(128),
  destination_transaction_hash VARCHAR(128),
  bridge_proof TEXT,
  validator_signature_count INTEGER DEFAULT 0,
  initiated_at TIMESTAMP NOT NULL,
  state_updated_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_user_state (user_address, state),
  INDEX idx_state (state),
  INDEX idx_bridge_operation (bridge_operation_id)
);

-- Check constraint for valid states
ALTER TABLE bridge_transfers
ADD CONSTRAINT chk_state CHECK (
  state IN ('initiated', 'locked', 'proof_generated', 
            'validators_signed', 'minted', 'failed')
);
```

Query for active transfers:

```sql
SELECT * FROM bridge_transfers
WHERE user_address = $1
AND state IN ('locked', 'proof_generated', 'validators_signed')
ORDER BY initiated_at DESC;
```

## UI Components

### Portfolio Display

```typescript
// components/PortfolioView.tsx

interface Props {
  portfolio: PortfolioWithBridge;
}

export function PortfolioView({ portfolio }: Props) {
  const { partitioned, activeBridgeTransfers, conservationValid } = portfolio;
  
  return (
    <div>
      <h2>Portfolio Overview</h2>
      
      {/* Total Value */}
      <div className="total-value">
        <h3>Total Value</h3>
        <p>${portfolio.totalValue?.toFixed(2) ?? 'N/A'}</p>
      </div>
      
      {/* Available Holdings */}
      <section>
        <h3>Available Holdings (Source Chain)</h3>
        <AssetList assets={partitioned.sourceChainHoldings} />
      </section>
      
      {/* In-Transit Holdings */}
      {partitioned.inTransitHoldings.length > 0 && (
        <section className="in-transit">
          <h3>
            In-Transit (Bridging)
            <span className="badge">{partitioned.inTransitHoldings.length}</span>
          </h3>
          <AssetList assets={partitioned.inTransitHoldings} />
          <BridgeTransferList transfers={activeBridgeTransfers} />
        </section>
      )}
      
      {/* Destination Holdings */}
      {partitioned.destinationChainHoldings.length > 0 && (
        <section>
          <h3>Destination Chain Holdings</h3>
          <AssetList assets={partitioned.destinationChainHoldings} />
        </section>
      )}
      
      {/* Conservation Warning */}
      {!conservationValid && (
        <div className="warning">
          ⚠️ Portfolio accounting issue detected. Please contact support.
        </div>
      )}
    </div>
  );
}

function BridgeTransferList({ transfers }: { transfers: BridgeTransferRecord[] }) {
  return (
    <ul className="bridge-transfers">
      {transfers.map(transfer => (
        <li key={transfer.transferId}>
          <div className="transfer-info">
            <span className="asset">{transfer.amount} {transfer.assetCode}</span>
            <span className="route">
              {transfer.sourceChain} → {transfer.destinationChain}
            </span>
            <span className={`state ${transfer.state}`}>
              {formatState(transfer.state)}
            </span>
          </div>
          <div className="transfer-meta">
            <small>
              {transfer.validatorSignatureCount} validators signed
              · {formatTimestamp(transfer.initiatedAt)}
            </small>
          </div>
        </li>
      ))}
    </ul>
  );
}

function formatState(state: string): string {
  return state.split('_').map(w => 
    w.charAt(0).toUpperCase() + w.slice(1)
  ).join(' ');
}
```

## Testing Integration

### Test Bridge Transfers in Your Tests

```typescript
// __tests__/portfolioService.bridge.test.ts

import { portfolioService } from '../src/services/portfolioService';
import { BridgeTransferState } from '../src/domain/execution/bridgeAccountingModel';

describe('PortfolioService with Bridge Accounting', () => {
  it('excludes in-transit amounts from available balance', async () => {
    const address = 'GTEST123...';
    
    // Mock: 1000 XLM on Stellar, 300 in-transit
    mockStellarBalance(address, 'XLM', '1000.0000000');
    mockActiveBridgeTransfer(address, {
      assetCode: 'XLM',
      amount: '300.0000000',
      state: BridgeTransferState.LOCKED
    });
    
    const portfolio = await portfolioService.getPortfolioWithBridge(address);
    
    const xlmSource = portfolio.partitioned.sourceChainHoldings.find(
      h => h.assetCode === 'XLM'
    );
    const xlmInTransit = portfolio.partitioned.inTransitHoldings.find(
      h => h.assetCode === 'XLM'
    );
    
    expect(xlmSource?.numericAmount).toBe(700); // 1000 - 300
    expect(xlmInTransit?.numericAmount).toBe(300);
    expect(portfolio.conservationValid).toBe(true);
  });
});
```

## Monitoring and Alerts

### Key Metrics to Track

1. **Conservation Violations**
   ```typescript
   if (!verifyConservationInvariant(holdings).holds) {
     metrics.increment('portfolio.conservation_violation');
     alerts.send('Portfolio conservation violated', { userId, holdings });
   }
   ```

2. **Stale In-Transit Transfers**
   ```typescript
   const staleTransfers = activeBridgeTransfers.filter(t => 
     Date.now() - t.initiatedAt > 3600000 // 1 hour
   );
   if (staleTransfers.length > 0) {
     metrics.gauge('bridge.stale_transfers', staleTransfers.length);
   }
   ```

3. **Double-Counting Risks**
   ```typescript
   const risks = detectDoubleCountingRisks(holdings);
   if (risks.length > 0) {
     metrics.increment('portfolio.double_count_risk');
     logger.warn('Double-counting risk detected', { risks });
   }
   ```

## Troubleshooting

### Issue: Conservation invariant fails

**Symptom**: `verifyConservationInvariant()` returns `holds: false`

**Possible causes**:
1. Stale balance data (source/destination out of sync)
2. Missing bridge transfer records
3. Duplicate bridge transfer records
4. Numerical precision issues

**Solution**:
```typescript
const check = verifyConservationInvariant(holdings);
if (!check.holds) {
  console.error('Conservation errors:', check.errors);
  
  // Re-fetch fresh data
  const freshHoldings = await refetchPortfolio(userId);
  const recheckCheck = verifyConservationInvariant(freshHoldings);
  
  if (!recheck.holds) {
    // Persistent issue - alert and investigate
    alerts.critical('Persistent conservation violation', { userId, errors: recheck.errors });
  }
}
```

### Issue: In-transit amount exceeds source balance

**Symptom**: Source balance becomes 0 or negative

**Cause**: Race condition or stale on-chain data

**Solution**: The `computePartitionedHoldings` function clamps source to 0, preventing negative balances. Monitor for this condition:

```typescript
if (sourceBalance - inTransitSum < 0) {
  logger.warn('In-transit exceeds source balance', {
    asset: assetCode,
    sourceBalance,
    inTransitSum,
    transfers: bridgeTransfers
  });
}
```

## Performance Considerations

1. **Cache bridge transfers**: Active transfers change infrequently
   ```typescript
   const cacheKey = `bridge:transfers:${userId}`;
   let transfers = await cache.get(cacheKey);
   if (!transfers) {
     transfers = await fetchActiveBridgeTransfers(userId);
     await cache.set(cacheKey, transfers, 60); // 60 second TTL
   }
   ```

2. **Batch balance fetches**: Fetch all chains in parallel
   ```typescript
   const [stellar, starknet] = await Promise.all([
     fetchStellarBalances(address),
     fetchStarknetBalances(address)
   ]);
   ```

3. **Index database queries**: See database schema indexes above

## Checklist for Integration

- [ ] Database table `bridge_transfers` created
- [ ] `fetchActiveBridgeTransfers()` method implemented
- [ ] `getPortfolioWithBridge()` method added to PortfolioService
- [ ] API endpoint updated to support `?includeBridge=true`
- [ ] UI updated to show in-transit holdings
- [ ] Invariant system extended with bridge awareness
- [ ] Tests added for bridge accounting scenarios
- [ ] Monitoring and alerts configured
- [ ] Documentation updated

## Support

For questions or issues:
- Review `BRIDGE_ACCOUNTING_DESIGN.md` for architectural details
- Check `src/services/__tests__/invariantReconciliation.test.ts` for test examples
- See `src/domain/execution/bridgeAccountingModel.ts` for API documentation

---

**Next**: See `BRIDGE_ACCOUNTING_DESIGN.md` for comprehensive architecture documentation.
