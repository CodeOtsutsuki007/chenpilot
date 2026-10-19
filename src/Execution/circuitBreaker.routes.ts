// chenpilot/src/Execution/circuitBreaker.routes.ts
import { Router, Request, Response } from "express";
import {
  priceFeedCircuitBreaker,
  CircuitState,
} from "./circuitBreaker";

const router = Router();

/**
 * Get circuit breaker state
 */
router.get("/state", (req: Request, res: Response) => {
  try {
    const state = priceFeedCircuitBreaker.getState();
    const stats = priceFeedCircuitBreaker.getStats();

    res.json({
      success: true,
      state,
      stats,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * Get circuit breaker statistics
 */
router.get("/stats", (req: Request, res: Response) => {
  try {
    const stats = priceFeedCircuitBreaker.getStats();

    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * Get event log
 */
router.get("/events", (req: Request, res: Response) => {
  try {
    const events = priceFeedCircuitBreaker.getEventLog();

    res.json({
      success: true,
      events,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * Get price history for an asset pair
 */
router.get("/price-history/:assetPair", (req: Request, res: Response) => {
  try {
    const { assetPair } = req.params;
    const history = priceFeedCircuitBreaker.getPriceHistory(assetPair);

    res.json({
      success: true,
      assetPair,
      history,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * Reset circuit breaker
 */
router.post("/reset", (req: Request, res: Response) => {
  try {
    priceFeedCircuitBreaker.reset();

    res.json({
      success: true,
      message: "Circuit breaker reset",
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * Manually record a failure (for testing)
 */
router.post("/record-failure", (req: Request, res: Response) => {
  try {
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({
        error: "reason is required",
      });
    }

    priceFeedCircuitBreaker.recordFailure(reason);

    res.json({
      success: true,
      message: "Failure recorded",
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * Manually record a success (for testing)
 */
router.post("/record-success", (req: Request, res: Response) => {
  try {
    const { price, assetPair } = req.body;

    if (!price || !assetPair) {
      return res.status(400).json({
        error: "price and assetPair are required",
      });
    }

    priceFeedCircuitBreaker.recordSuccess(price, assetPair);

    res.json({
      success: true,
      message: "Success recorded",
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
