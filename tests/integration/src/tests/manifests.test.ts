/**
 * Manifests API Tests
 *
 * Tests for photo manifest management.
 * Note: Manifest creation requires actual shard uploads via TUS protocol,
 * which is complex for integration tests. These tests focus on basic API
 * behavior that can be tested without full upload flow.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { api, User } from '../api-client';
import { waitForApi, uniqueUser, createTestAlbum, randomBase64 } from '../utils';

describe('Manifests API', () => {
  let owner: string;

  beforeAll(async () => {
    await waitForApi(api);
  });

  beforeEach(async () => {
    owner = uniqueUser('owner');

    // Initialize owner with a pubkey
    api.setUser(owner);
    await api.put<User>('/api/users/me', {
      identityPubkey: randomBase64(32),
    });
  });

  describe('POST /api/manifests', () => {
    it('returns 400 when shards not found', async () => {
      const album = await createTestAlbum(api, owner);

      // Try to create manifest with non-existent shard IDs
      const response = await api.post('/api/manifests', {
        albumId: album.id,
        encryptedMeta: randomBase64(256),
        signature: randomBase64(64),
        signerPubkey: randomBase64(32),
        shardIds: ['00000000-0000-0000-0000-000000000001'],
      });

      // Should fail because shards don't exist
      expect(response.status).toBe(400);
    });

    it('returns 403 for non-member', async () => {
      const album = await createTestAlbum(api, owner);

      api.setUser(uniqueUser());
      const response = await api.post('/api/manifests', {
        albumId: album.id,
        encryptedMeta: randomBase64(256),
        signature: randomBase64(64),
        signerPubkey: randomBase64(32),
        shardIds: ['00000000-0000-0000-0000-000000000001'],
      });

      // Non-member should be forbidden
      expect(response.status).toBe(403);
    });

    it('returns 404 for non-existent album', async () => {
      api.setUser(owner);
      const response = await api.post('/api/manifests', {
        albumId: '00000000-0000-0000-0000-000000000000',
        encryptedMeta: randomBase64(256),
        signature: randomBase64(64),
        signerPubkey: randomBase64(32),
        shardIds: ['00000000-0000-0000-0000-000000000001'],
      });

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/manifests/:manifestId', () => {
    it('returns 404 for non-existent manifest', async () => {
      api.setUser(owner);
      const response = await api.get('/api/manifests/00000000-0000-0000-0000-000000000000');

      expect(response.status).toBe(404);
    });
  });
});
