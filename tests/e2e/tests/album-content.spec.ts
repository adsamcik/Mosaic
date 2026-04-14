/**
 * Album Content API E2E Tests
 *
 * Tests the album content API endpoints for encrypted content storage and retrieval.
 * Since the content editor UI isn't integrated yet, these tests focus on API-level validation.
 */

import {
  test,
  expect,
  loginUser,
  createAlbumViaAPI,
  TEST_PASSWORD,
  API_URL,
} from '../fixtures-enhanced';

// Constant epoch ID for tests - backend accepts any value in test mode
const TEST_EPOCH_ID = 1;

test.describe('Album Content API @p1 @album', () => {
  test.describe('GET /api/albums/:albumId/content', () => {
    test('returns 404 for album with no content', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('content-reader');
      await loginUser(user, TEST_PASSWORD);

      // Create an album
      const album = await createAlbumViaAPI(user.email, testContext.generateAlbumName('Empty'));

      // GET content - should return 404 since no content exists
      const response = await user.page.request.get(
        `${API_URL}/api/albums/${album.id}/content`,
        { headers: { 'Remote-User': user.email } }
      );

      expect(response.status()).toBe(404);
    });

    test('returns 404 for non-existent album', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('content-reader');
      await loginUser(user, TEST_PASSWORD);

      const fakeAlbumId = '00000000-0000-0000-0000-000000000000';
      
      const response = await user.page.request.get(
        `${API_URL}/api/albums/${fakeAlbumId}/content`,
        { headers: { 'Remote-User': user.email } }
      );

      expect(response.status()).toBe(404);
    });

    test('returns 403 for album user cannot access', async ({ testContext }) => {
      // Create album with first user
      const owner = await testContext.createAuthenticatedUser('owner');
      await loginUser(owner, TEST_PASSWORD);
      const album = await createAlbumViaAPI(owner.email, testContext.generateAlbumName('Private'));

      // Try to access with second user
      const intruder = await testContext.createAuthenticatedUser('intruder');
      await loginUser(intruder, TEST_PASSWORD);

      const response = await intruder.page.request.get(
        `${API_URL}/api/albums/${album.id}/content`,
        { headers: { 'Remote-User': intruder.email } }
      );

      expect(response.status()).toBe(403);
    });
  });

  test.describe('PUT /api/albums/:albumId/content', () => {
    test('creates content for album with no existing content', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('content-creator');
      await loginUser(user, TEST_PASSWORD);

      // Create an album
      const album = await createAlbumViaAPI(user.email, testContext.generateAlbumName('Story'));

      // Generate mock encrypted content
      const encryptedContent = new Uint8Array(64);
      crypto.getRandomValues(encryptedContent);
      const nonce = new Uint8Array(24);
      crypto.getRandomValues(nonce);

      // PUT content
      const response = await user.page.request.put(
        `${API_URL}/api/albums/${album.id}/content`,
        {
          headers: {
            'Remote-User': user.email,
            'Content-Type': 'application/json',
          },
          data: {
            encryptedContent: Buffer.from(encryptedContent).toString('base64'),
            nonce: Buffer.from(nonce).toString('base64'),
            epochId: TEST_EPOCH_ID,
            expectedVersion: 0,
          },
        }
      );

      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.version).toBe(1);
      expect(body.epochId).toBe(TEST_EPOCH_ID);
    });

    test('updates existing content with correct version', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('content-updater');
      await loginUser(user, TEST_PASSWORD);

      const album = await createAlbumViaAPI(user.email, testContext.generateAlbumName('Update'));

      // Create initial content
      const content1 = new Uint8Array(64);
      crypto.getRandomValues(content1);
      const nonce1 = new Uint8Array(24);
      crypto.getRandomValues(nonce1);

      await user.page.request.put(
        `${API_URL}/api/albums/${album.id}/content`,
        {
          headers: {
            'Remote-User': user.email,
            'Content-Type': 'application/json',
          },
          data: {
            encryptedContent: Buffer.from(content1).toString('base64'),
            nonce: Buffer.from(nonce1).toString('base64'),
            epochId: TEST_EPOCH_ID,
            expectedVersion: 0,
          },
        }
      );

      // Update with version 1
      const content2 = new Uint8Array(128);
      crypto.getRandomValues(content2);
      const nonce2 = new Uint8Array(24);
      crypto.getRandomValues(nonce2);

      const updateResponse = await user.page.request.put(
        `${API_URL}/api/albums/${album.id}/content`,
        {
          headers: {
            'Remote-User': user.email,
            'Content-Type': 'application/json',
          },
          data: {
            encryptedContent: Buffer.from(content2).toString('base64'),
            nonce: Buffer.from(nonce2).toString('base64'),
            epochId: TEST_EPOCH_ID,
            expectedVersion: 1,
          },
        }
      );

      expect(updateResponse.status()).toBe(200);
      const body = await updateResponse.json();
      expect(body.version).toBe(2);
    });

    test('rejects update with wrong version (optimistic concurrency)', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('conflict-test');
      await loginUser(user, TEST_PASSWORD);

      const album = await createAlbumViaAPI(user.email, testContext.generateAlbumName('Conflict'));

      // Create initial content
      const content1 = new Uint8Array(64);
      crypto.getRandomValues(content1);
      const nonce1 = new Uint8Array(24);
      crypto.getRandomValues(nonce1);

      await user.page.request.put(
        `${API_URL}/api/albums/${album.id}/content`,
        {
          headers: {
            'Remote-User': user.email,
            'Content-Type': 'application/json',
          },
          data: {
            encryptedContent: Buffer.from(content1).toString('base64'),
            nonce: Buffer.from(nonce1).toString('base64'),
            epochId: TEST_EPOCH_ID,
            expectedVersion: 0,
          },
        }
      );

      // Try to update with wrong version (0 instead of 1)
      const content2 = new Uint8Array(128);
      crypto.getRandomValues(content2);
      const nonce2 = new Uint8Array(24);
      crypto.getRandomValues(nonce2);

      const conflictResponse = await user.page.request.put(
        `${API_URL}/api/albums/${album.id}/content`,
        {
          headers: {
            'Remote-User': user.email,
            'Content-Type': 'application/json',
          },
          data: {
            encryptedContent: Buffer.from(content2).toString('base64'),
            nonce: Buffer.from(nonce2).toString('base64'),
            epochId: TEST_EPOCH_ID,
            expectedVersion: 0, // Wrong version!
          },
        }
      );

      expect(conflictResponse.status()).toBe(409);
    });

    test('returns 403 for non-owner trying to update content', async ({ testContext }) => {
      // Create album with owner
      const owner = await testContext.createAuthenticatedUser('content-owner');
      await loginUser(owner, TEST_PASSWORD);
      const album = await createAlbumViaAPI(owner.email, testContext.generateAlbumName('OwnerOnly'));

      // Try to update with different user
      const other = await testContext.createAuthenticatedUser('not-owner');
      await loginUser(other, TEST_PASSWORD);

      const content = new Uint8Array(64);
      crypto.getRandomValues(content);
      const nonce = new Uint8Array(24);
      crypto.getRandomValues(nonce);

      const response = await other.page.request.put(
        `${API_URL}/api/albums/${album.id}/content`,
        {
          headers: {
            'Remote-User': other.email,
            'Content-Type': 'application/json',
          },
          data: {
            encryptedContent: Buffer.from(content).toString('base64'),
            nonce: Buffer.from(nonce).toString('base64'),
            epochId: TEST_EPOCH_ID,
            expectedVersion: 0,
          },
        }
      );

      expect(response.status()).toBe(403);
    });

    test('validates nonce length (must be 24 bytes)', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('nonce-test');
      await loginUser(user, TEST_PASSWORD);

      const album = await createAlbumViaAPI(user.email, testContext.generateAlbumName('BadNonce'));

      const content = new Uint8Array(64);
      crypto.getRandomValues(content);
      const shortNonce = new Uint8Array(12); // Wrong size!
      crypto.getRandomValues(shortNonce);

      const response = await user.page.request.put(
        `${API_URL}/api/albums/${album.id}/content`,
        {
          headers: {
            'Remote-User': user.email,
            'Content-Type': 'application/json',
          },
          data: {
            encryptedContent: Buffer.from(content).toString('base64'),
            nonce: Buffer.from(shortNonce).toString('base64'),
            epochId: TEST_EPOCH_ID,
            expectedVersion: 0,
          },
        }
      );

      expect(response.status()).toBe(400);
    });
  });

  test.describe('Content roundtrip', () => {
    test('PUT then GET returns same encrypted content', async ({ testContext }) => {
      const user = await testContext.createAuthenticatedUser('roundtrip-test');
      await loginUser(user, TEST_PASSWORD);

      const album = await createAlbumViaAPI(user.email, testContext.generateAlbumName('Roundtrip'));

      // Generate content
      const encryptedContent = new Uint8Array(256);
      crypto.getRandomValues(encryptedContent);
      const nonce = new Uint8Array(24);
      crypto.getRandomValues(nonce);

      // PUT content
      await user.page.request.put(
        `${API_URL}/api/albums/${album.id}/content`,
        {
          headers: {
            'Remote-User': user.email,
            'Content-Type': 'application/json',
          },
          data: {
            encryptedContent: Buffer.from(encryptedContent).toString('base64'),
            nonce: Buffer.from(nonce).toString('base64'),
            epochId: TEST_EPOCH_ID,
            expectedVersion: 0,
          },
        }
      );

      // GET content
      const getResponse = await user.page.request.get(
        `${API_URL}/api/albums/${album.id}/content`,
        { headers: { 'Remote-User': user.email } }
      );

      expect(getResponse.status()).toBe(200);

      const body = await getResponse.json();
      expect(body.version).toBe(1);
      expect(body.epochId).toBe(TEST_EPOCH_ID);
      
      // Verify content matches (API returns base64-encoded byte arrays)
      const returnedContent = new Uint8Array(Buffer.from(body.encryptedContent, 'base64'));
      const returnedNonce = new Uint8Array(Buffer.from(body.nonce, 'base64'));
      
      expect(returnedContent).toEqual(encryptedContent);
      expect(returnedNonce).toEqual(nonce);
    });
  });
});
