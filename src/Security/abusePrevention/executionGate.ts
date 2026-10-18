import { CircuitBreaker, CircuitBreakerError, CircuitBreakerOptions, CircuitState } from "../../utils/resilience";
import { AbusePreventionService } from "./AbusePreventionService";
import { AbuseEvaluationResult, AbuseSubject } from "./types";

/**
 * Guards heavy execution paths (chain submissions, RPC fan-out, LLM calls).
 * A call passes three checks, cheapest first, before reaching the provider:
 *
 *   1. per-user abuse policy on the "provider" surface (throttles callers)
 *   2. circuit breaker (stops hammering a provider that is already failing)
 *   3. bounded concurrency with a bounded wait queue (sheds load instead of
 *      piling up unbounded work)
 */

export type GateRejectionReason = "throttled" | "circuit_open" | "queue_full" | "queue_timeout";

export class ExecutionGateRejectedError extends Error {
  constructor(
    public readonly gate: string,
    public readonly reason: GateRejectionReason,
    public readonly retryAfterMs?: number,
    public readonly abuseDecision?: AbuseEvaluationResult
  ) {
    super(`Execution gate '${gate}' rejected call: ${reason}`);
    this.name = "ExecutionGateRejectedError";
  }
}

export interface ExecutionGateOptions {
  name: string;
  maxConcurrent: number;
  /** Calls allowed to wait for a slot; further calls are rejected immediately. */
  maxQueued: number;
  queueTimeoutMs: number;
  circuit?: Partial<Omit<CircuitBreakerOptions, "name">>;
  abuse?: AbusePreventionService;
  /**
   * Decides whether an error counts against the circuit breaker. Caller
   * errors (e.g. 4xx from the provider) should return false so one user's
   * bad requests cannot open the circuit for everyone. Defaults to all errors.
   */
  isFailure?: (error: unknown) => boolean;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface ExecutionGateStats {
  name: string;
  active: number;
  queued: number;
  circuitState: CircuitState;
  rejected: Record<GateRejectionReason, number>;
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ExecutionGate {
  private active = 0;
  private queue: Waiter[] = [];
  private readonly breaker: CircuitBreaker;
  private rejected: Record<GateRejectionReason, number> = {
    throttled: 0,
    circuit_open: 0,
    queue_full: 0,
    queue_timeout: 0,
  };

  constructor(private readonly options: ExecutionGateOptions) {
    this.breaker = new CircuitBreaker({
      failureThreshold: 5,
      recoveryTimeout: 30_000,
      successThreshold: 2,
      ...options.circuit,
      name: options.name,
    });
  }

  async run<T>(subject: AbuseSubject, fn: () => Promise<T>, action = this.options.name): Promise<T> {
    if (this.options.abuse) {
      const decision = await this.options.abuse.evaluate({ surface: "provider", action, subject });
      if (!decision.allowed) {
        throw this.reject("throttled", decision.retryAfterMs, decision);
      }
    }

    let outcome: Outcome<T>;
    try {
      // The breaker short-circuits while open and lets a probe through once
      // its recovery timeout has elapsed.
      outcome = await this.withSlot(() => this.breaker.execute(() => this.classify(fn)));
    } catch (error) {
      if (error instanceof CircuitBreakerError) throw this.reject("circuit_open");
      throw error;
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  getStats(): ExecutionGateStats {
    return {
      name: this.options.name,
      active: this.active,
      queued: this.queue.length,
      circuitState: this.breaker.getState(),
      rejected: { ...this.rejected },
    };
  }

  /** Resolves non-failure errors so the breaker records them as successes. */
  private async classify<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      if (this.options.isFailure && !this.options.isFailure(error)) return { ok: false, error };
      throw error;
    }
  }

  private reject(reason: GateRejectionReason, retryAfterMs?: number, decision?: AbuseEvaluationResult): ExecutionGateRejectedError {
    this.rejected[reason]++;
    return new ExecutionGateRejectedError(this.options.name, reason, retryAfterMs, decision);
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.options.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    if (this.queue.length >= this.options.maxQueued) {
      return Promise.reject(this.reject("queue_full"));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.queue = this.queue.filter((w) => w !== waiter);
          reject(this.reject("queue_timeout"));
        }, this.options.queueTimeoutMs),
      };
      this.queue.push(waiter);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      // Slot is handed over directly; `active` stays the same.
      next.resolve();
      return;
    }
    this.active--;
  }
}
