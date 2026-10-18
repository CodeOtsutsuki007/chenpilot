import { SecretDescriptor } from "./types";

/**
 * Every secret the application reads through SecretManager, with the
 * workflows allowed to read it. Adding a workflow here is a privilege change
 * and should be reviewed like one.
 */
export const SECRET_CATALOG: readonly SecretDescriptor[] = [
  {
    name: "stellar.sponsor-key",
    description: "Stellar account that sponsors new user accounts",
    kind: "wallet",
    envVar: "SPONSOR_SECRET_KEY",
    workflows: ["sponsorship"],
    environments: ["local", "staging", "production"],
    maxLeaseMs: 30_000,
    minLength: 56,
  },
  {
    name: "capability.signing-key",
    description: "HMAC key that signs agent capability grants",
    kind: "service",
    envVar: "CAPABILITY_SECRET_KEY",
    workflows: ["capability"],
    environments: ["local", "staging", "production"],
    maxLeaseMs: 5_000,
    minLength: 32,
    // Historical development default; refused outside local.
    localDefault: "chenpilot-capability-secret-key-default-2026",
  },
  {
    name: "revocation.signing-key",
    description: "HMAC key that signs asset revocation records",
    kind: "service",
    envVar: "REVOCATION_SIGNING_KEY",
    workflows: ["asset-revocation"],
    environments: ["local", "staging", "production"],
    maxLeaseMs: 5_000,
    minLength: 32,
    // Historical development default; refused outside local.
    localDefault: "default-dev-signing-key",
  },
  {
    name: "provider.anthropic",
    description: "Anthropic API key used by the agent",
    kind: "provider",
    envVar: "ANTHROPIC_API_KEY",
    workflows: ["agent"],
    environments: ["local", "staging", "production"],
    maxLeaseMs: 60_000,
  },
];

/**
 * Placeholder values used by tests and examples. Seeing one in a shared
 * environment means local configuration leaked into a deployment.
 */
export const KNOWN_PLACEHOLDER_VALUES: ReadonlySet<string> = new Set([
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "sk-test-placeholder",
  "test-anthropic-key",
  "mock-anthropic-key-for-test-suite",
  "test-only-jwt-secret-0123456789abcdef",
  "01234567890123456789012345678901",
  "default_test_jwt_secret_32_chars_long_12345",
  "secret-token",
  "default-dev-signing-key",
  "chenpilot-capability-secret-key-default-2026",
]);
