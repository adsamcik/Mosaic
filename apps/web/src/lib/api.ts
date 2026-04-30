/**
 * Mosaic API Client
 *
 * Real implementation of MosaicApi for production use.
 * Communicates with the .NET backend via fetch.
 *
 * Every typed response is runtime-validated against a Zod schema declared
 * in `./api-schemas` before it leaves `apiRequest`. This is M2: a hardening
 * step against a compromised backend, MITM, or reverse-proxy bug that
 * could otherwise inject extra fields (e.g. `isAdmin: true`), drop
 * required ones, or shift types. See `./api-schemas.ts` for the rationale
 * behind permissive (non-strict) object parsing.
 */

import { z } from 'zod';

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
  UpdateManifestMetadataRequest,
  ManifestMetadataUpdated,
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
  UpdatePhotoExpirationRequest,
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
import {
  AdminAlbumLimitsSchema,
  AdminAlbumListEnvelopeSchema,
  AdminStatsResponseSchema,
  AdminUserListEnvelopeSchema,
  AdminUserQuotaSchema,
  AddShareLinkEpochKeysResponseSchema,
  AlbumContentResponseSchema,
  AlbumListSchema,
  AlbumMemberListSchema,
  AlbumMemberSchema,
  AlbumSchema,
  EpochKeyRecordListSchema,
  CreateEpochKeyResponseSchema,
  HealthResponseSchema,
  LinkAccessResponseSchema,
  LinkEpochKeyResponseListSchema,
  ManifestCreatedSchema,
  ManifestMetadataUpdatedSchema,
  ManifestRecordSchema,
  NearLimitsResponseSchema,
  QuotaDefaultsSchema,
  RenameAlbumResponseSchema,
  ShareLinkPhotoResponseListSchema,
  ShareLinkResponseListSchema,
  ShareLinkResponseSchema,
  ShareLinkWithSecretResponseListSchema,
  SyncResponseSchema,
  UpdateDescriptionResponseSchema,
  UserPublicSchema,
  UserSchema,
} from './api-schemas';
import { createLogger } from './logger';

const log = createLogger('ApiClient');

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
  /**
   * Optional Zod schema. When provided, the parsed JSON response is
   * validated against the schema and rejected (via {@link ApiError}) on
   * mismatch. See `./api-schemas.ts` for available schemas.
   *
   * Typed as `z.ZodTypeAny` rather than `z.ZodType<T>` to keep the
   * inferred-output side of Zod loosely coupled to the caller-chosen
   * generic `T`. The schema is the runtime contract; `T` is the
   * compile-time contract. They describe the same JSON shape, but Zod's
   * `.optional()` widens inferred types to `T | undefined`, which would
   * conflict with `exactOptionalPropertyTypes: true` if we tried to bind
   * them directly.
   */
  schema?: z.ZodTypeAny;
}

async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = 'GET', body, headers = {}, signal, schema } = options;

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

  const json: unknown = await response.json();

  if (schema !== undefined) {
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      // Never log the raw response body — it may contain ciphertext or
      // tokens. The Zod issues array contains paths and expected types
      // only, no values, so it's safe to log.
      log.error('API response validation failed', {
        path,
        issues: parsed.error.issues,
      });
      throw new ApiError(
        500,
        'Invalid response shape',
        JSON.stringify(parsed.error.issues),
      );
    }
    return parsed.data as T;
  }

  return json as T;
}

/**
 * Maximum page size accepted by every paginated `*List*` backend endpoint.
 * Backend caps `take` at 100; matching this minimises the number of round
 * trips when paging through a large list.
 */
const MAX_PAGE_SIZE = 100;

/**
 * Build a `?skip=&take=` query string for the paginated list endpoints.
 * Returns an empty string when both parameters are omitted so the URL stays
 * identical to the legacy single-page calls (avoids cache-busting).
 */
function paginationQuery(skip?: number, take?: number): string {
  if (skip === undefined && take === undefined) return '';
  const params = new URLSearchParams();
  if (skip !== undefined) params.set('skip', String(Math.max(0, skip)));
  if (take !== undefined) {
    params.set('take', String(Math.min(MAX_PAGE_SIZE, Math.max(1, take))));
  }
  return `?${params.toString()}`;
}

/**
 * Drain a paginated endpoint by repeatedly calling `fetchPage(skip, take)`
 * until a short page (or empty page) is returned. Used by callers that
 * need the full list (e.g. epoch rotation must seal the new key for every
 * member of the album, regardless of count).
 */
export async function paginateAll<T>(
  fetchPage: (skip: number, take: number) => Promise<T[]>,
  pageSize: number = MAX_PAGE_SIZE,
): Promise<T[]> {
  const out: T[] = [];
  for (let skip = 0; ; skip += pageSize) {
    const page = await fetchPage(skip, pageSize);
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
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
      return apiRequest('/health', { schema: HealthResponseSchema });
    },

    // =========================================================================
    // Users
    // =========================================================================
    async getCurrentUser(): Promise<User> {
      return apiRequest('/users/me', { schema: UserSchema });
    },

    async updateCurrentUser(request: UpdateUserRequest): Promise<User> {
      return apiRequest('/users/me', {
        method: 'PUT',
        body: request,
        schema: UserSchema,
      });
    },

    async updateCurrentUserWrappedKey(
      wrappedAccountKey: Uint8Array,
    ): Promise<void> {
      // PUT /users/me/wrapped-key returns 204 No Content on success, so no
      // schema is supplied — apiRequest's 204 short-circuit returns
      // undefined as T. Failures surface as ApiError with the server's
      // status/body, letting session.ts react (e.g. retry M4's TOCTOU
      // recovery) instead of the raw fetch silently failing.
      return apiRequest('/users/me/wrapped-key', {
        method: 'PUT',
        body: { wrappedAccountKey: toBase64(wrappedAccountKey) },
      });
    },

    async getUser(userId: string): Promise<UserPublic> {
      return apiRequest(`/users/${userId}`, { schema: UserPublicSchema });
    },

    async getUserByPubkey(pubkey: string): Promise<UserPublic> {
      // URL-encode the base64 pubkey
      return apiRequest(`/users/by-pubkey/${encodeURIComponent(pubkey)}`, {
        schema: UserPublicSchema,
      });
    },

    // =========================================================================
    // Albums
    // =========================================================================
    async listAlbums(skip?: number, take?: number): Promise<Album[]> {
      return apiRequest(`/albums${paginationQuery(skip, take)}`, {
        schema: AlbumListSchema,
      });
    },

    async createAlbum(request: CreateAlbumRequest): Promise<Album> {
      return apiRequest('/albums', {
        method: 'POST',
        body: request,
        schema: AlbumSchema,
      });
    },

    async getAlbum(albumId: string): Promise<Album> {
      return apiRequest(`/albums/${albumId}`, { schema: AlbumSchema });
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
        schema: RenameAlbumResponseSchema,
      });
    },

    async updateAlbumDescription(
      albumId: string,
      request: UpdateDescriptionRequest,
    ): Promise<UpdateDescriptionResponse> {
      return apiRequest(`/albums/${albumId}/description`, {
        method: 'PATCH',
        body: request,
        schema: UpdateDescriptionResponseSchema,
      });
    },

    async updateAlbumExpiration(
      albumId: string,
      request: UpdateExpirationRequest,
    ): Promise<Album> {
      return apiRequest(`/albums/${albumId}/expiration`, {
        method: 'PATCH',
        body: request,
        schema: AlbumSchema,
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
      const requestOptions: RequestOptions = { schema: SyncResponseSchema };
      if (signal !== undefined) {
        requestOptions.signal = signal;
      }

      return apiRequest(`/albums/${albumId}/sync?${params}`, requestOptions);
    },

    // =========================================================================
    // Album Content
    // =========================================================================
    async getAlbumContent(albumId: string): Promise<AlbumContentResponse> {
      return apiRequest(`/albums/${albumId}/content`, {
        schema: AlbumContentResponseSchema,
      });
    },

    async updateAlbumContent(
      albumId: string,
      request: UpdateAlbumContentRequest,
    ): Promise<AlbumContentResponse> {
      return apiRequest(`/albums/${albumId}/content`, {
        method: 'PUT',
        body: request,
        schema: AlbumContentResponseSchema,
      });
    },

    // =========================================================================
    // Members
    // =========================================================================
    async listAlbumMembers(
      albumId: string,
      skip?: number,
      take?: number,
    ): Promise<AlbumMember[]> {
      return apiRequest(
        `/albums/${albumId}/members${paginationQuery(skip, take)}`,
        { schema: AlbumMemberListSchema },
      );
    },

    async inviteToAlbum(
      albumId: string,
      request: InviteRequest,
    ): Promise<AlbumMember> {
      return apiRequest(`/albums/${albumId}/members`, {
        method: 'POST',
        body: request,
        schema: AlbumMemberSchema,
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
      return apiRequest(`/albums/${albumId}/epoch-keys`, {
        schema: EpochKeyRecordListSchema,
      });
    },

    async createEpochKey(
      albumId: string,
      request: CreateEpochKeyRequest,
    ): Promise<EpochKeyRecord> {
      // Backend POST /albums/{id}/epoch-keys returns only metadata (id,
      // albumId, recipientId, epochId, createdAt) — see
      // EpochKeysController.Create. Validate against the slim
      // CreateEpochKeyResponseSchema, then expand into the EpochKeyRecord
      // shape callers expect by echoing back the bundle/signatures the
      // client already had in the request.
      const created = await apiRequest<{
        id: string;
        albumId: string;
        recipientId: string;
        epochId: number;
        createdAt: string;
      }>(`/albums/${albumId}/epoch-keys`, {
        method: 'POST',
        body: request,
        schema: CreateEpochKeyResponseSchema,
      });
      return {
        id: created.id,
        albumId: created.albumId,
        epochId: created.epochId,
        encryptedKeyBundle: request.encryptedKeyBundle,
        ownerSignature: request.ownerSignature,
        sharerPubkey: request.sharerPubkey,
        signPubkey: request.signPubkey,
        createdAt: created.createdAt,
      };
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
        schema: ManifestCreatedSchema,
      });
    },

    async getManifest(manifestId: string): Promise<ManifestRecord> {
      return apiRequest(`/manifests/${manifestId}`, {
        schema: ManifestRecordSchema,
      });
    },

    async updateManifestMetadata(
      manifestId: string,
      request: UpdateManifestMetadataRequest,
    ): Promise<ManifestMetadataUpdated> {
      return apiRequest(`/manifests/${manifestId}/metadata`, {
        method: 'PATCH',
        body: request,
        schema: ManifestMetadataUpdatedSchema,
      });
    },

    async deleteManifest(manifestId: string): Promise<void> {
      return apiRequest(`/manifests/${manifestId}`, {
        method: 'DELETE',
      });
    },

    async updatePhotoExpiration(
      manifestId: string,
      request: UpdatePhotoExpirationRequest,
    ): Promise<void> {
      return apiRequest(`/manifests/${manifestId}/expiration`, {
        method: 'PATCH',
        body: request,
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
    async listShareLinks(
      albumId: string,
      skip?: number,
      take?: number,
    ): Promise<ShareLinkResponse[]> {
      return apiRequest(
        `/albums/${albumId}/share-links${paginationQuery(skip, take)}`,
        { schema: ShareLinkResponseListSchema },
      );
    },

    async listShareLinksWithSecrets(
      albumId: string,
      skip?: number,
      take?: number,
    ): Promise<ShareLinkWithSecretResponse[]> {
      return apiRequest(
        `/albums/${albumId}/share-links/with-secrets${paginationQuery(skip, take)}`,
        { schema: ShareLinkWithSecretResponseListSchema },
      );
    },

    async createShareLink(
      albumId: string,
      request: CreateShareLinkRequest,
    ): Promise<ShareLinkResponse> {
      return apiRequest(`/albums/${albumId}/share-links`, {
        method: 'POST',
        body: request,
        schema: ShareLinkResponseSchema,
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
        schema: AddShareLinkEpochKeysResponseSchema,
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
        schema: ShareLinkResponseSchema,
      });
    },

    // =========================================================================
    // Anonymous Share Link Access (no auth required)
    // =========================================================================
    async getShareLinkInfo(linkIdBase64: string): Promise<LinkAccessResponse> {
      return apiRequest(`/s/${encodeURIComponent(linkIdBase64)}`, {
        schema: LinkAccessResponseSchema,
      });
    },

    async getShareLinkKeys(
      linkIdBase64: string,
    ): Promise<LinkEpochKeyResponse[]> {
      return apiRequest(`/s/${encodeURIComponent(linkIdBase64)}/keys`, {
        schema: LinkEpochKeyResponseListSchema,
      });
    },

    async getShareLinkPhotos(
      linkIdBase64: string,
      skip?: number,
      take?: number,
    ): Promise<ShareLinkPhotoResponse[]> {
      return apiRequest(
        `/s/${encodeURIComponent(linkIdBase64)}/photos${paginationQuery(skip, take)}`,
        { schema: ShareLinkPhotoResponseListSchema },
      );
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
      return apiRequest('/admin/settings/quota', {
        schema: QuotaDefaultsSchema,
      });
    },

    async updateQuotaDefaults(request: QuotaDefaults): Promise<QuotaDefaults> {
      return apiRequest('/admin/settings/quota', {
        method: 'PUT',
        body: request,
        schema: QuotaDefaultsSchema,
      });
    },

    // =========================================================================
    // Admin - Users
    // =========================================================================
    async listUsers(skip?: number, take?: number): Promise<AdminUserResponse[]> {
      const wrapped = await apiRequest<{ users: AdminUserResponse[] }>(
        `/admin/users${paginationQuery(skip, take)}`,
        { schema: AdminUserListEnvelopeSchema },
      );
      return wrapped.users;
    },

    async getUserQuota(userId: string): Promise<AdminUserQuota> {
      return apiRequest(`/admin/users/${userId}/quota`, {
        schema: AdminUserQuotaSchema,
      });
    },

    async updateUserQuota(
      userId: string,
      request: UpdateUserQuotaRequest,
    ): Promise<AdminUserQuota> {
      return apiRequest(`/admin/users/${userId}/quota`, {
        method: 'PUT',
        body: request,
        schema: AdminUserQuotaSchema,
      });
    },

    async resetUserQuota(userId: string): Promise<AdminUserQuota> {
      return apiRequest(`/admin/users/${userId}/quota`, {
        method: 'DELETE',
        schema: AdminUserQuotaSchema,
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
    async listAllAlbums(
      skip?: number,
      take?: number,
    ): Promise<AdminAlbumResponse[]> {
      const wrapped = await apiRequest<{ albums: AdminAlbumResponse[] }>(
        `/admin/albums${paginationQuery(skip, take)}`,
        { schema: AdminAlbumListEnvelopeSchema },
      );
      return wrapped.albums;
    },

    async getAlbumLimits(albumId: string): Promise<AdminAlbumLimits> {
      return apiRequest(`/admin/albums/${albumId}/limits`, {
        schema: AdminAlbumLimitsSchema,
      });
    },

    async updateAlbumLimits(
      albumId: string,
      request: UpdateAlbumLimitsRequest,
    ): Promise<AdminAlbumLimits> {
      return apiRequest(`/admin/albums/${albumId}/limits`, {
        method: 'PUT',
        body: request,
        schema: AdminAlbumLimitsSchema,
      });
    },

    async resetAlbumLimits(albumId: string): Promise<AdminAlbumLimits> {
      return apiRequest(`/admin/albums/${albumId}/limits`, {
        method: 'DELETE',
        schema: AdminAlbumLimitsSchema,
      });
    },

    // =========================================================================
    // Admin - Stats
    // =========================================================================
    async getStats(): Promise<AdminStatsResponse> {
      return apiRequest('/admin/stats', { schema: AdminStatsResponseSchema });
    },

    async getNearLimits(): Promise<NearLimitsResponse> {
      return apiRequest('/admin/stats/near-limits', {
        schema: NearLimitsResponseSchema,
      });
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
