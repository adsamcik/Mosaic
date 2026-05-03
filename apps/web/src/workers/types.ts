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
  ShardIntegrityFailed = 223,
  LegacyRawKeyDecryptFallback = 224,
  StreamingChunkOutOfOrder = 225,
  StreamingTotalChunkMismatch = 226,
  StreamingPlaintextDivergence = 227,
  OperationCancelled = 300,
  SecretHandleNotFound = 400,
  IdentityHandleNotFound = 401,
  HandleSpaceExhausted = 402,
  EpochHandleNotFound = 403,
  InternalStatePoisoned = 500,
  UnsupportedMediaFormat = 600,
  InvalidMediaContainer = 601,
  InvalidMediaDimensions = 602,
  MediaOutputTooLarge = 603,
  MediaMetadataMismatch = 604,
  InvalidMediaSidecar = 605,
  MediaAdapterOutputMismatch = 606,
  VideoContainerInvalid = 607,
  MediaInspectFailed = 608,
  MediaStripFailed = 609,
  SidecarFieldOverflow = 610,
  SidecarTagUnknown = 611,
  MalformedSidecar = 612,
  MakerNoteRejected = 613,
  ExifTraversalLimitExceeded = 614,
  VideoTooLargeForV1 = 615,
  VideoSourceUnreadable = 616,
  VideoTierShapeRejected = 617,
  MetadataSidecarReservedTagNotPromoted = 618,
  ClientCoreInvalidTransition = 700,
  ClientCoreMissingEventPayload = 701,
  ClientCoreRetryBudgetExhausted = 702,
  ClientCoreSyncPageDidNotAdvance = 703,
  ClientCoreManifestOutcomeUnknown = 704,
  ClientCoreUnsupportedSnapshotVersion = 705,
  ClientCoreInvalidSnapshot = 706,
  ManifestShapeRejected = 707,
  IdempotencyExpired = 708,
  ManifestSetConflict = 709,
  BackendIdempotencyConflict = 710,
  VideoPosterExtractionFailed = 711,
  PinValidationFailed = 800,

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
 * Bridge object passed to the DB worker so it can wrap and unwrap OPFS
 * snapshots without ever holding raw key bytes.
 *
 * Slice 8 contract: the DB worker never sees the L2-derived DB key — it
 * only invokes these callbacks, which round-trip through the crypto
 * worker's `wrapDbBlob` / `unwrapDbBlob` Comlink methods. Pass the
 * functions through `Comlink.proxy(...)` so the SharedWorker can invoke
 * them across the worker boundary.
 */
export interface DbCryptoBridge {
  /**
   * Wrap an OPFS snapshot plaintext with the active account's DB key.
   * Output is opaque ciphertext (`nonce(24) || ciphertext_with_tag`).
   */
  wrap(plaintext: Uint8Array): Promise<Uint8Array>;
  /**
   * Unwrap a snapshot blob previously produced by `wrap`. Returns plaintext.
   */
  unwrap(wrapped: Uint8Array): Promise<Uint8Array>;
}

/**
 * Database Worker API
 * Manages SQLite-WASM database with encrypted persistence to OPFS
 */
export interface DbWorkerApi {
  /**
   * Initialize the database worker.
   *
   * Slice 8 contract: the DB worker no longer accepts raw key bytes.
   * Instead, the caller passes a {@link DbCryptoBridge} whose callbacks
   * route through the crypto worker's `wrapDbBlob` / `unwrapDbBlob`
   * methods. Wrap each callback with `Comlink.proxy(...)` so the bridge
   * survives transfer to a SharedWorker.
   *
   * `init` performs sql.js bootstrap, loads (and decrypts) any persisted
   * OPFS snapshot, runs schema migrations, and leaves the worker ready
   * for use. A snapshot whose first byte does not match the current
   * `SNAPSHOT_VERSION` is silently discarded and the worker reinitializes
   * from an empty database (the cutover policy: server is the source of
   * truth, stale snapshots are not preserved across the migration).
   */
  init(crypto: DbCryptoBridge): Promise<void>;

  /**
   * Delete the persisted encrypted snapshot and recreate an empty database.
   * Reuses the crypto bridge supplied to `init` and leaves the worker ready
   * for immediate use. Must only be called after `init(crypto)` has
   * attached the bridge.
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
   * Initialize crypto with user credentials.
   *
   * Slice 2 contract: this method routes through the Rust handle-based
   * `createNewAccount` + `createIdentityForAccount` flow internally; it
   * mints fresh account and identity handles and caches the wrapped
   * account key for `getWrappedAccountKey`. The L0/L1/L2 bytes never
   * cross the Comlink boundary.
   */
  init(
    password: string,
    userSalt: Uint8Array,
    accountSalt: Uint8Array,
  ): Promise<void>;

  /**
   * Initialize crypto with an existing wrapped account key.
   *
   * Slice 2 contract: routes through `unlockAccount` +
   * `openIdentityForAccount` if a wrapped identity seed is supplied,
   * otherwise re-derives the identity from the account key.
   */
  initWithWrappedKey(
    password: string,
    userSalt: Uint8Array,
    accountSalt: Uint8Array,
    wrappedAccountKey: Uint8Array,
    wrappedIdentitySeed?: Uint8Array,
  ): Promise<void>;

  /**
   * Get the wrapped account key for server storage.
   *
   * Cached during `init` / `initWithWrappedKey`; never re-derived.
   */
  getWrappedAccountKey(): Promise<Uint8Array | null>;

  /**
   * Get the wrapped identity seed produced by `init` (or supplied to
   * `initWithWrappedKey` when registering a returning user that has a
   * persisted wrapped identity seed). `null` until identity is bound.
   */
  getWrappedIdentitySeed(): Promise<Uint8Array | null>;

  /**
   * Clear all keys from memory.
   *
   * Cascades closure of every Rust handle (epoch → identity → account)
   * via the registry and bumps the registry's generation counter so any
   * handle ID minted before this call resolves to `StaleHandle`.
   */
  clear(): Promise<void>;

  /**
   * Wrap an OPFS-snapshot plaintext blob with the active account's L2 key
   * through the Rust account handle; raw key bytes never cross the Comlink
   * boundary in either direction.
   *
   * Output is the Rust account-handle envelope:
   * `[nonce(24) || ciphertext_with_tag(16)]`. P-W7.3 replaces the
   * account-derived DB-session wrapper key with handle-based L2 wrapping.
   *
   * @throws WorkerCryptoError(WorkerNotInitialized) if no account handle is open.
   */
  wrapDbBlob(plaintext: Uint8Array): Promise<Uint8Array>;

  /**
   * Unwrap a blob previously wrapped by {@link wrapDbBlob}. Returns the
   * plaintext on success.
   *
   * @throws WorkerCryptoError(WorkerNotInitialized) if no account handle is open.
   * @throws WorkerCryptoError on Rust-side authentication / parsing failures.
   */
  unwrapDbBlob(wrapped: Uint8Array): Promise<Uint8Array>;

  /**
   * Wrap `plaintext` with a key derived from the active account handle.
   *
   * Slice 2 replacement for the per-tab AES-GCM key in `key-cache.ts`:
   * the wrap key never crosses Comlink. Output is opaque ciphertext
   * (`nonce(24) || ciphertext_with_tag`).
   */
  getDbEncryptionWrap(plaintext: Uint8Array): Promise<Uint8Array>;

  unwrapDbEncryption(wrapped: Uint8Array): Promise<Uint8Array>;

  /**
   * Serialize the session bootstrap state into an OPAQUE blob suitable
   * for sessionStorage / IndexedDB caching across page reloads.
   *
   * The blob carries only opaque payload: the wrapped account key, the
   * wrapped identity seed, and the auth public key. Raw secret keys
   * NEVER appear in the blob — the caller must still supply the
   * password to reopen the handles via `restoreSessionState`.
   */
  serializeSessionState(): Promise<Uint8Array | null>;

  /**
   * Reopen the account + identity handles from a previously serialized
   * blob, supplying the password and salts for the L1 KDF pass.
   */
  restoreSessionState(
    blob: Uint8Array,
    password: string,
    userSalt: Uint8Array,
    accountSalt: Uint8Array,
  ): Promise<void>;

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
   * Verify manifest signature using the per-epoch manifest signing key.
   *
   * Slice 4 — routes through Rust `verifyManifestWithEpoch`. The signing
   * public key crosses Comlink (it's safe to expose); the manifest
   * transcript bytes and signature do too.
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
   * Slice 2 contract: identity is now derived during `init` /
   * `initWithWrappedKey`. This method remains as a no-op stub for the
   * Slice 3+ callers (`epoch-key-service.ts`, `epoch-rotation-service.ts`)
   * that still defensively call it; it returns immediately when an
   * identity handle is already open and is otherwise a no-op.
   *
   * @deprecated Slice 3 will retire the call sites; this stub will be
   * deleted along with them.
   */
  deriveIdentity(): Promise<void>;

  /**
   * Open (decrypt) an epoch key bundle.
   *
   * Slice 3 — never returns raw seed/sign-secret bytes across Comlink. The
   * sealed bundle is verified inside Rust, the cleartext payload is imported
   * directly into a new epoch handle, and the only thing handed back to the
   * caller is the opaque handle id plus the per-epoch sign public key
   * (32-byte Ed25519, safe to expose).
   *
   * @param bundle - Encrypted epoch key bundle from server
   * @param senderPubkey - Ed25519 public key of the sender (for signature verification)
   * @param albumId - Album ID for context validation
   * @param minEpochId - Minimum acceptable epoch ID (prevents replay)
   * @returns Opaque epoch handle id, epoch id, and per-epoch sign public key.
   */
  openEpochKeyBundle(
    bundle: Uint8Array,
    senderPubkey: Uint8Array,
    albumId: string,
    minEpochId: number,
    options?: OpenEpochKeyBundleOptions,
  ): Promise<{
    epochHandleId: EpochHandleId;
    epochId: number;
    signPublicKey: Uint8Array;
  }>;

  /**
   * Create an epoch key bundle for sharing with another user.
   *
   * Slice 3 — takes the sender's epoch handle id directly. Bundle payload
   * bytes (epoch seed + per-epoch sign keypair) never cross Comlink; they
   * are resolved from the registry inside Rust and consumed by the seal
   * call atomically.
   *
   * @param epochHandleId - Sender's epoch handle that holds the bundle payload
   * @param albumId - Album ID
   * @param recipientPubkey - Recipient's Ed25519 identity public key
   * @returns Sealed and signed bundle ready for transmission
   */
  createEpochKeyBundle(
    epochHandleId: EpochHandleId,
    albumId: string,
    recipientPubkey: Uint8Array,
  ): Promise<{ encryptedBundle: Uint8Array; signature: Uint8Array }>;

  /**
   * Generate a new epoch key for album creation or rotation.
   *
   * Slice 3 — mints a Rust-owned epoch handle for the bound account key.
   * Returns the opaque handle id plus the wrapped epoch seed (for any
   * caller that wants to persist the seed for offline re-open) and the
   * per-epoch sign public key (so the caller can publish `signPubkey` in
   * create/rotate API requests). Raw secret bytes never cross Comlink.
   *
   * @param epochId - Epoch ID
   */
  generateEpochKey(epochId: number): Promise<{
    epochHandleId: EpochHandleId;
    wrappedSeed: Uint8Array;
    signPublicKey: Uint8Array;
  }>;

  /**
   * Encrypt manifest metadata for upload using a Rust-owned epoch handle.
   *
   * Slice 4 — replaces the legacy `encryptManifest(meta, readKey, epochId)`
   * which derived the thumb-tier key in TypeScript. The handle resolves
   * the tier key inside Rust; the seed never crosses Comlink. The implicit
   * `(shardIndex=0, tier=THUMB)` convention matches the manifest envelope
   * layout.
   *
   * @param epochHandleId - Opaque epoch handle id from the worker.
   * @param plaintext - Manifest JSON-encoded plaintext bytes.
   * @returns Shard envelope (header + ciphertext) and base64url SHA-256.
   */
  encryptManifestWithEpoch(
    epochHandleId: EpochHandleId,
    plaintext: Uint8Array,
  ): Promise<{ envelopeBytes: Uint8Array; sha256: string }>;

  /**
   * Sign manifest transcript bytes with the per-epoch Ed25519 manifest
   * signing key attached to a Rust-owned epoch handle.
   *
   * Slice 4 — replaces the legacy `signManifest(payloadBytes, signSecret)`
   * which took the per-epoch sign secret as raw bytes. The sign secret
   * never crosses Comlink; the worker resolves it from the epoch handle
   * inside Rust and signs in one shot.
   *
   * @param epochHandleId - Opaque epoch handle id from the worker.
   * @param manifestBytes - Manifest transcript bytes to sign.
   * @returns 64-byte Ed25519 detached signature.
   */
  signManifestWithEpoch(
    epochHandleId: EpochHandleId,
    manifestBytes: Uint8Array,
  ): Promise<Uint8Array>;

  /**
   * Decrypt a manifest envelope using a Rust-owned epoch handle's
   * thumb-tier key.
   *
   * Slice 4 — replaces the legacy `decryptManifest(encryptedMeta, readKey)`
   * which derived tier keys in TypeScript. Returns the JSON-encoded
   * `PhotoMeta` plaintext bytes (the caller decodes/parses).
   *
   * @param epochHandleId - Opaque epoch handle id from the worker.
   * @param envelopeBytes - Complete shard envelope (header + ciphertext).
   * @returns Decoded UTF-8 JSON bytes of the {@link PhotoMeta}.
   */
  decryptManifestWithEpoch(
    epochHandleId: EpochHandleId,
    envelopeBytes: Uint8Array,
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
  // LocalAuth Authentication Methods
  // =========================================================================

  /**
   * Derive the password-rooted LocalAuth Ed25519 keypair from
   * `password` + `userSalt` and stash it in the worker's transient
   * pre-auth slot.
   *
   * Slice 2 fixup: this method exists because LocalAuth login/register
   * must sign an auth challenge BEFORE an account handle is open (the
   * server only releases the wrapped account key after a successful
   * auth). The derived auth keypair is rooted in Argon2id+HKDF over
   * `password`+`userSalt` — the same pre-auth derivation the legacy
   * worker exposed — and is independent from the account-handle-rooted
   * auth keypair used by future Slice 8+ flows.
   *
   * After this call, `signAuthChallenge` and `getAuthPublicKey` route
   * through the pre-auth slot. The slot survives `init` /
   * `initWithWrappedKey` so the register flow (which calls
   * `deriveAuthKey` → `init` → `signAuthChallenge`) keeps the same
   * keypair across the boundary. The slot is wiped on `clear()`.
   *
   * @param password - User's password (UTF-8)
   * @param userSalt - 16-byte per-user salt
   * @returns The 32-byte Ed25519 auth public key
   */
  deriveAuthKey(password: string, userSalt: Uint8Array): Promise<Uint8Array>;

  /**
   * Sign an authentication challenge for LocalAuth login.
   *
   * Slice 2 contract: prefers the pre-auth keypair installed by
   * `deriveAuthKey()` (password-rooted). Falls back to the active
   * account handle's L2-rooted auth keypair when no pre-auth slot is
   * populated. Builds the canonical transcript
   * (`Mosaic_Auth_Challenge_v1 || username_len_be_u32 || username ||
   * timestamp_be_u64? || challenge`) inside Rust and returns a 64-byte
   * detached signature.
   *
   * Throws `WorkerCryptoError(WorkerNotInitialized)` when neither a
   * pre-auth keypair nor an open account handle is available.
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
   * Get the Ed25519 LocalAuth public key.
   *
   * Returns the pre-auth keypair's public key when `deriveAuthKey()`
   * has populated the transient slot; otherwise returns the cached
   * account-handle-rooted public key (set by `init` /
   * `initWithWrappedKey` / `restoreSessionState`); otherwise `null`.
   *
   * @returns Ed25519 public key (32 bytes) or null if no key is bound
   */
  getAuthPublicKey(): Promise<Uint8Array | null>;

  // =========================================================================
  // Album Content Encryption (Story Blocks) — Slice 7 handle-based contract
  // =========================================================================

  /**
   * Encrypt album content (story blocks document) using the album's epoch
   * handle. Routes through the Rust facade's `encryptAlbumContent` which
   * derives a content-specific sub-key from the handle and binds the epoch
   * id as AAD. The epoch seed never crosses Comlink.
   *
   * Slice 7 — replaces the legacy seed-bearing signature with a
   * handle-based one.
   *
   * @param epochHandleId - Opaque epoch handle id from the worker.
   * @param plaintext - Plaintext content (JSON-encoded document).
   * @returns Encrypted content with nonce + ciphertext.
   */
  encryptAlbumContent(
    epochHandleId: EpochHandleId,
    plaintext: Uint8Array,
  ): Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }>;

  /**
   * Decrypt album content previously produced by {@link encryptAlbumContent}.
   *
   * Slice 7 — replaces the legacy seed-bearing signature with a
   * handle-based one.
   *
   * @param epochHandleId - Opaque epoch handle id from the worker.
   * @param nonce - 24-byte nonce from encryption.
   * @param ciphertext - Encrypted content (with embedded auth tag).
   * @returns Decrypted plaintext content.
   */
  decryptAlbumContent(
    epochHandleId: EpochHandleId,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array>;

  // =========================================================================
  // Album Name Encryption — Slice 7 thin wrappers over shard contract
  // =========================================================================

  /**
   * Encrypt an album name using the epoch handle's thumb-tier key.
   *
   * Convenience wrapper over {@link encryptShardWithEpoch} that pins
   * `shardIndex=0` and `tier=ShardTier::Thumbnail` (byte value `1`,
   * matching `mosaic_domain::ShardTier::Thumbnail.to_byte()`). The
   * worker is the single source of truth for the (shardIndex, tier)
   * convention so callers do not duplicate magic numbers.
   *
   * Slice 7 — replaces the inline encrypt-shard call from `useAlbums.ts`.
   *
   * @param epochHandleId - Opaque epoch handle id from the worker.
   * @param nameBytes - UTF-8 encoded album name.
   * @returns Shard envelope bytes (header + ciphertext) suitable for
   *   base64-encoding into `encryptedName` API fields.
   */
  encryptAlbumName(
    epochHandleId: EpochHandleId,
    nameBytes: Uint8Array,
  ): Promise<Uint8Array>;

  /**
   * Decrypt an album-name envelope previously produced by
   * {@link encryptAlbumName}. Thin wrapper over
   * {@link decryptShardWithEpoch} — the envelope header carries the tier
   * byte so callers do not specify it.
   *
   * @param epochHandleId - Opaque epoch handle id from the worker.
   * @param envelopeBytes - Complete shard envelope (header + ciphertext).
   * @returns UTF-8 plaintext bytes of the album name.
   */
  decryptAlbumName(
    epochHandleId: EpochHandleId,
    envelopeBytes: Uint8Array,
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
   * Returns the handle ID, the wrapped epoch seed (caller persists it),
   * and the per-epoch Ed25519 manifest signing public key.
   */
  createEpochHandle(
    accountHandleId: AccountHandleId,
    epochId: number,
  ): Promise<{
    epochHandleId: EpochHandleId;
    wrappedSeed: Uint8Array;
    signPublicKey: Uint8Array;
  }>;

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

  // ---- Link sharing (Slice 6) ----

  /**
   * Generate a fresh 32-byte link secret. Random bytes are produced inside
   * the Rust crypto core; the worker only forwards the resulting buffer
   * across Comlink.
   */
  generateLinkSecret(): Promise<Uint8Array>;

  /**
   * Derive `(linkId, wrappingKey)` from a link secret.
   *
   * @param linkSecret - 32-byte secret from URL fragment.
   * @returns 16-byte link ID + 32-byte wrapping key.
   */
  deriveLinkKeys(
    linkSecret: Uint8Array,
  ): Promise<{ linkId: Uint8Array; wrappingKey: Uint8Array }>;

  /**
   * Wrap a tier key for share-link distribution.
   *
   * The tier key never crosses Comlink — it is derived inside the worker
   * from the epoch handle and wrapped under the per-link wrapping key in
   * one shot.
   *
   * @param epochHandleId - Opaque epoch handle id.
   * @param tier - 0-indexed tier byte (0=thumb, 1=preview, 2=full).
   * @param wrappingKey - 32-byte per-link wrapping key.
   */
  wrapTierKeyForLink(
    epochHandleId: EpochHandleId,
    tier: 0 | 1 | 2,
    wrappingKey: Uint8Array,
  ): Promise<{ tier: number; nonce: Uint8Array; encryptedKey: Uint8Array }>;

  /**
   * Unwrap a tier key wrapped via `wrapTierKeyForLink`.
   *
   * @param nonce - 24-byte nonce stored alongside the encrypted key.
   * @param encryptedKey - Encrypted tier key.
   * @param tier - 0-indexed tier byte (0=thumb, 1=preview, 2=full).
   * @param wrappingKey - 32-byte per-link wrapping key.
   * @returns Unwrapped 32-byte tier key (caller is responsible for wiping).
   */
  unwrapTierKeyFromLink(
    nonce: Uint8Array,
    encryptedKey: Uint8Array,
    tier: 0 | 1 | 2,
    wrappingKey: Uint8Array,
  ): Promise<Uint8Array>;

  // ---- Album content (Slice 7) ----
  //
  // The handle-based `encryptAlbumContent` / `decryptAlbumContent` and
  // the album-name helpers are declared in the dedicated "Album Content
  // Encryption" / "Album Name Encryption" blocks above. The Slice 1
  // `*WithEpoch` aliases were retired now that the legacy seed-bearing
  // methods have been deleted.

  // ---- Bundle sealing (Slice 6) ----

  /**
   * Seal and sign an epoch key bundle for a recipient.
   *
   * The bundle protocol carries the per-epoch signing keypair inside the
   * sealed payload. Recipients open it through the handle-based bundle flow,
   * which imports payload secrets inside Rust without exposing them to JS.
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
