# SPEC: Loading State Strategy

> **Status:** Draft  
> **Created:** 2026-01-02  
> **Purpose:** Eliminate UI blinking by implementing stale-while-revalidate loading patterns

---

## Problem Statement

The current binary loading state pattern (`isLoading: true/false`) causes visual jarring when:

1. **Sync-complete triggers refetch** → Grid disappears → Spinner shows → Grid reappears
2. **Search query changes** → Content hidden during fetch
3. **Background refresh** → User loses context of what they were viewing
4. **Error recovery** → Existing content lost even for transient errors

### Current Anti-Pattern

```typescript
// usePhotos.ts - Binary loading causes "blink"
const [isLoading, setIsLoading] = useState(true);

const refetch = async () => {
  setIsLoading(true);  // 💥 BLINK: Grid immediately replaced with spinner
  const result = await fetchPhotos();
  setPhotos(result);
  setIsLoading(false);
};

// Component - All-or-nothing rendering
if (isLoading) {
  return <LoadingSpinner />;  // 💥 Grid gone!
}
return <PhotoGrid photos={photos} />;
```

---

## Solution: Fetch Status State Machine

Replace binary `isLoading` with a discriminated union that tracks **fetch status** separately from **data availability**.

### Core Principle: Stale-While-Revalidate

> **Show existing content during background fetches. Only show loading states when there's nothing to show.**

---

## 1. TypeScript Interfaces

### FetchStatus Discriminated Union

```typescript
/**
 * Fetch status discriminated union - tracks the lifecycle of data fetching.
 * Data availability is tracked separately from fetch status.
 */
export type FetchStatus =
  | { status: 'idle' }
  | { status: 'loading'; reason: FetchReason }
  | { status: 'success'; timestamp: number }
  | { status: 'error'; error: Error; retryCount: number };

/**
 * Why are we fetching? Determines UI treatment.
 */
export type FetchReason =
  | 'initial'           // First load - no data exists yet
  | 'refresh'           // Background refresh - show stale data
  | 'search'            // Search query changed - may show stale results
  | 'dependency-change' // albumId changed - requires full reload
  | 'retry'             // Retrying after error
  | 'optimistic-sync';  // Following optimistic update confirmation

/**
 * Derived UI state for components - what should the UI show?
 */
export type LoadingUIState =
  | 'empty-loading'      // No data + loading → Show skeleton
  | 'content'            // Has data, not loading → Normal render
  | 'content-refreshing' // Has data + background loading → Show content + subtle indicator
  | 'content-stale'      // Has data + error (might be stale) → Show content + error indicator
  | 'error-empty';       // No data + error → Show error state

/**
 * Complete query result shape
 */
export interface QueryResult<T> {
  /** The data (may be stale during refresh) */
  data: T | null;
  /** Current fetch status */
  fetchStatus: FetchStatus;
  /** Derived UI state for easy conditional rendering */
  uiState: LoadingUIState;
  /** Trigger a refresh */
  refetch: (reason?: FetchReason) => void;
  /** Clear error and retry */
  retry: () => void;
  /** Is data fresh (fetched within threshold)? */
  isFresh: boolean;
  /** Timestamp of last successful fetch */
  dataUpdatedAt: number | null;
}
```

### UsePhotosResult Specific Type

```typescript
export interface UsePhotosResult extends QueryResult<PhotoMeta[]> {
  /** Convenience accessor - empty array if null */
  photos: PhotoMeta[];
  /** Legacy compatibility - true only for initial load */
  isLoading: boolean;
  /** Error object if in error state */
  error: Error | null;
}
```

---

## 2. State Machine Definition

```
┌─────────┐
│  IDLE   │ ── mount/refetch(initial) ──→ LOADING(initial)
└─────────┘                                    │
     ↑                                         │
     │                                         ▼
     │                               ┌──────────────────┐
     │                               │ LOADING(initial) │
     │                               └────────┬─────────┘
     │                                        │
     │                          success/error │
     │                                        ▼
     │         ┌─────────────────────────────────────────────────────┐
     │         │                                                     │
     │         ▼                                                     ▼
     │  ┌─────────────┐                                       ┌─────────────┐
     │  │   SUCCESS   │ ←──────── refetch(refresh) ─────────→ │   LOADING   │
     │  │  (has data) │                                       │  (refresh)  │
     │  └──────┬──────┘                                       └──────┬──────┘
     │         │                                                     │
     │         │ refetch(dependency-change)                          │
     │         ▼                                                     │
     │  ┌─────────────┐      success                                 │
     └──│   LOADING   │ ←────────────────────────────────────────────┘
        │(dep-change) │
        └──────┬──────┘
               │ error
               ▼
        ┌─────────────┐
        │    ERROR    │ ── retry ──→ LOADING(retry)
        │  (no data)  │
        └─────────────┘
```

### State Transitions Table

| Current State | Event | Next State | Data Behavior |
|---------------|-------|------------|---------------|
| `idle` | mount/fetch | `loading(initial)` | `null` |
| `loading(initial)` | success | `success` | Set new data |
| `loading(initial)` | error | `error` | Keep `null` |
| `success` | refetch(refresh) | `loading(refresh)` | **Keep existing** |
| `success` | refetch(search) | `loading(search)` | **Keep existing** |
| `success` | refetch(dep-change) | `loading(initial)` | Clear to `null` |
| `loading(refresh)` | success | `success` | Replace data |
| `loading(refresh)` | error | `error` | **Keep existing** |
| `error` | retry | `loading(retry)` | Keep existing (if any) |
| `loading(retry)` | success | `success` | Set new data |
| `loading(retry)` | error | `error` | Increment retryCount |

### Key Insight: Data Independence

**Fetch status and data are independent concerns:**

- `loading(refresh)` + has data = Show content with refresh indicator
- `error` + has data = Show content with error toast (recoverable)
- `error` + no data = Show error state (unrecoverable without retry)

---

## 3. Deriving UI State

```typescript
/**
 * Derive the UI state from fetch status and data availability.
 * This is the single source of truth for what the UI should render.
 */
function deriveUIState<T>(
  fetchStatus: FetchStatus,
  data: T | null
): LoadingUIState {
  const hasData = data !== null && (Array.isArray(data) ? data.length > 0 : true);

  switch (fetchStatus.status) {
    case 'idle':
      return hasData ? 'content' : 'empty-loading';

    case 'loading':
      if (fetchStatus.reason === 'initial' || fetchStatus.reason === 'dependency-change') {
        // Full reload scenarios - if no data, show skeleton
        return hasData ? 'content-refreshing' : 'empty-loading';
      }
      // Background refresh - always show existing content
      return hasData ? 'content-refreshing' : 'empty-loading';

    case 'success':
      return hasData ? 'content' : 'content'; // Even empty result is "content"

    case 'error':
      return hasData ? 'content-stale' : 'error-empty';
  }
}
```

---

## 4. Hook Implementation

### useFetchState Primitive

```typescript
import { useCallback, useRef, useState } from 'react';

interface UseFetchStateOptions {
  /** Time in ms before data is considered stale */
  staleTime?: number;
  /** Max automatic retry attempts */
  maxRetries?: number;
}

interface UseFetchState<T> {
  data: T | null;
  setData: (data: T | null) => void;
  fetchStatus: FetchStatus;
  uiState: LoadingUIState;
  startFetch: (reason: FetchReason) => void;
  setSuccess: () => void;
  setError: (error: Error) => void;
  isFresh: boolean;
  dataUpdatedAt: number | null;
}

export function useFetchState<T>(options: UseFetchStateOptions = {}): UseFetchState<T> {
  const { staleTime = 30_000, maxRetries = 3 } = options;

  const [data, setData] = useState<T | null>(null);
  const [fetchStatus, setFetchStatus] = useState<FetchStatus>({ status: 'idle' });
  const [dataUpdatedAt, setDataUpdatedAt] = useState<number | null>(null);
  const retryCountRef = useRef(0);

  const startFetch = useCallback((reason: FetchReason) => {
    // On dependency change, clear data to force skeleton
    if (reason === 'dependency-change') {
      setData(null);
      setDataUpdatedAt(null);
    }
    if (reason === 'retry') {
      retryCountRef.current += 1;
    } else {
      retryCountRef.current = 0;
    }
    setFetchStatus({ status: 'loading', reason });
  }, []);

  const setSuccess = useCallback(() => {
    const now = Date.now();
    setDataUpdatedAt(now);
    setFetchStatus({ status: 'success', timestamp: now });
  }, []);

  const setError = useCallback((error: Error) => {
    setFetchStatus({
      status: 'error',
      error,
      retryCount: retryCountRef.current,
    });
  }, []);

  const isFresh = dataUpdatedAt !== null && Date.now() - dataUpdatedAt < staleTime;
  const uiState = deriveUIState(fetchStatus, data);

  return {
    data,
    setData,
    fetchStatus,
    uiState,
    startFetch,
    setSuccess,
    setError,
    isFresh,
    dataUpdatedAt,
  };
}
```

### Refactored usePhotos Hook

```typescript
import { useCallback, useEffect, useRef } from 'react';
import { getDbClient } from '../lib/db-client';
import type { PhotoMeta } from '../workers/types';
import { useFetchState } from './useFetchState';
import type { FetchReason, UsePhotosResult } from './types';

export function usePhotos(albumId: string, searchQuery?: string): UsePhotosResult {
  const {
    data,
    setData,
    fetchStatus,
    uiState,
    startFetch,
    setSuccess,
    setError,
    isFresh,
    dataUpdatedAt,
  } = useFetchState<PhotoMeta[]>({ staleTime: 30_000 });

  const prevAlbumIdRef = useRef(albumId);
  const prevSearchRef = useRef(searchQuery);

  // Determine fetch reason based on what changed
  const determineFetchReason = useCallback((): FetchReason => {
    if (data === null) return 'initial';
    if (prevAlbumIdRef.current !== albumId) return 'dependency-change';
    if (prevSearchRef.current !== searchQuery) return 'search';
    return 'refresh';
  }, [data, albumId, searchQuery]);

  const fetchPhotos = useCallback(async (reason: FetchReason) => {
    startFetch(reason);
    try {
      const db = await getDbClient();
      let result: PhotoMeta[];
      
      if (searchQuery?.trim()) {
        result = await db.searchPhotos(albumId, searchQuery.trim());
      } else {
        result = await db.getPhotos(albumId, 1000, 0);
      }

      setData(result);
      setSuccess();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [albumId, searchQuery, startFetch, setData, setSuccess, setError]);

  // Initial fetch on mount
  useEffect(() => {
    const reason = determineFetchReason();
    prevAlbumIdRef.current = albumId;
    prevSearchRef.current = searchQuery;
    void fetchPhotos(reason);
  }, [albumId, searchQuery]); // Intentionally excluding fetchPhotos to control when it runs

  // Manual refetch function
  const refetch = useCallback((reason: FetchReason = 'refresh') => {
    void fetchPhotos(reason);
  }, [fetchPhotos]);

  // Retry function for error recovery
  const retry = useCallback(() => {
    void fetchPhotos('retry');
  }, [fetchPhotos]);

  // Legacy compatibility
  const isLoading = fetchStatus.status === 'loading' && 
    (fetchStatus.reason === 'initial' || fetchStatus.reason === 'dependency-change');
  
  const error = fetchStatus.status === 'error' ? fetchStatus.error : null;

  return {
    photos: data ?? [],
    data,
    fetchStatus,
    uiState,
    refetch,
    retry,
    isFresh,
    dataUpdatedAt,
    // Legacy compatibility
    isLoading,
    error,
  };
}
```

---

## 5. Component Rendering Patterns

### Pattern 1: Switch on UI State (Recommended)

```tsx
function PhotoGridContainer({ albumId }: { albumId: string }) {
  const { photos, uiState, refetch, retry, fetchStatus } = usePhotos(albumId);

  switch (uiState) {
    case 'empty-loading':
      return <PhotoGridSkeleton count={12} columns={4} />;

    case 'error-empty':
      return (
        <ErrorState
          message={fetchStatus.status === 'error' ? fetchStatus.error.message : 'Unknown error'}
          onRetry={retry}
        />
      );

    case 'content':
    case 'content-refreshing':
    case 'content-stale':
      return (
        <>
          {uiState === 'content-refreshing' && <RefreshIndicator />}
          {uiState === 'content-stale' && <StaleDataBanner onRefresh={() => refetch('refresh')} />}
          <PhotoGrid photos={photos} />
        </>
      );
  }
}
```

### Pattern 2: Layered Rendering (For Complex Grids)

```tsx
function EnhancedPhotoGrid({ albumId, searchQuery }: Props) {
  const { photos, uiState, fetchStatus } = usePhotos(albumId, searchQuery);

  return (
    <div className="photo-grid-container" data-ui-state={uiState}>
      {/* Always render grid if we have photos */}
      {photos.length > 0 && <VirtualizedGrid photos={photos} />}
      
      {/* Skeleton only for initial/empty load */}
      {uiState === 'empty-loading' && <PhotoGridSkeleton />}
      
      {/* Subtle refresh indicator - doesn't replace content */}
      {uiState === 'content-refreshing' && (
        <div className="refresh-indicator">
          <Spinner size="small" />
        </div>
      )}
      
      {/* Error overlay for stale data */}
      {uiState === 'content-stale' && (
        <StaleDataToast 
          message="Unable to refresh. Showing cached data."
          onDismiss={() => {}}
        />
      )}
      
      {/* Full error state only when truly empty */}
      {uiState === 'error-empty' && (
        <ErrorState 
          error={fetchStatus.status === 'error' ? fetchStatus.error : undefined}
        />
      )}
    </div>
  );
}
```

### Pattern 3: Composable Status Components

```tsx
// Reusable status overlay component
function LoadingOverlay({ uiState, fetchStatus, onRetry }: LoadingOverlayProps) {
  if (uiState === 'content' || uiState === 'empty-loading') {
    return null;
  }

  return (
    <div className={`loading-overlay loading-overlay--${uiState}`}>
      {uiState === 'content-refreshing' && (
        <div className="refresh-badge">
          <Spinner size="xs" />
          <span>Refreshing...</span>
        </div>
      )}
      {uiState === 'content-stale' && (
        <button className="retry-badge" onClick={onRetry}>
          <AlertIcon />
          <span>Tap to retry</span>
        </button>
      )}
    </div>
  );
}

// Usage
function PhotoGrid({ albumId }: Props) {
  const query = usePhotos(albumId);

  return (
    <div className="photo-grid-wrapper">
      <LoadingOverlay {...query} onRetry={query.retry} />
      
      {query.uiState === 'empty-loading' ? (
        <PhotoGridSkeleton />
      ) : query.uiState === 'error-empty' ? (
        <ErrorState error={query.error} />
      ) : (
        <VirtualizedGrid photos={query.photos} />
      )}
    </div>
  );
}
```

---

## 6. Integration with Sync Engine

The sync engine's `sync-complete` event should trigger a **background refresh**, not a full reload:

```typescript
// In component
useEffect(() => {
  const handleSyncComplete = (event: Event) => {
    const detail = (event as CustomEvent<SyncEventDetail>).detail;
    if (detail.albumId === albumId) {
      // ✅ Background refresh - keeps existing content visible
      refetch('refresh');
    }
  };
  syncEngine.addEventListener('sync-complete', handleSyncComplete);
  return () => syncEngine.removeEventListener('sync-complete', handleSyncComplete);
}, [albumId, refetch]);
```

---

## 7. CSS for Refresh Indicators

```css
/* Subtle refresh indicator - top-right corner */
.refresh-indicator {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 4px 8px;
  background: var(--surface-elevated);
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  z-index: 10;
  animation: fade-in 0.2s ease-out;
}

/* Stale data banner */
.stale-data-banner {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 8px 16px;
  background: var(--warning-surface);
  color: var(--warning-text);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
}

/* Reduced motion support */
@media (prefers-reduced-motion: reduce) {
  .refresh-indicator {
    animation: none;
  }
}
```

---

## 8. Optimistic Updates Pattern

For operations like delete/move that should feel instant:

```typescript
interface OptimisticUpdate<T> {
  /** Optimistically update the data */
  optimistic: (updater: (current: T) => T) => void;
  /** Rollback on error */
  rollback: () => void;
  /** Confirm the optimistic update */
  confirm: () => void;
}

function useOptimisticPhotos(albumId: string): UsePhotosResult & OptimisticUpdate<PhotoMeta[]> {
  const query = usePhotos(albumId);
  const previousDataRef = useRef<PhotoMeta[] | null>(null);

  const optimistic = useCallback((updater: (current: PhotoMeta[]) => PhotoMeta[]) => {
    previousDataRef.current = query.data;
    const newData = updater(query.photos);
    // Directly update local state (bypassing fetch)
    query.setData(newData);
  }, [query]);

  const rollback = useCallback(() => {
    if (previousDataRef.current !== null) {
      query.setData(previousDataRef.current);
      previousDataRef.current = null;
    }
  }, [query]);

  const confirm = useCallback(() => {
    previousDataRef.current = null;
    query.refetch('optimistic-sync');
  }, [query]);

  return { ...query, optimistic, rollback, confirm };
}

// Usage in delete handler
const handleDeletePhoto = async (photoId: string) => {
  // Instant visual feedback
  photos.optimistic(current => current.filter(p => p.id !== photoId));
  
  try {
    await api.deletePhoto(photoId);
    photos.confirm();
  } catch (error) {
    photos.rollback();
    toast.error('Failed to delete photo');
  }
};
```

---

## 9. Migration Path

### Phase 1: Add New Types (Non-Breaking)
1. Create `types/fetch-status.ts` with new interfaces
2. Create `useFetchState.ts` primitive hook

### Phase 2: Refactor usePhotos (Backward Compatible)
1. Refactor `usePhotos` to use `useFetchState` internally
2. Keep legacy `isLoading` and `error` in return type
3. Add new `uiState` and `fetchStatus` fields

### Phase 3: Update Components Incrementally
1. Update `EnhancedMosaicPhotoGrid` to use `uiState`
2. Update other grid components
3. Add refresh indicators

### Phase 4: Remove Legacy Fields
1. Remove `isLoading` boolean (after all components updated)
2. Use `fetchStatus.status === 'loading'` with reason check if needed

---

## 10. Testing Strategy

### Unit Tests for State Derivation

```typescript
describe('deriveUIState', () => {
  it('returns empty-loading when loading initial with no data', () => {
    expect(deriveUIState({ status: 'loading', reason: 'initial' }, null))
      .toBe('empty-loading');
  });

  it('returns content-refreshing when loading refresh with data', () => {
    expect(deriveUIState({ status: 'loading', reason: 'refresh' }, [photo1]))
      .toBe('content-refreshing');
  });

  it('returns content-stale when error with existing data', () => {
    expect(deriveUIState({ status: 'error', error: new Error(), retryCount: 0 }, [photo1]))
      .toBe('content-stale');
  });

  it('returns error-empty when error with no data', () => {
    expect(deriveUIState({ status: 'error', error: new Error(), retryCount: 0 }, null))
      .toBe('error-empty');
  });
});
```

### Integration Test for No-Blink Behavior

```typescript
describe('usePhotos stale-while-revalidate', () => {
  it('keeps existing photos visible during background refresh', async () => {
    const { result } = renderHook(() => usePhotos('album-1'));
    
    // Initial load
    await waitFor(() => expect(result.current.photos).toHaveLength(3));
    expect(result.current.uiState).toBe('content');

    // Trigger refresh
    act(() => result.current.refetch('refresh'));
    
    // Photos should still be visible during refresh
    expect(result.current.photos).toHaveLength(3);
    expect(result.current.uiState).toBe('content-refreshing');
    
    // After refresh completes
    await waitFor(() => expect(result.current.uiState).toBe('content'));
  });
});
```

---

## 11. Summary

| Before | After |
|--------|-------|
| `isLoading: boolean` | `fetchStatus: FetchStatus` (discriminated union) |
| `if (isLoading) return <Spinner>` | `switch (uiState)` with 5 states |
| Data cleared on refetch | Data preserved during background refresh |
| Error loses existing data | Error shows "stale" badge, keeps data |
| No optimistic updates | `optimistic()` / `rollback()` pattern |

**Key Files to Create/Modify:**
1. `src/hooks/types/fetch-status.ts` - New type definitions
2. `src/hooks/useFetchState.ts` - New primitive hook
3. `src/hooks/usePhotos.ts` - Refactor with backward compat
4. `src/components/Gallery/EnhancedMosaicPhotoGrid.tsx` - Update rendering
5. `src/styles/loading-states.css` - New CSS for indicators

---

## Approval Checklist

- [ ] Types reviewed for completeness
- [ ] State machine covers all transitions
- [ ] Backward compatibility maintained
- [ ] CSS respects reduced-motion
- [ ] Testing strategy defined
