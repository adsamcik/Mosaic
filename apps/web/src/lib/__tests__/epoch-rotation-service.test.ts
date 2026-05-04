/**
 * Epoch Rotation Service - Security Tests (P-W7.6)
 *
 * Share-link rewrap imports Rust-owned link-share handles from URL fragment
 * seeds. Derived wrapping keys never cross into JavaScript.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShareLinkWithSecretResponse } from '../api-types';

const captured: {
  linkSecrets: Uint8Array[];
} = { linkSecrets: [] };

function nonZero(size: number, fill: number): Uint8Array {
  const buf = new Uint8Array(size);
  buf.fill(fill);
  return buf;
}

// ---------------------------------------------------------------------------
// Mocks (registered before the SUT import)
// ---------------------------------------------------------------------------

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
  vi.clearAllMocks();

  mockGetCryptoClient.mockResolvedValue({
    unwrapWithAccountKey: vi.fn(async () => {
      const secret = nonZero(32, 0xc1);
      captured.linkSecrets.push(secret);
      return secret;
    }),
    importLinkShareHandle: vi.fn(async () => ({
      linkShareHandleId: 'lnks_test-handle-id',
      linkId: nonZero(16, 0xb1),
    })),
    wrapLinkTierHandle: vi.fn(async (_linkHandle: string, _epochHandle: string, tier: number) => ({
      tier,
      nonce: new Uint8Array(24).fill(tier),
      encryptedKey: new Uint8Array(48).fill(tier),
    })),
    closeLinkShareHandle: vi.fn(async () => undefined),
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wrapKeysForShareLinks (P-W7.6 handle material)', () => {
  it('zeros per-link URL fragment seed after successful wrapping', async () => {
    const links = [makeShareLink({ id: 'link-a', accessTier: 3 })];

    const results = await wrapKeysForShareLinks(links, TEST_EPOCH_HANDLE_ID);

    expect(results).toHaveLength(1);
    expect(captured.linkSecrets).toHaveLength(1);
    expect(captured.linkSecrets[0]!.every((b) => b === 0)).toBe(true);
  });

  it('routes tier-key wrapping through the worker handle (no JS-side tier keys)', async () => {
    const crypto = await mockGetCryptoClient();
    const links = [makeShareLink({ id: 'link-a', accessTier: 3 })];

    const results = await wrapKeysForShareLinks(links, TEST_EPOCH_HANDLE_ID);

    expect(results).toHaveLength(1);
    // Three calls = thumb (tier 1) + preview (tier 2) + full (tier 3).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((crypto as any).wrapLinkTierHandle).toHaveBeenCalledTimes(3);
  });
});


