/**
 * PhotoGridEditor Component
 *
 * Editor for photo group blocks with drag-and-drop reordering,
 * layout selection, and photo management.
 */

import React, { memo, useCallback } from 'react';
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
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { PhotoGridEditorProps } from './types';

// ==============================================================================
// Sortable Photo Item (private)
// ==============================================================================

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

// ==============================================================================
// PhotoGridEditor Component
// ==============================================================================

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
