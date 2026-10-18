/**
 * evidenceStore.ts
 *
 * Verifiable evidence persistence for high-risk agent decisions (Issue #783).
 * Captures user requests, tool inputs/outputs, network/wallet/contract metadata,
 * policy evaluations, outcomes, and attachable artifacts with tamper-evident digests.
 */

import * as crypto from "crypto";
import logger from "../config/logger";

export interface DecisionContext {
  userId: string;
  sessionId?: string;
  userPrompt: string;
  intent?: string;
  clientMetadata?: Record<string, unknown>;
}

export interface ToolExecutionRecord {
  toolName: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  durationMs?: number;
}

export interface EnvironmentMetadata {
  network: string;
  chainId?: string;
  walletAddress?: string;
  contractAddresses?: string[];
  rpcEndpoint?: string;
}

export interface PolicyEvaluationRecord {
  policyName: string;
  decision: "ALLOW" | "DENY" | "REQUIRE_CONFIRMATION" | "FLAG_FOR_REVIEW";
  reason?: string;
  riskScore?: number;
  evaluatedAt: string;
}

export interface DecisionArtifact {
  name: string;
  type: "decoded_transaction" | "receipt" | "proof" | "raw_payload";
  data: unknown;
}

export interface VerifiableEvidenceBundle {
  bundleId: string;
  timestamp: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  context: DecisionContext;
  toolExecutions: ToolExecutionRecord[];
  environment: EnvironmentMetadata;
  policyDecisions: PolicyEvaluationRecord[];
  outcome: {
    status: "SUCCESS" | "FAILED" | "REJECTED" | "ESCALATED";
    result?: unknown;
    warnings?: string[];
    errors?: string[];
  };
  artifacts?: DecisionArtifact[];
  /** SHA-256 digest guaranteeing bundle integrity */
  digest: string;
}

export type CreateEvidenceBundleInput = Omit<
  VerifiableEvidenceBundle,
  "bundleId" | "timestamp" | "digest"
>;

export class EvidenceStore {
  private store: Map<string, VerifiableEvidenceBundle> = new Map();

  /**
   * Deterministically stringify object for cryptographic hashing.
   */
  private canonicalize(obj: unknown): string {
    if (obj === null || typeof obj !== "object") {
      return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
      return `[${obj.map((item) => this.canonicalize(item)).join(",")}]`;
    }
    const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
    const pairs = sortedKeys.map(
      (key) => `${JSON.stringify(key)}:${this.canonicalize((obj as Record<string, unknown>)[key])}`
    );
    return `{${pairs.join(",")}}`;
  }

  /**
   * Compute a tamper-evident SHA-256 digest of bundle fields.
   */
  public computeDigest(payload: Omit<VerifiableEvidenceBundle, "digest">): string {
    const canonical = this.canonicalize({
      bundleId: payload.bundleId,
      timestamp: payload.timestamp,
      riskLevel: payload.riskLevel,
      context: payload.context,
      toolExecutions: payload.toolExecutions,
      environment: payload.environment,
      policyDecisions: payload.policyDecisions,
      outcome: payload.outcome,
      artifacts: payload.artifacts,
    });
    return crypto.createHash("sha256").update(canonical).digest("hex");
  }

  /**
   * Persist a verifiable evidence bundle for a high-risk agent decision.
   */
  public async persistBundle(
    input: CreateEvidenceBundleInput
  ): Promise<VerifiableEvidenceBundle> {
    const bundleId = `ev_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const timestamp = new Date().toISOString();

    const unsignedBundle = {
      ...input,
      bundleId,
      timestamp,
    };

    const digest = this.computeDigest(unsignedBundle);

    const bundle: VerifiableEvidenceBundle = {
      ...unsignedBundle,
      digest,
    };

    this.store.set(bundleId, bundle);

    logger.info("Persisted verifiable evidence bundle", {
      bundleId,
      userId: bundle.context.userId,
      riskLevel: bundle.riskLevel,
      outcome: bundle.outcome.status,
      digest,
    });

    return bundle;
  }

  /**
   * Retrieve an evidence bundle by its ID.
   */
  public async getBundle(bundleId: string): Promise<VerifiableEvidenceBundle | null> {
    return this.store.get(bundleId) || null;
  }

  /**
   * Verify that a stored bundle has not been tampered with.
   */
  public async verifyBundle(bundleId: string): Promise<{
    valid: boolean;
    computedDigest: string;
    storedDigest: string;
  }> {
    const bundle = await this.getBundle(bundleId);
    if (!bundle) {
      throw new Error(`Evidence bundle "${bundleId}" not found`);
    }

    const { digest: storedDigest, ...unsigned } = bundle;
    const computedDigest = this.computeDigest(unsigned);

    return {
      valid: computedDigest === storedDigest,
      computedDigest,
      storedDigest,
    };
  }

  /**
   * Query bundles by user ID.
   */
  public async getBundlesByUser(userId: string): Promise<VerifiableEvidenceBundle[]> {
    const results: VerifiableEvidenceBundle[] = [];
    for (const bundle of this.store.values()) {
      if (bundle.context.userId === userId) {
        results.push(bundle);
      }
    }
    return results;
  }
}

export const evidenceStore = new EvidenceStore();
