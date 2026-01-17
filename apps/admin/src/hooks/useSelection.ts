/**
 * useSelection Hook
 *
 * Manages photo selection state for batch operations.
 * Designed to be lifted up and shared between the gallery header
 * and photo grid components.
 */

import { useCallback, useState } from 'react';

export interface SelectionState {
  /** Whether selection mode is active */
  isSelectionMode: boolean;
  /** Set of selected photo IDs */
  selectedIds: Set<string>;
  /** Number of selected photos */
  selectedCount: number;
}

export interface SelectionActions {
  /** Toggle selection mode on/off */
  toggleSelectionMode: () => void;
  /** Enter selection mode */
  enterSelectionMode: () => void;
  /** Exit selection mode and clear selection */
  exitSelectionMode: () => void;
  /** Toggle selection of a single photo */
  togglePhotoSelection: (photoId: string) => void;
  /** Select a photo */
  selectPhoto: (photoId: string) => void;
  /** Deselect a photo */
  deselectPhoto: (photoId: string) => void;
  /** Select all photos from the given list */
  selectAll: (photoIds: string[]) => void;
  /** Clear all selections */
  clearSelection: () => void;
  /** Check if a photo is selected */
  isSelected: (photoId: string) => boolean;
}

export interface UseSelectionReturn extends SelectionState, SelectionActions {}

/**
 * Hook for managing photo selection state
 */
export function useSelection(): UseSelectionReturn {
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleSelectionMode = useCallback(() => {
    setIsSelectionMode((prev) => {
      if (prev) {
        // Exiting selection mode - clear selection
        setSelectedIds(new Set());
      }
      return !prev;
    });
  }, []);

  const enterSelectionMode = useCallback(() => {
    setIsSelectionMode(true);
  }, []);

  const exitSelectionMode = useCallback(() => {
    setIsSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  const togglePhotoSelection = useCallback((photoId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(photoId)) {
        next.delete(photoId);
      } else {
        next.add(photoId);
      }
      return next;
    });
  }, []);

  const selectPhoto = useCallback((photoId: string) => {
    setSelectedIds((prev) => {
      if (prev.has(photoId)) return prev;
      const next = new Set(prev);
      next.add(photoId);
      return next;
    });
  }, []);

  const deselectPhoto = useCallback((photoId: string) => {
    setSelectedIds((prev) => {
      if (!prev.has(photoId)) return prev;
      const next = new Set(prev);
      next.delete(photoId);
      return next;
    });
  }, []);

  const selectAll = useCallback((photoIds: string[]) => {
    setSelectedIds(new Set(photoIds));
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const isSelected = useCallback(
    (photoId: string) => selectedIds.has(photoId),
    [selectedIds],
  );

  return {
    // State
    isSelectionMode,
    selectedIds,
    selectedCount: selectedIds.size,
    // Actions
    toggleSelectionMode,
    enterSelectionMode,
    exitSelectionMode,
    togglePhotoSelection,
    selectPhoto,
    deselectPhoto,
    selectAll,
    clearSelection,
    isSelected,
  };
}
