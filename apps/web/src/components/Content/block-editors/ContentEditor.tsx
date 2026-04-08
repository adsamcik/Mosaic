/**
 * ContentEditor Component
 *
 * Main orchestrator for the block-based content editor.
 * Manages block ordering, photo picker integration, slash commands,
 * and undo-on-delete functionality.
 */

import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import type { ContentBlock } from '../../../lib/content-blocks';
import {
  createTextBlock,
  createHeadingBlock,
  createDividerBlock,
  createPhotoBlock,
  createPhotoGroupBlock,
  createQuoteBlock,
  createMapBlock,
  createSectionBlock,
} from '../../../lib/content-blocks';
import { PhotoPickerDialog } from '../PhotoPickerDialog';
import {
  SlashCommandMenu,
  useSlashCommand,
  type InsertableBlockType,
} from '../SlashCommandMenu';
import { useToast } from '../../../contexts/ToastContext';
import { BlockEditorItem } from './BlockEditorItem';
import { AddBlockMenu } from './AddBlockMenu';
import type { ContentEditorProps, PhotoBlockCreationType } from './types';
import '../BlockEditor.css';

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
