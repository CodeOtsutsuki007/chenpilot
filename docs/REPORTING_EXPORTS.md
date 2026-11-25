# Reporting Exports Versioned Manifest and Integrity

## Overview
Generated report exports provided by Chen Pilot include a versioned schema manifest and cryptographic SHA-256 checksum integrity verification. This ensures report consumers can validate both structural compatibility and end-to-end payload integrity.

## Manifest Structure
Each exported report is wrapped in a JSON structure containing:
- `manifestVersion`: Semantic version of the export schema (e.g., `"1.0.0"`).
- `generatedAt`: ISO 8601 timestamp of export generation.
- `checksum`: Hex-encoded SHA-256 checksum of the serialized payload.
- `payload`: The underlying report data object.

## Verification & Compatibility
Consumers should utilize `validateReportManifest(data)` to inspect:
1. Presence of all required manifest headers.
2. Schema version compatibility against current (`1.0.0`) and minimum supported bounds.
3. Cryptographic integrity via re-computing and comparing the SHA-256 checksum against the payload.
