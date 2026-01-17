/**
 * PhotoLightbox Component Tests
 * Tests the updated UI with SVG icons for navigation, info, download, and delete
 * Tests viewport-based shard preloading behavior
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhotoLightbox } from '../src/components/Gallery/PhotoLightbox';
import * as photoService from '../src/lib/photo-service';
import type { PhotoMeta } from '../src/workers/types';

// Mock the photo-service
vi.mock('../src/lib/photo-service', () => ({
  loadPhoto: vi
    .fn()
    .mockResolvedValue({ blobUrl: 'blob:test-full', size: 2048 }),
  preloadPhotos: vi.fn().mockResolvedValue(undefined),
  releasePhoto: vi.fn(),
}));

// Mock the AlbumPermissionsContext
vi.mock('../src/contexts/AlbumPermissionsContext', () => ({
  useAlbumPermissions: () => ({
    isOwner: true,
    canUpload: true,
    canDelete: true,
    canDownload: true,
    canManageMembers: true,
    canManageShareLinks: true,
  }),
}));

// Create a mock photo
function createMockPhoto(overrides: Partial<PhotoMeta> = {}): PhotoMeta {
  return {
    id: 'photo-1',
    albumId: 'album-1',
    epochId: 'epoch-1',
    filename: 'test-photo.jpg',
    mimeType: 'image/jpeg',
    width: 1920,
    height: 1080,
    shardIds: ['shard-1', 'shard-2'],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    tags: ['nature', 'landscape'],
    takenAt: '2024-01-01T12:00:00Z',
    ...overrides,
  };
}

describe('PhotoLightbox', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders the lightbox', () => {
    const onClose = vi.fn();

    act(() => {
      root.render(
        createElement(PhotoLightbox, {
          photo: createMockPhoto(),
          epochReadKey: new Uint8Array(32),
          onClose,
        }),
      );
    });

    const lightbox = container.querySelector('[data-testid="lightbox"]');
    expect(lightbox).not.toBeNull();
  });

  it('renders close button with SVG icon', () => {
    act(() => {
      root.render(
        createElement(PhotoLightbox, {
          photo: createMockPhoto(),
          epochReadKey: new Uint8Array(32),
          onClose: vi.fn(),
        }),
      );
    });

    const closeButton = container.querySelector(
      '[data-testid="lightbox-close"]',
    );
    expect(closeButton).not.toBeNull();
    expect(closeButton?.querySelector('svg')).not.toBeNull();
    // Should NOT contain text close character
    expect(closeButton?.textContent).not.toContain('✕');
  });

  it('renders navigation buttons with SVG icons', () => {
    act(() => {
      root.render(
        createElement(PhotoLightbox, {
          photo: createMockPhoto(),
          epochReadKey: new Uint8Array(32),
          onClose: vi.fn(),
          onNext: vi.fn(),
          onPrevious: vi.fn(),
          hasNext: true,
          hasPrevious: true,
        }),
      );
    });

    const prevButton = container.querySelector('[data-testid="lightbox-prev"]');
    const nextButton = container.querySelector('[data-testid="lightbox-next"]');

    expect(prevButton).not.toBeNull();
    expect(nextButton).not.toBeNull();

    // Both should have SVG icons
    expect(prevButton?.querySelector('svg')).not.toBeNull();
    expect(nextButton?.querySelector('svg')).not.toBeNull();

    // Should NOT contain text arrow characters
    expect(prevButton?.textContent).not.toContain('‹');
    expect(nextButton?.textContent).not.toContain('›');
  });

  it('renders info toggle button with SVG icon', () => {
    act(() => {
      root.render(
        createElement(PhotoLightbox, {
          photo: createMockPhoto(),
          epochReadKey: new Uint8Array(32),
          onClose: vi.fn(),
          showMetadata: true,
        }),
      );
    });

    const infoButton = container.querySelector(
      '[data-testid="lightbox-info-toggle"]',
    );
    expect(infoButton).not.toBeNull();
    expect(infoButton?.querySelector('svg')).not.toBeNull();
    // Should NOT contain info character
    expect(infoButton?.textContent).not.toContain('ℹ');
  });

  it('renders delete button with SVG icon when onDelete provided', () => {
    act(() => {
      root.render(
        createElement(PhotoLightbox, {
          photo: createMockPhoto(),
          epochReadKey: new Uint8Array(32),
          onClose: vi.fn(),
          onDelete: vi.fn(),
        }),
      );
    });

    const deleteButton = container.querySelector(
      '[data-testid="lightbox-delete"]',
    );
    expect(deleteButton).not.toBeNull();
    expect(deleteButton?.querySelector('svg')).not.toBeNull();
    // Should NOT contain trash emoji
    expect(deleteButton?.textContent).not.toContain('🗑️');
  });

  it('has correct CSS classes for lightbox styling', () => {
    act(() => {
      root.render(
        createElement(PhotoLightbox, {
          photo: createMockPhoto(),
          epochReadKey: new Uint8Array(32),
          onClose: vi.fn(),
        }),
      );
    });

    expect(container.querySelector('.lightbox-backdrop')).not.toBeNull();
    expect(container.querySelector('.lightbox-content')).not.toBeNull();
    expect(container.querySelector('.lightbox-close')).not.toBeNull();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();

    act(() => {
      root.render(
        createElement(PhotoLightbox, {
          photo: createMockPhoto(),
          epochReadKey: new Uint8Array(32),
          onClose,
        }),
      );
    });

    const closeButton = container.querySelector(
      '[data-testid="lightbox-close"]',
    ) as HTMLButtonElement;

    act(() => {
      closeButton.click();
    });

    expect(onClose).toHaveBeenCalled();
  });

  it('displays photo counter with filename', () => {
    const photo = createMockPhoto({ filename: 'vacation-photo.jpg' });

    act(() => {
      root.render(
        createElement(PhotoLightbox, {
          photo,
          epochReadKey: new Uint8Array(32),
          onClose: vi.fn(),
        }),
      );
    });

    const counter = container.querySelector('[data-testid="lightbox-counter"]');
    expect(counter).not.toBeNull();
    expect(counter?.textContent).toContain('vacation-photo.jpg');
  });
});

/**
 * Lightbox Preloading Tests
 *
 * Tests the viewport-based shard preloading behavior.
 * The lightbox preloads adjacent photos when opened or navigated:
 * - Opening: preloads photos at index-1, index+1, index-2, index+2
 * - Forward navigation: prioritizes index+1, index+2, then index-1
 * - Backward navigation: prioritizes index-1, index-2, then index+1
 */
describe('PhotoLightbox Preloading', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  // Create an array of mock photos for preloading tests
  function createMockPhotos(count: number): PhotoMeta[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `photo-${i}`,
      albumId: 'album-1',
      epochId: 'epoch-1',
      filename: `photo-${i}.jpg`,
      mimeType: 'image/jpeg',
      width: 1920,
      height: 1080,
      shardIds: [`shard-${i}-a`, `shard-${i}-b`],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      tags: [],
    }));
  }

  // Create a mock photo with empty shardIds (placeholder/pending photo)
  function createMockPhotoWithoutShards(index: number): PhotoMeta {
    return {
      id: `photo-${index}`,
      albumId: 'album-1',
      epochId: 'epoch-1',
      filename: `photo-${index}.jpg`,
      mimeType: 'image/jpeg',
      width: 1920,
      height: 1080,
      shardIds: [], // No shards
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      tags: [],
    };
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  describe('preloads photos from preloadQueue', () => {
    it('calls preloadPhotos with provided preloadQueue', async () => {
      const photos = createMockPhotos(10);
      const currentPhoto = photos[5]!;
      const preloadQueue = [photos[4]!, photos[6]!, photos[3]!, photos[7]!];
      const epochReadKey = new Uint8Array(32);

      await act(async () => {
        root.render(
          createElement(PhotoLightbox, {
            photo: currentPhoto,
            epochReadKey,
            onClose: vi.fn(),
            preloadQueue,
          }),
        );
        // Allow useEffect to run
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Verify preloadPhotos was called
      expect(photoService.preloadPhotos).toHaveBeenCalled();

      // Verify it was called with the correct photos
      const call = vi.mocked(photoService.preloadPhotos).mock.calls[0];
      expect(call).toBeDefined();
      const [photosArg, keyArg] = call!;

      // Should have 4 photos in the preload queue
      expect(photosArg).toHaveLength(4);

      // Verify the photo IDs are correct (with :full suffix)
      const preloadedIds = photosArg.map((p) => p.id);
      expect(preloadedIds).toContain('photo-4:full');
      expect(preloadedIds).toContain('photo-6:full');
      expect(preloadedIds).toContain('photo-3:full');
      expect(preloadedIds).toContain('photo-7:full');

      // Verify the epoch key is passed correctly
      expect(keyArg).toBe(epochReadKey);
    });

    it('does not call preloadPhotos when preloadQueue is empty', async () => {
      const photos = createMockPhotos(10);
      const currentPhoto = photos[5]!;

      await act(async () => {
        root.render(
          createElement(PhotoLightbox, {
            photo: currentPhoto,
            epochReadKey: new Uint8Array(32),
            onClose: vi.fn(),
            preloadQueue: [],
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // preloadPhotos should not be called with empty queue
      expect(photoService.preloadPhotos).not.toHaveBeenCalled();
    });

    it('does not call preloadPhotos when epochReadKey is missing', async () => {
      const photos = createMockPhotos(10);
      const currentPhoto = photos[5]!;
      const preloadQueue = [photos[4]!, photos[6]!];

      await act(async () => {
        root.render(
          createElement(PhotoLightbox, {
            photo: currentPhoto,
            epochReadKey: undefined as unknown as Uint8Array,
            onClose: vi.fn(),
            preloadQueue,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // preloadPhotos should not be called without epoch key
      expect(photoService.preloadPhotos).not.toHaveBeenCalled();
    });

    it('uses correct mimeType for each photo in preloadQueue', async () => {
      const photos = createMockPhotos(5);
      // Modify mimeTypes to be different
      photos[1]!.mimeType = 'image/png';
      photos[2]!.mimeType = 'image/webp';
      photos[3]!.mimeType = 'image/gif';

      const currentPhoto = photos[2]!;
      const preloadQueue = [photos[1]!, photos[3]!];
      const epochReadKey = new Uint8Array(32);

      await act(async () => {
        root.render(
          createElement(PhotoLightbox, {
            photo: currentPhoto,
            epochReadKey,
            onClose: vi.fn(),
            preloadQueue,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const call = vi.mocked(photoService.preloadPhotos).mock.calls[0];
      expect(call).toBeDefined();
      const [photosArg] = call!;

      // Verify mimeTypes are preserved
      const pngPhoto = photosArg.find((p) => p.id === 'photo-1:full');
      const gifPhoto = photosArg.find((p) => p.id === 'photo-3:full');

      expect(pngPhoto?.mimeType).toBe('image/png');
      expect(gifPhoto?.mimeType).toBe('image/gif');
    });

    it('includes shardIds for each photo in preloadQueue', async () => {
      const photos = createMockPhotos(5);
      const currentPhoto = photos[2]!;
      const preloadQueue = [photos[1]!, photos[3]!];
      const epochReadKey = new Uint8Array(32);

      await act(async () => {
        root.render(
          createElement(PhotoLightbox, {
            photo: currentPhoto,
            epochReadKey,
            onClose: vi.fn(),
            preloadQueue,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const call = vi.mocked(photoService.preloadPhotos).mock.calls[0];
      expect(call).toBeDefined();
      const [photosArg] = call!;

      // Verify shardIds are included
      const photo1 = photosArg.find((p) => p.id === 'photo-1:full');
      const photo3 = photosArg.find((p) => p.id === 'photo-3:full');

      expect(photo1?.shardIds).toEqual(['shard-1-a', 'shard-1-b']);
      expect(photo3?.shardIds).toEqual(['shard-3-a', 'shard-3-b']);
    });
  });

  describe('preload errors are silent', () => {
    it('does not crash when preloadPhotos fails', async () => {
      // Mock preloadPhotos to throw an error
      vi.mocked(photoService.preloadPhotos).mockRejectedValueOnce(
        new Error('Network error during preload'),
      );

      const photos = createMockPhotos(5);
      const currentPhoto = photos[2]!;
      const preloadQueue = [photos[1]!, photos[3]!];

      // This should not throw
      await act(async () => {
        root.render(
          createElement(PhotoLightbox, {
            photo: currentPhoto,
            epochReadKey: new Uint8Array(32),
            onClose: vi.fn(),
            preloadQueue,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      // The lightbox should still render properly
      const lightbox = container.querySelector('[data-testid="lightbox"]');
      expect(lightbox).not.toBeNull();
    });

    it('continues to load main photo when preload fails', async () => {
      // Mock preloadPhotos to throw an error
      vi.mocked(photoService.preloadPhotos).mockRejectedValueOnce(
        new Error('Preload failed'),
      );

      const photos = createMockPhotos(5);
      const currentPhoto = photos[2]!;
      const preloadQueue = [photos[1]!, photos[3]!];

      await act(async () => {
        root.render(
          createElement(PhotoLightbox, {
            photo: currentPhoto,
            epochReadKey: new Uint8Array(32),
            onClose: vi.fn(),
            preloadQueue,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      // loadPhoto should still be called for the main photo
      expect(photoService.loadPhoto).toHaveBeenCalled();
      const loadPhotoCall = vi.mocked(photoService.loadPhoto).mock.calls[0];
      expect(loadPhotoCall?.[0]).toBe('photo-2:full');
    });
  });

  describe('preloadQueue updates trigger new preloads', () => {
    it('calls preloadPhotos again when preloadQueue changes', async () => {
      const photos = createMockPhotos(10);
      const currentPhoto = photos[5]!;
      const initialQueue = [photos[4]!, photos[6]!];
      const epochReadKey = new Uint8Array(32);

      await act(async () => {
        root.render(
          createElement(PhotoLightbox, {
            photo: currentPhoto,
            epochReadKey,
            onClose: vi.fn(),
            preloadQueue: initialQueue,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // First call with initial queue
      expect(photoService.preloadPhotos).toHaveBeenCalledTimes(1);

      // Update the preload queue (simulating navigation)
      const newQueue = [photos[6]!, photos[7]!, photos[4]!];

      await act(async () => {
        root.render(
          createElement(PhotoLightbox, {
            photo: photos[6]!,
            epochReadKey,
            onClose: vi.fn(),
            preloadQueue: newQueue,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Should be called again with new queue
      expect(photoService.preloadPhotos).toHaveBeenCalledTimes(2);

      // Verify the second call has the new queue
      const secondCall = vi.mocked(photoService.preloadPhotos).mock.calls[1];
      expect(secondCall).toBeDefined();
      const [photosArg] = secondCall!;
      const preloadedIds = photosArg.map((p) => p.id);
      expect(preloadedIds).toContain('photo-6:full');
      expect(preloadedIds).toContain('photo-7:full');
      expect(preloadedIds).toContain('photo-4:full');
    });
  });

  describe('Original Shard Extraction', () => {
    it('uses originalShardIds when available', async () => {
      vi.mocked(photoService.loadPhoto).mockClear();

      const photo = createMockPhoto({
        shardIds: ['thumb-shard', 'preview-shard', 'original-shard'],
        originalShardIds: ['original-shard-1', 'original-shard-2'],
      });

      await act(async () => {
        root.render(
          createElement(PhotoLightbox, {
            photo,
            epochReadKey: new Uint8Array(32),
            onClose: vi.fn(),
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(photoService.loadPhoto).toHaveBeenCalledWith(
        `${photo.id}:full`,
        ['original-shard-1', 'original-shard-2'], // Should use originalShardIds
        expect.any(Uint8Array),
        'image/jpeg',
        expect.any(Object),
      );
    });

    it('extracts original from 3-shard legacy format', async () => {
      vi.mocked(photoService.loadPhoto).mockClear();

      const photo = createMockPhoto({
        shardIds: ['thumb-shard', 'preview-shard', 'original-shard'],
        originalShardIds: undefined, // No tier-specific fields
      });

      await act(async () => {
        root.render(
          createElement(PhotoLightbox, {
            photo,
            epochReadKey: new Uint8Array(32),
            onClose: vi.fn(),
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(photoService.loadPhoto).toHaveBeenCalledWith(
        `${photo.id}:full`,
        ['original-shard'], // Should extract only shardIds[2]
        expect.any(Uint8Array),
        'image/jpeg',
        expect.any(Object),
      );
    });

    it('uses all shards for legacy chunked format (non-3 shard count)', async () => {
      vi.mocked(photoService.loadPhoto).mockClear();

      const photo = createMockPhoto({
        shardIds: ['chunk-1', 'chunk-2', 'chunk-3', 'chunk-4'], // 4 chunks = large file
        originalShardIds: undefined,
      });

      await act(async () => {
        root.render(
          createElement(PhotoLightbox, {
            photo,
            epochReadKey: new Uint8Array(32),
            onClose: vi.fn(),
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(photoService.loadPhoto).toHaveBeenCalledWith(
        `${photo.id}:full`,
        ['chunk-1', 'chunk-2', 'chunk-3', 'chunk-4'], // All chunks for legacy format
        expect.any(Uint8Array),
        'image/jpeg',
        expect.any(Object),
      );
    });

    it('uses single shard for small files', async () => {
      vi.mocked(photoService.loadPhoto).mockClear();

      const photo = createMockPhoto({
        shardIds: ['single-original'],
        originalShardIds: undefined,
      });

      await act(async () => {
        root.render(
          createElement(PhotoLightbox, {
            photo,
            epochReadKey: new Uint8Array(32),
            onClose: vi.fn(),
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(photoService.loadPhoto).toHaveBeenCalledWith(
        `${photo.id}:full`,
        ['single-original'], // Single shard used as-is
        expect.any(Uint8Array),
        'image/jpeg',
        expect.any(Object),
      );
    });

    it('falls back to shardIds when originalShardIds is empty array', async () => {
      vi.mocked(photoService.loadPhoto).mockClear();

      const photo = createMockPhoto({
        shardIds: ['thumb', 'preview', 'original'],
        originalShardIds: [], // Empty array
      });

      await act(async () => {
        root.render(
          createElement(PhotoLightbox, {
            photo,
            epochReadKey: new Uint8Array(32),
            onClose: vi.fn(),
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(photoService.loadPhoto).toHaveBeenCalledWith(
        `${photo.id}:full`,
        ['original'], // Falls back to shardIds[2]
        expect.any(Uint8Array),
        'image/jpeg',
        expect.any(Object),
      );
    });

    it('extracts original shards in preload queue', async () => {
      vi.mocked(photoService.preloadPhotos).mockClear();

      const mainPhoto = createMockPhoto({ id: 'main' });
      const preloadPhoto = createMockPhoto({
        id: 'preload-1',
        shardIds: ['thumb', 'preview', 'original'],
        originalShardIds: undefined,
      });

      await act(async () => {
        root.render(
          createElement(PhotoLightbox, {
            photo: mainPhoto,
            epochReadKey: new Uint8Array(32),
            onClose: vi.fn(),
            preloadQueue: [preloadPhoto],
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(photoService.preloadPhotos).toHaveBeenCalled();
      const [photosArg] = vi.mocked(photoService.preloadPhotos).mock.calls[0]!;

      // Verify preload extracts only original shard
      const preloadItem = photosArg.find((p) => p.id === 'preload-1:full');
      expect(preloadItem).toBeDefined();
      expect(preloadItem?.shardIds).toEqual(['original']); // Only original shard
    });
  });
});
