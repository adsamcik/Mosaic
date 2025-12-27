/**
 * PhotoLightbox Component Tests
 *
 * Tests for the photo lightbox/detail view component.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhotoLightbox } from '../src/components/Gallery/PhotoLightbox';
import type { PhotoMeta } from '../src/workers/types';

// Mock photo service
const mockPhotoService = {
  loadPhoto: vi.fn(),
  releasePhoto: vi.fn(),
  preloadPhotos: vi.fn(),
};

vi.mock('../src/lib/photo-service', () => ({
  loadPhoto: (...args: unknown[]) => mockPhotoService.loadPhoto(...args),
  releasePhoto: (...args: unknown[]) => mockPhotoService.releasePhoto(...args),
  preloadPhotos: (...args: unknown[]) => mockPhotoService.preloadPhotos(...args),
}));

// Create mock photo for testing
function createMockPhoto(id: string): PhotoMeta {
  return {
    id,
    assetId: `asset-${id}`,
    albumId: 'album-1',
    filename: `test-photo-${id}.jpg`,
    mimeType: 'image/jpeg',
    width: 1920,
    height: 1080,
    takenAt: '2024-06-15T14:30:00Z',
    lat: 40.7128,
    lng: -74.006,
    tags: ['vacation', 'summer'],
    shardIds: [`shard-${id}-1`, `shard-${id}-2`],
    epochId: 1,
    createdAt: '2024-01-01T12:00:00Z',
    updatedAt: '2024-01-01T12:00:00Z',
  };
}

// Helper to render component and get elements
function renderLightbox(
  props: Partial<Parameters<typeof PhotoLightbox>[0]> = {}
) {
  const mockEpochReadKey = new Uint8Array(32).fill(1);
  const mockPhoto = createMockPhoto('photo-1');

  const defaultProps = {
    photo: mockPhoto,
    epochReadKey: mockEpochReadKey,
    onClose: vi.fn(),
    onNext: vi.fn(),
    onPrevious: vi.fn(),
    hasNext: true,
    hasPrevious: true,
  };

  const container = document.createElement('div');
  document.body.appendChild(container);

  let root: ReturnType<typeof createRoot>;
  act(() => {
    root = createRoot(container);
    root.render(createElement(PhotoLightbox, { ...defaultProps, ...props }));
  });

  const getByTestId = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`);
  const queryByTestId = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`);
  const queryAllByTestId = (testId: string) =>
    Array.from(container.querySelectorAll(`[data-testid="${testId}"]`));

  const cleanup = () => {
    act(() => {
      root!.unmount();
    });
    container.remove();
  };

  const rerender = (
    newProps: Partial<Parameters<typeof PhotoLightbox>[0]>
  ) => {
    act(() => {
      root.render(
        createElement(PhotoLightbox, { ...defaultProps, ...props, ...newProps })
      );
    });
  };

  return {
    container,
    getByTestId,
    queryByTestId,
    queryAllByTestId,
    cleanup,
    rerender,
    props: { ...defaultProps, ...props },
  };
}

describe('PhotoLightbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';

    // Default mock for loadPhoto that resolves successfully
    mockPhotoService.loadPhoto.mockResolvedValue({
      blobUrl: 'blob:mock-url',
      mimeType: 'image/jpeg',
      size: 1024 * 1024,
    });

    mockPhotoService.preloadPhotos.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('renders lightbox backdrop', () => {
      const { getByTestId, cleanup } = renderLightbox();

      expect(getByTestId('lightbox')).not.toBeNull();
      cleanup();
    });

    it('renders close button', () => {
      const { getByTestId, cleanup } = renderLightbox();

      expect(getByTestId('lightbox-close')).not.toBeNull();
      cleanup();
    });

    it('renders navigation buttons when hasNext and hasPrevious', () => {
      const { getByTestId, cleanup } = renderLightbox({
        hasNext: true,
        hasPrevious: true,
      });

      expect(getByTestId('lightbox-prev')).not.toBeNull();
      expect(getByTestId('lightbox-next')).not.toBeNull();
      cleanup();
    });

    it('hides prev button when hasPrevious is false', () => {
      const { queryByTestId, cleanup } = renderLightbox({
        hasPrevious: false,
        hasNext: true,
      });

      expect(queryByTestId('lightbox-prev')).toBeNull();
      expect(queryByTestId('lightbox-next')).not.toBeNull();
      cleanup();
    });

    it('hides next button when hasNext is false', () => {
      const { queryByTestId, cleanup } = renderLightbox({
        hasNext: false,
        hasPrevious: true,
      });

      expect(queryByTestId('lightbox-next')).toBeNull();
      expect(queryByTestId('lightbox-prev')).not.toBeNull();
      cleanup();
    });

    it('renders info toggle button', () => {
      const { getByTestId, cleanup } = renderLightbox();

      expect(getByTestId('lightbox-info-toggle')).not.toBeNull();
      cleanup();
    });

    it('renders photo counter with filename', () => {
      const photo = createMockPhoto('test');
      const { getByTestId, cleanup } = renderLightbox({ photo });

      const counter = getByTestId('lightbox-counter');
      expect(counter?.textContent).toContain(photo.filename);
      cleanup();
    });
  });

  describe('loading state', () => {
    it('shows loading spinner initially', () => {
      // Make loadPhoto pending
      mockPhotoService.loadPhoto.mockImplementation(
        () => new Promise(() => {}) // Never resolves
      );

      const { getByTestId, cleanup } = renderLightbox();

      expect(getByTestId('lightbox-loading')).not.toBeNull();
      cleanup();
    });
  });

  describe('loaded state', () => {
    it('shows image when loaded', async () => {
      mockPhotoService.loadPhoto.mockResolvedValue({
        blobUrl: 'blob:loaded-url',
        mimeType: 'image/jpeg',
        size: 2048,
      });

      const { getByTestId, cleanup } = renderLightbox();

      // Wait for async load
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(getByTestId('lightbox-image')).not.toBeNull();
      const img = getByTestId('lightbox-image') as HTMLImageElement;
      expect(img.src).toBe('blob:loaded-url');
      cleanup();
    });
  });

  describe('error state', () => {
    it('shows error message when load fails', async () => {
      mockPhotoService.loadPhoto.mockRejectedValue(new Error('Load failed'));

      const { getByTestId, cleanup } = renderLightbox();

      // Wait for async error
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(getByTestId('lightbox-error')).not.toBeNull();
      cleanup();
    });

    it('shows retry button on error', async () => {
      mockPhotoService.loadPhoto.mockRejectedValue(new Error('Load failed'));

      const { getByTestId, cleanup } = renderLightbox();

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(getByTestId('lightbox-retry')).not.toBeNull();
      cleanup();
    });

    it('retries loading when retry button clicked', async () => {
      mockPhotoService.loadPhoto.mockRejectedValueOnce(new Error('Load failed'));
      mockPhotoService.loadPhoto.mockResolvedValue({
        blobUrl: 'blob:retry-url',
        mimeType: 'image/jpeg',
        size: 1024,
      });

      const { getByTestId, cleanup } = renderLightbox();

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const retryButton = getByTestId('lightbox-retry') as HTMLButtonElement;

      await act(async () => {
        retryButton.click();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(mockPhotoService.loadPhoto).toHaveBeenCalledTimes(2);
      cleanup();
    });
  });

  describe('close functionality', () => {
    it('calls onClose when close button clicked', async () => {
      const onClose = vi.fn();
      const { getByTestId, cleanup } = renderLightbox({ onClose });

      const closeButton = getByTestId('lightbox-close') as HTMLButtonElement;

      act(() => {
        closeButton.click();
      });

      expect(onClose).toHaveBeenCalledTimes(1);
      cleanup();
    });

    it('calls onClose when backdrop clicked', async () => {
      const onClose = vi.fn();
      const { getByTestId, cleanup } = renderLightbox({ onClose });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const backdrop = getByTestId('lightbox') as HTMLDivElement;

      act(() => {
        // Simulate click on backdrop itself
        backdrop.click();
      });

      expect(onClose).toHaveBeenCalledTimes(1);
      cleanup();
    });
  });

  describe('navigation', () => {
    it('calls onPrevious when prev button clicked', async () => {
      const onPrevious = vi.fn();
      const { getByTestId, cleanup } = renderLightbox({
        onPrevious,
        hasPrevious: true,
      });

      const prevButton = getByTestId('lightbox-prev') as HTMLButtonElement;

      act(() => {
        prevButton.click();
      });

      expect(onPrevious).toHaveBeenCalledTimes(1);
      cleanup();
    });

    it('calls onNext when next button clicked', async () => {
      const onNext = vi.fn();
      const { getByTestId, cleanup } = renderLightbox({
        onNext,
        hasNext: true,
      });

      const nextButton = getByTestId('lightbox-next') as HTMLButtonElement;

      act(() => {
        nextButton.click();
      });

      expect(onNext).toHaveBeenCalledTimes(1);
      cleanup();
    });
  });

  describe('metadata panel', () => {
    it('renders metadata panel when showMetadata is true', () => {
      const { getByTestId, cleanup } = renderLightbox({ showMetadata: true });

      expect(getByTestId('lightbox-metadata')).not.toBeNull();
      cleanup();
    });

    it('hides metadata panel when showMetadata is false', () => {
      const { queryByTestId, cleanup } = renderLightbox({ showMetadata: false });

      expect(queryByTestId('lightbox-metadata')).toBeNull();
      expect(queryByTestId('lightbox-info-toggle')).toBeNull();
      cleanup();
    });

    it('toggles metadata visibility when info button clicked', async () => {
      const { getByTestId, cleanup } = renderLightbox();

      const infoToggle = getByTestId('lightbox-info-toggle') as HTMLButtonElement;
      const metadata = getByTestId('lightbox-metadata') as HTMLDivElement;

      // Initially hidden (no visible class)
      expect(metadata.classList.contains('lightbox-metadata-visible')).toBe(false);

      act(() => {
        infoToggle.click();
      });

      expect(metadata.classList.contains('lightbox-metadata-visible')).toBe(true);

      act(() => {
        infoToggle.click();
      });

      expect(metadata.classList.contains('lightbox-metadata-visible')).toBe(false);
      cleanup();
    });
  });

  describe('accessibility', () => {
    it('has dialog role', () => {
      const { getByTestId, cleanup } = renderLightbox();

      const lightbox = getByTestId('lightbox');
      expect(lightbox?.getAttribute('role')).toBe('dialog');
      cleanup();
    });

    it('has aria-modal attribute', () => {
      const { getByTestId, cleanup } = renderLightbox();

      const lightbox = getByTestId('lightbox');
      expect(lightbox?.getAttribute('aria-modal')).toBe('true');
      cleanup();
    });

    it('has aria-label with photo filename', () => {
      const photo = createMockPhoto('test-photo');
      const { getByTestId, cleanup } = renderLightbox({ photo });

      const lightbox = getByTestId('lightbox');
      expect(lightbox?.getAttribute('aria-label')).toContain(photo.filename);
      cleanup();
    });

    it('close button has aria-label', () => {
      const { getByTestId, cleanup } = renderLightbox();

      const closeButton = getByTestId('lightbox-close');
      expect(closeButton?.getAttribute('aria-label')).toBe('Close lightbox');
      cleanup();
    });

    it('navigation buttons have aria-labels', () => {
      const { getByTestId, cleanup } = renderLightbox({
        hasNext: true,
        hasPrevious: true,
      });

      expect(getByTestId('lightbox-prev')?.getAttribute('aria-label')).toBe(
        'Previous photo'
      );
      expect(getByTestId('lightbox-next')?.getAttribute('aria-label')).toBe(
        'Next photo'
      );
      cleanup();
    });
  });

  describe('preloading', () => {
    it('preloads photos from preloadQueue', async () => {
      const preloadQueue = [createMockPhoto('preload-1'), createMockPhoto('preload-2')];

      renderLightbox({ preloadQueue });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(mockPhotoService.preloadPhotos).toHaveBeenCalled();
    });

    it('does not preload when preloadQueue is empty', async () => {
      renderLightbox({ preloadQueue: [] });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(mockPhotoService.preloadPhotos).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('handles missing shardIds gracefully', async () => {
      const photoWithoutShards = {
        ...createMockPhoto('test'),
        shardIds: [],
      };

      const { getByTestId, cleanup } = renderLightbox({
        photo: photoWithoutShards,
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(getByTestId('lightbox-error')).not.toBeNull();
      cleanup();
    });
  });

  describe('cleanup', () => {
    it('releases photo on unmount', async () => {
      const { cleanup } = renderLightbox();

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      cleanup();

      expect(mockPhotoService.releasePhoto).toHaveBeenCalled();
    });
  });
});
