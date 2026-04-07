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

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAlbumPermissions } from '../../contexts/AlbumPermissionsContext';

interface AlbumSettingsDropdownProps {
  onShowMembers: () => void;
  onShowShareLinks: () => void;
  onRenameAlbum?: (() => void) | undefined;
  onEditDescription?: (() => void) | undefined;
  onDeleteAlbum?: (() => void) | undefined;
  onDownloadAll?: (() => void) | undefined;
}

/**
 * Dropdown menu for album settings/configuration
 */
export function AlbumSettingsDropdown({
  onShowMembers,
  onShowShareLinks,
  onRenameAlbum,
  onEditDescription,
  onDeleteAlbum,
  onDownloadAll,
}: AlbumSettingsDropdownProps) {
  const { t } = useTranslation();
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
    <div
      className="album-settings-dropdown"
      data-testid="album-settings-dropdown"
    >
      <button
        ref={buttonRef}
        className="button-secondary album-settings-trigger"
        onClick={toggleDropdown}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label="Album settings"
        data-testid="album-settings-button"
      >
        <span className="settings-icon">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </span>
        <span className="button-label">Album</span>
        <span className="dropdown-arrow">
          {isOpen ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="18 15 12 9 6 15" />
            </svg>
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          )}
        </span>
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
            <span className="menu-icon">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </span>
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
              <span className="menu-icon">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
              </span>
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
              <span className="menu-icon">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </span>
              <span className="menu-label">Rename Album</span>
            </button>
          )}

          {/* Edit Description - owners and editors */}
          {permissions.canUpload && onEditDescription && (
            <button
              className="album-settings-item"
              onClick={() => handleAction(onEditDescription)}
              role="menuitem"
              data-testid="menu-description-button"
            >
              <span className="menu-icon">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                  <polyline points="10 9 9 9 8 9" />
                </svg>
              </span>
              <span className="menu-label">Edit Description</span>
            </button>
          )}

          {/* Download All - visible to all members */}
          {onDownloadAll && (
            <button
              className="album-settings-item"
              onClick={() => handleAction(onDownloadAll)}
              role="menuitem"
              data-testid="menu-download-all-button"
            >
              <span className="menu-icon">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </span>
              <span className="menu-label">{t('download.downloadAll')}</span>
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
                <span className="menu-icon">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </span>
                <span className="menu-label">Delete Album</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
