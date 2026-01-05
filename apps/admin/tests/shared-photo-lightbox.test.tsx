/**
 * SharedPhotoLightbox Component Tests
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import type { PhotoMeta } from '../src/workers/types';

// Mock crypto client - use vi.hoisted to avoid hoisting issues
const { mockDecryptShardWithTierKey, mockPeekHeader, mockCryptoClient } = vi.hoisted(() => {
  const mockDecryptShardWithTierKey = vi.fn(() => Promise.resolve(new Uint8Array(10)));
  // Default: return tier 2 (preview) for all shards
  const mockPeekHeader = vi.fn(() => Promise.resolve({ epochId: 1, shardId: 0, tier: 2 }));
  const mockCryptoClient = {
    decryptShard: vi.fn(() => Promise.resolve(new Uint8Array(10))),
    decryptShardWithTierKey: mockDecryptShardWithTierKey,
    peekHeader: mockPeekHeader,
  };
  return { mockDecryptShardWithTierKey, mockPeekHeader, mockCryptoClient };
});

vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: vi.fn(() => Promise.resolve(mockCryptoClient)),
}));

// Mock shard service - use vi.hoisted
const { mockDownloadShard } = vi.hoisted(() => {
  const mockDownloadShard = vi.fn(() => Promise.resolve(new Uint8Array(10)));
  return { mockDownloadShard };
});

vi.mock('../src/lib/shard-service', () => ({
  downloadShardViaShareLink: mockDownloadShard,
}));

// Import component after mocks are set up
import { SharedPhotoLightbox } from '../src/components/Shared/SharedPhotoLightbox';

// Mock URL.createObjectURL and URL.revokeObjectURL
const mockCreateObjectURL = vi.fn(() => 'blob:mock-url');
const mockRevokeObjectURL = vi.fn();
global.URL.createObjectURL = mockCreateObjectURL;
global.URL.revokeObjectURL = mockRevokeObjectURL;

describe('SharedPhotoLightbox', () => {
  let container: HTMLElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    mockDecryptShardWithTierKey.mockClear();
    mockPeekHeader.mockClear();
    // Reset to default behavior: tier 2 (preview) shards
    mockPeekHeader.mockResolvedValue({ epochId: 1, shardId: 0, tier: 2 });
    mockDownloadShard.mockClear();
    mockCreateObjectURL.mockClear();
    mockRevokeObjectURL.mockClear();
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
    }
    if (container) {
      container.remove();
    }
    container = null;
    root = null;
    vi.clearAllMocks();
  });

  const mockPhoto: PhotoMeta = {
    id: 'photo-1',
    assetId: 'asset-1',
    albumId: 'album-1',
    filename: 'test.jpg',
    mimeType: 'image/jpeg',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    width: 800,
    height: 600,
    epochId: 1,
    shardIds: ['shard-1'],
    tags: [],
  };

  // Create a base64 encoded tiny image for thumbnail testing
  // This is a 1x1 pixel JPEG
  const tinyJpegBase64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+gD/2Q==';

  const mockPhotoWithThumbnail: PhotoMeta = {
    ...mockPhoto,
    thumbnail: tinyJpegBase64,
  };

  it('renders with correct backdrop class', () => {
    container = document.createElement('div');
    document.body.appendChild(container);

    act(() => {
      root = createRoot(container!);
      root!.render(
        createElement(SharedPhotoLightbox, {
          photo: mockPhoto,
          linkId: 'link-1',
          tierKey: new Uint8Array(32),
          accessTier: 3,
          onClose: vi.fn(),
          hasNext: false,
          hasPrevious: false,
        })
      );
    });

    const lightbox = container.querySelector('[data-testid="shared-photo-lightbox"]');
    expect(lightbox).toBeTruthy();
    expect(lightbox?.className).toBe('lightbox-backdrop');
  });

  it('renders photo info correctly', () => {
    container = document.createElement('div');
    document.body.appendChild(container);

    act(() => {
      root = createRoot(container!);
      root!.render(
        createElement(SharedPhotoLightbox, {
          photo: mockPhoto,
          linkId: 'link-1',
          tierKey: new Uint8Array(32),
          accessTier: 3,
          onClose: vi.fn(),
          hasNext: false,
          hasPrevious: false,
        })
      );
    });

    const filename = container.querySelector('.lightbox-filename');
    expect(filename?.textContent).toBe('test.jpg');
  });

  it('shows thumbnail immediately when available', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);

    await act(async () => {
      root = createRoot(container!);
      root!.render(
        createElement(SharedPhotoLightbox, {
          photo: mockPhotoWithThumbnail,
          linkId: 'link-1',
          tierKey: new Uint8Array(32),
          accessTier: 3,
          onClose: vi.fn(),
          hasNext: false,
          hasPrevious: false,
        })
      );
      // Wait for async effects
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    // Should create a blob URL for the thumbnail
    expect(mockCreateObjectURL).toHaveBeenCalled();
    
    // Should show the image
    const image = container.querySelector('[data-testid="lightbox-image"]');
    expect(image).toBeTruthy();
  });

  it('attempts to load full-res shards after showing thumbnail', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);

    await act(async () => {
      root = createRoot(container!);
      root!.render(
        createElement(SharedPhotoLightbox, {
          photo: mockPhotoWithThumbnail,
          linkId: 'link-1',
          tierKey: new Uint8Array(32),
          accessTier: 3,
          onClose: vi.fn(),
          hasNext: false,
          hasPrevious: false,
        })
      );
      // Wait for async shard loading
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    // Should have downloaded shards
    expect(mockDownloadShard).toHaveBeenCalledWith('link-1', 'shard-1');
    
    // Should have decrypted shards
    expect(mockDecryptShardWithTierKey).toHaveBeenCalled();
  });

  it('gracefully handles decryption failure when thumbnail is available', async () => {
    // Make decryption fail
    mockDecryptShardWithTierKey.mockRejectedValueOnce(new Error('Decryption failed'));
    
    container = document.createElement('div');
    document.body.appendChild(container);

    await act(async () => {
      root = createRoot(container!);
      root!.render(
        createElement(SharedPhotoLightbox, {
          photo: mockPhotoWithThumbnail,
          linkId: 'link-1',
          tierKey: new Uint8Array(32),
          accessTier: 2, // Preview tier - might not be able to decrypt original shards
          onClose: vi.fn(),
          hasNext: false,
          hasPrevious: false,
        })
      );
      // Wait for async effects
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    // Should still show the image (thumbnail fallback)
    const image = container.querySelector('[data-testid="lightbox-image"]');
    expect(image).toBeTruthy();
    
    // Should NOT show an error
    const error = container.querySelector('[data-testid="lightbox-error"]');
    expect(error).toBeNull();
  });

  it('shows error when no thumbnail and shard loading fails', async () => {
    // Make decryption fail
    mockDecryptShardWithTierKey.mockRejectedValueOnce(new Error('Decryption failed'));
    
    container = document.createElement('div');
    document.body.appendChild(container);

    await act(async () => {
      root = createRoot(container!);
      root!.render(
        createElement(SharedPhotoLightbox, {
          photo: mockPhoto, // No thumbnail
          linkId: 'link-1',
          tierKey: new Uint8Array(32),
          accessTier: 2,
          onClose: vi.fn(),
          hasNext: false,
          hasPrevious: false,
        })
      );
      // Wait for async effects
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    // Should show an error
    const error = container.querySelector('[data-testid="lightbox-error"]');
    expect(error).toBeTruthy();
    expect(error?.textContent).toContain('Decryption failed');
  });

  it('shows error when no thumbnail or tier key available', () => {
    container = document.createElement('div');
    document.body.appendChild(container);

    act(() => {
      root = createRoot(container!);
      root!.render(
        createElement(SharedPhotoLightbox, {
          photo: { ...mockPhoto, thumbnail: undefined, shardIds: [] }, // No thumbnail, no shards
          linkId: 'link-1',
          tierKey: undefined, // No tier key
          accessTier: 3,
          onClose: vi.fn(),
          hasNext: false,
          hasPrevious: false,
        })
      );
    });

    // When there's no thumbnail and no tier key, shows error
    // (useEffect runs and transitions state from 'loading' to 'error' synchronously for this case)
    const error = container.querySelector('[data-testid="lightbox-error"]');
    expect(error).toBeTruthy();
    expect(error?.textContent).toContain('No image available');
  });

  it('peeks at shard headers to determine tier before decrypting', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);

    await act(async () => {
      root = createRoot(container!);
      root!.render(
        createElement(SharedPhotoLightbox, {
          photo: mockPhotoWithThumbnail,
          linkId: 'link-1',
          tierKey: new Uint8Array(32),
          accessTier: 2,
          onClose: vi.fn(),
          hasNext: false,
          hasPrevious: false,
        })
      );
      // Wait for async shard loading
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    // Should have called peekHeader to check shard tier
    expect(mockPeekHeader).toHaveBeenCalled();
  });

  it('only decrypts shards matching access tier', async () => {
    // Set up 3 shards with different tiers (thumb=1, preview=2, original=3)
    const photoWithMultipleShards: PhotoMeta = {
      ...mockPhotoWithThumbnail,
      shardIds: ['shard-thumb', 'shard-preview', 'shard-original'],
    };

    // Return different tiers for each shard
    mockPeekHeader
      .mockResolvedValueOnce({ epochId: 1, shardId: 0, tier: 1 }) // thumb
      .mockResolvedValueOnce({ epochId: 1, shardId: 1, tier: 2 }) // preview
      .mockResolvedValueOnce({ epochId: 1, shardId: 2, tier: 3 }); // original

    container = document.createElement('div');
    document.body.appendChild(container);

    await act(async () => {
      root = createRoot(container!);
      root!.render(
        createElement(SharedPhotoLightbox, {
          photo: photoWithMultipleShards,
          linkId: 'link-1',
          tierKey: new Uint8Array(32),
          accessTier: 2, // Preview tier - should NOT decrypt original (tier 3)
          onClose: vi.fn(),
          hasNext: false,
          hasPrevious: false,
        })
      );
      // Wait for async shard loading
      await new Promise(resolve => setTimeout(resolve, 150));
    });

    // Should have peeked at all 3 shards
    expect(mockPeekHeader).toHaveBeenCalledTimes(3);
    
    // Should only decrypt 1 shard (the preview tier, highest available <= accessTier)
    expect(mockDecryptShardWithTierKey).toHaveBeenCalledTimes(1);
    
    // Should show the loaded image
    const image = container.querySelector('[data-testid="lightbox-image"]');
    expect(image).toBeTruthy();
  });

  it('uses getTierKey callback when provided to get correct key for shard tier', async () => {
    const mockGetTierKey = vi.fn((epochId: number, tier: number) => {
      // Return different mock keys for different tiers
      return new Uint8Array(32).fill(tier);
    });

    // Set shard tier to 1 (thumb) to test that getTierKey is called with tier 1
    mockPeekHeader.mockResolvedValue({ epochId: 1, shardId: 0, tier: 1 });

    container = document.createElement('div');
    document.body.appendChild(container);

    await act(async () => {
      root = createRoot(container!);
      root!.render(
        createElement(SharedPhotoLightbox, {
          photo: mockPhotoWithThumbnail,
          linkId: 'link-1',
          tierKey: new Uint8Array(32),
          accessTier: 2,
          onClose: vi.fn(),
          hasNext: false,
          hasPrevious: false,
          getTierKey: mockGetTierKey,
        })
      );
      // Wait for async shard loading
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    // Should have called getTierKey with epoch 1 and tier 1 (from the shard header)
    expect(mockGetTierKey).toHaveBeenCalledWith(1, 1);
  });
});
