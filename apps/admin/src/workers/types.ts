/**
 * Shared types for worker communication
 */

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
  /** BlurHash string for instant placeholder (~30 chars, 4x3 components) */
  blurhash?: string;

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
   * Close the database and clear session key
   */
  close(): Promise<void>;

  // Album state management
  getAlbumVersion(albumId: string): Promise<number>;
  setAlbumVersion(albumId: string, version: number): Promise<void>;

  // Manifest operations
  insertManifests(manifests: DecryptedManifest[]): Promise<void>;
  deleteManifest(id: string): Promise<void>;

  // Photo queries
  getPhotos(
    albumId: string,
    limit: number,
    offset: number,
  ): Promise<PhotoMeta[]>;
  getPhotoCount(albumId: string): Promise<number>;
  searchPhotos(albumId: string, query: string): Promise<PhotoMeta[]>;
  getPhotosForMap(albumId: string, bounds: Bounds): Promise<GeoPoint[]>;
  getPhotoById(id: string): Promise<PhotoMeta | null>;

  /**
   * Clear all cached photos for an album.
   * Used after epoch rotation to ensure stale encrypted data is removed.
   * @param albumId - Album ID to clear photos for
   */
  clearAlbumPhotos(albumId: string): Promise<void>;
}

/** Encrypted shard result */
export interface EncryptedShard {
  ciphertext: Uint8Array;
  sha256: string;
}

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
