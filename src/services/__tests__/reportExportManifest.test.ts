import {
  CURRENT_REPORT_MANIFEST_VERSION,
  MINIMUM_COMPATIBLE_REPORT_MANIFEST_VERSION,
  createReportManifest,
  generateReportChecksum,
  validateReportManifest,
} from "../reportExportManifest";

describe("reportExportManifest", () => {
  const samplePayload = { reportType: "operator_summary", totalVolume: "12500.50", itemsCount: 42 };

  it("generates correct checksum for payload", () => {
    const serialized = JSON.stringify(samplePayload);
    const checksum = generateReportChecksum(serialized);
    expect(typeof checksum).toBe("string");
    expect(checksum.length).toBe(64);
  });

  it("creates valid report manifest with correct version and checksum", () => {
    const manifest = createReportManifest(samplePayload);
    expect(manifest.manifestVersion).toBe(CURRENT_REPORT_MANIFEST_VERSION);
    expect(manifest.generatedAt).toBeDefined();
    expect(manifest.checksum).toBe(generateReportChecksum(JSON.stringify(samplePayload)));
    expect(manifest.payload).toEqual(samplePayload);
  });

  it("successfully validates a correct manifest", () => {
    const manifest = createReportManifest(samplePayload);
    const result = validateReportManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.compatible).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails validation when checksum is tampered with", () => {
    const manifest = createReportManifest(samplePayload);
    manifest.checksum = "0000000000000000000000000000000000000000000000000000000000000000";
    const result = validateReportManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Checksum verification failed"))).toBe(true);
  });

  it("fails validation when payload is modified without updating checksum", () => {
    const manifest = createReportManifest(samplePayload);
    (manifest.payload as any).totalVolume = "99999.00";
    const result = validateReportManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Checksum verification failed"))).toBe(true);
  });

  it("rejects incompatible or unsupported manifest versions", () => {
    const manifest = createReportManifest(samplePayload, "99.0.0");
    const result = validateReportManifest(manifest);
    expect(result.compatible).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("outside compatible range"))).toBe(true);
  });

  it("rejects malformed manifest objects", () => {
    expect(validateReportManifest(null).valid).toBe(false);
    expect(validateReportManifest(undefined).valid).toBe(false);
    expect(validateReportManifest("not-an-object").valid).toBe(false);
    
    const incomplete = { manifestVersion: "1.0.0" };
    const result = validateReportManifest(incomplete);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
