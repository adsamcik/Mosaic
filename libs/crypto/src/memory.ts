/**
 * Mosaic Crypto Library - Memory Safety Module
 *
 * Helper functions for securely zeroing sensitive key material.
 * Use these functions to clear cryptographic keys from memory after use.
 *
 * @example
 * ```typescript
 * import { zeroEpochKey, zeroIdentityKeypair } from '@mosaic/crypto';
 *
 * const epochKey = generateEpochKey(1);
 * try {
 *   // ... use epochKey for encryption
 * } finally {
 *   zeroEpochKey(epochKey);
 * }
 * ```
 */

import { memzero } from './utils';
import type { EpochKey, IdentityKeypair, LinkKeys } from './types';

/**
 * Securely zero all sensitive key material in an EpochKey.
 *
 * This function clears:
 * - epochSeed (32 bytes) - Master seed for tier key derivation
 * - thumbKey (32 bytes) - Thumbnail encryption key
 * - previewKey (32 bytes) - Preview encryption key
 * - fullKey (32 bytes) - Original encryption key
 * - signKeypair.secretKey (64 bytes) - Ed25519 signing secret
 *
 * The publicKey is NOT zeroed as it is safe to expose.
 *
 * @param epochKey - The epoch key to zero
 *
 * @example
 * ```typescript
 * const epochKey = generateEpochKey(1);
 * try {
 *   const encrypted = encryptShard(data, epochKey, tier, shardIndex);
 * } finally {
 *   zeroEpochKey(epochKey);
 * }
 * ```
 */
export function zeroEpochKey(epochKey: EpochKey): void {
  memzero(epochKey.epochSeed);
  memzero(epochKey.thumbKey);
  memzero(epochKey.previewKey);
  memzero(epochKey.fullKey);
  memzero(epochKey.signKeypair.secretKey);
}

/**
 * Securely zero all sensitive key material in an IdentityKeypair.
 *
 * This function clears:
 * - ed25519.secretKey (64 bytes) - Ed25519 signing secret
 * - x25519.secretKey (32 bytes) - X25519 encryption secret
 *
 * Public keys are NOT zeroed as they are safe to expose.
 *
 * @param keypair - The identity keypair to zero
 *
 * @example
 * ```typescript
 * const identity = deriveIdentityKeypair(seed);
 * try {
 *   // ... use identity for signing or decryption
 * } finally {
 *   zeroIdentityKeypair(identity);
 * }
 * ```
 */
export function zeroIdentityKeypair(keypair: IdentityKeypair): void {
  memzero(keypair.ed25519.secretKey);
  memzero(keypair.x25519.secretKey);
}

/**
 * Securely zero all sensitive key material in LinkKeys.
 *
 * This function clears:
 * - linkId (16 bytes) - Server lookup identifier
 * - wrappingKey (32 bytes) - Key for wrapping tier keys
 *
 * Note: While linkId is sent to the server for lookup, it is derived
 * from the link secret and should be zeroed when no longer needed.
 *
 * @param linkKeys - The link keys to zero
 *
 * @example
 * ```typescript
 * const linkKeys = deriveLinkKeys(linkSecret);
 * try {
 *   const wrapped = wrapTierKeyForLink(tierKey, tier, linkKeys.wrappingKey);
 * } finally {
 *   zeroLinkKeys(linkKeys);
 * }
 * ```
 */
export function zeroLinkKeys(linkKeys: LinkKeys): void {
  memzero(linkKeys.linkId);
  memzero(linkKeys.wrappingKey);
}
