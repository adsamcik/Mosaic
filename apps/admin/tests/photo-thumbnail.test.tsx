/**
 * PhotoThumbnail Component Tests
 * Tests the updated UI with SVG icons for placeholder, delete, and error states
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhotoThumbnail } from '../src/components/Gallery/PhotoThumbnail';
import type { PhotoMeta } from '../src/workers/types';

// Mock the photo-service
vi.mock('../src/lib/photo-service', () => ({
  loadPhoto: vi.fn().mockResolvedValue({ blobUrl: 'blob:test', size: 1024 }),
  releasePhoto: vi.fn(),
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
    tags: [],
    ...overrides,
  };
}

describe('PhotoThumbnail', () => {
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

  it('renders the photo thumbnail container', () => {
    act(() => {
      root.render(
        createElement(PhotoThumbnail, {
          photo: createMockPhoto(),
        })
      );
    });

    const thumbnail = container.querySelector('[data-testid="photo-thumbnail"]');
    expect(thumbnail).not.toBeNull();
  });

  it('renders placeholder with SVG icon when no epoch key', () => {
    act(() => {
      root.render(
        createElement(PhotoThumbnail, {
          photo: createMockPhoto(),
          // No epochReadKey provided
        })
      );
    });

    const placeholder = container.querySelector('[data-testid="photo-placeholder"]');
    expect(placeholder).not.toBeNull();

    // Should have SVG icons for image and lock
    const svgs = placeholder?.querySelectorAll('svg');
    expect(svgs?.length).toBeGreaterThanOrEqual(1);

    // Should NOT contain emoji characters
    expect(placeholder?.textContent).not.toContain('🖼️');
    expect(placeholder?.textContent).not.toContain('🔒');
  });

  it('has onDelete callback prop', () => {
    const onDelete = vi.fn();

    act(() => {
      root.render(
        createElement(PhotoThumbnail, {
          photo: createMockPhoto(),
          epochReadKey: new Uint8Array(32),
          onDelete,
        })
      );
    });

    // Verify the component accepts onDelete prop without error
    const thumbnail = container.querySelector('[data-testid="photo-thumbnail"]');
    expect(thumbnail).not.toBeNull();
  });


  it('shows selected state when isSelected is true', () => {
    act(() => {
      root.render(
        createElement(PhotoThumbnail, {
          photo: createMockPhoto(),
          isSelected: true,
          selectionMode: true,
          onSelectionChange: vi.fn(),
        })
      );
    });

    const thumbnail = container.querySelector('.photo-thumbnail-selected');
    expect(thumbnail).not.toBeNull();
  });

  it('shows checkbox in selection mode', () => {
    act(() => {
      root.render(
        createElement(PhotoThumbnail, {
          photo: createMockPhoto(),
          selectionMode: true,
          onSelectionChange: vi.fn(),
        })
      );
    });

    const checkbox = container.querySelector('[data-testid="photo-checkbox"]');
    expect(checkbox).not.toBeNull();
  });
});
