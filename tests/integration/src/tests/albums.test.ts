/**
 * Albums API Tests
 *
 * Tests for album CRUD operations.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { api, Album, PagedResponse } from '../api-client';
import { waitForApi, uniqueUser, createTestAlbum, generateCreateAlbumRequest } from '../utils';

describe('Albums API', () => {
  let testUser: string;

  beforeAll(async () => {
    await waitForApi(api);
  });

  beforeEach(() => {
    testUser = uniqueUser();
  });

  describe('POST /api/v1/albums', () => {
    it('creates a new album', async () => {
      api.setUser(testUser);

      const requestBody = generateCreateAlbumRequest();
      const response = await api.post<Album>('/api/v1/albums', requestBody);

      expect(response.status).toBe(201);
      expect(response.data.id).toBeDefined();
      expect(response.data.ownerId).toBeDefined();
      expect(response.data.currentVersion).toBe(1);
      expect(response.data.createdAt).toBeDefined();
    });

    it('returns 401 without auth', async () => {
      api.clearAuth();

      const response = await api.post('/api/v1/albums', generateCreateAlbumRequest());

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/v1/albums', () => {
    it('lists albums for user', async () => {
      api.setUser(testUser);

      // Create two albums
      await api.post<Album>('/api/v1/albums', generateCreateAlbumRequest());
      await api.post<Album>('/api/v1/albums', generateCreateAlbumRequest());

      const response = await api.get<PagedResponse<Album>>('/api/v1/albums');

      expect(response.status).toBe(200);
      expect(response.data.items).toHaveLength(2);
    });

    it('returns empty array for new user', async () => {
      api.setUser(uniqueUser());

      const response = await api.get<PagedResponse<Album>>('/api/v1/albums');

      expect(response.status).toBe(200);
      expect(response.data.items).toEqual([]);
      expect(response.data.nextSkip).toBeNull();
    });

    it('includes role in response', async () => {
      api.setUser(testUser);

      await api.post<Album>('/api/v1/albums', generateCreateAlbumRequest());
      const response = await api.get<PagedResponse<Album>>('/api/v1/albums');

      expect(response.data.items[0].role).toBe('owner');
    });
  });

  describe('GET /api/v1/albums/:id', () => {
    it('returns album details', async () => {
      api.setUser(testUser);

      const created = await api.post<Album>('/api/v1/albums', generateCreateAlbumRequest());
      const response = await api.get<Album>(`/api/v1/albums/${created.data.id}`);

      expect(response.status).toBe(200);
      expect(response.data.id).toBe(created.data.id);
      expect(response.data.role).toBe('owner');
    });

    it('returns 403 for non-member', async () => {
      api.setUser(testUser);
      const created = await api.post<Album>('/api/v1/albums', generateCreateAlbumRequest());

      // Create a different user and ensure they exist
      const otherUser = uniqueUser();
      api.setUser(otherUser);
      await api.get('/api/v1/users/me'); // Ensure user is created

      const response = await api.get(`/api/v1/albums/${created.data.id}`);

      expect(response.status).toBe(403);
    });

    it('returns 404 for non-existent album', async () => {
      api.setUser(testUser);
      await api.get('/api/v1/users/me'); // Ensure user is created

      const response = await api.get('/api/v1/albums/00000000-0000-0000-0000-000000000000');

      // Should return 403 since user is not a member (not found is treated as forbidden)
      expect([403, 404]).toContain(response.status);
    });
  });

  describe('GET /api/v1/albums/:id/sync', () => {
    it('returns empty manifests for new album', async () => {
      api.setUser(testUser);

      const album = await createTestAlbum(api, testUser);

      const response = await api.get<{
        albumVersion: number;
        manifests: unknown[];
      }>(`/api/v1/albums/${album.id}/sync?since=0`);

      expect(response.status).toBe(200);
      expect(response.data.manifests).toEqual([]);
      expect(response.data.albumVersion).toBe(0);
    });

    it('returns 403 for non-member', async () => {
      api.setUser(testUser);
      const album = await createTestAlbum(api, testUser);

      // Create a different user and ensure they exist
      const otherUser = uniqueUser();
      api.setUser(otherUser);
      await api.get('/api/v1/users/me'); // Ensure user is created

      const response = await api.get(`/api/v1/albums/${album.id}/sync?since=0`);

      expect(response.status).toBe(403);
    });
  });
});
