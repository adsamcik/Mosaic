/**
 * Members API Tests
 *
 * Tests for album membership management.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { api, AlbumMember, User } from '../api-client';
import { waitForApi, uniqueUser, createTestAlbum, randomBase64 } from '../utils';

describe('Members API', () => {
  let owner: string;
  let member: string;

  beforeAll(async () => {
    await waitForApi(api);
  });

  beforeEach(async () => {
    owner = uniqueUser('owner');
    member = uniqueUser('member');

    // Initialize member user with a pubkey
    api.setUser(member);
    await api.put<User>('/api/users/me', {
      identityPubkey: randomBase64(32),
    });
  });

  describe('GET /api/albums/:id/members', () => {
    it('lists album members', async () => {
      const album = await createTestAlbum(api, owner);

      const response = await api.get<AlbumMember[]>(`/api/albums/${album.id}/members`);

      expect(response.status).toBe(200);
      expect(response.data).toHaveLength(1);
      expect(response.data[0].role).toBe('owner');
    });

    it('returns 403 for non-member', async () => {
      const album = await createTestAlbum(api, owner);

      api.setUser(uniqueUser());
      const response = await api.get(`/api/albums/${album.id}/members`);

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/albums/:id/members', () => {
    it('adds a new member', async () => {
      const album = await createTestAlbum(api, owner);

      // Get member's user ID
      api.setUser(member);
      const memberUser = await api.get<User>('/api/users/me');

      // Add member as owner
      api.setUser(owner);
      const response = await api.post<AlbumMember>(
        `/api/albums/${album.id}/members`,
        {
          userId: memberUser.data.id,
          role: 'viewer',
        }
      );

      expect(response.status).toBe(201);
      expect(response.data.role).toBe('viewer');
    });

    it('allows member to access album after being added', async () => {
      const album = await createTestAlbum(api, owner);

      // Get member's user ID
      api.setUser(member);
      const memberUser = await api.get<User>('/api/users/me');

      // Add member
      api.setUser(owner);
      await api.post(`/api/albums/${album.id}/members`, {
        userId: memberUser.data.id,
        role: 'viewer',
      });

      // Member should now have access
      api.setUser(member);
      const response = await api.get(`/api/albums/${album.id}`);

      expect(response.status).toBe(200);
    });

    it('returns 403 for non-owner', async () => {
      const album = await createTestAlbum(api, owner);

      // Get member's user ID and add them
      api.setUser(member);
      const memberUser = await api.get<User>('/api/users/me');

      api.setUser(owner);
      await api.post(`/api/albums/${album.id}/members`, {
        userId: memberUser.data.id,
        role: 'viewer',
      });

      // Member cannot add other members
      api.setUser(member);
      const newMember = uniqueUser();
      api.setUser(newMember);
      const newMemberUser = await api.get<User>('/api/users/me');

      api.setUser(member);
      const response = await api.post(`/api/albums/${album.id}/members`, {
        userId: newMemberUser.data.id,
        role: 'viewer',
      });

      expect(response.status).toBe(403);
    });
  });

  describe('DELETE /api/albums/:id/members/:userId', () => {
    it('removes a member', async () => {
      const album = await createTestAlbum(api, owner);

      // Add member
      api.setUser(member);
      const memberUser = await api.get<User>('/api/users/me');

      api.setUser(owner);
      await api.post(`/api/albums/${album.id}/members`, {
        userId: memberUser.data.id,
        role: 'viewer',
      });

      // Remove member
      const deleteResponse = await api.delete(
        `/api/albums/${album.id}/members/${memberUser.data.id}`
      );

      expect(deleteResponse.status).toBe(204);

      // Member should no longer have access
      api.setUser(member);
      const accessResponse = await api.get(`/api/albums/${album.id}`);

      expect(accessResponse.status).toBe(403);
    });

    it('returns 403 when non-owner tries to remove member', async () => {
      const album = await createTestAlbum(api, owner);

      // Add member
      api.setUser(member);
      const memberUser = await api.get<User>('/api/users/me');

      api.setUser(owner);
      await api.post(`/api/albums/${album.id}/members`, {
        userId: memberUser.data.id,
        role: 'viewer',
      });

      // Member cannot remove themselves via this endpoint
      api.setUser(member);
      const response = await api.delete(
        `/api/albums/${album.id}/members/${memberUser.data.id}`
      );

      expect(response.status).toBe(403);
    });
  });
});
