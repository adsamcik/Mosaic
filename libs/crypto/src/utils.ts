/**
 * Mosaic Crypto Library - Utility Functions
 *
 * Helper functions for byte manipulation and cryptographic operations.
 */

import sodium from 'libsodium-wrappers';

/**
 * Concatenate multiple Uint8Arrays into a single array.
 *
 * @param arrays - Arrays to concatenate
 * @returns Combined array
 */
export function concat(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Constant-time comparison of two byte arrays.
 * Returns true if arrays are equal, false otherwise.
 *
 * @param a - First array
 * @param b - Second array
 * @returns true if equal
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  // sodium.compare returns 0 if equal, -1 or 1 if not
  return sodium.compare(a, b) === 0;
}

/**
 * Compute SHA256 hash of data.
 *
 * @param data - Data to hash
 * @returns Hash as base64url string (no padding)
 */
export async function sha256(data: Uint8Array): Promise<string> {
  // Copy to new ArrayBuffer to satisfy crypto.subtle.digest type requirements
  const buffer = new ArrayBuffer(data.length);
  new Uint8Array(buffer).set(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return sodium.to_base64(
    new Uint8Array(hashBuffer),
    sodium.base64_variants.URLSAFE_NO_PADDING
  );
}

/**
 * Synchronous SHA256 using libsodium's generichash.
 * Useful when async is not convenient.
 *
 * @param data - Data to hash
 * @returns Hash as base64url string (no padding)
 */
export function sha256Sync(data: Uint8Array): string {
  const hash = sodium.crypto_generichash(32, data);
  return sodium.to_base64(hash, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/**
 * Securely zero memory containing sensitive data.
 *
 * @param buffer - Buffer to zero
 */
export function memzero(buffer: Uint8Array): void {
  sodium.memzero(buffer);
}

/**
 * Generate cryptographically secure random bytes.
 *
 * @param length - Number of bytes to generate
 * @returns Random bytes
 */
export function randomBytes(length: number): Uint8Array {
  return sodium.randombytes_buf(length);
}

/**
 * Convert bytes to base64url string (no padding).
 *
 * @param data - Bytes to encode
 * @returns Base64url string
 */
export function toBase64(data: Uint8Array): string {
  return sodium.to_base64(data, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/**
 * Convert base64url string to bytes.
 *
 * @param base64 - Base64url string (with or without padding)
 * @returns Decoded bytes
 */
export function fromBase64(base64: string): Uint8Array {
  return sodium.from_base64(base64, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/**
 * Convert string to UTF-8 bytes.
 *
 * @param str - String to encode
 * @returns UTF-8 bytes
 */
export function toBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Convert UTF-8 bytes to string.
 *
 * @param bytes - Bytes to decode
 * @returns Decoded string
 */
export function fromBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
