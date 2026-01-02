# Mosaic Animation System Design

> **Status:** ✅ Implemented  
> **Author:** Copilot  
> **Date:** 2025-12-31  
> **Implemented:** 2025-07-24

## Executive Summary

This document specifies a comprehensive animation system for Mosaic's photo gallery that provides smooth enter/exit animations, layout transitions, and upload progress integration while maintaining 60fps performance with 1000+ items through TanStack Virtual integration.

---

## 1. Animation Library Recommendation

### Decision: **CSS-First with Minimal React State**

**Rationale:**

| Option | Bundle Size | Virtual List Compat | Exit Animation | Performance |
|--------|-------------|---------------------|----------------|-------------|
| **CSS-only** | 0 KB | ✅ Excellent | ❌ Limited | ✅ Best |
| Framer Motion | ~45 KB | ⚠️ AnimatePresence issues with virtualization | ✅ AnimatePresence | ⚠️ Good |
| React Spring | ~25 KB | ⚠️ Requires manual orchestration | ⚠️ Manual | ✅ Good |
| **CSS + useTransition** | 0 KB | ✅ Excellent | ✅ Delay-based | ✅ Best |

**Why NOT Framer Motion:**
- `AnimatePresence` fundamentally conflicts with virtualization—it expects items to remain mounted during exit animations, but virtualized items are unmounted when scrolled out of view
- Bundle size impact (45KB gzipped) is significant for a privacy-focused app
- Layout animations (`layout` prop) cause expensive re-renders across all items

**Why CSS + React 19 Patterns:**
- Native CSS animations use GPU compositing (transform, opacity)
- React 19's `startTransition` enables non-blocking state updates
- Zero bundle size addition
- Works seamlessly with TanStack Virtual's windowing
- Exit animations handled via "phantom entries" pattern (explained below)

---

## 2. Component Architecture

### 2.1 Animation Layer Structure

```
┌─────────────────────────────────────────────────────────────────┐
│  VirtualizedGrid (TanStack Virtual)                             │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  VirtualRow                                                │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │  │
│  │  │AnimatedTile │  │AnimatedTile │  │AnimatedTile │       │  │
│  │  │  ┌───────┐  │  │  ┌───────┐  │  │  ┌───────┐  │       │  │
│  │  │  │ Photo │  │  │  │ Photo │  │  │  │ Photo │  │       │  │
│  │  │  │Thumb  │  │  │  │Thumb  │  │  │  │Thumb  │  │       │  │
│  │  │  └───────┘  │  │  └───────┘  │  │  └───────┘  │       │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘       │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 AnimatedTile Wrapper Component

```tsx
// apps/admin/src/components/Gallery/AnimatedTile.tsx

import { useEffect, useRef, useState, type ReactNode } from 'react';

type AnimationPhase = 'entering' | 'entered' | 'exiting' | 'exited';

interface AnimatedTileProps {
  /** Unique stable key for this item */
  itemKey: string;
  /** When this timestamp changes, we know the item was just added */
  appearedAt?: number;
  /** If true, item is marked for removal and will animate out */
  isExiting?: boolean;
  /** Callback when exit animation completes */
  onExitComplete?: () => void;
  /** Stagger delay in ms (for batch animations) */
  staggerDelay?: number;
  /** The content to render */
  children: ReactNode;
}

export function AnimatedTile({
  itemKey,
  appearedAt,
  isExiting = false,
  onExitComplete,
  staggerDelay = 0,
  children,
}: AnimatedTileProps) {
  const [phase, setPhase] = useState<AnimationPhase>('entering');
  const ref = useRef<HTMLDivElement>(null);
  const entryTime = useRef(appearedAt ?? Date.now());

  // Handle enter animation
  useEffect(() => {
    // If item appeared recently (within 100ms), animate it
    const isNew = Date.now() - entryTime.current < 100;
    
    if (isNew) {
      // Start in entering state
      setPhase('entering');
      
      // Apply stagger delay then transition to entered
      const timer = setTimeout(() => {
        setPhase('entered');
      }, staggerDelay + 16); // 16ms = one frame delay for CSS to pick up initial state
      
      return () => clearTimeout(timer);
    } else {
      // Item was already present, skip animation
      setPhase('entered');
    }
  }, [itemKey, staggerDelay]);

  // Handle exit animation
  useEffect(() => {
    if (isExiting && phase !== 'exiting' && phase !== 'exited') {
      setPhase('exiting');
      
      // Wait for animation to complete
      const timer = setTimeout(() => {
        setPhase('exited');
        onExitComplete?.();
      }, 300); // Match CSS animation duration
      
      return () => clearTimeout(timer);
    }
  }, [isExiting, phase, onExitComplete]);

  // Animation class based on phase
  const animationClass = {
    entering: 'tile-enter',
    entered: 'tile-enter-active',
    exiting: 'tile-exit',
    exited: 'tile-exit-active',
  }[phase];

  return (
    <div
      ref={ref}
      className={`animated-tile ${animationClass}`}
      style={{
        '--stagger-delay': `${staggerDelay}ms`,
      } as React.CSSProperties}
    >
      {children}
    </div>
  );
}
```

### 2.3 Animation Tracking Hook

```tsx
// apps/admin/src/hooks/useAnimatedItems.ts

import { useRef, useMemo, useCallback, useState } from 'react';

interface AnimatedItem<T> {
  item: T;
  key: string;
  appearedAt: number;
  isExiting: boolean;
}

interface UseAnimatedItemsOptions<T> {
  /** Function to extract unique key from item */
  getKey: (item: T) => string;
  /** Callback when exit animation completes for an item */
  onRemoveComplete?: (key: string) => void;
}

/**
 * Tracks item enter/exit state for animations.
 * Maintains "phantom" entries for items being removed so they can animate out.
 */
export function useAnimatedItems<T>(
  items: T[],
  options: UseAnimatedItemsOptions<T>
) {
  const { getKey, onRemoveComplete } = options;
  
  // Track when items first appeared
  const seenKeys = useRef(new Map<string, number>());
  
  // Track items that are exiting (still visible but being removed)
  const [exitingKeys, setExitingKeys] = useState(new Set<string>());
  
  // Previous items for comparison
  const prevItemsRef = useRef<T[]>([]);

  // Compute animated items with enter/exit state
  const animatedItems = useMemo(() => {
    const now = Date.now();
    const currentKeys = new Set(items.map(getKey));
    const result: AnimatedItem<T>[] = [];

    // Detect removed items (were in prev, not in current)
    const prevKeys = new Set(prevItemsRef.current.map(getKey));
    const removedKeys = new Set<string>();
    
    for (const key of prevKeys) {
      if (!currentKeys.has(key)) {
        removedKeys.add(key);
      }
    }

    // Add current items
    for (const item of items) {
      const key = getKey(item);
      
      // Track first appearance
      if (!seenKeys.current.has(key)) {
        seenKeys.current.set(key, now);
      }
      
      result.push({
        item,
        key,
        appearedAt: seenKeys.current.get(key)!,
        isExiting: false,
      });
    }

    // Add phantom entries for exiting items
    for (const key of exitingKeys) {
      // Find the item from previous state
      const prevItem = prevItemsRef.current.find(i => getKey(i) === key);
      if (prevItem && !currentKeys.has(key)) {
        result.push({
          item: prevItem,
          key,
          appearedAt: seenKeys.current.get(key) ?? now,
          isExiting: true,
        });
      }
    }

    // Update exiting keys state
    if (removedKeys.size > 0) {
      setExitingKeys(prev => {
        const next = new Set(prev);
        for (const key of removedKeys) {
          next.add(key);
        }
        return next;
      });
    }

    // Update prev items ref
    prevItemsRef.current = items;

    return result;
  }, [items, getKey, exitingKeys]);

  // Callback when exit animation completes
  const handleExitComplete = useCallback((key: string) => {
    setExitingKeys(prev => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    seenKeys.current.delete(key);
    onRemoveComplete?.(key);
  }, [onRemoveComplete]);

  // Calculate stagger delays for batch entries
  const getStaggerDelay = useCallback((key: string, batchWindow = 100): number => {
    const appearedAt = seenKeys.current.get(key);
    if (!appearedAt) return 0;
    
    const now = Date.now();
    const age = now - appearedAt;
    
    // Only stagger items that appeared very recently (within batch window)
    if (age > batchWindow) return 0;
    
    // Find position among items that appeared in same batch
    const batchItems = Array.from(seenKeys.current.entries())
      .filter(([, time]) => now - time < batchWindow)
      .sort((a, b) => a[1] - b[1]);
    
    const index = batchItems.findIndex(([k]) => k === key);
    return index * 50; // 50ms stagger between items
  }, []);

  return {
    animatedItems,
    handleExitComplete,
    getStaggerDelay,
  };
}
```

---

## 3. CSS Keyframe Definitions

```css
/* apps/admin/src/styles/animations.css */

/* =============================================================================
   TILE ANIMATIONS
   ============================================================================= */

/* Base animated tile setup */
.animated-tile {
  will-change: transform, opacity;
}

/* Enter animation - initial state */
.tile-enter {
  opacity: 0;
  transform: scale(0.92);
}

/* Enter animation - active/final state */
.tile-enter-active {
  opacity: 1;
  transform: scale(1);
  transition: 
    opacity 280ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 280ms cubic-bezier(0.34, 1.56, 0.64, 1);
  transition-delay: var(--stagger-delay, 0ms);
}

/* Exit animation - starting state */
.tile-exit {
  opacity: 1;
  transform: scale(1);
}

/* Exit animation - final state */
.tile-exit-active {
  opacity: 0;
  transform: scale(0.85);
  transition: 
    opacity 200ms ease-out,
    transform 200ms cubic-bezier(0.4, 0, 1, 1);
  pointer-events: none;
}

/* =============================================================================
   SKELETON LOADING ANIMATIONS
   ============================================================================= */

.skeleton-tile {
  background: linear-gradient(
    90deg,
    var(--color-bg-tertiary) 0%,
    var(--color-bg-secondary) 50%,
    var(--color-bg-tertiary) 100%
  );
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s ease-in-out infinite;
  border-radius: 4px;
}

@keyframes skeleton-shimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}

/* Skeleton fade out when content loads */
.skeleton-tile-loaded {
  animation: skeleton-fade-out 300ms ease-out forwards;
}

@keyframes skeleton-fade-out {
  0% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

/* =============================================================================
   UPLOAD TRANSITION ANIMATIONS
   ============================================================================= */

/* Pending → Complete transition */
.pending-to-complete {
  animation: pending-complete-morph 400ms cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes pending-complete-morph {
  0% {
    filter: grayscale(0.3) brightness(0.9);
    transform: scale(0.98);
  }
  50% {
    filter: grayscale(0) brightness(1.05);
    transform: scale(1.02);
  }
  100% {
    filter: grayscale(0) brightness(1);
    transform: scale(1);
  }
}

/* Upload complete flash effect */
.upload-complete-flash {
  position: relative;
}

.upload-complete-flash::after {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(circle, rgba(59, 130, 246, 0.4) 0%, transparent 70%);
  animation: flash-fade 600ms ease-out forwards;
  pointer-events: none;
  border-radius: inherit;
}

@keyframes flash-fade {
  0% {
    opacity: 1;
    transform: scale(1);
  }
  100% {
    opacity: 0;
    transform: scale(1.2);
  }
}

/* =============================================================================
   LAYOUT SHIFT ANIMATIONS
   ============================================================================= */

/* Smooth layout transitions for grid reorganization */
.photo-grid-row {
  transition: transform 200ms ease-out;
}

/* When items shift position due to deletions/reordering */
.layout-shift {
  transition: 
    transform 250ms cubic-bezier(0.25, 0.1, 0.25, 1),
    left 250ms cubic-bezier(0.25, 0.1, 0.25, 1),
    top 250ms cubic-bezier(0.25, 0.1, 0.25, 1);
}

/* =============================================================================
   PROGRESSIVE LOAD ANIMATIONS
   ============================================================================= */

/* Staggered reveal for initial load */
.reveal-stagger {
  opacity: 0;
  transform: translateY(8px);
  animation: reveal-up 300ms ease-out forwards;
  animation-delay: var(--reveal-delay, 0ms);
}

@keyframes reveal-up {
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Progressive image load (blur to sharp) */
.image-progressive-load {
  filter: blur(8px);
  transform: scale(1.02);
  transition: 
    filter 400ms ease-out,
    transform 400ms ease-out;
}

.image-progressive-load.loaded {
  filter: blur(0);
  transform: scale(1);
}

/* =============================================================================
   REDUCED MOTION SUPPORT
   ============================================================================= */

@media (prefers-reduced-motion: reduce) {
  .animated-tile,
  .skeleton-tile,
  .pending-to-complete,
  .reveal-stagger,
  .layout-shift {
    animation: none !important;
    transition: opacity 100ms linear !important;
    transform: none !important;
  }
  
  .tile-enter {
    opacity: 0;
    transform: none;
  }
  
  .tile-enter-active {
    opacity: 1;
    transform: none;
    transition: opacity 100ms linear;
  }
  
  .tile-exit-active {
    opacity: 0;
    transform: none;
    transition: opacity 100ms linear;
  }
}
```

---

## 4. Integration with TanStack Virtual

### 4.1 The Virtualization-Animation Challenge

TanStack Virtual unmounts items when they scroll out of the viewport. This creates challenges:

1. **Exit animations** - Items are unmounted before they can animate out
2. **Enter animations** - Items re-entering the viewport shouldn't re-animate
3. **Layout shifts** - Virtualizer doesn't know about animated height changes

### 4.2 Solution: The "Phantom Entry" Pattern

```tsx
// Integration example for EnhancedMosaicPhotoGrid.tsx

import { useAnimatedItems } from '../../hooks/useAnimatedItems';
import { AnimatedTile } from './AnimatedTile';

export function EnhancedMosaicPhotoGrid({ albumId, ... }: Props) {
  const { photos, ... } = usePhotos(albumId);
  
  // Track animation state for all photos
  const {
    animatedItems,
    handleExitComplete,
    getStaggerDelay,
  } = useAnimatedItems(displayPhotos, {
    getKey: (photo) => photo.id,
    onRemoveComplete: (key) => {
      // Clean up any resources for removed photo
      releasePhoto(key);
    },
  });

  // Filter to only items that should be rendered
  // (includes exiting items that are animating out)
  const renderableItems = useMemo(() => 
    animatedItems.filter(a => !a.isExiting || /* is in viewport */),
    [animatedItems]
  );

  // ... virtualizer setup ...

  return (
    <div ref={parentRef} className="photo-grid-container">
      <div style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <div key={virtualRow.key} /* ... */>
            {rowItems.map((animatedItem) => (
              <AnimatedTile
                key={animatedItem.key}
                itemKey={animatedItem.key}
                appearedAt={animatedItem.appearedAt}
                isExiting={animatedItem.isExiting}
                onExitComplete={() => handleExitComplete(animatedItem.key)}
                staggerDelay={getStaggerDelay(animatedItem.key)}
              >
                {animatedItem.isExiting ? (
                  // Render a static version during exit
                  <PhotoThumbnailStatic photo={animatedItem.item} />
                ) : (
                  <PhotoThumbnail photo={animatedItem.item} ... />
                )}
              </AnimatedTile>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
```

### 4.3 Handling Viewport Re-entry

```tsx
// Track which items have been seen to prevent re-animation
const seenInSession = useRef(new Set<string>());

function AnimatedTile({ itemKey, ... }: AnimatedTileProps) {
  const shouldAnimate = !seenInSession.current.has(itemKey);
  
  useEffect(() => {
    seenInSession.current.add(itemKey);
  }, [itemKey]);

  // If item was already seen, skip enter animation
  const initialPhase = shouldAnimate ? 'entering' : 'entered';
  const [phase, setPhase] = useState(initialPhase);
  
  // ... rest of component
}
```

---

## 5. Key Scenario Implementations

### 5.1 Single Photo Upload Complete

```tsx
// In UploadContext or similar
function handleUploadComplete(assetId: string) {
  // Add a "completedAt" timestamp that AnimatedTile can detect
  updatePhotoMeta(assetId, { 
    completedAt: Date.now(),
    isPending: false 
  });
}

// In AnimatedTile or PhotoThumbnail
function PhotoThumbnail({ photo, ... }) {
  const [showFlash, setShowFlash] = useState(false);
  
  // Detect transition from pending → complete
  useEffect(() => {
    if (photo.completedAt && Date.now() - photo.completedAt < 1000) {
      setShowFlash(true);
      const timer = setTimeout(() => setShowFlash(false), 600);
      return () => clearTimeout(timer);
    }
  }, [photo.completedAt]);

  return (
    <div className={`photo-thumbnail ${showFlash ? 'upload-complete-flash' : ''}`}>
      {/* ... */}
    </div>
  );
}
```

### 5.2 Batch Upload Stagger

```tsx
// When multiple uploads complete near-simultaneously
function useBatchStagger(photos: PhotoMeta[]) {
  return useMemo(() => {
    const now = Date.now();
    const recentlyCompleted = photos
      .filter(p => p.completedAt && now - p.completedAt < 500)
      .sort((a, b) => a.completedAt! - b.completedAt!);
    
    const staggerMap = new Map<string, number>();
    recentlyCompleted.forEach((photo, index) => {
      staggerMap.set(photo.id, index * 60); // 60ms between each
    });
    
    return staggerMap;
  }, [photos]);
}
```

### 5.3 Photo Deletion with Gap Fill

```tsx
function handleDeletePhoto(photoId: string) {
  // 1. Mark as exiting (triggers CSS exit animation)
  setExitingIds(prev => new Set([...prev, photoId]));
  
  // 2. After animation, actually remove
  setTimeout(async () => {
    await deletePhotoFromServer(photoId);
    refetchPhotos();
    setExitingIds(prev => {
      const next = new Set(prev);
      next.delete(photoId);
      return next;
    });
  }, 300); // Match CSS exit duration
}
```

### 5.4 Full List Refresh (Preserve Existing)

```tsx
function useSmartRefetch<T>(
  fetchFn: () => Promise<T[]>,
  getKey: (item: T) => string
) {
  const [items, setItems] = useState<T[]>([]);
  const seenKeys = useRef(new Set<string>());

  const refetch = useCallback(async () => {
    const newItems = await fetchFn();
    
    // Mark new items for animation
    const newKeys = new Set(newItems.map(getKey));
    const freshKeys = new Set<string>();
    
    for (const key of newKeys) {
      if (!seenKeys.current.has(key)) {
        freshKeys.add(key);
        seenKeys.current.add(key);
      }
    }
    
    // Use startTransition for non-blocking update
    startTransition(() => {
      setItems(newItems);
    });
    
    return freshKeys; // Return set of IDs that should animate
  }, [fetchFn, getKey]);

  return { items, refetch };
}
```

### 5.5 Initial Load with Skeleton

```tsx
function PhotoGridSkeleton({ count = 12, columns = 4 }) {
  return (
    <div className="photo-grid-skeleton">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="skeleton-tile"
          style={{
            '--reveal-delay': `${(i % columns) * 50 + Math.floor(i / columns) * 100}ms`
          } as React.CSSProperties}
        />
      ))}
    </div>
  );
}

// In main grid
function PhotoGrid({ albumId }) {
  const { photos, isLoading } = usePhotos(albumId);
  const [showContent, setShowContent] = useState(false);

  useEffect(() => {
    if (!isLoading && photos.length > 0) {
      // Slight delay to let skeleton settle before crossfade
      const timer = setTimeout(() => setShowContent(true), 50);
      return () => clearTimeout(timer);
    }
  }, [isLoading, photos.length]);

  if (isLoading) {
    return <PhotoGridSkeleton />;
  }

  return (
    <div className={showContent ? 'grid-content-visible' : 'grid-content-hidden'}>
      {/* Actual grid */}
    </div>
  );
}
```

---

## 6. Performance Considerations

### 6.1 GPU-Accelerated Properties Only

```css
/* ✅ GOOD - Uses GPU compositing */
.tile-enter-active {
  transform: scale(1);
  opacity: 1;
}

/* ❌ BAD - Triggers layout/paint */
.tile-enter-active {
  width: 100%;        /* Triggers layout */
  height: auto;       /* Triggers layout */
  box-shadow: ...;    /* Triggers paint */
}
```

### 6.2 will-change Management

```tsx
// Only apply will-change during active animations
function AnimatedTile({ isAnimating, children }) {
  return (
    <div 
      className="animated-tile"
      style={{ willChange: isAnimating ? 'transform, opacity' : 'auto' }}
    >
      {children}
    </div>
  );
}
```

### 6.3 Animation Batching with RAF

```tsx
// Batch multiple animation state changes into single frame
function useBatchedAnimations() {
  const pendingUpdates = useRef<Map<string, AnimationPhase>>(new Map());
  const rafId = useRef<number>();
  const [phases, setPhases] = useState<Map<string, AnimationPhase>>(new Map());

  const scheduleUpdate = useCallback((key: string, phase: AnimationPhase) => {
    pendingUpdates.current.set(key, phase);
    
    if (!rafId.current) {
      rafId.current = requestAnimationFrame(() => {
        setPhases(new Map(pendingUpdates.current));
        pendingUpdates.current.clear();
        rafId.current = undefined;
      });
    }
  }, []);

  return { phases, scheduleUpdate };
}
```

### 6.4 Intersection Observer for Lazy Animation

```tsx
// Only animate items that are visible
function useVisibleItems(containerRef: RefObject<HTMLElement>) {
  const [visibleIds, setVisibleIds] = useState(new Set<string>());

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        setVisibleIds(prev => {
          const next = new Set(prev);
          for (const entry of entries) {
            const id = entry.target.getAttribute('data-id');
            if (id) {
              if (entry.isIntersecting) {
                next.add(id);
              } else {
                next.delete(id);
              }
            }
          }
          return next;
        });
      },
      { rootMargin: '100px' }
    );

    // Observe items...
    return () => observer.disconnect();
  }, []);

  return visibleIds;
}
```

### 6.5 Debounced Layout Recalculation

```tsx
// Avoid layout thrashing during rapid updates
const debouncedRecalcLayout = useMemo(
  () => debounce(() => {
    startTransition(() => {
      setLayoutVersion(v => v + 1);
    });
  }, 100),
  []
);
```

---

## 7. Integration Checklist

### Files to Create

- [x] `apps/admin/src/styles/animations.css` - CSS keyframes and classes
- [x] `apps/admin/src/components/Gallery/AnimatedTile.tsx` - Animation wrapper
- [x] `apps/admin/src/hooks/useAnimatedItems.ts` - Animation state tracking
- [x] `apps/admin/src/components/Gallery/PhotoGridSkeleton.tsx` - Loading skeleton

### Files to Modify

- [x] `apps/admin/src/components/Gallery/EnhancedMosaicPhotoGrid.tsx` - Add animation wrappers
- [ ] `apps/admin/src/components/Gallery/SquarePhotoGrid.tsx` - Add animation wrappers
- [ ] `apps/admin/src/components/Gallery/PhotoThumbnail.tsx` - Add upload complete detection
- [ ] `apps/admin/src/components/Gallery/PendingPhotoThumbnail.tsx` - Add pending→complete transition
- [x] `apps/admin/src/styles/globals.css` - Import animations.css

### Testing Requirements

- [x] Unit tests for `useAnimatedItems` hook
- [ ] Visual regression tests for enter/exit animations
- [ ] Performance benchmark: 1000 items at 60fps
- [x] Reduced motion preference respected
- [ ] Memory leak test: items properly cleaned up after exit

---

## 8. Alternatives Considered

### 8.1 View Transitions API

**Pros:** Native browser support, automatic layout animations  
**Cons:** Limited browser support (no Firefox), complex with virtualization  
**Decision:** Monitor for future adoption when support improves

### 8.2 FLIP Animation Pattern

**Pros:** Smooth layout animations without expensive recalculations  
**Cons:** Complex to implement with virtualization, requires position tracking  
**Decision:** Not needed for current use case; CSS transitions sufficient

### 8.3 Framer Motion with Custom Virtualization

**Pros:** Rich animation primitives, great DX  
**Cons:** Bundle size, AnimatePresence conflicts, performance overhead  
**Decision:** Rejected due to virtualization incompatibility

---

## 9. Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Frame rate | 60fps sustained | Chrome DevTools Performance |
| Animation jank | < 5ms per frame | Long Task detection |
| Bundle size impact | < 2KB | Bundle analyzer |
| First contentful paint | < 200ms delta | Lighthouse |
| Reduced motion compliance | 100% | Manual testing |

---

## 10. Implementation Priority

1. **Phase 1 (MVP):** CSS animations + AnimatedTile wrapper + enter animations
2. **Phase 2:** Exit animations with phantom entries
3. **Phase 3:** Stagger effects for batch operations  
4. **Phase 4:** Skeleton loading states
5. **Phase 5:** Layout shift animations
