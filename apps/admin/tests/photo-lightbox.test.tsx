/**
 * PhotoLightbox Component Tests
 * Tests the updated UI with SVG icons for navigation, info, download, and delete
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhotoLightbox } from '../src/components/Gallery/PhotoLightbox';
import type { PhotoMeta } from '../src/workers/types';

// Mock the photo-service
vi.mock('../src/lib/photo-service', () => ({
  loadPhoto: vi.fn().mockResolvedValue({ blobUrl: 'blob:test-full', size: 2048 }),
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
        })
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
        })
      );
    });

    const closeButton = container.querySelector('[data-testid="lightbox-close"]');
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
        })
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
        })
      );
    });

    const infoButton = container.querySelector('[data-testid="lightbox-info-toggle"]');
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
        })
      );
    });

    const deleteButton = container.querySelector('[data-testid="lightbox-delete"]');
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
        })
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
        })
      );
    });

    const closeButton = container.querySelector('[data-testid="lightbox-close"]') as HTMLButtonElement;

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
        })
      );
    });

    const counter = container.querySelector('[data-testid="lightbox-counter"]');
    expect(counter).not.toBeNull();
    expect(counter?.textContent).toContain('vacation-photo.jpg');
  });
});
