# SPEC: Block-Based Content System for Mosaic Albums

> **Feature:** Rich content blocks for photo storytelling
> **Status:** Research/Design Phase
> **Date:** 2026-01-28

---

## Executive Summary

This specification explores adding a **block-based content system** to Mosaic albums, enabling users to create rich narratives with text, headings, photo groups, maps, and timelines—all while maintaining **zero-knowledge encryption**.

The design is inspired by Notion/Gutenberg but adapted for Mosaic's unique constraints:
- All content encrypted client-side
- Server sees only opaque blobs
- Offline-first with sync capability
- Key rotation support

---

## Table of Contents

1. [Block Types](#1-block-types)
2. [Data Structure Design](#2-data-structure-design)
3. [Encryption Strategy](#3-encryption-strategy)
4. [Integration with Existing System](#4-integration-with-existing-system)
5. [Sync & Versioning](#5-sync--versioning)
6. [Technical Challenges](#6-technical-challenges)
7. [Implementation Approaches](#7-implementation-approaches)
8. [Pros/Cons Analysis](#8-proscons-analysis)
9. [Recommended Approach](#9-recommended-approach)

---

## 1. Block Types

### 1.1 Core Block Types

| Block Type | Purpose | Content |
|------------|---------|---------|
| **Text** | Paragraphs, descriptions | Rich text (bold, italic, links) |
| **Heading** | Section titles | H1, H2, H3 levels |
| **PhotoRef** | Reference to a photo | Manifest ID + optional caption |
| **PhotoGroup** | Grid of photos | Array of PhotoRefs + layout |
| **Divider** | Visual separator | None (structural) |
| **Map** | Location display | GeoJSON or bounding box |
| **Timeline** | Date marker | Date + optional label |
| **Section** | Container block | Child blocks (nesting) |

### 1.2 TypeScript Block Interfaces

```typescript
// ============================================================================
// Base Block Types
// ============================================================================

/** All blocks share these properties */
interface BaseBlock {
  /** Unique block ID (UUIDv7, client-generated) */
  id: string;
  /** Block type discriminator */
  type: BlockType;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
  /** Optional parent block ID (for nesting) */
  parentId?: string;
  /** Position within parent (fractional indexing) */
  position: string;
}

/** Discriminated union of all block types */
type BlockType = 
  | 'text'
  | 'heading'
  | 'photo-ref'
  | 'photo-group'
  | 'divider'
  | 'map'
  | 'timeline'
  | 'section';

// ============================================================================
// Content Blocks
// ============================================================================

/** Rich text content (subset of Slate.js or ProseMirror format) */
interface RichText {
  /** Plain text content */
  text: string;
  /** Bold formatting */
  bold?: boolean;
  /** Italic formatting */
  italic?: boolean;
  /** Link URL */
  href?: string;
}

/** Paragraph/text block */
interface TextBlock extends BaseBlock {
  type: 'text';
  content: {
    /** Array of rich text segments */
    segments: RichText[];
  };
}

/** Heading block (H1, H2, H3) */
interface HeadingBlock extends BaseBlock {
  type: 'heading';
  content: {
    level: 1 | 2 | 3;
    text: string;
  };
}

/** Visual separator */
interface DividerBlock extends BaseBlock {
  type: 'divider';
  content: Record<string, never>; // Empty object
}

// ============================================================================
// Photo Blocks
// ============================================================================

/** Single photo reference with optional caption */
interface PhotoRefBlock extends BaseBlock {
  type: 'photo-ref';
  content: {
    /** Reference to manifest ID */
    manifestId: string;
    /** Optional caption */
    caption?: string;
    /** Display size hint */
    size?: 'small' | 'medium' | 'large' | 'full';
  };
}

/** Photo grid/gallery within content */
interface PhotoGroupBlock extends BaseBlock {
  type: 'photo-group';
  content: {
    /** Manifest IDs of photos in group */
    manifestIds: string[];
    /** Layout style */
    layout: 'grid' | 'masonry' | 'carousel' | 'row';
    /** Number of columns (for grid) */
    columns?: 2 | 3 | 4;
    /** Optional group title */
    title?: string;
  };
}

// ============================================================================
// Contextual Blocks
// ============================================================================

/** Map showing location(s) */
interface MapBlock extends BaseBlock {
  type: 'map';
  content: {
    /** Center point */
    center?: { lat: number; lng: number };
    /** Zoom level (1-18) */
    zoom?: number;
    /** Photos to show on map (uses their GPS data) */
    manifestIds?: string[];
    /** Custom markers */
    markers?: Array<{
      lat: number;
      lng: number;
      label?: string;
    }>;
  };
}

/** Timeline/date marker */
interface TimelineBlock extends BaseBlock {
  type: 'timeline';
  content: {
    /** Date being marked (ISO 8601) */
    date: string;
    /** Display format hint */
    format?: 'date' | 'datetime' | 'year' | 'month';
    /** Optional label */
    label?: string;
  };
}

// ============================================================================
// Container Blocks
// ============================================================================

/** Section container for grouping blocks */
interface SectionBlock extends BaseBlock {
  type: 'section';
  content: {
    /** Section title */
    title?: string;
    /** Visual style */
    style?: 'card' | 'bordered' | 'plain' | 'highlight';
    /** Collapsed by default? */
    collapsed?: boolean;
  };
  /** Child block IDs (ordering defined by children's position) */
  childIds: string[];
}

// ============================================================================
// Album Content Document
// ============================================================================

/** Complete album content structure */
interface AlbumContent {
  /** Content format version */
  version: 1;
  /** Album ID this content belongs to */
  albumId: string;
  /** Root-level block IDs (non-nested blocks) */
  rootBlockIds: string[];
  /** All blocks indexed by ID */
  blocks: Record<string, Block>;
  /** Last modification timestamp */
  updatedAt: string;
}

/** Union of all block types */
type Block = 
  | TextBlock
  | HeadingBlock
  | DividerBlock
  | PhotoRefBlock
  | PhotoGroupBlock
  | MapBlock
  | TimelineBlock
  | SectionBlock;
```

### 1.3 Block Position Strategy

For efficient reordering without full document rewrites, use **fractional indexing**:

```typescript
// Position is a string that sorts lexicographically
// Examples:
// "a0" - first item
// "a1" - second item
// "a05" - between a0 and a1
// "a0V" - between a0 and a05

// Library: fractional-indexing or generate-key-between
import { generateKeyBetween } from 'fractional-indexing';

// Insert between blocks
const newPosition = generateKeyBetween(
  blockA.position, // "a0"
  blockB.position  // "a1"
); // Returns "a0V"
```

---

## 2. Data Structure Design

### 2.1 Approach A: Single Encrypted Document

Store entire album content as one encrypted blob:

```
┌─────────────────────────────────────────────────┐
│                AlbumContent (JSON)              │
│  ┌───────────────────────────────────────────┐  │
│  │ version: 1                                 │  │
│  │ albumId: "..."                             │  │
│  │ rootBlockIds: ["block1", "block2", ...]   │  │
│  │ blocks: {                                  │  │
│  │   "block1": { type: "heading", ... },     │  │
│  │   "block2": { type: "text", ... },        │  │
│  │   "block3": { type: "photo-ref", ... },   │  │
│  │ }                                          │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
                        │
                        ▼ XChaCha20-Poly1305
┌─────────────────────────────────────────────────┐
│      Encrypted Blob (stored on server)          │
└─────────────────────────────────────────────────┘
```

**Pros:**
- Simple to implement
- Atomic updates
- Single encryption/decryption operation

**Cons:**
- Must re-upload entire document on any change
- Merge conflicts harder to resolve
- Large documents = slow on every edit

### 2.2 Approach B: Per-Block Encryption (CRDT-style)

Each block is independently encrypted and synced:

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   Block 1    │  │   Block 2    │  │   Block 3    │
│ (Encrypted)  │  │ (Encrypted)  │  │ (Encrypted)  │
└──────────────┘  └──────────────┘  └──────────────┘
        │                 │                 │
        └────────────────┼─────────────────┘
                         ▼
              ┌─────────────────────┐
              │  Album Block Index  │
              │  (manifestIds list) │
              └─────────────────────┘
```

```typescript
/** Server-side block record */
interface BlockRecord {
  id: string;
  albumId: string;
  /** Lamport clock for ordering */
  version: number;
  /** Tombstone for deletion */
  isDeleted: boolean;
  /** Encrypted block content */
  encryptedContent: Uint8Array;
  /** Ed25519 signature */
  signature: string;
  /** Epoch signing public key */
  signerPubkey: string;
  /** Timestamps */
  createdAt: string;
  updatedAt: string;
}
```

**Pros:**
- Fine-grained sync (only changed blocks)
- Better offline editing
- Parallel editing possible

**Cons:**
- More complex sync logic
- More server storage (per-block overhead)
- Block ordering requires additional structure

### 2.3 Approach C: Hybrid (Chunked Document)

Split document into sections, each independently encrypted:

```
┌─────────────────────────────────────────────────┐
│ Album Content                                    │
│  ┌──────────────────┐ ┌──────────────────┐      │
│  │ Chunk 0          │ │ Chunk 1          │ ...  │
│  │ (blocks 0-49)    │ │ (blocks 50-99)   │      │
│  └──────────────────┘ └──────────────────┘      │
└─────────────────────────────────────────────────┘
```

**Pros:**
- Balance of simplicity and efficiency
- Partial updates possible

**Cons:**
- Chunk boundaries complicate editing
- Rebalancing needed on large changes

---

## 3. Encryption Strategy

### 3.1 Key Derivation

Blocks use the same epoch key infrastructure as photos:

```typescript
// Derive a block encryption key from epoch seed
function deriveBlockKey(epochSeed: Uint8Array): Uint8Array {
  return hkdfExpand(
    epochSeed,
    "Mosaic_BlockContent_v1", // Different context from shards
    32
  );
}
```

**Key Hierarchy:**
```
Epoch Seed (32 bytes)
    │
    ├─► HKDF("Mosaic_Thumb_v1")    → Thumbnail shard key
    ├─► HKDF("Mosaic_Preview_v1")  → Preview shard key  
    ├─► HKDF("Mosaic_Full_v1")     → Full shard key
    └─► HKDF("Mosaic_Block_v1")    → Block content key (NEW)
```

### 3.2 Envelope Format for Blocks

Reuse the existing 64-byte envelope header with a new tier:

```typescript
enum ContentTier {
  THUMB = 1,
  PREVIEW = 2,
  ORIGINAL = 3,
  METADATA = 4,  // Album name/description (existing)
  BLOCKS = 5,    // Block content (NEW)
}

interface BlockEnvelope {
  magic: "SGzk";
  version: 0x03;
  epochId: number;
  blockId: number;  // Use shardId field for block index
  nonce: Uint8Array; // 24 bytes, fresh per encryption
  tier: ContentTier.BLOCKS;
  reserved: Uint8Array; // 26 bytes of zeros
}
```

### 3.3 Signature Verification

Blocks are signed like manifests:

```typescript
interface SignedBlock {
  /** Encrypted block content */
  encryptedContent: Uint8Array;
  /** Ed25519 signature over (context || encryptedContent) */
  signature: Uint8Array;
  /** Signer's epoch sign public key */
  signerPubkey: Uint8Array;
}

const BLOCK_SIGN_CONTEXT = "Mosaic_Block_v1";
```

### 3.4 Share Link Access

For share links with tier access:

| Link Tier | Block Access |
|-----------|--------------|
| THUMB (1) | No block access (photos only) |
| PREVIEW (2) | Read block content |
| FULL (3) | Read block content |

```typescript
// Share links at PREVIEW or FULL tier get block key
interface ShareLinkKeys {
  tier: AccessTier;
  epochKeys: Array<{
    epochId: number;
    tierKey: Uint8Array;
    blockKey?: Uint8Array; // Only for tier >= PREVIEW
    signPubkey: Uint8Array;
  }>;
}
```

---

## 4. Integration with Existing System

### 4.1 Option A: Blocks as New Entity (RECOMMENDED)

Create a separate `blocks` table and API:

```
┌─────────────────────────────────────────────────────────────┐
│                        DATABASE                              │
│                                                              │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐   │
│  │   albums    │────>│  manifests  │     │   blocks    │   │
│  │             │     │  (photos)   │     │  (content)  │   │
│  └─────────────┘     └─────────────┘     └─────────────┘   │
│         │                                       │           │
│         └───────────────────────────────────────┘           │
│                       album_id FK                            │
└─────────────────────────────────────────────────────────────┘
```

**Backend Entity:**

```csharp
// apps/backend/Mosaic.Backend/Data/Entities/Block.cs
namespace Mosaic.Backend.Data.Entities;

public class Block
{
    public Guid Id { get; set; }
    public Guid AlbumId { get; set; }
    
    /// <summary>
    /// Lamport clock version (increments on update)
    /// </summary>
    public long Version { get; set; }
    
    /// <summary>
    /// Soft delete marker
    /// </summary>
    public bool IsDeleted { get; set; }
    
    /// <summary>
    /// Encrypted block content (XChaCha20-Poly1305)
    /// </summary>
    public required byte[] EncryptedContent { get; set; }
    
    /// <summary>
    /// Ed25519 signature over context || content
    /// </summary>
    public required string Signature { get; set; }
    
    /// <summary>
    /// Epoch signing public key (base64)
    /// </summary>
    public required string SignerPubkey { get; set; }
    
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    
    // Navigation
    public Album Album { get; set; } = null!;
}
```

**API Endpoints:**

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/albums/{id}/blocks` | List blocks for album |
| GET | `/api/albums/{id}/blocks/sync` | Sync blocks since version |
| POST | `/api/albums/{id}/blocks` | Create block |
| PUT | `/api/albums/{id}/blocks/{blockId}` | Update block |
| DELETE | `/api/albums/{id}/blocks/{blockId}` | Delete block (soft) |

### 4.2 Option B: Extend Manifests

Reuse manifest table with a new manifest type:

```typescript
// Manifest type discriminator
enum ManifestType {
  PHOTO = 1,   // Existing photo manifests
  BLOCK = 2,  // New block content
}

interface ManifestRecord {
  id: string;
  albumId: string;
  type: ManifestType; // NEW FIELD
  versionCreated: number;
  isDeleted: boolean;
  encryptedMeta: Uint8Array;
  signature: string;
  signerPubkey: string;
  shardIds: string[]; // Empty for blocks
}
```

**Pros:**
- Fewer schema changes
- Reuses existing sync logic

**Cons:**
- Conflates two different concepts
- Complicates manifest queries
- May confuse photo-specific logic

### 4.3 Recommendation: Option A (New Entity)

Blocks are fundamentally different from photo manifests:
- No shards (content is the encrypted blob)
- Different update patterns (frequent edits vs. immutable photos)
- Different sync granularity needs

A separate entity is cleaner and more maintainable.

---

## 5. Sync & Versioning

### 5.1 Block Versioning

Each block has its own version counter (Lamport clock):

```typescript
interface BlockVersion {
  blockId: string;
  version: number;       // Increments on each update
  albumVersion: number;  // Album version when created/updated
}
```

### 5.2 Sync Protocol

Extend existing sync to include blocks:

```typescript
// Extended sync response
interface SyncResponse {
  manifests: ManifestRecord[];    // Photos
  blocks: BlockRecord[];          // Content blocks (NEW)
  deletedBlockIds: string[];      // Tombstones (NEW)
  currentEpochId: number;
  albumVersion: number;
  hasMore: boolean;
}

// Sync request with block support
interface SyncRequest {
  sinceVersion?: number;
  includeBlocks?: boolean;  // Default true
}
```

### 5.3 Conflict Resolution

For concurrent edits (unlikely in personal photo galleries):

1. **Last-Writer-Wins (LWW):** Simple, may lose changes
2. **Version Vector:** Block-level CRDT, complex but correct
3. **Operational Transform:** Full real-time collaboration, very complex

**Recommendation:** Start with LWW for simplicity. Block editing in Mosaic is:
- Single-user most of the time
- Low concurrency (≤50 users per deployment)
- Not real-time collaborative

### 5.4 Local Storage (SQLite-WASM)

Add blocks table to DbWorker:

```sql
CREATE TABLE blocks (
  id TEXT PRIMARY KEY,
  album_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL,
  position TEXT NOT NULL,
  parent_id TEXT,
  content TEXT NOT NULL,  -- Decrypted JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_blocks_album ON blocks(album_id);
CREATE INDEX idx_blocks_parent ON blocks(parent_id) WHERE parent_id IS NOT NULL;
```

---

## 6. Technical Challenges

### 6.1 Block Reordering (Drag-and-Drop)

**Challenge:** Moving a block requires updating positions without touching other blocks.

**Solution: Fractional Indexing**

```typescript
import { generateKeyBetween } from 'fractional-indexing';

function moveBlock(
  block: Block,
  beforeBlock: Block | null,
  afterBlock: Block | null
): string {
  return generateKeyBetween(
    beforeBlock?.position ?? null,
    afterBlock?.position ?? null
  );
}

// Example positions after operations:
// Initial: [A: "a0", B: "a1", C: "a2"]
// Move C between A and B: [A: "a0", C: "a0V", B: "a1"]
// Insert D at start: [D: "Zz", A: "a0", C: "a0V", B: "a1"]
```

### 6.2 Rich Text Editing While Encrypted

**Challenge:** Rich text editors need plaintext access. Every keystroke = re-encrypt?

**Solution: Delayed Encryption**

```typescript
class BlockEditor {
  private decryptedContent: AlbumContent;
  private isDirty = false;
  private saveTimeoutId: number | null = null;
  
  // Edit in-memory (plaintext)
  edit(blockId: string, content: BlockContent) {
    this.decryptedContent.blocks[blockId].content = content;
    this.isDirty = true;
    this.scheduleSave();
  }
  
  // Debounced save with encryption
  private scheduleSave() {
    if (this.saveTimeoutId) {
      clearTimeout(this.saveTimeoutId);
    }
    this.saveTimeoutId = setTimeout(() => this.save(), 1500);
  }
  
  async save() {
    if (!this.isDirty) return;
    
    // Encrypt changed blocks
    const encrypted = await cryptoWorker.encryptBlocks(
      this.decryptedContent,
      epochKey
    );
    
    // Send to server
    await api.updateBlocks(albumId, encrypted);
    
    this.isDirty = false;
  }
  
  // Force save on blur/navigation
  async flush() {
    if (this.saveTimeoutId) {
      clearTimeout(this.saveTimeoutId);
    }
    await this.save();
  }
}
```

### 6.3 Performance with Many Blocks

**Challenge:** Albums could have hundreds of blocks. Initial load = slow?

**Solution: Lazy Loading & Virtualization**

```typescript
// Only load visible blocks initially
interface BlockLoadStrategy {
  // Load first N blocks immediately
  initialBlockCount: 50;
  
  // Load more on scroll (intersection observer)
  pageSize: 25;
  
  // Preload blocks before viewport
  prefetchCount: 10;
}

// Virtual list for block rendering
function AlbumContentView({ albumId }: { albumId: string }) {
  const { blocks, loadMore, hasMore } = useBlocks(albumId);
  
  return (
    <VirtualList
      items={blocks}
      onLoadMore={loadMore}
      hasMore={hasMore}
      renderItem={(block) => <BlockRenderer block={block} />}
    />
  );
}
```

### 6.4 Key Rotation with Blocks

**Challenge:** Epoch rotation requires re-encrypting all blocks.

**Solution: Same pattern as existing metadata rotation**

```typescript
async function rotateEpochWithBlocks(
  albumId: string,
  oldKey: EpochKey,
  newKey: EpochKey
): Promise<void> {
  // 1. Re-encrypt album name/description
  const newEncryptedName = await reencryptMetadata(
    album.encryptedName, oldKey, newKey
  );
  
  // 2. Re-encrypt all blocks
  const blocks = await api.getBlocks(albumId);
  const reencryptedBlocks = await Promise.all(
    blocks.map(async (block) => {
      const decrypted = await decryptBlock(block, oldKey);
      return encryptBlock(decrypted, newKey);
    })
  );
  
  // 3. Update server atomically
  await api.rotateEpochWithBlocks(albumId, newKey, {
    encryptedName: newEncryptedName,
    blocks: reencryptedBlocks,
  });
}
```

### 6.5 Offline Editing

**Challenge:** User edits blocks while offline. Sync on reconnect.

**Solution: Queue-based offline sync**

```typescript
interface OfflineEditQueue {
  /** Pending block operations */
  operations: BlockOperation[];
  /** Last known online album version */
  lastSyncVersion: number;
}

interface BlockOperation {
  type: 'create' | 'update' | 'delete';
  blockId: string;
  /** Encrypted content (for create/update) */
  encryptedContent?: Uint8Array;
  /** Client timestamp */
  clientTimestamp: string;
}

// On reconnect
async function syncOfflineEdits(queue: OfflineEditQueue) {
  // Pull server changes first
  const serverChanges = await api.syncBlocks(
    albumId, 
    queue.lastSyncVersion
  );
  
  // Merge with local changes (LWW based on timestamp)
  const merged = mergeBlockChanges(
    queue.operations,
    serverChanges.blocks
  );
  
  // Push merged result
  await api.updateBlocks(albumId, merged);
}
```

---

## 7. Implementation Approaches

### 7.1 Phase 1: MVP (Single Document)

Start simple with Approach A (single encrypted document):

1. **Week 1-2:** 
   - Add `AlbumContent` schema
   - Create `/blocks` API endpoint (single blob CRUD)
   - Add `encryptedContent` column to albums table

2. **Week 3-4:**
   - Implement block types (Text, Heading, PhotoRef, Divider)
   - Create `BlockEditor` component with Slate.js or TipTap
   - Wire up encryption/decryption

3. **Week 5-6:**
   - Add to sync protocol
   - Implement offline persistence
   - Add to key rotation

### 7.2 Phase 2: Optimization (Per-Block Sync)

If Phase 1 shows performance issues:

1. Migrate to per-block storage
2. Add differential sync
3. Implement fractional indexing

### 7.3 Phase 3: Advanced Features

After core is stable:

1. MapBlock with photo GPS clustering
2. TimelineBlock with auto-grouping
3. Section collapsing
4. Rich text with inline images

---

## 8. Pros/Cons Analysis

### 8.1 Single Document Approach

| Aspect | Pros | Cons |
|--------|------|------|
| **Simplicity** | ✅ One API, one blob | |
| **Atomicity** | ✅ All-or-nothing updates | |
| **Implementation** | ✅ Fast to build | |
| **Scalability** | | ❌ Large docs = slow |
| **Offline** | | ❌ Conflict resolution harder |
| **Bandwidth** | | ❌ Re-upload entire doc |

### 8.2 Per-Block Approach

| Aspect | Pros | Cons |
|--------|------|------|
| **Scalability** | ✅ Handles 1000s of blocks | |
| **Sync** | ✅ Fine-grained, efficient | |
| **Offline** | ✅ Block-level merging | |
| **Complexity** | | ❌ More code, more bugs |
| **Storage** | | ❌ Per-block overhead |
| **Implementation** | | ❌ Longer to build |

### 8.3 Recommendation Matrix

| Use Case | Best Approach |
|----------|---------------|
| ≤100 blocks per album | Single Document |
| Real-time collaboration | Per-Block |
| Frequent offline editing | Per-Block |
| <10 users, simple needs | Single Document |
| MVP/prototype | Single Document |

---

## 9. Recommended Approach

### 9.1 Summary

For Mosaic's target use case (≤50 users, personal photo galleries):

1. **Start with Single Document** (Approach A)
   - Faster to implement
   - Sufficient for typical album sizes
   - Matches existing metadata encryption pattern

2. **Design for Migration**
   - Use BlockId-based references (not array indices)
   - Version the format (`version: 1`)
   - Abstract storage behind service layer

3. **Monitor & Iterate**
   - If albums regularly exceed 100 blocks, migrate to per-block
   - If users report editing lag, optimize

### 9.2 Implementation Roadmap

```
Week 1-2: Schema & API
  ├── Add encryptedContent field to Album entity
  ├── Create PATCH /api/albums/{id}/content endpoint
  └── Add to sync response

Week 3-4: Frontend Core
  ├── Define block TypeScript types
  ├── Create BlockEditor component (basic rich text)
  ├── Wire up encryption in CryptoWorker
  └── Add to DbWorker local storage

Week 5-6: Polish & Test
  ├── Add PhotoRef and PhotoGroup blocks
  ├── Implement drag-and-drop reordering
  ├── Add to key rotation flow
  └── Write comprehensive tests

Week 7-8: Advanced Blocks
  ├── MapBlock with Leaflet integration
  ├── TimelineBlock with date parsing
  ├── Section blocks with collapse
  └── Share link viewer for blocks
```

### 9.3 Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Storage | Single encrypted document | Simplicity for MVP |
| Ordering | Fractional indexing | Efficient reordering |
| Rich Text | Slate.js or TipTap | Battle-tested, extensible |
| Key Derivation | HKDF with new context | Crypto separation |
| Sync | Extend existing album sync | Reuse infrastructure |
| Conflict Resolution | Last-Writer-Wins | Sufficient for personal use |

---

## Appendix A: Full TypeScript Types

```typescript
// ============================================================================
// Complete Block System Types
// ============================================================================

/** Block format version */
const BLOCK_FORMAT_VERSION = 1;

/** Block signing context */
const BLOCK_SIGN_CONTEXT = "Mosaic_Block_v1";

/** Block key derivation context */
const BLOCK_KEY_CONTEXT = "Mosaic_BlockKey_v1";

// --- Base Types ---

type BlockType = 
  | 'text'
  | 'heading'
  | 'photo-ref'
  | 'photo-group'
  | 'divider'
  | 'map'
  | 'timeline'
  | 'section';

interface BaseBlock {
  id: string;
  type: BlockType;
  createdAt: string;
  updatedAt: string;
  parentId?: string;
  position: string;
}

// --- Content Blocks ---

interface RichTextSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
}

interface TextBlock extends BaseBlock {
  type: 'text';
  content: {
    segments: RichTextSegment[];
  };
}

interface HeadingBlock extends BaseBlock {
  type: 'heading';
  content: {
    level: 1 | 2 | 3;
    text: string;
  };
}

interface DividerBlock extends BaseBlock {
  type: 'divider';
  content: Record<string, never>;
}

// --- Photo Blocks ---

type PhotoSize = 'small' | 'medium' | 'large' | 'full';
type GroupLayout = 'grid' | 'masonry' | 'carousel' | 'row';

interface PhotoRefBlock extends BaseBlock {
  type: 'photo-ref';
  content: {
    manifestId: string;
    caption?: string;
    size?: PhotoSize;
  };
}

interface PhotoGroupBlock extends BaseBlock {
  type: 'photo-group';
  content: {
    manifestIds: string[];
    layout: GroupLayout;
    columns?: 2 | 3 | 4;
    title?: string;
  };
}

// --- Contextual Blocks ---

interface GeoPoint {
  lat: number;
  lng: number;
}

interface MapMarker extends GeoPoint {
  label?: string;
}

interface MapBlock extends BaseBlock {
  type: 'map';
  content: {
    center?: GeoPoint;
    zoom?: number;
    manifestIds?: string[];
    markers?: MapMarker[];
  };
}

type DateFormat = 'date' | 'datetime' | 'year' | 'month';

interface TimelineBlock extends BaseBlock {
  type: 'timeline';
  content: {
    date: string;
    format?: DateFormat;
    label?: string;
  };
}

// --- Container Blocks ---

type SectionStyle = 'card' | 'bordered' | 'plain' | 'highlight';

interface SectionBlock extends BaseBlock {
  type: 'section';
  content: {
    title?: string;
    style?: SectionStyle;
    collapsed?: boolean;
  };
  childIds: string[];
}

// --- Union Type ---

type Block = 
  | TextBlock
  | HeadingBlock
  | DividerBlock
  | PhotoRefBlock
  | PhotoGroupBlock
  | MapBlock
  | TimelineBlock
  | SectionBlock;

// --- Album Content Document ---

interface AlbumContent {
  version: typeof BLOCK_FORMAT_VERSION;
  albumId: string;
  rootBlockIds: string[];
  blocks: Record<string, Block>;
  updatedAt: string;
}

// --- Server Types ---

interface EncryptedAlbumContent {
  /** XChaCha20-Poly1305 encrypted AlbumContent JSON */
  encryptedContent: Uint8Array;
  /** Ed25519 signature */
  signature: string;
  /** Signer pubkey */
  signerPubkey: string;
  /** Album version when last updated */
  versionUpdated: number;
}
```

---

## Appendix B: Encryption Example

```typescript
// Crypto worker implementation
async function encryptAlbumContent(
  content: AlbumContent,
  epochSeed: Uint8Array,
  signSecretKey: Uint8Array,
  signPublicKey: Uint8Array,
): Promise<EncryptedAlbumContent> {
  // Derive block key from epoch seed
  const blockKey = hkdfExpand(epochSeed, BLOCK_KEY_CONTEXT, 32);
  
  try {
    // Serialize to JSON
    const plaintext = new TextEncoder().encode(JSON.stringify(content));
    
    // Generate fresh nonce
    const nonce = sodium.randombytes_buf(24);
    
    // Encrypt with XChaCha20-Poly1305
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      null, // No additional data
      null,
      nonce,
      blockKey
    );
    
    // Combine nonce + ciphertext
    const envelope = new Uint8Array(nonce.length + ciphertext.length);
    envelope.set(nonce, 0);
    envelope.set(ciphertext, nonce.length);
    
    // Sign the encrypted content
    const signatureInput = new TextEncoder().encode(BLOCK_SIGN_CONTEXT);
    const toSign = new Uint8Array(signatureInput.length + envelope.length);
    toSign.set(signatureInput, 0);
    toSign.set(envelope, signatureInput.length);
    
    const signature = sodium.crypto_sign_detached(toSign, signSecretKey);
    
    return {
      encryptedContent: envelope,
      signature: sodium.to_base64(signature),
      signerPubkey: sodium.to_base64(signPublicKey),
      versionUpdated: Date.now(),
    };
  } finally {
    // Zero sensitive key material
    sodium.memzero(blockKey);
  }
}

async function decryptAlbumContent(
  encrypted: EncryptedAlbumContent,
  epochSeed: Uint8Array,
  signPublicKey: Uint8Array,
): Promise<AlbumContent> {
  // Verify signature first
  const signatureInput = new TextEncoder().encode(BLOCK_SIGN_CONTEXT);
  const toVerify = new Uint8Array(
    signatureInput.length + encrypted.encryptedContent.length
  );
  toVerify.set(signatureInput, 0);
  toVerify.set(encrypted.encryptedContent, signatureInput.length);
  
  const isValid = sodium.crypto_sign_verify_detached(
    sodium.from_base64(encrypted.signature),
    toVerify,
    signPublicKey
  );
  
  if (!isValid) {
    throw new CryptoError('Invalid block content signature', 'SIGNATURE_INVALID');
  }
  
  // Derive block key
  const blockKey = hkdfExpand(epochSeed, BLOCK_KEY_CONTEXT, 32);
  
  try {
    // Extract nonce and ciphertext
    const nonce = encrypted.encryptedContent.slice(0, 24);
    const ciphertext = encrypted.encryptedContent.slice(24);
    
    // Decrypt
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      null,
      nonce,
      blockKey
    );
    
    // Parse JSON
    const content = JSON.parse(new TextDecoder().decode(plaintext));
    
    // Validate format version
    if (content.version !== BLOCK_FORMAT_VERSION) {
      throw new CryptoError(
        `Unsupported block format version: ${content.version}`,
        'INVALID_INPUT'
      );
    }
    
    return content as AlbumContent;
  } finally {
    sodium.memzero(blockKey);
  }
}
```

---

## Appendix C: Migration Path

If Single Document becomes too slow, migrate to Per-Block:

```typescript
// Migration script (run client-side)
async function migrateToPerBlock(albumId: string): Promise<void> {
  // 1. Fetch and decrypt current document
  const encrypted = await api.getAlbumContent(albumId);
  const content = await decryptAlbumContent(encrypted, epochKey);
  
  // 2. Create individual block records
  const blockRecords = Object.values(content.blocks).map(block => ({
    id: block.id,
    albumId,
    type: block.type,
    position: block.position,
    parentId: block.parentId,
    content: block.content,
  }));
  
  // 3. Upload to new per-block API
  await api.migrateBlocks(albumId, blockRecords);
  
  // 4. Delete old document
  await api.deleteAlbumContent(albumId);
}
```

---

**End of Specification**
