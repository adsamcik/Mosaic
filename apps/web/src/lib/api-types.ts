/**
 * Mosaic API Types
 *
 * TypeScript types matching the OpenAPI specification.
 * Generated from docs/api/openapi.yaml
 */

// =============================================================================
// Access Tier for Share Links (re-exported from @mosaic/crypto)
// =============================================================================

import { AccessTier } from '@mosaic/crypto';
export { AccessTier };
export type AccessTierValue = AccessTier;

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
  /** Whether the user is an admin */
  isAdmin?: boolean;
  /** Base64-encoded encrypted user salt for multi-device sync */
  encryptedSalt?: string;
  /** Base64-encoded nonce used for salt encryption (12 bytes for AES-GCM) */
  saltNonce?: string;
  /** Base64-encoded account salt for L1 derivation */
  accountSalt?: string;
  /** Base64-encoded wrapped account key for identity persistence */
  wrappedAccountKey?: string;
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
  /** Base64-encoded encrypted album name (client-side encrypted with epoch read key) */
  encryptedName?: string | null;
  /** Base64-encoded encrypted album description (client-side encrypted with epoch read key) */
  encryptedDescription?: string | null;
  /** ISO 8601 date when album expires and will be deleted */
  expiresAt?: string | null;
  /** Days before expiration to show warning (default: 7) */
  expirationWarningDays?: number;
}

export interface CreateAlbumRequest {
  initialEpochKey: CreateEpochKeyRequest;
  /** Base64-encoded encrypted album name (optional) */
  encryptedName?: string;
  /** Base64-encoded encrypted album description (optional) */
  encryptedDescription?: string;
  /** ISO 8601 date when album should expire */
  expiresAt?: string;
  /** Days before expiration to show warning (default: 7) */
  expirationWarningDays?: number;
}

/** Request to update album expiration settings */
export interface UpdateExpirationRequest {
  /** ISO 8601 date when album expires, or null to remove expiration */
  expiresAt?: string | null;
  /** Days before expiration to show warning */
  expirationWarningDays?: number;
}

/** Request to update photo expiration settings. Lifecycle metadata only. */
export interface UpdatePhotoExpirationRequest {
  /** ISO 8601 date when photo expires, or null to remove expiration */
  expiresAt?: string | null;
  /** Days before expiration to show warning */
  expirationWarningDays?: number;
}

/** Request to rename an album (update encrypted name) */
export interface RenameAlbumRequest {
  /** Base64-encoded encrypted album name (encrypted with epoch read key) */
  encryptedName: string;
}

/** Response from renaming an album */
export interface RenameAlbumResponse {
  id: string;
  encryptedName: string;
  updatedAt: string;
}

/** Request to update album description */
export interface UpdateDescriptionRequest {
  /** Base64-encoded encrypted album description, or null to clear */
  encryptedDescription?: string | null;
}

/** Response from updating album description */
export interface UpdateDescriptionResponse {
  id: string;
  encryptedDescription?: string | null;
  updatedAt: string;
}

// =============================================================================
// Album Content Types (Story Blocks)
// =============================================================================

/** Response containing encrypted album content */
export interface AlbumContentResponse {
  /** Base64-encoded encrypted content document */
  encryptedContent: string;
  /** Base64-encoded 24-byte nonce */
  nonce: string;
  /** Epoch ID used for encryption */
  epochId: number;
  /** Content version (for optimistic concurrency) */
  version: number;
  /** When content was last updated (ISO 8601) */
  updatedAt: string;
}

/** Request to update album content */
export interface UpdateAlbumContentRequest {
  /** Base64-encoded encrypted content document */
  encryptedContent: string;
  /** Base64-encoded 24-byte nonce */
  nonce: string;
  /** Epoch ID used for encryption */
  epochId: number;
  /** Expected current version (0 for new content) */
  expectedVersion: number;
}

/** Request to update share link expiration settings */
export interface UpdateLinkExpirationRequest {
  /** ISO 8601 date when link expires, or null to remove expiration */
  expiresAt?: string | null;
  /** Maximum number of uses, or null to remove limit */
  maxUses?: number | null;
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

export interface SyncAlbumOptions {
  limit?: number;
  signal?: AbortSignal;
}

// =============================================================================
// Share Link Types
// =============================================================================

// AccessTier type is imported from @mosaic/crypto and re-exported at the top of this file

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
  encryptedName?: string | null;
  grantToken?: string | null;
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
// Admin Types
// =============================================================================

/** Quota defaults that can be configured site-wide */
export interface QuotaDefaults {
  maxStorageBytes: number;
  maxAlbums: number;
  maxPhotosPerAlbum: number;
  maxAlbumSizeBytes: number;
}

/** User with quota information for admin view */
export interface AdminUserResponse {
  id: string;
  authSub: string;
  identityPubkey?: string;
  isAdmin: boolean;
  createdAt: string;
  albumCount: number;
  totalStorageBytes: number;
  quota: AdminUserQuota;
}

/** User quota with both limits and current usage */
export interface AdminUserQuota {
  maxStorageBytes?: number;
  currentStorageBytes: number;
  maxAlbums?: number;
  currentAlbumCount: number;
}

/** Request to update user quota */
export interface UpdateUserQuotaRequest {
  maxStorageBytes?: number | null;
  maxAlbums?: number | null;
}

/** Album with limits for admin view */
export interface AdminAlbumResponse {
  id: string;
  ownerId: string;
  ownerAuthSub: string;
  createdAt: string;
  photoCount: number;
  totalSizeBytes: number;
  limits?: AdminAlbumLimits;
}

/** Album limits with both max and current values */
export interface AdminAlbumLimits {
  maxPhotos?: number;
  currentPhotoCount: number;
  maxSizeBytes?: number;
  currentSizeBytes: number;
}

/** Request to update album limits */
export interface UpdateAlbumLimitsRequest {
  maxPhotos?: number | null;
  maxSizeBytes?: number | null;
}

/** System-wide statistics for admin dashboard */
export interface AdminStatsResponse {
  totalUsers: number;
  totalAlbums: number;
  totalPhotos: number;
  totalStorageBytes: number;
}

/** Users/albums near their limits */
export interface NearLimitsResponse {
  usersNearStorageLimit: AdminUserResponse[];
  usersNearAlbumLimit: AdminUserResponse[];
  albumsNearPhotoLimit: AdminAlbumResponse[];
  albumsNearSizeLimit: AdminAlbumResponse[];
}

// =============================================================================
// Sync Types
// =============================================================================

export interface SyncResponse {
  manifests: ManifestRecord[];
  currentEpochId: number;
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
  /** ISO 8601 date when this photo expires and will be deleted */
  expiresAt?: string | null;
  /** Days before expiration to show warning */
  expirationWarningDays?: number;
  createdAt: string;
  updatedAt?: string;
}

export interface CreateManifestRequest {
  albumId: string;
  encryptedMeta: string;
  signature: string;
  signerPubkey: string;
  shardIds: string[];
  /** Optional tier for all shards (defaults to 3/Original) */
  tier?: number;
  /** Optional per-shard tier assignment (takes precedence over shardIds if provided) */
  tieredShards?: Array<{ shardId: string; tier: number }>;
}

export interface ManifestCreated {
  id: string;
  version: number;
}

export interface UpdateManifestMetadataRequest {
  encryptedMeta: string;
  signature: string;
  signerPubkey: string;
}

export interface ManifestMetadataUpdated {
  id: string;
  versionCreated: number;
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
  /**
   * Upload the wrapped account key for the current user (PUT /users/me/wrapped-key).
   * Used during first login to persist the L2 account key wrapped under the
   * password-derived key, so subsequent logins on any device unwrap to the
   * same identity. Returns void; the server responds 204 on success.
   *
   * Going through the centralised API client (instead of a raw fetch in
   * session.ts) ensures the request is subject to the same error envelope
   * as other endpoints, so failures propagate to the login caller and
   * trigger M4's re-fetch guard.
   */
  updateCurrentUserWrappedKey(wrappedAccountKey: Uint8Array): Promise<void>;
  getUser(userId: string): Promise<UserPublic>;
  getUserByPubkey(pubkey: string): Promise<UserPublic>;

  // Albums
  listAlbums(skip?: number, take?: number): Promise<Album[]>;
  createAlbum(request: CreateAlbumRequest): Promise<Album>;
  getAlbum(albumId: string): Promise<Album>;
  deleteAlbum(albumId: string): Promise<void>;
  renameAlbum(
    albumId: string,
    request: RenameAlbumRequest,
  ): Promise<RenameAlbumResponse>;
  updateAlbumDescription(
    albumId: string,
    request: UpdateDescriptionRequest,
  ): Promise<UpdateDescriptionResponse>;
  updateAlbumExpiration(
    albumId: string,
    request: UpdateExpirationRequest,
  ): Promise<Album>;
  syncAlbum(
    albumId: string,
    since: number,
    options?: SyncAlbumOptions,
  ): Promise<SyncResponse>;

  // Members
  listAlbumMembers(
    albumId: string,
    skip?: number,
    take?: number,
  ): Promise<AlbumMember[]>;
  inviteToAlbum(albumId: string, request: InviteRequest): Promise<AlbumMember>;
  removeAlbumMember(albumId: string, userId: string): Promise<void>;

  // Epoch Keys
  getEpochKeys(albumId: string): Promise<EpochKeyRecord[]>;
  createEpochKey(
    albumId: string,
    request: CreateEpochKeyRequest,
  ): Promise<EpochKeyRecord>;
  rotateEpoch(
    albumId: string,
    epochId: number,
    request: RotateEpochRequest,
  ): Promise<void>;

  // Manifests
  createManifest(request: CreateManifestRequest): Promise<ManifestCreated>;
  getManifest(manifestId: string): Promise<ManifestRecord>;
  updateManifestMetadata(
    manifestId: string,
    request: UpdateManifestMetadataRequest,
  ): Promise<ManifestMetadataUpdated>;
  deleteManifest(manifestId: string): Promise<void>;
  updatePhotoExpiration(
    manifestId: string,
    request: UpdatePhotoExpirationRequest,
  ): Promise<void>;

  // Shards
  downloadShard(shardId: string): Promise<Uint8Array>;
  createShardUpload(request: CreateShardRequest): Promise<ShardCreated>;

  // Album Expiration
  updateAlbumExpiration(
    albumId: string,
    request: UpdateExpirationRequest,
  ): Promise<Album>;

  // Share Links
  listShareLinks(
    albumId: string,
    skip?: number,
    take?: number,
  ): Promise<ShareLinkResponse[]>;
  listShareLinksWithSecrets(
    albumId: string,
    skip?: number,
    take?: number,
  ): Promise<ShareLinkWithSecretResponse[]>;
  createShareLink(
    albumId: string,
    request: CreateShareLinkRequest,
  ): Promise<ShareLinkResponse>;
  revokeShareLink(linkId: string): Promise<void>;
  addShareLinkEpochKeys(
    linkId: string,
    request: AddShareLinkEpochKeysRequest,
  ): Promise<{ added: number; updated: number }>;
  updateShareLinkExpiration(
    albumId: string,
    linkId: string,
    request: UpdateLinkExpirationRequest,
  ): Promise<ShareLinkResponse>;

  // Anonymous Share Link Access (no auth required)
  getShareLinkInfo(linkIdBase64: string): Promise<LinkAccessResponse>;
  getShareLinkKeys(linkIdBase64: string): Promise<LinkEpochKeyResponse[]>;
  getShareLinkPhotos(
    linkIdBase64: string,
    skip?: number,
    take?: number,
  ): Promise<ShareLinkPhotoResponse[]>;
  getShareLinkShard(
    linkIdBase64: string,
    shardId: string,
  ): Promise<ArrayBuffer>;

  // Admin - Settings
  getQuotaDefaults(): Promise<QuotaDefaults>;
  updateQuotaDefaults(request: QuotaDefaults): Promise<QuotaDefaults>;

  // Admin - Users
  listUsers(skip?: number, take?: number): Promise<AdminUserResponse[]>;
  getUserQuota(userId: string): Promise<AdminUserQuota>;
  updateUserQuota(
    userId: string,
    request: UpdateUserQuotaRequest,
  ): Promise<AdminUserQuota>;
  resetUserQuota(userId: string): Promise<AdminUserQuota>;
  promoteToAdmin(userId: string): Promise<void>;
  demoteFromAdmin(userId: string): Promise<void>;

  // Admin - Albums
  listAllAlbums(skip?: number, take?: number): Promise<AdminAlbumResponse[]>;
  getAlbumLimits(albumId: string): Promise<AdminAlbumLimits>;
  updateAlbumLimits(
    albumId: string,
    request: UpdateAlbumLimitsRequest,
  ): Promise<AdminAlbumLimits>;
  resetAlbumLimits(albumId: string): Promise<AdminAlbumLimits>;

  // Admin - Stats
  getStats(): Promise<AdminStatsResponse>;
  getNearLimits(): Promise<NearLimitsResponse>;

  // Album Content
  getAlbumContent(albumId: string): Promise<AlbumContentResponse>;
  updateAlbumContent(
    albumId: string,
    request: UpdateAlbumContentRequest,
  ): Promise<AlbumContentResponse>;
}
