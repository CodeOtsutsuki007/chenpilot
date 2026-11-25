/**
 * Report Export Manifest and Checksum Service
 * 
 * Provides versioned manifest wrapping, cryptographic checksum (SHA-256) generation,
 * and validation for generated reports.
 */

import * as crypto from "crypto";

export const CURRENT_REPORT_MANIFEST_VERSION = "1.0.0";
export const MINIMUM_COMPATIBLE_REPORT_MANIFEST_VERSION = "1.0.0";

export interface ReportManifest<T = unknown> {
  manifestVersion: string;
  generatedAt: string;
  checksum: string;
  payload: T;
}

export interface ReportValidationResult {
  valid: boolean;
  compatible: boolean;
  errors: string[];
}

/**
 * Parse a semantic version string
 */
function parseVersion(version: string): { major: number; minor: number; patch: number } {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid version format: ${version}`);
  }
  return {
    major: parts[0],
    minor: parts[1],
    patch: parts[2],
  };
}

/**
 * Compare two semantic versions
 * 
 * @returns -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2
 */
function compareVersions(v1: string, v2: string): number {
  const parsed1 = parseVersion(v1);
  const parsed2 = parseVersion(v2);

  if (parsed1.major !== parsed2.major) {
    return parsed1.major < parsed2.major ? -1 : 1;
  }
  if (parsed1.minor !== parsed2.minor) {
    return parsed1.minor < parsed2.minor ? -1 : 1;
  }
  if (parsed1.patch !== parsed2.patch) {
    return parsed1.patch < parsed2.patch ? -1 : 1;
  }
  return 0;
}

/**
 * Generate a SHA-256 checksum for the report payload string or buffer.
 */
export function generateReportChecksum(payload: unknown): string {
  const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
  return crypto.createHash("sha256").update(serialized, "utf8").digest("hex");
}

/**
 * Wrap a report payload into a versioned manifest with checksum.
 */
export function createReportManifest<T>(payload: T, manifestVersion: string = CURRENT_REPORT_MANIFEST_VERSION): ReportManifest<T> {
  const serialized = JSON.stringify(payload);
  const checksum = generateReportChecksum(serialized);
  return {
    manifestVersion,
    generatedAt: new Date().toISOString(),
    checksum,
    payload,
  };
}

/**
 * Validate a report manifest for structure, schema compatibility, and checksum integrity.
 */
export function validateReportManifest(manifestUnknown: unknown): ReportValidationResult {
  const errors: string[] = [];

  if (!manifestUnknown || typeof manifestUnknown !== "object") {
    return {
      valid: false,
      compatible: false,
      errors: ["Manifest must be a non-null object"],
    };
  }

  const manifest = manifestUnknown as Record<string, unknown>;

  if (typeof manifest.manifestVersion !== "string" || !manifest.manifestVersion) {
    errors.push("Missing or invalid manifestVersion");
  }

  if (typeof manifest.generatedAt !== "string" || !manifest.generatedAt) {
    errors.push("Missing or invalid generatedAt timestamp");
  }

  if (typeof manifest.checksum !== "string" || !manifest.checksum) {
    errors.push("Missing or invalid checksum");
  }

  if (manifest.payload === undefined) {
    errors.push("Missing payload");
  }

  if (errors.length > 0) {
    return {
      valid: false,
      compatible: false,
      errors,
    };
  }

  const manifestVersion = manifest.manifestVersion as string;
  let compatible = false;
  try {
    const parsed = parseVersion(manifestVersion);
    const minParsed = parseVersion(MINIMUM_COMPATIBLE_REPORT_MANIFEST_VERSION);
    const curParsed = parseVersion(CURRENT_REPORT_MANIFEST_VERSION);

    if (parsed.major === curParsed.major && compareVersions(manifestVersion, MINIMUM_COMPATIBLE_REPORT_MANIFEST_VERSION) >= 0) {
      compatible = true;
    } else {
      errors.push(`Manifest version ${manifestVersion} is outside compatible range [${MINIMUM_COMPATIBLE_REPORT_MANIFEST_VERSION}, ${CURRENT_REPORT_MANIFEST_VERSION}]`);
    }
  } catch {
    errors.push(`Invalid manifest version format: ${manifestVersion}`);
    return {
      valid: false,
      compatible: false,
      errors,
    };
  }

  // Verify checksum integrity
  const expectedChecksum = generateReportChecksum(JSON.stringify(manifest.payload));
  if (expectedChecksum !== manifest.checksum) {
    errors.push(`Checksum verification failed: expected ${expectedChecksum}, received ${manifest.checksum}`);
  }

  return {
    valid: errors.length === 0,
    compatible,
    errors,
  };
}
