/**
 * Mosaic Crypto Library - Type Definitions
 *
 * Core cryptographic types for zero-knowledge photo gallery.
 * All keys are 32 bytes unless otherwise noted.
 */

// =============================================================================
// Key Types
// =============================================================================

/**
 * Keys derived from user password via Argon2id + HKDF.
 * L0 (master) and L1 (root) are never persisted.
 * L2 (account) is wrapped and stored locally.
 */
export interface DerivedKeys {
  /** L0: Argon2id(password, salt) - never stored */
  masterKey: Uint8Array;
  /** L1: HKDF(L0, account_salt) - never stored */
  rootKey: Uint8Array;
  /** L2: random(32) - stored wrapped by L1 */
  accountKey: Uint8Array;
  /** L2 encrypted with L1 for storage */
  accountKeyWrapped: Uint8Array;
}

/**
 * Per-album epoch key set.
 * ReadKey encrypts content, SignKeypair signs manifests.
 */
export interface EpochKey {
  /** Epoch identifier (increments on key rotation) */
  epochId: number;
  /** 32 bytes - XChaCha20 encryption key for shards */
  readKey: Uint8Array;
  /** Ed25519 keypair for signing manifests */
  signKeypair: {
    /** 32 bytes - public verification key */
    publicKey: Uint8Array;
    /** 64 bytes - secret signing key */
    secretKey: Uint8Array;
  };
}

/**
 * User identity keypair derived from wrapped seed.
 * Ed25519 for signatures, X25519 for sealed boxes.
 */
export interface IdentityKeypair {
  /** Ed25519 keypair for signing (identity verification) */
  ed25519: {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  };
  /** X25519 keypair for key exchange (derived from Ed25519) */
  x25519: {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  };
}

/**
 * Epoch key bundle transmitted to album members.
 * Encrypted via sealed box and signed by owner.
 */
export interface EpochKeyBundle {
  /** Bundle format version */
  version: number;
  /** Album this bundle belongs to */
  albumId: string;
  /** Epoch identifier */
  epochId: number;
  /** Recipient's Ed25519 public key (fingerprint binding) */
  recipientPubkey: Uint8Array;
  /** 32 bytes - XChaCha20 read key */
  readKey: Uint8Array;
  /** Ed25519 signing keypair for this epoch */
  signKeypair: {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  };
}

// =============================================================================
// Envelope Types
// =============================================================================

/**
 * 64-byte shard envelope header.
 * Used as AAD for AEAD encryption.
 */
export interface ShardHeader {
  /** Magic bytes "SGzk" (4 bytes) */
  magic: string;
  /** Format version: 0x03 (1 byte) */
  version: number;
  /** Epoch ID (4 bytes, LE u32) */
  epochId: number;
  /** Shard index within photo (4 bytes, LE u32) */
  shardId: number;
  /** 24 random bytes - MUST be unique per encryption */
  nonce: Uint8Array;
  /** 27 bytes - MUST be zero, validated on decrypt */
  reserved: Uint8Array;
}

/**
 * Result of encrypting a shard.
 */
export interface EncryptedShard {
  /** Complete envelope: 64-byte header + ciphertext + 16-byte tag */
  ciphertext: Uint8Array;
  /** SHA256 hash of ciphertext for manifest inclusion */
  sha256: string;
}

/**
 * Authenticated sealed bundle for key distribution.
 */
export interface SealedBundle {
  /** crypto_box_seal output */
  sealed: Uint8Array;
  /** Ed25519 signature over (context || sealed) */
  signature: Uint8Array;
  /** Signer's Ed25519 public key */
  sharerPubkey: Uint8Array;
}

// =============================================================================
// Manifest Types
// =============================================================================

/**
 * Individual shard reference in manifest.
 */
export interface ShardReference {
  /** Chunk index (0-based) */
  index: number;
  /** Server-assigned shard UUID */
  id: string;
  /** SHA256 hash of ciphertext (base64) */
  sha256: string;
}

/**
 * Decrypted photo metadata from manifest.
 */
export interface PhotoMetadata {
  /** Stable logical photo ID (UUIDv7) */
  assetId: string;
  /** Original filename */
  filename: string;
  /** MIME type */
  mimeType: string;
  /** File size in bytes */
  sizeBytes: number;
  /** Photo dimensions */
  dimensions?: {
    width: number;
    height: number;
  };
  /** GPS coordinates */
  location?: {
    latitude: number;
    longitude: number;
    altitude?: number;
  };
  /** When photo was taken */
  capturedAt?: string;
  /** When metadata was last modified */
  updatedAt: string;
  /** Device that last modified */
  deviceId: string;
  /** Shard references with integrity hashes */
  shards: ShardReference[];
}

/**
 * Signed manifest envelope (encrypted payload).
 */
export interface ManifestEnvelope {
  /** Encrypted PhotoMetadata (XChaCha20-Poly1305) */
  encryptedMeta: Uint8Array;
  /** Ed25519 signature */
  signature: Uint8Array;
  /** Signer's epoch sign public key */
  signerPubkey: Uint8Array;
}

// =============================================================================
// Argon2 Parameters
// =============================================================================

/**
 * Argon2id parameters for password hashing.
 */
export interface Argon2Params {
  /** Memory cost in KiB */
  memory: number;
  /** Number of iterations (time cost) */
  iterations: number;
  /** Degree of parallelism */
  parallelism: number;
}

// =============================================================================
// Context Types
// =============================================================================

/**
 * Context for validating opened epoch key bundles.
 */
export interface BundleValidationContext {
  /** Expected album ID */
  albumId: string;
  /** Minimum acceptable epoch ID (prevents replay) */
  minEpochId: number;
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Crypto operation error with context.
 */
export class CryptoError extends Error {
  constructor(
    message: string,
    public readonly code: CryptoErrorCode,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'CryptoError';
  }
}

export enum CryptoErrorCode {
  /** libsodium not initialized */
  NOT_INITIALIZED = 'NOT_INITIALIZED',
  /** Invalid key length */
  INVALID_KEY_LENGTH = 'INVALID_KEY_LENGTH',
  /** Decryption failed (wrong key or tampered) */
  DECRYPTION_FAILED = 'DECRYPTION_FAILED',
  /** Signature verification failed */
  SIGNATURE_INVALID = 'SIGNATURE_INVALID',
  /** Envelope format error */
  INVALID_ENVELOPE = 'INVALID_ENVELOPE',
  /** Reserved bytes not zero */
  RESERVED_NOT_ZERO = 'RESERVED_NOT_ZERO',
  /** Hash mismatch */
  INTEGRITY_FAILED = 'INTEGRITY_FAILED',
  /** Bundle context mismatch */
  CONTEXT_MISMATCH = 'CONTEXT_MISMATCH',
  /** Ed25519 to X25519 conversion failed */
  KEY_CONVERSION_FAILED = 'KEY_CONVERSION_FAILED',
}

// =============================================================================
// Constants
// =============================================================================

/** Envelope magic bytes */
export const ENVELOPE_MAGIC = 'SGzk';

/** Current envelope version */
export const ENVELOPE_VERSION = 0x03;

/** Envelope header size in bytes */
export const ENVELOPE_HEADER_SIZE = 64;

/** XChaCha20-Poly1305 nonce size */
export const NONCE_SIZE = 24;

/** XChaCha20-Poly1305 tag size */
export const TAG_SIZE = 16;

/** Key size for all symmetric keys */
export const KEY_SIZE = 32;

/** Maximum shard payload size (6MB) */
export const MAX_SHARD_SIZE = 6 * 1024 * 1024;

/** Signing context for epoch bundles */
export const BUNDLE_SIGN_CONTEXT = 'Mosaic_EpochBundle_v1';

/** Signing context for manifests */
export const MANIFEST_SIGN_CONTEXT = 'Mosaic_Manifest_v1';
