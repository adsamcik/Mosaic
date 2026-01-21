/**
 * useSelection Hook
 *
 * Manages photo selection state for batch operations.
 * Designed to be lifted up and shared between the gallery header
 * and photo grid components.
 *
 * Supports shift-click range selection by tracking the last selected photo
 * as an anchor point. When shift-clicking, all photos between the anchor
 * and the clicked photo are selected.
 */

import { useCallback, useRef, useState } from 'react';

export interface SelectionState {
  /** Whether selection mode is active */
  isSelectionMode: boolean;
  /** Set of selected photo IDs */
  selectedIds: Set<string>;
  /** Number of selected photos */
  selectedCount: number;
  /** Last selected photo ID (anchor point for shift-click) */
  lastSelectedId: string | null;
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
  /** Select a range of photos between last selected and target (for shift-click) */
  selectRange: (photoId: string, allPhotoIds: string[]) => void;
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
  // Use ref to track last selected ID without causing re-renders
  const lastSelectedIdRef = useRef<string | null>(null);

  const toggleSelectionMode = useCallback(() => {
    setIsSelectionMode((prev) => {
      if (prev) {
        // Exiting selection mode - clear selection
        setSelectedIds(new Set());
        lastSelectedIdRef.current = null;
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
    lastSelectedIdRef.current = null;
  }, []);

  const togglePhotoSelection = useCallback((photoId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(photoId)) {
        next.delete(photoId);
      } else {
        next.add(photoId);
        lastSelectedIdRef.current = photoId;
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
    lastSelectedIdRef.current = photoId;
  }, []);

  const deselectPhoto = useCallback((photoId: string) => {
    setSelectedIds((prev) => {
      if (!prev.has(photoId)) return prev;
      const next = new Set(prev);
      next.delete(photoId);
      return next;
    });
  }, []);

  /**
   * Select all photos between the last selected photo and the target photo.
   * This implements shift-click range selection behavior.
   */
  const selectRange = useCallback(
    (photoId: string, allPhotoIds: string[]) => {
      const anchorId = lastSelectedIdRef.current;

      // If no anchor point, just select the single photo
      if (!anchorId) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.add(photoId);
          return next;
        });
        lastSelectedIdRef.current = photoId;
        return;
      }

      // Find indices of anchor and target in the photo list
      const anchorIndex = allPhotoIds.indexOf(anchorId);
      const targetIndex = allPhotoIds.indexOf(photoId);

      // If either photo not found, just select the target
      if (anchorIndex === -1 || targetIndex === -1) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.add(photoId);
          return next;
        });
        lastSelectedIdRef.current = photoId;
        return;
      }

      // Get the range of photos to select (inclusive)
      const startIndex = Math.min(anchorIndex, targetIndex);
      const endIndex = Math.max(anchorIndex, targetIndex);
      const rangeIds = allPhotoIds.slice(startIndex, endIndex + 1);

      // Add all photos in range to selection (preserving existing selections)
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of rangeIds) {
          next.add(id);
        }
        return next;
      });

      // Don't update anchor - keep it at the original position for chained shift-clicks
    },
    [],
  );

  const selectAll = useCallback((photoIds: string[]) => {
    setSelectedIds(new Set(photoIds));
    lastSelectedIdRef.current = null;
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    lastSelectedIdRef.current = null;
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
    lastSelectedId: lastSelectedIdRef.current,
    // Actions
    toggleSelectionMode,
    enterSelectionMode,
    exitSelectionMode,
    togglePhotoSelection,
    selectPhoto,
    deselectPhoto,
    selectRange,
    selectAll,
    clearSelection,
    isSelected,
  };
}
