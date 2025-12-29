/**
 * SharedPhotoLightbox Component Tests
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import type { PhotoMeta } from '../src/workers/types';

// Mock crypto client - use vi.hoisted to avoid hoisting issues
const { mockDecryptShardWithTierKey, mockCryptoClient } = vi.hoisted(() => {
  const mockDecryptShardWithTierKey = vi.fn(() => Promise.resolve(new Uint8Array(10)));
  const mockCryptoClient = {
    decryptShard: vi.fn(() => Promise.resolve(new Uint8Array(10))),
    decryptShardWithTierKey: mockDecryptShardWithTierKey,
  };
  return { mockDecryptShardWithTierKey, mockCryptoClient };
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
});
