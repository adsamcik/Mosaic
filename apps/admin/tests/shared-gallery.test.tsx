/**
 * SharedGallery Component Tests
 *
 * Tests the SharedGallery component for anonymous share link viewing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { TierKey } from '../../src/hooks/useLinkKeys';
import type { AccessTier } from '../../src/lib/api-types';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock crypto client
const mockDecryptManifest = vi.fn();
vi.mock('../../src/lib/crypto-client', () => ({
  getCryptoClient: vi.fn(() =>
    Promise.resolve({
      decryptManifest: mockDecryptManifest,
    })
  ),
}));

// Mock @mosaic/crypto
vi.mock('@mosaic/crypto', () => ({
  fromBase64: (s: string) => new Uint8Array(Buffer.from(s, 'base64')),
  toBase64: (arr: Uint8Array) => Buffer.from(arr).toString('base64'),
}));

// Mock SharedPhotoGrid
vi.mock('../../src/components/Shared/SharedPhotoGrid', () => ({
  SharedPhotoGrid: ({ photos, accessTier }: { photos: unknown[]; accessTier: number }) => (
    <div data-testid="shared-photo-grid">
      <span data-testid="photo-count">{photos.length}</span>
      <span data-testid="grid-access-tier">{accessTier}</span>
    </div>
  ),
}));

// Import after mocks
import { SharedGallery } from '../../src/components/Shared/SharedGallery';

// Helper to create tier keys map
function createTierKeys(epochId: number, tier: AccessTier): Map<number, Map<AccessTier, TierKey>> {
  const tierMap = new Map<AccessTier, TierKey>();
  tierMap.set(tier, {
    epochId,
    tier,
    key: new Uint8Array(32).fill(1),
    signPubkey: new Uint8Array(32).fill(2),
  });
  return new Map([[epochId, tierMap]]);
}

describe('SharedGallery', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default successful photo response
    mockFetch.mockResolvedValue({
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
    mockDecryptManifest.mockResolvedValue({
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
    cleanup();
    vi.restoreAllMocks();
  });

  describe('loading states', () => {
    it('should show loading when keys are loading', () => {
      render(
        <SharedGallery
          linkId="test-link-id"
          albumId="album-123"
          accessTier={2}
          tierKeys={new Map()}
          isLoadingKeys={true}
        />
      );

      expect(screen.getByText('Loading encryption keys...')).toBeInTheDocument();
    });

    it('should show loading while fetching photos', () => {
      // Make fetch hang
      mockFetch.mockImplementation(() => new Promise(() => {}));

      render(
        <SharedGallery
          linkId="test-link-id"
          albumId="album-123"
          accessTier={2}
          tierKeys={createTierKeys(1, 2)}
          isLoadingKeys={false}
        />
      );

      expect(screen.getByText('Loading photos...')).toBeInTheDocument();
    });
  });

  describe('error states', () => {
    it('should show error when photo fetch fails', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Server error' }),
      });

      render(
        <SharedGallery
          linkId="test-link-id"
          albumId="album-123"
          accessTier={2}
          tierKeys={createTierKeys(1, 2)}
          isLoadingKeys={false}
        />
      );

      await waitFor(() => {
        expect(screen.getByText(/Failed to load photos/i)).toBeInTheDocument();
      });
    });
  });

  describe('empty state', () => {
    it('should show empty state when no photos', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [],
      });

      render(
        <SharedGallery
          linkId="test-link-id"
          albumId="album-123"
          accessTier={2}
          tierKeys={createTierKeys(1, 2)}
          isLoadingKeys={false}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('No photos in this album.')).toBeInTheDocument();
      });
    });

    it('should show empty state when all photos are deleted', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [
          {
            id: 'photo-1',
            versionCreated: 1,
            isDeleted: true, // Deleted
            encryptedMeta: btoa('meta'),
            signature: btoa('sig'),
            signerPubkey: btoa('pub'),
            shardIds: [],
          },
        ],
      });

      render(
        <SharedGallery
          linkId="test-link-id"
          albumId="album-123"
          accessTier={2}
          tierKeys={createTierKeys(1, 2)}
          isLoadingKeys={false}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('No photos in this album.')).toBeInTheDocument();
      });
    });
  });

  describe('successful rendering', () => {
    it('should render gallery header with title', async () => {
      render(
        <SharedGallery
          linkId="test-link-id"
          albumId="album-123"
          accessTier={2}
          tierKeys={createTierKeys(1, 2)}
          isLoadingKeys={false}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('shared-photo-grid')).toBeInTheDocument();
      });

      expect(screen.getByText('Shared Album')).toBeInTheDocument();
    });

    it('should display photo count', async () => {
      render(
        <SharedGallery
          linkId="test-link-id"
          albumId="album-123"
          accessTier={2}
          tierKeys={createTierKeys(1, 2)}
          isLoadingKeys={false}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('(1 photos)')).toBeInTheDocument();
      });
    });

    it('should render SharedPhotoGrid with correct props', async () => {
      render(
        <SharedGallery
          linkId="test-link-id"
          albumId="album-123"
          accessTier={2}
          tierKeys={createTierKeys(1, 2)}
          isLoadingKeys={false}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('shared-photo-grid')).toBeInTheDocument();
      });

      expect(screen.getByTestId('photo-count')).toHaveTextContent('1');
      expect(screen.getByTestId('grid-access-tier')).toHaveTextContent('2');
    });
  });

  describe('tier badges', () => {
    it.each([
      [1, 'Thumbnails'],
      [2, 'Preview'],
      [3, 'Full Access'],
    ])('should display correct badge for tier %d', async (tier, expectedText) => {
      render(
        <SharedGallery
          linkId="test-link-id"
          albumId="album-123"
          accessTier={tier as AccessTier}
          tierKeys={createTierKeys(1, tier as AccessTier)}
          isLoadingKeys={false}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('shared-photo-grid')).toBeInTheDocument();
      });

      expect(screen.getByText(expectedText)).toBeInTheDocument();
    });
  });

  describe('photo decryption', () => {
    it('should decrypt manifests using tier keys', async () => {
      const tierKeys = createTierKeys(1, 2);

      render(
        <SharedGallery
          linkId="test-link-id"
          albumId="album-123"
          accessTier={2}
          tierKeys={tierKeys}
          isLoadingKeys={false}
        />
      );

      await waitFor(() => {
        expect(mockDecryptManifest).toHaveBeenCalled();
      });
    });

    it('should skip deleted photos', async () => {
      mockFetch.mockResolvedValue({
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

      render(
        <SharedGallery
          linkId="test-link-id"
          albumId="album-123"
          accessTier={2}
          tierKeys={createTierKeys(1, 2)}
          isLoadingKeys={false}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('photo-count')).toHaveTextContent('1');
      });
    });
  });

  describe('API calls', () => {
    it('should fetch photos from correct endpoint', async () => {
      render(
        <SharedGallery
          linkId="test-link-id"
          albumId="album-123"
          accessTier={2}
          tierKeys={createTierKeys(1, 2)}
          isLoadingKeys={false}
        />
      );

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/s/test-link-id/photos');
      });
    });

    it('should not fetch until tier keys are loaded', () => {
      render(
        <SharedGallery
          linkId="test-link-id"
          albumId="album-123"
          accessTier={2}
          tierKeys={new Map()} // Empty
          isLoadingKeys={true}
        />
      );

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
