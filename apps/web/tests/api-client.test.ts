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
    id: '0190a0d4-cffe-7a55-9b8a-94e4ad9c4e51',
    ownerId: '0190a0d5-1234-7a55-9b8a-94e4ad9c4e52',
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
    await api.updateAlbumExpiration('0190a0d4-cffe-7a55-9b8a-94e4ad9c4e51', {
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


  it('serializes the album expiration request without encrypted metadata fields', async () => {
    const api = getApi();
    await api.updateAlbumExpiration('album-123', {
      expiresAt: '2024-12-25T23:59:59Z',
      expirationWarningDays: 7,
    });

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)).toEqual({
      expiresAt: '2024-12-25T23:59:59Z',
      expirationWarningDays: 7,
    });
  });

  it('calls the correct URL pattern', async () => {
    const api = getApi();
    await api.updateAlbumExpiration('0190a0d4-cffe-7a55-9b8a-94e4ad9c4e51', {
      expiresAt: '2024-12-25T23:59:59Z',
      expirationWarningDays: 7,
    });

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      '/api/albums/0190a0d4-cffe-7a55-9b8a-94e4ad9c4e51/expiration',
    );
  });
});

// ===========================================================================
// M9: updateCurrentUserWrappedKey
// ---------------------------------------------------------------------------
// Verifies the wrapped-key PUT goes to the centralised API client (not a
// raw fetch in session.ts) so failures surface as ApiError and feed the
// M4 first-login conflict-recovery path.
// ===========================================================================

describe('updateCurrentUserWrappedKey (M9)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PUTs to /users/me/wrapped-key with a base64 wrappedAccountKey body', async () => {
    const api = getApi();
    const wrapped = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

    await api.updateCurrentUserWrappedKey(wrapped);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/users/me/wrapped-key');
    expect(init.method).toBe('PUT');

    const body = JSON.parse(init.body as string) as {
      wrappedAccountKey: string;
    };
    // base64 of 0xde 0xad 0xbe 0xef
    expect(body.wrappedAccountKey).toBe('3q2+7w==');
  });
});

// ===========================================================================
// M2: runtime response validation
// ---------------------------------------------------------------------------
// Verifies that apiRequest rejects malformed responses (compromised
// backend / MITM / proxy bug) with ApiError(500, 'Invalid response shape')
// and accepts well-formed ones, stripping unknown fields.
// ===========================================================================

const VALID_USER = {
  id: '0190a0d4-cffe-7a55-9b8a-94e4ad9c4e51',
  authSub: 'oidc:42',
  identityPubkey: 'YWJjZGVmZ2hpamtsbW5vcA==',
  createdAt: '2024-12-25T23:59:59Z',
  isAdmin: false,
} as const;

describe('apiRequest response validation (M2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a malformed User response with ApiError(500, "Invalid response shape")', async () => {
    const malformed = {
      id: 42, // wrong type — should be UUID string
      authSub: 'oidc:42',
      // createdAt missing entirely
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(malformed),
      }),
    );

    const api = getApi();
    let thrown: unknown;
    try {
      await api.getCurrentUser();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    const apiErr = thrown as ApiError;
    expect(apiErr.status).toBe(500);
    expect(apiErr.statusText).toBe('Invalid response shape');
    // The body should contain Zod validation issue paths so callers can
    // diagnose without re-running the request.
    expect(typeof apiErr.body).toBe('string');
    expect(apiErr.body).toContain('id');
  });

  it('rejects when the backend tries to inject isAdmin as a non-boolean', async () => {
    const tampered = {
      ...VALID_USER,
      isAdmin: 'true', // string, not boolean — silent privilege escalation attempt
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(tampered),
      }),
    );

    const api = getApi();
    await expect(api.getCurrentUser()).rejects.toBeInstanceOf(ApiError);
  });

  it('returns a parsed value for a well-formed User and strips unknown fields', async () => {
    const withInjectedField = {
      ...VALID_USER,
      bypassAuth: true, // attacker-supplied — must be stripped
      anotherExtra: 'leak',
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(withInjectedField),
      }),
    );

    const api = getApi();
    const user = await api.getCurrentUser();

    expect(user.id).toBe(VALID_USER.id);
    expect(user.authSub).toBe(VALID_USER.authSub);
    expect(user.isAdmin).toBe(false);
    // Cast to Record to assert injected fields didn't survive the schema.
    const userRecord = user as unknown as Record<string, unknown>;
    expect(userRecord['bypassAuth']).toBeUndefined();
    expect(userRecord['anotherExtra']).toBeUndefined();
  });

  it('preserves non-OK responses as the original ApiError (not the schema 500)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: () => Promise.resolve('not allowed'),
      }),
    );

    const api = getApi();
    let thrown: unknown;
    try {
      await api.getCurrentUser();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    const apiErr = thrown as ApiError;
    expect(apiErr.status).toBe(403);
    expect(apiErr.statusText).toBe('Forbidden');
  });
});

describe('updatePhotoExpiration', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses a dependency-safe PATCH adapter with only lifecycle metadata', async () => {
    const api = getApi();
    await api.updatePhotoExpiration('manifest-123', {
      expiresAt: '2024-12-25T23:59:59Z',
      expirationWarningDays: 3,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/manifests/manifest-123/expiration');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({
      expiresAt: '2024-12-25T23:59:59Z',
      expirationWarningDays: 3,
    });
  });
});
