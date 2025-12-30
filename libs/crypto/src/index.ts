/**
 * Mosaic Crypto Library
 *
 * Zero-knowledge cryptographic operations for encrypted photo gallery.
 * All encryption/decryption happens client-side.
 */

// Re-export types
export type {
  DerivedKeys,
  DeriveKeysResult,
  EpochKey,
  IdentityKeypair,
  EpochKeyBundle,
  ShardHeader,
  EncryptedShard,
  SealedBundle,
  ShardReference,
  PhotoMetadata,
  ManifestEnvelope,
  Argon2Params,
  BundleValidationContext,
  LinkKeys,
  WrappedTierKey,
} from './types';

export {
  CryptoError,
  CryptoErrorCode,
  ENVELOPE_MAGIC,
  ENVELOPE_VERSION,
  ENVELOPE_HEADER_SIZE,
  NONCE_SIZE,
  TAG_SIZE,
  KEY_SIZE,
  MAX_SHARD_SIZE,
  BUNDLE_SIGN_CONTEXT,
  MANIFEST_SIGN_CONTEXT,
  ShardTier,
  AccessTier,
} from './types';

// Re-export Argon2 utilities
export {
  getArgon2Params,
  isMobileDevice,
  isLowMemoryDevice,
  benchmarkArgon2,
  benchmarkAllPresets,
  ARGON2_PRESETS,
} from './argon2-params';

// Re-export utils
export {
  concat,
  constantTimeEqual,
  sha256,
  sha256Sync,
  memzero,
  randomBytes,
  toBase64,
  fromBase64,
  toBytes,
  fromBytes,
} from './utils';

// Re-export keychain
export {
  deriveKeys,
  deriveKeysInternal,
  unwrapAccountKey,
  rewrapAccountKey,
  generateSalts,
} from './keychain';

// Re-export keybox
export {
  wrapKey,
  unwrapKey,
  wrapSymmetricKey,
  unwrapSymmetricKey,
} from './keybox';

// Re-export envelope
export {
  encryptShard,
  decryptShard,
  peekHeader,
  parseShardHeader,
  verifyShard,
} from './envelope';

// Re-export identity
export {
  deriveIdentityKeypair,
  ed25519PubToX25519,
  ed25519SecretToX25519,
  generateIdentitySeed,
  generateEd25519Keypair,
  isValidEd25519PublicKey,
} from './identity';

// Re-export signer
export {
  signManifest,
  verifyManifest,
  signShard,
  verifyShard as verifyShardSignature,
  signWithContext,
  verifyWithContext,
} from './signer';

// Re-export epochs
export {
  generateEpochKey,
  serializeEpochKeyPublic,
  wrapEpochKey,
  unwrapEpochKey,
  rotateEpochKey,
  isValidEpochKey,
  deriveTierKeys,
  getTierKey,
} from './epochs';

// Re-export sharing
export {
  sealAndSignBundle,
  verifyAndOpenBundle,
  createEpochKeyBundle,
} from './sharing';

// Re-export link sharing
export {
  LINK_SECRET_SIZE,
  LINK_ID_SIZE,
  generateLinkSecret,
  deriveLinkKeys,
  wrapTierKeyForLink,
  wrapAllTierKeysForLink,
  unwrapTierKeyFromLink,
  encodeLinkSecret,
  decodeLinkSecret,
  encodeLinkId,
  decodeLinkId,
  createShareLinkUrl,
  parseShareLinkUrl,
} from './link-sharing';

// Re-export authentication
export {
  CHALLENGE_SIZE,
  generateAuthChallenge,
  signAuthChallenge,
  verifyAuthChallenge,
  deriveAuthKeypair,
  generateFakeUserSalt,
  generateFakeChallenge,
} from './auth';

// Re-export memory safety helpers
export {
  zeroEpochKey,
  zeroIdentityKeypair,
  zeroLinkKeys,
} from './memory';

import type {
  DeriveKeysResult,
  EpochKey,
  IdentityKeypair,
  EpochKeyBundle,
  EncryptedShard,
  SealedBundle,
  BundleValidationContext,
} from './types';

/**
 * Core cryptographic operations interface.
 *
 * Implementations must ensure:
 * - Nonces are never reused with the same key
 * - Keys are zeroed after use via memzero()
 * - All inputs are validated before crypto operations
 */
export interface CryptoLib {
  // ===========================================================================
  // Initialization
  // ===========================================================================

  /**
   * Initialize the crypto library (loads libsodium WASM).
   * Must be called before any other method.
   */
  init(): Promise<void>;

  /**
   * Check if library is initialized.
   */
  isReady(): boolean;

  // ===========================================================================
  // Key Derivation
  // ===========================================================================

  /**
   * Derive account key from password.
   * L0 (masterKey) and L1 (rootKey) are zeroed before return.
   *
   * @param password - User password (will be cleared after use)
   * @param salt - 16-byte Argon2 salt
   * @param accountSalt - Additional salt for HKDF (unique per account)
   * @returns Account key and wrapped account key (L0/L1 already zeroed)
   */
  deriveKeys(
    password: string,
    salt: Uint8Array,
    accountSalt: Uint8Array
  ): Promise<DeriveKeysResult>;

  /**
   * Derive identity keypair from seed.
   * Creates Ed25519 keypair and derives X25519 keypair for key exchange.
   *
   * @param seed - 32-byte seed (typically unwrapped from storage)
   * @returns Identity keypair (Ed25519 + X25519)
   */
  deriveIdentityKeypair(seed: Uint8Array): IdentityKeypair;

  /**
   * Generate a new random epoch key set.
   *
   * @param epochId - Epoch identifier
   * @returns New epoch key with ReadKey and SignKeypair
   */
  generateEpochKey(epochId: number): EpochKey;

  // ===========================================================================
  // Key Wrapping
  // ===========================================================================

  /**
   * Wrap (encrypt) a key with another key.
   * Uses XChaCha20-Poly1305 with random nonce.
   *
   * @param key - Key to wrap (32 bytes)
   * @param wrapper - Wrapping key (32 bytes)
   * @returns Wrapped key (nonce + ciphertext + tag)
   */
  wrapKey(key: Uint8Array, wrapper: Uint8Array): Uint8Array;

  /**
   * Unwrap (decrypt) a wrapped key.
   *
   * @param wrapped - Wrapped key from wrapKey()
   * @param wrapper - Wrapping key (32 bytes)
   * @returns Unwrapped key (32 bytes)
   * @throws CryptoError if decryption fails
   */
  unwrapKey(wrapped: Uint8Array, wrapper: Uint8Array): Uint8Array;

  // ===========================================================================
  // Envelope Operations
  // ===========================================================================

  /**
   * Encrypt data into a shard envelope.
   *
   * @param data - Plaintext data (max 6MB)
   * @param readKey - Epoch read key (32 bytes)
   * @param epochId - Current epoch ID
   * @param shardIndex - Shard index within photo
   * @returns Encrypted shard with SHA256 hash
   */
  encryptShard(
    data: Uint8Array,
    readKey: Uint8Array,
    epochId: number,
    shardIndex: number
  ): Promise<EncryptedShard>;

  /**
   * Decrypt a shard envelope.
   *
   * @param envelope - Complete envelope (header + ciphertext)
   * @param readKey - Epoch read key (32 bytes)
   * @returns Decrypted plaintext
   * @throws CryptoError if decryption fails or envelope is invalid
   */
  decryptShard(envelope: Uint8Array, readKey: Uint8Array): Promise<Uint8Array>;

  /**
   * Parse shard header without decrypting.
   *
   * @param envelope - Complete envelope
   * @returns Parsed header fields
   * @throws CryptoError if header is malformed
   */
  parseShardHeader(envelope: Uint8Array): {
    epochId: number;
    shardId: number;
    nonce: Uint8Array;
  };

  /**
   * Verify shard integrity against expected hash.
   *
   * @param ciphertext - Downloaded ciphertext
   * @param expectedSha256 - Hash from manifest (base64)
   * @returns true if hash matches
   */
  verifyShard(ciphertext: Uint8Array, expectedSha256: string): boolean;

  // ===========================================================================
  // Manifest Signing
  // ===========================================================================

  /**
   * Sign manifest data with epoch sign key.
   *
   * @param manifest - Manifest bytes to sign
   * @param signSecretKey - Epoch signing secret key (64 bytes)
   * @returns Ed25519 signature (64 bytes)
   */
  signManifest(manifest: Uint8Array, signSecretKey: Uint8Array): Uint8Array;

  /**
   * Verify manifest signature.
   *
   * @param manifest - Manifest bytes
   * @param signature - Ed25519 signature (64 bytes)
   * @param signPublicKey - Epoch signing public key (32 bytes)
   * @returns true if signature is valid
   */
  verifyManifest(
    manifest: Uint8Array,
    signature: Uint8Array,
    signPublicKey: Uint8Array
  ): boolean;

  // ===========================================================================
  // Epoch Key Distribution (Authenticated Sealed Box)
  // ===========================================================================

  /**
   * Seal and sign an epoch key bundle for a recipient.
   *
   * Uses crypto_box_seal for confidentiality (only recipient can open)
   * plus Ed25519 signature for authenticity (proves owner sent it).
   *
   * @param bundle - Epoch key bundle to send
   * @param recipientEd25519Pub - Recipient's Ed25519 public key
   * @param ownerIdentityKeypair - Owner's full identity keypair
   * @returns Sealed bundle with signature
   */
  sealAndSignBundle(
    bundle: EpochKeyBundle,
    recipientEd25519Pub: Uint8Array,
    ownerIdentityKeypair: IdentityKeypair
  ): SealedBundle;

  /**
   * Verify signature and open a sealed epoch key bundle.
   *
   * Verifies owner signature FIRST (reject forgeries before decryption),
   * then opens sealed box and validates context.
   *
   * @param sealed - Sealed bundle ciphertext
   * @param signature - Owner's signature
   * @param ownerEd25519Pub - Owner's Ed25519 public key
   * @param myIdentityKeypair - Recipient's full identity keypair
   * @param expectedContext - Context to validate against
   * @returns Decrypted and validated epoch key bundle
   * @throws CryptoError if signature invalid, decryption fails, or context mismatch
   */
  verifyAndOpenBundle(
    sealed: Uint8Array,
    signature: Uint8Array,
    ownerEd25519Pub: Uint8Array,
    myIdentityKeypair: IdentityKeypair,
    expectedContext: BundleValidationContext
  ): EpochKeyBundle;

  // ===========================================================================
  // Secure Memory
  // ===========================================================================

  /**
   * Securely zero memory containing sensitive data.
   * Always call this after using keys.
   *
   * @param buffer - Buffer to zero
   */
  memzero(buffer: Uint8Array): void;

  // ===========================================================================
  // Random
  // ===========================================================================

  /**
   * Generate cryptographically secure random bytes.
   *
   * @param length - Number of bytes to generate
   * @returns Random bytes
   */
  randomBytes(length: number): Uint8Array;

  // ===========================================================================
  // Hashing
  // ===========================================================================

  /**
   * Compute SHA256 hash of data.
   *
   * @param data - Data to hash
   * @returns Hash as base64 string
   */
  sha256(data: Uint8Array): string;
}
