/**
 * API Client Integration Tests
 *
 * Tests for the API client utilities and error handling.
 * Note: These don't test actual network requests (that would require a mock server),
 * but verify the client utilities and error classes work correctly.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { ApiError, toBase64, fromBase64, getApi } from '../src/lib/api';

describe('ApiError', () => {
  it('creates error with status and message', () => {
    const error = new ApiError(404, 'Not Found');

    expect(error.status).toBe(404);
    expect(error.statusText).toBe('Not Found');
    expect(error.message).toBe('API Error 404: Not Found');
    expect(error.name).toBe('ApiError');
  });

  it('includes optional body', () => {
    const error = new ApiError(
      400,
      'Bad Request',
      '{"error": "validation failed"}',
    );

    expect(error.body).toBe('{"error": "validation failed"}');
  });

  it('is instanceof Error', () => {
    const error = new ApiError(500, 'Internal Server Error');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ApiError);
  });
});

describe('base64 utilities', () => {
  it('round-trips simple data', () => {
    const original = new Uint8Array([1, 2, 3, 4, 5]);
    const encoded = toBase64(original);
    const decoded = fromBase64(encoded);

    expect(decoded).toEqual(original);
  });

  it('handles empty array', () => {
    const original = new Uint8Array([]);
    const encoded = toBase64(original);
    const decoded = fromBase64(encoded);

    expect(decoded).toEqual(original);
    expect(encoded).toBe('');
  });

  it('handles binary data with all byte values', () => {
    // Create array with all possible byte values
    const original = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      original[i] = i;
    }

    const encoded = toBase64(original);
    const decoded = fromBase64(encoded);

    expect(decoded).toEqual(original);
  });

  it('produces valid base64 string', () => {
    const original = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const encoded = toBase64(original);

    // Base64 should only contain valid characters
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]*$/);

    // Known base64 encoding of "Hello"
    expect(encoded).toBe('SGVsbG8=');
  });

  it('handles large data', () => {
    // 64KB of random-ish data (reduced from 1MB for faster tests)
    const original = new Uint8Array(64 * 1024);
    for (let i = 0; i < original.length; i++) {
      original[i] = (i * 17 + 31) % 256;
    }

    const encoded = toBase64(original);
    const decoded = fromBase64(encoded);

    expect(decoded).toEqual(original);
  });
});

describe('updateAlbumExpiration', () => {
  const mockAlbumResponse = {
    id: 'album-123',
    ownerId: 'user-456',
    currentVersion: 1,
    currentEpochId: 1,
    createdAt: new Date().toISOString(),
    expiresAt: '2024-12-25T23:59:59Z',
    expirationWarningDays: 7,
  };

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockAlbumResponse),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses PATCH method, not PUT', async () => {
    const api = getApi();
    await api.updateAlbumExpiration('album-123', {
      expiresAt: '2024-12-25T23:59:59Z',
      expirationWarningDays: 7,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(init.method).toBe('PATCH');
  });

  it('calls the correct URL pattern', async () => {
    const api = getApi();
    await api.updateAlbumExpiration('album-123', {
      expiresAt: '2024-12-25T23:59:59Z',
      expirationWarningDays: 7,
    });

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/albums/album-123/expiration');
  });
});
