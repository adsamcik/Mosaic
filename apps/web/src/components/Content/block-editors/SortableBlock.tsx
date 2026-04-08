/**
 * SortableBlock Component
 *
 * Drag-and-drop wrapper for content blocks with handle and delete button.
 */

import { memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { SortableBlockProps } from './types';

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
