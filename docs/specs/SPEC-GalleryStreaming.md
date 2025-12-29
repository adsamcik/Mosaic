# SPEC: Gallery Streaming Redesign

> **Status:** DRAFT - Awaiting Approval  
> **Author:** GitHub Copilot  
> **Date:** 2024-12-29

## Executive Summary

Redesign the photo gallery to use a streaming/progressive loading architecture. The current implementation loads all photos at mount, causing:

1. **Slow initial load** - Entire photo list fetched before display
2. **Memory pressure** - All PhotoMeta objects held in memory
3. **No visual feedback during load** - Users see empty state or spinner

The new design implements:

- **Embedded thumbnails first** - Display base64 thumbnails from PhotoMeta instantly
- **Progressive shard loading** - Load full photos in viewport only, on demand
- **Infinite scroll pagination** - Fetch photo metadata in pages (50 at a time)
- **Virtualized rendering** - Continue using TanStack Virtual (already implemented)

## Current Architecture Analysis

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Current: Load All → Render All → Download All Visible Shards            │
└─────────────────────────────────────────────────────────────────────────┘

1. Gallery mounts
2. usePhotos(albumId) fetches ALL photos from local SQLite (up to 1000)
3. PhotoGrid renders virtualized rows
4. Each visible PhotoThumbnail triggers loadPhoto()
5. loadPhoto() downloads shards → decrypts → creates blob URL
```

### Problems

| Issue | Impact | Metric |
|-------|--------|--------|
| Fetch all photos upfront | Memory bloat, slow TTI | 1000 photos = ~400KB metadata |
| No embedded thumbnail usage | Unnecessary shard downloads for grid view | Every photo = 1+ HTTP request |
| Shard downloads per photo | Bandwidth waste | Full photo loaded even for 200px thumbnail |
| No request prioritization | Visible photos may load last | User sees spinners |

## Proposed Architecture

### Phase 1: Use Embedded Thumbnails (Quick Win)

PhotoMeta already contains a `thumbnail` field (base64 JPEG, ~300px) embedded during upload. **The grid should use this first** before loading shards.

```
PhotoThumbnail Render Order:
1. Show embedded base64 thumbnail immediately (if present)
2. Only load shards when: lightbox opens OR user explicitly requests full resolution
```

### Phase 2: Infinite Scroll Pagination

Replace single-fetch with paginated loading:

```typescript
// New: Paginated query
const { 
  photos, 
  isLoading, 
  hasNextPage, 
  fetchNextPage 
} = usePhotosInfinite(albumId, {
  pageSize: 50,
  searchQuery
});
```

### Phase 3: Smart Preloading

Preload based on viewport position and scroll direction:

```
Viewport: photos 20-40 visible
Preload ahead: photos 41-50 (metadata only)
Full resolution preload: none (lightbox only)
```

## Data Flow (Redesigned)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ New: Stream Metadata → Show Thumbnails → Lazy Load Shards              │
└─────────────────────────────────────────────────────────────────────────┘

1. Gallery mounts
2. usePhotosInfinite fetches first page (50 photos) from SQLite
3. PhotoGrid renders virtualized rows with embedded thumbnails
4. Scroll triggers: intersection observer fires → fetch next page
5. Lightbox opens: NOW load shards for full resolution
```

## ZK Invariants

✅ **All encryption/decryption remains client-side** - No changes to crypto flow  
✅ **Embedded thumbnails are encrypted at rest** - Stored in local SQLite, derived from client-encrypted manifests  
✅ **Shard downloads still require epoch key** - Full photo loading unchanged  
✅ **Server never sees plaintext** - Pagination happens on encrypted/local data

## Component Changes

### 1. `usePhotosInfinite` Hook (NEW)

```typescript
// File: apps/admin/src/hooks/usePhotosInfinite.ts

interface UsePhotosInfiniteOptions {
  pageSize?: number;
  searchQuery?: string;
}

interface UsePhotosInfiniteResult {
  photos: PhotoMeta[];
  isLoading: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  error: Error | null;
  refetch: () => void;
}

export function usePhotosInfinite(
  albumId: string, 
  options?: UsePhotosInfiniteOptions
): UsePhotosInfiniteResult;
```

### 2. `PhotoThumbnail` Changes

```diff
// File: apps/admin/src/components/Gallery/PhotoThumbnail.tsx

function PhotoThumbnail({ photo, epochReadKey, ... }) {
+ // Phase 1: Use embedded thumbnail if available
+ const embeddedThumbnailUrl = useMemo(() => {
+   if (!photo.thumbnail) return null;
+   return `data:image/jpeg;base64,${photo.thumbnail}`;
+ }, [photo.thumbnail]);
+ 
+ // Only load full shards if: no thumbnail, or lightbox requested
+ const shouldLoadShards = !photo.thumbnail || loadFullResolution;

  useEffect(() => {
-   if (!epochReadKey || !photo.shardIds || photo.shardIds.length === 0) {
+   if (!shouldLoadShards || !epochReadKey || !photo.shardIds?.length) {
      return;
    }
    // ... existing shard loading logic
  }, [photo.id, photo.shardIds, photo.mimeType, epochReadKey, shouldLoadShards]);
  
  // Render embedded thumbnail first, upgrade to full resolution when loaded
  return (
-   <img src={state.result?.blobUrl} ... />
+   <img 
+     src={state.status === 'loaded' ? state.result.blobUrl : embeddedThumbnailUrl} 
+     ... 
+   />
  );
}
```

### 3. `JustifiedPhotoThumbnail` Changes

Same pattern as PhotoThumbnail.

### 4. `PhotoGrid` Changes

```diff
// File: apps/admin/src/components/Gallery/PhotoGrid.tsx

- const { photos, isLoading, error, refetch } = usePhotos(albumId, searchQuery);
+ const { 
+   photos, 
+   isLoading, 
+   isFetchingNextPage,
+   hasNextPage, 
+   fetchNextPage, 
+   error, 
+   refetch 
+ } = usePhotosInfinite(albumId, { searchQuery });

+ // Trigger next page when scrolling near end
+ const loadMoreRef = useRef<HTMLDivElement>(null);
+ useEffect(() => {
+   if (!loadMoreRef.current || !hasNextPage || isFetchingNextPage) return;
+   
+   const observer = new IntersectionObserver(
+     ([entry]) => { if (entry.isIntersecting) fetchNextPage(); },
+     { rootMargin: '200px' }
+   );
+   observer.observe(loadMoreRef.current);
+   return () => observer.disconnect();
+ }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <>
      {/* Existing virtual grid */}
      <div ref={parentRef} className="photo-grid-container">
        ...
      </div>
+     {/* Sentinel for infinite scroll */}
+     <div ref={loadMoreRef} style={{ height: 1 }} />
+     {isFetchingNextPage && <LoadingSpinner />}
    </>
  );
```

### 5. `JustifiedPhotoGrid` Changes

Same infinite scroll pattern.

### 6. Database Client Changes

```diff
// File: apps/admin/src/lib/db-client.ts (or db-worker)

interface DbClient {
- getPhotos(albumId: string, limit: number, offset: number): Promise<PhotoMeta[]>;
+ getPhotos(albumId: string, options: { limit: number; offset: number }): Promise<PhotoMeta[]>;
+ getPhotoCount(albumId: string): Promise<number>;
}
```

## Migration Strategy

### Backward Compatibility

- Photos without embedded thumbnails show loading spinner (current behavior)
- Existing sync flow continues to work
- No database schema changes required

### Rollout

1. **Phase 1**: Use embedded thumbnails (low risk, immediate benefit)
2. **Phase 2**: Add infinite scroll pagination
3. **Phase 3**: Add scroll-direction-aware preloading (optional optimization)

## Verification Plan

### Unit Tests

| Test | File | Description |
|------|------|-------------|
| `usePhotosInfinite.test.ts` | hooks/ | Pagination, loading states, error handling |
| `PhotoThumbnail.test.tsx` | components/ | Embedded thumbnail rendering, fallback behavior |
| `JustifiedPhotoThumbnail.test.tsx` | components/ | Same for justified layout |

### Integration Tests

| Test | Description |
|------|-------------|
| Grid displays embedded thumbnails immediately | No shard downloads for initial render |
| Scroll triggers page fetch | IntersectionObserver fires correctly |
| Lightbox loads full resolution | Shards downloaded only when lightbox opens |

### E2E Tests

| Test | Description |
|------|-------------|
| Large album scroll performance | 500+ photos scroll smoothly |
| Thumbnail visible before shards load | Visual verification |
| Network throttled behavior | Graceful degradation |

## Performance Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Time to first thumbnail | ~2s (shard download) | <100ms (embedded) |
| Initial network requests | N (one per visible photo) | 0 (thumbnails in SQLite) |
| Memory (1000 photos) | ~400KB metadata + blobs | ~20KB (page) + blobs |

## Open Questions

1. **Thumbnail size trade-off**: Current embedded thumbnails are ~300px. Is this sufficient for grid view?
2. **Search behavior**: Should search results also paginate or return all matches?
3. **Justified layout**: The justified grid needs dimensions upfront. Does `thumbWidth`/`thumbHeight` suffice?

## Approval Checklist

- [ ] Architecture approved
- [ ] ZK invariants verified
- [ ] Test plan approved
- [ ] Performance targets agreed

---

**Next Steps**: Please review this specification. If approved, I will proceed with Phase 1 implementation (using embedded thumbnails).
