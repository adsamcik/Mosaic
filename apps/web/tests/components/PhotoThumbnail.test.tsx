/**
 * PhotoThumbnail Component Tests
 *
 * Tests the "Embedded Thumbnails First" feature:
 * 1. Displays embedded base64 thumbnails immediately if photo.thumbnail exists
 * 2. Only loads shards if no thumbnail OR loadFullResolution is true
 * 3. Allows clicking on photos with embedded thumbnails (no need to wait for shard loading)
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhotoThumbnail } from '../../src/components/Gallery/PhotoThumbnail';
import type { PhotoMeta } from '../../src/workers/types';
import * as photoService from '../../src/lib/photo-service';

// Mock the photo-service
vi.mock('../../src/lib/photo-service', () => ({
  loadPhoto: vi
    .fn()
    .mockResolvedValue({
      blobUrl: 'blob:test',
      mimeType: 'image/jpeg',
      size: 1024,
    }),
  releasePhoto: vi.fn(),
}));

// Mock the thumbhash-decoder
vi.mock('../../src/lib/thumbhash-decoder', () => ({
  getCachedPlaceholderDataURL: vi
    .fn()
    .mockReturnValue('data:image/png;base64,thumbhashMockData'),
  isValidPlaceholderHash: vi
    .fn()
    .mockImplementation((hash: string) => hash && hash.length > 4),
}));

/**
 * Creates a mock photo with all required fields
 */
function createMockPhoto(overrides: Partial<PhotoMeta> = {}): PhotoMeta {
  return {
    id: 'photo-1',
    assetId: 'asset-1',
    albumId: 'album-1',
    epochId: 1,
    filename: 'test-photo.jpg',
    mimeType: 'image/jpeg',
    width: 1920,
    height: 1080,
    shardIds: ['shard-1', 'shard-2'],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    tags: [],
    ...overrides,
  };
}

describe('PhotoThumbnail', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const mockEpochKey = new Uint8Array(32);

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

  describe('Embedded Thumbnail Display', () => {
    it('renders embedded thumbnail immediately when photo.thumbnail exists', () => {
      const photo = createMockPhoto({
        thumbnail: 'base64EncodedThumbnailData',
      });

      act(() => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
          }),
        );
      });

      const embeddedImg = container.querySelector(
        '[data-testid="photo-image-embedded"]',
      );
      expect(embeddedImg).not.toBeNull();
      expect(embeddedImg?.getAttribute('src')).toBe(
        'data:image/jpeg;base64,base64EncodedThumbnailData',
      );
    });

    it('does NOT show loading spinner when embedded thumbnail exists', () => {
      const photo = createMockPhoto({
        thumbnail: 'base64EncodedThumbnailData',
      });

      act(() => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
          }),
        );
      });

      const loading = container.querySelector('[data-testid="photo-loading"]');
      expect(loading).toBeNull();
    });

    it('does NOT call loadPhoto when embedded thumbnail exists', async () => {
      const photo = createMockPhoto({
        thumbnail: 'base64EncodedThumbnailData',
      });

      await act(async () => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
          }),
        );
        // Wait for any potential async effects
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      expect(photoService.loadPhoto).not.toHaveBeenCalled();
    });

    it('shows correct URL in data-thumbnail-url attribute', () => {
      const photo = createMockPhoto({
        thumbnail: 'base64EncodedThumbnailData',
      });

      act(() => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
          }),
        );
      });

      const thumbnail = container.querySelector(
        '[data-testid="photo-thumbnail"]',
      );
      expect(thumbnail?.getAttribute('data-thumbnail-url')).toBe(
        'data:image/jpeg;base64,base64EncodedThumbnailData',
      );
    });
  });

  describe('Fallback to Shard Loading', () => {
    it('loads shards when photo.thumbnail is undefined', async () => {
      const photo = createMockPhoto({
        thumbnail: undefined,
      });

      await act(async () => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
          }),
        );
        // Wait for the effect to trigger
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      expect(photoService.loadPhoto).toHaveBeenCalledWith(
        photo.id,
        photo.shardIds,
        mockEpochKey,
        photo.mimeType,
        expect.any(Object),
      );
    });

    it('treats empty string thumbnail as no thumbnail (loads shards)', async () => {
      const photo = createMockPhoto({
        thumbnail: '',
      });

      await act(async () => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
          }),
        );
        // Wait for the effect to trigger
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      expect(photoService.loadPhoto).toHaveBeenCalled();
    });

    it('shows loading state when no thumbnail and loading shards', async () => {
      // Create a pending promise to simulate loading
      let resolveLoad: (value: photoService.PhotoLoadResult) => void;
      vi.mocked(photoService.loadPhoto).mockImplementation(() => {
        return new Promise((resolve) => {
          resolveLoad = resolve;
        });
      });

      const photo = createMockPhoto({
        thumbnail: undefined,
        blurhash: undefined,
      });

      await act(async () => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
          }),
        );
        // Allow effect to run
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const loading = container.querySelector('[data-testid="photo-loading"]');
      expect(loading).not.toBeNull();

      // Cleanup
      await act(async () => {
        resolveLoad!({
          blobUrl: 'blob:test',
          mimeType: 'image/jpeg',
          size: 1024,
        });
      });
    });
  });

  describe('loadFullResolution Prop', () => {
    it('loads shards when loadFullResolution is true even if thumbnail exists', async () => {
      const photo = createMockPhoto({
        thumbnail: 'base64EncodedThumbnailData',
      });

      await act(async () => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
            loadFullResolution: true,
          }),
        );
        // Wait for the effect to trigger
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      expect(photoService.loadPhoto).toHaveBeenCalledWith(
        photo.id,
        photo.shardIds,
        mockEpochKey,
        photo.mimeType,
        expect.any(Object),
      );
    });

    it('shows thumbnail with upgrade overlay when loading full resolution', async () => {
      // Create a pending promise to simulate loading
      let resolveLoad: (value: photoService.PhotoLoadResult) => void;
      vi.mocked(photoService.loadPhoto).mockImplementation(() => {
        return new Promise((resolve) => {
          resolveLoad = resolve;
        });
      });

      const photo = createMockPhoto({
        thumbnail: 'base64EncodedThumbnailData',
      });

      await act(async () => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
            loadFullResolution: true,
          }),
        );
        // Allow effect to run
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const upgrading = container.querySelector(
        '[data-testid="photo-upgrading"]',
      );
      expect(upgrading).not.toBeNull();

      // Cleanup
      await act(async () => {
        resolveLoad!({
          blobUrl: 'blob:test',
          mimeType: 'image/jpeg',
          size: 1024,
        });
      });
    });

    it('shows full resolution image after loading completes', async () => {
      vi.mocked(photoService.loadPhoto).mockResolvedValue({
        blobUrl: 'blob:fullres',
        mimeType: 'image/jpeg',
        size: 2048,
      });

      const photo = createMockPhoto({
        thumbnail: 'base64EncodedThumbnailData',
      });

      await act(async () => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
            loadFullResolution: true,
          }),
        );
        // Wait for loading to complete
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      const fullResImg = container.querySelector('[data-testid="photo-image"]');
      expect(fullResImg).not.toBeNull();
      expect(fullResImg?.getAttribute('src')).toBe('blob:fullres');
    });
  });

  describe('Click Handler with Embedded Thumbnail', () => {
    it('is clickable immediately with embedded thumbnail', () => {
      const onClick = vi.fn();
      const photo = createMockPhoto({
        thumbnail: 'base64EncodedThumbnailData',
      });

      act(() => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
            onClick,
          }),
        );
      });

      const thumbnail = container.querySelector(
        '[data-testid="photo-thumbnail"]',
      );
      expect(thumbnail?.getAttribute('tabIndex')).toBe('0');

      act(() => {
        thumbnail?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(onClick).toHaveBeenCalled();
    });

    it('calls onClick when clicking on photo with embedded thumbnail', () => {
      const onClick = vi.fn();
      const photo = createMockPhoto({
        thumbnail: 'base64EncodedThumbnailData',
      });

      act(() => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
            onClick,
          }),
        );
      });

      const thumbnail = container.querySelector(
        '[data-testid="photo-thumbnail"]',
      );
      act(() => {
        thumbnail?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('handles keyboard activation with embedded thumbnail', () => {
      const onClick = vi.fn();
      const photo = createMockPhoto({
        thumbnail: 'base64EncodedThumbnailData',
      });

      act(() => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
            onClick,
          }),
        );
      });

      const thumbnail = container.querySelector(
        '[data-testid="photo-thumbnail"]',
      );
      act(() => {
        thumbnail?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      });

      expect(onClick).toHaveBeenCalled();
    });
  });

  describe('Selection Mode with Embedded Thumbnail', () => {
    it('toggles selection when clicking in selection mode', () => {
      const onSelectionChange = vi.fn();
      const photo = createMockPhoto({
        thumbnail: 'base64EncodedThumbnailData',
      });

      act(() => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
            selectionMode: true,
            isSelected: false,
            onSelectionChange,
          }),
        );
      });

      const thumbnail = container.querySelector(
        '[data-testid="photo-thumbnail"]',
      );
      act(() => {
        thumbnail?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(onSelectionChange).toHaveBeenCalledWith(true, expect.anything());
    });

    it('shows checkbox in selection mode with embedded thumbnail', () => {
      const photo = createMockPhoto({
        thumbnail: 'base64EncodedThumbnailData',
      });

      act(() => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
            selectionMode: true,
            onSelectionChange: vi.fn(),
          }),
        );
      });

      const checkbox = container.querySelector(
        '[data-testid="photo-checkbox"]',
      );
      expect(checkbox).not.toBeNull();
    });

    it('applies selected class when isSelected is true', () => {
      const photo = createMockPhoto({
        thumbnail: 'base64EncodedThumbnailData',
      });

      act(() => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
            selectionMode: true,
            isSelected: true,
            onSelectionChange: vi.fn(),
          }),
        );
      });

      const thumbnail = container.querySelector('.photo-thumbnail-selected');
      expect(thumbnail).not.toBeNull();
    });
  });

  describe('No Epoch Key Scenarios', () => {
    it('does not load shards when epoch key is undefined', async () => {
      const photo = createMockPhoto({
        thumbnail: undefined,
      });

      await act(async () => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: undefined,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      expect(photoService.loadPhoto).not.toHaveBeenCalled();
    });

    it('shows placeholder when no thumbnail and no epoch key', () => {
      const photo = createMockPhoto({
        thumbnail: undefined,
        blurhash: undefined,
      });

      act(() => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: undefined,
          }),
        );
      });

      const placeholder = container.querySelector(
        '[data-testid="photo-placeholder"]',
      );
      expect(placeholder).not.toBeNull();
    });

    it('still displays embedded thumbnail without epoch key', () => {
      const photo = createMockPhoto({
        thumbnail: 'base64EncodedThumbnailData',
      });

      act(() => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: undefined,
          }),
        );
      });

      const embeddedImg = container.querySelector(
        '[data-testid="photo-image-embedded"]',
      );
      expect(embeddedImg).not.toBeNull();
    });
  });

  describe('BlurHash Placeholder', () => {
    it('shows blurhash while loading when no embedded thumbnail', async () => {
      // Create a pending promise to simulate loading
      let resolveLoad: (value: photoService.PhotoLoadResult) => void;
      vi.mocked(photoService.loadPhoto).mockImplementation(() => {
        return new Promise((resolve) => {
          resolveLoad = resolve;
        });
      });

      const photo = createMockPhoto({
        thumbnail: undefined,
        blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
      });

      await act(async () => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
          }),
        );
        // Allow effect to run
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const blurhash = container.querySelector(
        '[data-testid="photo-blurhash"]',
      );
      expect(blurhash).not.toBeNull();

      // Cleanup
      await act(async () => {
        resolveLoad!({
          blobUrl: 'blob:test',
          mimeType: 'image/jpeg',
          size: 1024,
        });
      });
    });

    it('prefers embedded thumbnail over blurhash', () => {
      const photo = createMockPhoto({
        thumbnail: 'base64EncodedThumbnailData',
        blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
      });

      act(() => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
          }),
        );
      });

      // Should show embedded thumbnail, not blurhash
      const embeddedImg = container.querySelector(
        '[data-testid="photo-image-embedded"]',
      );
      const blurhash = container.querySelector(
        '[data-testid="photo-blurhash"]',
      );
      expect(embeddedImg).not.toBeNull();
      expect(blurhash).toBeNull();
    });
  });

  describe('Delete Handler with Embedded Thumbnail', () => {
    it('sets data-thumbnail-url with embedded thumbnail for delete operations', () => {
      const onDelete = vi.fn();
      const photo = createMockPhoto({
        thumbnail: 'base64EncodedThumbnailData',
      });

      act(() => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
            onDelete,
          }),
        );
      });

      // Verify the thumbnail URL is set correctly via data attribute
      // This URL is used by the delete handler when invoked
      const thumbnail = container.querySelector(
        '[data-testid="photo-thumbnail"]',
      );
      expect(thumbnail?.getAttribute('data-thumbnail-url')).toBe(
        'data:image/jpeg;base64,base64EncodedThumbnailData',
      );
    });

    it('handles keyboard delete with embedded thumbnail URL', () => {
      const onDelete = vi.fn();
      const photo = createMockPhoto({
        thumbnail: 'base64EncodedThumbnailData',
      });

      act(() => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
            onDelete,
            onClick: vi.fn(), // Needed for focus/keyboard handling
          }),
        );
      });

      const thumbnail = container.querySelector(
        '[data-testid="photo-thumbnail"]',
      );
      act(() => {
        thumbnail?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }),
        );
      });

      expect(onDelete).toHaveBeenCalledWith(
        'data:image/jpeg;base64,base64EncodedThumbnailData',
      );
    });
  });

  describe('Component Structure', () => {
    it('sets data-photo-id attribute', () => {
      const photo = createMockPhoto({
        id: 'unique-photo-id',
        thumbnail: 'base64EncodedThumbnailData',
      });

      act(() => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
          }),
        );
      });

      const thumbnail = container.querySelector(
        '[data-testid="photo-thumbnail"]',
      );
      expect(thumbnail?.getAttribute('data-photo-id')).toBe('unique-photo-id');
    });

    it('applies custom style prop', () => {
      const photo = createMockPhoto({
        thumbnail: 'base64EncodedThumbnailData',
      });

      act(() => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
            style: { maxWidth: '300px' },
          }),
        );
      });

      const thumbnail = container.querySelector(
        '[data-testid="photo-thumbnail"]',
      );
      expect((thumbnail as HTMLElement).style.maxWidth).toBe('300px');
    });

    it('shows filename in photo info', () => {
      const photo = createMockPhoto({
        filename: 'vacation-photo.jpg',
        thumbnail: 'base64EncodedThumbnailData',
      });

      act(() => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
          }),
        );
      });

      const filename = container.querySelector('.photo-filename');
      expect(filename?.textContent).toBe('vacation-photo.jpg');
    });
  });

  describe('Cleanup', () => {
    it('calls releasePhoto on unmount', async () => {
      const photo = createMockPhoto({
        thumbnail: undefined,
      });

      await act(async () => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      act(() => {
        root.unmount();
      });

      expect(photoService.releasePhoto).toHaveBeenCalledWith(photo.id);
    });

    it('does not call releasePhoto when no shards were loaded', async () => {
      const photo = createMockPhoto({
        thumbnail: 'base64EncodedThumbnailData',
      });

      await act(async () => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      vi.clearAllMocks();

      act(() => {
        root.unmount();
      });

      // releasePhoto should not be called since no shards were loaded
      expect(photoService.releasePhoto).not.toHaveBeenCalled();
    });
  });

  describe('Error State', () => {
    it('shows error state when shard loading fails', async () => {
      vi.mocked(photoService.loadPhoto).mockRejectedValue(
        new Error('Failed to load'),
      );

      const photo = createMockPhoto({
        thumbnail: undefined,
        blurhash: undefined,
      });

      await act(async () => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
          }),
        );
        // Wait for the error to propagate
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      const error = container.querySelector('[data-testid="photo-error"]');
      expect(error).not.toBeNull();
    });

    it('shows retry button on error', async () => {
      vi.mocked(photoService.loadPhoto).mockRejectedValue(
        new Error('Failed to load'),
      );

      const photo = createMockPhoto({
        thumbnail: undefined,
        blurhash: undefined,
      });

      await act(async () => {
        root.render(
          createElement(PhotoThumbnail, {
            photo,
            epochReadKey: mockEpochKey,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      const retryButton = container.querySelector('.retry-button');
      expect(retryButton).not.toBeNull();
    });
  });
});
