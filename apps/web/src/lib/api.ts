/**
 * Mosaic API Client
 *
 * Real implementation of MosaicApi for production use.
 * Communicates with the .NET backend via fetch.
 */

import type {
  MosaicApi,
  HealthResponse,
  User,
  UserPublic,
  UpdateUserRequest,
  Album,
  CreateAlbumRequest,
  RenameAlbumRequest,
  RenameAlbumResponse,
  UpdateDescriptionRequest,
  UpdateDescriptionResponse,
  AlbumContentResponse,
  UpdateAlbumContentRequest,
  SyncResponse,
  SyncAlbumOptions,
  AlbumMember,
  InviteRequest,
  EpochKeyRecord,
  CreateEpochKeyRequest,
  RotateEpochRequest,
  ManifestRecord,
  CreateManifestRequest,
  ManifestCreated,
  CreateShardRequest,
  ShardCreated,
  ShareLinkResponse,
  ShareLinkWithSecretResponse,
  CreateShareLinkRequest,
  AddShareLinkEpochKeysRequest,
  LinkAccessResponse,
  LinkEpochKeyResponse,
  ShareLinkPhotoResponse,
  UpdateExpirationRequest,
  UpdateLinkExpirationRequest,
  QuotaDefaults,
  AdminUserResponse,
  AdminUserQuota,
  UpdateUserQuotaRequest,
  AdminAlbumResponse,
  AdminAlbumLimits,
  UpdateAlbumLimitsRequest,
  AdminStatsResponse,
  NearLimitsResponse,
} from './api-types';

// =============================================================================
// API Configuration
// =============================================================================

const API_BASE = '/api';

// =============================================================================
// Error Handling
// =============================================================================

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body?: string,
  ) {
    super(`API Error ${status}: ${statusText}`);
    this.name = 'ApiError';
  }
}

// =============================================================================
// Request Helper
// =============================================================================

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = 'GET', body, headers = {}, signal } = options;

  const requestHeaders: Record<string, string> = {
    ...headers,
  };

  // Only add Content-Type for requests with body
  if (body !== undefined) {
    requestHeaders['Content-Type'] = 'application/json';
  }

  const init: RequestInit = {
    method,
    headers: requestHeaders,
    credentials: 'same-origin',
  };

  if (signal !== undefined) {
    init.signal = signal;
  }

  // Only add body if it's defined
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const response = await fetch(`${API_BASE}${path}`, init);

  if (!response.ok) {
    const errorBody = await response.text().catch(() => undefined);
    throw new ApiError(response.status, response.statusText, errorBody);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

// =============================================================================
// API Client Implementation
// =============================================================================

/**
 * Create a real API client connected to the backend.
 */
export function createApiClient(): MosaicApi {
  return {
    // =========================================================================
    // Health
    // =========================================================================
    async getHealth(): Promise<HealthResponse> {
      return apiRequest('/health');
    },

    // =========================================================================
    // Users
    // =========================================================================
    async getCurrentUser(): Promise<User> {
      return apiRequest('/users/me');
    },

    async updateCurrentUser(request: UpdateUserRequest): Promise<User> {
      return apiRequest('/users/me', {
        method: 'PUT',
        body: request,
      });
    },

    async getUser(userId: string): Promise<UserPublic> {
      return apiRequest(`/users/${userId}`);
    },

    async getUserByPubkey(pubkey: string): Promise<UserPublic> {
      // URL-encode the base64 pubkey
      return apiRequest(`/users/by-pubkey/${encodeURIComponent(pubkey)}`);
    },

    // =========================================================================
    // Albums
    // =========================================================================
    async listAlbums(): Promise<Album[]> {
      return apiRequest('/albums');
    },

    async createAlbum(request: CreateAlbumRequest): Promise<Album> {
      return apiRequest('/albums', {
        method: 'POST',
        body: request,
      });
    },

    async getAlbum(albumId: string): Promise<Album> {
      return apiRequest(`/albums/${albumId}`);
    },

    async deleteAlbum(albumId: string): Promise<void> {
      return apiRequest(`/albums/${albumId}`, {
        method: 'DELETE',
      });
    },

    async renameAlbum(
      albumId: string,
      request: RenameAlbumRequest,
    ): Promise<RenameAlbumResponse> {
      return apiRequest(`/albums/${albumId}/name`, {
        method: 'PATCH',
        body: request,
      });
    },

    async updateAlbumDescription(
      albumId: string,
      request: UpdateDescriptionRequest,
    ): Promise<UpdateDescriptionResponse> {
      return apiRequest(`/albums/${albumId}/description`, {
        method: 'PATCH',
        body: request,
      });
    },

    async updateAlbumExpiration(
      albumId: string,
      request: UpdateExpirationRequest,
    ): Promise<Album> {
      return apiRequest(`/albums/${albumId}/expiration`, {
        method: 'PATCH',
        body: request,
      });
    },

    async syncAlbum(
      albumId: string,
      since: number,
      options: SyncAlbumOptions = {},
    ): Promise<SyncResponse> {
      const { limit, signal } = options;
      const params = new URLSearchParams({
        since: String(since),
      });
      if (limit !== undefined) {
        params.set('limit', String(limit));
      }
      const requestOptions: RequestOptions = {};
      if (signal !== undefined) {
        requestOptions.signal = signal;
      }

      return apiRequest(`/albums/${albumId}/sync?${params}`, requestOptions);
    },

    // =========================================================================
    // Album Content
    // =========================================================================
    async getAlbumContent(albumId: string): Promise<AlbumContentResponse> {
      return apiRequest(`/albums/${albumId}/content`);
    },

    async updateAlbumContent(
      albumId: string,
      request: UpdateAlbumContentRequest,
    ): Promise<AlbumContentResponse> {
      return apiRequest(`/albums/${albumId}/content`, {
        method: 'PUT',
        body: request,
      });
    },

    // =========================================================================
    // Members
    // =========================================================================
    async listAlbumMembers(albumId: string): Promise<AlbumMember[]> {
      return apiRequest(`/albums/${albumId}/members`);
    },

    async inviteToAlbum(
      albumId: string,
      request: InviteRequest,
    ): Promise<AlbumMember> {
      return apiRequest(`/albums/${albumId}/members`, {
        method: 'POST',
        body: request,
      });
    },

    async removeAlbumMember(albumId: string, userId: string): Promise<void> {
      return apiRequest(`/albums/${albumId}/members/${userId}`, {
        method: 'DELETE',
      });
    },

    // =========================================================================
    // Epoch Keys
    // =========================================================================
    async getEpochKeys(albumId: string): Promise<EpochKeyRecord[]> {
      return apiRequest(`/albums/${albumId}/epoch-keys`);
    },

    async createEpochKey(
      albumId: string,
      request: CreateEpochKeyRequest,
    ): Promise<EpochKeyRecord> {
      return apiRequest(`/albums/${albumId}/epoch-keys`, {
        method: 'POST',
        body: request,
      });
    },

    async rotateEpoch(
      albumId: string,
      epochId: number,
      request: RotateEpochRequest,
    ): Promise<void> {
      return apiRequest(`/albums/${albumId}/epochs/${epochId}/rotate`, {
        method: 'POST',
        body: request,
      });
    },

    // =========================================================================
    // Manifests
    // =========================================================================
    async createManifest(
      request: CreateManifestRequest,
    ): Promise<ManifestCreated> {
      return apiRequest('/manifests', {
        method: 'POST',
        body: request,
      });
    },

    async getManifest(manifestId: string): Promise<ManifestRecord> {
      return apiRequest(`/manifests/${manifestId}`);
    },

    async deleteManifest(manifestId: string): Promise<void> {
      return apiRequest(`/manifests/${manifestId}`, {
        method: 'DELETE',
      });
    },

    // =========================================================================
    // Shards
    // =========================================================================
    async downloadShard(shardId: string): Promise<Uint8Array> {
      const response = await fetch(`${API_BASE}/shards/${shardId}`, {
        credentials: 'same-origin',
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => undefined);
        throw new ApiError(response.status, response.statusText, errorBody);
      }

      return new Uint8Array(await response.arrayBuffer());
    },

    async createShardUpload(
      _request: CreateShardRequest,
    ): Promise<ShardCreated> {
      // Note: Actual shard uploads use TUS protocol at /api/files
      // This method returns the upload URL for the TUS client
      return {
        id: '', // Will be set by TUS server
        uploadUrl: `${API_BASE}/files`,
      };
    },

    // =========================================================================
    // Share Links
    // =========================================================================
    async listShareLinks(albumId: string): Promise<ShareLinkResponse[]> {
      return apiRequest(`/albums/${albumId}/share-links`);
    },

    async listShareLinksWithSecrets(
      albumId: string,
    ): Promise<ShareLinkWithSecretResponse[]> {
      return apiRequest(`/albums/${albumId}/share-links/with-secrets`);
    },

    async createShareLink(
      albumId: string,
      request: CreateShareLinkRequest,
    ): Promise<ShareLinkResponse> {
      return apiRequest(`/albums/${albumId}/share-links`, {
        method: 'POST',
        body: request,
      });
    },

    async revokeShareLink(linkId: string): Promise<void> {
      return apiRequest(`/share-links/${linkId}`, {
        method: 'DELETE',
      });
    },

    async addShareLinkEpochKeys(
      linkId: string,
      request: AddShareLinkEpochKeysRequest,
    ): Promise<{ added: number; updated: number }> {
      return apiRequest(`/share-links/${linkId}/keys`, {
        method: 'POST',
        body: request,
      });
    },

    async updateShareLinkExpiration(
      albumId: string,
      linkId: string,
      request: UpdateLinkExpirationRequest,
    ): Promise<ShareLinkResponse> {
      return apiRequest(`/albums/${albumId}/share-links/${linkId}/expiration`, {
        method: 'PUT',
        body: request,
      });
    },

    // =========================================================================
    // Anonymous Share Link Access (no auth required)
    // =========================================================================
    async getShareLinkInfo(linkIdBase64: string): Promise<LinkAccessResponse> {
      return apiRequest(`/s/${encodeURIComponent(linkIdBase64)}`);
    },

    async getShareLinkKeys(
      linkIdBase64: string,
    ): Promise<LinkEpochKeyResponse[]> {
      return apiRequest(`/s/${encodeURIComponent(linkIdBase64)}/keys`);
    },

    async getShareLinkPhotos(
      linkIdBase64: string,
    ): Promise<ShareLinkPhotoResponse[]> {
      return apiRequest(`/s/${encodeURIComponent(linkIdBase64)}/photos`);
    },

    async getShareLinkShard(
      linkIdBase64: string,
      shardId: string,
    ): Promise<ArrayBuffer> {
      const response = await fetch(
        `${API_BASE}/s/${encodeURIComponent(linkIdBase64)}/shards/${encodeURIComponent(shardId)}`,
      );
      if (!response.ok) {
        const errorBody = await response.text().catch(() => undefined);
        throw new ApiError(response.status, response.statusText, errorBody);
      }
      return response.arrayBuffer();
    },

    // =========================================================================
    // Admin - Settings
    // =========================================================================
    async getQuotaDefaults(): Promise<QuotaDefaults> {
      return apiRequest('/admin/settings/quota');
    },

    async updateQuotaDefaults(request: QuotaDefaults): Promise<QuotaDefaults> {
      return apiRequest('/admin/settings/quota', {
        method: 'PUT',
        body: request,
      });
    },

    // =========================================================================
    // Admin - Users
    // =========================================================================
    async listUsers(): Promise<AdminUserResponse[]> {
      return apiRequest('/admin/users');
    },

    async getUserQuota(userId: string): Promise<AdminUserQuota> {
      return apiRequest(`/admin/users/${userId}/quota`);
    },

    async updateUserQuota(
      userId: string,
      request: UpdateUserQuotaRequest,
    ): Promise<AdminUserQuota> {
      return apiRequest(`/admin/users/${userId}/quota`, {
        method: 'PUT',
        body: request,
      });
    },

    async resetUserQuota(userId: string): Promise<AdminUserQuota> {
      return apiRequest(`/admin/users/${userId}/quota`, {
        method: 'DELETE',
      });
    },

    async promoteToAdmin(userId: string): Promise<void> {
      return apiRequest(`/admin/users/${userId}/promote`, {
        method: 'POST',
      });
    },

    async demoteFromAdmin(userId: string): Promise<void> {
      return apiRequest(`/admin/users/${userId}/demote`, {
        method: 'POST',
      });
    },

    // =========================================================================
    // Admin - Albums
    // =========================================================================
    async listAllAlbums(): Promise<AdminAlbumResponse[]> {
      return apiRequest('/admin/albums');
    },

    async getAlbumLimits(albumId: string): Promise<AdminAlbumLimits> {
      return apiRequest(`/admin/albums/${albumId}/limits`);
    },

    async updateAlbumLimits(
      albumId: string,
      request: UpdateAlbumLimitsRequest,
    ): Promise<AdminAlbumLimits> {
      return apiRequest(`/admin/albums/${albumId}/limits`, {
        method: 'PUT',
        body: request,
      });
    },

    async resetAlbumLimits(albumId: string): Promise<AdminAlbumLimits> {
      return apiRequest(`/admin/albums/${albumId}/limits`, {
        method: 'DELETE',
      });
    },

    // =========================================================================
    // Admin - Stats
    // =========================================================================
    async getStats(): Promise<AdminStatsResponse> {
      return apiRequest('/admin/stats');
    },

    async getNearLimits(): Promise<NearLimitsResponse> {
      return apiRequest('/admin/stats/near-limits');
    },
  };
}

// =============================================================================
// Singleton Instance
// =============================================================================

let apiInstance: MosaicApi | null = null;

/**
 * Get the singleton API client instance.
 */
export function getApi(): MosaicApi {
  if (!apiInstance) {
    apiInstance = createApiClient();
  }
  return apiInstance;
}

/**
 * TUS upload endpoint for resumable uploads.
 */
export const TUS_ENDPOINT = `${API_BASE}/files`;

/**
 * Helper to convert Uint8Array to base64 string for JSON serialization.
 * Uses chunked processing to avoid call stack overflow for large arrays.
 */
export function toBase64(data: Uint8Array): string {
  // For large arrays, we need to chunk to avoid call stack overflow
  const CHUNK_SIZE = 8192;
  if (data.length <= CHUNK_SIZE) {
    return btoa(String.fromCharCode(...data));
  }

  // Process in chunks
  let binary = '';
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    const chunk = data.subarray(i, Math.min(i + CHUNK_SIZE, data.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * Helper to convert base64 string to Uint8Array.
 */
export function fromBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
