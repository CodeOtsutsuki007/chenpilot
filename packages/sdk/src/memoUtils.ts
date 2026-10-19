/**
 * Memo Utilities for Stellar Transactions
 * Provides simplified utilities for building and validating Hash and Return memo types.
 */

import { Memo } from "@stellar/stellar-sdk";

/**
 * Represents a memo value with its type
 */
export interface MemoValue {
  type: "hash" | "return";
  value: Buffer;
}

/**
 * Error class for memo validation failures
 */
export class MemoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoValidationError";
  }
}

/**
 * Validates that a buffer is a valid 32-byte hash for memo operations
 * @param buffer - The buffer to validate
 * @throws {MemoValidationError} if buffer is not exactly 32 bytes
 * @returns true if valid
 */
export function isValidMemoHash(buffer: Buffer | Uint8Array): boolean {
  if (!buffer || (buffer as any).length !== 32) {
    throw new MemoValidationError(
      `Memo hash must be exactly 32 bytes, received ${
        (buffer as any).length || 0
      } bytes`
    );
  }
  return true;
}

/**
 * Builds a Hash memo from a buffer or string
 * @param input - Buffer (must be 32 bytes) or hex string (must be 64 chars) representing the hash
 * @returns Stellar SDK Memo object
 * @throws {MemoValidationError} if input is invalid
 */
export function buildHashMemo(input: Buffer | string | Uint8Array): Memo {
  let buffer: Buffer;

  if (typeof input === "string") {
    // Validate hex string length (64 chars = 32 bytes)
    if (!/^[0-9a-fA-F]{64}$/.test(input)) {
      throw new MemoValidationError(
        "Hash memo hex string must be exactly 64 hexadecimal characters (32 bytes)"
      );
    }
    buffer = Buffer.from(input, "hex");
  } else if (input instanceof Uint8Array || Buffer.isBuffer(input)) {
    buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  } else {
    throw new MemoValidationError(
      "Hash input must be a Buffer, Uint8Array, or hex string"
    );
  }

  isValidMemoHash(buffer);
  return Memo.hash(buffer);
}

/**
 * Builds a Return memo from a buffer or string
 * @param input - Buffer (must be 32 bytes) or hex string (must be 64 chars) representing the return hash
 * @returns Stellar SDK Memo object
 * @throws {MemoValidationError} if input is invalid
 */
export function buildReturnMemo(input: Buffer | string | Uint8Array): Memo {
  let buffer: Buffer;

  if (typeof input === "string") {
    // Validate hex string length (64 chars = 32 bytes)
    if (!/^[0-9a-fA-F]{64}$/.test(input)) {
      throw new MemoValidationError(
        "Return memo hex string must be exactly 64 hexadecimal characters (32 bytes)"
      );
    }
    buffer = Buffer.from(input, "hex");
  } else if (input instanceof Uint8Array || Buffer.isBuffer(input)) {
    buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  } else {
    throw new MemoValidationError(
      "Return input must be a Buffer, Uint8Array, or hex string"
    );
  }

  isValidMemoHash(buffer);
  return Memo.return(buffer);
}

/**
 * Validates a memo object
 * @param memo - Stellar SDK Memo object to validate
 * @returns true if memo is valid
 * @throws {MemoValidationError} if memo is invalid
 */
export function validateMemo(memo: Memo): boolean {
  if (!memo) {
    throw new MemoValidationError("Memo cannot be null or undefined");
  }

  if (memo.type === "hash" || memo.type === "return") {
    if (!memo.value || (memo.value as any).length !== 32) {
      throw new MemoValidationError(
        `${memo.type} memo value must be exactly 32 bytes`
      );
    }
  }

  return true;
}

/**
 * Converts a memo to its hex string representation
 * @param memo - Stellar SDK Memo object
 * @returns Hex string representation of the memo value
 * @throws {MemoValidationError} if memo is not a hash or return type
 */
export function memoToHex(memo: Memo): string {
  if (memo.type !== "hash" && memo.type !== "return") {
    throw new MemoValidationError(
      `Cannot convert memo type '${memo.type}' to hex. Only 'hash' and 'return' types are supported.`
    );
  }

  const value = memo.value as Buffer | Uint8Array;
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.toString("hex");
}

/**
 * Converts a memo hex string back to a Buffer
 * @param hex - Hex string representation (must be 64 characters)
 * @returns Buffer representation
 * @throws {MemoValidationError} if hex string is invalid
 */
export function hexToMemoBuffer(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new MemoValidationError(
      "Hex string must be exactly 64 hexadecimal characters (32 bytes)"
    );
  }
  return Buffer.from(hex, "hex");
}

/**
 * Compares two memo values for equality
 * @param memo1 - First memo to compare
 * @param memo2 - Second memo to compare
 * @returns true if both memos have the same type and value
 */
export function compareMemos(memo1: Memo, memo2: Memo): boolean {
  if (memo1.type !== memo2.type) {
    return false;
  }

  if (memo1.type === "hash" || memo1.type === "return") {
    const hex1 = memoToHex(memo1);
    const hex2 = memoToHex(memo2);
    return hex1 === hex2;
  }

  return memo1.value === memo2.value;
}
