/**
 * Epoch Keys API Tests
 *
 * Tests for epoch key management.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { api, User } from '../api-client';
import { waitForApi, uniqueUser, createTestAlbum, randomBase64 } from '../utils';

/**
 * Generate epoch key create data for API requests
 */
function generateEpochKeyData(epochId: number = 1) {
  return {
    recipientId: '', // To be filled with actual user ID
    epochId,
    encryptedKeyBundle: randomBase64(96),
    ownerSignature: randomBase64(64),
    sharerPubkey: randomBase64(32),
    signPubkey: randomBase64(32),
  };
}

interface EpochKeyResponse {
  id: string;
  albumId: string;
  epochId: number;
  encryptedKeyBundle: string;
  ownerSignature: string;
  sharerPubkey: string;
  signPubkey: string;
  createdAt: string;
}

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
      const epochKeyData = generateEpochKeyData(2);
      epochKeyData.recipientId = ownerId;

      const response = await api.post<EpochKeyResponse>(
        `/api/albums/${album.id}/epoch-keys`,
        epochKeyData
      );

      expect(response.status).toBe(201);
      expect(response.data.epochId).toBe(2);
      expect(response.data.id).toBeDefined();
      expect(response.data.recipientId).toBe(ownerId);
    });

    it('returns 403 for non-owner', async () => {
      const album = await createTestAlbum(api, owner);
      const member = uniqueUser('member');

      // Get member user
      api.setUser(member);
      const memberUser = await api.get<User>('/api/users/me');

      // Add member via invite with epoch keys
      api.setUser(owner);
      await api.post(`/api/albums/${album.id}/members`, {
        recipientId: memberUser.data.id,
        role: 'viewer',
        epochKeys: [{
          epochId: 1,
          encryptedKeyBundle: randomBase64(96),
          ownerSignature: randomBase64(64),
          sharerPubkey: randomBase64(32),
          signPubkey: randomBase64(32),
        }],
      });

      // Member (viewer) cannot upload epoch keys
      api.setUser(member);
      const epochKeyData = generateEpochKeyData(2);
      epochKeyData.recipientId = memberUser.data.id;
      const response = await api.post(`/api/albums/${album.id}/epoch-keys`, epochKeyData);

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/albums/:id/epoch-keys', () => {
    it('lists epoch keys for user', async () => {
      const album = await createTestAlbum(api, owner);

      // Album creation already creates epoch 1, so we should have one key
      const response = await api.get<EpochKeyResponse[]>(
        `/api/albums/${album.id}/epoch-keys`
      );

      expect(response.status).toBe(200);
      expect(response.data).toHaveLength(1);
      expect(response.data[0].epochId).toBe(1);
    });

    it('only returns keys wrapped for the requesting user', async () => {
      const album = await createTestAlbum(api, owner);
      const member = uniqueUser('member');

      // Get member user
      api.setUser(member);
      const memberUser = await api.get<User>('/api/users/me');

      // Add member via invite with epoch keys
      api.setUser(owner);
      await api.post(`/api/albums/${album.id}/members`, {
        recipientId: memberUser.data.id,
        role: 'viewer',
        epochKeys: [{
          epochId: 1,
          encryptedKeyBundle: randomBase64(96),
          ownerSignature: randomBase64(64),
          sharerPubkey: randomBase64(32),
          signPubkey: randomBase64(32),
        }],
      });

      // Member should only see their own key
      api.setUser(member);
      const response = await api.get<EpochKeyResponse[]>(
        `/api/albums/${album.id}/epoch-keys`
      );

      expect(response.status).toBe(200);
      expect(response.data).toHaveLength(1);
    });
  });
});
