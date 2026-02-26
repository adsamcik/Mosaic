/**
 * useLightbox Hook
 *
 * Manages lightbox state for viewing full-resolution photos.
 * Provides navigation between photos and keyboard controls.
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
  const [currentIndex, setCurrentIndex] = useState(0);
  const [navigationDirection, setNavigationDirection] =
    useState<NavigationDirection>('initial');

  // Compute derived state
  const currentPhoto =
    isOpen && photos.length > 0 ? (photos[currentIndex] ?? null) : null;
  const hasNext = isOpen && currentIndex < photos.length - 1;
  const hasPrevious = isOpen && currentIndex > 0;

  /**
   * Open the lightbox at a specific photo index
   */
  const open = useCallback(
    (index: number) => {
      if (index >= 0 && index < photos.length) {
        setCurrentIndex(index);
        setNavigationDirection('initial');
        setIsOpen(true);
      }
    },
    [photos.length],
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
    setCurrentIndex((prev) => {
      if (prev < photos.length - 1) {
        setNavigationDirection('forward');
        return prev + 1;
      }
      return prev;
    });
  }, [photos.length]);

  /**
   * Navigate to the previous photo
   */
  const previous = useCallback(() => {
    setCurrentIndex((prev) => {
      if (prev > 0) {
        setNavigationDirection('backward');
        return prev - 1;
      }
      return prev;
    });
  }, []);

  /**
   * Navigate to a specific photo index
   */
  const goTo = useCallback(
    (index: number) => {
      if (index >= 0 && index < photos.length) {
        setCurrentIndex(index);
      }
    },
    [photos.length],
  );

  // Handle keyboard navigation when lightbox is open
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'Escape':
          close();
          break;
        case 'ArrowRight':
          next();
          break;
        case 'ArrowLeft':
          previous();
          break;
        default:
          // Ignore other keys
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, close, next, previous]);

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

  // Reset index if photos array changes and current index is out of bounds
  useEffect(() => {
    if (currentIndex >= photos.length && photos.length > 0) {
      setCurrentIndex(photos.length - 1);
    } else if (photos.length === 0 && isOpen) {
      setIsOpen(false);
    }
  }, [photos.length, currentIndex, isOpen]);

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
