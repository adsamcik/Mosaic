/**
 * Block Editor Component
 *
 * TipTap-based editor for editing album content blocks.
 * Provides WYSIWYG editing for text blocks and block management.
 */

import React, { memo, useCallback, useMemo, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type {
  ContentBlock,
  RichTextSegment,
} from '../../lib/content-blocks';
import {
  createTextBlock,
  createHeadingBlock,
  createDividerBlock,
  createPhotoBlock,
  createPhotoGroupBlock,
  createQuoteBlock,
} from '../../lib/content-blocks';
import { PhotoPickerDialog } from './PhotoPickerDialog';
import './BlockEditor.css';

// ==============================================================================
// TipTap Extensions Configuration
// ==============================================================================

const createEditorExtensions = (placeholder: string) => [
  StarterKit.configure({
    heading: {
      levels: [1, 2, 3],
    },
  }),
  Placeholder.configure({
    placeholder,
  }),
];

// ==============================================================================
// Text Editor Component
// ==============================================================================

export interface TextEditorProps {
  content: RichTextSegment[];
  onChange: (segments: RichTextSegment[]) => void;
  placeholder?: string | undefined;
}

/**
 * Convert RichTextSegments to TipTap HTML
 */
function segmentsToHtml(segments: RichTextSegment[]): string {
  return segments
    .map((segment) => {
      let text = segment.text;
      if (segment.code) {
        text = `<code>${text}</code>`;
      }
      if (segment.bold) {
        text = `<strong>${text}</strong>`;
      }
      if (segment.italic) {
        text = `<em>${text}</em>`;
      }
      if (segment.href) {
        text = `<a href="${segment.href}">${text}</a>`;
      }
      return text;
    })
    .join('');
}

/**
 * Convert TipTap HTML to RichTextSegments
 */
function htmlToSegments(html: string): RichTextSegment[] {
  // Simple parsing - in production would use DOM parsing
  const div = document.createElement('div');
  div.innerHTML = html;
  const segments: RichTextSegment[] = [];

  function walk(node: Node, formatting: Partial<RichTextSegment> = {}) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      if (text) {
        segments.push({ text, ...formatting });
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      const newFormatting = { ...formatting };

      switch (el.tagName.toLowerCase()) {
        case 'strong':
        case 'b':
          newFormatting.bold = true;
          break;
        case 'em':
        case 'i':
          newFormatting.italic = true;
          break;
        case 'code':
          newFormatting.code = true;
          break;
        case 'a':
          newFormatting.href = el.getAttribute('href') || undefined;
          break;
      }

      for (const child of Array.from(node.childNodes)) {
        walk(child, newFormatting);
      }
    }
  }

  walk(div);
  return segments.length > 0 ? segments : [{ text: '' }];
}

export const TextEditor = memo(function TextEditor({
  content,
  onChange,
  placeholder = 'Type something...',
}: TextEditorProps) {
  const editor = useEditor({
    extensions: createEditorExtensions(placeholder),
    content: `<p>${segmentsToHtml(content)}</p>`,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      // Extract content from paragraph wrapper
      const match = html.match(/<p>(.*)<\/p>/s);
      const innerHtml = match ? match[1] ?? '' : html;
      onChange(htmlToSegments(innerHtml));
    },
  });

  return (
    <div className="text-editor">
      <EditorContent editor={editor} />
    </div>
  );
});

// ==============================================================================
// Heading Editor Component
// ==============================================================================

export interface HeadingEditorProps {
  text: string;
  level: 1 | 2 | 3;
  onChange: (text: string, level: 1 | 2 | 3) => void;
}

export const HeadingEditor = memo(function HeadingEditor({
  text,
  level,
  onChange,
}: HeadingEditorProps) {
  const [editText, setEditText] = useState(text);

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setEditText(e.target.value);
    },
    [],
  );

  const handleBlur = useCallback(() => {
    onChange(editText, level);
  }, [editText, level, onChange]);

  const handleLevelChange = useCallback(
    (newLevel: 1 | 2 | 3) => {
      onChange(editText, newLevel);
    },
    [editText, onChange],
  );

  return (
    <div className="heading-editor">
      <div className="heading-editor-controls">
        {([1, 2, 3] as const).map((l) => (
          <button
            key={l}
            type="button"
            className={`heading-level-btn ${level === l ? 'active' : ''}`}
            onClick={() => handleLevelChange(l)}
          >
            H{l}
          </button>
        ))}
      </div>
      <input
        type="text"
        className={`heading-input heading-level-${level}`}
        value={editText}
        onChange={handleTextChange}
        onBlur={handleBlur}
        placeholder="Enter heading..."
      />
    </div>
  );
});

// ==============================================================================
// Sortable Block Wrapper
// ==============================================================================

export interface SortableBlockProps {
  id: string;
  children: React.ReactNode;
  onDelete: () => void;
}

export const SortableBlock = memo(function SortableBlock({
  id,
  children,
  onDelete,
}: SortableBlockProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`sortable-block ${isDragging ? 'dragging' : ''}`}
    >
      <div className="sortable-block-handle" {...attributes} {...listeners}>
        <span className="drag-handle">⋮⋮</span>
      </div>
      <div className="sortable-block-content">{children}</div>
      <button
        type="button"
        className="sortable-block-delete"
        onClick={onDelete}
        aria-label="Delete block"
      >
        ×
      </button>
    </div>
  );
});

// ==============================================================================
// Block Editor Item
// ==============================================================================

export interface BlockEditorItemProps {
  block: ContentBlock;
  onUpdate: (updates: Partial<ContentBlock>) => void;
  onDelete: () => void;
  getThumbnailUrl?: ((manifestId: string) => string | undefined) | undefined;
}

export const BlockEditorItem = memo(function BlockEditorItem({
  block,
  onUpdate,
  onDelete,
  getThumbnailUrl,
}: BlockEditorItemProps) {
  const renderBlockEditor = () => {
    switch (block.type) {
      case 'heading':
        return (
          <HeadingEditor
            text={block.text}
            level={block.level}
            onChange={(text, level) => onUpdate({ text, level })}
          />
        );

      case 'text':
        return (
          <TextEditor
            content={block.segments}
            onChange={(segments) => onUpdate({ segments })}
          />
        );

      case 'photo': {
        const url = getThumbnailUrl?.(block.manifestId);
        return (
          <div className="photo-block-editor">
            {url ? (
              <img src={url} alt="" className="photo-block-preview" />
            ) : (
              <div className="photo-block-placeholder">
                Photo: {block.manifestId.slice(0, 8)}...
              </div>
            )}
            <div className="photo-caption-editor">
              <TextEditor
                content={block.caption ?? [{ text: '' }]}
                onChange={(segments) => {
                  // Only store caption if non-empty
                  const hasContent = segments.some((s) => s.text.trim().length > 0);
                  onUpdate({ caption: hasContent ? segments : undefined });
                }}
                placeholder="Add a caption..."
              />
            </div>
          </div>
        );
      }

      case 'photo-group': {
        return (
          <div className="photo-group-editor">
            <div className="photo-group-preview">
              {block.manifestIds.slice(0, 4).map((id) => {
                const url = getThumbnailUrl?.(id);
                return url ? (
                  <img key={id} src={url} alt="" className="photo-group-thumb" />
                ) : (
                  <div key={id} className="photo-group-placeholder">
                    {id.slice(0, 4)}
                  </div>
                );
              })}
              {block.manifestIds.length > 4 && (
                <div className="photo-group-more">
                  +{block.manifestIds.length - 4}
                </div>
              )}
            </div>
            <select
              value={block.layout}
              onChange={(e) =>
                onUpdate({ layout: e.target.value as 'grid' | 'row' | 'masonry' })
              }
              className="photo-group-layout-select"
            >
              <option value="grid">Grid</option>
              <option value="row">Row</option>
              <option value="masonry">Masonry</option>
            </select>
          </div>
        );
      }

      case 'divider':
        return (
          <div className="divider-editor">
            <select
              value={block.style}
              onChange={(e) =>
                onUpdate({ style: e.target.value as 'line' | 'dots' | 'space' })
              }
              className="divider-style-select"
            >
              <option value="line">Line</option>
              <option value="dots">Dots</option>
              <option value="space">Space</option>
            </select>
          </div>
        );

      case 'quote':
        return (
          <div className="quote-block-editor">
            <div className="quote-text-editor">
              <TextEditor
                content={block.text}
                onChange={(segments) => onUpdate({ text: segments })}
                placeholder="Enter quote..."
              />
            </div>
            <input
              type="text"
              className="quote-attribution-input"
              value={block.attribution || ''}
              onChange={(e) =>
                onUpdate({ attribution: e.target.value || undefined })
              }
              placeholder="Attribution (optional)"
            />
          </div>
        );

      case 'section':
        return (
          <div className="section-editor">
            <input
              type="text"
              value={block.title || ''}
              onChange={(e) => onUpdate({ title: e.target.value || undefined })}
              placeholder="Section title (optional)"
              className="section-title-input"
            />
          </div>
        );

      default:
        return <div className="unknown-block">Unknown block type</div>;
    }
  };

  return (
    <SortableBlock id={block.id} onDelete={onDelete}>
      {renderBlockEditor()}
    </SortableBlock>
  );
});

// ==============================================================================
// Add Block Menu
// ==============================================================================

export interface AddBlockMenuProps {
  onAddBlock: (type: ContentBlock['type']) => void;
  onAddPhotoBlock?: (() => void) | undefined;
  onAddPhotoGroupBlock?: (() => void) | undefined;
  availablePhotoIds?: string[] | undefined;
}

export const AddBlockMenu = memo(function AddBlockMenu({
  onAddBlock,
  onAddPhotoBlock,
  onAddPhotoGroupBlock,
}: AddBlockMenuProps) {
  const [isOpen, setIsOpen] = useState(false);

  const handleAdd = useCallback(
    (type: ContentBlock['type']) => {
      onAddBlock(type);
      setIsOpen(false);
    },
    [onAddBlock],
  );

  const handleAddPhoto = useCallback(() => {
    onAddPhotoBlock?.();
    setIsOpen(false);
  }, [onAddPhotoBlock]);

  const handleAddPhotoGroup = useCallback(() => {
    onAddPhotoGroupBlock?.();
    setIsOpen(false);
  }, [onAddPhotoGroupBlock]);

  return (
    <div className="add-block-menu">
      {isOpen ? (
        <div className="add-block-options">
          <button type="button" onClick={() => handleAdd('heading')}>
            Heading
          </button>
          <button type="button" onClick={() => handleAdd('text')}>
            Text
          </button>
          <button type="button" onClick={() => handleAdd('divider')}>
            Divider
          </button>
          <button type="button" onClick={() => handleAdd('quote')}>
            Quote
          </button>
          {onAddPhotoBlock && (
            <button type="button" onClick={handleAddPhoto}>
              Photo
            </button>
          )}
          {onAddPhotoGroupBlock && (
            <button type="button" onClick={handleAddPhotoGroup}>
              Photo Grid
            </button>
          )}
          <button
            type="button"
            className="add-block-cancel"
            onClick={() => setIsOpen(false)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="add-block-btn"
          onClick={() => setIsOpen(true)}
        >
          + Add Block
        </button>
      )}
    </div>
  );
});

// ==============================================================================
// Content Editor Component
// ==============================================================================

/** Type of photo block being created */
type PhotoBlockCreationType = 'photo' | 'photo-group' | null;

export interface ContentEditorProps {
  blocks: ContentBlock[];
  onBlockUpdate: (blockId: string, updates: Partial<ContentBlock>) => void;
  onBlockAdd: (block: ContentBlock) => void;
  onBlockRemove: (blockId: string) => void;
  onBlockMove: (fromIndex: number, toIndex: number) => void;
  getThumbnailUrl?: ((manifestId: string) => string | undefined) | undefined;
  className?: string | undefined;
  /** Album ID for loading photos in the picker */
  albumId?: string | undefined;
}

export const ContentEditor = memo(function ContentEditor({
  blocks,
  onBlockUpdate,
  onBlockAdd,
  onBlockRemove,
  onBlockMove,
  getThumbnailUrl,
  className,
  albumId,
}: ContentEditorProps) {
  // Photo picker state
  const [pickerOpen, setPickerOpen] = useState(false);
  const [photoBlockType, setPhotoBlockType] = useState<PhotoBlockCreationType>(null);
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const blockIds = useMemo(() => blocks.map((b) => b.id), [blocks]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (over && active.id !== over.id) {
        const oldIndex = blocks.findIndex((b) => b.id === active.id);
        const newIndex = blocks.findIndex((b) => b.id === over.id);
        if (oldIndex !== -1 && newIndex !== -1) {
          onBlockMove(oldIndex, newIndex);
        }
      }
    },
    [blocks, onBlockMove],
  );

  const handleAddBlock = useCallback(
    (type: ContentBlock['type']) => {
      let newBlock: ContentBlock;
      const position = String.fromCharCode(97 + blocks.length); // Simple position

      switch (type) {
        case 'heading':
          newBlock = createHeadingBlock(2, 'New Heading', position);
          break;
        case 'text':
          newBlock = createTextBlock([{ text: '' }], position);
          break;
        case 'divider':
          newBlock = createDividerBlock('line', position);
          break;
        case 'quote':
          newBlock = createQuoteBlock([{ text: '' }], position);
          break;
        default:
          // Photo blocks are handled via picker dialog
          return;
      }

      onBlockAdd(newBlock);
    },
    [blocks.length, onBlockAdd],
  );

  // Open picker for single photo block
  const handleAddPhotoBlock = useCallback(() => {
    setPhotoBlockType('photo');
    setPickerOpen(true);
  }, []);

  // Open picker for photo group block
  const handleAddPhotoGroupBlock = useCallback(() => {
    setPhotoBlockType('photo-group');
    setPickerOpen(true);
  }, []);

  // Handle photo selection from picker
  const handlePhotoSelect = useCallback(
    (manifestIds: string[]) => {
      if (manifestIds.length === 0) {
        setPickerOpen(false);
        setPhotoBlockType(null);
        return;
      }

      const position = String.fromCharCode(97 + blocks.length);

      if (photoBlockType === 'photo') {
        // Create single photo block with first selected photo
        const newBlock = createPhotoBlock(manifestIds[0]!, position);
        onBlockAdd(newBlock);
      } else if (photoBlockType === 'photo-group') {
        // Create photo group block with all selected photos
        const newBlock = createPhotoGroupBlock(manifestIds, 'grid', position);
        onBlockAdd(newBlock);
      }

      setPickerOpen(false);
      setPhotoBlockType(null);
    },
    [blocks.length, onBlockAdd, photoBlockType],
  );

  // Close picker without adding
  const handlePickerClose = useCallback(() => {
    setPickerOpen(false);
    setPhotoBlockType(null);
  }, []);

  return (
    <div className={`content-editor ${className || ''}`}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={blockIds} strategy={verticalListSortingStrategy}>
          {blocks.map((block) => (
            <BlockEditorItem
              key={block.id}
              block={block}
              onUpdate={(updates) => onBlockUpdate(block.id, updates)}
              onDelete={() => onBlockRemove(block.id)}
              getThumbnailUrl={getThumbnailUrl}
            />
          ))}
        </SortableContext>
      </DndContext>

      <AddBlockMenu
        onAddBlock={handleAddBlock}
        onAddPhotoBlock={albumId ? handleAddPhotoBlock : undefined}
        onAddPhotoGroupBlock={albumId ? handleAddPhotoGroupBlock : undefined}
      />

      {/* Photo picker dialog */}
      {albumId && (
        <PhotoPickerDialog
          isOpen={pickerOpen}
          onClose={handlePickerClose}
          onSelect={handlePhotoSelect}
          albumId={albumId}
          maxSelection={photoBlockType === 'photo' ? 1 : 20}
          title={
            photoBlockType === 'photo'
              ? 'Select Photo'
              : 'Select Photos for Grid'
          }
        />
      )}
    </div>
  );
});
