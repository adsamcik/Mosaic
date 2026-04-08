/**
 * Block Editor Component
 *
 * Re-exports from block-editors/ directory.
 * This file is kept for backward compatibility with existing imports.
 */

export {
  TextEditor,
  segmentsToHtml,
  htmlToSegments,
  HeadingEditor,
  PhotoGridEditor,
  SortableBlock,
  BlockEditorItem,
  AddBlockMenu,
  ContentEditor,
} from './block-editors';

export type {
  TextEditorProps,
  HeadingEditorProps,
  PhotoGridEditorProps,
  SortableBlockProps,
  BlockEditorItemProps,
  AddBlockMenuProps,
  ContentEditorProps,
} from './block-editors';
