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
  /** Shard IDs for this photo's encrypted data */
  shardIds: string[];
  /** Epoch ID for key lookup */
  epochId: number;
  /** Base64-encoded JPEG thumbnail (embedded in manifest for fast loading) */
  thumbnail?: string;
  /** Thumbnail width in pixels */
  thumbWidth?: number;
  /** Thumbnail height in pixels */
  thumbHeight?: number;
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
  getPhotos(albumId: string, limit: number, offset: number): Promise<PhotoMeta[]>;
  getPhotoCount(albumId: string): Promise<number>;
  searchPhotos(albumId: string, query: string): Promise<PhotoMeta[]>;
  getPhotosForMap(albumId: string, bounds: Bounds): Promise<GeoPoint[]>;
  getPhotoById(id: string): Promise<PhotoMeta | null>;
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
   * Derives L0 → L1 keys and unwraps L2 account key
   */
  init(
    password: string,
    userSalt: Uint8Array,
    accountSalt: Uint8Array
  ): Promise<void>;

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
   */
  encryptShard(
    data: Uint8Array,
    readKey: Uint8Array,
    epochId: number,
    shardIndex: number
  ): Promise<EncryptedShard>;

  /**
   * Decrypt a photo shard
   */
  decryptShard(envelope: Uint8Array, readKey: Uint8Array): Promise<Uint8Array>;

  /**
   * Decrypt manifest metadata
   */
  decryptManifest(
    encryptedMeta: Uint8Array,
    readKey: Uint8Array
  ): Promise<PhotoMeta>;

  /**
   * Verify manifest signature
   */
  verifyManifest(
    manifest: Uint8Array,
    signature: Uint8Array,
    pubKey: Uint8Array
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
    minEpochId: number
  ): Promise<{ epochSeed: Uint8Array; signPublicKey: Uint8Array; signSecretKey: Uint8Array }>;

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
    recipientPubkey: Uint8Array
  ): Promise<{ encryptedBundle: Uint8Array; signature: Uint8Array }>;

  /**
   * Generate a new epoch key for album creation or rotation
   * @param epochId - Epoch ID
   * @returns New epoch key with epochSeed and signKeypair
   */
  generateEpochKey(
    epochId: number
  ): Promise<{ epochSeed: Uint8Array; signPublicKey: Uint8Array; signSecretKey: Uint8Array }>;

  /**
   * Sign manifest data for upload
   * @param manifestData - Manifest bytes to sign
   * @param signSecretKey - Epoch sign secret key (64 bytes)
   * @returns Ed25519 signature (64 bytes)
   */
  signManifest(manifestData: Uint8Array, signSecretKey: Uint8Array): Promise<Uint8Array>;

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
  getClusters(bbox: [number, number, number, number], zoom: number): GeoFeature[];

  /**
   * Get leaf points for a cluster
   */
  getLeaves(clusterId: number, limit: number, offset: number): GeoFeature[];
}
