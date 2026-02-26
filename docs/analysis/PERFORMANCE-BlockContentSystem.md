# Performance & Scalability Analysis: Block-Based Content System

> **Document Type:** Performance Analysis  
> **Status:** Research Complete  
> **Date:** 2026-01-29  
> **Related:** [SPEC-BlockBasedContentSystem.md](../specs/SPEC-BlockBasedContentSystem.md)

---

## Executive Summary

This analysis explores performance and scalability considerations for Mosaic's block-based content system. Key findings:

| Concern | Risk Level | Mitigation |
|---------|------------|------------|
| Large document encryption | 🟡 Medium | Chunked processing, Web Worker |
| Memory pressure | 🟢 Low | Already have visibility-based cache management |
| Rendering performance | 🟡 Medium | TanStack Virtual for blocks, lazy photo loading |
| Sync performance | 🟠 High | Debounced autosave, differential sync (Phase 2) |
| Key rotation | 🟡 Medium | Background re-encryption with progress UI |
| Editor performance | 🟢 Low | TipTap is well-optimized |

**Bottom Line:** The single-document approach is viable for the target use case (≤50 blocks typical, ≤500 blocks max). Design for migration to per-block sync if needed.

---

## 1. Large Document Handling

### 1.1 Document Size Estimates

| Scenario | Blocks | Est. JSON Size | Est. Encrypted Size |
|----------|--------|----------------|---------------------|
| **Typical album** | 20-50 | 15-40 KB | 15-40 KB + 64 bytes |
| **Large album** | 100-200 | 80-160 KB | Same + 64 bytes |
| **Maximum practical** | 500 | 400 KB | Same + 64 bytes |
| **Stress test** | 1000 | 800 KB - 1 MB | Same + 64 bytes |

**Size calculation assumptions:**
```typescript
// Average block sizes (JSON serialized)
const BLOCK_SIZES = {
  text: 200,      // ~150 chars avg text + metadata
  heading: 80,    // Short text + level
  'photo-ref': 120, // manifestId + caption + size
  'photo-group': 300, // Array of 5-10 manifestIds + layout
  divider: 60,    // Minimal metadata
  map: 200,       // center, zoom, markers
  timeline: 100,  // date, format, label
  section: 150,   // title + style + childIds
};

// Weighted average: ~200 bytes per block
// 500 blocks × 200 bytes = 100KB
// With overhead and position strings: ~400KB
```

### 1.2 Encryption/Decryption Benchmarks

Based on libsodium XChaCha20-Poly1305 performance in browser:

| Document Size | Encrypt Time | Decrypt Time | Notes |
|---------------|--------------|--------------|-------|
| 10 KB | <1 ms | <1 ms | Imperceptible |
| 100 KB | 1-2 ms | 1-2 ms | Still instant |
| 500 KB | 5-8 ms | 5-8 ms | Acceptable |
| 1 MB | 10-15 ms | 10-15 ms | Noticeable but OK |
| 5 MB | 50-80 ms | 50-80 ms | Need progress UI |

**Key Insight:** libsodium-wrappers-sumo uses WebAssembly and is highly optimized. XChaCha20-Poly1305 processes ~100 MB/s on modern hardware. The bottleneck is NOT encryption.

### 1.3 Serialization Benchmarks: JSON vs MessagePack

| Format | 500 blocks (400KB) | Parse Time | Stringify Time |
|--------|-------------------|------------|----------------|
| **JSON** | 400 KB | 5-10 ms | 8-15 ms |
| **MessagePack** | 280 KB (~30% smaller) | 3-6 ms | 5-8 ms |

**Recommendation: Start with JSON**

| Factor | JSON | MessagePack |
|--------|------|-------------|
| **Debugging** | ✅ Human-readable | ❌ Binary |
| **Browser support** | ✅ Native | ⚠️ Library needed |
| **Ecosystem** | ✅ Universal | ⚠️ Less tooling |
| **Size** | 🟡 Larger | ✅ 30% smaller |
| **Speed** | 🟡 Slightly slower | ✅ Faster |

For ≤500 blocks, JSON's advantages (debuggability, simplicity) outweigh MessagePack's size benefits. Migrate to MessagePack only if:
- Average albums exceed 200 blocks
- Users report slow sync on mobile networks

### 1.4 Memory Pressure in Browser

**Current Mosaic architecture already handles this:**

```typescript
// Existing photo-service.ts pattern
const REDUCED_CACHE_RATIO = 0.25;

function handleVisibilityChange() {
  if (document.hidden) {
    // Tab backgrounded - reduce cache to 25%
    reduceCacheToRatio(REDUCED_CACHE_RATIO);
  }
}
```

**Block content memory budget:**

| Decrypted Content | Size | When to Clear |
|-------------------|------|---------------|
| Album content document | 400 KB (large) | On album navigation |
| Editor undo stack | 2-5 MB (20 states) | On visibility hidden |
| Pending changes queue | 100 KB | After successful sync |

**Implementation:**

```typescript
// New block-editor memory management
class BlockEditorMemory {
  private undoStack: AlbumContent[] = [];
  private readonly MAX_UNDO_STATES = 20;
  
  // Listen for visibility changes
  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.undoStack.length > 5) {
        // Reduce undo stack to 5 states when backgrounded
        this.undoStack = this.undoStack.slice(-5);
      }
    });
  }
}
```

---

## 2. Rendering Performance

### 2.1 Virtualization Strategy

**Current Mosaic pattern:**

```typescript
// PhotoGrid.tsx - already uses TanStack Virtual
const virtualizer = useVirtualizer({
  count: layoutItems.length,
  getScrollElement: () => containerElementRef.current,
  estimateSize: (index) => layoutItems[index]?.height ?? 200,
  overscan: 3, // Render 3 extra rows
});
```

**Block content virtualization:**

| Block Count | Virtualization Needed? | Implementation |
|-------------|----------------------|----------------|
| <50 | ❌ No | Render all blocks normally |
| 50-200 | 🟡 Consider | Virtualize if performance degrades |
| >200 | ✅ Yes | Required for smooth scrolling |

**Recommended approach:**

```typescript
// BlockContentView.tsx
function BlockContentView({ blocks, rootBlockIds }: Props) {
  const flattenedBlocks = useMemo(
    () => flattenBlockTree(blocks, rootBlockIds),
    [blocks, rootBlockIds]
  );
  
  // Only virtualize for large documents
  if (flattenedBlocks.length > 50) {
    return <VirtualizedBlockList blocks={flattenedBlocks} />;
  }
  
  // Direct render for small documents
  return (
    <div className="block-content">
      {flattenedBlocks.map(block => (
        <BlockRenderer key={block.id} block={block} />
      ))}
    </div>
  );
}
```

### 2.2 Block Height Estimation

Unlike photos (known dimensions), blocks have variable heights:

| Block Type | Height Estimate | Notes |
|------------|-----------------|-------|
| Text | Dynamic | Line count × line height |
| Heading | 40-60px | Based on level (H1 > H2 > H3) |
| PhotoRef | 200-400px | Based on size hint |
| PhotoGroup | 200-600px | Based on row count |
| Divider | 32px | Fixed |
| Map | 300px | Fixed minimum |
| Timeline | 48px | Fixed |
| Section | Header only | Children are separate items |

**Dynamic measurement pattern:**

```typescript
// Use @tanstack/react-virtual's dynamic sizing
const virtualizer = useVirtualizer({
  count: blocks.length,
  getScrollElement: () => parentRef.current,
  estimateSize: (index) => estimateBlockHeight(blocks[index]),
  // Enable dynamic measuring
  measureElement: (el) => el?.getBoundingClientRect().height ?? 0,
});
```

### 2.3 Lazy Loading Block Content

**Photo thumbnails within blocks:**

```typescript
// PhotoGroupBlock.tsx
function PhotoGroupBlock({ manifestIds, layout }: Props) {
  // Use existing preload infrastructure
  const { photos, loading } = usePhotoThumbnails(manifestIds, {
    // Only load when block is in/near viewport
    enabled: isInViewport,
    // Prioritize visible thumbnails
    priority: 'low',
  });
  
  return (
    <div data-block-type="photo-group">
      {manifestIds.map((id, index) => (
        <LazyThumbnail
          key={id}
          manifestId={id}
          photo={photos[id]}
          loading={loading[id]}
        />
      ))}
    </div>
  );
}
```

### 2.4 Debouncing Re-renders During Editing

**Critical for typing performance:**

```typescript
// BlockEditor.tsx - Debounce patterns

// 1. Content changes: 300ms debounce before updating state
const debouncedContent = useDebouncedValue(content, 300);

// 2. Position changes (drag): 16ms (single frame)
const throttledPosition = useThrottledValue(position, 16);

// 3. Sync trigger: 1500ms debounce after edit
const scheduleSave = useMemo(
  () => debounce(() => syncBlocks(albumId), 1500),
  [albumId]
);
```

**TipTap's built-in optimization:**

TipTap (recommended editor) handles this internally:
- Uses ProseMirror's transaction batching
- Defers DOM updates to requestAnimationFrame
- Only re-renders affected nodes

---

## 3. Sync Performance

### 3.1 Current Design: Single Document Sync

```
┌─────────────────────────────────────────────────────────────┐
│  User types "Hello"                                         │
│         ↓                                                   │
│  In-memory update (immediate)                               │
│         ↓                                                   │
│  Debounce timer starts (1500ms)                             │
│         ↓                                                   │
│  Timer fires → Encrypt entire document                      │
│         ↓                                                   │
│  PUT /api/albums/{id}/content (400KB payload)               │
│         ↓                                                   │
│  Server stores blob, increments version                     │
└─────────────────────────────────────────────────────────────┘
```

**Performance characteristics:**

| Metric | Single Document | Per-Block |
|--------|-----------------|-----------|
| Edit latency | 0 ms (in-memory) | 0 ms |
| Sync latency | 1.5s debounce | 1.5s debounce |
| Payload size | 100-400 KB | 0.1-2 KB |
| Server writes | 1 per sync | 1-N per sync |
| Conflict resolution | Simple (LWW) | Complex |

### 3.2 Sync Optimization Patterns

**A. Aggressive Debouncing (Recommended for MVP)**

```typescript
const DEBOUNCE_DELAYS = {
  typing: 1500,      // Normal text editing
  navigation: 0,     // Save immediately before leaving
  blur: 500,         // User clicked away
  idle: 5000,        // Background periodic save
};
```

**B. Optimistic UI with Queue**

```typescript
// Block changes are immediately reflected in UI
// Sync happens in background
class BlockSyncQueue {
  private pendingSync: AlbumContent | null = null;
  private syncInProgress = false;
  
  async queueSync(content: AlbumContent): Promise<void> {
    this.pendingSync = content;
    
    if (!this.syncInProgress) {
      this.flush();
    }
    // If sync in progress, pendingSync will be sent after current sync
  }
  
  private async flush(): Promise<void> {
    while (this.pendingSync) {
      this.syncInProgress = true;
      const toSync = this.pendingSync;
      this.pendingSync = null;
      
      await this.syncToServer(toSync);
      this.syncInProgress = false;
    }
  }
}
```

### 3.3 Alternative: Per-Block Sync (Phase 2)

For large albums or real-time collaboration:

```typescript
// Each block sync'd independently
interface BlockSyncState {
  blockId: string;
  localVersion: number;
  serverVersion: number;
  status: 'synced' | 'pending' | 'conflict';
}

// Only changed blocks are sent
async function syncChangedBlocks(
  changedBlockIds: string[],
  blocks: Record<string, Block>,
): Promise<void> {
  const patches = changedBlockIds.map(id => ({
    id,
    operation: 'upsert',
    content: await encryptBlock(blocks[id], epochKey),
  }));
  
  await api.patchBlocks(albumId, patches);
}
```

**Migration strategy:**

1. Start with single document (simpler)
2. Track metrics: average edit frequency, document sizes
3. If >30% of syncs are for documents >200KB, migrate

### 3.4 Differential Sync (Future)

With encrypted content, true differential sync is challenging:

| Approach | Feasibility | Notes |
|----------|-------------|-------|
| **JSON diff** | ❌ Not with encryption | Can't diff ciphertext |
| **Block-level diff** | ✅ Works | Only send changed blocks |
| **Operation log (CRDT)** | ✅ Complex but works | Send operations, not state |

**Per-block diff is the practical path:**

```typescript
// Client computes which blocks changed
function getChangedBlocks(
  previous: AlbumContent,
  current: AlbumContent,
): string[] {
  const changed: string[] = [];
  
  for (const [id, block] of Object.entries(current.blocks)) {
    const prev = previous.blocks[id];
    if (!prev || block.updatedAt !== prev.updatedAt) {
      changed.push(id);
    }
  }
  
  // Also detect deletions
  for (const id of Object.keys(previous.blocks)) {
    if (!current.blocks[id]) {
      changed.push(id);
    }
  }
  
  return changed;
}
```

### 3.5 Offline Queue and Batch Sync

```typescript
// OfflineSyncQueue in db.worker.ts
interface OfflineQueue {
  albumId: string;
  operations: Array<{
    type: 'content-update';
    timestamp: string;
    encryptedContent: Uint8Array;
  }>;
  lastOnlineVersion: number;
}

// On reconnect
async function processOfflineQueue(queue: OfflineQueue): Promise<void> {
  // 1. Fetch server state
  const serverContent = await api.getContent(queue.albumId);
  
  // 2. If server is newer, merge
  if (serverContent.version > queue.lastOnlineVersion) {
    const merged = mergeContent(
      await decryptContent(serverContent),
      queue.operations,
    );
    await api.putContent(queue.albumId, await encryptContent(merged));
  } else {
    // 3. If we're ahead, just push latest
    const latest = queue.operations[queue.operations.length - 1];
    await api.putContent(queue.albumId, latest.encryptedContent);
  }
}
```

---

## 4. Editor Performance

### 4.1 Rich Text Editor Comparison

Based on the research in [SPEC-BlockEditorUX.md](../specs/SPEC-BlockEditorUX.md):

| Criteria | TipTap | Slate.js | Lexical |
|----------|--------|----------|---------|
| **Bundle size** | ~60KB | ~80KB | ~40KB |
| **Keystroke latency** | <5ms | <5ms | <3ms |
| **10K char doc** | ✅ Smooth | ✅ Smooth | ✅ Smooth |
| **100K char doc** | ✅ Good | 🟡 Some lag | ✅ Good |
| **React 19 compat** | ✅ | ✅ | ✅ |
| **Custom blocks** | ✅ NodeViews | ✅ Plugins | ✅ Plugins |

**Recommendation: TipTap**

- Best custom block support via NodeViews
- Excellent TypeScript support
- Built-in Y.js for future collaboration
- Active development and support

### 4.2 Debounced Autosave Timing

```
User types → Buffer changes → 1.5s idle → Encrypt → Sync
             ↑                    ↑
             └── Every keystroke  └── Only fires once per "burst"
```

**Why 1500ms?**

| Delay | Pros | Cons |
|-------|------|------|
| 500ms | Faster sync | Too aggressive, sync during typing |
| 1000ms | Balance | Still might catch mid-sentence |
| **1500ms** | **Natural pause** | **Matches sentence completion** |
| 3000ms | Very relaxed | Risk of data loss if browser crashes |

**Additional save triggers:**

```typescript
// Save immediately on these events
const IMMEDIATE_SAVE_EVENTS = [
  'beforeunload',      // Tab close
  'visibilitychange',  // Tab switch (if hidden)
  'pagehide',          // Mobile background
];

// Save with short delay (500ms) on these
const QUICK_SAVE_EVENTS = [
  'blur',              // Focus left editor
  'albumNavigation',   // User clicking another album
];
```

### 4.3 Undo/Redo Stack Management

**Memory budget for undo history:**

```typescript
interface UndoConfig {
  // Maximum number of undo states
  maxStates: 20,
  
  // Maximum total memory (approximate)
  maxMemoryKB: 5000, // 5MB
  
  // Prune on visibility hidden
  backgroundMaxStates: 5,
}

class UndoManager {
  private stack: AlbumContent[] = [];
  
  push(state: AlbumContent): void {
    // Deep clone to avoid reference issues
    this.stack.push(structuredClone(state));
    
    // Enforce limits
    while (this.stack.length > UndoConfig.maxStates) {
      this.stack.shift();
    }
    
    // Check memory (rough estimate)
    const estimatedSize = this.stack.reduce(
      (sum, s) => sum + JSON.stringify(s).length,
      0
    );
    
    while (estimatedSize > UndoConfig.maxMemoryKB * 1024) {
      this.stack.shift();
    }
  }
}
```

### 4.4 Copy/Paste Large Content

**Challenges:**
1. Pasting large images (handled by browser, not a block concern)
2. Pasting many text blocks from Notion/Word
3. Pasting HTML with embedded images

**Implementation:**

```typescript
// Handle paste in TipTap
editor.on('paste', ({ clipboardData }) => {
  const html = clipboardData.getData('text/html');
  const text = clipboardData.getData('text/plain');
  
  if (html) {
    // Parse HTML, extract blocks
    const blocks = parseHtmlToBlocks(html);
    
    // Limit pasted content
    if (blocks.length > 50) {
      showWarning('Pasted content truncated to 50 blocks');
      blocks.splice(50);
    }
    
    // Insert with requestIdleCallback for large pastes
    if (blocks.length > 10) {
      requestIdleCallback(() => insertBlocks(blocks));
    } else {
      insertBlocks(blocks);
    }
  }
});
```

---

## 5. Key Rotation Performance

### 5.1 Current Re-encryption Time

**Photo re-encryption is already solved:**

```typescript
// Current epoch rotation in apps/web/src/lib/epoch-rotation-service.ts
// Re-encrypts all manifests and metadata
```

**Block content adds:**

| Component | Size | Re-encrypt Time |
|-----------|------|-----------------|
| Album name | 100 bytes | <1 ms |
| Album description | 1 KB | <1 ms |
| **Block content** | 100-400 KB | 5-15 ms |
| Total added overhead | - | **5-15 ms** |

### 5.2 Time Budget

**Current rotation flow:**

```
1. Generate new epoch key                      1 ms
2. Re-encrypt album name/description           1 ms
3. Re-encrypt block content (NEW)              15 ms
4. Create epoch key bundles for members        5 ms × N
5. Upload to server                            200-500 ms
```

**Block content is negligible** compared to network time.

### 5.3 Background Rotation

For very large albums (>500 blocks):

```typescript
// Could chunk re-encryption if needed
async function* chunkReencrypt(
  content: AlbumContent,
  oldKey: Uint8Array,
  newKey: Uint8Array,
): AsyncGenerator<{ progress: number; blocks: Block[] }> {
  const blockIds = Object.keys(content.blocks);
  const chunkSize = 50;
  
  for (let i = 0; i < blockIds.length; i += chunkSize) {
    const chunk = blockIds.slice(i, i + chunkSize);
    const reencrypted = await Promise.all(
      chunk.map(id => reencryptBlock(content.blocks[id], oldKey, newKey))
    );
    
    yield {
      progress: (i + chunkSize) / blockIds.length,
      blocks: reencrypted,
    };
  }
}
```

**Verdict:** Not needed for MVP. Single-shot re-encryption handles 500 blocks in <20ms.

---

## 6. Measurement and Monitoring

### 6.1 Key Metrics to Track

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| **Document load time** | <200ms for 50 blocks | `performance.mark/measure` |
| **Encryption time** | <50ms for 500 blocks | CryptoWorker timing |
| **Sync latency** | <2s after edit pause | Time from flush to response |
| **Scroll FPS** | 60fps | `requestAnimationFrame` loop |
| **Memory usage** | <100MB for block editor | `performance.memory` |
| **First paint** | <500ms from navigation | `PerformanceObserver` |

### 6.2 Implementation

```typescript
// New file: apps/web/src/lib/block-metrics.ts
import { createLogger } from './logger';

const log = createLogger('BlockMetrics');

interface MetricsCollector {
  startOperation(name: string): void;
  endOperation(name: string): void;
  getStats(): Record<string, { count: number; avgMs: number; maxMs: number }>;
}

class BlockMetrics implements MetricsCollector {
  private operations = new Map<string, number[]>();
  private inFlight = new Map<string, number>();
  
  startOperation(name: string): void {
    this.inFlight.set(name, performance.now());
  }
  
  endOperation(name: string): void {
    const start = this.inFlight.get(name);
    if (!start) return;
    
    const duration = performance.now() - start;
    this.inFlight.delete(name);
    
    const times = this.operations.get(name) ?? [];
    times.push(duration);
    this.operations.set(name, times.slice(-100)); // Keep last 100
    
    // Log slow operations
    if (duration > 100) {
      log.warn(`Slow operation: ${name} took ${duration.toFixed(1)}ms`);
    }
  }
  
  getStats(): Record<string, { count: number; avgMs: number; maxMs: number }> {
    const stats: Record<string, { count: number; avgMs: number; maxMs: number }> = {};
    
    for (const [name, times] of this.operations) {
      stats[name] = {
        count: times.length,
        avgMs: times.reduce((a, b) => a + b, 0) / times.length,
        maxMs: Math.max(...times),
      };
    }
    
    return stats;
  }
}

export const blockMetrics = new BlockMetrics();

// Usage:
// blockMetrics.startOperation('encrypt-content');
// await encryptContent(content);
// blockMetrics.endOperation('encrypt-content');
```

### 6.3 Performance Budgets

| Operation | Warning | Error |
|-----------|---------|-------|
| Content encryption | >50ms | >200ms |
| Content decryption | >50ms | >200ms |
| Block render (single) | >16ms | >50ms |
| Full content render | >100ms | >500ms |
| Sync round-trip | >3s | >10s |

### 6.4 Alerting (Development)

```typescript
// In development, add performance warnings
if (import.meta.env.DEV) {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.duration > 100) {
        console.warn(
          `⚠️ Slow operation: ${entry.name} took ${entry.duration.toFixed(0)}ms`
        );
      }
    }
  });
  
  observer.observe({ entryTypes: ['measure'] });
}
```

---

## 7. Optimizations for Common Cases

### 7.1 The 80/20 Rule

**Most albums will have <50 blocks.** Optimize for this.

| User Pattern | Expected Distribution | Strategy |
|--------------|----------------------|----------|
| Photo-only albums | 60% | Block content section hidden |
| 5-20 blocks | 25% | No virtualization, simple render |
| 50-100 blocks | 10% | Light virtualization |
| >100 blocks | 5% | Full optimization |

### 7.2 Fast Path for Common Patterns

```typescript
// BlockContentView.tsx
function BlockContentView({ content }: Props) {
  const blockCount = Object.keys(content.blocks).length;
  
  // Fast path: No blocks yet
  if (blockCount === 0) {
    return <EmptyBlockContent onAddFirst={() => /*...*/} />;
  }
  
  // Fast path: Few blocks, render directly
  if (blockCount < 30) {
    return <DirectBlockRender blocks={content.blocks} />;
  }
  
  // Full path: Many blocks, use virtualization
  return <VirtualizedBlockRender blocks={content.blocks} />;
}
```

### 7.3 Photo-Heavy vs Text-Heavy Optimization

**Photo-heavy albums:**
- Prioritize thumbnail loading
- Lazy-load full photos in PhotoGroupBlocks
- Use intersection observer for photo loading

**Text-heavy albums:**
- No special optimization needed
- TipTap handles long text efficiently

```typescript
// Detect album type for optimization hints
function analyzeAlbumContent(content: AlbumContent): 'photo-heavy' | 'text-heavy' | 'mixed' {
  const blocks = Object.values(content.blocks);
  const photoBlocks = blocks.filter(b => 
    b.type === 'photo-ref' || b.type === 'photo-group'
  ).length;
  
  const ratio = photoBlocks / blocks.length;
  
  if (ratio > 0.6) return 'photo-heavy';
  if (ratio < 0.2) return 'text-heavy';
  return 'mixed';
}
```

### 7.4 Lazy Hydration Strategies

**For share link viewers (read-only):**

```typescript
// Share link viewers don't need editor capabilities
function BlockViewerLazy({ content }: Props) {
  // Load editor code only if user can edit
  const { canEdit } = usePermissions();
  
  if (canEdit) {
    // Dynamically import editor
    const BlockEditor = lazy(() => import('./BlockEditor'));
    return (
      <Suspense fallback={<BlockSkeleton />}>
        <BlockEditor content={content} />
      </Suspense>
    );
  }
  
  // Static render for viewers - much smaller bundle
  return <StaticBlockRenderer content={content} />;
}
```

---

## 8. Implementation Priorities

### Priority Matrix

| Optimization | Impact | Effort | Priority |
|--------------|--------|--------|----------|
| Debounced autosave | High | Low | **P0 - MVP** |
| Memory management | Medium | Low | **P0 - MVP** |
| Basic metrics | Medium | Low | **P0 - MVP** |
| TipTap integration | High | Medium | **P1 - Launch** |
| Conditional virtualization | Medium | Medium | **P1 - Launch** |
| Lazy photo loading in blocks | Medium | Low | **P1 - Launch** |
| Per-block sync | High | High | **P2 - Scale** |
| MessagePack serialization | Low | Medium | **P3 - Optimize** |
| Background key rotation | Low | Medium | **P3 - Optimize** |

### MVP Performance Checklist

- [ ] Debounced autosave (1500ms)
- [ ] Immediate save on blur/navigation
- [ ] Undo stack memory limit (20 states, 5MB)
- [ ] Cache reduction on visibility hidden
- [ ] Basic timing metrics
- [ ] Performance warning in dev mode

### Launch Performance Checklist

- [ ] TipTap with NodeViews for custom blocks
- [ ] Conditional virtualization for >50 blocks
- [ ] Lazy photo loading with intersection observer
- [ ] Prefetch photos in PhotoGroupBlocks
- [ ] Performance dashboard in dev tools

---

## Appendix A: Benchmark Scripts

```typescript
// scripts/benchmark-block-content.ts
// Run with: npx tsx scripts/benchmark-block-content.ts

import sodium from 'libsodium-wrappers';

async function benchmark() {
  await sodium.ready;
  
  // Generate test content of various sizes
  const sizes = [10, 50, 100, 500, 1000];
  
  for (const blockCount of sizes) {
    const content = generateTestContent(blockCount);
    const json = JSON.stringify(content);
    const bytes = new TextEncoder().encode(json);
    
    // Benchmark encryption
    const key = sodium.randombytes_buf(32);
    const nonce = sodium.randombytes_buf(24);
    
    const encryptStart = performance.now();
    const encrypted = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      bytes, null, null, nonce, key
    );
    const encryptTime = performance.now() - encryptStart;
    
    // Benchmark decryption
    const decryptStart = performance.now();
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, encrypted, null, nonce, key
    );
    const decryptTime = performance.now() - decryptStart;
    
    console.log(`${blockCount} blocks (${(bytes.length/1024).toFixed(1)}KB):`);
    console.log(`  Encrypt: ${encryptTime.toFixed(2)}ms`);
    console.log(`  Decrypt: ${decryptTime.toFixed(2)}ms`);
  }
}

function generateTestContent(blockCount: number) {
  const blocks: Record<string, unknown> = {};
  
  for (let i = 0; i < blockCount; i++) {
    blocks[`block-${i}`] = {
      id: `block-${i}`,
      type: i % 3 === 0 ? 'text' : i % 3 === 1 ? 'heading' : 'photo-ref',
      content: { text: `Block content ${i} with some additional text` },
      position: `a${i}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  
  return {
    version: 1,
    albumId: 'test-album',
    rootBlockIds: Object.keys(blocks),
    blocks,
    updatedAt: new Date().toISOString(),
  };
}

benchmark();
```

---

## Appendix B: Further Research

### Topics for Future Investigation

1. **WebAssembly Compression** - Could ZSTD WASM reduce encrypted payload sizes?
2. **IndexedDB Performance** - Large blob storage performance on mobile
3. **Service Worker Caching** - Cache decrypted content for offline reads?
4. **Web Worker Pool** - Multiple crypto workers for parallel operations?
5. **Streaming Encryption** - For very large documents (>10MB)

### References

- [libsodium performance](https://doc.libsodium.org/internals)
- [TipTap performance guide](https://tiptap.dev/guide/performance)
- [TanStack Virtual docs](https://tanstack.com/virtual/latest)
- [Web Performance API](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API)
