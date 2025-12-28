/**
 * Mosaic API Types
 *
 * TypeScript types matching the OpenAPI specification.
 * Generated from docs/api/openapi.yaml
 */

// =============================================================================
// Common Types
// =============================================================================

export interface ErrorResponse {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version?: string;
  checks?: Record<string, 'ok' | 'warn' | 'fail'>;
}

// =============================================================================
// User Types
// =============================================================================

export interface User {
  id: string;
  authSub: string;
  identityPubkey?: string;
  createdAt: string;
  /** Base64-encoded encrypted user salt for multi-device sync */
  encryptedSalt?: string;
  /** Base64-encoded nonce used for salt encryption (12 bytes for AES-GCM) */
  saltNonce?: string;
}

export interface UserPublic {
  id: string;
  identityPubkey: string;
}

export interface UpdateUserRequest {
  identityPubkey?: string;
  /** Base64-encoded encrypted user salt */
  encryptedSalt?: string;
  /** Base64-encoded nonce for salt encryption */
  saltNonce?: string;
}

// =============================================================================
// Album Types
// =============================================================================

export interface Album {
  id: string;
  ownerId: string;
  currentVersion: number;
  currentEpochId: number;
  createdAt: string;
  updatedAt?: string;
}

export interface CreateAlbumRequest {
  initialEpochKey: CreateEpochKeyRequest;
}

// =============================================================================
// Member Types
// =============================================================================

export type AlbumRole = 'owner' | 'editor' | 'viewer';

export interface AlbumMember {
  userId: string;
  role: AlbumRole;
  invitedBy?: string;
  joinedAt: string;
  user?: UserPublic;
}

export interface InviteRequest {
  recipientId: string;
  role: 'editor' | 'viewer';
  epochKeys: CreateEpochKeyRequest[];
}

// =============================================================================
// Epoch Key Types
// =============================================================================

export interface EpochKeyRecord {
  id: string;
  albumId: string;
  epochId: number;
  encryptedKeyBundle: string;
  ownerSignature: string;
  sharerPubkey: string;
  signPubkey: string;
  createdAt: string;
}

export interface CreateEpochKeyRequest {
  recipientId: string;
  epochId: number;
  encryptedKeyBundle: string;
  ownerSignature: string;
  sharerPubkey: string;
  signPubkey: string;
}

export interface RotateEpochRequest {
  epochKeys: CreateEpochKeyRequest[];
  shareLinkKeys?: ShareLinkKeyUpdateRequest[];
}

// =============================================================================
// Share Link Types
// =============================================================================

/** Access tier for share links */
export type AccessTier = 1 | 2 | 3; // 1=thumb, 2=preview, 3=full

/** Wrapped tier key for a share link */
export interface WrappedKeyRequest {
  epochId: number;
  tier: AccessTier;
  nonce: string; // Base64
  encryptedKey: string; // Base64
}

/** Share link creation request */
export interface CreateShareLinkRequest {
  accessTier: AccessTier;
  expiresAt?: string;
  maxUses?: number;
  ownerEncryptedSecret?: string; // Base64
  linkId: string; // Base64 (16 bytes)
  wrappedKeys: WrappedKeyRequest[];
}

/** Share link response */
export interface ShareLinkResponse {
  id: string;
  linkId: string;
  accessTier: AccessTier;
  expiresAt?: string;
  maxUses?: number;
  useCount: number;
  isRevoked: boolean;
  createdAt: string;
}

/** Share link with owner-encrypted secret (for epoch rotation) */
export interface ShareLinkWithSecretResponse {
  id: string;
  linkId: string;
  accessTier: AccessTier;
  isRevoked: boolean;
  ownerEncryptedSecret?: string; // Base64
}

/** Response for anonymous link access */
export interface LinkAccessResponse {
  albumId: string;
  accessTier: AccessTier;
  epochCount: number;
}

/** Response for link epoch key */
export interface LinkEpochKeyResponse {
  epochId: number;
  tier: AccessTier;
  nonce: string; // Base64
  encryptedKey: string; // Base64
  signPubkey?: string;
}

/** Response for photo metadata accessed via share link */
export interface ShareLinkPhotoResponse {
  id: string;
  versionCreated: number;
  isDeleted: boolean;
  encryptedMeta: string; // Base64
  signature: string;
  signerPubkey: string;
  shardIds: string[];
}

/** Wrapped key for share link tier during rotation */
export interface ShareLinkWrappedKeyRequest {
  tier: AccessTier;
  nonce: string; // Base64
  encryptedKey: string; // Base64
}

/** Share link key update during epoch rotation */
export interface ShareLinkKeyUpdateRequest {
  shareLinkId: string;
  wrappedKeys: ShareLinkWrappedKeyRequest[];
}

/** Request to add epoch keys to a share link */
export interface AddShareLinkEpochKeysRequest {
  epochKeys: ShareLinkEpochKeyRequest[];
}

/** Individual epoch key for share link */
export interface ShareLinkEpochKeyRequest {
  epochId: number;
  tier: AccessTier;
  nonce: string; // Base64, 24 bytes
  encryptedKey: string; // Base64
}

// =============================================================================
// Sync Types
// =============================================================================

export interface SyncResponse {
  manifests: ManifestRecord[];
  albumVersion: number;
  hasMore: boolean;
}

// =============================================================================
// Manifest Types
// =============================================================================

export interface ManifestRecord {
  id: string;
  albumId: string;
  versionCreated: number;
  isDeleted: boolean;
  encryptedMeta: string;
  signature: string;
  signerPubkey: string;
  shardIds: string[];
  createdAt: string;
  updatedAt?: string;
}

export interface CreateManifestRequest {
  albumId: string;
  encryptedMeta: string;
  signature: string;
  signerPubkey: string;
  shardIds: string[];
}

export interface ManifestCreated {
  id: string;
  version: number;
}

// =============================================================================
// Shard Types
// =============================================================================

export interface CreateShardRequest {
  sizeBytes: number;
}

export interface ShardCreated {
  id: string;
  uploadUrl: string;
}

// =============================================================================
// API Client Interface
// =============================================================================

/**
 * API client interface for Mosaic backend.
 */
export interface MosaicApi {
  // Health
  getHealth(): Promise<HealthResponse>;

  // Users
  getCurrentUser(): Promise<User>;
  updateCurrentUser(request: UpdateUserRequest): Promise<User>;
  getUser(userId: string): Promise<UserPublic>;
  getUserByPubkey(pubkey: string): Promise<UserPublic>;

  // Albums
  listAlbums(): Promise<Album[]>;
  createAlbum(request: CreateAlbumRequest): Promise<Album>;
  getAlbum(albumId: string): Promise<Album>;
  deleteAlbum(albumId: string): Promise<void>;
  syncAlbum(albumId: string, since: number, limit?: number): Promise<SyncResponse>;

  // Members
  listAlbumMembers(albumId: string): Promise<AlbumMember[]>;
  inviteToAlbum(albumId: string, request: InviteRequest): Promise<AlbumMember>;
  removeAlbumMember(albumId: string, userId: string): Promise<void>;

  // Epoch Keys
  getEpochKeys(albumId: string): Promise<EpochKeyRecord[]>;
  createEpochKey(albumId: string, request: CreateEpochKeyRequest): Promise<EpochKeyRecord>;
  rotateEpoch(albumId: string, epochId: number, request: RotateEpochRequest): Promise<void>;

  // Manifests
  createManifest(request: CreateManifestRequest): Promise<ManifestCreated>;
  getManifest(manifestId: string): Promise<ManifestRecord>;
  deleteManifest(manifestId: string): Promise<void>;

  // Shards
  downloadShard(shardId: string): Promise<Uint8Array>;
  createShardUpload(request: CreateShardRequest): Promise<ShardCreated>;

  // Share Links
  listShareLinks(albumId: string): Promise<ShareLinkResponse[]>;
  listShareLinksWithSecrets(albumId: string): Promise<ShareLinkWithSecretResponse[]>;
  createShareLink(albumId: string, request: CreateShareLinkRequest): Promise<ShareLinkResponse>;
  revokeShareLink(linkId: string): Promise<void>;
  addShareLinkEpochKeys(
    linkId: string,
    request: AddShareLinkEpochKeysRequest
  ): Promise<{ added: number; updated: number }>;

  // Anonymous Share Link Access (no auth required)
  getShareLinkInfo(linkIdBase64: string): Promise<LinkAccessResponse>;
  getShareLinkKeys(linkIdBase64: string): Promise<LinkEpochKeyResponse[]>;
  getShareLinkPhotos(linkIdBase64: string): Promise<ShareLinkPhotoResponse[]>;
}
