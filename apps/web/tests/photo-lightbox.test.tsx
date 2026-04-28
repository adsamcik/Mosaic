/**
 * PhotoLightbox Component Tests
 * Tests the updated UI with SVG icons for navigation, info, download, and delete
 * Tests viewport-based shard preloading behavior
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhotoLightbox } from '../src/components/Gallery/PhotoLightbox';
import * as photoEditService from '../src/lib/photo-edit-service';
import * as photoService from '../src/lib/photo-service';
import type { PhotoMeta } from '../src/workers/types';

const albumPermissionsMock = vi.hoisted(() => ({
  permissions: {
    role: 'owner',
    isOwner: true,
    canUpload: true,
    canDelete: true,
    canDownload: true,
    canManageMembers: true,
    canManageShareLinks: true,
    canEditAlbum: true,
    canSelect: true,
  },
}));

const defaultAlbumPermissions = {
  role: 'owner',
  isOwner: true,
  canUpload: true,
  canDelete: true,
  canDownload: true,
  canManageMembers: true,
  canManageShareLinks: true,
  canEditAlbum: true,
  canSelect: true,
} as const;

// Mock the photo-service
vi.mock('../src/lib/photo-service', () => ({
  loadPhoto: vi
    .fn()
    .mockResolvedValue({ blobUrl: 'blob:test-full', size: 2048 }),
  preloadPhotos: vi.fn().mockResolvedValue(undefined),
  releasePhoto: vi.fn(),
  getCachedPhoto: vi.fn().mockReturnValue(null), // Not cached by default
}));

vi.mock('../src/lib/photo-edit-service', () => ({
  rotatePhoto: vi.fn().mockResolvedValue({}),
  updatePhotoDescription: vi.fn().mockResolvedValue({}),
}));

// Mock the AlbumPermissionsContext
vi.mock('../src/contexts/AlbumPermissionsContext', () => ({
  useAlbumPermissions: () => albumPermissionsMock.permissions,
}));

beforeEach(() => {
  albumPermissionsMock.permissions = { ...defaultAlbumPermissions };
  vi.mocked(photoEditService.rotatePhoto).mockResolvedValue({} as PhotoMeta);
  vi.mocked(photoEditService.updatePhotoDescription).mockResolvedValue({} as PhotoMeta);
});

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

  describe('Rotate button', () => {
    async function renderLoaded(photo: PhotoMeta) {
      vi.mocked(photoService.getCachedPhoto).mockReturnValue(null);
      vi.mocked(photoService.loadPhoto).mockResolvedValue({
        blobUrl: 'blob:test-full',
        size: 2048,
      });

      await act(async () => {
        root.render(
          createElement(PhotoLightbox, {
            photo,
            epochReadKey: new Uint8Array(32),
            onClose: vi.fn(),
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }

    it('is hidden when canUpload is false', async () => {
      albumPermissionsMock.permissions = {
        ...defaultAlbumPermissions,
        canUpload: false,
      };

      await renderLoaded(createMockPhoto());

      expect(
        container.querySelector('[data-testid="lightbox-rotate-button"]'),
      ).toBeNull();
    });

    it('is visible when canUpload is true', async () => {
      await renderLoaded(createMockPhoto());

      const button = container.querySelector(
        '[data-testid="lightbox-rotate-button"]',
      ) as HTMLButtonElement | null;
      expect(button).not.toBeNull();
      expect(button?.disabled).toBe(false);
    });

    it('click rotates the displayed image', async () => {
      const photo = createMockPhoto();
      await renderLoaded(photo);

      const button = container.querySelector(
        '[data-testid="lightbox-rotate-button"]',
      ) as HTMLButtonElement;

      await act(async () => {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const image = container.querySelector(
        '[data-testid="lightbox-image"]',
      ) as HTMLImageElement;
      expect(image.style.transform).toContain('rotate(90deg)');
      expect(photoEditService.rotatePhoto).toHaveBeenCalledTimes(1);
      expect(photoEditService.rotatePhoto).toHaveBeenCalledWith(photo, 90);
    });

    it('keyboard r triggers rotation', async () => {
      await renderLoaded(createMockPhoto());

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(photoEditService.rotatePhoto).toHaveBeenCalledTimes(1);
    });

    it('reverts optimistic rotation when rotation fails', async () => {
      vi.mocked(photoEditService.rotatePhoto).mockRejectedValueOnce(
        new Error('rotation failed'),
      );
      await renderLoaded(createMockPhoto());

      const button = container.querySelector(
        '[data-testid="lightbox-rotate-button"]',
      ) as HTMLButtonElement;

      await act(async () => {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const image = container.querySelector(
        '[data-testid="lightbox-image"]',
      ) as HTMLImageElement;
      expect(image.style.transform).toBe('rotate(0deg)');
    });

    it('resets displayRotation when navigating to a different photo', async () => {
      const firstPhoto = createMockPhoto({ id: 'photo-rotated', rotation: 90 });
      const secondPhoto = createMockPhoto({ id: 'photo-unrotated', rotation: 0 });

      await renderLoaded(firstPhoto);

      let image = container.querySelector(
        '[data-testid="lightbox-image"]',
      ) as HTMLImageElement;
      expect(image.style.transform).toBe('rotate(90deg)');

      await act(async () => {
        root.render(
          createElement(PhotoLightbox, {
            photo: secondPhoto,
            epochReadKey: new Uint8Array(32),
            onClose: vi.fn(),
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      image = container.querySelector(
        '[data-testid="lightbox-image"]',
      ) as HTMLImageElement;
      expect(image.style.transform).toBe('rotate(0deg)');
    });
  });

  describe('Description editing', () => {
    async function renderLoaded(
      photo: PhotoMeta,
      props: Partial<Parameters<typeof PhotoLightbox>[0]> = {},
    ) {
      vi.mocked(photoService.getCachedPhoto).mockReturnValue(null);
      vi.mocked(photoService.loadPhoto).mockResolvedValue({
        blobUrl: 'blob:test-full',
        size: 2048,
      });

      await act(async () => {
        root.render(
          createElement(PhotoLightbox, {
            photo,
            epochReadKey: new Uint8Array(32),
            onClose: vi.fn(),
            ...props,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }

    function getDescriptionValue(): HTMLElement | null {
      const descriptions = Array.from(
        container.querySelectorAll('.lightbox-info-description'),
      );
      return descriptions[0] as HTMLElement | null;
    }

    function changeTextarea(textarea: HTMLTextAreaElement, value: string) {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(textarea, value);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    it('is read-only when canUpload is false', async () => {
      albumPermissionsMock.permissions = {
        ...defaultAlbumPermissions,
        canUpload: false,
      };
      const photo = createMockPhoto({ description: 'Read-only description' });

      await renderLoaded(photo);

      const description = getDescriptionValue();
      expect(description?.textContent).toBe('Read-only description');
      expect(description?.classList.contains('lightbox-description-clickable')).toBe(false);

      await act(async () => {
        description?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(container.querySelector('[data-testid="lightbox-description-textarea"]')).toBeNull();
    });

    it('hides empty description from viewers', async () => {
      albumPermissionsMock.permissions = {
        ...defaultAlbumPermissions,
        canUpload: false,
      };

      await renderLoaded(createMockPhoto({ description: undefined }));

      expect(container.textContent).not.toContain('lightbox.metadata.description');
      expect(container.textContent).not.toContain('lightbox.description.placeholder');
    });

    it('shows an empty description placeholder for editors', async () => {
      await renderLoaded(createMockPhoto({ description: undefined }));

      const description = getDescriptionValue();
      expect(container.textContent).toContain('lightbox.metadata.description');
      expect(description?.textContent).toBe('lightbox.description.placeholder');
      expect(description?.classList.contains('lightbox-description-placeholder')).toBe(true);
    });

    it('enters edit mode when clicking an editable description', async () => {
      const photo = createMockPhoto({ description: 'Editable description' });
      await renderLoaded(photo);

      await act(async () => {
        getDescriptionValue()?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const textarea = container.querySelector(
        '[data-testid="lightbox-description-textarea"]',
      ) as HTMLTextAreaElement | null;
      expect(textarea).not.toBeNull();
      expect(textarea?.value).toBe('Editable description');
    });

    it('saves edited description on blur', async () => {
      const photo = createMockPhoto({ description: 'Old value' });
      await renderLoaded(photo);

      await act(async () => {
        getDescriptionValue()?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const textarea = container.querySelector(
        '[data-testid="lightbox-description-textarea"]',
      ) as HTMLTextAreaElement;
      await act(async () => {
        changeTextarea(textarea, 'New value');
        textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(photoEditService.updatePhotoDescription).toHaveBeenCalledWith(photo, 'New value');
    });

    it('cancels with Escape after editing without saving on unmount blur', async () => {
      await renderLoaded(createMockPhoto({ description: 'Keep me' }));

      await act(async () => {
        getDescriptionValue()?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const textarea = container.querySelector(
        '[data-testid="lightbox-description-textarea"]',
      ) as HTMLTextAreaElement;
      textarea.focus();
      expect(document.activeElement).toBe(textarea);
      await act(async () => {
        changeTextarea(textarea, 'Discard me');
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      await act(async () => {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        textarea.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(photoEditService.updatePhotoDescription).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="lightbox-description-textarea"]')).toBeNull();
      expect(getDescriptionValue()?.textContent).toBe('Keep me');
    });

    it('cancels with Escape without saving when the draft is unchanged', async () => {
      await renderLoaded(createMockPhoto({ description: 'Keep me' }));

      await act(async () => {
        getDescriptionValue()?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const textarea = container.querySelector(
        '[data-testid="lightbox-description-textarea"]',
      ) as HTMLTextAreaElement;
      textarea.focus();
      expect(document.activeElement).toBe(textarea);

      await act(async () => {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        textarea.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(photoEditService.updatePhotoDescription).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="lightbox-description-textarea"]')).toBeNull();
      expect(getDescriptionValue()?.textContent).toBe('Keep me');
    });

    it('cancels with Escape after a prior successful save', async () => {
      const originalPhoto = createMockPhoto({ description: 'Old value' });
      await renderLoaded(originalPhoto);

      await act(async () => {
        getDescriptionValue()?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      let textarea = container.querySelector(
        '[data-testid="lightbox-description-textarea"]',
      ) as HTMLTextAreaElement;
      await act(async () => {
        changeTextarea(textarea, 'Saved value');
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => {
        textarea.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(photoEditService.updatePhotoDescription).toHaveBeenCalledTimes(1);
      expect(photoEditService.updatePhotoDescription).toHaveBeenLastCalledWith(
        originalPhoto,
        'Saved value',
      );

      const savedPhoto = { ...originalPhoto, description: 'Saved value' };
      await renderLoaded(savedPhoto);

      await act(async () => {
        getDescriptionValue()?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      textarea = container.querySelector(
        '[data-testid="lightbox-description-textarea"]',
      ) as HTMLTextAreaElement;
      textarea.focus();
      expect(document.activeElement).toBe(textarea);
      await act(async () => {
        changeTextarea(textarea, 'Discard after save');
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      await act(async () => {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        textarea.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(photoEditService.updatePhotoDescription).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[data-testid="lightbox-description-textarea"]')).toBeNull();
      expect(getDescriptionValue()?.textContent).toBe('Saved value');
    });

    it('saves with Ctrl+Enter', async () => {
      const photo = createMockPhoto({ description: 'Old value' });
      await renderLoaded(photo);

      await act(async () => {
        getDescriptionValue()?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const textarea = container.querySelector(
        '[data-testid="lightbox-description-textarea"]',
      ) as HTMLTextAreaElement;
      await act(async () => {
        changeTextarea(textarea, 'Keyboard save');
        textarea.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(photoEditService.updatePhotoDescription).toHaveBeenCalledWith(photo, 'Keyboard save');
    });

    it('does not navigate with arrow keys while editing', async () => {
      const onNext = vi.fn();
      await renderLoaded(createMockPhoto({ description: 'Edit me' }), {
        onNext,
        hasNext: true,
      });

      await act(async () => {
        getDescriptionValue()?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const textarea = container.querySelector(
        '[data-testid="lightbox-description-textarea"]',
      ) as HTMLTextAreaElement;
      await act(async () => {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(onNext).not.toHaveBeenCalled();
    });

    it('closes edit mode when navigating to a different photo', async () => {
      const firstPhoto = createMockPhoto({ id: 'photo-a', description: 'First description' });
      const secondPhoto = createMockPhoto({ id: 'photo-b', description: 'Second description' });
      await renderLoaded(firstPhoto);

      await act(async () => {
        getDescriptionValue()?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(container.querySelector('[data-testid="lightbox-description-textarea"]')).not.toBeNull();

      await act(async () => {
        root.render(
          createElement(PhotoLightbox, {
            photo: secondPhoto,
            epochReadKey: new Uint8Array(32),
            onClose: vi.fn(),
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(container.querySelector('[data-testid="lightbox-description-textarea"]')).toBeNull();
      expect(getDescriptionValue()?.textContent).toBe('Second description');
    });

    it('closes and reverts to original description when saving fails', async () => {
      vi.mocked(photoEditService.updatePhotoDescription).mockRejectedValueOnce(
        new Error('save failed'),
      );
      const photo = createMockPhoto({ description: 'Original description' });
      await renderLoaded(photo);

      await act(async () => {
        getDescriptionValue()?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const textarea = container.querySelector(
        '[data-testid="lightbox-description-textarea"]',
      ) as HTMLTextAreaElement;
      await act(async () => {
        changeTextarea(textarea, 'Draft description');
        textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(container.querySelector('[data-testid="lightbox-description-textarea"]')).toBeNull();
      expect(getDescriptionValue()?.textContent).toBe('Original description');
    });
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

  describe('Caching behavior', () => {
    it('uses cached photo immediately without loading', async () => {
      const cachedResult = { blobUrl: 'blob:cached', mimeType: 'image/jpeg', size: 4096 };
      vi.mocked(photoService.getCachedPhoto).mockReturnValue(cachedResult);

      const photo = createMockPhoto();

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

      // Should not call loadPhoto since it's cached
      expect(photoService.loadPhoto).not.toHaveBeenCalled();
      
      // Should show the image
      const image = container.querySelector('[data-testid="lightbox-image"]');
      expect(image).not.toBeNull();
      expect((image as HTMLImageElement).src).toBe('blob:cached');
    });

    it('shows thumbnail placeholder while loading full-res', async () => {
      // Not cached
      vi.mocked(photoService.getCachedPhoto).mockReturnValue(null);
      // Make loadPhoto take time
      vi.mocked(photoService.loadPhoto).mockImplementation(() => {
        return new Promise((resolve) => setTimeout(() => resolve({ 
          blobUrl: 'blob:full', 
          mimeType: 'image/jpeg', 
          size: 8192 
        }), 100));
      });

      const photo = createMockPhoto({ 
        thumbnail: 'base64EncodedThumbnail' 
      });

      await act(async () => {
        root.render(
          createElement(PhotoLightbox, {
            photo,
            epochReadKey: new Uint8Array(32),
            onClose: vi.fn(),
          }),
        );
        // Allow initial render but not full load
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      // Should show loading state with thumbnail
      const loading = container.querySelector('[data-testid="lightbox-loading"]');
      expect(loading).not.toBeNull();
      
      const thumbnail = container.querySelector('[data-testid="lightbox-thumbnail-placeholder"]');
      expect(thumbnail).not.toBeNull();
      expect((thumbnail as HTMLImageElement).src).toContain('data:image/jpeg;base64');
    });

    it('releases photo on unmount', async () => {
      const cachedResult = { blobUrl: 'blob:cached', mimeType: 'image/jpeg', size: 4096 };
      vi.mocked(photoService.getCachedPhoto).mockReturnValue(cachedResult);

      const photo = createMockPhoto();

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

      // Unmount
      await act(async () => {
        root.unmount();
      });

      // Should release the photo
      expect(photoService.releasePhoto).toHaveBeenCalledWith(`${photo.id}:full`);
    });
  });
});

/**
 * Video Playback Tests
 *
 * Tests video rendering, playback controls, pause-on-navigation,
 * spacebar toggle, and error handling in the lightbox.
 */
describe('Video Playback', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const pauseMock = vi.fn();
  const playMock = vi.fn(() => Promise.resolve());

  function createVideoPhoto(overrides: Partial<PhotoMeta> = {}): PhotoMeta {
    return {
      id: 'video-1',
      albumId: 'album-1',
      epochId: 'epoch-1',
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      isVideo: true,
      width: 1920,
      height: 1080,
      shardIds: ['shard-v1', 'shard-v2'],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      tags: [],
      ...overrides,
    };
  }

  function createImagePhoto(overrides: Partial<PhotoMeta> = {}): PhotoMeta {
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
      tags: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    pauseMock.mockClear();
    playMock.mockClear();

    // Reset photo-service mocks to defaults (clearAllMocks doesn't reset implementations)
    vi.mocked(photoService.loadPhoto).mockResolvedValue({
      blobUrl: 'blob:test-full',
      size: 2048,
    });
    vi.mocked(photoService.getCachedPhoto).mockReturnValue(null);
    vi.mocked(photoService.preloadPhotos).mockResolvedValue(undefined);

    // Mock HTMLVideoElement play/pause since happy-dom has limited support
    Object.defineProperty(HTMLVideoElement.prototype, 'pause', {
      value: pauseMock,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(HTMLVideoElement.prototype, 'play', {
      value: playMock,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  /** Helper: render a loaded lightbox and wait for the photo to resolve */
  async function renderLoaded(
    props: Partial<Parameters<typeof PhotoLightbox>[0]> & { photo: PhotoMeta },
  ) {
    await act(async () => {
      root.render(
        createElement(PhotoLightbox, {
          epochReadKey: new Uint8Array(32),
          onClose: vi.fn(),
          ...props,
        }),
      );
      // Allow loadPhoto promise to resolve and state to settle
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }

  describe('Video element rendering', () => {
    it('renders <video> element when photo.isVideo is true', async () => {
      await renderLoaded({ photo: createVideoPhoto() });

      const video = container.querySelector('[data-testid="lightbox-video"]');
      expect(video).not.toBeNull();
      expect(video?.tagName).toBe('VIDEO');
    });

    it('renders <video> element when mimeType is video/*', async () => {
      // isVideo not explicitly set, but mimeType triggers detection
      await renderLoaded({
        photo: createVideoPhoto({ isVideo: undefined, mimeType: 'video/webm' }),
      });

      const video = container.querySelector('[data-testid="lightbox-video"]');
      expect(video).not.toBeNull();
    });

    it('renders <img> element when photo is not a video', async () => {
      await renderLoaded({ photo: createImagePhoto() });

      const img = container.querySelector('[data-testid="lightbox-image"]');
      expect(img).not.toBeNull();
      expect(container.querySelector('[data-testid="lightbox-video"]')).toBeNull();
    });

    it('video element has controls attribute', async () => {
      await renderLoaded({ photo: createVideoPhoto() });

      const video = container.querySelector('video') as HTMLVideoElement;
      expect(video).not.toBeNull();
      expect(video.hasAttribute('controls')).toBe(true);
    });

    it('video element has autoPlay attribute', async () => {
      await renderLoaded({ photo: createVideoPhoto() });

      const video = container.querySelector('video') as HTMLVideoElement;
      expect(video).not.toBeNull();
      expect(video.autoplay).toBe(true);
    });

    it('video element has playsInline attribute', async () => {
      await renderLoaded({ photo: createVideoPhoto() });

      const video = container.querySelector('video') as HTMLVideoElement;
      expect(video).not.toBeNull();
      // happy-dom may not reflect playsInline as a property; check the attribute
      expect(video.hasAttribute('playsinline')).toBe(true);
    });

    it('video element src matches loaded blob URL', async () => {
      await renderLoaded({ photo: createVideoPhoto() });

      const video = container.querySelector('video') as HTMLVideoElement;
      expect(video).not.toBeNull();
      expect(video.src).toBe('blob:test-full');
    });
  });

  describe('Video pause on navigation', () => {
    it('pauses video when navigating to next photo', async () => {
      const onNext = vi.fn();

      await renderLoaded({
        photo: createVideoPhoto(),
        onNext,
        hasNext: true,
      });

      // Verify video is rendered
      expect(container.querySelector('video')).not.toBeNull();

      // Simulate ArrowRight keydown on window
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
        );
      });

      expect(pauseMock).toHaveBeenCalled();
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it('pauses video when navigating to previous photo', async () => {
      const onPrevious = vi.fn();

      await renderLoaded({
        photo: createVideoPhoto(),
        onPrevious,
        hasPrevious: true,
      });

      act(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
        );
      });

      expect(pauseMock).toHaveBeenCalled();
      expect(onPrevious).toHaveBeenCalledTimes(1);
    });
  });

  describe('Video pause on close', () => {
    it('pauses video when Escape key pressed', async () => {
      const onClose = vi.fn();

      await renderLoaded({
        photo: createVideoPhoto(),
        onClose,
      });

      act(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });

      expect(pauseMock).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });

    it('pauses video when close button clicked', async () => {
      const onClose = vi.fn();

      await renderLoaded({
        photo: createVideoPhoto(),
        onClose,
      });

      const closeButton = container.querySelector(
        '[data-testid="lightbox-close"]',
      ) as HTMLButtonElement;

      act(() => {
        closeButton.click();
      });

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('Spacebar handling', () => {
    it('spacebar toggles video play when paused', async () => {
      await renderLoaded({ photo: createVideoPhoto() });

      const video = container.querySelector('video') as HTMLVideoElement;
      expect(video).not.toBeNull();

      // Simulate paused state — the default `paused` on HTMLVideoElement
      // In happy-dom, paused is true by default
      Object.defineProperty(video, 'paused', {
        value: true,
        writable: true,
        configurable: true,
      });

      act(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
        );
      });

      expect(playMock).toHaveBeenCalled();
    });

    it('spacebar toggles video pause when playing', async () => {
      await renderLoaded({ photo: createVideoPhoto() });

      const video = container.querySelector('video') as HTMLVideoElement;
      expect(video).not.toBeNull();

      // Simulate playing state
      Object.defineProperty(video, 'paused', {
        value: false,
        writable: true,
        configurable: true,
      });

      act(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
        );
      });

      expect(pauseMock).toHaveBeenCalled();
    });

    it('spacebar does not trigger navigation', async () => {
      const onNext = vi.fn();
      const onPrevious = vi.fn();

      await renderLoaded({
        photo: createVideoPhoto(),
        onNext,
        onPrevious,
        hasNext: true,
        hasPrevious: true,
      });

      act(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
        );
      });

      expect(onNext).not.toHaveBeenCalled();
      expect(onPrevious).not.toHaveBeenCalled();
    });
  });

  describe('Video error handling', () => {
    it('shows an inline overlay when video fails to play but keeps the blob loaded', async () => {
      await renderLoaded({ photo: createVideoPhoto() });

      const video = container.querySelector('video') as HTMLVideoElement;
      expect(video).not.toBeNull();

      // Simulate the browser failing to decode the video (e.g. HEVC .mov on
      // Chrome). Stub the readonly `error` getter to return a real
      // MEDIA_ERR_SRC_NOT_SUPPORTED.
      Object.defineProperty(video, 'error', {
        configurable: true,
        get: () => ({
          code: 4,
          MEDIA_ERR_ABORTED: 1,
          MEDIA_ERR_NETWORK: 2,
          MEDIA_ERR_DECODE: 3,
          MEDIA_ERR_SRC_NOT_SUPPORTED: 4,
          message: 'unsupported',
        }),
      });

      await act(async () => {
        video.dispatchEvent(new Event('error', { bubbles: false }));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      // The lightbox stays in the loaded state — the blob is still cached
      // and the user can navigate away, retry, or download it. The full
      // 'Failed to load photo' error screen must NOT appear.
      expect(container.querySelector('[data-testid="lightbox-error"]')).toBeNull();

      const overlay = container.querySelector(
        '[data-testid="lightbox-video-error"]',
      );
      expect(overlay).not.toBeNull();
      expect(overlay?.textContent ?? '').toMatch(/cannot play this video format/i);

      // Download fallback is offered (canDownload defaults to true under the
      // test album-permissions context).
      expect(
        container.querySelector('[data-testid="lightbox-video-error-download"]'),
      ).not.toBeNull();
    });
  });

  describe('Cleanup', () => {
    it('pauses video when photo changes (rerender with different photo)', async () => {
      await renderLoaded({ photo: createVideoPhoto({ id: 'video-a' }) });

      expect(container.querySelector('video')).not.toBeNull();

      // Rerender with a different photo — the useEffect cleanup should pause
      await act(async () => {
        root.render(
          createElement(PhotoLightbox, {
            photo: createVideoPhoto({ id: 'video-b' }),
            epochReadKey: new Uint8Array(32),
            onClose: vi.fn(),
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      // pauseVideo is called in the useEffect cleanup when photo.id changes
      expect(pauseMock).toHaveBeenCalled();
    });
  });
});
