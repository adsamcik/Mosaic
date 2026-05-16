/**
 * Mosaic Crypto Library - Utility Functions
 *
 * Helper functions for byte manipulation and cryptographic operations.
 */


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
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/**
 * Securely zero memory containing sensitive data.
 *
 * @param buffer - Buffer to zero
 */
export function memzero(buffer: Uint8Array): void {
  // Best-effort JS zeroization: engines may keep prior copies internally,
  // but callers should still overwrite live Uint8Array buffers promptly.
  buffer.fill(0);
}

/**
 * Generate cryptographically secure random bytes.
 *
 * @param length - Number of bytes to generate
 * @returns Random bytes
 */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error('random byte length must be a non-negative safe integer');
  }
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Convert bytes to base64url string (no padding).
 *
 * @param data - Bytes to encode
 * @returns Base64url string
 */
export function toBase64(data: Uint8Array): string {
  const binary = String.fromCharCode(...data);
  const base64 = typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(data).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Convert base64 string to bytes.
 * Accepts both URL-safe Base64 (with - and _) and standard Base64 (with + and /).
 * Handles both padded and unpadded input.
 *
 * This is important because .NET serializes byte[] to standard Base64,
 * but we use URL-safe Base64 internally.
 *
 * @param base64 - Base64 string (standard or URL-safe, with or without padding)
 * @returns Decoded bytes
 */
export function fromBase64(base64: string): Uint8Array {
  const standard = base64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard.padEnd(standard.length + ((4 - (standard.length % 4)) % 4), '=');
  const binary = typeof atob === 'function'
    ? atob(padded)
    : Buffer.from(padded, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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
