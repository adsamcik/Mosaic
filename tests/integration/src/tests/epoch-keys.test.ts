/**
 * Epoch Keys API Tests
 *
 * Tests for epoch key management.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { api, EpochKey, User } from '../api-client';
import { waitForApi, uniqueUser, createTestAlbum, randomBase64 } from '../utils';

describe('Epoch Keys API', () => {
  let owner: string;
  let ownerId: string;

  beforeAll(async () => {
    await waitForApi(api);
  });

  beforeEach(async () => {
    owner = uniqueUser('owner');

    // Initialize owner with a pubkey and get their ID
    api.setUser(owner);
    const user = await api.put<User>('/api/users/me', {
      identityPubkey: randomBase64(32),
    });
    ownerId = user.data.id;
  });

  describe('POST /api/albums/:id/epoch-keys', () => {
    it('creates an epoch key', async () => {
      const album = await createTestAlbum(api, owner);
      const wrappedKey = randomBase64(48); // Wrapped key size

      const response = await api.post<EpochKey>(
        `/api/albums/${album.id}/epoch-keys`,
        {
          epochId: 1,
          wrappedKey,
          wrappedFor: ownerId,
        }
      );

      expect(response.status).toBe(201);
      expect(response.data.epochId).toBe(1);
      expect(response.data.wrappedKey).toBe(wrappedKey);
      expect(response.data.wrappedFor).toBe(ownerId);
    });

    it('returns 403 for non-owner', async () => {
      const album = await createTestAlbum(api, owner);
      const member = uniqueUser('member');

      // Add member
      api.setUser(member);
      const memberUser = await api.get<User>('/api/users/me');

      api.setUser(owner);
      await api.post(`/api/albums/${album.id}/members`, {
        userId: memberUser.data.id,
        role: 'viewer',
      });

      // Member cannot upload epoch keys
      api.setUser(member);
      const response = await api.post(`/api/albums/${album.id}/epoch-keys`, {
        epochId: 1,
        wrappedKey: randomBase64(48),
        wrappedFor: memberUser.data.id,
      });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/albums/:id/epoch-keys', () => {
    it('lists epoch keys for user', async () => {
      const album = await createTestAlbum(api, owner);

      // Upload a key
      await api.post(`/api/albums/${album.id}/epoch-keys`, {
        epochId: 1,
        wrappedKey: randomBase64(48),
        wrappedFor: ownerId,
      });

      const response = await api.get<EpochKey[]>(
        `/api/albums/${album.id}/epoch-keys`
      );

      expect(response.status).toBe(200);
      expect(response.data).toHaveLength(1);
      expect(response.data[0].epochId).toBe(1);
    });

    it('only returns keys wrapped for the requesting user', async () => {
      const album = await createTestAlbum(api, owner);
      const member = uniqueUser('member');

      // Add member
      api.setUser(member);
      const memberUser = await api.put<User>('/api/users/me', {
        identityPubkey: randomBase64(32),
      });

      api.setUser(owner);
      await api.post(`/api/albums/${album.id}/members`, {
        userId: memberUser.data.id,
        role: 'viewer',
      });

      // Upload key for owner only
      await api.post(`/api/albums/${album.id}/epoch-keys`, {
        epochId: 1,
        wrappedKey: randomBase64(48),
        wrappedFor: ownerId,
      });

      // Member should see no keys
      api.setUser(member);
      const response = await api.get<EpochKey[]>(
        `/api/albums/${album.id}/epoch-keys`
      );

      expect(response.status).toBe(200);
      expect(response.data).toHaveLength(0);
    });
  });
});
