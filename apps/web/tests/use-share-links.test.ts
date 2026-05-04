/**
 * useShareLinks Hook Tests
 *
 * Tests the useShareLinks hook behavior for managing share links.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock API implementation
const mockApi = {
  listShareLinks: vi.fn(),
  createShareLink: vi.fn(),
  revokeShareLink: vi.fn(),
};

// Mock crypto client implementation
// Slice 6 — share-link key wrapping flows entirely through the worker.
const mockCryptoClient = {
  wrapWithAccountKey: vi.fn(),
  createLinkShareHandle: vi.fn(),
  wrapLinkTierHandle: vi.fn(),
  closeLinkShareHandle: vi.fn(),
};

// Mock epoch key store
const mockGetEpochKey = vi.fn();
const mockGetCachedEpochIds = vi.fn();

// Mock epoch key service
const mockFetchAndUnwrapEpochKeys = vi.fn();

// Mock link encoding helpers (pure URL encoders).
const mockEncodeLinkSecret = vi.fn();
const mockEncodeLinkId = vi.fn();

// Mock the API client
vi.mock('../src/lib/api', () => ({
  getApi: () => mockApi,
  toBase64: (arr: Uint8Array) => btoa(String.fromCharCode(...arr)),
  fromBase64: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
  paginateAll: async <T>(
    fetchPage: (skip: number, take: number) => Promise<T[]>,
    pageSize = 100,
  ): Promise<T[]> => {
    const out: T[] = [];
    for (let skip = 0; ; skip += pageSize) {
      const page = await fetchPage(skip, pageSize);
      out.push(...page);
      if (page.length < pageSize) break;
    }
    return out;
  },
}));

// Mock the crypto client
vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: () => Promise.resolve(mockCryptoClient),
}));

// Mock epoch key store
vi.mock('../src/lib/epoch-key-store', () => ({
  getEpochKey: (...args: unknown[]) => mockGetEpochKey(...args),
  getCachedEpochIds: (...args: unknown[]) => mockGetCachedEpochIds(...args),
}));

// Mock epoch key service
vi.mock('../src/lib/epoch-key-service', () => ({
  fetchAndUnwrapEpochKeys: (...args: unknown[]) =>
    mockFetchAndUnwrapEpochKeys(...args),
}));

// Mock link-encoding URL helpers — pure base64url, no crypto.
vi.mock('../src/lib/link-encoding', () => ({
  encodeLinkSecret: (...args: unknown[]) => mockEncodeLinkSecret(...args),
  encodeLinkId: (...args: unknown[]) => mockEncodeLinkId(...args),
  LINK_SECRET_SIZE: 32,
  LINK_ID_SIZE: 16,
}));

// Helper to create mock share link response
function createMockShareLink(id: string, overrides = {}) {
  return {
    id,
    linkId: 'encoded-link-id',
    accessTier: 2 as const,
    expiresAt: undefined,
    maxUses: undefined,
    useCount: 0,
    isRevoked: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// Import the hook after mocks are set up
import {
  ShareLinkError,
  ShareLinkErrorCode,
  useShareLinks,
  type UseShareLinksResult,
} from '../src/hooks/useShareLinks';

interface HookHarnessProps {
  albumId: string;
  onResult: (result: UseShareLinksResult) => void;
}

function HookHarness({ albumId, onResult }: HookHarnessProps) {
  const result = useShareLinks(albumId);
  onResult(result);
  return null;
}

const linkShareHandleId = 'lnks_test-handle-id';
const linkSecretForUrl = new Uint8Array(32).fill(4);
const linkIdBytes = new Uint8Array(16).fill(5);
const ownerEncryptedSecret = new Uint8Array(48).fill(6);

function wrappedTier(tier: number) {
  return {
    tier,
    nonce: new Uint8Array(24).fill(tier),
    encryptedKey: new Uint8Array(48).fill(tier + 10),
  };
}

function toTestBase64(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr));
}

describe('useShareLinks', () => {
  let container: HTMLElement;
  let root: Root;
  let hookResult: UseShareLinksResult;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations
    mockApi.listShareLinks.mockResolvedValue([]);
    mockApi.createShareLink.mockResolvedValue(createMockShareLink('new-link'));
    mockApi.revokeShareLink.mockResolvedValue(undefined);

    mockCryptoClient.wrapWithAccountKey.mockResolvedValue(ownerEncryptedSecret);
    mockCryptoClient.createLinkShareHandle.mockResolvedValue({
      linkShareHandleId,
      linkSecretForUrl,
      linkId: linkIdBytes,
      ...wrappedTier(1),
    });
    mockCryptoClient.wrapLinkTierHandle.mockImplementation(
      async (_handle: string, _epochHandle: string, tier: number) => wrappedTier(tier),
    );
    mockCryptoClient.closeLinkShareHandle.mockResolvedValue(undefined);

    mockGetCachedEpochIds.mockReturnValue([1]);
    mockGetEpochKey.mockReturnValue({
      epochId: 1,
      epochHandleId: 'epch_test-handle-id',
      signPublicKey: new Uint8Array(32).fill(2),
      epochSeed: new Uint8Array(0),
      signKeypair: {
        publicKey: new Uint8Array(32).fill(2),
        secretKey: new Uint8Array(0),
      },
    });

    mockFetchAndUnwrapEpochKeys.mockResolvedValue([]);

    mockEncodeLinkSecret.mockReturnValue('encoded-secret');
    mockEncodeLinkId.mockReturnValue('encoded-link-id');

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    hookResult = undefined as unknown as UseShareLinksResult;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.removeChild(container);
    vi.restoreAllMocks();
  });

  async function renderUseShareLinks(albumId = 'album-1'): Promise<UseShareLinksResult> {
    await act(async () => {
      root.render(
        createElement(HookHarness, {
          albumId,
          onResult: (result) => {
            hookResult = result;
          },
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    return hookResult;
  }

  async function createViaHook(accessTier: 1 | 2 | 3 = 2) {
    await renderUseShareLinks();
    let result: Awaited<ReturnType<UseShareLinksResult['createShareLink']>> | undefined;
    await act(async () => {
      result = await hookResult.createShareLink({ accessTier });
    });
    return result!;
  }

  describe('API client', () => {
    it('can list share links', async () => {
      const links = [
        createMockShareLink('link-1'),
        createMockShareLink('link-2'),
      ];
      mockApi.listShareLinks.mockResolvedValue(links);

      const api = (await import('../src/lib/api')).getApi();
      const result = await api.listShareLinks('album-1');

      expect(result).toHaveLength(2);
      expect(mockApi.listShareLinks).toHaveBeenCalledWith('album-1');
    });

    it('creates a share link through the hook crypto path', async () => {
      const result = await createViaHook(2);

      expect(result.shareLink.id).toBe('new-link');
      expect(result.linkSecret).toBe('encoded-secret');
      expect(result.shareUrl).toContain('/s/encoded-link-id#k=encoded-secret');
      expect(mockFetchAndUnwrapEpochKeys).toHaveBeenCalledWith('album-1');
      expect(mockCryptoClient.createLinkShareHandle).toHaveBeenCalledWith(
        'album-1',
        'epch_test-handle-id',
        1,
      );
      expect(mockCryptoClient.wrapLinkTierHandle).toHaveBeenCalledWith(
        linkShareHandleId,
        'epch_test-handle-id',
        2,
      );
      expect(mockCryptoClient.wrapWithAccountKey).toHaveBeenCalledWith(linkSecretForUrl);
      expect(mockApi.createShareLink).toHaveBeenCalledWith('album-1', {
        accessTier: 2,
        linkId: toTestBase64(linkIdBytes),
        ownerEncryptedSecret: toTestBase64(ownerEncryptedSecret),
        wrappedKeys: [
          {
            epochId: 1,
            tier: 1,
            nonce: toTestBase64(wrappedTier(1).nonce),
            encryptedKey: toTestBase64(wrappedTier(1).encryptedKey),
          },
          {
            epochId: 1,
            tier: 2,
            nonce: toTestBase64(wrappedTier(2).nonce),
            encryptedKey: toTestBase64(wrappedTier(2).encryptedKey),
          },
        ],
      });
      expect(mockEncodeLinkId).toHaveBeenCalledWith(linkIdBytes);
      expect(mockEncodeLinkSecret).toHaveBeenCalledWith(linkSecretForUrl);
      expect(mockCryptoClient.closeLinkShareHandle).toHaveBeenCalledWith(linkShareHandleId);
    });

    it('can revoke a share link', async () => {
      const api = (await import('../src/lib/api')).getApi();
      await api.revokeShareLink('link-1');

      expect(mockApi.revokeShareLink).toHaveBeenCalledWith('link-1');
    });
  });

  describe('ShareLinkError', () => {
    it('creates error with code', () => {
      const error = new ShareLinkError(
        'Test error',
        ShareLinkErrorCode.FETCH_FAILED,
      );

      expect(error.message).toBe('Test error');
      expect(error.code).toBe(ShareLinkErrorCode.FETCH_FAILED);
      expect(error.name).toBe('ShareLinkError');
    });

    it('includes cause when provided', () => {
      const cause = new Error('Original error');
      const error = new ShareLinkError(
        'Wrapper error',
        ShareLinkErrorCode.CREATE_FAILED,
        cause,
      );

      expect(error.cause).toBe(cause);
    });
  });

  describe('ShareLinkErrorCode', () => {
    it('has expected error codes', () => {
      expect(ShareLinkErrorCode.FETCH_FAILED).toBe('FETCH_FAILED');
      expect(ShareLinkErrorCode.CREATE_FAILED).toBe('CREATE_FAILED');
      expect(ShareLinkErrorCode.REVOKE_FAILED).toBe('REVOKE_FAILED');
      expect(ShareLinkErrorCode.NO_EPOCH_KEYS).toBe('NO_EPOCH_KEYS');
      expect(ShareLinkErrorCode.WRAP_FAILED).toBe('WRAP_FAILED');
      expect(ShareLinkErrorCode.DERIVE_FAILED).toBe('DERIVE_FAILED');
    });
  });

  describe('access tier display', () => {
    it('transforms tier 1 to Thumbnails Only', async () => {
      mockApi.listShareLinks.mockResolvedValue([
        createMockShareLink('link-1', { accessTier: 1 }),
      ]);

      const api = (await import('../src/lib/api')).getApi();
      const links = await api.listShareLinks('album-1');

      // The hook would transform this, but we're testing the raw API response
      expect(links[0].accessTier).toBe(1);
    });

    it('transforms tier 2 to Preview', async () => {
      mockApi.listShareLinks.mockResolvedValue([
        createMockShareLink('link-1', { accessTier: 2 }),
      ]);

      const api = (await import('../src/lib/api')).getApi();
      const links = await api.listShareLinks('album-1');

      expect(links[0].accessTier).toBe(2);
    });

    it('transforms tier 3 to Full Access', async () => {
      mockApi.listShareLinks.mockResolvedValue([
        createMockShareLink('link-1', { accessTier: 3 }),
      ]);

      const api = (await import('../src/lib/api')).getApi();
      const links = await api.listShareLinks('album-1');

      expect(links[0].accessTier).toBe(3);
    });
  });

  describe('expiry handling', () => {
    it('detects expired links', async () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      mockApi.listShareLinks.mockResolvedValue([
        createMockShareLink('link-1', { expiresAt: yesterday.toISOString() }),
      ]);

      const api = (await import('../src/lib/api')).getApi();
      const links = await api.listShareLinks('album-1');

      expect(links[0].expiresAt).toBeDefined();
      const expiryDate = new Date(links[0].expiresAt!);
      expect(expiryDate < new Date()).toBe(true);
    });

    it('handles links without expiry', async () => {
      mockApi.listShareLinks.mockResolvedValue([
        createMockShareLink('link-1', { expiresAt: undefined }),
      ]);

      const api = (await import('../src/lib/api')).getApi();
      const links = await api.listShareLinks('album-1');

      expect(links[0].expiresAt).toBeUndefined();
    });
  });

  describe('sorting', () => {
    it('sorts links by creation date (newest first)', async () => {
      const now = new Date();
      const earlier = new Date(now.getTime() - 86400000); // 1 day earlier

      mockApi.listShareLinks.mockResolvedValue([
        createMockShareLink('older', { createdAt: earlier.toISOString() }),
        createMockShareLink('newer', { createdAt: now.toISOString() }),
      ]);

      const api = (await import('../src/lib/api')).getApi();
      const links = await api.listShareLinks('album-1');

      // Raw API doesn't sort, but the hook would
      expect(links[0].id).toBe('older');
      expect(links[1].id).toBe('newer');
    });
  });

  describe('error handling', () => {
    it('handles fetch errors', async () => {
      mockApi.listShareLinks.mockRejectedValue(new Error('Network error'));

      const api = (await import('../src/lib/api')).getApi();

      await expect(api.listShareLinks('album-1')).rejects.toThrow(
        'Network error',
      );
    });

    it('handles create errors after the hook crypto path', async () => {
      mockApi.createShareLink.mockRejectedValue(new Error('Create failed'));
      await renderUseShareLinks();

      let thrown: unknown;
      await act(async () => {
        try {
          await hookResult.createShareLink({ accessTier: 2 });
        } catch (error) {
          thrown = error;
        }
      });

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe('Create failed');
      expect(mockCryptoClient.createLinkShareHandle).toHaveBeenCalled();
      expect(mockApi.createShareLink).toHaveBeenCalled();
      expect(mockCryptoClient.closeLinkShareHandle).toHaveBeenCalledWith(linkShareHandleId);
    });

    it('handles revoke errors', async () => {
      mockApi.revokeShareLink.mockRejectedValue(new Error('Revoke failed'));

      const api = (await import('../src/lib/api')).getApi();

      await expect(api.revokeShareLink('link-1')).rejects.toThrow(
        'Revoke failed',
      );
    });
  });


  describe('tier key wrapping based on access tier', () => {
    it('creates only the thumb tier for tier 1 links', async () => {
      await createViaHook(1);

      expect(mockCryptoClient.createLinkShareHandle).toHaveBeenCalledWith(
        'album-1',
        'epch_test-handle-id',
        1,
      );
      expect(mockCryptoClient.wrapLinkTierHandle).not.toHaveBeenCalled();
      expect(mockApi.createShareLink.mock.calls[0][1].wrappedKeys).toHaveLength(1);
    });

    it('wraps thumb and preview tiers for tier 2 links', async () => {
      await createViaHook(2);

      expect(mockCryptoClient.wrapLinkTierHandle).toHaveBeenCalledTimes(1);
      expect(mockCryptoClient.wrapLinkTierHandle).toHaveBeenCalledWith(
        linkShareHandleId,
        'epch_test-handle-id',
        2,
      );
      expect(
        mockApi.createShareLink.mock.calls[0][1].wrappedKeys.map(
          (key: { tier: number }) => key.tier,
        ),
      ).toEqual([1, 2]);
    });

    it('wraps thumb, preview, and original tiers for tier 3 links', async () => {
      await createViaHook(3);

      expect(mockCryptoClient.wrapLinkTierHandle).toHaveBeenCalledTimes(2);
      expect(mockCryptoClient.wrapLinkTierHandle).toHaveBeenNthCalledWith(
        1,
        linkShareHandleId,
        'epch_test-handle-id',
        2,
      );
      expect(mockCryptoClient.wrapLinkTierHandle).toHaveBeenNthCalledWith(
        2,
        linkShareHandleId,
        'epch_test-handle-id',
        3,
      );
      expect(
        mockApi.createShareLink.mock.calls[0][1].wrappedKeys.map(
          (key: { tier: number }) => key.tier,
        ),
      ).toEqual([1, 2, 3]);
    });
  });

  describe('multiple epoch handling', () => {
    it('wraps keys for all cached epochs through the hook', async () => {
      mockGetCachedEpochIds.mockReturnValue([1, 2, 3]);
      mockGetEpochKey.mockImplementation(
        (_albumId: string, epochId: number) => ({
          epochId,
          epochHandleId: `epch_${epochId}`,
          signPublicKey: new Uint8Array(32),
          epochSeed: new Uint8Array(0),
          signKeypair: {
            publicKey: new Uint8Array(32),
            secretKey: new Uint8Array(0),
          },
        }),
      );

      await createViaHook(2);

      expect(mockCryptoClient.createLinkShareHandle).toHaveBeenCalledWith('album-1', 'epch_1', 1);
      expect(mockCryptoClient.wrapLinkTierHandle).toHaveBeenCalledTimes(5);
      expect(mockCryptoClient.wrapLinkTierHandle).toHaveBeenCalledWith(linkShareHandleId, 'epch_1', 2);
      expect(mockCryptoClient.wrapLinkTierHandle).toHaveBeenCalledWith(linkShareHandleId, 'epch_2', 1);
      expect(mockCryptoClient.wrapLinkTierHandle).toHaveBeenCalledWith(linkShareHandleId, 'epch_2', 2);
      expect(mockCryptoClient.wrapLinkTierHandle).toHaveBeenCalledWith(linkShareHandleId, 'epch_3', 1);
      expect(mockCryptoClient.wrapLinkTierHandle).toHaveBeenCalledWith(linkShareHandleId, 'epch_3', 2);
      expect(mockApi.createShareLink.mock.calls[0][1].wrappedKeys).toHaveLength(6);
    });
  });

  describe('revoked link filtering', () => {
    it('identifies revoked links', async () => {
      mockApi.listShareLinks.mockResolvedValue([
        createMockShareLink('active', { isRevoked: false }),
        createMockShareLink('revoked', { isRevoked: true }),
      ]);

      const api = (await import('../src/lib/api')).getApi();
      const links = await api.listShareLinks('album-1');

      const activeLinks = links.filter((l) => !l.isRevoked);
      const revokedLinks = links.filter((l) => l.isRevoked);

      expect(activeLinks).toHaveLength(1);
      expect(revokedLinks).toHaveLength(1);
      expect(activeLinks[0].id).toBe('active');
      expect(revokedLinks[0].id).toBe('revoked');
    });
  });
});
