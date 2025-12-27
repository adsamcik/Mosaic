/**
 * Users API Tests
 *
 * Tests for user profile and authentication.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { api, User } from '../api-client';
import { waitForApi, uniqueUser, randomBase64 } from '../utils';

describe('Users API', () => {
  beforeAll(async () => {
    await waitForApi(api);
  });

  describe('GET /api/users/me', () => {
    it('returns 401 without auth header', async () => {
      api.clearAuth();
      const response = await api.get('/api/users/me');
      expect(response.status).toBe(401);
    });

    it('creates new user on first access', async () => {
      const username = uniqueUser();
      api.setUser(username);

      const response = await api.get<User>('/api/users/me');

      expect(response.status).toBe(200);
      expect(response.data.authSub).toBe(username);
      expect(response.data.id).toBeDefined();
      expect(response.data.createdAt).toBeDefined();
    });

    it('returns same user on subsequent access', async () => {
      const username = uniqueUser();
      api.setUser(username);

      const first = await api.get<User>('/api/users/me');
      const second = await api.get<User>('/api/users/me');

      expect(first.data.id).toBe(second.data.id);
      expect(first.data.createdAt).toBe(second.data.createdAt);
    });
  });

  describe('PUT /api/users/me', () => {
    it('updates display name', async () => {
      const username = uniqueUser();
      api.setUser(username);

      // Create user first
      await api.get<User>('/api/users/me');

      // Update
      const updateResponse = await api.put<User>('/api/users/me', {
        displayName: 'Test User',
      });

      expect(updateResponse.status).toBe(200);
      expect(updateResponse.data.displayName).toBe('Test User');

      // Verify persistence
      const getResponse = await api.get<User>('/api/users/me');
      expect(getResponse.data.displayName).toBe('Test User');
    });

    it('updates identity pubkey', async () => {
      const username = uniqueUser();
      api.setUser(username);

      // Create user first
      await api.get<User>('/api/users/me');

      const pubkey = randomBase64(32);
      const updateResponse = await api.put<User>('/api/users/me', {
        identityPubkey: pubkey,
      });

      expect(updateResponse.status).toBe(200);
      expect(updateResponse.data.identityPubkey).toBe(pubkey);
    });
  });
});
