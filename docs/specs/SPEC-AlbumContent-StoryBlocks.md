# SPEC: Album Content System (Story Blocks)

> **Feature:** User descriptions, groupings, titles, and storytelling capabilities for albums
> **Status:** Draft - Full Feature Design Complete
> **Created:** 2026-01-28
> **Updated:** 2026-01-29
> **Authors:** Copilot Research

---

## TL;DR

Add a **modular content block system** to Mosaic albums, enabling users to tell stories through encrypted text blocks, section groupings, maps, and timeline markers—all while maintaining zero-knowledge encryption.

**Target:** Full block-based system with phased rollout (v1 Core → v1.5 Geographic → v2 Rich Layouts).

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Research Findings](#research-findings)
3. [Proposed Approaches](#proposed-approaches)
4. [Recommended Architecture](#recommended-architecture)
5. [Data Models](#data-models)
6. [Security Analysis](#security-analysis)
7. [Implementation Plan](#implementation-plan)
8. [Multi-Perspective Design Research](#multi-perspective-design-research)
9. [Block Type Catalog](#block-type-catalog)
10. [Resolved Design Decisions](#resolved-design-decisions)
11. [Success Metrics](#success-metrics)

---

## Executive Summary

### The Problem

Currently, Mosaic albums are flat collections of photos. Users cannot:
- Add titles or descriptions that appear *within* the album view
- Group photos into logical sections (e.g., "Day 1", "The Beach House")
- Add narrative text between photo groups
- Create a visual story flow with their photos

### The Opportunity

Transform albums from "photo dumps" into **curated stories** that users can share, combining:
- 📝 **Text blocks** for descriptions and captions
- 📁 **Sections** for logical grouping with titles
- 🗺️ **Map views** showing photo locations
- 📅 **Timeline markers** for date-based navigation
- 🖼️ **Custom layouts** (hero images, grids, side-by-side)

### Key Constraints

| Constraint | Requirement |
|------------|-------------|
| **Zero-Knowledge** | Server NEVER sees block content, ordering, or structure |
| **Sync-Compatible** | Must work with existing version-based sync |
| **Extensible** | Easy to add new block types later |
| **Performant** | Handle 1000+ photos with narrative content |
| **Mobile-Friendly** | Touch-based editing on mobile devices |

---

## Research Findings

### Prior Art Analysis

| System | Approach | Pros | Cons |
|--------|----------|------|------|
| **Notion** | Block-based with nesting | Highly flexible, extensible | Complex sync, overkill for photos |
| **WordPress Gutenberg** | Block-based, flat | Mature ecosystem, good UX | No encryption story |
| **Google Photos Memories** | Auto-generated stories | Smart clustering | No user control |
| **Apple Photos** | Section-based | Simple mental model | Limited customization |
| **Flickr Albums** | Description + flat photos | Simple | No inline content |

### Key Insights

1. **Notion's data model** uses a block-tree structure where each block has:
   - Unique ID (UUIDv4)
   - Type discriminator (paragraph, heading, image, etc.)
   - Parent reference (for nesting)
   - Type-specific properties

2. **Zero-knowledge encryption** is well-established in password managers (Dashlane, Bitwarden) using:
   - Client-side encryption with derived keys
   - HKDF for domain separation between key types
   - Single encrypted blobs for atomic updates

3. **Photo organization patterns** show users prefer:
   - Date-based automatic grouping (80% use case)
   - Manual sections with custom titles (60% use case)
   - Inline descriptions (40% use case)
   - Custom ordering (30% use case)

---

## Proposed Approaches

### Approach A: Full Block System

A Notion-like block editor where everything is a block:

```typescript
type Block =
  | { type: 'heading'; level: 1 | 2 | 3; text: RichText[] }
  | { type: 'paragraph'; text: RichText[] }
  | { type: 'photo'; manifestId: string; caption?: RichText[] }
  | { type: 'photo-group'; manifestIds: string[]; layout: GridLayout }
  | { type: 'map'; center?: { lat: number; lng: number }; photos: string[] }
  | { type: 'timeline'; date: string; label?: string }
  | { type: 'divider'; style: 'line' | 'dots' | 'space' }
  | { type: 'section'; title?: string; children: Block[] };
```

| Pros | Cons |
|------|------|
| Maximum flexibility | 6-8 weeks implementation |
| Extensible to any content type | Complex drag-and-drop UI |
| Rich text anywhere | Higher sync complexity |
| Future-proof | Steeper learning curve for users |

### Approach B: Section-Based Structure

A simpler model where sections group photos:

```typescript
interface Section {
  id: string;
  title?: string;
  description?: string;
  coverPhotoId?: string;
  dateRange?: { start: string; end: string };
  position: string; // Fractional index for ordering
}

interface PhotoMeta {
  // ... existing fields ...
  sectionId?: string;
  sectionPosition?: string;
}
```

| Pros | Cons |
|------|------|
| 2-3 weeks implementation | No inline text between photos |
| Simple mental model | Limited layout options |
| Easy sync (one encrypted blob) | Less flexible than blocks |
| Low risk | May need rework for full blocks later |

### Approach C: Hybrid (Recommended)

**Start with Sections, design for Block evolution:**

1. **Phase 1 (MVP):** Sections with title + description
2. **Phase 2:** Add special blocks (map, timeline) to sections
3. **Phase 3:** Full block system if user demand exists

```typescript
// Phase 1: Sections contain photos
interface Section {
  id: string;
  title?: string;
  description?: string;
  photos: string[]; // Ordered photo manifest IDs
  position: string;
}

// Phase 2: Sections can contain blocks OR photos
interface Section {
  id: string;
  title?: string;
  children: (Block | PhotoRef)[];
  position: string;
}

// Phase 3: Everything is a block
type Block = SectionBlock | HeadingBlock | PhotoBlock | ...;
```

---

## Recommended Architecture

### Core Concept: Album Content Document

A single encrypted document per album containing all structural content:

```
┌─────────────────────────────────────────────────────────────┐
│                    AlbumContentDocument                      │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ sections: [                                            │ │
│  │   {                                                    │ │
│  │     id: "section-1",                                   │ │
│  │     title: "Arrival in Paris",                        │ │
│  │     description: "We landed on a rainy morning...",   │ │
│  │     photoIds: ["photo-a", "photo-b", "photo-c"],      │ │
│  │     position: "a0"                                     │ │
│  │   },                                                   │ │
│  │   {                                                    │ │
│  │     id: "section-2",                                   │ │
│  │     title: "The Eiffel Tower",                        │ │
│  │     description: null,                                 │ │
│  │     photoIds: ["photo-d", "photo-e"],                 │ │
│  │     position: "a1"                                     │ │
│  │   }                                                    │ │
│  │ ],                                                     │ │
│  │ unsortedPhotoIds: ["photo-f", "photo-g"],             │ │
│  │ settings: {                                            │ │
│  │   showMap: true,                                       │ │
│  │   showTimeline: false                                  │ │
│  │ }                                                      │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  Encrypted with epoch-derived block key                     │
│  Signed with epoch sign key                                  │
└─────────────────────────────────────────────────────────────┘
```

### Why Single Document?

| Alternative | Problem |
|-------------|---------|
| Per-block encryption | Server sees block count, structure, operation patterns |
| Plaintext ordering | **Violates ZK** - structure is meaningful metadata |
| Per-section blobs | More complex sync, still leaks section count |

**Single document benefits:**
- ✅ Zero-knowledge: Server sees one opaque blob
- ✅ Atomic updates: No partial state
- ✅ Simple sync: One version counter
- ✅ Easy key rotation: One re-encryption

### Storage Location

**Backend entity:**

```csharp
public class AlbumContent
{
    public Guid AlbumId { get; set; } // PK + FK to Album
    public long Version { get; set; }
    public byte[] EncryptedContent { get; set; }
    public string Signature { get; set; }
    public string SignerPubkey { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public uint RowVersion { get; set; } // Concurrency token
    
    public Album Album { get; set; } = null!;
}
```

**Client-side SQLite:**

```sql
CREATE TABLE album_content (
  album_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  encrypted_content BLOB NOT NULL,
  signature TEXT NOT NULL,
  signer_pubkey TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

## Data Models

### TypeScript Interfaces (Client-Side)

```typescript
// ─── Album Content Document ───────────────────────────────

/** Format version for migrations */
const ALBUM_CONTENT_VERSION = 1;

/** Plaintext structure encrypted as single blob */
interface AlbumContentDocument {
  /** Format version for future migrations */
  version: typeof ALBUM_CONTENT_VERSION;
  
  /** Ordered sections */
  sections: Section[];
  
  /** Photo IDs not assigned to any section */
  unsortedPhotoIds: string[];
  
  /** Album-level content settings */
  settings: AlbumContentSettings;
}

interface AlbumContentSettings {
  /** Show map view in album */
  showMap: boolean;
  /** Show timeline navigation */
  showTimeline: boolean;
  /** Default view mode */
  defaultView: 'sections' | 'grid' | 'timeline';
}

// ─── Section Model ────────────────────────────────────────

interface Section {
  /** Unique identifier (UUIDv4) */
  id: string;
  
  /** Section title (optional) */
  title?: string;
  
  /** Section description (optional, supports basic markdown) */
  description?: string;
  
  /** ID of photo to use as section cover */
  coverPhotoId?: string;
  
  /** Date range (computed from photos or manual override) */
  dateRange?: {
    start: string; // ISO 8601
    end: string;
  };
  
  /** Location (computed from photos or manual override) */
  location?: {
    name?: string;
    lat: number;
    lng: number;
  };
  
  /** Ordered photo manifest IDs in this section */
  photoIds: string[];
  
  /** Fractional index for section ordering */
  position: string;
}

// ─── Future Block Types (Phase 2+) ────────────────────────

/** Discriminated union for future extensibility */
type ContentBlock =
  | HeadingBlock
  | ParagraphBlock
  | PhotoRefBlock
  | PhotoGroupBlock
  | MapBlock
  | TimelineBlock
  | DividerBlock;

interface HeadingBlock {
  type: 'heading';
  id: string;
  level: 1 | 2 | 3;
  text: string;
  position: string;
}

interface ParagraphBlock {
  type: 'paragraph';
  id: string;
  text: string; // Basic markdown support
  position: string;
}

interface PhotoRefBlock {
  type: 'photo';
  id: string;
  manifestId: string;
  caption?: string;
  position: string;
}

interface PhotoGroupBlock {
  type: 'photo-group';
  id: string;
  manifestIds: string[];
  layout: 'grid' | 'masonry' | 'carousel';
  columns?: 2 | 3 | 4;
  position: string;
}

interface MapBlock {
  type: 'map';
  id: string;
  /** Photo IDs to show on map (or 'all' for section/album) */
  photoIds: string[] | 'all';
  /** Optional override for map center */
  center?: { lat: number; lng: number; zoom: number };
  position: string;
}

interface TimelineBlock {
  type: 'timeline';
  id: string;
  date: string;
  label?: string;
  position: string;
}

interface DividerBlock {
  type: 'divider';
  id: string;
  style: 'line' | 'dots' | 'space';
  position: string;
}
```

### Backend DTOs

```csharp
// ─── API Request/Response ─────────────────────────────────

/// <summary>Request to update album content</summary>
public record UpdateAlbumContentRequest(
    byte[] EncryptedContent,
    string Signature,
    string SignerPubkey,
    long ExpectedVersion
);

/// <summary>Album content sync response</summary>
public record AlbumContentResponse(
    Guid AlbumId,
    long Version,
    byte[] EncryptedContent,
    string Signature,
    string SignerPubkey,
    DateTime UpdatedAt
);
```

### Fractional Indexing for Ordering

Use `fractional-indexing` library pattern for position strings:

```typescript
import { generateKeyBetween } from 'fractional-indexing';

// Initial sections
const positions = [
  generateKeyBetween(null, null),    // "a0"
  generateKeyBetween("a0", null),    // "a1"
  generateKeyBetween("a1", null),    // "a2"
];

// Insert between a0 and a1
const newPos = generateKeyBetween("a0", "a1"); // "a0V"

// Move a2 to beginning
const newFirst = generateKeyBetween(null, "a0"); // "Zz"
```

---

## Security Analysis

### Encryption Strategy

**Key Derivation (HKDF Domain Separation):**

```
Epoch Seed (32 bytes)
    │
    ├─► HKDF("mosaic:tier:thumb:v1")    → Thumbnail key
    ├─► HKDF("mosaic:tier:preview:v1")  → Preview key  
    ├─► HKDF("mosaic:tier:full:v1")     → Original key
    └─► HKDF("mosaic:tier:content:v1")  → Content key (NEW)
```

**Implementation:**

```typescript
const CONTENT_KEY_CONTEXT = "mosaic:tier:content:v1";

async function deriveContentKey(epochSeed: Uint8Array): Promise<Uint8Array> {
  return sodium.crypto_generichash(
    32,
    epochSeed,
    sodium.from_string(CONTENT_KEY_CONTEXT)
  );
}

async function encryptAlbumContent(
  content: AlbumContentDocument,
  epochSeed: Uint8Array,
  epochId: number
): Promise<EncryptedEnvelope> {
  const contentKey = await deriveContentKey(epochSeed);
  
  try {
    const plaintext = msgpack.encode(content);
    const nonce = sodium.randombytes_buf(24);
    
    // Build header (64 bytes, matches shard format)
    const header = buildEnvelopeHeader({
      version: 3,
      epochId,
      shardIndex: 0, // Reserved for content
      nonce,
      tier: 5, // CONTENT tier
    });
    
    // Encrypt with AAD = header
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      header, // AAD
      nonce,
      contentKey
    );
    
    return { header, ciphertext };
  } finally {
    sodium.memzero(contentKey);
  }
}
```

### Zero-Knowledge Invariants

| Data Element | Encrypted? | Rationale |
|--------------|------------|-----------|
| Section titles | ✅ Yes | User content |
| Section descriptions | ✅ Yes | User content |
| Section ordering | ✅ Yes | Structure is metadata |
| Photo-to-section mapping | ✅ Yes | Organization is metadata |
| Section count | ✅ Yes (inside blob) | Leaks album complexity |
| Content blob size | ⚠️ Visible | Unavoidable; optional padding |
| Content version | ❌ Plaintext | Ordering metadata only |
| Album ID | ❌ Plaintext | Routing requirement |

### Signature Verification

```typescript
const CONTENT_SIGN_CONTEXT = "Mosaic_AlbumContent_v1";

async function signAlbumContent(
  encryptedContent: Uint8Array,
  signSecretKey: Uint8Array
): Promise<Uint8Array> {
  const message = concatBytes(
    sodium.from_string(CONTENT_SIGN_CONTEXT),
    encryptedContent
  );
  return sodium.crypto_sign_detached(message, signSecretKey);
}
```

### Access Control

| Actor | Can View Content? | Can Edit Content? |
|-------|-------------------|-------------------|
| Album Owner | ✅ | ✅ |
| Member (Editor) | ✅ | ✅ |
| Member (Viewer) | ✅ | ❌ |
| Share Link (PREVIEW+) | ✅ | ❌ |
| Share Link (THUMB only) | ❌ | ❌ |
| Server | ❌ | ❌ |

### Key Rotation Impact

When rotating epoch keys:

```typescript
async function rotateEpochWithContent(
  albumId: string,
  oldEpochSeed: Uint8Array,
  newEpochSeed: Uint8Array,
  newEpochId: number
): Promise<void> {
  // 1. Decrypt with old key
  const oldContentKey = await deriveContentKey(oldEpochSeed);
  const content = await decryptAlbumContent(existingBlob, oldContentKey);
  sodium.memzero(oldContentKey);
  
  // 2. Re-encrypt with new key
  const newBlob = await encryptAlbumContent(content, newEpochSeed, newEpochId);
  
  // 3. Include in rotation request
  await api.rotateEpoch(albumId, {
    ...existingPayload,
    encryptedContent: newBlob,
    contentSignature: await signAlbumContent(newBlob, newSignKey),
  });
}
```

---

## Implementation Plan

### Phase 1: Core Block System (3-4 weeks)

**Goal:** Full block-based editor with essential block types.

**Block Types for v1:**

| Block | Priority | Effort | Description |
|-------|----------|--------|-------------|
| **HeadingBlock** | P0 | 1d | H1, H2, H3 section titles |
| **TextBlock** | P0 | 3d | Rich text with bold/italic/links |
| **PhotoBlock** | P0 | 2d | Single photo with optional caption |
| **PhotoGroupBlock** | P0 | 5d | Grid/masonry/carousel layouts |
| **DividerBlock** | P0 | 0.5d | Line, dots, or whitespace |
| **SectionBlock** | P0 | 3d | Container for grouping blocks |

**Backend:**

- [ ] Add `AlbumContent` entity and migration
- [ ] Add `GET/PUT /api/albums/{id}/content` endpoints
- [ ] Include content in album sync response
- [ ] Add content to epoch rotation logic
- [ ] Version-based concurrency control

**Frontend - Editor:**

- [ ] TipTap integration for rich text editing
- [ ] Block type registry with schemas (Zod validation)
- [ ] `@dnd-kit` for block reordering
- [ ] Fractional indexing for position management
- [ ] Slash command (`/`) for adding blocks
- [ ] Block toolbar (hover controls)
- [ ] Debounced autosave (1500ms)

**Frontend - Rendering:**

- [ ] `AlbumContentProvider` context
- [ ] Block renderers for each type
- [ ] Read-only view mode
- [ ] Photo picker modal for PhotoBlock/PhotoGroupBlock

**Crypto:**

- [ ] `deriveContentKey()` with HKDF domain separation
- [ ] Encrypt/decrypt album content document
- [ ] Signature verification before decrypt
- [ ] Key rotation with content re-encryption

**Tests:**

- [ ] Crypto: Round-trip encryption/decryption
- [ ] Validation: Block schema validation with malformed data
- [ ] Sync: Version conflict handling
- [ ] E2E: Create blocks, reorder, edit, delete

### Phase 1.5: Geographic & Temporal (3 weeks)

**Goal:** Location and time-based storytelling features.

| Block | Priority | Effort | Description |
|-------|----------|--------|-------------|
| **MapBlock** | P1 | 5d | Leaflet map showing photo locations |
| **TimelineMarker** | P1 | 2d | Date waypoint in content flow |
| **DateRangeBlock** | P1 | 1d | Trip duration display |
| **TableOfContentsBlock** | P1 | 2d | Auto-generated from headings |
| **HeroBlock** | P1 | 2d | Full-width banner image |

**Features:**

- [ ] Map integration with existing Leaflet/Supercluster
- [ ] Auto-compute location/date metadata from photos in section
- [ ] Collapsible sections (expand/collapse)
- [ ] Quote and callout blocks

### Phase 2: Rich Layouts & Interaction (4-6 weeks)

**Goal:** Advanced layouts and interactive features.

| Block | Priority | Effort | Description |
|-------|----------|--------|-------------|
| **JourneyMapBlock** | P2 | 8d | Route visualization with photo waypoints |
| **BeforeAfterBlock** | P2 | 4d | Comparison slider for two photos |
| **SlideshowBlock** | P2 | 5d | Auto-playing presentation mode |
| **ColumnLayoutBlock** | P2 | 3d | 2/3 column layouts |
| **TabbedContentBlock** | P2 | 4d | Multi-view sections |

**Features:**

- [ ] Column layouts for text + photo side-by-side
- [ ] Slideshow presentation mode
- [ ] Before/after comparison slider
- [ ] Album linking (related albums)
- [ ] Photo statistics block

### Future Vision (v3+)

| Block | Notes |
|-------|-------|
| **VideoBlock** | Requires video upload support |
| **AudioBlock** | Voice notes, ambient audio |
| **TimelapseMapBlock** | Animated journey replay |
| **WeatherBlock** | Historical weather at photo time/place |
| **PanoramaViewer** | 360° photo support |
| **AutoCaptionBlock** | Client-side AI captions (on-device inference) |

---

## Multi-Perspective Design Research

### UX/Editor Design

**Editor Mode Decision:**
No explicit View/Edit toggle. Follow Notion/Apple Notes model where content is always editable for authorized users. Controls appear contextually:
- Viewing: Clean, minimal UI
- Focused: Block outline + drag handle
- Editing: Caret visible + inline toolbar

**Block Manipulation UX:**

| Action | Desktop | Mobile |
|--------|---------|--------|
| Add block | Slash command `/` or hover `(+)` | Floating Action Button (FAB) |
| Reorder | Drag handle on left | Long-press + drag, or "Reorder Mode" |
| Delete | Immediate with undo toast (5s) | Same |
| Multi-select | Shift+click range | Enter selection mode |

**Rich Text:**
Minimal but polished: Bold, italic, links, quotes only. Support both inline toolbar on selection and Markdown shortcuts (`**bold**`, `*italic*`).

**Recommended Libraries:**

| Need | Library | Rationale |
|------|---------|-----------|
| Rich text | **TipTap** | Excellent block customization, TypeScript-first, Y.js support |
| Drag & drop | **@dnd-kit** | Touch-native, keyboard support, works with virtualization |
| Ordering | **fractional-indexing** | Efficient reordering without array shifts |

**Mobile Considerations:**
- FAB button for adding blocks (always visible)
- Long-press for context menus
- Formatting toolbar fixed above keyboard
- Explicit "Reorder Mode" toggle (touch drag-drop is notoriously difficult)

### Performance Analysis

**Key Benchmarks:**

| Operation | 50 Blocks (~40KB) | 500 Blocks (~400KB) |
|-----------|-------------------|---------------------|
| Encrypt time | <2 ms | 10-15 ms |
| Decrypt time | <2 ms | 10-15 ms |
| Full render | <50 ms | <200 ms |

**Performance Budgets:**

| Metric | Target | Warning | Error |
|--------|--------|---------|-------|
| Content encryption | <15ms | >50ms | >200ms |
| Initial render | <100ms | >200ms | >500ms |
| Sync latency | <2s | >3s | >10s |
| Memory (blocks) | <50MB | >100MB | >200MB |

**Optimizations:**

- Debounced autosave (1500ms) with force-save on blur
- TanStack Virtual only for >50 blocks
- Lazy-load photo thumbnails in PhotoGroupBlock
- Undo stack limit: 20 states / 5MB max
- Clear content cache on album navigation

### Sync & Conflict Resolution

**Strategy: Block-Level Merge with LWW Fallback**

| Scenario | Resolution |
|----------|------------|
| Two users add blocks at same position | Fractional indexing handles |
| Two users edit same block | Block-level merge with LWW fallback |
| Offline edits reconnecting | Three-way merge + conflict notification |
| Edit during key rotation | Detect epoch mismatch, re-encrypt |

**Sync Protocol:**

```typescript
interface AlbumContentSync {
  albumId: string;
  version: number;
  encryptedContent: Uint8Array;
  signature: Uint8Array;
  signerPubkey: Uint8Array;
  expectedVersion: number; // For optimistic concurrency
}
```

**Conflict UX:**
- 95% of conflicts auto-merge (different blocks, additions, reorderings)
- Toast notification + optional resolution dialog for remaining 5%
- Version history snapshots for recovery

**Future Path to CRDTs:**
Design allows migration to Yjs/Secsync for real-time collaboration if needed.

### Security Requirements

**Must Have (P0):**

| ID | Requirement |
|----|-------------|
| S-001 | URL scheme allowlist for hrefs (no `javascript:`, `data:`, `vbscript:`) |
| S-002 | Never use `dangerouslySetInnerHTML` for block content |
| S-003 | Strict Zod schema validation on every decrypt |
| S-004 | Graceful handling of malformed blocks (no crashes) |
| S-005 | Content size limits enforced client-side |
| S-006 | Fresh `randombytes_buf(24)` nonce per encryption call |
| S-007 | Signature verification BEFORE decryption |
| S-008 | No external resource loading in rich text |
| S-009 | `memzero()` on all key material after use |
| S-010 | Strip HTML on paste, extract plain text only |

**Should Have (P1):**

| ID | Requirement |
|----|-------------|
| S-011 | Minimum padding for small blocks (512 bytes) |
| S-012 | Version binding in signatures (replay prevention) |
| S-013 | Separate `contentKey` derivation for share link tiers |
| S-014 | Read-only mode enforcement for share link viewers |
| S-015 | Rate limiting on block creation |
| S-016 | Soft delete with retention period |
| S-017 | CSP headers blocking inline scripts and external images |

**XSS Prevention:**

```typescript
// REQUIRED: URL scheme allowlist
const ALLOWED_URL_SCHEMES = ['https:', 'http:', 'mailto:'];

function sanitizeHref(href: string): string | null {
  try {
    const url = new URL(href);
    if (!ALLOWED_URL_SCHEMES.includes(url.protocol)) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}
```

**Size Correlation Attack Mitigation:**

```typescript
// Pad small blocks to prevent type inference
const MIN_ENCRYPTED_SIZE = 512;

function encryptWithPadding(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  const targetSize = Math.max(MIN_ENCRYPTED_SIZE, 1 << Math.ceil(Math.log2(plaintext.length + 1)));
  const padded = new Uint8Array(Math.min(targetSize, 64 * 1024));
  padded.set(plaintext);
  // Random fill remainder
  crypto.getRandomValues(padded.subarray(plaintext.length + 4));
  new DataView(padded.buffer).setUint32(plaintext.length, plaintext.length, true);
  return encrypt(padded, key);
}
```

---

## Block Type Catalog

### Category 1: Core Content (v1)

```typescript
interface HeadingBlock {
  type: 'heading';
  id: string;
  level: 1 | 2 | 3;
  text: string;
  position: string;
}

interface TextBlock {
  type: 'text';
  id: string;
  segments: RichTextSegment[];
  position: string;
}

interface RichTextSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string; // Must pass sanitizeHref()
}

interface PhotoBlock {
  type: 'photo';
  id: string;
  manifestId: string;
  caption?: RichTextSegment[];
  position: string;
}

interface PhotoGroupBlock {
  type: 'photo-group';
  id: string;
  manifestIds: string[];
  layout: 'grid' | 'masonry' | 'carousel' | 'row';
  columns?: 2 | 3 | 4;
  position: string;
}

interface DividerBlock {
  type: 'divider';
  id: string;
  style: 'line' | 'dots' | 'space';
  position: string;
}

interface SectionBlock {
  type: 'section';
  id: string;
  title?: string;
  collapsed?: boolean;
  childIds: string[]; // References to other blocks
  position: string;
}
```

### Category 2: Geographic (v1.5)

```typescript
interface MapBlock {
  type: 'map';
  id: string;
  photoIds: string[] | 'all';
  center?: { lat: number; lng: number; zoom: number };
  position: string;
}

interface TimelineMarkerBlock {
  type: 'timeline';
  id: string;
  date: string; // ISO 8601
  label?: string;
  position: string;
}
```

### Category 3: Layout (v2)

```typescript
interface HeroBlock {
  type: 'hero';
  id: string;
  manifestId: string;
  overlayText?: string;
  position: string;
}

interface ColumnLayoutBlock {
  type: 'columns';
  id: string;
  columns: 2 | 3;
  childIds: string[][]; // Array of block IDs per column
  position: string;
}

interface BeforeAfterBlock {
  type: 'before-after';
  id: string;
  beforeManifestId: string;
  afterManifestId: string;
  position: string;
}
```

---

## Resolved Design Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Section nesting? | **Max 2 levels** (Section → Blocks) | Simpler UX, mobile-friendly |
| Photos not in blocks? | **Implicit "Unsorted" section** at end | Backwards compatible |
| Content sync? | **With album sync bundle** | Simpler version management |
| Rich text format? | **TipTap internal format** (not Markdown) | Richer editing, better UX |
| Mobile editing? | **Explicit "Reorder Mode"** toggle | Touch drag-drop is unreliable |
| Conflict resolution? | **Block-level merge + LWW** | Balance of simplicity and correctness |
| Onboarding? | **Templates + slash commands** | Guided but not restrictive |
| Default view? | **Grid until user adds blocks** | Preserve existing behavior |

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Block adoption | 40% of albums with ≥1 block | Analytics |
| Text block usage | 25% of albums with narrative text | Analytics |
| Map block usage | 15% of albums with map | Analytics |
| Content sync latency | <500ms for content update | Performance monitoring |
| Key rotation time | <2s with content included | Performance monitoring |
| Editor performance | <100ms initial render | Performance monitoring |
| User satisfaction | Positive feedback on storytelling | User interviews |

---

## References

- [Notion Block API Documentation](https://developers.notion.com/reference/block)
- [WordPress Gutenberg Block Editor](https://developer.wordpress.org/block-editor/)
- [Fractional Indexing for Ordering](https://www.figma.com/blog/realtime-editing-of-ordered-sequences/)
- [Zero-Knowledge Architecture (Dashlane)](https://www.dashlane.com/blog/security-terms-101)
- [HKDF RFC 5869](https://datatracker.ietf.org/doc/html/rfc5869)

---

## Appendix: Migration from Sections to Blocks

If Phase 3 is needed, sections can migrate to blocks:

```typescript
function migrateToBlocks(sections: Section[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  
  for (const section of sections) {
    // Section title → HeadingBlock
    if (section.title) {
      blocks.push({
        type: 'heading',
        id: generateId(),
        level: 2,
        text: section.title,
        position: generatePosition(),
      });
    }
    
    // Section description → ParagraphBlock
    if (section.description) {
      blocks.push({
        type: 'paragraph',
        id: generateId(),
        text: section.description,
        position: generatePosition(),
      });
    }
    
    // Photos → PhotoGroupBlock
    if (section.photoIds.length > 0) {
      blocks.push({
        type: 'photo-group',
        id: generateId(),
        manifestIds: section.photoIds,
        layout: 'grid',
        position: generatePosition(),
      });
    }
    
    // Divider between sections
    blocks.push({
      type: 'divider',
      id: generateId(),
      style: 'space',
      position: generatePosition(),
    });
  }
  
  return blocks;
}
```

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-01-28 | Copilot | Initial brainstorm and research |
| 2026-01-29 | Copilot | Full feature design with multi-perspective research (UX, Data Model, Performance, Sync, Block Types, Security). Replaced phased MVP approach with comprehensive block system. Added resolved design decisions, security requirements, and performance budgets. |
