// chenpilot/src/Agents/planner/issuerResolution.ts
import * as StellarSdk from "@stellar/stellar-sdk";
import logger from "../../config/logger";

/**
 * Represents a known asset issuer
 */
export interface KnownIssuer {
  code: string;
  issuer: string;
  description?: string;
  isVerified?: boolean;
}

/**
 * Result of issuer resolution
 */
export interface IssuerResolutionResult {
  asset: StellarSdk.Asset;
  matchedIssuer?: string;
  isAmbiguous: boolean;
  alternatives?: KnownIssuer[];
  resolutionType: "explicit" | "single" | "ambiguous" | "unknown";
}

/**
 * Service for resolving asset issuers from symbols
 */
export class IssuerResolutionService {
  private knownIssuers: Map<string, KnownIssuer[]> = new Map();

  constructor() {
    this.initializeKnownIssuers();
  }

  /**
   * Initialize with commonly known issuers
   */
  private initializeKnownIssuers(): void {
    // USDC issuers
    this.addKnownIssuer({
      code: "USDC",
      issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      description: "Circle USDC on Stellar",
      isVerified: true,
    });

    // USDT issuers
    this.addKnownIssuer({
      code: "USDT",
      issuer: "GCQTGZQQ5G4PTM2GL7CDIFKUBIPEC52BROAQIAPW53XBRJVN6ZJVTG6V",
      description: "Tether USDT on Stellar",
      isVerified: true,
    });

    // Add more known issuers as needed
  }

  /**
   * Add a known issuer to the registry
   */
  addKnownIssuer(issuer: KnownIssuer): void {
    const code = issuer.code.toUpperCase();
    if (!this.knownIssuers.has(code)) {
      this.knownIssuers.set(code, []);
    }
    this.knownIssuers.get(code)!.push(issuer);
  }

  /**
   * Resolve an asset symbol to a Stellar asset, considering issuer ambiguity
   *
   * @param symbol - Asset code (e.g., "USDC")
   * @param explicitIssuer - Optional explicit issuer address
   * @returns Resolution result with asset and ambiguity information
   */
  resolveAsset(
    symbol: string,
    explicitIssuer?: string
  ): IssuerResolutionResult {
    const code = symbol.toUpperCase();

    // Native asset (XLM) - never ambiguous
    if (code === "XLM") {
      return {
        asset: StellarSdk.Asset.native(),
        resolutionType: "single",
        isAmbiguous: false,
      };
    }

    const knownIssuers = this.knownIssuers.get(code);

    // No known issuers - unknown asset
    if (!knownIssuers || knownIssuers.length === 0) {
      return {
        asset: new StellarSdk.Asset(code, "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"), // Placeholder
        resolutionType: "unknown",
        isAmbiguous: false,
      };
    }

    // Explicit issuer provided - use it if it matches known issuers
    if (explicitIssuer) {
      const matched = knownIssuers.find(
        (issuer) => issuer.issuer === explicitIssuer
      );

      if (matched) {
        return {
          asset: new StellarSdk.Asset(code, explicitIssuer),
          matchedIssuer: explicitIssuer,
          resolutionType: "explicit",
          isAmbiguous: false,
        };
      }

      // Explicit issuer not in known list - still create asset but warn
      logger.warn(
        `Explicit issuer ${explicitIssuer} for ${code} not in known issuers list`
      );
      return {
        asset: new StellarSdk.Asset(code, explicitIssuer),
        matchedIssuer: explicitIssuer,
        resolutionType: "explicit",
        isAmbiguous: false,
      };
    }

    // Single known issuer - use it
    if (knownIssuers.length === 1) {
      const issuer = knownIssuers[0];
      return {
        asset: new StellarSdk.Asset(code, issuer.issuer),
        matchedIssuer: issuer.issuer,
        resolutionType: "single",
        isAmbiguous: false,
      };
    }

    // Multiple known issuers - ambiguous
    return {
      asset: new StellarSdk.Asset(code, knownIssuers[0].issuer), // Default to first
      matchedIssuer: knownIssuers[0].issuer,
      resolutionType: "ambiguous",
      isAmbiguous: true,
      alternatives: knownIssuers,
    };
  }

  /**
   * Check if a symbol is ambiguous (has multiple known issuers)
   */
  isAmbiguous(symbol: string): boolean {
    const code = symbol.toUpperCase();
    if (code === "XLM") return false;

    const knownIssuers = this.knownIssuers.get(code);
    return knownIssuers !== undefined && knownIssuers.length > 1;
  }

  /**
   * Get all known issuers for a symbol
   */
  getKnownIssuers(symbol: string): KnownIssuer[] {
    const code = symbol.toUpperCase();
    return this.knownIssuers.get(code) || [];
  }

  /**
   * Generate a prompt for the user to select an issuer when ambiguous
   */
  generateIssuerSelectionPrompt(symbol: string): string {
    const issuers = this.getKnownIssuers(symbol);
    if (issuers.length === 0) {
      return `Asset ${symbol} is not recognized. Please provide the issuer address.`;
    }

    const options = issuers
      .map(
        (issuer, index) =>
          `${index + 1}. ${issuer.issuer}${issuer.description ? ` (${issuer.description})` : ""}${issuer.isVerified ? " ✓ Verified" : ""}`
      )
      .join("\n");

    return `The asset ${symbol} has multiple known issuers. Please specify which one to use:\n\n${options}\n\nPlease provide the issuer address or select by number.`;
  }

  /**
   * Extract asset symbols from user input that may be ambiguous
   */
  extractAmbiguousAssets(input: string): string[] {
    const assetPattern = /\b([A-Z]{3,12})\b/g;
    const matches = input.match(assetPattern) || [];

    return matches.filter((symbol) => this.isAmbiguous(symbol));
  }
}

export const issuerResolutionService = new IssuerResolutionService();
