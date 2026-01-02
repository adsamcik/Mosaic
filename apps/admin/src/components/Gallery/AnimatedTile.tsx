/**
 * AnimatedTile Component
 * 
 * Wrapper component that provides smooth enter/exit animations for photo tiles.
 * Designed to work with virtualized lists where items are mounted/unmounted
 * based on scroll position.
 * 
 * Animation Phases:
 * - entering: Item just appeared (opacity 0, scale 0.92)
 * - entered: Animation complete (opacity 1, scale 1)
 * - exiting: Item being removed (animating to opacity 0, scale 0.85)
 * - exited: Animation done, ready for unmount
 * 
 * Key Features:
 * - Detects "new" items vs returning items (no re-animation on scroll)
 * - Supports staggered batch animations
 * - GPU-accelerated (transform + opacity only)
 * - Respects prefers-reduced-motion
 * 
 * @module AnimatedTile
 */

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import '../../styles/animations.css';

/** Animation phase states */
export type AnimationPhase = 'entering' | 'entered' | 'exiting' | 'exited';

/** Props for AnimatedTile component */
export interface AnimatedTileProps {
  /** Unique stable key for this item (used to track "seen" state) */
  itemKey: string;
  /** Timestamp when this item first appeared (for new item detection) */
  appearedAt?: number;
  /** Whether this item should animate out */
  isExiting?: boolean;
  /** Callback when exit animation completes */
  onExitComplete?: () => void;
  /** Stagger delay in ms (for batch animations) */
  staggerDelay?: number;
  /** Whether this item has been seen before (skip enter animation) */
  hasBeenSeen?: boolean;
  /** Whether to skip animation entirely (e.g., initial load) */
  skipAnimation?: boolean;
  /** The content to render */
  children: ReactNode;
  /** Additional CSS class names */
  className?: string;
  /** Additional inline styles */
  style?: React.CSSProperties;
  /** Test ID for testing */
  'data-testid'?: string;
}

/** Time window (ms) to consider an item as "new" */
const NEW_ITEM_THRESHOLD = 150;

/** Duration (ms) for enter animation */
const ENTER_DURATION = 280;

/** Duration (ms) for exit animation */
const EXIT_DURATION = 200;

/** Delay (ms) before removing will-change for memory efficiency */
const SETTLE_DELAY = 100;

/**
 * AnimatedTile - Provides smooth enter/exit animations for photo grid tiles.
 * 
 * @example
 * ```tsx
 * <AnimatedTile
 *   itemKey={photo.id}
 *   appearedAt={photo.appearedAt}
 *   isExiting={isDeleting}
 *   onExitComplete={() => cleanup(photo.id)}
 *   staggerDelay={index * 50}
 * >
 *   <PhotoThumbnail photo={photo} />
 * </AnimatedTile>
 * ```
 */
export const AnimatedTile = memo(function AnimatedTile({
  itemKey,
  appearedAt,
  isExiting = false,
  onExitComplete,
  staggerDelay = 0,
  hasBeenSeen = false,
  skipAnimation = false,
  children,
  className = '',
  style,
  'data-testid': testId,
}: AnimatedTileProps) {
  // Determine initial phase
  const getInitialPhase = (): AnimationPhase => {
    if (skipAnimation || hasBeenSeen) return 'entered';
    
    const now = Date.now();
    const entryTime = appearedAt ?? now;
    const isNew = now - entryTime < NEW_ITEM_THRESHOLD;
    
    return isNew ? 'entering' : 'entered';
  };

  const [phase, setPhase] = useState<AnimationPhase>(getInitialPhase);
  const [isSettled, setIsSettled] = useState(phase === 'entered');
  const ref = useRef<HTMLDivElement>(null);
  const entryTimeRef = useRef(appearedAt ?? Date.now());

  // Handle enter animation
  useEffect(() => {
    if (skipAnimation || hasBeenSeen) {
      setPhase('entered');
      setIsSettled(true);
      return;
    }

    const isNew = Date.now() - entryTimeRef.current < NEW_ITEM_THRESHOLD;

    if (isNew && phase === 'entering') {
      // Small delay to ensure CSS picks up initial state
      const frameDelay = requestAnimationFrame(() => {
        setPhase('entered');
      });

      // After animation completes + settle delay, remove will-change
      const settleTimer = setTimeout(() => {
        setIsSettled(true);
      }, staggerDelay + ENTER_DURATION + SETTLE_DELAY);

      return () => {
        cancelAnimationFrame(frameDelay);
        clearTimeout(settleTimer);
      };
    } else if (!isNew && phase === 'entering') {
      // Item is old, skip to entered
      setPhase('entered');
      setIsSettled(true);
    }
  }, [itemKey, staggerDelay, skipAnimation, hasBeenSeen, phase]);

  // Handle exit animation
  useEffect(() => {
    if (isExiting && phase !== 'exiting' && phase !== 'exited') {
      setPhase('exiting');
      setIsSettled(false);

      // Wait for animation to complete
      const timer = setTimeout(() => {
        setPhase('exited');
        onExitComplete?.();
      }, EXIT_DURATION);

      return () => clearTimeout(timer);
    }
  }, [isExiting, phase, onExitComplete]);

  // Get animation class based on phase
  const getAnimationClass = useCallback((): string => {
    switch (phase) {
      case 'entering':
        return 'tile-enter';
      case 'entered':
        return 'tile-enter-active';
      case 'exiting':
        return 'tile-exit';
      case 'exited':
        return 'tile-exit-active';
      default:
        return '';
    }
  }, [phase]);

  // Don't render if fully exited
  if (phase === 'exited') {
    return null;
  }

  const animationClass = getAnimationClass();
  const settledClass = isSettled ? 'animation-settled' : '';

  return (
    <div
      ref={ref}
      className={`animated-tile ${animationClass} ${settledClass} ${className}`.trim()}
      style={{
        '--stagger-delay': `${staggerDelay}ms`,
        ...style,
      } as React.CSSProperties}
      data-item-key={itemKey}
      data-animation-phase={phase}
      data-testid={testId}
    >
      {children}
    </div>
  );
});

/**
 * Hook to check if reduced motion is preferred
 */
export function usePrefersReducedMotion(): boolean {
  const [prefersReduced, setPrefersReduced] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    
    const handler = (event: MediaQueryListEvent) => {
      setPrefersReduced(event.matches);
    };

    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  return prefersReduced;
}
