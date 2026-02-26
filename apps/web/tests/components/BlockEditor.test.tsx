/**
 * Block Editor Tests
 *
 * Tests for the block editor components including photo caption editing.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BlockEditorItem,
  TextEditor,
  HeadingEditor,
  PhotoGridEditor,
  ContentEditor,
} from '../../src/components/Content/BlockEditor';
import type {
  PhotoBlock,
  HeadingBlock,
  TextBlock,
  RichTextSegment,
  ContentBlock,
} from '../../src/lib/content-blocks';
import { ToastProvider } from '../../src/contexts/ToastContext';
import { ToastContainer } from '../../src/components/Toast';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      // Return key with any interpolated values
      if (opts) {
        return Object.entries(opts).reduce(
          (acc, [k, v]) => acc.replace(`{{${k}}}`, String(v)),
          key
        );
      }
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

// Mock TipTap - it doesn't work well in happy-dom
vi.mock('@tiptap/react', () => ({
  useEditor: vi.fn(() => ({
    getHTML: () => '<p></p>',
    destroy: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  })),
  EditorContent: ({ editor }: { editor: unknown }) =>
    createElement('div', { 'data-testid': 'editor-content' }),
}));

// Mock DnD-Kit
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => 
    createElement('div', { 'data-testid': 'dnd-context' }, children),
  closestCenter: vi.fn(),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(),
}));

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) =>
    createElement('div', { 'data-testid': 'sortable-context' }, children),
  sortableKeyboardCoordinates: vi.fn(),
  useSortable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  })),
  verticalListSortingStrategy: vi.fn(),
  horizontalListSortingStrategy: vi.fn(),
  arrayMove: vi.fn((arr: unknown[], from: number, to: number) => {
    const result = [...arr];
    const [removed] = result.splice(from, 1);
    result.splice(to, 0, removed);
    return result;
  }),
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: () => null,
    },
  },
}));

// Helper to render component and get container
function renderComponent<P extends object>(
  Component: React.ComponentType<P>,
  props: P,
) {
  const container = document.createElement('div');
  document.body.appendChild(container);

  let root: ReturnType<typeof createRoot>;
  act(() => {
    root = createRoot(container);
    root.render(createElement(Component, props));
  });

  const cleanup = () => {
    act(() => {
      root!.unmount();
    });
    container.remove();
  };

  return { container, cleanup };
}

// Setup and teardown for each test
let cleanupFns: (() => void)[] = [];

afterEach(() => {
  cleanupFns.forEach((fn) => fn());
  cleanupFns = [];
});

function render<P extends object>(Component: React.ComponentType<P>, props: P) {
  const result = renderComponent(Component, props);
  cleanupFns.push(result.cleanup);
  return result;
}

describe('BlockEditorItem', () => {
  describe('photo block', () => {
    it('renders photo preview with thumbnail URL', () => {
      const block: PhotoBlock = {
        id: 'photo-1',
        type: 'photo',
        manifestId: 'manifest-123',
        position: 'a',
      };
      const onUpdate = vi.fn();
      const onDelete = vi.fn();
      const getThumbnailUrl = vi.fn(() => 'https://example.com/thumb.jpg');

      const { container } = render(BlockEditorItem, {
        block,
        onUpdate,
        onDelete,
        getThumbnailUrl,
      });

      const img = container.querySelector('.photo-block-preview');
      expect(img).not.toBeNull();
      expect(img?.getAttribute('src')).toBe('https://example.com/thumb.jpg');
    });

    it('renders placeholder when no thumbnail URL', () => {
      const block: PhotoBlock = {
        id: 'photo-1',
        type: 'photo',
        manifestId: 'manifest-123',
        position: 'a',
      };
      const onUpdate = vi.fn();
      const onDelete = vi.fn();

      const { container } = render(BlockEditorItem, {
        block,
        onUpdate,
        onDelete,
      });

      const placeholder = container.querySelector('.photo-block-placeholder');
      expect(placeholder).not.toBeNull();
      expect(placeholder?.textContent).toContain('Photo:');
    });

    it('renders caption editor', () => {
      const block: PhotoBlock = {
        id: 'photo-1',
        type: 'photo',
        manifestId: 'manifest-123',
        position: 'a',
      };
      const onUpdate = vi.fn();
      const onDelete = vi.fn();
      const getThumbnailUrl = vi.fn(() => 'https://example.com/thumb.jpg');

      const { container } = render(BlockEditorItem, {
        block,
        onUpdate,
        onDelete,
        getThumbnailUrl,
      });

      const captionEditor = container.querySelector('.photo-caption-editor');
      expect(captionEditor).not.toBeNull();
    });

    it('includes photo-block-editor container', () => {
      const block: PhotoBlock = {
        id: 'photo-1',
        type: 'photo',
        manifestId: 'manifest-123',
        position: 'a',
        caption: [{ text: 'Test caption' }],
      };
      const onUpdate = vi.fn();
      const onDelete = vi.fn();

      const { container } = render(BlockEditorItem, {
        block,
        onUpdate,
        onDelete,
      });

      const editor = container.querySelector('.photo-block-editor');
      expect(editor).not.toBeNull();
    });

    it('renders with existing caption', () => {
      const block: PhotoBlock = {
        id: 'photo-1',
        type: 'photo',
        manifestId: 'manifest-123',
        position: 'a',
        caption: [{ text: 'Existing caption' }],
      };
      const onUpdate = vi.fn();
      const onDelete = vi.fn();
      const getThumbnailUrl = vi.fn(() => 'https://example.com/thumb.jpg');

      const { container } = render(BlockEditorItem, {
        block,
        onUpdate,
        onDelete,
        getThumbnailUrl,
      });

      // Caption editor should be present
      const captionEditor = container.querySelector('.photo-caption-editor');
      expect(captionEditor).not.toBeNull();
      // Text editor should be inside
      const textEditor = captionEditor?.querySelector('.text-editor');
      expect(textEditor).not.toBeNull();
    });
  });

  describe('heading block', () => {
    it('renders heading editor', () => {
      const block: HeadingBlock = {
        id: 'heading-1',
        type: 'heading',
        level: 1,
        text: 'Test Heading',
        position: 'a',
      };
      const onUpdate = vi.fn();
      const onDelete = vi.fn();

      const { container } = render(BlockEditorItem, {
        block,
        onUpdate,
        onDelete,
      });

      const headingEditor = container.querySelector('.heading-editor');
      expect(headingEditor).not.toBeNull();
    });
  });

  describe('text block', () => {
    it('renders text editor', () => {
      const block: TextBlock = {
        id: 'text-1',
        type: 'text',
        segments: [{ text: 'Test text' }],
        position: 'a',
      };
      const onUpdate = vi.fn();
      const onDelete = vi.fn();

      const { container } = render(BlockEditorItem, {
        block,
        onUpdate,
        onDelete,
      });

      const textEditor = container.querySelector('.text-editor');
      expect(textEditor).not.toBeNull();
    });
  });
});

describe('TextEditor', () => {
  it('renders editor content', () => {
    const content: RichTextSegment[] = [{ text: 'Hello' }];
    const onChange = vi.fn();

    const { container } = render(TextEditor, {
      content,
      onChange,
    });

    // Should have text-editor wrapper
    expect(container.querySelector('.text-editor')).not.toBeNull();
  });

  it('renders with placeholder', () => {
    const content: RichTextSegment[] = [{ text: '' }];
    const onChange = vi.fn();

    const { container } = render(TextEditor, {
      content,
      onChange,
      placeholder: 'Type here...',
    });

    expect(container.querySelector('.text-editor')).not.toBeNull();
  });
});

describe('HeadingEditor', () => {
  it('renders with text and level', () => {
    const onChange = vi.fn();

    const { container } = render(HeadingEditor, {
      text: 'My Heading',
      level: 2,
      onChange,
    });

    const input = container.querySelector('.heading-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe('My Heading');
    expect(input.classList.contains('heading-level-2')).toBe(true);
  });

  it('renders level buttons', () => {
    const onChange = vi.fn();

    const { container } = render(HeadingEditor, {
      text: 'Test',
      level: 1,
      onChange,
    });

    const buttons = container.querySelectorAll('.heading-level-btn');
    expect(buttons.length).toBe(3);
  });

  it('highlights active level button', () => {
    const onChange = vi.fn();

    const { container } = render(HeadingEditor, {
      text: 'Test',
      level: 2,
      onChange,
    });

    const activeButton = container.querySelector('.heading-level-btn.active');
    expect(activeButton).not.toBeNull();
    expect(activeButton?.textContent).toBe('H2');
  });
});

describe('PhotoGridEditor', () => {
  it('renders photo thumbnails', () => {
    const onUpdate = vi.fn();
    const onAddPhotos = vi.fn();
    const getThumbnailUrl = vi.fn((id: string) => `https://example.com/${id}.jpg`);

    const { container } = render(PhotoGridEditor, {
      manifestIds: ['photo-1', 'photo-2'],
      layout: 'grid',
      onUpdate,
      getThumbnailUrl,
      onAddPhotos,
    });

    // Should have thumbnail images
    const thumbs = container.querySelectorAll('.grid-photo-thumb');
    expect(thumbs.length).toBe(2);
  });

  it('renders add button when under limit', () => {
    const onUpdate = vi.fn();
    const onAddPhotos = vi.fn();

    const { container } = render(PhotoGridEditor, {
      manifestIds: ['photo-1'],
      layout: 'grid',
      onUpdate,
      onAddPhotos,
    });

    // Should have add button
    const addButton = container.querySelector('.grid-photo-add');
    expect(addButton).not.toBeNull();
  });

  it('hides add button at max capacity', () => {
    const onUpdate = vi.fn();
    const onAddPhotos = vi.fn();
    // Create 12 photos (max)
    const manifestIds = Array.from({ length: 12 }, (_, i) => `photo-${i}`);

    const { container } = render(PhotoGridEditor, {
      manifestIds,
      layout: 'grid',
      onUpdate,
      onAddPhotos,
    });

    // Should NOT have add button at max capacity
    const addButton = container.querySelector('.grid-photo-add');
    expect(addButton).toBeNull();
  });

  it('renders remove buttons on photos', () => {
    const onUpdate = vi.fn();
    const onAddPhotos = vi.fn();

    const { container } = render(PhotoGridEditor, {
      manifestIds: ['photo-1', 'photo-2'],
      layout: 'grid',
      onUpdate,
      onAddPhotos,
    });

    // Should have remove buttons
    const removeButtons = container.querySelectorAll('.grid-photo-remove');
    expect(removeButtons.length).toBe(2);
  });

  it('renders layout selector with current value', () => {
    const onUpdate = vi.fn();
    const onAddPhotos = vi.fn();

    const { container } = render(PhotoGridEditor, {
      manifestIds: ['photo-1'],
      layout: 'masonry',
      onUpdate,
      onAddPhotos,
    });

    const select = container.querySelector('.photo-group-layout-select') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select?.value).toBe('masonry');
  });

  it('renders photo count', () => {
    const onUpdate = vi.fn();
    const onAddPhotos = vi.fn();

    const { container } = render(PhotoGridEditor, {
      manifestIds: ['photo-1', 'photo-2', 'photo-3'],
      layout: 'grid',
      onUpdate,
      onAddPhotos,
    });

    const countElement = container.querySelector('.photo-grid-count');
    expect(countElement).not.toBeNull();
  });
});

describe('ContentEditor', () => {
  // Helper to render ContentEditor wrapped in ToastProvider with ToastContainer
  function renderWithToast<P extends object>(
    Component: React.ComponentType<P>,
    props: P,
  ) {
    const container = document.createElement('div');
    document.body.appendChild(container);

    let root: ReturnType<typeof createRoot>;
    act(() => {
      root = createRoot(container);
      root.render(
        createElement(ToastProvider, null,
          createElement('div', null,
            createElement(Component, props),
            createElement(ToastContainer)
          )
        )
      );
    });

    const cleanup = () => {
      act(() => {
        root!.unmount();
      });
      container.remove();
    };

    cleanupFns.push(cleanup);
    return { container, cleanup };
  }

  describe('block deletion with undo', () => {
    it('calls onBlockRemove when delete button is clicked', () => {
      const blocks: ContentBlock[] = [
        {
          id: 'heading-1',
          type: 'heading',
          text: 'Test Heading',
          level: 2,
          position: 'a',
        },
      ];
      const onBlockUpdate = vi.fn();
      const onBlockAdd = vi.fn();
      const onBlockRemove = vi.fn();
      const onBlockMove = vi.fn();

      const { container } = renderWithToast(ContentEditor, {
        blocks,
        onBlockUpdate,
        onBlockAdd,
        onBlockRemove,
        onBlockMove,
      });

      // Find and click the delete button
      const deleteButton = container.querySelector('.sortable-block-delete');
      expect(deleteButton).not.toBeNull();
      
      act(() => {
        (deleteButton as HTMLButtonElement)?.click();
      });

      expect(onBlockRemove).toHaveBeenCalledWith('heading-1');
    });

    it('shows toast notification when block is deleted', () => {
      const blocks: ContentBlock[] = [
        {
          id: 'text-1',
          type: 'text',
          segments: [{ text: 'Test' }],
          position: 'a',
        },
      ];
      const onBlockUpdate = vi.fn();
      const onBlockAdd = vi.fn();
      const onBlockRemove = vi.fn();
      const onBlockMove = vi.fn();

      const { container } = renderWithToast(ContentEditor, {
        blocks,
        onBlockUpdate,
        onBlockAdd,
        onBlockRemove,
        onBlockMove,
      });

      // Click delete button
      const deleteButton = container.querySelector('.sortable-block-delete');
      act(() => {
        (deleteButton as HTMLButtonElement)?.click();
      });

      // Toast should appear in the document (ToastContainer renders to body)
      const toast = document.querySelector('[data-testid="toast-info"]');
      expect(toast).not.toBeNull();
      // Mock returns translation key, not the value
      expect(toast?.textContent).toContain('content.blockDeleted');
    });

    it('shows undo button in toast', () => {
      const blocks: ContentBlock[] = [
        {
          id: 'divider-1',
          type: 'divider',
          style: 'line',
          position: 'a',
        },
      ];
      const onBlockUpdate = vi.fn();
      const onBlockAdd = vi.fn();
      const onBlockRemove = vi.fn();
      const onBlockMove = vi.fn();

      renderWithToast(ContentEditor, {
        blocks,
        onBlockUpdate,
        onBlockAdd,
        onBlockRemove,
        onBlockMove,
      });

      // Click delete button
      const deleteButton = document.querySelector('.sortable-block-delete');
      act(() => {
        (deleteButton as HTMLButtonElement)?.click();
      });

      // Undo button should be present
      const undoButton = document.querySelector('[data-testid="toast-action"]');
      expect(undoButton).not.toBeNull();
      // Mock returns translation key, not the value
      expect(undoButton?.textContent).toContain('common.undo');
    });

    it('calls onBlockAdd when undo is clicked', () => {
      const originalBlock: ContentBlock = {
        id: 'quote-1',
        type: 'quote',
        text: [{ text: 'Famous quote' }],
        position: 'a',
      };
      const blocks: ContentBlock[] = [originalBlock];
      const onBlockUpdate = vi.fn();
      const onBlockAdd = vi.fn();
      const onBlockRemove = vi.fn();
      const onBlockMove = vi.fn();

      renderWithToast(ContentEditor, {
        blocks,
        onBlockUpdate,
        onBlockAdd,
        onBlockRemove,
        onBlockMove,
      });

      // Click delete button
      const deleteButton = document.querySelector('.sortable-block-delete');
      act(() => {
        (deleteButton as HTMLButtonElement)?.click();
      });

      // Click undo button
      const undoButton = document.querySelector('[data-testid="toast-action"]');
      act(() => {
        (undoButton as HTMLButtonElement)?.click();
      });

      // onBlockAdd should be called with the original block
      expect(onBlockAdd).toHaveBeenCalledWith(originalBlock);
    });
  });
});
