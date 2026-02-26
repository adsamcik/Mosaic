/**
 * Block Editor Component
 *
 * TipTap-based editor for editing album content blocks.
 * Provides WYSIWYG editing for text blocks and block management.
 */

import React, { memo, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  horizontalListSortingStrategy,
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
  createMapBlock,
  createSectionBlock,
} from '../../lib/content-blocks';
import { PhotoPickerDialog } from './PhotoPickerDialog';
import {
  SlashCommandMenu,
  useSlashCommand,
  type InsertableBlockType,
} from './SlashCommandMenu';
import { useToast } from '../../contexts/ToastContext';
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
  /** Called when "/" is typed at start of empty content */
  onSlashCommand?: ((rect: DOMRect) => void) | undefined;
  /** Called when slash command query updates (text after /) */
  onSlashQueryChange?: ((query: string) => void) | undefined;
  /** Called when slash command is cancelled (e.g., space or backspace clears) */
  onSlashCancel?: (() => void) | undefined;
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
  onSlashCommand,
  onSlashQueryChange,
  onSlashCancel,
}: TextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const slashActiveRef = useRef(false);

  const editor = useEditor({
    extensions: createEditorExtensions(placeholder),
    content: `<p>${segmentsToHtml(content)}</p>`,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      // Extract content from paragraph wrapper
      const match = html.match(/<p>(.*)<\/p>/s);
      const innerHtml = match ? match[1] ?? '' : html;
      const text = editor.getText();
      
      // Check for slash command
      if (text.startsWith('/')) {
        if (!slashActiveRef.current && text === '/') {
          // Just typed "/", activate slash command
          slashActiveRef.current = true;
          // Get cursor position for menu
          const selection = window.getSelection();
          if (selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();
            onSlashCommand?.(rect);
          }
        } else if (slashActiveRef.current) {
          // Update query (text after /)
          const query = text.slice(1);
          onSlashQueryChange?.(query);
        }
      } else if (slashActiveRef.current) {
        // Slash was cleared (e.g., backspace)
        slashActiveRef.current = false;
        onSlashCancel?.();
      }
      
      onChange(htmlToSegments(innerHtml));
    },
  });

  return (
    <div className="text-editor" ref={editorRef}>
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
// Photo Grid Editor Component
// ==============================================================================

export interface PhotoGridEditorProps {
  manifestIds: string[];
  layout: 'grid' | 'masonry' | 'carousel' | 'row';
  onUpdate: (updates: { manifestIds?: string[]; layout?: 'grid' | 'masonry' | 'carousel' | 'row' }) => void;
  getThumbnailUrl?: ((manifestId: string) => string | undefined) | undefined;
  onAddPhotos: () => void;
}

interface SortablePhotoItemProps {
  id: string;
  thumbnailUrl: string | undefined;
  onRemove: () => void;
}

const SortablePhotoItem = memo(function SortablePhotoItem({
  id,
  thumbnailUrl,
  onRemove,
}: SortablePhotoItemProps) {
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
      className={`grid-photo-item ${isDragging ? 'dragging' : ''}`}
      {...attributes}
      {...listeners}
    >
      {thumbnailUrl ? (
        <img src={thumbnailUrl} alt="" className="grid-photo-thumb" />
      ) : (
        <div className="grid-photo-placeholder">
          {id.slice(0, 4)}
        </div>
      )}
      <button
        type="button"
        className="grid-photo-remove"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        aria-label="Remove photo"
      >
        ×
      </button>
    </div>
  );
});

export const PhotoGridEditor = memo(function PhotoGridEditor({
  manifestIds,
  layout,
  onUpdate,
  getThumbnailUrl,
  onAddPhotos,
}: PhotoGridEditorProps) {
  const { t } = useTranslation();

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Require 8px of movement before drag starts
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (over && active.id !== over.id) {
        const oldIndex = manifestIds.indexOf(String(active.id));
        const newIndex = manifestIds.indexOf(String(over.id));
        if (oldIndex !== -1 && newIndex !== -1) {
          const newManifestIds = arrayMove(manifestIds, oldIndex, newIndex);
          onUpdate({ manifestIds: newManifestIds });
        }
      }
    },
    [manifestIds, onUpdate],
  );

  const handleRemovePhoto = useCallback(
    (manifestId: string) => {
      const newManifestIds = manifestIds.filter((id) => id !== manifestId);
      onUpdate({ manifestIds: newManifestIds });
    },
    [manifestIds, onUpdate],
  );

  const handleLayoutChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onUpdate({ layout: e.target.value as 'grid' | 'row' | 'masonry' });
    },
    [onUpdate],
  );

  const canAddMore = manifestIds.length < 12;

  return (
    <div className="photo-grid-editor">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={manifestIds} strategy={horizontalListSortingStrategy}>
          <div className="photo-grid-items">
            {manifestIds.map((id) => (
              <SortablePhotoItem
                key={id}
                id={id}
                thumbnailUrl={getThumbnailUrl?.(id)}
                onRemove={() => handleRemovePhoto(id)}
              />
            ))}
            {canAddMore && (
              <button
                type="button"
                className="grid-photo-add"
                onClick={onAddPhotos}
                aria-label={t('blocks.photoGrid.addPhotos')}
              >
                <span className="grid-photo-add-icon">+</span>
                <span className="grid-photo-add-label">{t('blocks.photoGrid.add')}</span>
              </button>
            )}
          </div>
        </SortableContext>
      </DndContext>

      <div className="photo-grid-controls">
        <select
          value={layout}
          onChange={handleLayoutChange}
          className="photo-group-layout-select"
        >
          <option value="grid">{t('blocks.photoGrid.layoutGrid')}</option>
          <option value="row">{t('blocks.photoGrid.layoutRow')}</option>
          <option value="masonry">{t('blocks.photoGrid.layoutMasonry')}</option>
        </select>
        <span className="photo-grid-count">
          {t('blocks.photoGrid.photoCount', { count: manifestIds.length, max: 12 })}
        </span>
      </div>
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
  /** Slash command handlers for text blocks */
  onSlashCommand?: ((blockId: string, rect: DOMRect) => void) | undefined;
  onSlashQueryChange?: ((query: string) => void) | undefined;
  onSlashCancel?: (() => void) | undefined;
  /** Handler to open photo picker for adding photos to a photo-group block */
  onAddPhotos?: ((blockId: string) => void) | undefined;
}

export const BlockEditorItem = memo(function BlockEditorItem({
  block,
  onUpdate,
  onDelete,
  getThumbnailUrl,
  onSlashCommand,
  onSlashQueryChange,
  onSlashCancel,
  onAddPhotos,
}: BlockEditorItemProps) {
  const handleSlashCommand = useCallback(
    (rect: DOMRect) => {
      onSlashCommand?.(block.id, rect);
    },
    [block.id, onSlashCommand],
  );

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
            onSlashCommand={handleSlashCommand}
            onSlashQueryChange={onSlashQueryChange}
            onSlashCancel={onSlashCancel}
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
        const handleAddPhotosClick = () => {
          onAddPhotos?.(block.id);
        };
        return (
          <PhotoGridEditor
            manifestIds={block.manifestIds}
            layout={block.layout}
            onUpdate={onUpdate}
            getThumbnailUrl={getThumbnailUrl}
            onAddPhotos={handleAddPhotosClick}
          />
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

      case 'map':
        return (
          <div className="map-block-editor">
            <div className="map-editor-row">
              <label className="map-editor-label">
                Center
                <div className="map-editor-coords">
                  <input
                    type="number"
                    step="0.0001"
                    min="-90"
                    max="90"
                    value={block.center.lat}
                    onChange={(e) =>
                      onUpdate({
                        center: { ...block.center, lat: parseFloat(e.target.value) || 0 },
                      })
                    }
                    placeholder="Latitude"
                    className="map-coord-input"
                  />
                  <input
                    type="number"
                    step="0.0001"
                    min="-180"
                    max="180"
                    value={block.center.lng}
                    onChange={(e) =>
                      onUpdate({
                        center: { ...block.center, lng: parseFloat(e.target.value) || 0 },
                      })
                    }
                    placeholder="Longitude"
                    className="map-coord-input"
                  />
                </div>
              </label>
            </div>
            <div className="map-editor-row">
              <label className="map-editor-label">
                Zoom: {block.zoom ?? 10}
                <input
                  type="range"
                  min="1"
                  max="18"
                  value={block.zoom ?? 10}
                  onChange={(e) => onUpdate({ zoom: parseInt(e.target.value, 10) })}
                  className="map-zoom-slider"
                />
              </label>
            </div>
            <div className="map-editor-row">
              <label className="map-editor-label">
                Height: {block.height ?? 400}px
                <input
                  type="range"
                  min="200"
                  max="600"
                  step="50"
                  value={block.height ?? 400}
                  onChange={(e) => onUpdate({ height: parseInt(e.target.value, 10) })}
                  className="map-height-slider"
                />
              </label>
            </div>
            <div className="map-preview-container">
              <div className="map-preview-placeholder">
                📍 Map: {block.center.lat.toFixed(4)}, {block.center.lng.toFixed(4)}
                {block.markers && block.markers.length > 0 && (
                  <span> • {block.markers.length} marker(s)</span>
                )}
              </div>
            </div>
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
          <button type="button" onClick={() => handleAdd('map')}>
            Map
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
  const { t } = useTranslation();
  const { addToast } = useToast();
  
  // Photo picker state
  const [pickerOpen, setPickerOpen] = useState(false);
  const [photoBlockType, setPhotoBlockType] = useState<PhotoBlockCreationType>(null);
  /** Block ID when editing an existing photo-group block's photos */
  const [editingPhotoGroupBlockId, setEditingPhotoGroupBlockId] = useState<string | null>(null);
  
  // Slash command state
  const slashCommand = useSlashCommand();
  const [slashBlockId, setSlashBlockId] = useState<string | null>(null);
  
  // Undo deletion state - stores pending undo data
  const pendingUndoRef = useRef<{ block: ContentBlock; index: number } | null>(null);
  
  /**
   * Handle block deletion with undo toast.
   * Shows a toast with an undo action that restores the block at its original position.
   */
  const handleBlockDelete = useCallback(
    (blockId: string) => {
      // Find the block and its index before deletion
      const blockIndex = blocks.findIndex((b) => b.id === blockId);
      if (blockIndex === -1) return;
      
      const deletedBlock = blocks[blockIndex]!;
      
      // Clear any previous pending undo (new delete takes precedence)
      pendingUndoRef.current = { block: deletedBlock, index: blockIndex };
      
      // Remove the block immediately
      onBlockRemove(blockId);
      
      // Show toast with undo action
      addToast({
        message: t('content.blockDeleted', 'Block deleted'),
        type: 'info',
        duration: 5000,
        action: {
          label: t('common.undo', 'Undo'),
          onClick: () => {
            const pending = pendingUndoRef.current;
            if (!pending) return;
            
            // Add the block back
            onBlockAdd(pending.block);
            
            // Move it to the original position (it was added at the end)
            // After adding, the block is at position blocks.length (current length after delete)
            // We need to move it from that position to the original index
            const currentLength = blocks.length; // This is after the delete, so it's original - 1
            if (pending.index < currentLength) {
              // Block was added at end, move to original position
              onBlockMove(currentLength, pending.index);
            }
            
            // Clear pending undo
            pendingUndoRef.current = null;
          },
        },
      });
    },
    [blocks, onBlockRemove, onBlockAdd, onBlockMove, addToast, t],
  );
  
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
        case 'map':
          newBlock = createMapBlock({ lat: 51.505, lng: -0.09 }, position, { zoom: 10 });
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

  // Open picker for adding photos to existing photo-group block
  const handleAddPhotosToBlock = useCallback((blockId: string) => {
    setEditingPhotoGroupBlockId(blockId);
    setPhotoBlockType('photo-group');
    setPickerOpen(true);
  }, []);

  // Handle photo selection from picker
  const handlePhotoSelect = useCallback(
    (manifestIds: string[]) => {
      if (manifestIds.length === 0) {
        setPickerOpen(false);
        setPhotoBlockType(null);
        setEditingPhotoGroupBlockId(null);
        return;
      }

      // Check if we're editing an existing photo-group block
      if (editingPhotoGroupBlockId) {
        // Update existing block with new photos (append to existing)
        const existingBlock = blocks.find((b) => b.id === editingPhotoGroupBlockId);
        if (existingBlock && existingBlock.type === 'photo-group') {
          // Merge existing manifestIds with new selections (remove duplicates)
          const existingIds = new Set(existingBlock.manifestIds);
          const newIds = manifestIds.filter((id) => !existingIds.has(id));
          const mergedIds = [...existingBlock.manifestIds, ...newIds].slice(0, 12);
          onBlockUpdate(editingPhotoGroupBlockId, { manifestIds: mergedIds });
        }
        setPickerOpen(false);
        setPhotoBlockType(null);
        setEditingPhotoGroupBlockId(null);
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
    [blocks, onBlockAdd, onBlockUpdate, photoBlockType, editingPhotoGroupBlockId],
  );

  // Close picker without adding
  const handlePickerClose = useCallback(() => {
    setPickerOpen(false);
    setPhotoBlockType(null);
    setEditingPhotoGroupBlockId(null);
  }, []);

  // Slash command: triggered when "/" is typed at start of empty text block
  const handleSlashCommand = useCallback(
    (blockId: string, rect: DOMRect) => {
      setSlashBlockId(blockId);
      slashCommand.open(rect);
    },
    [slashCommand],
  );

  // Slash command: query updated as user types after "/"
  const handleSlashQueryChange = useCallback(
    (query: string) => {
      slashCommand.setQuery(query);
    },
    [slashCommand],
  );

  // Slash command: close menu and clear state
  const handleSlashCancel = useCallback(() => {
    slashCommand.close();
    setSlashBlockId(null);
  }, [slashCommand]);

  // Slash command: block type selected from menu
  const handleSlashSelect = useCallback(
    (type: InsertableBlockType) => {
      if (!slashBlockId) return;

      // Find the block to replace
      const blockIndex = blocks.findIndex((b) => b.id === slashBlockId);
      if (blockIndex === -1) {
        slashCommand.close();
        setSlashBlockId(null);
        return;
      }

      const position = blocks[blockIndex]!.position;

      // Handle photo types specially - open picker
      if (type === 'photo') {
        onBlockRemove(slashBlockId);
        setPhotoBlockType('photo');
        setPickerOpen(true);
        slashCommand.close();
        setSlashBlockId(null);
        return;
      }

      if (type === 'photo-group') {
        onBlockRemove(slashBlockId);
        setPhotoBlockType('photo-group');
        setPickerOpen(true);
        slashCommand.close();
        setSlashBlockId(null);
        return;
      }

      // Create the new block
      let newBlock: ContentBlock;
      switch (type) {
        case 'heading':
          newBlock = createHeadingBlock(2, '', position);
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
        case 'map':
          newBlock = createMapBlock({ lat: 51.505, lng: -0.09 }, position, { zoom: 10 });
          break;
        case 'section':
          newBlock = createSectionBlock(undefined, [], position);
          break;
        default:
          slashCommand.close();
          setSlashBlockId(null);
          return;
      }

      // Remove old text block and add new block
      onBlockRemove(slashBlockId);
      onBlockAdd(newBlock);
      slashCommand.close();
      setSlashBlockId(null);
    },
    [blocks, slashBlockId, slashCommand, onBlockRemove, onBlockAdd],
  );

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
              onDelete={() => handleBlockDelete(block.id)}
              getThumbnailUrl={getThumbnailUrl}
              onSlashCommand={handleSlashCommand}
              onSlashQueryChange={handleSlashQueryChange}
              onSlashCancel={handleSlashCancel}
              onAddPhotos={albumId ? handleAddPhotosToBlock : undefined}
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
      {albumId && (() => {
        // Get max selection based on current state
        let maxSelection = 20;
        if (photoBlockType === 'photo') {
          maxSelection = 1;
        } else if (editingPhotoGroupBlockId) {
          // When editing, limit to remaining slots
          const existingBlock = blocks.find((b) => b.id === editingPhotoGroupBlockId);
          if (existingBlock && existingBlock.type === 'photo-group') {
            maxSelection = 12 - existingBlock.manifestIds.length;
          }
        } else {
          maxSelection = 12;
        }
        return (
          <PhotoPickerDialog
            isOpen={pickerOpen}
            onClose={handlePickerClose}
            onSelect={handlePhotoSelect}
            albumId={albumId}
            maxSelection={maxSelection}
            title={
              editingPhotoGroupBlockId
                ? 'Add Photos to Grid'
                : photoBlockType === 'photo'
                  ? 'Select Photo'
                  : 'Select Photos for Grid'
            }
          />
        );
      })()}

      {/* Slash command menu */}
      <SlashCommandMenu
        isOpen={slashCommand.isOpen}
        position={slashCommand.position}
        query={slashCommand.query}
        onSelect={handleSlashSelect}
        onClose={handleSlashCancel}
        hasPhotoBlocks={!!albumId}
      />
    </div>
  );
});
