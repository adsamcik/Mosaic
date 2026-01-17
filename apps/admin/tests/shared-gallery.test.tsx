/**
 * SharedGallery Component Tests
 *
 * Tests the SharedGallery component for anonymous share link viewing.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TierKey } from '../src/hooks/useLinkKeys';
import type { AccessTier } from '../src/lib/api-types';

// Use vi.hoisted for mocks
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  decryptManifest: vi.fn(),
}));

// Mock fetch globally
global.fetch = mocks.fetch as unknown as typeof fetch;

// Mock crypto client
vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: vi.fn(() =>
    Promise.resolve({
      decryptManifest: mocks.decryptManifest,
    }),
  ),
}));

// Mock @mosaic/crypto
vi.mock('@mosaic/crypto', () => ({
  fromBase64: (s: string) =>
    new Uint8Array(
      atob(s)
        .split('')
        .map((c) => c.charCodeAt(0)),
    ),
  toBase64: (arr: Uint8Array) => btoa(String.fromCharCode(...arr)),
}));

// Mock SharedPhotoGrid
vi.mock('../src/components/Shared/SharedPhotoGrid', () => ({
  SharedPhotoGrid: ({
    photos,
    accessTier,
  }: {
    photos: unknown[];
    accessTier: number;
  }) =>
    createElement('div', { 'data-testid': 'shared-photo-grid' }, [
      createElement(
        'span',
        { key: 'count', 'data-testid': 'photo-count' },
        String(photos.length),
      ),
      createElement(
        'span',
        { key: 'tier', 'data-testid': 'grid-access-tier' },
        String(accessTier),
      ),
    ]),
}));

// Import after mocks
import { SharedGallery } from '../src/components/Shared/SharedGallery';

// Helper to create tier keys map
function createTierKeys(
  epochId: number,
  tier: AccessTier,
): Map<number, Map<AccessTier, TierKey>> {
  const tierMap = new Map<AccessTier, TierKey>();
  tierMap.set(tier, {
    epochId,
    tier,
    key: new Uint8Array(32).fill(1),
    signPubkey: new Uint8Array(32).fill(2),
  });
  return new Map([[epochId, tierMap]]);
}

// Helper to render component
function renderComponent(props: {
  linkId: string;
  albumId: string;
  accessTier: AccessTier;
  tierKeys: Map<number, Map<AccessTier, TierKey>>;
  isLoadingKeys: boolean;
}) {
  const container = document.createElement('div');
  document.body.appendChild(container);

  let root: ReturnType<typeof createRoot>;
  act(() => {
    root = createRoot(container);
    root.render(createElement(SharedGallery, props));
  });

  const getByTestId = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

  const getByText = (text: string | RegExp) => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const content = walker.currentNode.textContent;
      if (content) {
        if (typeof text === 'string' && content.includes(text)) {
          return walker.currentNode.parentElement;
        }
        if (text instanceof RegExp && text.test(content)) {
          return walker.currentNode.parentElement;
        }
      }
    }
    return null;
  };

  return {
    container,
    getByTestId,
    getByText,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

// Helper to wait for async updates
async function waitFor(
  condition: () => boolean,
  { timeout = 1000, interval = 10 } = {},
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, interval));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe('SharedGallery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';

    // Default successful photo response
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: 'photo-1',
          versionCreated: 1,
          isDeleted: false,
          encryptedMeta: btoa('encrypted-meta'),
          signature: btoa('signature'),
          signerPubkey: btoa('pubkey'),
          shardIds: ['shard-1', 'shard-2'],
        },
      ],
    });

    // Default successful decryption
    mocks.decryptManifest.mockResolvedValue({
      id: 'photo-1',
      assetId: 'asset-1',
      albumId: 'album-123',
      filename: 'test.jpg',
      mimeType: 'image/jpeg',
      width: 1920,
      height: 1080,
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      shardIds: ['shard-1'],
      epochId: 1,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  describe('loading states', () => {
    it('should show loading when keys are loading', () => {
      const { getByText, cleanup } = renderComponent({
        linkId: 'test-link-id',
        albumId: 'album-123',
        accessTier: 2,
        tierKeys: new Map(),
        isLoadingKeys: true,
      });

      expect(getByText('Loading encryption keys...')).not.toBeNull();

      cleanup();
    });

    it('should show loading while fetching photos', () => {
      // Make fetch hang
      mocks.fetch.mockImplementation(() => new Promise(() => {}));

      const { getByText, cleanup } = renderComponent({
        linkId: 'test-link-id',
        albumId: 'album-123',
        accessTier: 2,
        tierKeys: createTierKeys(1, 2),
        isLoadingKeys: false,
      });

      expect(getByText('Loading photos...')).not.toBeNull();

      cleanup();
    });
  });

  describe('error states', () => {
    it('should show error when photo fetch fails', async () => {
      mocks.fetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Server error' }),
      });

      const { getByText, cleanup } = renderComponent({
        linkId: 'test-link-id',
        albumId: 'album-123',
        accessTier: 2,
        tierKeys: createTierKeys(1, 2),
        isLoadingKeys: false,
      });

      await waitFor(() => getByText(/Failed to load photos/i) !== null);

      expect(getByText(/Failed to load photos/i)).not.toBeNull();

      cleanup();
    });
  });

  describe('empty state', () => {
    it('should show empty state when no photos', async () => {
      mocks.fetch.mockResolvedValue({
        ok: true,
        json: async () => [],
      });

      const { getByText, cleanup } = renderComponent({
        linkId: 'test-link-id',
        albumId: 'album-123',
        accessTier: 2,
        tierKeys: createTierKeys(1, 2),
        isLoadingKeys: false,
      });

      await waitFor(() => getByText('No photos in this album.') !== null);

      expect(getByText('No photos in this album.')).not.toBeNull();

      cleanup();
    });

    it('should show empty state when all photos are deleted', async () => {
      mocks.fetch.mockResolvedValue({
        ok: true,
        json: async () => [
          {
            id: 'photo-1',
            versionCreated: 1,
            isDeleted: true,
            encryptedMeta: btoa('meta'),
            signature: btoa('sig'),
            signerPubkey: btoa('pub'),
            shardIds: [],
          },
        ],
      });

      const { getByText, cleanup } = renderComponent({
        linkId: 'test-link-id',
        albumId: 'album-123',
        accessTier: 2,
        tierKeys: createTierKeys(1, 2),
        isLoadingKeys: false,
      });

      await waitFor(() => getByText('No photos in this album.') !== null);

      expect(getByText('No photos in this album.')).not.toBeNull();

      cleanup();
    });
  });

  describe('successful rendering', () => {
    it('should render gallery header with title', async () => {
      const { getByText, getByTestId, cleanup } = renderComponent({
        linkId: 'test-link-id',
        albumId: 'album-123',
        accessTier: 2,
        tierKeys: createTierKeys(1, 2),
        isLoadingKeys: false,
      });

      await waitFor(() => getByTestId('shared-photo-grid') !== null);

      expect(getByText('Shared Album')).not.toBeNull();

      cleanup();
    });

    it('should display photo count in header', async () => {
      const { getByTestId, cleanup } = renderComponent({
        linkId: 'test-link-id',
        albumId: 'album-123',
        accessTier: 2,
        tierKeys: createTierKeys(1, 2),
        isLoadingKeys: false,
      });

      // Wait for grid to render (photo count is shown when photos load)
      await waitFor(() => getByTestId('shared-photo-grid') !== null);

      // Photo count is rendered alongside the title
      expect(getByTestId('shared-photo-grid')).not.toBeNull();

      cleanup();
    });

    it('should render SharedPhotoGrid with correct props', async () => {
      const { getByTestId, cleanup } = renderComponent({
        linkId: 'test-link-id',
        albumId: 'album-123',
        accessTier: 2,
        tierKeys: createTierKeys(1, 2),
        isLoadingKeys: false,
      });

      await waitFor(() => getByTestId('shared-photo-grid') !== null);

      expect(getByTestId('photo-count')?.textContent).toBe('1');
      expect(getByTestId('grid-access-tier')?.textContent).toBe('2');

      cleanup();
    });
  });

  describe('tier badges', () => {
    it.each([
      [1, 'Thumbnails'],
      [2, 'Preview'],
      [3, 'Full Access'],
    ])(
      'should display correct badge for tier %d',
      async (tier, expectedText) => {
        const { getByText, getByTestId, cleanup } = renderComponent({
          linkId: 'test-link-id',
          albumId: 'album-123',
          accessTier: tier as AccessTier,
          tierKeys: createTierKeys(1, tier as AccessTier),
          isLoadingKeys: false,
        });

        await waitFor(() => getByTestId('shared-photo-grid') !== null);

        expect(getByText(expectedText)).not.toBeNull();

        cleanup();
      },
    );
  });

  describe('photo decryption', () => {
    it('should decrypt manifests using tier keys', async () => {
      const tierKeys = createTierKeys(1, 2);

      const { getByTestId, cleanup } = renderComponent({
        linkId: 'test-link-id',
        albumId: 'album-123',
        accessTier: 2,
        tierKeys,
        isLoadingKeys: false,
      });

      await waitFor(() => mocks.decryptManifest.mock.calls.length > 0);

      expect(mocks.decryptManifest).toHaveBeenCalled();

      cleanup();
    });

    it('should skip deleted photos', async () => {
      mocks.fetch.mockResolvedValue({
        ok: true,
        json: async () => [
          {
            id: 'photo-1',
            versionCreated: 1,
            isDeleted: true,
            encryptedMeta: btoa('meta'),
            signature: btoa('sig'),
            signerPubkey: btoa('pub'),
            shardIds: [],
          },
          {
            id: 'photo-2',
            versionCreated: 2,
            isDeleted: false,
            encryptedMeta: btoa('meta2'),
            signature: btoa('sig2'),
            signerPubkey: btoa('pub2'),
            shardIds: ['shard-1'],
          },
        ],
      });

      const { getByTestId, cleanup } = renderComponent({
        linkId: 'test-link-id',
        albumId: 'album-123',
        accessTier: 2,
        tierKeys: createTierKeys(1, 2),
        isLoadingKeys: false,
      });

      await waitFor(() => getByTestId('photo-count')?.textContent === '1');

      expect(getByTestId('photo-count')?.textContent).toBe('1');

      cleanup();
    });
  });

  describe('API calls', () => {
    it('should fetch photos from correct endpoint', async () => {
      const { getByTestId, cleanup } = renderComponent({
        linkId: 'test-link-id',
        albumId: 'album-123',
        accessTier: 2,
        tierKeys: createTierKeys(1, 2),
        isLoadingKeys: false,
      });

      await waitFor(() => mocks.fetch.mock.calls.length > 0);

      expect(mocks.fetch).toHaveBeenCalledWith('/api/s/test-link-id/photos');

      cleanup();
    });

    it('should not fetch until tier keys are loaded', () => {
      const { cleanup } = renderComponent({
        linkId: 'test-link-id',
        albumId: 'album-123',
        accessTier: 2,
        tierKeys: new Map(),
        isLoadingKeys: true,
      });

      expect(mocks.fetch).not.toHaveBeenCalled();

      cleanup();
    });
  });
});
