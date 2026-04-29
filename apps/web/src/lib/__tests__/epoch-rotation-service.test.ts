/**
 * Epoch Rotation Service - Security Tests (M1)
 *
 * Verifies that wrapKeysForShareLinks() zeroes derived tier keys and
 * per-link key material on both the success and the throw path so that
 * sensitive bytes do not linger in worker memory across epoch rotations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShareLinkWithSecretResponse } from '../api-types';

// ---------------------------------------------------------------------------
// Mock state captured across calls so tests can reach into the buffers the
// service derived and assert they were wiped after the function returned.
// ---------------------------------------------------------------------------

interface CapturedTierKeys {
  thumbKey: Uint8Array;
  previewKey: Uint8Array;
  fullKey: Uint8Array;
}

interface CapturedLinkKeys {
  linkId: Uint8Array;
  wrappingKey: Uint8Array;
}

const captured: {
  tierKeys: CapturedTierKeys | null;
  linkSecrets: Uint8Array[];
  linkKeys: CapturedLinkKeys[];
} = { tierKeys: null, linkSecrets: [], linkKeys: [] };

function nonZero(size: number, fill: number): Uint8Array {
  const buf = new Uint8Array(size);
  buf.fill(fill);
  return buf;
}

// ---------------------------------------------------------------------------
// Mocks (registered before the SUT import)
// ---------------------------------------------------------------------------

vi.mock('@mosaic/crypto', () => ({
  AccessTier: { THUMB: 1, PREVIEW: 2, FULL: 3 },
  deriveTierKeys: vi.fn(() => {
    const keys: CapturedTierKeys = {
      thumbKey: nonZero(32, 0xa1),
      previewKey: nonZero(32, 0xa2),
      fullKey: nonZero(32, 0xa3),
    };
    captured.tierKeys = keys;
    return keys;
  }),
  deriveLinkKeys: vi.fn(() => {
    const keys: CapturedLinkKeys = {
      linkId: nonZero(16, 0xb1),
      wrappingKey: nonZero(32, 0xb2),
    };
    captured.linkKeys.push(keys);
    return keys;
  }),
  wrapTierKeyForLink: vi.fn(() => ({
    nonce: new Uint8Array(24),
    encryptedKey: new Uint8Array(48),
  })),
  memzero: vi.fn((buf: Uint8Array) => {
    buf.fill(0);
  }),
}));

vi.mock('../api', () => ({
  fromBase64: vi.fn(() => new Uint8Array([1, 2, 3])),
  toBase64: vi.fn(() => 'base64'),
  getApi: vi.fn(),
  paginateAll: vi.fn(),
}));

vi.mock('../crypto-client', () => ({
  getCryptoClient: vi.fn(),
}));

vi.mock('../db-client', () => ({
  getDbClient: vi.fn(),
}));

vi.mock('../epoch-key-service', () => ({
  fetchAndUnwrapEpochKeys: vi.fn(),
}));

vi.mock('../epoch-key-store', () => ({
  clearAlbumKeys: vi.fn(),
  setEpochKey: vi.fn(),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Imports must come after the mocks are registered.
import { getCryptoClient } from '../crypto-client';
import { wrapKeysForShareLinks } from '../epoch-rotation-service';

const mockGetCryptoClient = vi.mocked(getCryptoClient);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeShareLink(
  overrides: Partial<ShareLinkWithSecretResponse> = {},
): ShareLinkWithSecretResponse {
  return {
    id: 'link-1',
    linkId: 'link-id-1',
    accessTier: 3,
    isRevoked: false,
    ownerEncryptedSecret: 'opaque-secret',
    ...overrides,
  } as ShareLinkWithSecretResponse;
}

beforeEach(() => {
  captured.tierKeys = null;
  captured.linkSecrets = [];
  captured.linkKeys = [];
  vi.clearAllMocks();

  mockGetCryptoClient.mockResolvedValue({
    unwrapWithAccountKey: vi.fn(async () => {
      const secret = nonZero(32, 0xc1);
      captured.linkSecrets.push(secret);
      return secret;
    }),
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wrapKeysForShareLinks (M1: zeroize derived tier keys)', () => {
  it('zeros tier keys after successful wrapping', async () => {
    const epochSeed = new Uint8Array(32).fill(0xee);
    const links = [makeShareLink({ id: 'link-a', accessTier: 3 })];

    const results = await wrapKeysForShareLinks(links, epochSeed);

    expect(results).toHaveLength(1);
    const tk = captured.tierKeys;
    expect(tk).not.toBeNull();
    expect(tk!.thumbKey.every((b) => b === 0)).toBe(true);
    expect(tk!.previewKey.every((b) => b === 0)).toBe(true);
    expect(tk!.fullKey.every((b) => b === 0)).toBe(true);
  });

  it('zeros per-link linkSecret and wrappingKey after successful wrapping', async () => {
    const epochSeed = new Uint8Array(32).fill(0xee);
    const links = [makeShareLink({ id: 'link-a', accessTier: 3 })];

    await wrapKeysForShareLinks(links, epochSeed);

    expect(captured.linkSecrets).toHaveLength(1);
    expect(captured.linkSecrets[0]!.every((b) => b === 0)).toBe(true);
    expect(captured.linkKeys).toHaveLength(1);
    expect(captured.linkKeys[0]!.wrappingKey.every((b) => b === 0)).toBe(true);
  });

  it('zeros tier keys even when iteration throws (finally path)', async () => {
    const epochSeed = new Uint8Array(32).fill(0xee);

    // A link whose ownerEncryptedSecret access throws. The `if (!link.owner...)`
    // guard runs OUTSIDE the per-link try/catch, so the error escapes upward
    // to the function-level try/finally that wipes tier keys.
    const badLink = {
      id: 'bad',
      linkId: 'bad-link-id',
      accessTier: 3,
      get isRevoked() {
        return false;
      },
      get ownerEncryptedSecret(): string {
        throw new Error('induced failure');
      },
    } as unknown as ShareLinkWithSecretResponse;

    await expect(wrapKeysForShareLinks([badLink], epochSeed)).rejects.toThrow(
      'induced failure',
    );

    const tk = captured.tierKeys;
    expect(tk).not.toBeNull();
    expect(tk!.thumbKey.every((b) => b === 0)).toBe(true);
    expect(tk!.previewKey.every((b) => b === 0)).toBe(true);
    expect(tk!.fullKey.every((b) => b === 0)).toBe(true);
  });
});
