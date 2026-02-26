/**
 * useSelection Hook Tests
 *
 * Tests for the photo selection state management hook,
 * including shift-click range selection functionality.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  useSelection,
  type UseSelectionReturn,
} from '../../src/hooks/useSelection';

// Test harness component that exposes hook results
interface HarnessProps {
  onResult: (result: UseSelectionReturn) => void;
}

function TestHarness({ onResult }: HarnessProps) {
  const result = useSelection();
  onResult(result);
  return null;
}

describe('useSelection', () => {
  let container: HTMLElement;
  let root: Root;
  let hookResult: UseSelectionReturn;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    hookResult = undefined as unknown as UseSelectionReturn;
  });

  afterEach(() => {
    root.unmount();
    document.body.removeChild(container);
  });

  function renderHook() {
    act(() => {
      root.render(
        createElement(TestHarness, {
          onResult: (result) => {
            hookResult = result;
          },
        }),
      );
    });
    return hookResult;
  }

  describe('basic selection operations', () => {
    it('starts with empty selection and selection mode off', () => {
      renderHook();

      expect(hookResult.isSelectionMode).toBe(false);
      expect(hookResult.selectedIds.size).toBe(0);
      expect(hookResult.selectedCount).toBe(0);
      expect(hookResult.lastSelectedId).toBe(null);
    });

    it('can toggle selection mode', () => {
      renderHook();

      act(() => {
        hookResult.toggleSelectionMode();
      });

      expect(hookResult.isSelectionMode).toBe(true);

      act(() => {
        hookResult.toggleSelectionMode();
      });

      expect(hookResult.isSelectionMode).toBe(false);
    });

    it('clears selection when exiting selection mode via toggle', () => {
      renderHook();

      // Enter selection mode and select a photo
      act(() => {
        hookResult.enterSelectionMode();
        hookResult.selectPhoto('photo-1');
      });

      expect(hookResult.selectedCount).toBe(1);

      // Exit via toggle
      act(() => {
        hookResult.toggleSelectionMode();
      });

      expect(hookResult.isSelectionMode).toBe(false);
      expect(hookResult.selectedCount).toBe(0);
    });

    it('can enter selection mode', () => {
      renderHook();

      act(() => {
        hookResult.enterSelectionMode();
      });

      expect(hookResult.isSelectionMode).toBe(true);
    });

    it('can exit selection mode and clear selection', () => {
      renderHook();

      act(() => {
        hookResult.enterSelectionMode();
        hookResult.selectPhoto('photo-1');
        hookResult.selectPhoto('photo-2');
      });

      expect(hookResult.selectedCount).toBe(2);

      act(() => {
        hookResult.exitSelectionMode();
      });

      expect(hookResult.isSelectionMode).toBe(false);
      expect(hookResult.selectedCount).toBe(0);
      expect(hookResult.lastSelectedId).toBe(null);
    });

    it('can select and deselect individual photos', () => {
      renderHook();

      act(() => {
        hookResult.selectPhoto('photo-1');
      });

      expect(hookResult.selectedIds.has('photo-1')).toBe(true);
      expect(hookResult.selectedCount).toBe(1);

      act(() => {
        hookResult.deselectPhoto('photo-1');
      });

      expect(hookResult.selectedIds.has('photo-1')).toBe(false);
      expect(hookResult.selectedCount).toBe(0);
    });

    it('can toggle photo selection', () => {
      renderHook();

      act(() => {
        hookResult.togglePhotoSelection('photo-1');
      });

      expect(hookResult.selectedIds.has('photo-1')).toBe(true);

      act(() => {
        hookResult.togglePhotoSelection('photo-1');
      });

      expect(hookResult.selectedIds.has('photo-1')).toBe(false);
    });

    it('can select all photos', () => {
      renderHook();
      const photoIds = ['photo-1', 'photo-2', 'photo-3'];

      act(() => {
        hookResult.selectAll(photoIds);
      });

      expect(hookResult.selectedCount).toBe(3);
      expect(hookResult.selectedIds.has('photo-1')).toBe(true);
      expect(hookResult.selectedIds.has('photo-2')).toBe(true);
      expect(hookResult.selectedIds.has('photo-3')).toBe(true);
    });

    it('can clear selection', () => {
      renderHook();

      act(() => {
        hookResult.selectPhoto('photo-1');
        hookResult.selectPhoto('photo-2');
      });

      expect(hookResult.selectedCount).toBe(2);

      act(() => {
        hookResult.clearSelection();
      });

      expect(hookResult.selectedCount).toBe(0);
      expect(hookResult.lastSelectedId).toBe(null);
    });

    it('can check if a photo is selected', () => {
      renderHook();

      act(() => {
        hookResult.selectPhoto('photo-1');
      });

      expect(hookResult.isSelected('photo-1')).toBe(true);
      expect(hookResult.isSelected('photo-2')).toBe(false);
    });
  });

  describe('lastSelectedId tracking', () => {
    it('updates lastSelectedId when selecting a photo', () => {
      renderHook();

      act(() => {
        hookResult.selectPhoto('photo-1');
      });

      expect(hookResult.lastSelectedId).toBe('photo-1');

      act(() => {
        hookResult.selectPhoto('photo-2');
      });

      expect(hookResult.lastSelectedId).toBe('photo-2');
    });

    it('updates lastSelectedId when toggling to select', () => {
      renderHook();

      act(() => {
        hookResult.togglePhotoSelection('photo-1');
      });

      expect(hookResult.lastSelectedId).toBe('photo-1');
    });

    it('does not update lastSelectedId when deselecting', () => {
      renderHook();

      act(() => {
        hookResult.selectPhoto('photo-1');
        hookResult.selectPhoto('photo-2');
      });

      expect(hookResult.lastSelectedId).toBe('photo-2');

      act(() => {
        hookResult.deselectPhoto('photo-2');
      });

      // lastSelectedId should still be photo-2 (the last selected)
      expect(hookResult.lastSelectedId).toBe('photo-2');
    });

    it('clears lastSelectedId on selectAll', () => {
      renderHook();

      act(() => {
        hookResult.selectPhoto('photo-1');
      });

      expect(hookResult.lastSelectedId).toBe('photo-1');

      act(() => {
        hookResult.selectAll(['photo-1', 'photo-2', 'photo-3']);
      });

      expect(hookResult.lastSelectedId).toBe(null);
    });
  });

  describe('shift-click range selection (selectRange)', () => {
    const allPhotoIds = ['photo-1', 'photo-2', 'photo-3', 'photo-4', 'photo-5'];

    it('selects single photo when no anchor exists', () => {
      renderHook();

      act(() => {
        hookResult.selectRange('photo-3', allPhotoIds);
      });

      expect(hookResult.selectedCount).toBe(1);
      expect(hookResult.selectedIds.has('photo-3')).toBe(true);
      expect(hookResult.lastSelectedId).toBe('photo-3');
    });

    it('selects range from anchor to target (forward)', () => {
      renderHook();

      // First click sets anchor
      act(() => {
        hookResult.selectPhoto('photo-2');
      });

      expect(hookResult.lastSelectedId).toBe('photo-2');

      // Shift-click on photo-4
      act(() => {
        hookResult.selectRange('photo-4', allPhotoIds);
      });

      // Should select photos 2, 3, 4
      expect(hookResult.selectedCount).toBe(3);
      expect(hookResult.selectedIds.has('photo-2')).toBe(true);
      expect(hookResult.selectedIds.has('photo-3')).toBe(true);
      expect(hookResult.selectedIds.has('photo-4')).toBe(true);
    });

    it('selects range from anchor to target (backward)', () => {
      renderHook();

      // First click sets anchor at the end
      act(() => {
        hookResult.selectPhoto('photo-4');
      });

      // Shift-click on photo-2 (backward)
      act(() => {
        hookResult.selectRange('photo-2', allPhotoIds);
      });

      // Should select photos 2, 3, 4
      expect(hookResult.selectedCount).toBe(3);
      expect(hookResult.selectedIds.has('photo-2')).toBe(true);
      expect(hookResult.selectedIds.has('photo-3')).toBe(true);
      expect(hookResult.selectedIds.has('photo-4')).toBe(true);
    });

    it('preserves existing selections when range selecting', () => {
      renderHook();

      // Select photo-1 first (not in range)
      act(() => {
        hookResult.selectPhoto('photo-1');
      });

      // Then select photo-3 (this becomes anchor)
      act(() => {
        hookResult.selectPhoto('photo-3');
      });

      // Shift-click on photo-5
      act(() => {
        hookResult.selectRange('photo-5', allPhotoIds);
      });

      // Should have photo-1 plus range 3-5
      expect(hookResult.selectedCount).toBe(4);
      expect(hookResult.selectedIds.has('photo-1')).toBe(true);
      expect(hookResult.selectedIds.has('photo-3')).toBe(true);
      expect(hookResult.selectedIds.has('photo-4')).toBe(true);
      expect(hookResult.selectedIds.has('photo-5')).toBe(true);
    });

    it('keeps anchor stable for chained shift-clicks', () => {
      renderHook();

      // First click sets anchor at photo-2
      act(() => {
        hookResult.selectPhoto('photo-2');
      });

      // First shift-click to photo-4
      act(() => {
        hookResult.selectRange('photo-4', allPhotoIds);
      });

      expect(hookResult.selectedCount).toBe(3); // photos 2, 3, 4

      // Second shift-click to photo-5 should still use photo-2 as anchor
      act(() => {
        hookResult.selectRange('photo-5', allPhotoIds);
      });

      // Should now have photos 2, 3, 4, 5
      expect(hookResult.selectedCount).toBe(4);
      expect(hookResult.selectedIds.has('photo-2')).toBe(true);
      expect(hookResult.selectedIds.has('photo-3')).toBe(true);
      expect(hookResult.selectedIds.has('photo-4')).toBe(true);
      expect(hookResult.selectedIds.has('photo-5')).toBe(true);
    });

    it('handles range selection when anchor not in list', () => {
      renderHook();

      // Select a photo that won't be in the list we pass
      act(() => {
        hookResult.selectPhoto('photo-999');
      });

      // Try range select with a list that doesn't contain the anchor
      act(() => {
        hookResult.selectRange('photo-3', allPhotoIds);
      });

      // Should fall back to selecting just the target
      expect(hookResult.selectedIds.has('photo-3')).toBe(true);
      expect(hookResult.lastSelectedId).toBe('photo-3');
    });

    it('handles range selection when target not in list', () => {
      renderHook();

      act(() => {
        hookResult.selectPhoto('photo-2');
      });

      // Try range select with a target that's not in the list
      act(() => {
        hookResult.selectRange('photo-999', allPhotoIds);
      });

      // Should fall back to selecting just the target
      expect(hookResult.lastSelectedId).toBe('photo-999');
    });

    it('handles selecting the same photo as anchor', () => {
      renderHook();

      act(() => {
        hookResult.selectPhoto('photo-3');
      });

      act(() => {
        hookResult.selectRange('photo-3', allPhotoIds);
      });

      // Should just have that one photo selected
      expect(hookResult.selectedCount).toBe(1);
      expect(hookResult.selectedIds.has('photo-3')).toBe(true);
    });
  });
});
