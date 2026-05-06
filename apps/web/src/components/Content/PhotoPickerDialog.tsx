/**
 * Photo Picker Dialog Component
 *
 * Modal dialog for selecting photos from an album to add to story blocks.
 * Supports multi-select with visual checkmarks and shows photo thumbnails.
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePhotos } from '../../hooks/usePhotos';
import { useAlbumEpochKeys } from '../../hooks/useEpochKeys';
import {
  getCachedPlaceholderDataURL,
  isValidPlaceholderHash,
} from '../../lib/thumbhash-decoder';
import type { EpochHandleId, PhotoMeta } from '../../workers/types';
import { Dialog } from '../Shared/Dialog';
import './PhotoPickerDialog.css';

export interface PhotoPickerDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Called when dialog should close */
  onClose: () => void;
  /** Called when photos are selected */
  onSelect: (manifestIds: string[]) => void;
  /** Album ID to load photos from */
  albumId: string;
  /** Optional: pre-selected IDs for editing existing blocks */
  initialSelection?: string[];
  /** Optional: maximum number of photos that can be selected */
  maxSelection?: number;
  /** Optional: title override */
  title?: string;
}

/**
 * Single photo thumbnail for the picker grid
 */
const PickerThumbnail = memo(function PickerThumbnail({
  photo,
  isSelected,
  onToggle,
  epochReadKey: _epochReadKey, // Reserved for future shard loading
}: {
  photo: PhotoMeta;
  isSelected: boolean;
  onToggle: (id: string) => void;
  epochReadKey: EpochHandleId | undefined;
}) {
  // Get thumbnail URL - prefer embedded thumbnail, then thumbhash placeholder
  const thumbnailUrl = useMemo(() => {
    // Check for embedded thumbnail first
    if (photo.thumbnail && photo.thumbnail.length > 0) {
      if (
        photo.thumbnail.startsWith('blob:') ||
        photo.thumbnail.startsWith('data:') ||
        photo.thumbnail.startsWith('http')
      ) {
        return photo.thumbnail;
      }
      return `data:image/jpeg;base64,${photo.thumbnail}`;
    }
    return null;
  }, [photo.thumbnail]);

  // Placeholder (ThumbHash or legacy BlurHash)
  const placeholderUrl = useMemo(() => {
    const hash = photo.thumbhash || photo.blurhash;
    if (!hash || !isValidPlaceholderHash(hash)) return null;
    return getCachedPlaceholderDataURL(hash);
  }, [photo.thumbhash, photo.blurhash]);

  const handleClick = useCallback(() => {
    onToggle(photo.id);
  }, [photo.id, onToggle]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onToggle(photo.id);
      }
    },
    [photo.id, onToggle],
  );

  const displayUrl = thumbnailUrl || placeholderUrl;

  return (
    <div
      className={`picker-thumbnail ${isSelected ? 'selected' : ''}`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="checkbox"
      aria-checked={isSelected}
      aria-label={`Select ${photo.filename}`}
      data-testid={`picker-photo-${photo.id}`}
    >
      {displayUrl ? (
        <img
          src={displayUrl}
          alt={photo.filename}
          className="picker-thumbnail-image"
          loading="lazy"
        />
      ) : (
        <div className="picker-thumbnail-placeholder">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        </div>
      )}

      {/* Selection overlay */}
      <div className="picker-thumbnail-overlay">
        <div className="picker-checkbox-container">
          <input
            type="checkbox"
            className="picker-checkbox"
            checked={isSelected}
            onChange={() => onToggle(photo.id)}
            aria-label={`Select ${photo.filename}`}
            data-testid={`picker-checkbox-${photo.id}`}
          />
        </div>
      </div>

      {/* Selected indicator border */}
      {isSelected && <div className="picker-selected-indicator" />}
    </div>
  );
});

/**
 * Photo Picker Dialog
 *
 * Shows album photos in a grid and allows multi-select.
 */

// Stable empty array reference to avoid infinite re-render loops
const EMPTY_SELECTION: string[] = [];

export const PhotoPickerDialog = memo(function PhotoPickerDialog({
  isOpen,
  onClose,
  onSelect,
  albumId,
  initialSelection,
  maxSelection,
  title,
}: PhotoPickerDialogProps) {
  const { t } = useTranslation();
  
  // Use stable empty array if no initial selection provided
  const stableInitialSelection = initialSelection ?? EMPTY_SELECTION;
  
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    new Set(stableInitialSelection),
  );
  const [searchQuery, setSearchQuery] = useState('');

  // Load photos for the album
  const { photos, isLoading, error } = usePhotos(albumId, searchQuery || undefined);

  // Load epoch keys for thumbnails
  const { epochKeys, isLoading: keysLoading } = useAlbumEpochKeys(albumId);

  // Reset selection when dialog opens
  useEffect(() => {
    if (isOpen) {
      setSelectedIds(new Set(stableInitialSelection));
      setSearchQuery('');
    }
  }, [isOpen, stableInitialSelection]);

  // Toggle photo selection
  const handleToggle = useCallback(
    (photoId: string) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(photoId)) {
          next.delete(photoId);
        } else {
          // Check max selection limit
          if (maxSelection && next.size >= maxSelection) {
            return prev;
          }
          next.add(photoId);
        }
        return next;
      });
    },
    [maxSelection],
  );

  // Select all visible photos
  const handleSelectAll = useCallback(() => {
    if (maxSelection) {
      // Only select up to max
      const photosToSelect = photos.slice(0, maxSelection);
      setSelectedIds(new Set(photosToSelect.map((p) => p.id)));
    } else {
      setSelectedIds(new Set(photos.map((p) => p.id)));
    }
  }, [photos, maxSelection]);

  // Clear selection
  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // Handle confirm
  const handleConfirm = useCallback(() => {
    onSelect(Array.from(selectedIds));
    onClose();
  }, [selectedIds, onSelect, onClose]);

  // Filter photos by search query (simple client-side filter if usePhotos doesn't handle it)
  const filteredPhotos = useMemo(() => {
    // usePhotos handles search via FTS5, so we just use photos directly
    return photos;
  }, [photos]);

  // Get epoch key for a photo
  const getEpochKey = useCallback(
    (epochId: number) => epochKeys.get(epochId),
    [epochKeys],
  );

  const selectionCount = selectedIds.size;
  const hasSelection = selectionCount > 0;

  const footer = (
    <>
      <button
        type="button"
        onClick={onClose}
        className="button-secondary"
        data-testid="photo-picker-cancel"
      >
        {t('common.cancel')}
      </button>
      <button
        type="button"
        onClick={handleConfirm}
        disabled={!hasSelection}
        className="button-primary"
        data-testid="photo-picker-confirm"
      >
        {selectionCount > 0
          ? t('gallery.photoSelected', { count: selectionCount })
          : t('gallery.selectPhotos')}
      </button>
    </>
  );

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={title || t('gallery.selectPhotos')}
      footer={footer}
      className="photo-picker-dialog"
      testId="photo-picker-dialog"
    >
      {/* Search and actions bar */}
      <div className="picker-toolbar">
        <div className="picker-search">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('gallery.searchPlaceholder')}
            className="picker-search-input"
            data-testid="photo-picker-search"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="picker-search-clear"
              aria-label={t('gallery.clearSearch')}
            >
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
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>

        <div className="picker-actions">
          {hasSelection && (
            <button
              type="button"
              onClick={handleClearSelection}
              className="picker-action-btn"
              data-testid="photo-picker-clear"
            >
              {t('common.clear')}
            </button>
          )}
          <button
            type="button"
            onClick={handleSelectAll}
            className="picker-action-btn"
            disabled={photos.length === 0}
            data-testid="photo-picker-select-all"
          >
            {t('gallery.select')} All
          </button>
        </div>
      </div>

      {/* Photo grid */}
      <div className="picker-grid-container">
        {isLoading || keysLoading ? (
          <div className="picker-loading" data-testid="photo-picker-loading">
            <div className="loading-spinner" />
            <span>{t('common.loading')}</span>
          </div>
        ) : error ? (
          <div className="picker-error" data-testid="photo-picker-error">
            <span>{error.message}</span>
            <button type="button" onClick={() => window.location.reload()}>
              {t('common.retry')}
            </button>
          </div>
        ) : filteredPhotos.length === 0 ? (
          <div className="picker-empty" data-testid="photo-picker-empty">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            <span>
              {searchQuery
                ? t('gallery.searchPlaceholder') + ' - No results'
                : 'No photos in this album'}
            </span>
          </div>
        ) : (
          <div className="picker-grid" data-testid="photo-picker-grid">
            {filteredPhotos.map((photo) => (
              <PickerThumbnail
                key={photo.id}
                photo={photo}
                isSelected={selectedIds.has(photo.id)}
                onToggle={handleToggle}
                epochReadKey={getEpochKey(photo.epochId)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Selection info */}
      {maxSelection && (
        <div className="picker-selection-info">
          {selectionCount} / {maxSelection} selected
        </div>
      )}
    </Dialog>
  );
});

export default PhotoPickerDialog;
