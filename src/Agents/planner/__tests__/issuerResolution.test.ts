// chenpilot/src/Agents/planner/__tests__/issuerResolution.test.ts
import {
  IssuerResolutionService,
  issuerResolutionService,
} from "../issuerResolution";
import * as StellarSdk from "@stellar/stellar-sdk";

describe("IssuerResolutionService", () => {
  let service: IssuerResolutionService;

  beforeEach(() => {
    service = new IssuerResolutionService();
  });

  describe("resolveAsset", () => {
    it("should resolve native XLM without ambiguity", () => {
      const result = service.resolveAsset("XLM");
      expect(result.resolutionType).toBe("single");
      expect(result.isAmbiguous).toBe(false);
      expect(result.asset.isNative()).toBe(true);
    });

    it("should resolve asset with explicit issuer", () => {
      service.addKnownIssuer({
        code: "USDC",
        issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        description: "Circle USDC",
        isVerified: true,
      });

      const result = service.resolveAsset(
        "USDC",
        "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
      );

      expect(result.resolutionType).toBe("explicit");
      expect(result.isAmbiguous).toBe(false);
      expect(result.matchedIssuer).toBe(
        "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
      );
    });

    it("should mark asset as ambiguous when multiple issuers exist", () => {
      service.addKnownIssuer({
        code: "USDC",
        issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        description: "Circle USDC",
        isVerified: true,
      });
      service.addKnownIssuer({
        code: "USDC",
        issuer: "GBBM6BKZQHWBZWDC43ERMXV5OQ7I4XTDBKYGPOJBQBT4U2EFGWBACLSF",
        description: "Another USDC",
        isVerified: false,
      });

      const result = service.resolveAsset("USDC");

      expect(result.resolutionType).toBe("ambiguous");
      expect(result.isAmbiguous).toBe(true);
      expect(result.alternatives).toHaveLength(2);
    });

    it("should return unknown for unrecognized assets", () => {
      const result = service.resolveAsset("UNKNOWN");
      expect(result.resolutionType).toBe("unknown");
      expect(result.isAmbiguous).toBe(false);
    });
  });

  describe("isAmbiguous", () => {
    it("should return false for XLM", () => {
      expect(service.isAmbiguous("XLM")).toBe(false);
    });

    it("should return false for single issuer assets", () => {
      service.addKnownIssuer({
        code: "USDC",
        issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      });
      expect(service.isAmbiguous("USDC")).toBe(false);
    });

    it("should return true for multiple issuer assets", () => {
      service.addKnownIssuer({
        code: "USDC",
        issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      });
      service.addKnownIssuer({
        code: "USDC",
        issuer: "GBBM6BKZQHWBZWDC43ERMXV5OQ7I4XTDBKYGPOJBQBT4U2EFGWBACLSF",
      });
      expect(service.isAmbiguous("USDC")).toBe(true);
    });
  });

  describe("extractAmbiguousAssets", () => {
    it("should extract ambiguous assets from input", () => {
      service.addKnownIssuer({
        code: "USDC",
        issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      });
      service.addKnownIssuer({
        code: "USDC",
        issuer: "GBBM6BKZQHWBZWDC43ERMXV5OQ7I4XTDBKYGPOJBQBT4U2EFGWBACLSF",
      });

      const result = service.extractAmbiguousAssets("Swap 100 USDC to XLM");
      expect(result).toContain("USDC");
    });

    it("should not extract non-ambiguous assets", () => {
      service.addKnownIssuer({
        code: "USDC",
        issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      });

      const result = service.extractAmbiguousAssets("Swap 100 USDC to XLM");
      expect(result).not.toContain("USDC");
    });
  });

  describe("generateIssuerSelectionPrompt", () => {
    it("should generate a prompt for ambiguous assets", () => {
      service.addKnownIssuer({
        code: "USDC",
        issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        description: "Circle USDC",
        isVerified: true,
      });
      service.addKnownIssuer({
        code: "USDC",
        issuer: "GBBM6BKZQHWBZWDC43ERMXV5OQ7I4XTDBKYGPOJBQBT4U2EFGWBACLSF",
        description: "Another USDC",
        isVerified: false,
      });

      const prompt = service.generateIssuerSelectionPrompt("USDC");

      expect(prompt).toContain("USDC");
      expect(prompt).toContain("GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
      expect(prompt).toContain("Circle USDC");
      expect(prompt).toContain("✓ Verified");
    });

    it("should indicate unknown asset", () => {
      const prompt = service.generateIssuerSelectionPrompt("UNKNOWN");
      expect(prompt).toContain("not recognized");
    });
  });
});
