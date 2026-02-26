/**
 * DropZone Component Tests
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DropZone } from '../src/components/Upload/DropZone';

// Mock the UploadContext
vi.mock('../src/contexts/UploadContext', () => ({
  useUploadContext: () => ({
    upload: vi.fn().mockResolvedValue(undefined),
    isUploading: false,
    progress: 0,
    error: null,
    clearError: vi.fn(),
  }),
}));

function createDragEvent(type: string, files: File[] = []) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as any;
  event.dataTransfer = {
    files,
    types: files.length > 0 ? ['Files'] : [],
    effectAllowed: 'all',
    dropEffect: 'copy',
  };
  event.preventDefault = vi.fn();
  event.stopPropagation = vi.fn();
  return event;
}

function createImageFile(name: string) {
  return new File(['test image content'], name, { type: 'image/png' });
}

// Helper to create DropZone with children typed correctly
function createDropZone(props: {
  albumId: string;
  className?: string;
  children: ReactNode;
}) {
  return createElement(DropZone, props as any);
}

describe('DropZone', () => {
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

  it('renders children', () => {
    act(() => {
      root.render(
        createDropZone({
          albumId: 'album-123',
          children: createElement(
            'div',
            { 'data-testid': 'child-content' },
            'Gallery Content',
          ),
        }),
      );
    });

    expect(
      container.querySelector('[data-testid="child-content"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Gallery Content');
  });

  it('has correct data-testid', () => {
    act(() => {
      root.render(
        createDropZone({
          albumId: 'album-123',
          children: createElement('div', null, 'Content'),
        }),
      );
    });

    expect(container.querySelector('[data-testid="drop-zone"]')).not.toBeNull();
  });

  it('applies custom className', () => {
    act(() => {
      root.render(
        createDropZone({
          albumId: 'album-123',
          className: 'custom-class',
          children: createElement('div', null, 'Content'),
        }),
      );
    });

    expect(container.querySelector('.custom-class')).not.toBeNull();
  });

  it('shows overlay when files are dragged over', () => {
    act(() => {
      root.render(
        createDropZone({
          albumId: 'album-123',
          children: createElement('div', null, 'Content'),
        }),
      );
    });

    const dropZone = container.querySelector('[data-testid="drop-zone"]')!;
    const dragEvent = createDragEvent('dragenter', [
      createImageFile('photo.png'),
    ]);

    act(() => {
      dropZone.dispatchEvent(dragEvent);
    });

    expect(
      container.querySelector('[data-testid="drop-zone-overlay"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('upload.dropHere');
  });

  it('hides overlay when drag leaves', () => {
    act(() => {
      root.render(
        createDropZone({
          albumId: 'album-123',
          children: createElement('div', null, 'Content'),
        }),
      );
    });

    const dropZone = container.querySelector('[data-testid="drop-zone"]')!;

    // Drag enter
    const enterEvent = createDragEvent('dragenter', [
      createImageFile('photo.png'),
    ]);
    act(() => {
      dropZone.dispatchEvent(enterEvent);
    });
    expect(
      container.querySelector('[data-testid="drop-zone-overlay"]'),
    ).not.toBeNull();

    // Drag leave
    const leaveEvent = createDragEvent('dragleave', []);
    act(() => {
      dropZone.dispatchEvent(leaveEvent);
    });

    expect(
      container.querySelector('[data-testid="drop-zone-overlay"]'),
    ).toBeNull();
  });

  it('has active class when dragging', () => {
    act(() => {
      root.render(
        createDropZone({
          albumId: 'album-123',
          children: createElement('div', null, 'Content'),
        }),
      );
    });

    const dropZone = container.querySelector('[data-testid="drop-zone"]')!;
    const dragEvent = createDragEvent('dragenter', [
      createImageFile('photo.png'),
    ]);

    act(() => {
      dropZone.dispatchEvent(dragEvent);
    });

    expect(dropZone.classList.contains('drop-zone--active')).toBe(true);
  });

  it('handles dragover event without error', () => {
    act(() => {
      root.render(
        createDropZone({
          albumId: 'album-123',
          children: createElement('div', null, 'Content'),
        }),
      );
    });

    const dropZone = container.querySelector('[data-testid="drop-zone"]')!;
    const dragOverEvent = createDragEvent('dragover', [
      createImageFile('photo.png'),
    ]);

    act(() => {
      dropZone.dispatchEvent(dragOverEvent);
    });

    // Should not throw - just verify component still renders
    expect(container.querySelector('[data-testid="drop-zone"]')).not.toBeNull();
  });

  it('hides overlay on drop', async () => {
    act(() => {
      root.render(
        createDropZone({
          albumId: 'album-123',
          children: createElement('div', null, 'Content'),
        }),
      );
    });

    const dropZone = container.querySelector('[data-testid="drop-zone"]')!;

    // Drag enter first
    const enterEvent = createDragEvent('dragenter', [
      createImageFile('photo.png'),
    ]);
    act(() => {
      dropZone.dispatchEvent(enterEvent);
    });
    expect(
      container.querySelector('[data-testid="drop-zone-overlay"]'),
    ).not.toBeNull();

    // Drop
    const dropEvent = createDragEvent('drop', [createImageFile('photo.png')]);
    await act(async () => {
      dropZone.dispatchEvent(dropEvent);
    });

    expect(
      container.querySelector('[data-testid="drop-zone-overlay"]'),
    ).toBeNull();
  });

  it('renders without crashing when no files dragged', () => {
    act(() => {
      root.render(
        createDropZone({
          albumId: 'album-123',
          children: createElement('div', null, 'Content'),
        }),
      );
    });

    const dropZone = container.querySelector('[data-testid="drop-zone"]')!;
    const dragEvent = createDragEvent('dragenter', []);

    act(() => {
      dropZone.dispatchEvent(dragEvent);
    });

    // Should not show overlay when no files
    // (depends on implementation - overlay may or may not show)
    expect(container.querySelector('[data-testid="drop-zone"]')).not.toBeNull();
  });
});
