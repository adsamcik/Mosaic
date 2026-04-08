/**
 * useGridSelection Hook
 *
 * Extracts the common shift-click range selection callback used by
 * grid components (PhotoGrid, MosaicPhotoGrid, SquarePhotoGrid).
 *
 * Handles single-click select/deselect and shift-click range selection
 * using the sorted photo ID list as the ordering source.
 */

import { useCallback } from 'react';

import type { UseSelectionReturn } from './useSelection';

export interface UseGridSelectionOptions {
  /** Selection state from useSelection (optional — grids may render without selection) */
  selection: UseSelectionReturn | undefined;
  /** Ordered photo IDs used to resolve shift-click ranges */
  sortedPhotoIds: string[];
  /** When true, automatically enter selection mode on first select (default: false) */
  autoEnterSelectionMode?: boolean;
}

export type HandleSelectionChange = (
  photoId: string,
  selected: boolean,
  event?: React.MouseEvent | React.KeyboardEvent,
) => void;

/**
 * Returns a memoized `handleSelectionChange` callback that encapsulates
 * single-click and shift-click range selection logic.
 */
export function useGridSelection({
  selection,
  sortedPhotoIds,
  autoEnterSelectionMode = false,
}: UseGridSelectionOptions): HandleSelectionChange {
  return useCallback(
    (
      photoId: string,
      selected: boolean,
      event?: React.MouseEvent | React.KeyboardEvent,
    ) => {
      if (!selection) return;

      if (selected) {
        if (autoEnterSelectionMode && !selection.isSelectionMode) {
          selection.enterSelectionMode();
        }

        if (event?.shiftKey && selection.lastSelectedId) {
          selection.selectRange(photoId, sortedPhotoIds);
        } else {
          selection.selectPhoto(photoId);
        }
      } else {
        selection.deselectPhoto(photoId);
      }
    },
    [selection, sortedPhotoIds, autoEnterSelectionMode],
  );
}
