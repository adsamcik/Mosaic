/**
 * Buffer Utilities
 *
 * Safe conversion utilities for typed arrays used with Web Crypto API
 * and libsodium, which require `Uint8Array<ArrayBuffer>` rather than
 * `Uint8Array<ArrayBufferLike>`.
 */

/**
 * Ensure a Uint8Array is backed by a plain ArrayBuffer.
 *
 * Web Crypto API methods (encrypt, decrypt, importKey) require
 * `Uint8Array<ArrayBuffer>`. When data originates from a Worker
 * (SharedArrayBuffer) or a view over a larger buffer, a blind
 * `as` cast is unsafe. This function validates at runtime and
 * copies only when necessary.
 */
export function toArrayBufferView(data: Uint8Array): Uint8Array<ArrayBuffer> {
  if (data.buffer instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
    return data as Uint8Array<ArrayBuffer>;
  }
  // Copy to a dedicated ArrayBuffer (handles SharedArrayBuffer, sub-views, etc.)
  const copy = new Uint8Array(data.length);
  copy.set(data);
  return copy as Uint8Array<ArrayBuffer>;
}
