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
}
