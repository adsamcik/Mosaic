/**
 * JustifiedPhotoThumbnail Component Tests
 *
 * Tests the "Embedded Thumbnails First" feature:
 * 1. Displays embedded base64 thumbnails immediately if photo.thumbnail exists
 * 2. Only loads shards if no thumbnail OR loadFullResolution is true
 * 3. Allows clicking on photos with embedded thumbnails (no need to wait for shard loading)
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JustifiedPhotoThumbnail } from '../../src/components/Gallery/JustifiedPhotoThumbnail';
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

describe('JustifiedPhotoThumbnail', () => {
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
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 200,
            height: 150,
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
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 200,
            height: 150,
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
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 200,
            height: 150,
            epochReadKey: mockEpochKey,
          }),
        );
        // Wait for any potential async effects
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      expect(photoService.loadPhoto).not.toHaveBeenCalled();
    });
  });

  describe('Fallback to Shard Loading', () => {
    it('loads shards when photo.thumbnail is undefined', async () => {
      const photo = createMockPhoto({
        thumbnail: undefined,
      });

      await act(async () => {
        root.render(
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 200,
            height: 150,
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
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 200,
            height: 150,
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
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 200,
            height: 150,
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
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 200,
            height: 150,
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
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 200,
            height: 150,
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
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 200,
            height: 150,
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
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 200,
            height: 150,
            epochReadKey: mockEpochKey,
            onClick,
          }),
        );
      });

      const thumbnail = container.querySelector(
        '[data-testid="justified-photo-thumbnail"]',
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
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 200,
            height: 150,
            epochReadKey: mockEpochKey,
            onClick,
          }),
        );
      });

      const thumbnail = container.querySelector(
        '[data-testid="justified-photo-thumbnail"]',
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
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 200,
            height: 150,
            epochReadKey: mockEpochKey,
            onClick,
          }),
        );
      });

      const thumbnail = container.querySelector(
        '[data-testid="justified-photo-thumbnail"]',
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
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 200,
            height: 150,
            epochReadKey: mockEpochKey,
            selectionMode: true,
            isSelected: false,
            onSelectionChange,
          }),
        );
      });

      const thumbnail = container.querySelector(
        '[data-testid="justified-photo-thumbnail"]',
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
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 200,
            height: 150,
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
  });

  describe('No Epoch Key Scenarios', () => {
    it('does not load shards when epoch key is undefined', async () => {
      const photo = createMockPhoto({
        thumbnail: undefined,
      });

      await act(async () => {
        root.render(
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 200,
            height: 150,
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
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 200,
            height: 150,
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
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 200,
            height: 150,
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
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 200,
            height: 150,
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
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 200,
            height: 150,
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

  describe('Component Structure', () => {
    it('renders with correct dimensions', () => {
      const photo = createMockPhoto({
        thumbnail: 'base64EncodedThumbnailData',
      });

      act(() => {
        root.render(
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 250,
            height: 180,
            epochReadKey: mockEpochKey,
          }),
        );
      });

      const thumbnail = container.querySelector(
        '[data-testid="justified-photo-thumbnail"]',
      );
      expect(thumbnail).not.toBeNull();
      const style = (thumbnail as HTMLElement).style;
      expect(style.width).toBe('250px');
      expect(style.height).toBe('180px');
    });

    it('sets data-photo-id attribute', () => {
      const photo = createMockPhoto({
        id: 'unique-photo-id',
        thumbnail: 'base64EncodedThumbnailData',
      });

      act(() => {
        root.render(
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 200,
            height: 150,
            epochReadKey: mockEpochKey,
          }),
        );
      });

      const thumbnail = container.querySelector(
        '[data-testid="justified-photo-thumbnail"]',
      );
      expect(thumbnail?.getAttribute('data-photo-id')).toBe('unique-photo-id');
    });
  });

  describe('Cleanup', () => {
    it('calls releasePhoto on unmount', async () => {
      const photo = createMockPhoto({
        thumbnail: undefined,
      });

      await act(async () => {
        root.render(
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 200,
            height: 150,
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
          createElement(JustifiedPhotoThumbnail, {
            photo,
            width: 200,
            height: 150,
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
});
