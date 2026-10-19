import * as StellarSdk from "@stellar/stellar-sdk";
import config from "../config/config";
import logger from "../config/logger";
import priceCacheService, {
  PRICE_MAX_AGE_MS,
  type PriceAssetIdentity,
} from "./priceCache.service";
import { multiHopPathFinder } from "./multiHopPathFinder";
import {
  priceFeedCircuitBreaker,
  CircuitState,
} from "../Execution/circuitBreaker";

export type { PriceAssetIdentity };

// ---------------------------------------------------------------------------
// QuoteValidity — the contract callers must check before acting on a quote
// ---------------------------------------------------------------------------

export type QuoteInvalidReason =
  | "stale"
  | "no_liquidity"
  | "fetch_error"
  | "unsupported_asset"
  /**
   * The caller named an issuer that does not issue the asset this service
   * prices. Pricing it anyway would attribute one issuer's asset to another.
   */
  | "issuer_mismatch";

export interface QuoteValidity {
  valid: boolean;
  reason?: QuoteInvalidReason;
  /** Age of the underlying price data in ms. */
  ageMs: number;
  /** Timestamp when this quote expires (ms since epoch). */
  expiresAt: number;
}

export interface PriceQuote {
  fromAsset: string;
  toAsset: string;
  price: number;
  amount: number;
  estimatedOutput: number;
  path?: string[];
  cached: boolean;
  timestamp: number;
  validity: QuoteValidity;
  /**
   * Issuer of the source asset, resolved from the asset this quote was
   * actually priced against (absent for the native asset). Present whenever
   * the asset identity could be resolved, so a code-only caller still learns
   * which issuer the price belongs to.
   */
  fromIssuer?: string;
  /** Issuer of the destination asset; absent for the native asset. */
  toIssuer?: string;
  multiHopAnalysis?: {
    totalPathsFound: number;
    bestPathHops: number;
    /** Normalized 0–1 efficiency score. */
    efficiency: number;
  };
}

/**
 * Raised when a caller asks for a price under an issuer that does not match
 * the asset the price service actually resolves for that code.
 */
export class AssetIssuerMismatchError extends Error {
  readonly assetCode: string;
  readonly requestedIssuer: string;
  readonly actualIssuer: string;

  constructor(assetCode: string, requestedIssuer: string, actualIssuer: string) {
    super(
      `Asset ${assetCode} is issued by ${actualIssuer || "nobody (native)"}, not ${requestedIssuer}`
    );
    this.name = "AssetIssuerMismatchError";
    this.assetCode = assetCode;
    this.requestedIssuer = requestedIssuer;
    this.actualIssuer = actualIssuer;
  }
}

// ---------------------------------------------------------------------------

const SUPPORTED_ASSETS: Record<string, StellarSdk.Asset> = {
  XLM: StellarSdk.Asset.native(),
  USDC: new StellarSdk.Asset(
    "USDC",
    "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
  ),
  USDT: new StellarSdk.Asset(
    "USDT",
    "GCQTGZQQ5G4PTM2GL7CDIFKUBIPEC52BROAQIAPW53XBRJVN6ZJVTG6V"
  ),
};

/** Issuer of an asset, or undefined for the native asset. */
function issuerOf(asset: StellarSdk.Asset): string | undefined {
  if (asset.isNative()) return undefined;
  const issuer = asset.getIssuer();
  return issuer ? issuer : undefined;
}

/** The issuer fields actually present, so quotes stay minimal. */
function resolvedIdentity(
  fromAsset?: StellarSdk.Asset,
  toAsset?: StellarSdk.Asset
): PriceAssetIdentity {
  const identity: PriceAssetIdentity = {};
  const fromIssuer = fromAsset ? issuerOf(fromAsset) : undefined;
  const toIssuer = toAsset ? issuerOf(toAsset) : undefined;
  if (fromIssuer) identity.fromIssuer = fromIssuer;
  if (toIssuer) identity.toIssuer = toIssuer;
  return identity;
}

function makeValidity(
  ageMs: number,
  valid: boolean,
  reason?: QuoteInvalidReason
): QuoteValidity {
  return {
    valid,
    reason,
    ageMs,
    expiresAt: Date.now() - ageMs + PRICE_MAX_AGE_MS,
  };
}

export class StellarPriceService {
  private server: StellarSdk.Horizon.Server;
  private readonly CACHE_TTL = 60;

  constructor() {
    this.server = new StellarSdk.Horizon.Server(config.stellar.horizonUrl);
  }

  /**
   * Resolve a symbol to the asset this service prices, verifying issuer
   * identity when the caller supplies one.
   *
   * @throws {Error} when the symbol is unknown.
   * @throws {AssetIssuerMismatchError} when the caller names an issuer other
   * than the one that actually issues the asset behind that symbol.
   */
  private getAsset(symbol: string, issuer?: string): StellarSdk.Asset {
    const asset = SUPPORTED_ASSETS[symbol.toUpperCase()];
    if (!asset) throw new Error(`Unsupported asset: ${symbol}`);

    const requestedIssuer = issuer?.trim();
    if (requestedIssuer) {
      const actualIssuer = issuerOf(asset);
      if (actualIssuer !== requestedIssuer) {
        throw new AssetIssuerMismatchError(
          symbol.toUpperCase(),
          requestedIssuer,
          actualIssuer ?? ""
        );
      }
    }
    return asset;
  }

  /**
   * Returns a price quote with an explicit `validity` contract.
   * Throws only on unsupported assets; all other failures produce an
   * invalid quote so callers can handle them deterministically.
   *
   * Stale cache is NEVER silently returned as a valid quote.
   *
   * `identity` carries the issuer of each side when the caller knows it. The
   * issuers are checked against the assets actually priced, so a holding from
   * one issuer is never priced — or cached — under another issuer's identity.
   */
  async getPrice(
    fromAsset: string,
    toAsset: string,
    amount: number = 1,
    identity: PriceAssetIdentity = {}
  ): Promise<PriceQuote> {
    // Validate assets up-front — this is the only hard throw.
    let sourceAsset: StellarSdk.Asset;
    let destAsset: StellarSdk.Asset;
    try {
      sourceAsset = this.getAsset(fromAsset, identity.fromIssuer);
      destAsset = this.getAsset(toAsset, identity.toIssuer);
    } catch (error) {
      return this.invalidQuote(
        fromAsset,
        toAsset,
        amount,
        error instanceof AssetIssuerMismatchError
          ? "issuer_mismatch"
          : "unsupported_asset",
        0,
        identity
      );
    }

    const assetIdentity = resolvedIdentity(sourceAsset, destAsset);

    // Check cache — only use if fresh. The cache is keyed by the issuer
    // identity the caller supplied, so entries never cross issuers.
    const cached = await priceCacheService.getPrice(fromAsset, toAsset, identity);
    if (cached?.fresh) {
      return {
        fromAsset,
        toAsset,
        price: cached.data.price,
        amount,
        estimatedOutput: amount * cached.data.price,
        cached: true,
        timestamp: cached.data.timestamp,
        validity: makeValidity(cached.ageMs, true),
        ...assetIdentity,
      };
    }

    // Fetch live price from Stellar DEX with circuit breaker protection
    try {
      const assetPair = `${fromAsset}/${toAsset}`;

      // Check circuit breaker state
      if (!priceFeedCircuitBreaker.allowExecution()) {
        logger.warn(`Circuit breaker is ${priceFeedCircuitBreaker.getState()} for ${assetPair}`);
        return this.invalidQuote(
          fromAsset,
          toAsset,
          amount,
          "fetch_error",
          0,
          identity
        );
      }

      const paths = await this.server
        .strictSendPaths(sourceAsset, amount.toFixed(7), [destAsset])
        .call();

      if (!paths.records || paths.records.length === 0) {
        logger.warn(`No liquidity path found for ${fromAsset}/${toAsset}`);
        priceFeedCircuitBreaker.recordFailure("No liquidity path found");
        return this.invalidQuote(
          fromAsset,
          toAsset,
          amount,
          "no_liquidity",
          0,
          identity
        );
      }

      const bestPath = paths.records[0];
      const destAmount = parseFloat(bestPath.destination_amount);
      const price = destAmount / amount;

      // Detect price anomalies
      const anomalyDetection = priceFeedCircuitBreaker.detectAnomaly(
        assetPair,
        price
      );

      if (anomalyDetection.isAnomalous) {
        logger.warn(`Price anomaly detected for ${assetPair}: ${anomalyDetection.reason}`);
        priceFeedCircuitBreaker.recordFailure(
          anomalyDetection.reason || "Price anomaly detected"
        );
        return this.invalidQuote(
          fromAsset,
          toAsset,
          amount,
          "fetch_error",
          0,
          identity
        );
      }

      await priceCacheService.setPrice(
        fromAsset,
        toAsset,
        price,
        "stellar_dex",
        this.CACHE_TTL,
        identity
      );

      // Record success in circuit breaker
      priceFeedCircuitBreaker.recordSuccess(price, assetPair);

      const pathAssets = bestPath.path.map(
        (a: { asset_type: string; asset_code: string }) =>
          a.asset_type === "native" ? "XLM" : a.asset_code
      );

      logger.info(`Fetched live price ${fromAsset}/${toAsset} = ${price}`);

      return {
        fromAsset,
        toAsset,
        price,
        amount,
        estimatedOutput: destAmount,
        path: [fromAsset, ...pathAssets, toAsset],
        cached: false,
        timestamp: Date.now(),
        validity: makeValidity(0, true),
        ...assetIdentity,
      };
    } catch (error) {
      logger.error("Error fetching price from Stellar DEX:", error);
      priceFeedCircuitBreaker.recordFailure(
        error instanceof Error ? error.message : String(error)
      );
      return this.invalidQuote(
        fromAsset,
        toAsset,
        amount,
        "fetch_error",
        0,
        identity
      );
    }
  }

  /**
   * Batch price fetch. Each quote carries its own validity — callers must
   * filter on `quote.validity.valid` before use. Pairs may carry issuer
   * identity, which is forwarded to {@link getPrice} unchanged.
   */
  async getPrices(
    pairs: Array<{ from: string; to: string; amount?: number } & PriceAssetIdentity>
  ): Promise<PriceQuote[]> {
    return Promise.all(
      pairs.map((p) =>
        this.getPrice(p.from, p.to, p.amount ?? 1, {
          fromIssuer: p.fromIssuer,
          toIssuer: p.toIssuer,
        })
      )
    );
  }

  async getOrderbookDepth(
    fromAsset: string,
    toAsset: string,
    limit: number = 20
  ): Promise<{
    bids: Array<{ price: number; amount: number }>;
    asks: Array<{ price: number; amount: number }>;
  }> {
    const sourceAsset = this.getAsset(fromAsset);
    const destAsset = this.getAsset(toAsset);

    const orderbook = await this.server
      .orderbook(sourceAsset, destAsset)
      .limit(limit)
      .call();

    return {
      bids: orderbook.bids.map((b) => ({
        price: parseFloat(b.price),
        amount: parseFloat(b.amount),
      })),
      asks: orderbook.asks.map((a) => ({
        price: parseFloat(a.price),
        amount: parseFloat(a.amount),
      })),
    };
  }

  async invalidatePrice(
    fromAsset: string,
    toAsset: string,
    identity?: PriceAssetIdentity
  ): Promise<void> {
    await priceCacheService.invalidatePrice(fromAsset, toAsset, identity);
  }

  /**
   * Multi-hop price with validity contract.
   * Returns an invalid quote (rather than throwing) when no path is found.
   *
   * `identity` is verified exactly as in {@link getPrice}.
   */
  async getPriceWithMultiHop(
    fromAsset: string,
    toAsset: string,
    amount: number = 1,
    maxHops: number = 5,
    identity: PriceAssetIdentity = {}
  ): Promise<PriceQuote> {
    let sourceAsset: StellarSdk.Asset;
    let destAsset: StellarSdk.Asset;
    try {
      sourceAsset = this.getAsset(fromAsset, identity.fromIssuer);
      destAsset = this.getAsset(toAsset, identity.toIssuer);
    } catch (error) {
      return this.invalidQuote(
        fromAsset,
        toAsset,
        amount,
        error instanceof AssetIssuerMismatchError
          ? "issuer_mismatch"
          : "unsupported_asset",
        0,
        identity
      );
    }

    try {
      const pathResult = await multiHopPathFinder.findOptimalPath(
        sourceAsset,
        destAsset,
        amount.toFixed(7),
        { maxHops }
      );

      const destAmount = parseFloat(pathResult.bestPath.destinationAmount);
      const price = destAmount / amount;

      return {
        fromAsset,
        toAsset,
        price,
        amount,
        estimatedOutput: destAmount,
        path: pathResult.bestPath.route,
        cached: false,
        timestamp: Date.now(),
        validity: makeValidity(0, true),
        ...resolvedIdentity(sourceAsset, destAsset),
        multiHopAnalysis: {
          totalPathsFound: pathResult.allPaths.length,
          bestPathHops: pathResult.bestPath.hops,
          efficiency: pathResult.bestPath.efficiency,
        },
      };
    } catch (error) {
      logger.error("Error fetching multi-hop price:", error);
      return this.invalidQuote(
        fromAsset,
        toAsset,
        amount,
        "fetch_error",
        0,
        identity
      );
    }
  }

  private invalidQuote(
    fromAsset: string,
    toAsset: string,
    amount: number,
    reason: QuoteInvalidReason,
    ageMs: number,
    identity?: PriceAssetIdentity
  ): PriceQuote {
    return {
      fromAsset,
      toAsset,
      price: 0,
      amount,
      estimatedOutput: 0,
      cached: false,
      timestamp: Date.now(),
      validity: makeValidity(ageMs, false, reason),
      ...(identity?.fromIssuer ? { fromIssuer: identity.fromIssuer } : {}),
      ...(identity?.toIssuer ? { toIssuer: identity.toIssuer } : {}),
    };
  }
}

export default new StellarPriceService();
