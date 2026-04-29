/**
 * Epoch Rotation Service - Security Tests (M1)
 *
 * Slice 3 — tier-key derivation moved from `@mosaic/crypto` (in-worker JS)
 * to the Rust crypto core, so the per-iteration zeroing assertions for
 * thumb/preview/full keys no longer apply: those bytes never enter JS
 * memory in the new world. We retain the per-iteration `linkSecret` /
 * `wrappingKey` zeroing assertions because those buffers still cross the
 * worker boundary and are wiped on every path inside
 * `wrapKeysForShareLinks`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShareLinkWithSecretResponse } from '../api-types';

interface CapturedLinkKeys {
  linkId: Uint8Array;
  wrappingKey: Uint8Array;
}

const captured: {
  linkSecrets: Uint8Array[];
  linkKeys: CapturedLinkKeys[];
} = { linkSecrets: [], linkKeys: [] };

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
  // Slice 3 — Rust derives tier keys via the worker's epoch handle. JS
  // only still derives the per-link wrapping key from the recovered link
  // secret; share-link recipients carry on with the existing format.
  deriveLinkKeys: vi.fn(() => {
    const keys: CapturedLinkKeys = {
      linkId: nonZero(16, 0xb1),
      wrappingKey: nonZero(32, 0xb2),
    };
    captured.linkKeys.push(keys);
    return keys;
  }),
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

const TEST_EPOCH_HANDLE_ID = 'epch_test-handle-id';

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
  captured.linkSecrets = [];
  captured.linkKeys = [];
  vi.clearAllMocks();

  mockGetCryptoClient.mockResolvedValue({
    unwrapWithAccountKey: vi.fn(async () => {
      const secret = nonZero(32, 0xc1);
      captured.linkSecrets.push(secret);
      return secret;
    }),
    // Slice 3 — tier-key wrapping happens entirely inside the worker;
    // tier keys are never materialised in JS. The mock returns sentinel
    // bytes so callers can verify wrap-by-tier behaviour.
    wrapTierKeyForLinkRust: vi.fn(async (_handle: string, tier: number) => ({
      tier,
      nonce: new Uint8Array(24).fill(tier),
      encryptedKey: new Uint8Array(48).fill(tier),
    })),
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wrapKeysForShareLinks (M1: zeroize per-link material)', () => {
  it('zeros per-link linkSecret and wrappingKey after successful wrapping', async () => {
    const links = [makeShareLink({ id: 'link-a', accessTier: 3 })];

    const results = await wrapKeysForShareLinks(links, TEST_EPOCH_HANDLE_ID);

    expect(results).toHaveLength(1);
    expect(captured.linkSecrets).toHaveLength(1);
    expect(captured.linkSecrets[0]!.every((b) => b === 0)).toBe(true);
    expect(captured.linkKeys).toHaveLength(1);
    expect(captured.linkKeys[0]!.wrappingKey.every((b) => b === 0)).toBe(true);
  });

  it('routes tier-key wrapping through the worker handle (no JS-side tier keys)', async () => {
    const crypto = await mockGetCryptoClient();
    const links = [makeShareLink({ id: 'link-a', accessTier: 3 })];

    const results = await wrapKeysForShareLinks(links, TEST_EPOCH_HANDLE_ID);

    expect(results).toHaveLength(1);
    // Three calls = thumb (tier 0) + preview (tier 1) + full (tier 2).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((crypto as any).wrapTierKeyForLinkRust).toHaveBeenCalledTimes(3);
  });
});

