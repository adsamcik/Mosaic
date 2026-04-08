/**
 * Shared types for Block Editor components.
 */

import type { ContentBlock, RichTextSegment } from '../../../lib/content-blocks';

// ==============================================================================
// Text Editor
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

// ==============================================================================
// Heading Editor
// ==============================================================================

export interface HeadingEditorProps {
  text: string;
  level: 1 | 2 | 3;
  onChange: (text: string, level: 1 | 2 | 3) => void;
}

// ==============================================================================
// Photo Grid Editor
// ==============================================================================

export interface PhotoGridEditorProps {
  manifestIds: string[];
  layout: 'grid' | 'masonry' | 'carousel' | 'row';
  onUpdate: (updates: { manifestIds?: string[]; layout?: 'grid' | 'masonry' | 'carousel' | 'row' }) => void;
  getThumbnailUrl?: ((manifestId: string) => string | undefined) | undefined;
  onAddPhotos: () => void;
}

// ==============================================================================
// Sortable Block
// ==============================================================================

export interface SortableBlockProps {
  id: string;
  children: React.ReactNode;
  onDelete: () => void;
}

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

// ==============================================================================
// Add Block Menu
// ==============================================================================

export interface AddBlockMenuProps {
  onAddBlock: (type: ContentBlock['type']) => void;
  onAddPhotoBlock?: (() => void) | undefined;
  onAddPhotoGroupBlock?: (() => void) | undefined;
  availablePhotoIds?: string[] | undefined;
}

// ==============================================================================
// Content Editor
// ==============================================================================

/** Type of photo block being created */
export type PhotoBlockCreationType = 'photo' | 'photo-group' | null;

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
