/**
 * Mosaic API Mock Implementation
 *
 * Mock implementation of MosaicApi for parallel frontend development.
 * Returns realistic fake data for testing UI components.
 *
 * WARNING: This is NOT a real API client. Use only for development.
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
// Mock Data Store
// =============================================================================

interface MockStore {
  currentUser: User;
  users: Map<string, User>;
  albums: Map<string, Album>;
  members: Map<string, AlbumMember[]>;
  epochKeys: Map<string, EpochKeyRecord[]>;
  manifests: Map<string, ManifestRecord>;
  shards: Map<string, Uint8Array>;
}

function createMockStore(): MockStore {
  const currentUserId = 'user-00000000-0000-0000-0000-000000000001';

  const currentUser: User = {
    id: currentUserId,
    authSub: 'user@example.com',
    identityPubkey: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))),
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  };

  const users = new Map<string, User>([
    [currentUserId, currentUser],
    [
      'user-00000000-0000-0000-0000-000000000002',
      {
        id: 'user-00000000-0000-0000-0000-000000000002',
        authSub: 'alice@example.com',
        identityPubkey: btoa(String.fromCharCode(...new Uint8Array(32).fill(2))),
        createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ],
    [
      'user-00000000-0000-0000-0000-000000000003',
      {
        id: 'user-00000000-0000-0000-0000-000000000003',
        authSub: 'bob@example.com',
        identityPubkey: btoa(String.fromCharCode(...new Uint8Array(32).fill(3))),
        createdAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ],
  ]);

  // Create mock albums
  const albums = new Map<string, Album>([
    [
      'album-00000000-0000-0000-0000-000000000001',
      {
        id: 'album-00000000-0000-0000-0000-000000000001',
        ownerId: currentUserId,
        currentVersion: 42,
        currentEpochId: 1,
        createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    [
      'album-00000000-0000-0000-0000-000000000002',
      {
        id: 'album-00000000-0000-0000-0000-000000000002',
        ownerId: 'user-00000000-0000-0000-0000-000000000002',
        currentVersion: 128,
        currentEpochId: 2,
        createdAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ],
  ]);

  // Create mock members
  const members = new Map<string, AlbumMember[]>([
    [
      'album-00000000-0000-0000-0000-000000000001',
      [
        {
          userId: currentUserId,
          role: 'owner',
          joinedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        },
        {
          userId: 'user-00000000-0000-0000-0000-000000000002',
          role: 'editor',
          invitedBy: currentUserId,
          joinedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
    ],
    [
      'album-00000000-0000-0000-0000-000000000002',
      [
        {
          userId: 'user-00000000-0000-0000-0000-000000000002',
          role: 'owner',
          joinedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
        },
        {
          userId: currentUserId,
          role: 'viewer',
          invitedBy: 'user-00000000-0000-0000-0000-000000000002',
          joinedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
    ],
  ]);

  return {
    currentUser,
    users,
    albums,
    members,
    epochKeys: new Map(),
    manifests: new Map(),
    shards: new Map(),
  };
}

// =============================================================================
// Mock API Implementation
// =============================================================================

/**
 * Create a mock API client with simulated latency.
 */
export function createMockApi(latencyMs: number = 100): MosaicApi {
  const store = createMockStore();

  const delay = () => new Promise((r) => setTimeout(r, latencyMs));

  const generateUuid = () =>
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });

  return {
    // =========================================================================
    // Health
    // =========================================================================
    async getHealth(): Promise<HealthResponse> {
      await delay();
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0-mock',
        checks: {
          database: 'ok',
          storage: 'ok',
        },
      };
    },

    // =========================================================================
    // Users
    // =========================================================================
    async getCurrentUser(): Promise<User> {
      await delay();
      return { ...store.currentUser };
    },

    async updateCurrentUser(request: UpdateUserRequest): Promise<User> {
      await delay();
      if (request.identityPubkey) {
        store.currentUser.identityPubkey = request.identityPubkey;
      }
      return { ...store.currentUser };
    },

    async getUser(userId: string): Promise<UserPublic> {
      await delay();
      const user = store.users.get(userId);
      if (!user) {
        throw new Error(`User not found: ${userId}`);
      }
      return {
        id: user.id,
        identityPubkey: user.identityPubkey || '',
      };
    },

    async getUserByPubkey(pubkey: string): Promise<UserPublic> {
      await delay();
      for (const user of store.users.values()) {
        if (user.identityPubkey === pubkey) {
          return {
            id: user.id,
            identityPubkey: user.identityPubkey || '',
          };
        }
      }
      throw new Error(`User not found with pubkey`);
    },

    // =========================================================================
    // Albums
    // =========================================================================
    async listAlbums(): Promise<Album[]> {
      await delay();
      // Return albums where user is a member
      const result: Album[] = [];
      for (const [albumId, memberList] of store.members) {
        if (memberList.some((m) => m.userId === store.currentUser.id)) {
          const album = store.albums.get(albumId);
          if (album) {
            result.push({ ...album });
          }
        }
      }
      return result;
    },

    async createAlbum(request: CreateAlbumRequest): Promise<Album> {
      await delay();
      const id = `album-${generateUuid()}`;
      const album: Album = {
        id,
        ownerId: store.currentUser.id,
        currentVersion: 1,
        currentEpochId: request.initialEpochKey.epochId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.albums.set(id, album);
      store.members.set(id, [
        {
          userId: store.currentUser.id,
          role: 'owner',
          joinedAt: album.createdAt,
        },
      ]);
      return { ...album };
    },

    async getAlbum(albumId: string): Promise<Album> {
      await delay();
      const album = store.albums.get(albumId);
      if (!album) {
        throw new Error(`Album not found: ${albumId}`);
      }
      return { ...album };
    },

    async deleteAlbum(albumId: string): Promise<void> {
      await delay();
      const album = store.albums.get(albumId);
      if (!album) {
        throw new Error(`Album not found: ${albumId}`);
      }
      if (album.ownerId !== store.currentUser.id) {
        throw new Error('Forbidden: not album owner');
      }
      store.albums.delete(albumId);
      store.members.delete(albumId);
      store.epochKeys.delete(albumId);
    },

    async syncAlbum(
      albumId: string,
      since: number,
      limit: number = 100
    ): Promise<SyncResponse> {
      await delay();
      const album = store.albums.get(albumId);
      if (!album) {
        throw new Error(`Album not found: ${albumId}`);
      }

      // Generate mock manifests
      const manifests: ManifestRecord[] = [];
      const count = Math.min(limit, Math.max(0, album.currentVersion - since));

      for (let i = 0; i < count; i++) {
        const version = since + i + 1;
        manifests.push({
          id: `manifest-${albumId}-${version}`,
          albumId,
          versionCreated: version,
          isDeleted: false,
          encryptedMeta: btoa(`mock-encrypted-meta-${version}`),
          signature: btoa(`mock-signature-${version}`),
          signerPubkey: btoa(`mock-pubkey-${version}`),
          shardIds: [
            `shard-${version}-0`,
            `shard-${version}-1`,
          ],
          createdAt: new Date(
            Date.now() - (album.currentVersion - version) * 60 * 60 * 1000
          ).toISOString(),
        });
      }

      return {
        manifests,
        albumVersion: album.currentVersion,
        hasMore: since + count < album.currentVersion,
      };
    },

    // =========================================================================
    // Members
    // =========================================================================
    async listAlbumMembers(albumId: string): Promise<AlbumMember[]> {
      await delay();
      const memberList = store.members.get(albumId);
      if (!memberList) {
        throw new Error(`Album not found: ${albumId}`);
      }
      return memberList.map((m) => ({ ...m }));
    },

    async inviteToAlbum(
      albumId: string,
      request: InviteRequest
    ): Promise<AlbumMember> {
      await delay();
      const memberList = store.members.get(albumId);
      if (!memberList) {
        throw new Error(`Album not found: ${albumId}`);
      }

      const newMember: AlbumMember = {
        userId: request.recipientId,
        role: request.role,
        invitedBy: store.currentUser.id,
        joinedAt: new Date().toISOString(),
      };
      memberList.push(newMember);
      return { ...newMember };
    },

    async removeAlbumMember(albumId: string, userId: string): Promise<void> {
      await delay();
      const memberList = store.members.get(albumId);
      if (!memberList) {
        throw new Error(`Album not found: ${albumId}`);
      }
      const index = memberList.findIndex((m) => m.userId === userId);
      if (index < 0) {
        throw new Error(`Member not found: ${userId}`);
      }
      memberList.splice(index, 1);
    },

    // =========================================================================
    // Epoch Keys
    // =========================================================================
    async getEpochKeys(albumId: string): Promise<EpochKeyRecord[]> {
      await delay();
      const keys = store.epochKeys.get(albumId) || [];
      return keys
        .filter((k) => k.albumId === albumId)
        .map((k) => ({ ...k }));
    },

    async createEpochKey(
      albumId: string,
      request: CreateEpochKeyRequest
    ): Promise<EpochKeyRecord> {
      await delay();
      const id = `epoch-key-${generateUuid()}`;
      const record: EpochKeyRecord = {
        id,
        albumId,
        epochId: request.epochId,
        encryptedKeyBundle: request.encryptedKeyBundle,
        ownerSignature: request.ownerSignature,
        sharerPubkey: request.sharerPubkey,
        signPubkey: request.signPubkey,
        createdAt: new Date().toISOString(),
      };

      const keys = store.epochKeys.get(albumId) || [];
      keys.push(record);
      store.epochKeys.set(albumId, keys);

      return { ...record };
    },

    async rotateEpoch(
      albumId: string,
      epochId: number,
      request: RotateEpochRequest
    ): Promise<void> {
      await delay();
      const album = store.albums.get(albumId);
      if (!album) {
        throw new Error(`Album not found: ${albumId}`);
      }
      album.currentEpochId = epochId;
      album.updatedAt = new Date().toISOString();

      const keys = store.epochKeys.get(albumId) || [];
      for (const req of request.epochKeys) {
        keys.push({
          id: `epoch-key-${generateUuid()}`,
          albumId,
          epochId: req.epochId,
          encryptedKeyBundle: req.encryptedKeyBundle,
          ownerSignature: req.ownerSignature,
          sharerPubkey: req.sharerPubkey,
          signPubkey: req.signPubkey,
          createdAt: new Date().toISOString(),
        });
      }
      store.epochKeys.set(albumId, keys);
    },

    // =========================================================================
    // Manifests
    // =========================================================================
    async createManifest(
      request: CreateManifestRequest
    ): Promise<ManifestCreated> {
      await delay();
      const album = store.albums.get(request.albumId);
      if (!album) {
        throw new Error(`Album not found: ${request.albumId}`);
      }

      album.currentVersion++;
      album.updatedAt = new Date().toISOString();

      const id = `manifest-${generateUuid()}`;
      const manifest: ManifestRecord = {
        id,
        albumId: request.albumId,
        versionCreated: album.currentVersion,
        isDeleted: false,
        encryptedMeta: request.encryptedMeta,
        signature: request.signature,
        signerPubkey: request.signerPubkey,
        shardIds: request.shardIds,
        createdAt: new Date().toISOString(),
      };
      store.manifests.set(id, manifest);

      return {
        id,
        version: album.currentVersion,
      };
    },

    async getManifest(manifestId: string): Promise<ManifestRecord> {
      await delay();
      const manifest = store.manifests.get(manifestId);
      if (!manifest) {
        throw new Error(`Manifest not found: ${manifestId}`);
      }
      return { ...manifest };
    },

    async deleteManifest(manifestId: string): Promise<void> {
      await delay();
      const manifest = store.manifests.get(manifestId);
      if (!manifest) {
        throw new Error(`Manifest not found: ${manifestId}`);
      }
      manifest.isDeleted = true;
      manifest.updatedAt = new Date().toISOString();
    },

    // =========================================================================
    // Shards
    // =========================================================================
    async downloadShard(shardId: string): Promise<Uint8Array> {
      await delay();
      const shard = store.shards.get(shardId);
      if (shard) {
        return new Uint8Array(shard);
      }
      // Generate mock shard data
      const mockData = new Uint8Array(1024);
      for (let i = 0; i < mockData.length; i++) {
        mockData[i] = Math.floor(Math.random() * 256);
      }
      return mockData;
    },

    async createShardUpload(_request: CreateShardRequest): Promise<ShardCreated> {
      await delay();
      const id = `shard-${generateUuid()}`;
      return {
        id,
        uploadUrl: `/api/shards/${id}/upload`,
      };
    },
  };
}

/**
 * Default mock API instance with 100ms latency.
 */
export const mockApi = createMockApi(100);

export default mockApi;
