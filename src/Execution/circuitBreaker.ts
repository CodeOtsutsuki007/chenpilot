// chenpilot/src/Execution/circuitBreaker.ts
import logger from "../config/logger";

/**
 * Circuit breaker states
 */
export enum CircuitState {
  CLOSED = "closed",
  OPEN = "open",
  HALF_OPEN = "half_open",
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeoutMs: number;
  monitoringWindowMs: number;
  anomalyDetectionEnabled: boolean;
  priceDeviationThreshold: number; // Percentage
  volumeAnomalyThreshold: number; // Percentage
}

/**
 * Price anomaly detection result
 */
export interface PriceAnomalyDetection {
  isAnomalous: boolean;
  reason?: string;
  deviationPercentage?: number;
  previousPrice?: number;
  currentPrice?: number;
  timestamp: number;
}

/**
 * Circuit breaker event
 */
export interface CircuitBreakerEvent {
  state: CircuitState;
  timestamp: number;
  reason?: string;
  failureCount: number;
  successCount: number;
}

/**
 * Circuit breaker for price feed anomalies
 */
export class PriceFeedCircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number = 0;
  private lastSuccessTime: number = 0;
  private priceHistory: Map<string, number[]> = new Map();
  private eventLog: CircuitBreakerEvent[] = [];
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = {
      failureThreshold: config.failureThreshold || 5,
      successThreshold: config.successThreshold || 3,
      timeoutMs: config.timeoutMs || 60000, // 1 minute
      monitoringWindowMs: config.monitoringWindowMs || 300000, // 5 minutes
      anomalyDetectionEnabled: config.anomalyDetectionEnabled !== false,
      priceDeviationThreshold: config.priceDeviationThreshold || 50, // 50%
      volumeAnomalyThreshold: config.volumeAnomalyThreshold || 100, // 100%
    };
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Check if circuit allows execution
   */
  allowExecution(): boolean {
    if (this.state === CircuitState.CLOSED) {
      return true;
    }

    if (this.state === CircuitState.OPEN) {
      // Check if timeout has elapsed
      if (Date.now() - this.lastFailureTime > this.config.timeoutMs) {
        this.transitionToHalfOpen();
        return true;
      }
      return false;
    }

    if (this.state === CircuitState.HALF_OPEN) {
      return true;
    }

    return false;
  }

  /**
   * Record a successful price fetch
   */
  recordSuccess(price: number, assetPair: string): void {
    this.successCount++;
    this.lastSuccessTime = Date.now();

    // Update price history
    this.updatePriceHistory(assetPair, price);

    if (this.state === CircuitState.HALF_OPEN) {
      if (this.successCount >= this.config.successThreshold) {
        this.transitionToClosed("Success threshold reached");
      }
    }

    this.logEvent("Success recorded");
  }

  /**
   * Record a failed price fetch
   */
  recordFailure(reason: string): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.CLOSED) {
      if (this.failureCount >= this.config.failureThreshold) {
        this.transitionToOpen(reason);
      }
    } else if (this.state === CircuitState.HALF_OPEN) {
      this.transitionToOpen(reason);
    }

    this.logEvent(`Failure recorded: ${reason}`);
  }

  /**
   * Detect price anomalies
   */
  detectAnomaly(
    assetPair: string,
    currentPrice: number
  ): PriceAnomalyDetection {
    if (!this.config.anomalyDetectionEnabled) {
      return {
        isAnomalous: false,
        timestamp: Date.now(),
      };
    }

    const history = this.priceHistory.get(assetPair) || [];

    if (history.length < 2) {
      return {
        isAnomalous: false,
        timestamp: Date.now(),
      };
    }

    const previousPrice = history[history.length - 1];
    const deviation =
      Math.abs(currentPrice - previousPrice) / previousPrice * 100;

    if (deviation > this.config.priceDeviationThreshold) {
      logger.warn(`Price anomaly detected for ${assetPair}`, {
        deviation,
        previousPrice,
        currentPrice,
      });

      return {
        isAnomalous: true,
        reason: `Price deviation ${deviation.toFixed(2)}% exceeds threshold ${this.config.priceDeviationThreshold}%`,
        deviationPercentage: deviation,
        previousPrice,
        currentPrice,
        timestamp: Date.now(),
      };
    }

    return {
      isAnomalous: false,
      deviationPercentage: deviation,
      previousPrice,
      currentPrice,
      timestamp: Date.now(),
    };
  }

  /**
   * Check price with anomaly detection and circuit breaker
   */
  async checkPrice(
    assetPair: string,
    currentPrice: number,
    fetchFn: () => Promise<number>
  ): Promise<number> {
    // Check circuit breaker
    if (!this.allowExecution()) {
      throw new Error(
        `Circuit breaker is ${this.state}. Price fetch blocked for ${assetPair}`
      );
    }

    // Detect anomalies
    const anomalyDetection = this.detectAnomaly(assetPair, currentPrice);

    if (anomalyDetection.isAnomalous) {
      // Treat anomaly as failure
      this.recordFailure(anomalyDetection.reason || "Price anomaly detected");
      throw new Error(
        `Price anomaly detected for ${assetPair}: ${anomalyDetection.reason}`
      );
    }

    try {
      // Attempt to fetch price
      const price = await fetchFn();
      this.recordSuccess(price, assetPair);
      return price;
    } catch (error) {
      this.recordFailure(
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  /**
   * Reset circuit breaker to closed state
   */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.priceHistory.clear();
    this.logEvent("Circuit breaker reset");
  }

  /**
   * Get circuit breaker statistics
   */
  getStats(): {
    state: CircuitState;
    failureCount: number;
    successCount: number;
    lastFailureTime: number;
    lastSuccessTime: number;
    config: CircuitBreakerConfig;
  } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      config: { ...this.config },
    };
  }

  /**
   * Get event log
   */
  getEventLog(): CircuitBreakerEvent[] {
    return [...this.eventLog];
  }

  /**
   * Get price history for an asset pair
   */
  getPriceHistory(assetPair: string): number[] {
    return [...(this.priceHistory.get(assetPair) || [])];
  }

  /**
   * Update price history
   */
  private updatePriceHistory(assetPair: string, price: number): void {
    if (!this.priceHistory.has(assetPair)) {
      this.priceHistory.set(assetPair, []);
    }

    const history = this.priceHistory.get(assetPair)!;
    history.push(price);

    // Keep only recent history within monitoring window
    const maxHistorySize = Math.floor(
      this.config.monitoringWindowMs / 1000
    ); // 1 second per sample

    if (history.length > maxHistorySize) {
      history.shift();
    }
  }

  /**
   * Transition to open state
   */
  private transitionToOpen(reason: string): void {
    this.state = CircuitState.OPEN;
    this.logEvent(`Transitioned to OPEN: ${reason}`);
    logger.warn(`Circuit breaker opened for price feed`, { reason });
  }

  /**
   * Transition to closed state
   */
  private transitionToClosed(reason: string): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.logEvent(`Transitioned to CLOSED: ${reason}`);
    logger.info(`Circuit breaker closed for price feed`, { reason });
  }

  /**
   * Transition to half-open state
   */
  private transitionToHalfOpen(): void {
    this.state = CircuitState.HALF_OPEN;
    this.successCount = 0;
    this.logEvent("Transitioned to HALF_OPEN");
    logger.info("Circuit breaker half-open for price feed");
  }

  /**
   * Log an event
   */
  private logEvent(message: string): void {
    const event: CircuitBreakerEvent = {
      state: this.state,
      timestamp: Date.now(),
      reason: message,
      failureCount: this.failureCount,
      successCount: this.successCount,
    };

    this.eventLog.push(event);

    // Keep only last 100 events
    if (this.eventLog.length > 100) {
      this.eventLog.shift();
    }
  }
}

/**
 * Global circuit breaker instance for price feeds
 */
export const priceFeedCircuitBreaker = new PriceFeedCircuitBreaker();
