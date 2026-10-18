// chenpilot/packages/sdk/src/unifiedTransactionBuilder.ts
import * as StellarSdk from "@stellar/stellar-sdk";
import {
  SponsorshipTransactionBuilder,
  SponsorshipConfig,
} from "./sponsorship";
import { MultiSigBuilder, MultiSigConfig } from "./multiSig";

/**
 * Transaction flow type
 */
export enum TransactionFlow {
  CHAIN = "chain",
  SPONSOR = "sponsor",
  MULTISIG = "multisig",
  HYBRID = "hybrid",
}

/**
 * Unified transaction configuration
 */
export interface UnifiedTransactionConfig {
  source: StellarSdk.Keypair;
  networkPassphrase: string;
  flow: TransactionFlow;
  fee?: number;
  timebounds?: any;
  memo?: StellarSdk.Memo;
}

/**
 * Sponsorship configuration for unified builder
 */
export interface UnifiedSponsorshipConfig extends SponsorshipConfig {
  enabled: boolean;
}

/**
 * Multisig configuration for unified builder
 */
export interface UnifiedMultiSigConfig {
  enabled: boolean;
  config?: MultiSigConfig;
}

/**
 * Chain operation types
 */
export enum ChainOperation {
  PAYMENT = "payment",
  CHANGE_TRUST = "change_trust",
  MANAGE_DATA = "manage_data",
  CREATE_ACCOUNT = "create_account",
  PATH_PAYMENT = "path_payment",
}

/**
 * Operation specification
 */
export interface OperationSpec {
  type: ChainOperation;
  params: Record<string, unknown>;
}

/**
 * Unified transaction builder that supports chain, sponsor, and multisig flows
 */
export class UnifiedTransactionBuilder {
  private source: StellarSdk.Keypair;
  private networkPassphrase: string;
  private flow: TransactionFlow;
  private sponsorshipConfig?: UnifiedSponsorshipConfig;
  private multisigConfig?: UnifiedMultiSigConfig;
  private operations: OperationSpec[] = [];
  private fee: number;
  private timebounds: any;
  private memo?: StellarSdk.Memo;

  private sponsorshipBuilder?: SponsorshipTransactionBuilder;
  private chainBuilder?: StellarSdk.TransactionBuilder;

  constructor(config: UnifiedTransactionConfig) {
    this.source = config.source;
    this.networkPassphrase = config.networkPassphrase;
    this.flow = config.flow;
    this.fee = config.fee || 100;
    this.timebounds =
      config.timebounds || {
        minTime: Math.floor(Date.now() / 1000),
        maxTime: Math.floor(Date.now() / 1000) + 300,
      };
    this.memo = config.memo;

    this.initializeBuilder();
  }

  /**
   * Initialize the appropriate builder based on flow type
   */
  private initializeBuilder(): void {
    switch (this.flow) {
      case TransactionFlow.SPONSOR:
        if (!this.sponsorshipConfig?.enabled) {
          throw new Error("Sponsorship config required for SPONSOR flow");
        }
        this.sponsorshipBuilder = new SponsorshipTransactionBuilder(
          this.source,
          this.networkPassphrase,
          { fee: this.fee, timebounds: this.timebounds }
        );
        break;

      case TransactionFlow.CHAIN:
      case TransactionFlow.MULTISIG:
      case TransactionFlow.HYBRID:
        this.chainBuilder = new StellarSdk.TransactionBuilder(
          new StellarSdk.Account(this.source.publicKey(), "0"),
          {
            fee: this.fee,
            networkPassphrase: this.networkPassphrase,
            timebounds: this.timebounds,
          }
        );
        break;
    }
  }

  /**
   * Configure sponsorship
   */
  withSponsorship(config: UnifiedSponsorshipConfig): this {
    this.sponsorshipConfig = config;
    this.flow = TransactionFlow.SPONSOR;
    this.initializeBuilder();

    if (this.sponsorshipBuilder && config.enabled) {
      this.sponsorshipBuilder.addBeginSponsorship({
        sponsor: config.sponsor,
        sponsoredAccount: config.sponsoredAccount,
      });
    }

    return this;
  }

  /**
   * Configure multisig
   */
  withMultisig(config: UnifiedMultiSigConfig): this {
    this.multisigConfig = config;
    if (config.enabled) {
      this.flow = TransactionFlow.MULTISIG;
    }
    return this;
  }

  /**
   * Add a payment operation
   */
  addPayment(
    destination: string,
    asset: StellarSdk.Asset,
    amount: string
  ): this {
    this.operations.push({
      type: ChainOperation.PAYMENT,
      params: { destination, asset, amount },
    });

    if (this.sponsorshipBuilder && this.sponsorshipConfig?.enabled) {
      this.sponsorshipBuilder.addSponsoredPayment(destination, asset, amount);
    } else if (this.chainBuilder) {
      this.chainBuilder.addOperation(
        StellarSdk.Operation.payment({
          destination,
          asset,
          amount,
        })
      );
    }

    return this;
  }

  /**
   * Add a change trust operation
   */
  addChangeTrust(asset: StellarSdk.Asset, limit?: string): this {
    this.operations.push({
      type: ChainOperation.CHANGE_TRUST,
      params: { asset, limit },
    });

    if (this.sponsorshipBuilder && this.sponsorshipConfig?.enabled) {
      this.sponsorshipBuilder.addSponsoredTrustline(asset, limit);
    } else if (this.chainBuilder) {
      this.chainBuilder.addOperation(
        StellarSdk.Operation.changeTrust({ asset, limit })
      );
    }

    return this;
  }

  /**
   * Add a manage data operation
   */
  addManageData(name: string, value: string | null): this {
    this.operations.push({
      type: ChainOperation.MANAGE_DATA,
      params: { name, value },
    });

    if (this.sponsorshipBuilder && this.sponsorshipConfig?.enabled) {
      this.sponsorshipBuilder.addSponsoredManageData(name, value);
    } else if (this.chainBuilder) {
      this.chainBuilder.addOperation(
        StellarSdk.Operation.manageData({ name, value })
      );
    }

    return this;
  }

  /**
   * Add a create account operation
   */
  addCreateAccount(destination: string, startingBalance: string): this {
    this.operations.push({
      type: ChainOperation.CREATE_ACCOUNT,
      params: { destination, startingBalance },
    });

    if (this.chainBuilder) {
      this.chainBuilder.addOperation(
        StellarSdk.Operation.createAccount({
          destination,
          startingBalance,
        })
      );
    }

    return this;
  }

  /**
   * Add a path payment operation
   */
  addPathPayment(
    destination: string,
    sendAsset: StellarSdk.Asset,
    sendAmount: string,
    destAsset: StellarSdk.Asset,
    destMin: string,
    path?: StellarSdk.Asset[]
  ): this {
    this.operations.push({
      type: ChainOperation.PATH_PAYMENT,
      params: {
        destination,
        sendAsset,
        sendAmount,
        destAsset,
        destMin,
        path,
      },
    });

    if (this.chainBuilder) {
      this.chainBuilder.addOperation(
        StellarSdk.Operation.pathPaymentStrictSend({
          destination,
          sendAsset,
          sendAmount,
          destAsset,
          destMin,
          path,
        })
      );
    }

    return this;
  }

  /**
   * Set transaction fee
   */
  setFee(fee: number): this {
    this.fee = fee;
    if (this.sponsorshipBuilder) {
      this.sponsorshipBuilder.setFee(fee);
    } else if (this.chainBuilder) {
      (this.chainBuilder as any).fee = fee;
    }
    return this;
  }

  /**
   * Set timebounds
   */
  setTimebounds(timebounds: any): this {
    this.timebounds = timebounds;
    if (this.sponsorshipBuilder) {
      this.sponsorshipBuilder.setTimebounds(timebounds);
    } else if (this.chainBuilder) {
      (this.chainBuilder as any).timebounds = timebounds;
    }
    return this;
  }

  /**
   * Set memo
   */
  setMemo(memo: StellarSdk.Memo): this {
    this.memo = memo;
    if (this.sponsorshipBuilder) {
      this.sponsorshipBuilder.setMemo(memo);
    } else if (this.chainBuilder) {
      this.chainBuilder.addMemo(memo);
    }
    return this;
  }

  /**
   * Build the transaction
   */
  build(): StellarSdk.Transaction {
    if (this.sponsorshipBuilder && this.sponsorshipConfig?.enabled) {
      // End sponsorship before building
      this.sponsorshipBuilder.addEndSponsorship();
      return this.sponsorshipBuilder.build();
    } else if (this.chainBuilder) {
      return this.chainBuilder.build();
    }

    throw new Error("No builder initialized");
  }

  /**
   * Build and return XDR
   */
  toXDR(): string {
    return this.build().toXDR();
  }

  /**
   * Get the operations added to this builder
   */
  getOperations(): OperationSpec[] {
    return [...this.operations];
  }

  /**
   * Validate the transaction configuration
   */
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (this.flow === TransactionFlow.SPONSOR && !this.sponsorshipConfig?.enabled) {
      errors.push("Sponsorship flow requires sponsorship config");
    }

    if (this.flow === TransactionFlow.MULTISIG && !this.multisigConfig?.enabled) {
      errors.push("Multisig flow requires multisig config");
    }

    if (this.operations.length === 0) {
      errors.push("No operations added to transaction");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Create a builder preset for common flows
   */
  static createPreset(
    preset: "simple_payment" | "sponsored_trustline" | "multisig_payment",
    source: StellarSdk.Keypair,
    networkPassphrase: string
  ): UnifiedTransactionBuilder {
    const builder = new UnifiedTransactionBuilder({
      source,
      networkPassphrase,
      flow: TransactionFlow.CHAIN,
    });

    switch (preset) {
      case "simple_payment":
        return builder;

      case "sponsored_trustline":
        return builder;

      case "multisig_payment":
        builder.withMultisig({ enabled: true });
        return builder;
    }
  }
}

/**
 * Helper function to create a simple payment transaction
 */
export function createSimplePayment(
  source: StellarSdk.Keypair,
  destination: string,
  asset: StellarSdk.Asset,
  amount: string,
  networkPassphrase: string
): string {
  const builder = new UnifiedTransactionBuilder({
    source,
    networkPassphrase,
    flow: TransactionFlow.CHAIN,
  });

  builder.addPayment(destination, asset, amount);
  return builder.toXDR();
}

/**
 * Helper function to create a sponsored trustline transaction
 */
export function createSponsoredTrustline(
  sponsor: StellarSdk.Keypair,
  sponsoredAccount: string,
  asset: StellarSdk.Asset,
  limit?: string,
  networkPassphrase: string
): string {
  const builder = new UnifiedTransactionBuilder({
    source: sponsor,
    networkPassphrase,
    flow: TransactionFlow.SPONSOR,
  });

  builder.withSponsorship({
    enabled: true,
    sponsor: sponsor.publicKey(),
    sponsoredAccount,
  });

  builder.addChangeTrust(asset, limit);
  return builder.toXDR();
}

/**
 * Helper function to create a multisig payment transaction
 */
export function createMultisigPayment(
  source: StellarSdk.Keypair,
  destination: string,
  asset: StellarSdk.Asset,
  amount: string,
  networkPassphrase: string,
  multisigConfig: MultiSigConfig
): string {
  const builder = new UnifiedTransactionBuilder({
    source,
    networkPassphrase,
    flow: TransactionFlow.MULTISIG,
  });

  builder.withMultisig({ enabled: true, config: multisigConfig });
  builder.addPayment(destination, asset, amount);
  return builder.toXDR();
}
