/**
 * Share-link URL encoding utilities.
 *
 * Pure base64url encoders/decoders for the public link ID and the (still
 * URL-fragment-secret) link secret. None of these helpers touch real key
 * material in the cryptographic sense — they exist so that the share-link
 * URL format stays a pure TS concern, separate from the Rust crypto core.
 *
 * Slice 6 — the legacy `decodeLinkSecret`/`decodeLinkId`/`encodeLinkSecret`/
 * `encodeLinkId` exports from `@mosaic/crypto` were libsodium base64url
 * helpers. Re-implementing them here lets share-link callers drop the
 * `@mosaic/crypto` import without losing the URL-shape parser. The link
 * secret itself stays opaque in the URL fragment; this module never
 * derives wrapping keys or talks to the worker.
 */

/** Link secret size in bytes. Mirrors `@mosaic/crypto`'s LINK_SECRET_SIZE. */
export const LINK_SECRET_SIZE = 32;

/** Link ID size in bytes. Mirrors `@mosaic/crypto`'s LINK_ID_SIZE. */
export const LINK_ID_SIZE = 16;

/**
 * Encode a byte array using base64url (URL-safe, no padding).
 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  const standard = btoa(binary);
  return standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Decode a base64url string (URL-safe, no padding) into a byte array.
 *
 * Throws if the input contains non-base64url characters or has an invalid
 * padded length. Empty input returns a zero-length array.
 */
function fromBase64Url(encoded: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) {
    throw new Error('Invalid base64url characters');
  }
  const padLen = (4 - (encoded.length % 4)) % 4;
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encode a 32-byte link secret for use in the share-link URL fragment.
 */
export function encodeLinkSecret(linkSecret: Uint8Array): string {
  if (linkSecret.length !== LINK_SECRET_SIZE) {
    throw new Error(
      `Link secret must be ${LINK_SECRET_SIZE} bytes, got ${linkSecret.length}`,
    );
  }
  return toBase64Url(linkSecret);
}

/**
 * Decode a base64url-encoded link secret from the URL fragment back into
 * its 32-byte form.
 */
export function decodeLinkSecret(encoded: string): Uint8Array {
  const decoded = fromBase64Url(encoded);
  if (decoded.length !== LINK_SECRET_SIZE) {
    throw new Error(
      `Invalid link secret length: expected ${LINK_SECRET_SIZE}, got ${decoded.length}`,
    );
  }
  return decoded;
}

/**
 * Encode a 16-byte link ID for use in the share-link URL path.
 */
export function encodeLinkId(linkId: Uint8Array): string {
  if (linkId.length !== LINK_ID_SIZE) {
    throw new Error(
      `Link ID must be ${LINK_ID_SIZE} bytes, got ${linkId.length}`,
    );
  }
  return toBase64Url(linkId);
}

/**
 * Decode a base64url-encoded link ID from the URL path back into its
 * 16-byte form.
 */
export function decodeLinkId(encoded: string): Uint8Array {
  const decoded = fromBase64Url(encoded);
  if (decoded.length !== LINK_ID_SIZE) {
    throw new Error(
      `Invalid link ID length: expected ${LINK_ID_SIZE}, got ${decoded.length}`,
    );
  }
  return decoded;
}

/**
 * Length-stable byte comparison.
 *
 * Used to compare a derived link ID against the link ID supplied in the
 * URL — neither side is secret (the link ID is published in the URL
 * path), but a length-stable compare avoids accidentally exposing the
 * compared lengths through micro-benchmarking. Returns false immediately
 * on mismatched length; otherwise xors every byte and reports zero.
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
