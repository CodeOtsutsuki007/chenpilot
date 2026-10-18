/**
 * Secret redaction shared by the logger and anything else that emits
 * diagnostics. Has no dependencies so the logger can import it safely.
 */

export const REDACTED = "[REDACTED]";

/** Exact field names (normalized: lower-case, no "_" or "-") that always hold secrets. */
const SENSITIVE_KEYS = new Set([
  "pk",
  "privatekey",
  "encryptedprivatekey",
  "password",
  "token",
  "secret",
  "secretkey",
  "apikey",
  "authorization",
  "cookie",
  "setcookie",
  "mnemonic",
  "seed",
  "seedphrase",
  "clientsecret",
  "credentials",
]);

/** Suffixes that mark a field as secret, e.g. jwtSecret, sponsorSecretKey, botToken. */
const SENSITIVE_SUFFIXES = ["secret", "secretkey", "password", "privatekey", "apikey", "token", "mnemonic"];

/** Field names that end like a secret but are not. */
const NON_SENSITIVE_KEYS = new Set(["tokentype", "tokenaddress", "tokenid", "tokensymbol", "maxtokens", "inputtokens", "outputtokens", "totaltokens"]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (NON_SENSITIVE_KEYS.has(normalized)) return false;
  return SENSITIVE_KEYS.has(normalized) || SENSITIVE_SUFFIXES.some((s) => normalized.endsWith(s));
}

interface SecretPattern {
  name: string;
  pattern: RegExp;
  replacement: string;
}

/**
 * Value patterns for secrets that end up inside free-text strings (error
 * messages, URLs, stack traces). Deliberately does not match 64-char hex,
 * which is also the format of public transaction hashes.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    name: "pem-private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  { name: "stellar-secret-seed", pattern: /\bS[A-Z2-7]{55}\b/g, replacement: "[REDACTED_STELLAR_SECRET]" },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, replacement: "[REDACTED_JWT]" },
  { name: "bearer", pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: "$1 [REDACTED]" },
  { name: "provider-api-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replacement: "[REDACTED_API_KEY]" },
  { name: "url-credentials", pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, replacement: "$1[REDACTED]@" },
];

export function redactSecretsInString(value: string): string {
  let result = value;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** True when the string contains something that looks like a secret. */
export function containsSecret(value: string): boolean {
  return SECRET_PATTERNS.some(({ pattern }) => {
    pattern.lastIndex = 0;
    const found = pattern.test(value);
    pattern.lastIndex = 0;
    return found;
  });
}
