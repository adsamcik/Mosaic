/**
 * Album Settings Dropdown Component
 *
 * Provides a dropdown menu for album-level configuration actions:
 * - Share (manage members)
 * - Links (manage share links)
 * - Rename (rename album)
 * - Delete (delete album)
 *
 * This keeps album configuration separate from batch photo operations.
 */

import { useRef, useState, useEffect, useCallback } from 'react';
import { useAlbumPermissions } from '../../contexts/AlbumPermissionsContext';

interface AlbumSettingsDropdownProps {
  onShowMembers: () => void;
  onShowShareLinks: () => void;
  onRenameAlbum?: (() => void) | undefined;
  onDeleteAlbum?: (() => void) | undefined;
}

/**
 * Dropdown menu for album settings/configuration
 */
export function AlbumSettingsDropdown({
  onShowMembers,
  onShowShareLinks,
  onRenameAlbum,
  onDeleteAlbum,
}: AlbumSettingsDropdownProps) {
  const permissions = useAlbumPermissions();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  const toggleDropdown = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  const handleAction = useCallback((action: () => void) => {
    action();
    setIsOpen(false);
  }, []);

  return (
    <div className="album-settings-dropdown" data-testid="album-settings-dropdown">
      <button
        ref={buttonRef}
        className="button-secondary album-settings-trigger"
        onClick={toggleDropdown}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label="Album settings"
        data-testid="album-settings-button"
      >
        <span className="settings-icon">⚙️</span>
        <span className="button-label">Album</span>
        <span className="dropdown-arrow">{isOpen ? '▲' : '▼'}</span>
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="album-settings-menu"
          role="menu"
          aria-label="Album settings menu"
          data-testid="album-settings-menu"
        >
          {/* Share - visible to all members */}
          <button
            className="album-settings-item"
            onClick={() => handleAction(onShowMembers)}
            role="menuitem"
            data-testid="menu-share-button"
          >
            <span className="menu-icon">👥</span>
            <span className="menu-label">Manage Members</span>
          </button>

          {/* Links - owners only */}
          {permissions.canManageShareLinks && (
            <button
              className="album-settings-item"
              onClick={() => handleAction(onShowShareLinks)}
              role="menuitem"
              data-testid="menu-links-button"
            >
              <span className="menu-icon">🔗</span>
              <span className="menu-label">Share Links</span>
            </button>
          )}

          {/* Rename - owners and editors */}
          {permissions.canUpload && onRenameAlbum && (
            <button
              className="album-settings-item"
              onClick={() => handleAction(onRenameAlbum)}
              role="menuitem"
              data-testid="menu-rename-button"
            >
              <span className="menu-icon">✏️</span>
              <span className="menu-label">Rename Album</span>
            </button>
          )}

          {/* Divider before destructive action */}
          {permissions.isOwner && onDeleteAlbum && (
            <>
              <div className="album-settings-divider" role="separator" />
              <button
                className="album-settings-item album-settings-item--danger"
                onClick={() => handleAction(onDeleteAlbum)}
                role="menuitem"
                data-testid="menu-delete-button"
              >
                <span className="menu-icon">🗑️</span>
                <span className="menu-label">Delete Album</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
