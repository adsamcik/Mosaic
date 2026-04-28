/**
 * useLightbox Hook
 *
 * Manages lightbox state for viewing full-resolution photos.
 * Provides navigation between photos.
 */

import { useCallback, useEffect, useState } from 'react';
import type { PhotoMeta } from '../workers/types';

/** Navigation direction for preloading */
export type NavigationDirection = 'forward' | 'backward' | 'initial';

/**
 * Lightbox state returned by the hook
 */
export interface LightboxState {
  /** Whether the lightbox is currently open */
  isOpen: boolean;
  /** Index of the currently displayed photo in the photos array */
  currentIndex: number;
  /** The currently displayed photo, or null if closed */
  currentPhoto: PhotoMeta | null;
  /** Whether there is a next photo to navigate to */
  hasNext: boolean;
  /** Whether there is a previous photo to navigate to */
  hasPrevious: boolean;
  /** Direction of last navigation for smarter preloading */
  navigationDirection: NavigationDirection;
}

/**
 * Lightbox controls returned by the hook
 */
export interface LightboxControls {
  /** Open the lightbox at a specific photo index */
  open: (index: number) => void;
  /** Close the lightbox */
  close: () => void;
  /** Navigate to the next photo */
  next: () => void;
  /** Navigate to the previous photo */
  previous: () => void;
  /** Navigate to a specific photo index */
  goTo: (index: number) => void;
}

/**
 * Result returned by useLightbox hook
 */
export type UseLightboxResult = LightboxState & LightboxControls;

/**
 * Hook to manage photo lightbox state and navigation
 *
 * @param photos - Array of photos available for viewing
 * @returns Lightbox state and controls
 *
 * @example
 * ```tsx
 * const { isOpen, currentPhoto, open, close, next, previous } = useLightbox(photos);
 *
 * return (
 *   <>
 *     {photos.map((photo, i) => (
 *       <PhotoThumbnail key={photo.id} photo={photo} onClick={() => open(i)} />
 *     ))}
 *     {isOpen && currentPhoto && (
 *       <PhotoLightbox photo={currentPhoto} onClose={close} onNext={next} onPrevious={previous} />
 *     )}
 *   </>
 * );
 * ```
 */
export function useLightbox(photos: PhotoMeta[]): UseLightboxResult {
  const [isOpen, setIsOpen] = useState(false);
  // Anchor the open lightbox to the *photo identity*, not the integer index.
  // The parent's `photos` array can mutate while the lightbox is open
  // (background sync inserts a newer photo at the top, another grid deletes
  // a photo, the album re-syncs in a different order, …). Indexing by
  // integer caused the displayed photo to silently shift to a neighbour,
  // which the user perceives as the viewer "skipping" over photos.
  const [currentPhotoId, setCurrentPhotoId] = useState<string | null>(null);
  // Numeric position remembered for the rare case the anchored photo has
  // been removed from the array entirely (e.g. deleted from another tab):
  // we keep the same slot so the next/previous photo in the old order
  // takes its place — matching Google Photos' delete-and-advance behaviour.
  const [fallbackIndex, setFallbackIndex] = useState(0);
  const [navigationDirection, setNavigationDirection] =
    useState<NavigationDirection>('initial');

  // Derive the current index/photo synchronously during render so we never
  // paint a stale neighbour for a frame before an effect catches up.
  let currentIndex = 0;
  let currentPhoto: PhotoMeta | null = null;
  if (isOpen && photos.length > 0 && currentPhotoId) {
    const found = photos.findIndex((p) => p.id === currentPhotoId);
    if (found >= 0) {
      currentIndex = found;
      currentPhoto = photos[found] ?? null;
    } else {
      const clamped = Math.min(
        Math.max(fallbackIndex, 0),
        photos.length - 1,
      );
      currentIndex = clamped;
      currentPhoto = photos[clamped] ?? null;
    }
  }

  const hasNext = isOpen && currentPhoto !== null && currentIndex < photos.length - 1;
  const hasPrevious = isOpen && currentPhoto !== null && currentIndex > 0;

  /**
   * Open the lightbox at a specific photo index
   */
  const open = useCallback(
    (index: number) => {
      if (index >= 0 && index < photos.length) {
        setCurrentPhotoId(photos[index]!.id);
        setFallbackIndex(index);
        setNavigationDirection('initial');
        setIsOpen(true);
      }
    },
    [photos],
  );

  /**
   * Close the lightbox
   */
  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  /**
   * Navigate to the next photo
   */
  const next = useCallback(() => {
    if (!isOpen || currentPhoto === null) return;
    if (currentIndex >= photos.length - 1) return;
    const nextIdx = currentIndex + 1;
    setCurrentPhotoId(photos[nextIdx]!.id);
    setFallbackIndex(nextIdx);
    setNavigationDirection('forward');
  }, [isOpen, currentPhoto, currentIndex, photos]);

  /**
   * Navigate to the previous photo
   */
  const previous = useCallback(() => {
    if (!isOpen || currentPhoto === null) return;
    if (currentIndex <= 0) return;
    const prevIdx = currentIndex - 1;
    setCurrentPhotoId(photos[prevIdx]!.id);
    setFallbackIndex(prevIdx);
    setNavigationDirection('backward');
  }, [isOpen, currentPhoto, currentIndex, photos]);

  /**
   * Navigate to a specific photo index
   */
  const goTo = useCallback(
    (index: number) => {
      if (index >= 0 && index < photos.length) {
        setCurrentPhotoId(photos[index]!.id);
        setFallbackIndex(index);
      }
    },
    [photos],
  );

  // Prevent body scroll when lightbox is open
  useEffect(() => {
    if (isOpen) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = originalOverflow;
      };
    }
  }, [isOpen]);

  // Auto-close when the album empties; re-anchor state to the live array
  // so subsequent navigation operates against current photo identities.
  useEffect(() => {
    if (!isOpen) return;
    if (photos.length === 0) {
      setIsOpen(false);
      setCurrentPhotoId(null);
      return;
    }
    if (currentPhotoId === null) return;
    const idx = photos.findIndex((p) => p.id === currentPhotoId);
    if (idx >= 0) {
      // Keep fallbackIndex in sync with the photo's live position so any
      // future deletion of this same photo still reveals the right slot.
      if (idx !== fallbackIndex) setFallbackIndex(idx);
    } else if (photos.length > 0) {
      // The anchored photo is gone (deleted elsewhere). Re-anchor the ID
      // to whichever photo took its slot so render stays stable until the
      // user navigates again.
      const clamped = Math.min(
        Math.max(fallbackIndex, 0),
        photos.length - 1,
      );
      const replacement = photos[clamped]!.id;
      if (replacement !== currentPhotoId) setCurrentPhotoId(replacement);
    }
  }, [photos, isOpen, currentPhotoId, fallbackIndex]);

  return {
    isOpen,
    currentIndex,
    currentPhoto,
    hasNext,
    hasPrevious,
    navigationDirection,
    open,
    close,
    next,
    previous,
    goTo,
  };
}
