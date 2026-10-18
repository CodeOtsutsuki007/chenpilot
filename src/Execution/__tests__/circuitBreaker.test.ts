// chenpilot/src/Execution/__tests__/circuitBreaker.test.ts
import {
  PriceFeedCircuitBreaker,
  CircuitState,
  CircuitBreakerConfig,
} from "../circuitBreaker";

describe("PriceFeedCircuitBreaker", () => {
  let breaker: PriceFeedCircuitBreaker;

  beforeEach(() => {
    breaker = new PriceFeedCircuitBreaker({
      failureThreshold: 3,
      successThreshold: 2,
      timeoutMs: 1000,
      monitoringWindowMs: 5000,
      anomalyDetectionEnabled: true,
      priceDeviationThreshold: 50,
    });
  });

  describe("initial state", () => {
    it("should start in CLOSED state", () => {
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it("should allow execution in CLOSED state", () => {
      expect(breaker.allowExecution()).toBe(true);
    });
  });

  describe("recordFailure", () => {
    it("should increment failure count", () => {
      breaker.recordFailure("Test failure");
      const stats = breaker.getStats();
      expect(stats.failureCount).toBe(1);
    });

    it("should transition to OPEN after threshold", () => {
      breaker.recordFailure("Failure 1");
      breaker.recordFailure("Failure 2");
      breaker.recordFailure("Failure 3");

      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it("should block execution in OPEN state", () => {
      breaker.recordFailure("Failure 1");
      breaker.recordFailure("Failure 2");
      breaker.recordFailure("Failure 3");

      expect(breaker.allowExecution()).toBe(false);
    });
  });

  describe("recordSuccess", () => {
    it("should increment success count", () => {
      breaker.recordSuccess(100, "BTC/USD");
      const stats = breaker.getStats();
      expect(stats.successCount).toBe(1);
    });

    it("should transition to CLOSED from HALF_OPEN after threshold", () => {
      // Force to OPEN
      breaker.recordFailure("Failure 1");
      breaker.recordFailure("Failure 2");
      breaker.recordFailure("Failure 3");

      // Wait for timeout
      jest.useFakeTimers();
      jest.advanceTimersByTime(1100);

      // This should transition to HALF_OPEN
      breaker.allowExecution();

      // Record successes
      breaker.recordSuccess(100, "BTC/USD");
      breaker.recordSuccess(101, "BTC/USD");

      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe("detectAnomaly", () => {
    it("should detect price deviation above threshold", () => {
      breaker.recordSuccess(100, "BTC/USD");

      const detection = breaker.detectAnomaly("BTC/USD", 160); // 60% deviation

      expect(detection.isAnomalous).toBe(true);
      expect(detection.deviationPercentage).toBeGreaterThan(50);
    });

    it("should not detect anomaly below threshold", () => {
      breaker.recordSuccess(100, "BTC/USD");

      const detection = breaker.detectAnomaly("BTC/USD", 120); // 20% deviation

      expect(detection.isAnomalous).toBe(false);
    });

    it("should not detect anomaly with insufficient history", () => {
      const detection = breaker.detectAnomaly("BTC/USD", 100);

      expect(detection.isAnomalous).toBe(false);
    });
  });

  describe("checkPrice", () => {
    it("should fetch price when circuit is closed", async () => {
      const fetchFn = async () => 100;

      const price = await breaker.checkPrice("BTC/USD", 100, fetchFn);

      expect(price).toBe(100);
    });

    it("should block when circuit is open", async () => {
      // Force to OPEN
      breaker.recordFailure("Failure 1");
      breaker.recordFailure("Failure 2");
      breaker.recordFailure("Failure 3");

      const fetchFn = async () => 100;

      await expect(breaker.checkPrice("BTC/USD", 100, fetchFn)).rejects.toThrow(
        "Circuit breaker is OPEN"
      );
    });

    it("should detect anomalies and record failure", async () => {
      breaker.recordSuccess(100, "BTC/USD");

      const fetchFn = async () => 160;

      await expect(breaker.checkPrice("BTC/USD", 160, fetchFn)).rejects.toThrow(
        "Price anomaly detected"
      );

      expect(breaker.getStats().failureCount).toBe(1);
    });
  });

  describe("reset", () => {
    it("should reset to CLOSED state", () => {
      breaker.recordFailure("Failure 1");
      breaker.recordFailure("Failure 2");
      breaker.recordFailure("Failure 3");

      breaker.reset();

      expect(breaker.getState()).toBe(CircuitState.CLOSED);
      expect(breaker.getStats().failureCount).toBe(0);
      expect(breaker.getStats().successCount).toBe(0);
    });
  });

  describe("getStats", () => {
    it("should return current statistics", () => {
      breaker.recordSuccess(100, "BTC/USD");
      breaker.recordFailure("Test failure");

      const stats = breaker.getStats();

      expect(stats.successCount).toBe(1);
      expect(stats.failureCount).toBe(1);
      expect(stats.state).toBe(CircuitState.CLOSED);
    });
  });

  describe("getEventLog", () => {
    it("should return event history", () => {
      breaker.recordSuccess(100, "BTC/USD");
      breaker.recordFailure("Test failure");

      const events = breaker.getEventLog();

      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe("getPriceHistory", () => {
    it("should return price history for asset pair", () => {
      breaker.recordSuccess(100, "BTC/USD");
      breaker.recordSuccess(101, "BTC/USD");

      const history = breaker.getPriceHistory("BTC/USD");

      expect(history).toHaveLength(2);
      expect(history).toContain(100);
      expect(history).toContain(101);
    });

    it("should return empty array for unknown asset pair", () => {
      const history = breaker.getPriceHistory("UNKNOWN/USD");

      expect(history).toHaveLength(0);
    });
  });
});
