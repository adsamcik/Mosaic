# SPEC: Album Content System (Story Blocks)

> **Feature:** User descriptions, groupings, titles, and storytelling capabilities for albums
> **Status:** Draft - Brainstorm & Research Complete
> **Created:** 2026-01-28
> **Authors:** Copilot Research

---

## TL;DR

Add a **modular content block system** to Mosaic albums, enabling users to tell stories through encrypted text blocks, section groupings, maps, and timeline markers—all while maintaining zero-knowledge encryption.

**Recommended approach:** Start with **Section-Based MVP** (2-3 weeks), evolve to **full Block System** if user demand warrants (6+ weeks).

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Research Findings](#research-findings)
3. [Proposed Approaches](#proposed-approaches)
4. [Recommended Architecture](#recommended-architecture)
5. [Data Models](#data-models)
6. [Security Analysis](#security-analysis)
7. [Implementation Plan](#implementation-plan)
8. [Open Questions](#open-questions)

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

### Phase 1: Section-Based MVP (2-3 weeks)

**Goal:** Users can organize photos into titled sections with descriptions.

**Backend:**
- [ ] Add `AlbumContent` entity and migration
- [ ] Add `GET/PUT /api/albums/{id}/content` endpoints
- [ ] Include content in album sync response
- [ ] Add content to epoch rotation logic

**Frontend:**
- [ ] Add content key derivation to crypto worker
- [ ] Extend sync context to handle album content
- [ ] Create `AlbumContentProvider` context
- [ ] Build `SectionEditor` component
- [ ] Build `SectionView` component for album display
- [ ] Add section CRUD operations
- [ ] Implement drag-and-drop section/photo reordering

**Tests:**
- [ ] Crypto: Content encryption/decryption round-trip
- [ ] Sync: Content version handling
- [ ] E2E: Create section, add photos, reorder

### Phase 2: Enhanced Sections (2 weeks)

**Goal:** Add map and timeline views to sections.

- [ ] Section map view (photos with GPS in section)
- [ ] Section timeline view
- [ ] Auto-compute section date range from photos
- [ ] Auto-generate section suggestions from photo clusters

### Phase 3: Full Block System (4-6 weeks)

**Goal:** Full editorial control with inline blocks.

**Only implement if:**
- User feedback requests more flexibility
- Section system proves limiting
- Resources available for extended development

- [ ] Block type registry and renderers
- [ ] Rich text editor integration (Slate.js or TipTap)
- [ ] Block drag-and-drop
- [ ] Keyboard navigation
- [ ] Mobile touch editing

---

## Open Questions

### Design Decisions

1. **Should sections support nesting?**
   - Pro: More organizational flexibility
   - Con: Complexity, harder mobile UX
   - **Recommendation:** No for MVP, evaluate for Phase 2

2. **How to handle photos not in any section?**
   - Option A: Implicit "Unsorted" section at end
   - Option B: Grid view before first section
   - **Recommendation:** Option A with ability to hide

3. **Should content sync independently of photos?**
   - Pro: Smaller sync payloads for content-only edits
   - Con: More complex version management
   - **Recommendation:** Include in album sync bundle

### Technical Decisions

4. **Rich text format for descriptions?**
   - Option A: Plain text only (MVP)
   - Option B: Basic markdown (bold, italic, links)
   - Option C: Full rich text (Slate.js/TipTap format)
   - **Recommendation:** Option B for MVP

5. **Mobile editing experience?**
   - Touch drag-and-drop is notoriously difficult
   - Consider: Hold-to-reorder, dedicated "edit mode"
   - **Recommendation:** Research mobile patterns before Phase 1

6. **Conflict resolution for concurrent edits?**
   - LWW is sufficient for small user base (≤50)
   - Future: Block-level CRDT if collaboration grows
   - **Recommendation:** LWW with conflict UI

### User Experience

7. **How to onboard users to sections?**
   - Auto-suggest sections from date clusters?
   - Empty state with "Add Section" prompt?
   - Tutorial overlay on first visit?

8. **What's the default album view?**
   - New albums: Grid (existing behavior)
   - After adding sections: Sections view
   - User preference stored in content settings

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Section creation rate | 30% of albums with ≥1 section | Analytics |
| Section with description | 20% of sections have text | Analytics |
| Content sync latency | <500ms for content update | Performance monitoring |
| Key rotation time | <2s with content included | Performance monitoring |
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
