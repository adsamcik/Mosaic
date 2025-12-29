/**
 * Selection Action Bar Component
 *
 * A floating action bar that appears at the bottom of the screen
 * when photos are selected. Provides quick access to batch operations
 * like delete and download.
 */

import { useCallback, useEffect } from 'react';
import { useAlbumPermissions } from '../../contexts/AlbumPermissionsContext';

interface SelectionActionBarProps {
  /** Number of selected photos */
  selectedCount: number;
  /** Whether selection mode is active */
  isSelectionMode: boolean;
  /** Callback to select all photos */
  onSelectAll: () => void;
  /** Callback to clear selection */
  onClearSelection: () => void;
  /** Callback to exit selection mode */
  onExitSelectionMode: () => void;
  /** Callback to delete selected photos */
  onDeleteSelected: () => void;
  /** Total number of photos available */
  totalPhotos: number;
}

/**
 * Floating action bar for batch photo operations
 */
export function SelectionActionBar({
  selectedCount,
  isSelectionMode,
  onSelectAll,
  onClearSelection,
  onExitSelectionMode,
  onDeleteSelected,
  totalPhotos,
}: SelectionActionBarProps) {
  const permissions = useAlbumPermissions();

  // Handle keyboard shortcuts
  useEffect(() => {
    if (!isSelectionMode) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Escape to exit selection mode
      if (event.key === 'Escape') {
        event.preventDefault();
        onExitSelectionMode();
        return;
      }

      // Ctrl/Cmd + A to select all
      if ((event.ctrlKey || event.metaKey) && event.key === 'a') {
        event.preventDefault();
        onSelectAll();
        return;
      }

      // Delete/Backspace to delete selected (only if photos are selected)
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedCount > 0 && permissions.canDelete) {
        // Don't trigger if user is typing in an input
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
          return;
        }
        event.preventDefault();
        onDeleteSelected();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSelectionMode, selectedCount, onSelectAll, onExitSelectionMode, onDeleteSelected, permissions.canDelete]);

  // Don't render if not in selection mode
  if (!isSelectionMode) return null;

  const allSelected = selectedCount === totalPhotos && totalPhotos > 0;
  const someSelected = selectedCount > 0;

  return (
    <div className="selection-action-bar" data-testid="selection-action-bar">
      <div className="selection-action-bar-content">
        {/* Left side: Selection info */}
        <div className="selection-action-bar-info">
          <div className="selection-action-bar-count">
            <span className="selection-count-number">{selectedCount}</span>
            <span className="selection-count-label">
              {selectedCount === 1 ? 'photo selected' : 'photos selected'}
            </span>
          </div>
        </div>

        {/* Center: Quick actions */}
        <div className="selection-action-bar-actions">
          {/* Select All / Deselect All toggle */}
          <button
            className="action-bar-button action-bar-button-secondary"
            onClick={allSelected ? onClearSelection : onSelectAll}
            data-testid="action-bar-select-all"
            title={allSelected ? 'Deselect all (Ctrl+A)' : 'Select all (Ctrl+A)'}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {allSelected ? (
                // Checkbox with minus (deselect)
                <>
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                  <line x1="8" y1="12" x2="16" y2="12"/>
                </>
              ) : (
                // Checkbox with plus (select all)
                <>
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                  <line x1="12" y1="8" x2="12" y2="16"/>
                  <line x1="8" y1="12" x2="16" y2="12"/>
                </>
              )}
            </svg>
            <span>{allSelected ? 'Deselect All' : 'Select All'}</span>
          </button>

          {/* Clear selection (only when some are selected) */}
          {someSelected && !allSelected && (
            <button
              className="action-bar-button action-bar-button-secondary"
              onClick={onClearSelection}
              data-testid="action-bar-clear"
              title="Clear selection"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
              <span>Clear</span>
            </button>
          )}

          {/* Delete selected */}
          {permissions.canDelete && someSelected && (
            <button
              className="action-bar-button action-bar-button-danger"
              onClick={onDeleteSelected}
              data-testid="action-bar-delete"
              title="Delete selected (Delete key)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
              <span>Delete ({selectedCount})</span>
            </button>
          )}
        </div>

        {/* Right side: Exit button */}
        <div className="selection-action-bar-exit">
          <button
            className="action-bar-button action-bar-button-ghost"
            onClick={onExitSelectionMode}
            data-testid="action-bar-exit"
            title="Exit selection mode (Esc)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
            <span>Done</span>
          </button>
        </div>
      </div>

      {/* Keyboard shortcuts hint */}
      <div className="selection-action-bar-hints">
        <span className="hint"><kbd>Esc</kbd> to exit</span>
        <span className="hint"><kbd>Ctrl+A</kbd> select all</span>
        {permissions.canDelete && <span className="hint"><kbd>Del</kbd> delete</span>}
      </div>
    </div>
  );
}
