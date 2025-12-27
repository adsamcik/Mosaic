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
  SyncResponse,
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
    public readonly body?: string
  ) {
    super(`API Error ${status}: ${statusText}`);
    this.name = 'ApiError';
  }
}

// =============================================================================
// Request Helper
// =============================================================================

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
}

async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {} } = options;

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

    async syncAlbum(albumId: string, since: number, limit?: number): Promise<SyncResponse> {
      const params = new URLSearchParams({
        since: String(since),
      });
      if (limit !== undefined) {
        params.set('limit', String(limit));
      }
      return apiRequest(`/albums/${albumId}/sync?${params}`);
    },

    // =========================================================================
    // Members
    // =========================================================================
    async listAlbumMembers(albumId: string): Promise<AlbumMember[]> {
      return apiRequest(`/albums/${albumId}/members`);
    },

    async inviteToAlbum(albumId: string, request: InviteRequest): Promise<AlbumMember> {
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

    async createEpochKey(albumId: string, request: CreateEpochKeyRequest): Promise<EpochKeyRecord> {
      return apiRequest(`/albums/${albumId}/epoch-keys`, {
        method: 'POST',
        body: request,
      });
    },

    async rotateEpoch(albumId: string, epochId: number, request: RotateEpochRequest): Promise<void> {
      return apiRequest(`/albums/${albumId}/epochs/${epochId}/rotate`, {
        method: 'POST',
        body: request,
      });
    },

    // =========================================================================
    // Manifests
    // =========================================================================
    async createManifest(request: CreateManifestRequest): Promise<ManifestCreated> {
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
        throw new ApiError(response.status, response.statusText);
      }

      return new Uint8Array(await response.arrayBuffer());
    },

    async createShardUpload(_request: CreateShardRequest): Promise<ShardCreated> {
      // Note: Actual shard uploads use TUS protocol at /api/files
      // This method returns the upload URL for the TUS client
      return {
        id: '', // Will be set by TUS server
        uploadUrl: `${API_BASE}/files`,
      };
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
 */
export function toBase64(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data));
}

/**
 * Helper to convert base64 string to Uint8Array.
 */
export function fromBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
