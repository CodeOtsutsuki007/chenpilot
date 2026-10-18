import fs from "fs";
import path from "path";
import logger from "../config/logger";
import { decrypt } from "../utils/encryption";
import {
  isSharedEnvironment,
  resolveDeploymentEnvironment,
} from "../Security/secrets/environment";

/** Decrypted account data is dropped from memory after this long. */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Errors from this module never carry decrypted material: JSON.parse and
 * crypto errors can echo their input, so they are replaced with codes.
 */
export class AccountSecretError extends Error {
  constructor(
    public readonly code:
      | "not_configured"
      | "source_missing"
      | "plaintext_forbidden"
      | "decrypt_failed"
      | "malformed_payload"
      | "account_not_found",
    message: string
  ) {
    super(message);
    this.name = "AccountSecretError";
  }
}

function plaintextAllowed(): boolean {
  if (process.env.ALLOW_PLAINTEXT_ACCOUNTS !== "true") return false;
  if (isSharedEnvironment(resolveDeploymentEnvironment())) {
    throw new AccountSecretError(
      "plaintext_forbidden",
      "ALLOW_PLAINTEXT_ACCOUNTS is not permitted in staging or production"
    );
  }
  return true;
}

export interface AccountData {
  userId: string;
  [key: string]: unknown;
}

function resolveFilePath(filePath: string): string {
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
}

function loadEncryptedAccountsPayload(): string {
  const encryptedJsonB64 = process.env.ENCRYPTED_ACCOUNTS_JSON_B64?.trim();
  const encryptedJsonPath = process.env.ENCRYPTED_ACCOUNTS_JSON_PATH?.trim();

  if (encryptedJsonB64) {
    return encryptedJsonB64;
  }

  if (encryptedJsonPath) {
    const resolvedPath = resolveFilePath(encryptedJsonPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new AccountSecretError(
        "source_missing",
        `Encrypted accounts file not found at path: ${resolvedPath}`
      );
    }
    return fs.readFileSync(resolvedPath, "utf8").trim();
  }

  if (plaintextAllowed()) {
    const plaintextPath = process.env.ACCOUNTS_JSON_PATH;
    if (!plaintextPath) {
      throw new AccountSecretError(
        "not_configured",
        "ALLOW_PLAINTEXT_ACCOUNTS=true is set but ACCOUNTS_JSON_PATH is missing"
      );
    }
    const resolvedPath = resolveFilePath(plaintextPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new AccountSecretError(
        "source_missing",
        `Plaintext accounts file not found at path: ${resolvedPath}`
      );
    }
    logger.warn(
      "Loading plaintext account data from ACCOUNTS_JSON_PATH. This is only allowed in non-production development environments."
    );
    return fs.readFileSync(resolvedPath, "utf8");
  }

  throw new AccountSecretError(
    "not_configured",
    "Encrypted account secrets are not configured. Set ENCRYPTED_ACCOUNTS_JSON_PATH or ENCRYPTED_ACCOUNTS_JSON_B64."
  );
}

function parseAccountData(payload: string): AccountData[] {
  let rawJson = payload;

  try {
    rawJson = decrypt(payload);
  } catch {
    if (plaintextAllowed()) {
      logger.warn(
        "Falling back to plaintext account JSON because ALLOW_PLAINTEXT_ACCOUNTS=true"
      );
    } else {
      throw new AccountSecretError(
        "decrypt_failed",
        "Failed to decrypt account secrets payload"
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new AccountSecretError(
      "malformed_payload",
      "Account secret payload is not valid JSON"
    );
  }
  if (!Array.isArray(parsed)) {
    throw new AccountSecretError(
      "malformed_payload",
      "Account secret payload must resolve to an array"
    );
  }

  return parsed as AccountData[];
}

export class AccountSecretStore {
  private accountsCache?: AccountData[];
  private cacheExpiresAt = 0;

  constructor(
    private readonly cacheTtlMs = Number(process.env.ACCOUNT_SECRET_CACHE_TTL_MS) || DEFAULT_CACHE_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  getAccounts(): AccountData[] {
    if (!this.accountsCache || this.now() >= this.cacheExpiresAt) {
      const payload = loadEncryptedAccountsPayload();
      this.accountsCache = parseAccountData(payload);
      this.cacheExpiresAt = this.now() + this.cacheTtlMs;
    }
    return this.accountsCache;
  }

  /**
   * @param workflow Which flow needs the credential; recorded with the access
   *                 (never the credential itself).
   */
  getAccountByUserId<T extends AccountData = AccountData>(userId: string, workflow = "unspecified"): T {
    const account = this.getAccounts().find((item) => item.userId === userId);
    if (!account) {
      logger.warn("Wallet credential lookup failed", { userId, workflow, outcome: "account_not_found" });
      throw new AccountSecretError("account_not_found", `Account secret not found for userId: ${userId}`);
    }
    logger.info("Wallet credential accessed", { userId, workflow });
    return account as T;
  }

  /**
   * Clear the in-memory cache of decrypted account data.
   * Sensitive material will be recreated on next access from the
   * encrypted source, reducing the window of plaintext retention.
   */
  clearCache(): void {
    this.accountsCache = undefined;
    this.cacheExpiresAt = 0;
  }
}

export const accountSecretStore = new AccountSecretStore();
