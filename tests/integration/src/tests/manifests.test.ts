/**
 * Manifests API Tests
 *
 * Tests for photo manifest management.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { api, Manifest, User } from '../api-client';
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

  describe('POST /api/albums/:id/manifests', () => {
    it('creates a manifest', async () => {
      const album = await createTestAlbum(api, owner);
      const signedPayload = randomBase64(256);
      const signerPubkey = randomBase64(32);

      const response = await api.post<Manifest>(
        `/api/albums/${album.id}/manifests`,
        {
          signedPayload,
          signerPubkey,
          shardHashes: [randomBase64(32)],
        }
      );

      expect(response.status).toBe(201);
      expect(response.data.id).toBeDefined();
      expect(response.data.signedPayload).toBe(signedPayload);
      expect(response.data.signerPubkey).toBe(signerPubkey);
      expect(response.data.version).toBeGreaterThan(0);
    });

    it('increments album version', async () => {
      const album = await createTestAlbum(api, owner);

      const response1 = await api.post<Manifest>(
        `/api/albums/${album.id}/manifests`,
        {
          signedPayload: randomBase64(256),
          signerPubkey: randomBase64(32),
          shardHashes: [randomBase64(32)],
        }
      );

      const response2 = await api.post<Manifest>(
        `/api/albums/${album.id}/manifests`,
        {
          signedPayload: randomBase64(256),
          signerPubkey: randomBase64(32),
          shardHashes: [randomBase64(32)],
        }
      );

      expect(response2.data.version).toBeGreaterThan(response1.data.version);
    });

    it('returns 403 for non-member', async () => {
      const album = await createTestAlbum(api, owner);

      api.setUser(uniqueUser());
      const response = await api.post(`/api/albums/${album.id}/manifests`, {
        signedPayload: randomBase64(256),
        signerPubkey: randomBase64(32),
        shardHashes: [randomBase64(32)],
      });

      expect(response.status).toBe(403);
    });
  });

  describe('GET /api/albums/:id/manifests/:manifestId', () => {
    it('returns manifest details', async () => {
      const album = await createTestAlbum(api, owner);
      const signedPayload = randomBase64(256);

      const created = await api.post<Manifest>(
        `/api/albums/${album.id}/manifests`,
        {
          signedPayload,
          signerPubkey: randomBase64(32),
          shardHashes: [randomBase64(32)],
        }
      );

      const response = await api.get<Manifest>(
        `/api/albums/${album.id}/manifests/${created.data.id}`
      );

      expect(response.status).toBe(200);
      expect(response.data.id).toBe(created.data.id);
      expect(response.data.signedPayload).toBe(signedPayload);
    });

    it('returns 404 for non-existent manifest', async () => {
      const album = await createTestAlbum(api, owner);

      const response = await api.get(
        `/api/albums/${album.id}/manifests/00000000-0000-0000-0000-000000000000`
      );

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/albums/:id/manifests/:manifestId', () => {
    it('soft-deletes a manifest', async () => {
      const album = await createTestAlbum(api, owner);

      const created = await api.post<Manifest>(
        `/api/albums/${album.id}/manifests`,
        {
          signedPayload: randomBase64(256),
          signerPubkey: randomBase64(32),
          shardHashes: [randomBase64(32)],
        }
      );

      const deleteResponse = await api.delete(
        `/api/albums/${album.id}/manifests/${created.data.id}`
      );

      expect(deleteResponse.status).toBe(204);

      // Manifest should still be retrievable but marked as trashed
      const getResponse = await api.get<Manifest>(
        `/api/albums/${album.id}/manifests/${created.data.id}`
      );

      expect(getResponse.status).toBe(200);
      expect(getResponse.data.trashedAt).not.toBeNull();
    });
  });
});
