import logger from "../../config/logger";
import { ConfidenceLevel } from "./types";

export interface ChainFinalityThreshold {
  chainId: string;
  minConfirmations?: number;
  minLedgerDepth?: number;
  requiredConfidence: ConfidenceLevel;
}

export interface BridgeProofPayload {
  bridgeId: string;
  sourceChainId: string;
  targetChainId: string;
  txHash: string;
  sourceBlockOrLedger: number;
  claimedStatus: "confirmed" | "delivered" | "finalized";
  proofData?: string;
  receiptSignature?: string;
}

export interface IndependentChainState {
  chainId: string;
  currentBlockOrLedger: number;
  confirmedBlockOrLedger?: number;
  txExists: boolean;
  reorgDetected?: boolean;
}

export interface FinalityEvidenceBundle {
  decisionId: string;
  timestamp: string;
  bridgeId: string;
  sourceChainId: string;
  txHash: string;
  confidence: ConfidenceLevel;
  verdict: "VALIDATED" | "REJECTED_ANOMALY" | "INSUFFICIENT_EVIDENCE";
  details: {
    bridgeReportedBlock: number;
    chainObservedBlock: number;
    reconciledDepth: number;
    thresholdMet: boolean;
    anomalyDetected: boolean;
    reason?: string;
  };
}

export interface BridgeProofValidatorConfig {
  thresholds: Record<string, ChainFinalityThreshold>;
}

const DEFAULT_THRESHOLDS: Record<string, ChainFinalityThreshold> = {
  stellar: {
    chainId: "stellar",
    minLedgerDepth: 1,
    requiredConfidence: ConfidenceLevel.CANONICAL_IRREVERSIBLE,
  },
  bitcoin: {
    chainId: "bitcoin",
    minConfirmations: 6,
    requiredConfidence: ConfidenceLevel.CANONICAL_IRREVERSIBLE,
  },
  ethereum: {
    chainId: "ethereum",
    minConfirmations: 32,
    requiredConfidence: ConfidenceLevel.CANONICAL_IRREVERSIBLE,
  },
};

export class BridgeProofValidator {
  private thresholds: Map<string, ChainFinalityThreshold> = new Map();

  constructor(config?: Partial<BridgeProofValidatorConfig>) {
    const initial = { ...DEFAULT_THRESHOLDS, ...(config?.thresholds || {}) };
    for (const [key, val] of Object.entries(initial)) {
      this.thresholds.set(key.toLowerCase(), val);
    }
  }

  public setChainThreshold(threshold: ChainFinalityThreshold): void {
    this.thresholds.set(threshold.chainId.toLowerCase(), threshold);
  }

  public validateBridgeProof(
    proof: BridgeProofPayload,
    chainState: IndependentChainState
  ): FinalityEvidenceBundle {
    const decisionId = `decision_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const timestamp = new Date().toISOString();

    logger.info("Evaluating bridge proof independently from external APIs", {
      decisionId,
      bridgeId: proof.bridgeId,
      sourceChainId: proof.sourceChainId,
      txHash: proof.txHash,
      claimedStatus: proof.claimedStatus,
      chainStateBlock: chainState.currentBlockOrLedger,
    });

    const threshold = this.thresholds.get(proof.sourceChainId.toLowerCase()) || {
      chainId: proof.sourceChainId,
      minConfirmations: 1,
      minLedgerDepth: 1,
      requiredConfidence: ConfidenceLevel.ECONOMICALLY_SECURE,
    };

    if (!chainState.txExists) {
      const bundle: FinalityEvidenceBundle = {
        decisionId,
        timestamp,
        bridgeId: proof.bridgeId,
        sourceChainId: proof.sourceChainId,
        txHash: proof.txHash,
        confidence: ConfidenceLevel.NONE,
        verdict: "REJECTED_ANOMALY",
        details: {
          bridgeReportedBlock: proof.sourceBlockOrLedger,
          chainObservedBlock: chainState.currentBlockOrLedger,
          reconciledDepth: 0,
          thresholdMet: false,
          anomalyDetected: true,
          reason: "Transaction does not exist in canonical chain state",
        },
      };

      logger.warn("Bridge proof rejected: transaction missing from chain state", {
        decisionId,
        txHash: proof.txHash,
        confidence: bundle.confidence,
      });

      return bundle;
    }

    if (chainState.reorgDetected) {
      const bundle: FinalityEvidenceBundle = {
        decisionId,
        timestamp,
        bridgeId: proof.bridgeId,
        sourceChainId: proof.sourceChainId,
        txHash: proof.txHash,
        confidence: ConfidenceLevel.NONE,
        verdict: "REJECTED_ANOMALY",
        details: {
          bridgeReportedBlock: proof.sourceBlockOrLedger,
          chainObservedBlock: chainState.currentBlockOrLedger,
          reconciledDepth: 0,
          thresholdMet: false,
          anomalyDetected: true,
          reason: "Chain reorganization detected affecting source transaction",
        },
      };

      logger.warn("Bridge proof rejected: chain reorganization detected", {
        decisionId,
        txHash: proof.txHash,
        confidence: bundle.confidence,
      });

      return bundle;
    }

    if (proof.sourceBlockOrLedger > chainState.currentBlockOrLedger) {
      const bundle: FinalityEvidenceBundle = {
        decisionId,
        timestamp,
        bridgeId: proof.bridgeId,
        sourceChainId: proof.sourceChainId,
        txHash: proof.txHash,
        confidence: ConfidenceLevel.NONE,
        verdict: "REJECTED_ANOMALY",
        details: {
          bridgeReportedBlock: proof.sourceBlockOrLedger,
          chainObservedBlock: chainState.currentBlockOrLedger,
          reconciledDepth: 0,
          thresholdMet: false,
          anomalyDetected: true,
          reason: "Bridge reported block height is in the future relative to canonical chain state",
        },
      };

      logger.warn("Bridge proof rejected: block height anomaly detected", {
        decisionId,
        txHash: proof.txHash,
        confidence: bundle.confidence,
      });

      return bundle;
    }

    const reconciledDepth = chainState.currentBlockOrLedger - proof.sourceBlockOrLedger + 1;
    const requiredDepth = threshold.minConfirmations ?? threshold.minLedgerDepth ?? 1;

    if (reconciledDepth < requiredDepth) {
      const bundle: FinalityEvidenceBundle = {
        decisionId,
        timestamp,
        bridgeId: proof.bridgeId,
        sourceChainId: proof.sourceChainId,
        txHash: proof.txHash,
        confidence: ConfidenceLevel.PROVISIONAL,
        verdict: "INSUFFICIENT_EVIDENCE",
        details: {
          bridgeReportedBlock: proof.sourceBlockOrLedger,
          chainObservedBlock: chainState.currentBlockOrLedger,
          reconciledDepth,
          thresholdMet: false,
          anomalyDetected: false,
          reason: `Insufficient depth (${reconciledDepth} < required ${requiredDepth})`,
        },
      };

      logger.warn("Bridge proof pending: insufficient confirmation depth", {
        decisionId,
        txHash: proof.txHash,
        confidence: bundle.confidence,
        reconciledDepth,
        requiredDepth,
      });

      return bundle;
    }

    const bundle: FinalityEvidenceBundle = {
      decisionId,
      timestamp,
      bridgeId: proof.bridgeId,
      sourceChainId: proof.sourceChainId,
      txHash: proof.txHash,
      confidence: threshold.requiredConfidence,
      verdict: "VALIDATED",
      details: {
        bridgeReportedBlock: proof.sourceBlockOrLedger,
        chainObservedBlock: chainState.currentBlockOrLedger,
        reconciledDepth,
        thresholdMet: true,
        anomalyDetected: false,
      },
    };

    logger.info("Bridge proof validated independently", {
      decisionId,
      txHash: proof.txHash,
      confidence: bundle.confidence,
      reconciledDepth,
    });

    return bundle;
  }
}

export const bridgeProofValidator = new BridgeProofValidator();
