/**
 * Owner-side roster signing helper tests (batch C2c-4 — C2).
 */

import { describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  getAlbum: vi.fn(),
  publishSignedRoster: vi.fn(),
}));
const cryptoMocks = vi.hoisted(() => ({
  signManifestWithEpoch: vi.fn(),
}));
const epochMocks = vi.hoisted(() => ({
  fetchAndUnwrapEpochKeys: vi.fn(),
  getCurrentEpochKey: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    getApi: () => apiMocks,
  };
});

vi.mock('../crypto-client', () => ({
  getCryptoClient: async () => cryptoMocks,
}));

vi.mock('../epoch-key-service', () => ({
  fetchAndUnwrapEpochKeys: epochMocks.fetchAndUnwrapEpochKeys,
}));

vi.mock('../epoch-key-store', () => ({
  getCurrentEpochKey: epochMocks.getCurrentEpochKey,
}));

import { signAndPublishRoster } from '../roster-sign';

const ALBUM_A = 'a0a1a2a3-a4a5-a6a7-a8a9-aaabacadaeaf';
const MEMBER_X = '10111213-1415-1617-1819-1a1b1c1d1e1f';
const MEMBER_Y = '20212223-2425-2627-2829-2a2b2c2d2e2f';

function resetMocks() {
  vi.clearAllMocks();
  epochMocks.fetchAndUnwrapEpochKeys.mockResolvedValue(undefined);
  epochMocks.getCurrentEpochKey.mockReturnValue({
    epochId: 7,
    epochHandleId: 'epch_test',
    signPublicKey: new Uint8Array(32).fill(9),
  });
  cryptoMocks.signManifestWithEpoch.mockResolvedValue(new Uint8Array(64).fill(0xab));
  apiMocks.getAlbum.mockResolvedValue({
    id: ALBUM_A,
    ownerId: '00000000-0000-0000-0000-000000000001',
    currentVersion: 1,
    currentEpochId: 7,
    createdAt: new Date().toISOString(),
    memberRosterVersion: null,
  });
  apiMocks.publishSignedRoster.mockResolvedValue(undefined);
}

describe('signAndPublishRoster', () => {
  it('signs the canonical transcript and POSTs the signed roster', async () => {
    resetMocks();
    const result = await signAndPublishRoster(ALBUM_A, [
      { userId: MEMBER_X, role: 'editor' },
      { userId: MEMBER_Y, role: 'viewer' },
    ]);

    expect(result).toEqual({ rosterVersion: 1, signerEpochId: 7 });

    expect(epochMocks.fetchAndUnwrapEpochKeys).toHaveBeenCalledWith(ALBUM_A);
    expect(cryptoMocks.signManifestWithEpoch).toHaveBeenCalledTimes(1);
    const [handleArg, transcriptArg] = cryptoMocks.signManifestWithEpoch.mock.calls[0]!;
    expect(handleArg).toBe('epch_test');
    // Transcript = 55 (header) + 2 * 17 (members) = 89 bytes
    expect((transcriptArg as Uint8Array).length).toBe(89);

    expect(apiMocks.publishSignedRoster).toHaveBeenCalledTimes(1);
    const [albumArg, body] = apiMocks.publishSignedRoster.mock.calls[0]!;
    expect(albumArg).toBe(ALBUM_A);
    expect(body.rosterVersion).toBe(1);
    expect(body.signerEpochId).toBe(7);
    // Base64 of 64 bytes is 88 chars
    expect(typeof body.signature).toBe('string');
    expect(body.signature.length).toBe(88);
    expect(body.members).toEqual([
      { userId: MEMBER_X, roleByte: 2 },
      { userId: MEMBER_Y, roleByte: 3 },
    ]);
  });

  it('strictly increases the rosterVersion when the server already has one', async () => {
    resetMocks();
    apiMocks.getAlbum.mockResolvedValue({
      id: ALBUM_A,
      ownerId: '00000000-0000-0000-0000-000000000001',
      currentVersion: 1,
      currentEpochId: 7,
      createdAt: new Date().toISOString(),
      memberRosterVersion: 4,
    });

    const result = await signAndPublishRoster(ALBUM_A, [
      { userId: MEMBER_X, role: 'editor' },
    ]);

    expect(result.rosterVersion).toBe(5);
    expect(apiMocks.publishSignedRoster.mock.calls[0]![1].rosterVersion).toBe(5);
  });

  it('throws on unknown member role string and does not call sign/publish', async () => {
    resetMocks();
    await expect(
      signAndPublishRoster(ALBUM_A, [{ userId: MEMBER_X, role: 'admin' }]),
    ).rejects.toThrow(/unknown member role/);
    expect(cryptoMocks.signManifestWithEpoch).not.toHaveBeenCalled();
    expect(apiMocks.publishSignedRoster).not.toHaveBeenCalled();
  });

  it('throws when the current epoch key is not cached', async () => {
    resetMocks();
    epochMocks.getCurrentEpochKey.mockReturnValue(null);
    await expect(
      signAndPublishRoster(ALBUM_A, [{ userId: MEMBER_X, role: 'owner' }]),
    ).rejects.toThrow(/no epoch key/);
    expect(cryptoMocks.signManifestWithEpoch).not.toHaveBeenCalled();
  });

  it('rejects a non-64-byte worker signature output (defense in depth)', async () => {
    resetMocks();
    cryptoMocks.signManifestWithEpoch.mockResolvedValueOnce(new Uint8Array(63));
    await expect(
      signAndPublishRoster(ALBUM_A, [{ userId: MEMBER_X, role: 'owner' }]),
    ).rejects.toThrow(/expected 64/);
    expect(apiMocks.publishSignedRoster).not.toHaveBeenCalled();
  });
});
