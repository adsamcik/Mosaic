/**
 * Mosaic Crypto Library - Link Sharing Module
 *
 * Cryptographic operations for shareable album links.
 * Link secrets derive both a server lookup ID (linkId) and a wrapping key.
 * The server never sees the link secret - only the derived linkId.
 */

import sodium from 'libsodium-wrappers-sumo';
import {
  KEY_SIZE,
  AccessTier,
  type LinkKeys,
  type WrappedTierKey,
} from './types';
import { wrapKey, unwrapKey } from './keybox';
import { toBytes, randomBytes } from './utils';

/** Size of link secret in bytes (256-bit security) */
export const LINK_SECRET_SIZE = 32;

/** Size of link ID in bytes (128-bit, sufficient for lookup) */
export const LINK_ID_SIZE = 16;

/** Context for deriving link ID from secret */
const LINK_ID_CONTEXT = toBytes('mosaic:link:id:v1');

/** Context for deriving wrapping key from secret */
const LINK_WRAP_CONTEXT = toBytes('mosaic:link:wrap:v1');

/**
 * Generate a new random link secret.
 *
 * @returns 32-byte random secret for share link
 */
export function generateLinkSecret(): Uint8Array {
  return randomBytes(LINK_SECRET_SIZE);
}

/**
 * Derive link ID and wrapping key from a link secret.
 *
 * The link ID is used for server-side lookup (safe to expose).
 * The wrapping key is used to encrypt tier keys (never sent to server).
 *
 * @param linkSecret - 32-byte secret from URL fragment
 * @returns Object with linkId (16 bytes) and wrappingKey (32 bytes)
 */
export function deriveLinkKeys(linkSecret: Uint8Array): LinkKeys {
  if (linkSecret.length !== LINK_SECRET_SIZE) {
    throw new Error(
      `Link secret must be ${LINK_SECRET_SIZE} bytes, got ${linkSecret.length}`,
    );
  }

  // Derive 16-byte link ID using BLAKE2b HKDF-style
  const linkId = sodium.crypto_generichash(
    LINK_ID_SIZE,
    LINK_ID_CONTEXT,
    linkSecret,
  );

  // Derive 32-byte wrapping key using BLAKE2b HKDF-style
  const wrappingKey = sodium.crypto_generichash(
    KEY_SIZE,
    LINK_WRAP_CONTEXT,
    linkSecret,
  );

  return { linkId, wrappingKey };
}

/**
 * Wrap a single tier key for share link storage.
 *
 * The wrapped key is stored on the server, encrypted with the link's
 * wrapping key (derived from the link secret which server never sees).
 *
 * @param tierKey - 32-byte tier key to wrap
 * @param tier - Access tier of the key
 * @param wrappingKey - 32-byte key derived from link secret
 * @returns Wrapped tier key structure ready for server storage
 */
export function wrapTierKeyForLink(
  tierKey: Uint8Array,
  tier: AccessTier,
  wrappingKey: Uint8Array,
): WrappedTierKey {
  if (wrappingKey.length !== KEY_SIZE) {
    throw new Error(
      `Wrapping key must be ${KEY_SIZE} bytes, got ${wrappingKey.length}`,
    );
  }
  if (tierKey.length !== KEY_SIZE) {
    throw new Error(
      `Tier key must be ${KEY_SIZE} bytes, got ${tierKey.length}`,
    );
  }

  // Wrap the tier key
  const wrappedKey = wrapKey(tierKey, wrappingKey);

  return {
    tier,
    nonce: wrappedKey.subarray(0, 24),
    encryptedKey: wrappedKey.subarray(24),
  };
}

/**
 * Wrap all relevant tier keys for a share link.
 * For AccessTier.FULL, wraps thumbKey, previewKey, and fullKey.
 * For AccessTier.PREVIEW, wraps thumbKey and previewKey.
 * For AccessTier.THUMB, wraps only thumbKey.
 *
 * @param tierKeys - Object containing tier keys
 * @param accessTier - Maximum access tier to grant
 * @param wrappingKey - 32-byte key derived from link secret
 * @returns Array of wrapped tier keys
 */
export function wrapAllTierKeysForLink(
  tierKeys: {
    thumbKey: Uint8Array;
    previewKey: Uint8Array;
    fullKey: Uint8Array;
  },
  accessTier: AccessTier,
  wrappingKey: Uint8Array,
): WrappedTierKey[] {
  const results: WrappedTierKey[] = [];

  // Always include thumb key
  results.push(
    wrapTierKeyForLink(tierKeys.thumbKey, AccessTier.THUMB, wrappingKey),
  );

  // Include preview key if tier allows
  if (accessTier >= AccessTier.PREVIEW) {
    results.push(
      wrapTierKeyForLink(tierKeys.previewKey, AccessTier.PREVIEW, wrappingKey),
    );
  }

  // Include full key if tier allows
  if (accessTier >= AccessTier.FULL) {
    results.push(
      wrapTierKeyForLink(tierKeys.fullKey, AccessTier.FULL, wrappingKey),
    );
  }

  return results;
}

/**
 * Unwrap a tier key from share link storage.
 *
 * @param wrapped - Wrapped tier key from server
 * @param tier - Access tier being unwrapped (for AAD validation)
 * @param wrappingKey - 32-byte key derived from link secret
 * @returns Unwrapped 32-byte tier key
 */
export function unwrapTierKeyFromLink(
  wrapped: WrappedTierKey,
  tier: AccessTier,
  wrappingKey: Uint8Array,
): Uint8Array {
  if (wrapped.tier !== tier) {
    throw new Error(`Tier mismatch: expected ${tier}, got ${wrapped.tier}`);
  }

  // Reconstruct the full wrapped key (nonce || ciphertext)
  const fullWrapped = new Uint8Array(
    wrapped.nonce.length + wrapped.encryptedKey.length,
  );
  fullWrapped.set(wrapped.nonce, 0);
  fullWrapped.set(wrapped.encryptedKey, wrapped.nonce.length);

  return unwrapKey(fullWrapped, wrappingKey);
}

/**
 * Encode link secret for URL fragment.
 *
 * @param linkSecret - 32-byte secret
 * @returns Base64url encoded string (no padding)
 */
export function encodeLinkSecret(linkSecret: Uint8Array): string {
  return sodium.to_base64(
    linkSecret,
    sodium.base64_variants.URLSAFE_NO_PADDING,
  );
}

/**
 * Decode link secret from URL fragment.
 *
 * @param encoded - Base64url encoded string
 * @returns 32-byte link secret
 */
export function decodeLinkSecret(encoded: string): Uint8Array {
  const decoded = sodium.from_base64(
    encoded,
    sodium.base64_variants.URLSAFE_NO_PADDING,
  );
  if (decoded.length !== LINK_SECRET_SIZE) {
    throw new Error(
      `Invalid link secret length: expected ${LINK_SECRET_SIZE}, got ${decoded.length}`,
    );
  }
  return decoded;
}

/**
 * Encode link ID for URL path.
 *
 * @param linkId - 16-byte link ID
 * @returns Base64url encoded string (no padding)
 */
export function encodeLinkId(linkId: Uint8Array): string {
  return sodium.to_base64(linkId, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/**
 * Decode link ID from URL path.
 *
 * @param encoded - Base64url encoded string
 * @returns 16-byte link ID
 */
export function decodeLinkId(encoded: string): Uint8Array {
  const decoded = sodium.from_base64(
    encoded,
    sodium.base64_variants.URLSAFE_NO_PADDING,
  );
  if (decoded.length !== LINK_ID_SIZE) {
    throw new Error(
      `Invalid link ID length: expected ${LINK_ID_SIZE}, got ${decoded.length}`,
    );
  }
  return decoded;
}

/**
 * Create a complete share link URL.
 *
 * Format: {baseUrl}/s/{linkId}#k={linkSecret}
 *
 * @param baseUrl - Base URL of the application (e.g., https://photos.example.com)
 * @param linkSecret - 32-byte link secret
 * @returns Complete shareable URL
 */
export function createShareLinkUrl(
  baseUrl: string,
  linkSecret: Uint8Array,
): string {
  const { linkId } = deriveLinkKeys(linkSecret);
  const encodedLinkId = encodeLinkId(linkId);
  const encodedSecret = encodeLinkSecret(linkSecret);

  // Remove trailing slash from base URL if present
  const normalizedBase = baseUrl.replace(/\/$/, '');

  return `${normalizedBase}/s/${encodedLinkId}#k=${encodedSecret}`;
}

/**
 * Parse a share link URL to extract linkId and linkSecret.
 *
 * @param url - Complete share link URL
 * @returns Object with linkId and linkSecret, or null if invalid
 */
export function parseShareLinkUrl(url: string): {
  linkId: Uint8Array;
  linkSecret: Uint8Array;
} | null {
  try {
    const parsed = new URL(url);

    // Extract link ID from path: .../s/{linkId} (supports prefix paths)
    const pathMatch = parsed.pathname.match(/\/s\/([A-Za-z0-9_-]+)$/);
    // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement: Guard is semantically equivalent - mutation causes exception caught by try-catch, producing same null result
    if (!pathMatch || !pathMatch[1]) {
      return null;
    }
    const linkId = decodeLinkId(pathMatch[1]);

    // Extract link secret from fragment: #k={linkSecret}
    const fragment = parsed.hash;
    const secretMatch = fragment.match(/^#k=([A-Za-z0-9_-]+)$/);
    // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement: Guard is semantically equivalent - mutation causes exception caught by try-catch, producing same null result
    if (!secretMatch || !secretMatch[1]) {
      return null;
    }
    const linkSecret = decodeLinkSecret(secretMatch[1]);

    // Verify linkId matches derived value
    const { linkId: derivedLinkId } = deriveLinkKeys(linkSecret);
    if (!sodium.memcmp(linkId, derivedLinkId)) {
      return null; // linkId doesn't match secret - tampered or invalid
    }

    return { linkId, linkSecret };
  } catch (_error: unknown) {
    // Catch any parsing or validation errors
    return null;
  }
}
