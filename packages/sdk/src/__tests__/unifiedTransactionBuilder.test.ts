// chenpilot/packages/sdk/src/__tests__/unifiedTransactionBuilder.test.ts
import * as StellarSdk from "@stellar/stellar-sdk";
import {
  UnifiedTransactionBuilder,
  TransactionFlow,
  ChainOperation,
  createSimplePayment,
  createSponsoredTrustline,
  createMultisigPayment,
} from "../unifiedTransactionBuilder";
import { MultiSigConfig } from "../multiSig";

describe("UnifiedTransactionBuilder", () => {
  let source: StellarSdk.Keypair;
  const networkPassphrase = StellarSdk.Networks.TESTNET;

  beforeEach(() => {
    source = StellarSdk.Keypair.random();
  });

  describe("constructor", () => {
    it("should initialize with chain flow by default", () => {
      const builder = new UnifiedTransactionBuilder({
        source,
        networkPassphrase,
        flow: TransactionFlow.CHAIN,
      });

      expect(builder.getOperations()).toHaveLength(0);
    });

    it("should accept custom fee and timebounds", () => {
      const customTimebounds = {
        minTime: 1000,
        maxTime: 2000,
      };

      const builder = new UnifiedTransactionBuilder({
        source,
        networkPassphrase,
        flow: TransactionFlow.CHAIN,
        fee: 200,
        timebounds: customTimebounds,
      });

      expect(builder.getOperations()).toHaveLength(0);
    });
  });

  describe("addPayment", () => {
    it("should add a payment operation", () => {
      const builder = new UnifiedTransactionBuilder({
        source,
        networkPassphrase,
        flow: TransactionFlow.CHAIN,
      });

      const destination = StellarSdk.Keypair.random().publicKey();
      builder.addPayment(destination, StellarSdk.Asset.native(), "100");

      const operations = builder.getOperations();
      expect(operations).toHaveLength(1);
      expect(operations[0].type).toBe(ChainOperation.PAYMENT);
    });

    it("should add multiple payment operations", () => {
      const builder = new UnifiedTransactionBuilder({
        source,
        networkPassphrase,
        flow: TransactionFlow.CHAIN,
      });

      const dest1 = StellarSdk.Keypair.random().publicKey();
      const dest2 = StellarSdk.Keypair.random().publicKey();

      builder.addPayment(dest1, StellarSdk.Asset.native(), "100");
      builder.addPayment(dest2, StellarSdk.Asset.native(), "200");

      const operations = builder.getOperations();
      expect(operations).toHaveLength(2);
    });
  });

  describe("addChangeTrust", () => {
    it("should add a change trust operation", () => {
      const builder = new UnifiedTransactionBuilder({
        source,
        networkPassphrase,
        flow: TransactionFlow.CHAIN,
      });

      const asset = new StellarSdk.Asset(
        "USDC",
        "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
      );

      builder.addChangeTrust(asset, "10000");

      const operations = builder.getOperations();
      expect(operations).toHaveLength(1);
      expect(operations[0].type).toBe(ChainOperation.CHANGE_TRUST);
    });
  });

  describe("addManageData", () => {
    it("should add a manage data operation", () => {
      const builder = new UnifiedTransactionBuilder({
        source,
        networkPassphrase,
        flow: TransactionFlow.CHAIN,
      });

      builder.addManageData("test_key", "test_value");

      const operations = builder.getOperations();
      expect(operations).toHaveLength(1);
      expect(operations[0].type).toBe(ChainOperation.MANAGE_DATA);
    });
  });

  describe("withSponsorship", () => {
    it("should configure sponsorship flow", () => {
      const builder = new UnifiedTransactionBuilder({
        source,
        networkPassphrase,
        flow: TransactionFlow.CHAIN,
      });

      const sponsoredAccount = StellarSdk.Keypair.random().publicKey();

      builder.withSponsorship({
        enabled: true,
        sponsor: source.publicKey(),
        sponsoredAccount,
      });

      const operations = builder.getOperations();
      expect(operations).toHaveLength(0);
    });

    it("should add sponsored trustline", () => {
      const builder = new UnifiedTransactionBuilder({
        source,
        networkPassphrase,
        flow: TransactionFlow.SPONSOR,
      });

      const sponsoredAccount = StellarSdk.Keypair.random().publicKey();
      const asset = new StellarSdk.Asset(
        "USDC",
        "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
      );

      builder.withSponsorship({
        enabled: true,
        sponsor: source.publicKey(),
        sponsoredAccount,
      });

      builder.addChangeTrust(asset, "10000");

      const operations = builder.getOperations();
      expect(operations).toHaveLength(1);
    });
  });

  describe("withMultisig", () => {
    it("should configure multisig flow", () => {
      const builder = new UnifiedTransactionBuilder({
        source,
        networkPassphrase,
        flow: TransactionFlow.CHAIN,
      });

      const multisigConfig: MultiSigConfig = {
        masterAccount: source.publicKey(),
        signers: [],
        thresholds: { low: 1, medium: 2, high: 3 },
      };

      builder.withMultisig({ enabled: true, config: multisigConfig });

      const operations = builder.getOperations();
      expect(operations).toHaveLength(0);
    });
  });

  describe("build", () => {
    it("should build a transaction", () => {
      const builder = new UnifiedTransactionBuilder({
        source,
        networkPassphrase,
        flow: TransactionFlow.CHAIN,
      });

      const destination = StellarSdk.Keypair.random().publicKey();
      builder.addPayment(destination, StellarSdk.Asset.native(), "100");

      const transaction = builder.build();
      expect(transaction).toBeDefined();
    });

    it("should return XDR", () => {
      const builder = new UnifiedTransactionBuilder({
        source,
        networkPassphrase,
        flow: TransactionFlow.CHAIN,
      });

      const destination = StellarSdk.Keypair.random().publicKey();
      builder.addPayment(destination, StellarSdk.Asset.native(), "100");

      const xdr = builder.toXDR();
      expect(typeof xdr).toBe("string");
      expect(xdr.length).toBeGreaterThan(0);
    });
  });

  describe("validate", () => {
    it("should validate successfully for valid config", () => {
      const builder = new UnifiedTransactionBuilder({
        source,
        networkPassphrase,
        flow: TransactionFlow.CHAIN,
      });

      const destination = StellarSdk.Keypair.random().publicKey();
      builder.addPayment(destination, StellarSdk.Asset.native(), "100");

      const validation = builder.validate();
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should fail validation with no operations", () => {
      const builder = new UnifiedTransactionBuilder({
        source,
        networkPassphrase,
        flow: TransactionFlow.CHAIN,
      });

      const validation = builder.validate();
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain("No operations added to transaction");
    });

    it("should fail validation for sponsorship without config", () => {
      const builder = new UnifiedTransactionBuilder({
        source,
        networkPassphrase,
        flow: TransactionFlow.SPONSOR,
      });

      const validation = builder.validate();
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain("Sponsorship flow requires sponsorship config");
    });
  });

  describe("createPreset", () => {
    it("should create simple payment preset", () => {
      const builder = UnifiedTransactionBuilder.createPreset(
        "simple_payment",
        source,
        networkPassphrase
      );

      expect(builder).toBeDefined();
    });

    it("should create sponsored trustline preset", () => {
      const builder = UnifiedTransactionBuilder.createPreset(
        "sponsored_trustline",
        source,
        networkPassphrase
      );

      expect(builder).toBeDefined();
    });

    it("should create multisig payment preset", () => {
      const builder = UnifiedTransactionBuilder.createPreset(
        "multisig_payment",
        source,
        networkPassphrase
      );

      expect(builder).toBeDefined();
    });
  });

  describe("helper functions", () => {
    it("createSimplePayment should return XDR", () => {
      const destination = StellarSdk.Keypair.random().publicKey();
      const xdr = createSimplePayment(
        source,
        destination,
        StellarSdk.Asset.native(),
        "100",
        networkPassphrase
      );

      expect(typeof xdr).toBe("string");
      expect(xdr.length).toBeGreaterThan(0);
    });

    it("createSponsoredTrustline should return XDR", () => {
      const sponsoredAccount = StellarSdk.Keypair.random().publicKey();
      const asset = new StellarSdk.Asset(
        "USDC",
        "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
      );

      const xdr = createSponsoredTrustline(
        source,
        sponsoredAccount,
        asset,
        "10000",
        networkPassphrase
      );

      expect(typeof xdr).toBe("string");
      expect(xdr.length).toBeGreaterThan(0);
    });

    it("createMultisigPayment should return XDR", () => {
      const destination = StellarSdk.Keypair.random().publicKey();
      const multisigConfig: MultiSigConfig = {
        masterAccount: source.publicKey(),
        signers: [],
        thresholds: { low: 1, medium: 2, high: 3 },
      };

      const xdr = createMultisigPayment(
        source,
        destination,
        StellarSdk.Asset.native(),
        "100",
        networkPassphrase,
        multisigConfig
      );

      expect(typeof xdr).toBe("string");
      expect(xdr.length).toBeGreaterThan(0);
    });
  });
});
