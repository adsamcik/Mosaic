/**
 * Shared types for worker communication
 */
import type { EncryptedShard } from '@mosaic/crypto';

// Re-export EncryptedShard from crypto lib (single source of truth)
export type { EncryptedShard };

// =============================================================================
// Stable error codes for the Rust cutover handle-based contract
// =============================================================================

/**
 * Stable numeric error codes mirroring `mosaic_client::ClientErrorCode`
 * (subset that is reachable through the worker), plus worker-only codes for
 * handle-lifecycle errors that originate inside the TypeScript worker layer.
 *
 * Worker-only codes start at 1000 to avoid collisions with the Rust enum
 * (which currently maxes out at 706 — `ClientCoreInvalidSnapshot`). Adding
 * a new worker-only code? Pick the next free value above 1000 and document
 * the failure mode here.
 */
export enum WorkerCryptoErrorCode {
  Ok = 0,

  // Mirrors `mosaic_client::ClientErrorCode` — keep in sync.
  InvalidHeaderLength = 100,
  InvalidMagic = 101,
  UnsupportedVersion = 102,
  InvalidTier = 103,
  NonZeroReservedByte = 104,
  EmptyContext = 200,
  InvalidKeyLength = 201,
  InvalidInputLength = 202,
  InvalidEnvelope = 203,
  MissingCiphertext = 204,
  AuthenticationFailed = 205,
  RngFailure = 206,
  WrappedKeyTooShort = 207,
  KdfProfileTooWeak = 208,
  InvalidSaltLength = 209,
  KdfFailure = 210,
  InvalidSignatureLength = 211,
  InvalidPublicKey = 212,
  InvalidUsername = 213,
  KdfProfileTooCostly = 214,
  LinkTierMismatch = 215,
  BundleSignatureInvalid = 216,
  BundleAlbumIdEmpty = 217,
  BundleAlbumIdMismatch = 218,
  BundleEpochTooOld = 219,
  BundleRecipientMismatch = 220,
  BundleJsonParse = 221,
  BundleSealOpenFailed = 222,
  OperationCancelled = 300,
  SecretHandleNotFound = 400,
  IdentityHandleNotFound = 401,
  HandleSpaceExhausted = 402,
  EpochHandleNotFound = 403,
  InternalStatePoisoned = 500,

  // Worker-only error codes start at 1000.
  /** Operation issued against a handle whose generation no longer matches. */
  StaleHandle = 1000,
  /** Handle ID is not registered with the worker's handle registry. */
  HandleNotFound = 1001,
  /** Handle ID exists but refers to a handle of a different kind than expected. */
  HandleWrongKind = 1002,
  /** Handle has been closed; subsequent operations are rejected. */
  ClosedHandle = 1003,
  /** Worker has not been bootstrapped or has been cleared via clear(). */
  WorkerNotInitialized = 1004,
}

/**
 * Wire-shape used to round-trip a `WorkerCryptoError` across the Comlink
 * boundary. Comlink serializes thrown values via `structuredClone` which
 * preserves plain own-properties on Error subclasses, so we attach `code`
 * and a `name` that callers can branch on.
 */
export interface WorkerCryptoErrorJson {
  readonly name: 'WorkerCryptoError';
  readonly code: WorkerCryptoErrorCode;
  readonly message: string;
}

/**
 * Error class thrown by the crypto worker for every Rust-mapped or
 * handle-lifecycle failure. The `code` field is the stable contract — Slice
 * 1+ callers must branch on `code`, never on `message` text.
 */
export class WorkerCryptoError extends Error {
  readonly name = 'WorkerCryptoError' as const;
  readonly code: WorkerCryptoErrorCode;

  constructor(code: WorkerCryptoErrorCode, message: string) {
    super(message);
    this.code = code;
    // Preserve own-properties through Comlink's structuredClone.
    Object.defineProperty(this, 'code', {
      value: code,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }

  /**
   * Test whether an arbitrary thrown value carries the WorkerCryptoError
   * shape — works across both same-realm `instanceof` and Comlink-cloned
   * objects from another realm.
   */
  static is(err: unknown): err is { code: WorkerCryptoErrorCode; message: string; name: string } {
    if (err instanceof WorkerCryptoError) return true;
    if (
      typeof err === 'object' &&
      err !== null &&
      'name' in err &&
      'code' in err &&
      (err as { name: unknown }).name === 'WorkerCryptoError' &&
      typeof (err as { code: unknown }).code === 'number'
    ) {
      return true;
    }
    return false;
  }
}

/**
 * KDF parameter triple required by the Rust handle-based account methods.
 * Matches `mosaic_client::AccountUnlockRequest` field naming.
 */
export interface WorkerKdfParams {
  readonly memoryKib: number;
  readonly iterations: number;
  readonly parallelism: number;
}

/**
 * Branded string type for opaque handle IDs returned across Comlink.
 *
 * Slice 1 contract: ALL handle IDs are stable strings of the form
 *   `${kind}_${12-byte-base64url}` where `kind ∈ { acct, idnt, epch }`.
 * Callers must treat them as opaque — the worker is the only authority
 * for resolving an ID back to a Rust handle.
 */
export type AccountHandleId = string & { readonly __brand: 'AccountHandleId' };
export type IdentityHandleId = string & { readonly __brand: 'IdentityHandleId' };
export type EpochHandleId = string & { readonly __brand: 'EpochHandleId' };

/** Photo metadata stored in local SQLite */
export interface PhotoMeta {
  id: string;
  assetId: string;
  albumId: string;
  filename: string;
  mimeType: string;
  width: number;
  height: number;
  takenAt?: string;
  lat?: number;
  lng?: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /** @deprecated Use tier-specific shard fields instead */
  shardIds: string[];
  /** @deprecated Use tier-specific shard fields instead */
  shardHashes?: string[];
  /** Epoch ID for key lookup */
  epochId: number;
  /** Base64-encoded JPEG thumbnail (embedded in manifest for fast loading) */
  thumbnail?: string;
  /** Thumbnail width in pixels */
  thumbWidth?: number;
  /** Thumbnail height in pixels */
  thumbHeight?: number;
  /** User-provided description for the photo */
  description?: string;
  /** Display rotation in degrees clockwise (0, 90, 180, or 270). Applied at render time; underlying pixels are not modified. */
  rotation?: number;
  /** ThumbHash string (base64-encoded, ~25 bytes) for instant placeholder */
  thumbhash?: string;
  /** @deprecated Legacy BlurHash string - use thumbhash for new uploads */
  blurhash?: string;

  // Video-specific metadata (Phase 1)
  /** True for video files */
  isVideo?: boolean;
  /** Duration in seconds (e.g., 62.5) */
  duration?: number;
  /** Video codec (e.g., "h264", "vp9", "av1") — stored in manifest only, not local DB */
  videoCodec?: string;

  // Tier-specific shard IDs (use these for new uploads)
  /** Shard ID for 300px thumbnail (tier 1) */
  thumbnailShardId?: string;
  /** SHA256 hash of thumbnail shard */
  thumbnailShardHash?: string;

  /** Shard ID for 1200px preview (tier 2) */
  previewShardId?: string;
  /** SHA256 hash of preview shard */
  previewShardHash?: string;

  /** Shard IDs for full resolution (tier 3, may be chunked for large files) */
  originalShardIds?: string[];
  /** SHA256 hashes of original shards (parallel array) */
  originalShardHashes?: string[];

  // Pending upload state (for optimistic UI)
  /** True if this photo is being uploaded (not yet confirmed by server) */
  isPending?: boolean;
  /** Upload progress (0-100) for pending photos */
  uploadProgress?: number;
  /** Current upload action (waiting, converting, encrypting, uploading, finalizing) */
  uploadAction?: 'waiting' | 'converting' | 'encrypting' | 'uploading' | 'finalizing';
  /** True if this photo is syncing (upload complete, awaiting server confirmation) */
  isSyncing?: boolean;
  /** Error message if upload failed */
  uploadError?: string;
}

/** Tiered shard tracking during upload */
export interface TieredShardIds {
  thumbnail: { shardId: string; sha256: string };
  preview: { shardId: string; sha256: string };
  original: { shardId: string; sha256: string }[];
}

/** Encrypted manifest record from server */
export interface ManifestRecord {
  id: string;
  albumId: string;
  versionCreated: number;
  isDeleted: boolean;
  encryptedMeta: Uint8Array;
  signature: string;
  signerPubkey: string;
  shardIds: string[];
}

/** Decrypted manifest with photo metadata */
export interface DecryptedManifest {
  id: string;
  albumId: string;
  versionCreated: number;
  isDeleted: boolean;
  meta: PhotoMeta;
  shardIds: string[];
}

/** Geographic point for map clustering */
export interface GeoPoint {
  id: string;
  lat: number;
  lng: number;
}

/** Map bounding box */
export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

/** Album state in local database */
export interface AlbumState {
  id: string;
  currentVersion: number;
}

export interface OpenEpochKeyBundleOptions {
  /**
   * Allow legacy bundles with an empty albumId only after strict validation fails.
   * This is for one-time migration compatibility and must never be the default path.
   */
  allowLegacyEmptyAlbumId?: boolean;
}

/**
 * Database Worker API
 * Manages SQLite-WASM database with encrypted persistence to OPFS
 */
export interface DbWorkerApi {
  /**
   * Initialize the database with a session key for encryption
   * @param sessionKey - 32-byte key for database encryption
   */
  init(sessionKey: Uint8Array): Promise<void>;

  /**
   * Delete the persisted encrypted snapshot and recreate an empty database.
   * Reuses the current session key and leaves the worker ready for immediate use.
   * Must only be called after init(sessionKey) has established that session key.
   */
  resetStorage(): Promise<void>;

  /**
   * Close the database and clear session key
   */
  close(): Promise<void>;

  // Album state management
  getAlbumVersion(albumId: string): Promise<number>;
  setAlbumVersion(albumId: string, version: number): Promise<void>;

  // Manifest operations
  insertManifests(manifests: DecryptedManifest[]): Promise<void>;
  deleteManifest(id: string): Promise<void>;
  updatePhotoRotation(
    photoId: string,
    rotation: number,
    versionCreated: number,
  ): Promise<void>;
  updatePhotoDescription(
    photoId: string,
    description: string | null,
    versionCreated: number,
  ): Promise<void>;

  // Photo queries
  getPhotos(
    albumId: string,
    limit: number,
    offset: number,
  ): Promise<PhotoMeta[]>;
  getPhotoCount(albumId: string): Promise<number>;
  searchPhotos(
    albumId: string,
    query: string,
    limit?: number,
    offset?: number,
  ): Promise<PhotoMeta[]>;
  getPhotosForMap(albumId: string, bounds: Bounds): Promise<GeoPoint[]>;
  getPhotoById(id: string): Promise<PhotoMeta | null>;

  /**
   * Clear all cached photos for an album.
   * Used after epoch rotation to ensure stale encrypted data is removed.
   * @param albumId - Album ID to clear photos for
   */
  clearAlbumPhotos(albumId: string): Promise<void>;
}

// EncryptedShard is re-exported from @mosaic/crypto at the top of this file

/**
 * Crypto Worker API
 * Handles all cryptographic operations in a dedicated worker
 */
export interface CryptoWorkerApi {
  /**
   * Initialize crypto with user credentials
   * Derives L0 → L1 → L2 key hierarchy and generates NEW random account key.
   * Use initWithWrappedKey() for existing users who have a stored wrapped key.
   */
  init(
    password: string,
    userSalt: Uint8Array,
    accountSalt: Uint8Array,
  ): Promise<void>;

  /**
   * Initialize crypto with an existing wrapped account key.
   * Used for returning users who already have a stored wrapped key.
   */
  initWithWrappedKey(
    password: string,
    userSalt: Uint8Array,
    accountSalt: Uint8Array,
    wrappedAccountKey: Uint8Array,
  ): Promise<void>;

  /**
   * Get the wrapped account key for server storage.
   * Only available after init() for new users.
   */
  getWrappedAccountKey(): Promise<Uint8Array | null>;

  /**
   * Clear all keys from memory
   */
  clear(): Promise<void>;

  /**
   * Get session key for database encryption
   */
  getSessionKey(): Promise<Uint8Array>;

  /**
   * Encrypt a photo shard
   * @param data - Plaintext data to encrypt
   * @param epochSeed - Epoch seed for deriving tier keys (32 bytes)
   * @param epochId - Current epoch ID
   * @param shardIndex - Shard index within photo
   */
  encryptShard(
    data: Uint8Array,
    epochSeed: Uint8Array,
    epochId: number,
    shardIndex: number,
  ): Promise<EncryptedShard>;

  /**
   * Decrypt a photo shard (for owner/member viewing)
   * @param envelope - Complete envelope (header + ciphertext)
   * @param epochSeed - Epoch seed for deriving tier keys (32 bytes)
   */
  decryptShard(
    envelope: Uint8Array,
    epochSeed: Uint8Array,
  ): Promise<Uint8Array>;

  /**
   * Decrypt a photo shard with a tier key directly (for share link viewing)
   * Use this when you have the unwrapped tier key from a share link.
   * @param envelope - Complete envelope (header + ciphertext)
   * @param tierKey - Tier-specific decryption key (32 bytes, already derived)
   */
  decryptShardWithTierKey(
    envelope: Uint8Array,
    tierKey: Uint8Array,
  ): Promise<Uint8Array>;

  /**
   * Peek at shard envelope header without decrypting
   * @param envelope - Complete envelope (header + ciphertext)
   * @returns Header info including epochId, shardId, and tier
   */
  peekHeader(envelope: Uint8Array): Promise<{
    epochId: number;
    shardId: number;
    tier: number; // 1=thumb, 2=preview, 3=original
  }>;

  /**
   * Verify shard integrity against expected hash
   * @param envelope - Downloaded shard envelope
   * @param expectedSha256 - Expected SHA256 hash from manifest (base64url)
   * @returns true if hash matches
   */
  verifyShard(envelope: Uint8Array, expectedSha256: string): Promise<boolean>;

  /**
   * Decrypt manifest metadata
   */
  decryptManifest(
    encryptedMeta: Uint8Array,
    readKey: Uint8Array,
  ): Promise<PhotoMeta>;

  /**
   * Verify manifest signature
   */
  verifyManifest(
    manifest: Uint8Array,
    signature: Uint8Array,
    pubKey: Uint8Array,
  ): Promise<boolean>;

  /**
   * Get the user's identity public key (Ed25519)
   * Returns null if identity keypair not yet derived
   */
  getIdentityPublicKey(): Promise<Uint8Array | null>;

  /**
   * Derive identity keypair from account key
   * Must be called after init() and before identity-dependent operations
   */
  deriveIdentity(): Promise<void>;

  /**
   * Open (decrypt) an epoch key bundle
   * @param bundle - Encrypted epoch key bundle from server
   * @param senderPubkey - Ed25519 public key of the sender (for signature verification)
   * @param albumId - Album ID for context validation
   * @param minEpochId - Minimum acceptable epoch ID (prevents replay)
   * @returns Decrypted epoch key (epochSeed + signKeypair)
   */
  openEpochKeyBundle(
    bundle: Uint8Array,
    senderPubkey: Uint8Array,
    albumId: string,
    minEpochId: number,
    options?: OpenEpochKeyBundleOptions,
  ): Promise<{
    epochSeed: Uint8Array;
    signPublicKey: Uint8Array;
    signSecretKey: Uint8Array;
  }>;

  /**
   * Create an epoch key bundle for sharing with another user
   * @param albumId - Album ID
   * @param epochId - Epoch ID
   * @param epochSeed - Epoch seed key (32 bytes)
   * @param signKeypair - Epoch signing keypair
   * @param recipientPubkey - Recipient's Ed25519 identity public key
   * @returns Sealed and signed bundle ready for transmission
   */
  createEpochKeyBundle(
    albumId: string,
    epochId: number,
    epochSeed: Uint8Array,
    signPublicKey: Uint8Array,
    signSecretKey: Uint8Array,
    recipientPubkey: Uint8Array,
  ): Promise<{ encryptedBundle: Uint8Array; signature: Uint8Array }>;

  /**
   * Generate a new epoch key for album creation or rotation
   * @param epochId - Epoch ID
   * @returns New epoch key with epochSeed and signKeypair
   */
  generateEpochKey(epochId: number): Promise<{
    epochSeed: Uint8Array;
    signPublicKey: Uint8Array;
    signSecretKey: Uint8Array;
  }>;

  /**
   * Encrypt manifest metadata for upload
   * @param meta - Photo metadata to encrypt
   * @param readKey - Epoch read key (32 bytes)
   * @param epochId - Epoch ID for the manifest
   * @returns Encrypted manifest metadata (envelope format)
   */
  encryptManifest(
    meta: PhotoMeta,
    readKey: Uint8Array,
    epochId: number,
  ): Promise<{ ciphertext: Uint8Array; sha256: string }>;

  /**
   * Sign manifest data for upload
   * @param manifestData - Manifest bytes to sign
   * @param signSecretKey - Epoch sign secret key (64 bytes)
   * @returns Ed25519 signature (64 bytes)
   */
  signManifest(
    manifestData: Uint8Array,
    signSecretKey: Uint8Array,
  ): Promise<Uint8Array>;

  /**
   * Wrap data with the account key (L2) for secure storage
   * @param data - Data to wrap (32 bytes typical)
   * @returns Wrapped data (nonce + ciphertext + tag)
   */
  wrapWithAccountKey(data: Uint8Array): Promise<Uint8Array>;

  /**
   * Unwrap data that was encrypted with the account key (L2)
   * Used for owner-encrypted share link secrets during epoch rotation
   * @param wrapped - Wrapped data from server (nonce + ciphertext + tag)
   * @returns Unwrapped data
   */
  unwrapWithAccountKey(wrapped: Uint8Array): Promise<Uint8Array>;

  // =========================================================================
  // Link Sharing Operations
  // =========================================================================

  /**
   * Derive link ID and wrapping key from a link secret
   * @param linkSecret - 32-byte secret from URL fragment
   * @returns Object with linkId (16 bytes) and wrappingKey (32 bytes)
   */
  deriveLinkKeys(
    linkSecret: Uint8Array,
  ): Promise<{ linkId: Uint8Array; wrappingKey: Uint8Array }>;

  /**
   * Wrap a tier key for share link storage
   * @param tierKey - 32-byte tier key to wrap
   * @param tier - Access tier (1=thumb, 2=preview, 3=full)
   * @param wrappingKey - 32-byte key derived from link secret
   * @returns Wrapped key with nonce and encryptedKey
   */
  wrapTierKeyForLink(
    tierKey: Uint8Array,
    tier: number,
    wrappingKey: Uint8Array,
  ): Promise<{ tier: number; nonce: Uint8Array; encryptedKey: Uint8Array }>;

  /**
   * Unwrap a tier key from share link storage
   * @param nonce - 24-byte nonce
   * @param encryptedKey - Encrypted tier key
   * @param tier - Access tier of the key
   * @param wrappingKey - 32-byte key derived from link secret
   * @returns Unwrapped 32-byte tier key
   */
  unwrapTierKeyFromLink(
    nonce: Uint8Array,
    encryptedKey: Uint8Array,
    tier: number,
    wrappingKey: Uint8Array,
  ): Promise<Uint8Array>;

  /**
   * Generate a new random link secret (32 bytes)
   * @returns Random link secret
   */
  generateLinkSecret(): Promise<Uint8Array>;

  // =========================================================================
  // LocalAuth Authentication Methods
  // =========================================================================

  /**
   * Derive auth keypair from password + userSalt.
   * This is a deterministic derivation separate from the random account key.
   * The auth keypair is used for challenge-response authentication.
   *
   * Must be called before signAuthChallenge() or getAuthPublicKey().
   *
   * @param password - User password
   * @param userSalt - 16-byte user salt from server
   */
  deriveAuthKey(password: string, userSalt: Uint8Array): Promise<void>;

  /**
   * Sign an authentication challenge for LocalAuth login.
   * Uses the auth Ed25519 key derived from password+salt.
   *
   * Message format: context || username_len(4 BE) || username || [timestamp(8 BE)] || challenge
   *
   * @param challenge - 32-byte challenge from server
   * @param username - Username for binding
   * @param timestamp - Optional timestamp for replay protection
   * @returns Ed25519 signature (64 bytes)
   */
  signAuthChallenge(
    challenge: Uint8Array,
    username: string,
    timestamp?: number,
  ): Promise<Uint8Array>;

  /**
   * Get the Ed25519 public key for authentication.
   * This is the "auth pubkey" stored on server for challenge verification.
   * Returns the deterministically derived auth key (from password+salt), not the identity key.
   * @returns Ed25519 public key (32 bytes) or null if not initialized
   */
  getAuthPublicKey(): Promise<Uint8Array | null>;

  // =========================================================================
  // Key Export/Import for Session Caching
  // =========================================================================

  /**
   * Export all keys for caching (base64 encoded).
   * Used to persist keys across page reloads.
   * @returns Exported keys or null if not initialized
   */
  exportKeys(): Promise<ExportedKeys | null>;

  /**
   * Import previously exported keys to restore session.
   * @param keys - Keys previously exported via exportKeys()
   */
  importKeys(keys: ExportedKeys): Promise<void>;

  // =========================================================================
  // Album Content Encryption (Story Blocks)
  // =========================================================================

  /**
   * Encrypt album content (story blocks document).
   * Uses epoch key to derive a content-specific key via HKDF.
   * Binds epochId as AAD to prevent cross-epoch replay.
   *
   * @param content - Plaintext content (JSON-encoded document)
   * @param epochSeed - Epoch seed for key derivation (32 bytes)
   * @param epochId - Epoch ID for AAD binding
   * @returns Encrypted content with nonce
   */
  encryptAlbumContent(
    content: Uint8Array,
    epochSeed: Uint8Array,
    epochId: number,
  ): Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }>;

  /**
   * Decrypt album content.
   * @param ciphertext - Encrypted content
   * @param nonce - 24-byte nonce from encryption
   * @param epochSeed - Epoch seed for key derivation (32 bytes)
   * @param epochId - Epoch ID for AAD verification
   * @returns Decrypted plaintext content
   */
  decryptAlbumContent(
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    epochSeed: Uint8Array,
    epochId: number,
  ): Promise<Uint8Array>;

  // ===========================================================================
  // Slice 1 handle-based contract — Rust cutover surface
  //
  // These methods are the migration target for slices 2-8. They return string
  // handle IDs across the Comlink boundary; the worker maps them to internal
  // Rust handles via the HandleRegistry. NEVER returns raw secret key
  // material in a response shape that names a key (e.g. *Key, *Seed, *Secret).
  // Wrapped/sealed bytes are ciphertext and may cross the boundary.
  // ===========================================================================

  // ---- Account handle lifecycle (Slice 2 will route init/initWithWrappedKey through these) ----

  /**
   * Open (unlock) an existing account-key handle from a wrapped account key.
   * Returns the opaque account handle ID; the underlying L2 key never crosses
   * the Comlink boundary.
   */
  unlockAccount(opts: {
    password: string;
    userSalt: Uint8Array;
    accountSalt: Uint8Array;
    wrappedAccountKey: Uint8Array;
    kdf: WorkerKdfParams;
  }): Promise<{ accountHandleId: AccountHandleId }>;

  /**
   * Create a new account: generate a fresh random L2 key, wrap it under
   * Argon2id-derived L1, register the handle, and return both the handle ID
   * and the wrapped account key for the caller to persist on the server.
   */
  createNewAccount(opts: {
    password: string;
    userSalt: Uint8Array;
    accountSalt: Uint8Array;
    kdf: WorkerKdfParams;
  }): Promise<{ accountHandleId: AccountHandleId; wrappedAccountKey: Uint8Array }>;

  /**
   * Close an account handle. Cascades closure of any identity / epoch
   * handles that depend on it (Slice 1 lifetime semantics).
   */
  closeAccountHandle(handleId: AccountHandleId): Promise<void>;

  /** Returns the currently-open account handle ID, or null if none. */
  getAccountHandleId(): Promise<AccountHandleId | null>;

  // ---- Identity handle lifecycle (Slice 2 will route deriveIdentity through these) ----

  /**
   * Create a fresh identity for an account: random Ed25519 + X25519 seed,
   * wrapped under the account key. Returns the identity handle plus public
   * keys plus wrapped seed (caller persists wrapped seed on the server).
   */
  createIdentityForAccount(accountHandleId: AccountHandleId): Promise<{
    identityHandleId: IdentityHandleId;
    signingPublicKey: Uint8Array;
    encryptionPublicKey: Uint8Array;
    wrappedSeed: Uint8Array;
  }>;

  /**
   * Open an existing identity handle from its wrapped seed.
   */
  openIdentityForAccount(
    accountHandleId: AccountHandleId,
    wrappedSeed: Uint8Array,
  ): Promise<{
    identityHandleId: IdentityHandleId;
    signingPublicKey: Uint8Array;
    encryptionPublicKey: Uint8Array;
  }>;

  closeIdentityHandle(handleId: IdentityHandleId): Promise<void>;

  /**
   * Sign a manifest transcript using the identity's Ed25519 signing key.
   */
  signManifestWithIdentity(
    identityHandleId: IdentityHandleId,
    transcriptBytes: Uint8Array,
  ): Promise<Uint8Array>;

  /**
   * Verify a detached manifest signature. No identity handle required —
   * verification only needs the public key.
   */
  verifyManifestWithIdentity(
    transcriptBytes: Uint8Array,
    signature: Uint8Array,
    signingPublicKey: Uint8Array,
  ): Promise<boolean>;

  // ---- Epoch handle lifecycle (Slice 3 will route epoch ops through these) ----

  /**
   * Create a new epoch handle for an account at the given epoch ID.
   * Returns the handle ID and the wrapped epoch seed (caller persists it).
   */
  createEpochHandle(
    accountHandleId: AccountHandleId,
    epochId: number,
  ): Promise<{ epochHandleId: EpochHandleId; wrappedSeed: Uint8Array }>;

  /**
   * Open an existing epoch handle from its wrapped seed at the given epoch ID.
   */
  openEpochHandle(
    accountHandleId: AccountHandleId,
    wrappedSeed: Uint8Array,
    epochId: number,
  ): Promise<{ epochHandleId: EpochHandleId }>;

  closeEpochHandle(handleId: EpochHandleId): Promise<void>;

  /**
   * Look up an epoch handle by `(albumId, epochId)`. Allows callers to
   * deduplicate epoch-handle creation when the same album+epoch is reopened.
   * Slice 3+ will key the registry through this method.
   */
  getEpochHandleId(
    albumId: string,
    epochId: number,
  ): Promise<EpochHandleId | null>;

  /**
   * Encrypt a single shard using the epoch handle's tier sub-key.
   * `tier`: 0=thumb, 1=preview, 2=original (matches the WASM contract).
   */
  encryptShardWithEpoch(
    epochHandleId: EpochHandleId,
    plaintext: Uint8Array,
    shardIndex: number,
    tier: 0 | 1 | 2,
  ): Promise<{ envelopeBytes: Uint8Array; sha256: string }>;

  /**
   * Decrypt a complete shard envelope (header + ciphertext) using the
   * epoch handle.
   */
  decryptShardWithEpoch(
    epochHandleId: EpochHandleId,
    envelopeBytes: Uint8Array,
  ): Promise<Uint8Array>;

  /**
   * Encrypt a metadata sidecar using the epoch handle. Output is a shard
   * envelope keyed by the epoch's metadata sub-key with the album/photo IDs
   * bound as AAD.
   */
  encryptMetadataSidecarWithEpoch(
    epochHandleId: EpochHandleId,
    albumId: Uint8Array,
    photoId: Uint8Array,
    epochId: number,
    encodedFields: Uint8Array,
    shardIndex: number,
  ): Promise<{ envelopeBytes: Uint8Array; sha256: string }>;

  // ---- Link sharing (Slice 6 will route hooks through these) ----

  /** Generate a fresh 32-byte link secret. */
  generateLinkSecretRust(): Promise<Uint8Array>;

  /** Derive `(linkId, wrappingKey)` from a link secret. */
  deriveLinkKeysRust(
    linkSecret: Uint8Array,
  ): Promise<{ linkId: Uint8Array; wrappingKey: Uint8Array }>;

  /**
   * Wrap a tier key for share-link distribution. The tier key never crosses
   * Comlink — it's derived inside the worker from the epoch handle.
   */
  wrapTierKeyForLinkRust(
    epochHandleId: EpochHandleId,
    tier: 0 | 1 | 2,
    wrappingKey: Uint8Array,
  ): Promise<{ tier: number; nonce: Uint8Array; encryptedKey: Uint8Array }>;

  unwrapTierKeyFromLinkRust(
    nonce: Uint8Array,
    encryptedKey: Uint8Array,
    tier: 0 | 1 | 2,
    wrappingKey: Uint8Array,
  ): Promise<Uint8Array>;

  // ---- Album content (Slice 7) ----

  encryptAlbumContentWithEpoch(
    epochHandleId: EpochHandleId,
    plaintext: Uint8Array,
  ): Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }>;

  decryptAlbumContentWithEpoch(
    epochHandleId: EpochHandleId,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array>;

  // ---- Bundle sealing (Slice 6) ----

  /**
   * Seal and sign an epoch key bundle for a recipient.
   *
   * The bundle protocol requires the per-epoch signing keypair (and seed)
   * to flow inside the bundle. Recipients call `verifyAndOpenBundle` and
   * then bootstrap an epoch handle from the returned bytes via
   * `openEpochHandle`. The returned signSecret/epochSeed are intentional
   * payload, not key leakage — they are immediately consumed by
   * `openEpochHandle` and wiped.
   */
  sealAndSignBundle(
    identityHandleId: IdentityHandleId,
    recipientPubkey: Uint8Array,
    albumId: string,
    epochId: number,
    epochSeed: Uint8Array,
    signSecret: Uint8Array,
    signPublic: Uint8Array,
  ): Promise<{ sealed: Uint8Array; signature: Uint8Array; sharerPubkey: Uint8Array }>;

  verifyAndOpenBundle(
    identityHandleId: IdentityHandleId,
    sealed: Uint8Array,
    signature: Uint8Array,
    sharerPubkey: Uint8Array,
    expectedAlbumId: string,
    expectedMinEpoch: number,
    allowLegacyEmpty: boolean,
  ): Promise<{
    albumId: string;
    epochId: number;
    epochSeed: Uint8Array;
    signSecret: Uint8Array;
    signPublic: Uint8Array;
  }>;

  // ---- Auth challenge (Slice 2) ----

  deriveAuthKeypairForAccount(
    accountHandleId: AccountHandleId,
  ): Promise<{ authPublicKey: Uint8Array }>;

  signAuthChallengeWithAccount(
    accountHandleId: AccountHandleId,
    challengeBytes: Uint8Array,
  ): Promise<Uint8Array>;

  getAuthPublicKeyForAccount(
    accountHandleId: AccountHandleId,
  ): Promise<Uint8Array>;

  // ---- Generic key wrap (Slice 8 db worker) ----

  wrapKey(keyBytes: Uint8Array, wrapperKey: Uint8Array): Promise<Uint8Array>;

  unwrapKey(wrapped: Uint8Array, wrapperKey: Uint8Array): Promise<Uint8Array>;
}

/** Exported keys structure for session caching */
export interface ExportedKeys {
  accountKey: string; // base64
  sessionKey: string; // base64
  identitySecretKey: string; // base64 (Ed25519 64-byte secret)
  identityPublicKey: string; // base64 (Ed25519 32-byte public)
  identityX25519SecretKey: string; // base64
  identityX25519PublicKey: string; // base64
}

/** GeoJSON Feature for map clustering */
export interface GeoFeature {
  type: 'Feature';
  geometry: {
    type: 'Point';
    coordinates: [number, number]; // [lng, lat]
  };
  properties: {
    id: string;
    cluster?: boolean;
    cluster_id?: number;
    point_count?: number;
  };
}

/**
 * Geo Worker API
 * Handles map clustering with Supercluster
 */
export interface GeoWorkerApi {
  /**
   * Load points into the clusterer
   */
  load(points: GeoFeature[]): void;

  /**
   * Get clusters for a bounding box at a zoom level
   * @param bbox - [westLng, southLat, eastLng, northLat]
   * @param zoom - Map zoom level (0-20)
   */
  getClusters(
    bbox: [number, number, number, number],
    zoom: number,
  ): GeoFeature[];

  /**
   * Get leaf points for a cluster
   */
  getLeaves(clusterId: number, limit: number, offset: number): GeoFeature[];
}
