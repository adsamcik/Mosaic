/**
 * Mosaic Crypto Library - Sharing Module
 *
 * Authenticated sealed boxes for epoch key distribution.
 * Uses crypto_box_seal for confidentiality (only recipient can open)
 * plus Ed25519 signature for authenticity (proves owner sent it).
 */

import sodium from 'libsodium-wrappers-sumo';
import {
  CryptoError,
  CryptoErrorCode,
  BUNDLE_SIGN_CONTEXT,
  type EpochKeyBundle,
  type SealedBundle,
  type IdentityKeypair,
  type BundleValidationContext,
} from './types';
import { ed25519PubToX25519 } from './identity';
import { concat, toBytes, toBase64, fromBase64 } from './utils';

/** Bundle context for signing */
const BUNDLE_CONTEXT = toBytes(BUNDLE_SIGN_CONTEXT);

/** Current bundle format version */
const BUNDLE_VERSION = 1;

/**
 * Seal and sign an epoch key bundle for a recipient.
 *
 * The bundle is encrypted using crypto_box_seal (anonymous encryption)
 * so only the recipient can open it. The owner signs the sealed ciphertext
 * to prove authenticity.
 *
 * @param bundle - Epoch key bundle to send
 * @param recipientEd25519Pub - Recipient's Ed25519 public key (32 bytes)
 * @param ownerIdentity - Owner's full identity keypair
 * @returns Sealed bundle with signature
 * @throws CryptoError if key lengths are invalid
 */
export function sealAndSignBundle(
  bundle: EpochKeyBundle,
  recipientEd25519Pub: Uint8Array,
  ownerIdentity: IdentityKeypair,
): SealedBundle {
  if (recipientEd25519Pub.length !== 32) {
    throw new CryptoError(
      `Recipient Ed25519 public key must be 32 bytes, got ${recipientEd25519Pub.length}`,
      CryptoErrorCode.INVALID_KEY_LENGTH,
    );
  }

  // Serialize bundle to JSON with base64 encoding for binary fields
  const bundleJson = JSON.stringify({
    version: bundle.version,
    albumId: bundle.albumId,
    epochId: bundle.epochId,
    recipientPubkey: toBase64(bundle.recipientPubkey),
    epochSeed: toBase64(bundle.epochSeed),
    signKeypair: {
      publicKey: toBase64(bundle.signKeypair.publicKey),
      secretKey: toBase64(bundle.signKeypair.secretKey),
    },
  });
  const bundleBytes = toBytes(bundleJson);

  // Convert recipient Ed25519 to X25519 for encryption
  const recipientX25519Pub = ed25519PubToX25519(recipientEd25519Pub);

  // Seal (anonymous encryption - only recipient can open)
  const sealed = sodium.crypto_box_seal(bundleBytes, recipientX25519Pub);

  // Sign the sealed ciphertext with context
  const toSign = concat(BUNDLE_CONTEXT, sealed);
  const signature = sodium.crypto_sign_detached(
    toSign,
    ownerIdentity.ed25519.secretKey,
  );

  return {
    sealed,
    signature,
    sharerPubkey: ownerIdentity.ed25519.publicKey,
  };
}

/**
 * Verify signature and open a sealed epoch key bundle.
 *
 * SECURITY: Verifies owner signature FIRST before attempting decryption.
 * This prevents processing forged bundles.
 *
 * @param sealed - Sealed bundle ciphertext
 * @param signature - Owner's signature
 * @param ownerEd25519Pub - Owner's Ed25519 public key (for verification)
 * @param myIdentity - Recipient's full identity keypair
 * @param expectedContext - Context to validate against (albumId, minEpochId)
 * @returns Decrypted and validated epoch key bundle
 * @throws CryptoError if signature invalid, decryption fails, or context mismatch
 */
export function verifyAndOpenBundle(
  sealed: Uint8Array,
  signature: Uint8Array,
  ownerEd25519Pub: Uint8Array,
  myIdentity: IdentityKeypair,
  expectedContext: BundleValidationContext,
): EpochKeyBundle {
  // Verify signature FIRST - reject forgeries before decryption
  const toVerify = concat(BUNDLE_CONTEXT, sealed);
  if (
    !sodium.crypto_sign_verify_detached(signature, toVerify, ownerEd25519Pub)
  ) {
    throw new CryptoError(
      'Invalid bundle signature - not from claimed owner',
      CryptoErrorCode.SIGNATURE_INVALID,
    );
  }

  // Open sealed box
  let bundleBytes: Uint8Array;
  try {
    bundleBytes = sodium.crypto_box_seal_open(
      sealed,
      myIdentity.x25519.publicKey,
      myIdentity.x25519.secretKey,
    );
  } catch {
    throw new CryptoError(
      'Failed to open sealed bundle - not intended for this recipient',
      CryptoErrorCode.DECRYPTION_FAILED,
    );
  }

  // Parse JSON
  let bundleJson: {
    version: number;
    albumId: string;
    epochId: number;
    recipientPubkey: string;
    epochSeed: string;
    signKeypair: {
      publicKey: string;
      secretKey: string;
    };
  };

  try {
    bundleJson = JSON.parse(new TextDecoder().decode(bundleBytes));
  } catch {
    throw new CryptoError(
      'Failed to parse bundle JSON',
      CryptoErrorCode.INVALID_ENVELOPE,
    );
  }

  // Validate album ID
  // Note: Empty albumId is allowed for bundles created at album creation time,
  // when the album ID was not yet known. The signature still provides integrity.
  if (
    bundleJson.albumId !== '' &&
    bundleJson.albumId !== expectedContext.albumId
  ) {
    throw new CryptoError(
      `Bundle albumId mismatch: expected ${expectedContext.albumId}, got ${bundleJson.albumId}`,
      CryptoErrorCode.CONTEXT_MISMATCH,
    );
  }

  // Validate epoch ID (prevent replay of old keys)
  if (bundleJson.epochId < expectedContext.minEpochId) {
    throw new CryptoError(
      `Bundle epochId too old: ${bundleJson.epochId} < ${expectedContext.minEpochId}`,
      CryptoErrorCode.CONTEXT_MISMATCH,
    );
  }

  // Verify recipient binding
  const recipientPubkey = fromBase64(bundleJson.recipientPubkey);
  if (
    recipientPubkey.length !== myIdentity.ed25519.publicKey.length ||
    !sodium.memcmp(recipientPubkey, myIdentity.ed25519.publicKey)
  ) {
    throw new CryptoError(
      'Bundle not intended for this recipient',
      CryptoErrorCode.CONTEXT_MISMATCH,
    );
  }

  return {
    version: bundleJson.version,
    albumId: bundleJson.albumId,
    epochId: bundleJson.epochId,
    recipientPubkey,
    epochSeed: fromBase64(bundleJson.epochSeed),
    signKeypair: {
      publicKey: fromBase64(bundleJson.signKeypair.publicKey),
      secretKey: fromBase64(bundleJson.signKeypair.secretKey),
    },
  };
}

/**
 * Create an epoch key bundle for sharing.
 *
 * @param albumId - Album identifier
 * @param epochId - Epoch identifier
 * @param epochSeed - Epoch seed for deriving tier keys (32 bytes)
 * @param signKeypair - Epoch signing keypair
 * @param recipientPubkey - Recipient's Ed25519 public key
 * @returns Epoch key bundle ready for sealing
 */
export function createEpochKeyBundle(
  albumId: string,
  epochId: number,
  epochSeed: Uint8Array,
  signKeypair: { publicKey: Uint8Array; secretKey: Uint8Array },
  recipientPubkey: Uint8Array,
): EpochKeyBundle {
  return {
    version: BUNDLE_VERSION,
    albumId,
    epochId,
    recipientPubkey,
    epochSeed,
    signKeypair,
  };
}
