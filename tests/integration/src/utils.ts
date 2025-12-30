/**
 * Test Utilities
 *
 * Helper functions and fixtures for integration tests.
 */

import { api, ApiClient } from './api-client';

/**
 * Wait for the API to be healthy
 */
export async function waitForApi(
  client: ApiClient = api,
  maxAttempts = 30,
  intervalMs = 1000
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await client.get<{ status: string }>('/health');
      if (response.status === 200 && response.data.status === 'healthy') {
        return;
      }
    } catch {
      // Continue waiting
    }
    await sleep(intervalMs);
  }
  throw new Error(`API not ready after ${maxAttempts} attempts`);
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a unique test user ID
 */
export function uniqueUser(prefix = 'testuser'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
}

/**
 * Generate random bytes as base64
 */
export function randomBase64(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64');
}

/**
 * Test fixture for creating albums
 */
export async function createTestAlbum(client: ApiClient, user: string) {
  client.setUser(user);
  const response = await client.post<{
    id: string;
    ownerId: string;
    currentEpochId: number | null;
    currentVersion: number;
    createdAt: string;
  }>('/api/albums');

  if (response.status !== 201) {
    throw new Error(`Failed to create album: ${response.status}`);
  }

  return response.data;
}

/**
 * Test fixture for uploading epoch keys
 */
export async function uploadEpochKey(
  client: ApiClient,
  albumId: string,
  epochId: number,
  wrappedKey: string,
  targetUserId: string
) {
  const response = await client.post(`/api/albums/${albumId}/epoch-keys`, {
    epochId,
    wrappedKey,
    wrappedFor: targetUserId,
  });

  return response;
}

/**
 * Retry a function until it succeeds or max retries reached
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  delayMs = 500
): Promise<T> {
  let lastError: Error | undefined;

  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (i < maxRetries) {
        await sleep(delayMs * Math.pow(2, i)); // Exponential backoff
      }
    }
  }

  throw lastError;
}
