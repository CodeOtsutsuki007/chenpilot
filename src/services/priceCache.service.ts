import { getRedisClient, healthCheckRedis } from "./redis/client";
import logger from "../config/logger";

export interface PriceData {
  price: number;
  timestamp: number;
  source: string;
}

/**
 * Issuer identity of a price pair.
 *
 * Prices are per-asset, not per-code: two `USDC` issuers are two different
 * assets. Callers that know the issuer pass it here so the cache never
 * answers one issuer's request with another issuer's price. Omitting the
 * issuers keeps the historical `price:{FROM}:{TO}` key, so existing entries
 * and callers are unaffected.
 */
export interface PriceAssetIdentity {
  /** Issuer account of the source asset; omitted or empty for native XLM. */
  fromIssuer?: string;
  /** Issuer account of the destination asset; omitted or empty for native XLM. */
  toIssuer?: string;
}

/** Maximum age in ms a cached price is considered fresh enough to act on. */
export const PRICE_MAX_AGE_MS = 60_000;

export interface CachedPriceResult {
  data: PriceData;
  /** True when the entry is within PRICE_MAX_AGE_MS. */
  fresh: boolean;
  ageMs: number;
}

interface CacheStats {
  totalKeys: number;
  memoryUsage: string;
  hitRate?: number;
}

export class PriceCacheService {
  private readonly DEFAULT_TTL = 60;
  private hits = 0;
  private misses = 0;

  private getCacheKey(
    fromAsset: string,
    toAsset: string,
    identity?: PriceAssetIdentity
  ): string {
    const fromIssuer = identity?.fromIssuer?.trim();
    const toIssuer = identity?.toIssuer?.trim();
    return [
      "price",
      fromAsset.toUpperCase(),
      ...(fromIssuer ? [fromIssuer] : []),
      toAsset.toUpperCase(),
      ...(toIssuer ? [toIssuer] : []),
    ].join(":");
  }

  async getPrice(
    fromAsset: string,
    toAsset: string,
    identity?: PriceAssetIdentity
  ): Promise<CachedPriceResult | null> {
    const start = Date.now();

    try {
      const key = this.getCacheKey(fromAsset, toAsset, identity);
      const redis = getRedisClient();
      const cached = await redis.get(key);

      if (!cached) {
        this.misses++;
        return null;
      }

      this.hits++;

      const data: PriceData = JSON.parse(cached);
      const ageMs = Date.now() - data.timestamp;
      const fresh = ageMs <= PRICE_MAX_AGE_MS;

      logger.debug("Cache hit for price", {
        pair: `${fromAsset}/${toAsset}`,
        price: data.price,
        ageMs,
        fresh,
        latencyMs: Date.now() - start,
      });

      return { data, fresh, ageMs };
    } catch (error) {
      logger.error("Error getting cached price", {
        error: error instanceof Error ? error.message : "Unknown error",
        latencyMs: Date.now() - start,
      });
      return null;
    }
  }

  async setPrice(
    fromAsset: string,
    toAsset: string,
    price: number,
    source: string,
    ttl: number = this.DEFAULT_TTL,
    identity?: PriceAssetIdentity
  ): Promise<void> {
    const start = Date.now();

    try {
      const key = this.getCacheKey(fromAsset, toAsset, identity);
      const now = Date.now();
      const priceData: PriceData = {
        price,
        timestamp: now,
        source,
      };
      const serialized = JSON.stringify(priceData);

      const redis = getRedisClient();

      /**
       * Atomic "set if newer" using a Lua script.
       *
       * The script reads the current cached entry, compares its `timestamp`
       * field against the incoming one, and only overwrites when the new
       * observation is strictly newer (or when nothing is cached yet).
       * This prevents a slow concurrent fetch from replacing fresher data
       * that another concurrent fetch already committed.
       *
       * KEYS[1]  — cache key
       * ARGV[1]  — serialised new PriceData
       * ARGV[2]  — TTL in seconds
       * ARGV[3]  — new timestamp (ms) as a string for numeric comparison
       */
      const lua = `
        local existing = redis.call('GET', KEYS[1])
        if existing then
          local ok, parsed = pcall(cjson.decode, existing)
          if ok and parsed.timestamp and tonumber(parsed.timestamp) >= tonumber(ARGV[3]) then
            return 0
          end
        end
        redis.call('SETEX', KEYS[1], ARGV[2], ARGV[1])
        return 1
      `;

      await (redis as unknown as {
        eval(script: string, numkeys: number, ...args: string[]): Promise<number>;
      }).eval(lua, 1, key, serialized, String(ttl), String(now));

      logger.debug("Cached price", {
        pair: `${fromAsset}/${toAsset}`,
        price,
        ttl,
        latencyMs: Date.now() - start,
      });
    } catch (error) {
      logger.error("Error setting cached price", {
        error: error instanceof Error ? error.message : "Unknown error",
        latencyMs: Date.now() - start,
      });
    }
  }

  async getPrices(
    pairs: Array<{ from: string; to: string } & PriceAssetIdentity>
  ): Promise<Map<string, CachedPriceResult | null>> {
    const results = new Map<string, CachedPriceResult | null>();
    const start = Date.now();

    try {
      const keys = pairs.map((p) => this.getCacheKey(p.from, p.to, p));
      const redis = getRedisClient();
      const values = await redis.mget(...keys);

      pairs.forEach((pair, index) => {
        const fromIssuer = pair.fromIssuer?.trim();
        const toIssuer = pair.toIssuer?.trim();
        const pairKey = `${pair.from}/${pair.to}${
          fromIssuer ? `:${fromIssuer}` : ""
        }${toIssuer ? `:${toIssuer}` : ""}`;
        const value = values[index];

        if (value) {
          const data: PriceData = JSON.parse(value);
          const ageMs = Date.now() - data.timestamp;

          this.hits++;

          results.set(pairKey, {
            data,
            fresh: ageMs <= PRICE_MAX_AGE_MS,
            ageMs,
          });
        } else {
          this.misses++;
          results.set(pairKey, null);
        }
      });

      logger.debug("Batch price retrieval", {
        pairs: pairs.length,
        latencyMs: Date.now() - start,
      });
    } catch (error) {
      logger.error("Error getting multiple cached prices", {
        error: error instanceof Error ? error.message : "Unknown error",
        latencyMs: Date.now() - start,
      });
    }

    return results;
  }

  async invalidatePrice(
    fromAsset: string,
    toAsset: string,
    identity?: PriceAssetIdentity
  ): Promise<void> {
    try {
      const key = this.getCacheKey(fromAsset, toAsset, identity);
      const redis = getRedisClient();
      await redis.del(key);

      logger.debug("Invalidated price cache", {
        pair: `${fromAsset}/${toAsset}`,
      });
    } catch (error) {
      logger.error("Error invalidating cached price", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  async clearAll(): Promise<void> {
    const start = Date.now();

    try {
      const redis = getRedisClient();
      let cursor = "0";
      let deletedCount = 0;

      do {
        const result = await redis.scan(cursor, "MATCH", "price:*", "COUNT", 100);
        cursor = result[0];
        const keys = result[1];

        if (keys.length > 0) {
          await redis.del(...keys);
          deletedCount += keys.length;
        }
      } while (cursor !== "0");

      if (deletedCount > 0) {
        logger.info("Cleared price cache", {
          keysDeleted: deletedCount,
          latencyMs: Date.now() - start,
        });
      }
    } catch (error) {
      logger.error("Error clearing price cache", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  async getStats(): Promise<CacheStats> {
    try {
      const redis = getRedisClient();

      let totalKeys = 0;
      let cursor = "0";

      do {
        const result = await redis.scan(cursor, "MATCH", "price:*", "COUNT", 500);
        cursor = result[0];
        totalKeys += result[1].length;
      } while (cursor !== "0");

      const info = await redis.info("memory");
      const memoryMatch = info.match(/used_memory_human:(.+)/);
      const memoryUsage = memoryMatch ? memoryMatch[1].trim() : "unknown";

      const totalAccesses = this.hits + this.misses;
      const hitRate =
        totalAccesses > 0
          ? parseFloat(((this.hits / totalAccesses) * 100).toFixed(1))
          : undefined;

      return {
        totalKeys,
        memoryUsage,
        hitRate,
      };
    } catch (error) {
      logger.error("Error getting cache stats", {
        error: error instanceof Error ? error.message : "Unknown error",
      });

      return {
        totalKeys: 0,
        memoryUsage: "unknown",
      };
    }
  }

  getHitRate(): {
    hits: number;
    misses: number;
    hitRate: number | undefined;
  } {
    const total = this.hits + this.misses;

    return {
      hits: this.hits,
      misses: this.misses,
      hitRate:
        total > 0 ? parseFloat(((this.hits / total) * 100).toFixed(1)) : undefined,
    };
  }

  resetHitRate(): void {
    this.hits = 0;
    this.misses = 0;
  }

  async healthCheck(): Promise<boolean> {
    return healthCheckRedis();
  }
}
/**
 * Singleton cache.
 *
 * The price services import this module's default export; without it the
 * default resolves to `undefined` and every price lookup throws before it
 * reaches Horizon.
 */
export default new PriceCacheService();
