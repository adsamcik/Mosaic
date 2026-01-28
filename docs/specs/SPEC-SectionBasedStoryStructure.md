# SPEC: Section-Based Story Structure for Mosaic Albums

> **Feature:** Lightweight photo storytelling with sections
> **Status:** Research/Design Phase
> **Date:** 2026-01-28
> **Related:** [Block-Based Content System](./SPEC-BlockBasedContentSystem.md) (more complex alternative)

---

## Executive Summary

This specification explores a **section-based approach** to album storytelling—a simpler alternative to the full block-based content system. Instead of arbitrary nested blocks, albums are organized into **flat sections** that group photos with optional titles, descriptions, and metadata.

**Key Philosophy:** Optimize for the 80% use case (grouping photos by event/day/location) rather than full editorial flexibility.

---

## Table of Contents

1. [Core Concepts](#1-core-concepts)
2. [Section Model](#2-section-model)
3. [Data Structure Design](#3-data-structure-design)
4. [Comparison: Sections vs Blocks](#4-comparison-sections-vs-blocks)
5. [Database Schema](#5-database-schema)
6. [Encryption Strategy](#6-encryption-strategy)
7. [User Experience](#7-user-experience)
8. [Migration Path](#8-migration-path)
9. [Pros/Cons Analysis](#9-proscons-analysis)
10. [Recommendation](#10-recommendation)

---

## 1. Core Concepts

### 1.1 What is a Section?

A **Section** is a named container for photos within an album, providing:

| Property | Description |
|----------|-------------|
| **Title** | Optional heading (e.g., "Day 1: Arrival") |
| **Description** | Optional rich text description |
| **Date Range** | Start/end dates (can be auto-calculated from photos) |
| **Location** | Optional location name or GPS bounds |
| **Cover Photo** | Optional featured photo for the section |
| **Order** | Position within the album |

### 1.2 Section Hierarchy Options

#### Option A: Flat Sections (Recommended)

```
Album
 ├── Section: "Day 1: Hiking Trail"
 │    ├── Photo 1
 │    ├── Photo 2
 │    └── Photo 3
 ├── Section: "Day 2: Mountain Summit"
 │    ├── Photo 4
 │    └── Photo 5
 └── Section: "Day 3: Departure"
      └── Photo 6
```

**Pros:** Simple mental model, easy drag-and-drop, predictable rendering
**Cons:** Can't represent nested stories (e.g., chapters within a trip)

#### Option B: Nested Sections (Two Levels Max)

```
Album
 ├── Section: "Italy Trip 2025"
 │    ├── Subsection: "Rome"
 │    │    ├── Photo 1
 │    │    └── Photo 2
 │    └── Subsection: "Florence"
 │         └── Photo 3
 └── Section: "Paris Weekend"
      └── Photo 4
```

**Pros:** More organizational flexibility
**Cons:** Complexity increases significantly

### 1.3 Photos Without Sections

Photos can exist **outside** sections (in an "Unsorted" implicit section) to support:
- Backwards compatibility with existing albums
- Quick uploads before organization
- Simple albums without storytelling structure

---

## 2. Section Model

### 2.1 TypeScript Interface

```typescript
/**
 * Section within an album - groups photos with narrative context
 */
interface Section {
  /** Unique section ID (UUIDv7, client-generated) */
  id: string;
  
  /** Album this section belongs to */
  albumId: string;
  
  /** Ordering position (fractional indexing for efficient reordering) */
  position: string;
  
  /** Optional parent section ID (only if nested sections enabled) */
  parentId?: string;
  
  /** User-provided section title (encrypted) */
  title?: string;
  
  /** Rich text description (encrypted, markdown or HTML subset) */
  description?: string;
  
  /** Date range for this section (can be auto-calculated) */
  dateRange?: {
    start: string; // ISO 8601
    end: string;   // ISO 8601
  };
  
  /** Optional location metadata */
  location?: {
    name?: string;          // Human-readable name
    lat?: number;           // Center point latitude
    lng?: number;           // Center point longitude
    bounds?: {              // Bounding box of all photos
      north: number;
      south: number;
      east: number;
      west: number;
    };
  };
  
  /** Cover photo manifest ID (or auto-select first/best) */
  coverPhotoId?: string;
  
  /** Visual style options */
  style?: {
    /** Show as collapsed by default */
    collapsed?: boolean;
    /** Visual theme */
    theme?: 'default' | 'hero' | 'minimal';
  };
  
  /** Timestamps */
  createdAt: string;
  updatedAt: string;
}

/**
 * Extended photo metadata to include section membership
 */
interface PhotoMeta {
  // ... existing fields ...
  
  /** Section this photo belongs to (null = unsorted) */
  sectionId?: string;
  
  /** Position within section (fractional indexing) */
  sectionPosition?: string;
}
```

### 2.2 Automatic Section Features

Sections can auto-calculate metadata from their photos:

```typescript
interface CalculatedSectionMetadata {
  /** Earliest photo date in section */
  dateStart: string | null;
  
  /** Latest photo date in section */
  dateEnd: string | null;
  
  /** Number of photos in section */
  photoCount: number;
  
  /** Geographic bounding box of geotagged photos */
  bounds: Bounds | null;
  
  /** Most common location name from photos */
  locationName: string | null;
}
```

---

## 3. Data Structure Design

### 3.1 Approach A: Photo-Level Section Assignment

Add `sectionId` to each photo's manifest metadata:

```
┌────────────────────────────────────────────────────────────┐
│ PhotoMeta (in manifest)                                    │
│ {                                                          │
│   id: "photo-1",                                           │
│   sectionId: "section-1",    ← NEW                         │
│   sectionPosition: "a0V",    ← NEW                         │
│   filename: "...",                                         │
│   takenAt: "...",                                          │
│   ...                                                      │
│ }                                                          │
└────────────────────────────────────────────────────────────┘
```

**Pros:**
- No new server-side entities
- Section info travels with photo during sync
- Simple client-side filtering

**Cons:**
- Section metadata (title, description) must be stored separately
- Moving photo between sections = manifest update
- Orphaned sections possible if no photos

### 3.2 Approach B: Separate Section Structure Document

Store sections in a dedicated encrypted document per album:

```
┌─────────────────────────────────────────────────┐
│ AlbumSections (encrypted JSON)                  │
│ {                                               │
│   version: 1,                                   │
│   albumId: "...",                               │
│   sections: [                                   │
│     { id: "s1", title: "Day 1", ... },         │
│     { id: "s2", title: "Day 2", ... },         │
│   ],                                            │
│   photoAssignments: {                           │
│     "photo-1": { sectionId: "s1", pos: "a0" }, │
│     "photo-2": { sectionId: "s1", pos: "a1" }, │
│   }                                             │
│ }                                               │
└─────────────────────────────────────────────────┘
```

**Pros:**
- Section metadata independent of photos
- Single atomic update for reordering
- Clear separation of concerns

**Cons:**
- Additional server entity needed
- Must sync two data streams (manifests + sections)
- Potential for conflicts

### 3.3 Approach C: Hybrid (Recommended)

- **Section metadata** in album-level encrypted document
- **Photo-section assignment** in individual photo manifests The important thing here is the `sectionId` inside manifests provides redundancy/recovery

```
Album
 └── EncryptedSectionDoc: { sections: [...] }
 └── Manifests: [
       { ...photo1, sectionId: "s1", sectionPosition: "a0" },
       { ...photo2, sectionId: "s1", sectionPosition: "a1" },
     ]
```

---

## 4. Comparison: Sections vs Blocks

| Aspect | Section-Based | Block-Based |
|--------|---------------|-------------|
| **Mental Model** | Folders/chapters | Document editor |
| **Content Types** | Photos + text (section level) | Any block anywhere |
| **Nesting** | Flat or 2 levels max | Unlimited |
| **Text Placement** | Per-section description only | Inline between photos |
| **Maps** | Per-section aggregate | Inline map blocks |
| **Timelines** | Auto from section date range | Explicit timeline blocks |
| **Implementation** | ~2 weeks | ~8 weeks |
| **Storage Overhead** | Minimal | Moderate (per-block) |
| **Sync Complexity** | Low | High |
| **Key Rotation** | Simple (one more blob) | Complex (many blocks) |
| **User Learning Curve** | Low (familiar folder model) | Medium (new paradigm) |

### 4.1 Feature Mapping

How block features map to sections:

| Block Feature | Section Equivalent |
|---------------|-------------------|
| `HeadingBlock` | Section title |
| `TextBlock` | Section description |
| `PhotoRefBlock` | Photo in section |
| `PhotoGroupBlock` | Section cover photo + photo grid |
| `MapBlock` | Section location (auto-generated map) |
| `TimelineBlock` | Section date range |
| `DividerBlock` | Section boundary (implicit) |
| `SectionBlock` | First-class Section entity |

**What sections CAN'T do:**
- Inline text between individual photos
- Complex layouts (hero images, side-by-side text/photo)
- Arbitrary nesting depth
- Non-photo content blocks (quotes, callouts)

---

## 5. Database Schema

### 5.1 Backend Schema Changes (PostgreSQL)

```sql
-- No new tables needed for Approach A (photo-level assignment)
-- Section metadata stored encrypted in Album entity

-- For Approach B/C, add optional section storage:
CREATE TABLE album_sections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    album_id UUID NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    version_created BIGINT NOT NULL,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    
    -- Encrypted section structure (client-encrypted)
    encrypted_content BYTEA NOT NULL,
    
    -- Signature for integrity
    signature TEXT NOT NULL,
    signer_pubkey TEXT NOT NULL,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    row_version INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_album_sections_album_id ON album_sections(album_id);
```

### 5.2 C# Entity

```csharp
namespace Mosaic.Backend.Data.Entities;

/// <summary>
/// Encrypted section structure for an album.
/// Single document per album containing all section metadata.
/// </summary>
public class AlbumSectionDocument
{
    public Guid Id { get; set; }
    public Guid AlbumId { get; set; }
    public long VersionCreated { get; set; }
    public bool IsDeleted { get; set; }
    
    /// <summary>
    /// Client-encrypted JSON containing all sections.
    /// Server treats as opaque blob.
    /// </summary>
    public required byte[] EncryptedContent { get; set; }
    
    /// <summary>
    /// Ed25519 signature of encrypted content.
    /// </summary>
    public required string Signature { get; set; }
    
    /// <summary>
    /// Public key used for signing (base64).
    /// </summary>
    public required string SignerPubkey { get; set; }
    
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public uint RowVersion { get; set; }
    
    // Navigation
    public Album Album { get; set; } = null!;
}
```

### 5.3 PhotoMeta Extension

```typescript
// In workers/types.ts - extend PhotoMeta
export interface PhotoMeta {
  // ... existing fields ...
  
  /** Section this photo belongs to (null = unsorted) */
  sectionId?: string;
  
  /** 
   * Position within section for ordering.
   * Uses fractional indexing (e.g., "a0", "a1", "a0V")
   */
  sectionPosition?: string;
}
```

### 5.4 Local SQLite Schema

```sql
-- Section metadata table (client-side only)
CREATE TABLE IF NOT EXISTS sections (
    id TEXT PRIMARY KEY,
    album_id TEXT NOT NULL,
    position TEXT NOT NULL,           -- Fractional index
    parent_id TEXT,                   -- For nested sections
    title TEXT,
    description TEXT,
    date_start TEXT,                  -- ISO 8601
    date_end TEXT,                    -- ISO 8601
    location_name TEXT,
    location_lat REAL,
    location_lng REAL,
    cover_photo_id TEXT,
    style_collapsed INTEGER DEFAULT 0,
    style_theme TEXT DEFAULT 'default',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_sections_album ON sections(album_id);
CREATE INDEX idx_sections_position ON sections(album_id, position);

-- Add section columns to photos table
ALTER TABLE photos ADD COLUMN section_id TEXT;
ALTER TABLE photos ADD COLUMN section_position TEXT;

CREATE INDEX idx_photos_section ON photos(album_id, section_id, section_position);
```

---

## 6. Encryption Strategy

### 6.1 Section Document Encryption

Uses the same epoch key infrastructure as photos:

```typescript
const SECTION_KEY_CONTEXT = "Mosaic_Section_v1";
const SECTION_SIGN_CONTEXT = "Mosaic_SectionSign_v1";

interface EncryptedSectionDocument {
  encryptedContent: Uint8Array;
  signature: string;
  signerPubkey: string;
  epochId: number;
}

interface DecryptedSectionDocument {
  version: 1;
  albumId: string;
  sections: Section[];
  updatedAt: string;
}

async function encryptSectionDocument(
  doc: DecryptedSectionDocument,
  epochSeed: Uint8Array,
  signSecretKey: Uint8Array
): Promise<EncryptedSectionDocument> {
  // Derive section-specific key
  const sectionKey = hkdfExpand(epochSeed, SECTION_KEY_CONTEXT, 32);
  
  try {
    const plaintext = new TextEncoder().encode(JSON.stringify(doc));
    const nonce = sodium.randombytes_buf(24);
    
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      null, // no AAD
      null,
      nonce,
      sectionKey
    );
    
    const envelope = new Uint8Array(24 + ciphertext.length);
    envelope.set(nonce, 0);
    envelope.set(ciphertext, 24);
    
    // Sign the envelope
    const signInput = new TextEncoder().encode(SECTION_SIGN_CONTEXT);
    const toSign = new Uint8Array(signInput.length + envelope.length);
    toSign.set(signInput, 0);
    toSign.set(envelope, signInput.length);
    
    const signature = sodium.crypto_sign_detached(toSign, signSecretKey);
    
    return {
      encryptedContent: envelope,
      signature: sodium.to_base64(signature),
      signerPubkey: sodium.to_base64(sodium.crypto_sign_ed25519_sk_to_pk(signSecretKey)),
      epochId: currentEpochId,
    };
  } finally {
    sodium.memzero(sectionKey);
  }
}
```

### 6.2 Key Rotation Impact

Sections require one additional re-encryption during epoch rotation:

```typescript
async function rotateEpochWithSections(
  albumId: string,
  oldKey: EpochKey,
  newKey: EpochKey
): Promise<void> {
  // 1. Re-encrypt album name/description (existing)
  // 2. Re-encrypt section document (NEW - single operation)
  // 3. Photo manifests already include sectionId, handled by existing rotation
}
```

**Comparison to blocks:** Block system requires re-encrypting potentially hundreds of individual block records.

---

## 7. User Experience

### 7.1 Creating Sections

```
┌──────────────────────────────────────────────────────────┐
│ Album: "Italy 2025"                          [+ Section] │
├──────────────────────────────────────────────────────────┤
│ ┌────────────────────────────────────────────────────┐   │
│ │ 📍 Day 1: Rome                           [⋮] [−]  │   │
│ │ Arrived in the eternal city...                     │   │
│ │ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐                   │   │
│ │ │ 📷  │ │ 📷  │ │ 📷  │ │ 📷  │                   │   │
│ │ └─────┘ └─────┘ └─────┘ └─────┘                   │   │
│ └────────────────────────────────────────────────────┘   │
│ ┌────────────────────────────────────────────────────┐   │
│ │ 📍 Day 2: Vatican City                   [⋮] [+]  │   │
│ │ ┌─────┐ ┌─────┐                                    │   │
│ │ │ 📷  │ │ 📷  │                                    │   │
│ │ └─────┘ └─────┘                                    │   │
│ └────────────────────────────────────────────────────┘   │
│ ┌────────────────────────────────────────────────────┐   │
│ │ 📁 Unsorted (3 photos)                   [⋮] [+]  │   │
│ │ ┌─────┐ ┌─────┐ ┌─────┐                           │   │
│ │ │ 📷  │ │ 📷  │ │ 📷  │                           │   │
│ │ └─────┘ └─────┘ └─────┘                           │   │
│ └────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

### 7.2 Section Actions

| Action | Gesture | Notes |
|--------|---------|-------|
| Create section | Button or drag photos to "[+]" zone | Opens section editor |
| Edit section | Click title/description | Inline editing |
| Reorder sections | Drag section header | Fractional indexing |
| Move photo to section | Drag photo | Updates manifest |
| Auto-create sections | Menu option | Group by date/location |
| Collapse/expand | Click chevron | Saves in section style |
| Delete section | Menu | Photos move to Unsorted |

### 7.3 Auto-Grouping Feature

```typescript
interface AutoGroupOptions {
  /** Group by date gaps (e.g., > 4 hours = new section) */
  byDate?: {
    gapHours: number;
    nameFormat: 'date' | 'dayOfTrip' | 'weekday';
  };
  
  /** Group by location clusters */
  byLocation?: {
    radiusKm: number;
    minPhotos: number;
  };
}

async function autoCreateSections(
  albumId: string,
  photos: PhotoMeta[],
  options: AutoGroupOptions
): Promise<Section[]> {
  // Analyze photos and suggest sections
  // User can accept, modify, or reject suggestions
}
```

---

## 8. Migration Path

### 8.1 Existing Albums (No Sections)

Albums without sections work exactly as today:
- All photos in implicit "Unsorted" section
- No visual change unless user enables sections

### 8.2 Adding Sections to Existing Album

```typescript
async function enableSections(albumId: string): Promise<void> {
  // 1. Create empty section document
  const doc: DecryptedSectionDocument = {
    version: 1,
    albumId,
    sections: [],
    updatedAt: new Date().toISOString(),
  };
  
  // 2. Encrypt and upload
  await uploadSectionDocument(albumId, doc);
  
  // 3. Optionally run auto-grouping
  const suggestions = await autoCreateSections(albumId, photos, defaultOptions);
  // Present to user for approval
}
```

### 8.3 Evolution to Full Blocks

Sections can evolve into blocks if needed:

```typescript
// Migration: Section → Block
function sectionToBlocks(section: Section): Block[] {
  const blocks: Block[] = [];
  
  // Section becomes a HeadingBlock
  if (section.title) {
    blocks.push({
      type: 'heading',
      content: { level: 2, text: section.title },
    });
  }
  
  // Description becomes TextBlock
  if (section.description) {
    blocks.push({
      type: 'text',
      content: { segments: parseRichText(section.description) },
    });
  }
  
  // Photos become PhotoGroupBlock
  const photoIds = getPhotosInSection(section.id);
  if (photoIds.length > 0) {
    blocks.push({
      type: 'photo-group',
      content: { manifestIds: photoIds, layout: 'grid' },
    });
  }
  
  return blocks;
}
```

**Key Insight:** Section-based structure is a **subset** of block-based. Migration only adds capability, never breaks existing data.

---

## 9. Pros/Cons Analysis

### 9.1 Pros

| Benefit | Details |
|---------|---------|
| **Simple Implementation** | ~2 weeks vs ~8 weeks for blocks |
| **Familiar UX** | Users understand folders/chapters |
| **Low Overhead** | Single encrypted document vs many blocks |
| **Easy Sync** | One more blob to sync per album |
| **Fast Key Rotation** | One re-encryption vs hundreds |
| **Backwards Compatible** | Existing albums work unchanged |
| **Query Efficient** | Filter photos by sectionId in SQLite |
| **Covers 80% Use Case** | Most albums just need date/location groups |

### 9.2 Cons

| Limitation | Details |
|------------|---------|
| **No Inline Text** | Can't write between individual photos |
| **No Custom Layouts** | No hero images, side-by-side, etc. |
| **Limited Nesting** | Flat or 2 levels (no deep hierarchies) |
| **No Rich Blocks** | No callouts, quotes, embedded content |
| **Less Editorial Control** | Can't craft a "story" like a blog post |

### 9.3 When to Choose Sections

Choose sections if:
- Primary use case is photo organization (not storytelling)
- Development time is constrained
- User base is non-technical
- Albums are typically < 500 photos
- Key rotation speed matters

Choose blocks if:
- Building a "story publishing" platform
- Users expect Notion-like editing
- Complex layouts are important
- Deep nesting is required
- Have resources for 8+ week implementation

---

## 10. Recommendation

### 10.1 Implementation Strategy

**Phase 1: Sections (MVP)**
- Implement flat sections with title, description, date range
- Add sectionId/sectionPosition to PhotoMeta
- Store section document encrypted per album
- Timeline: 2-3 weeks

**Phase 2: Polish**
- Auto-grouping by date/location
- Section cover photos
- Drag-and-drop reordering
- Timeline: 1-2 weeks

**Phase 3: Optional Evolution**
- If user demand warrants, add block support
- Sections become first-class blocks
- Existing sections auto-migrate
- Timeline: 6-8 weeks (if needed)

### 10.2 Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Storage | Hybrid (section doc + photo manifest) | Redundancy + atomic section updates |
| Hierarchy | Flat sections | Simpler UX, easier implementation |
| Ordering | Fractional indexing | Efficient reordering |
| Key Derivation | HKDF with section context | Crypto separation |
| Auto-Group | Date-gap based (optional) | 80% use case coverage |

### 10.3 Implementation Checklist

```
Week 1: Backend + Types
 □ Add AlbumSectionDocument entity
 □ Add migration for album_sections table
 □ Create API endpoints:
   □ GET /api/albums/{id}/sections
   □ PUT /api/albums/{id}/sections
 □ Extend PhotoMeta type with sectionId/sectionPosition
 □ Update manifest encryption to include section fields

Week 2: Frontend Core
 □ Add sections to DbWorker schema
 □ Create section document encryption/decryption
 □ Update sync to handle section document
 □ Create useSections hook
 □ Build SectionEditor component
 □ Add section drag-and-drop

Week 3: Integration + Polish
 □ Wire up section view in AlbumView
 □ Add "Move to Section" photo action
 □ Implement auto-grouping algorithm
 □ Add section collapse/expand
 □ Update key rotation for sections
 □ Write tests for all section operations
```

---

## Appendix A: API Endpoints

```typescript
// GET /api/albums/{id}/sections
interface GetSectionsResponse {
  /** Current section document version */
  version: number;
  /** Encrypted section document (base64) */
  encryptedContent: string;
  /** Signature */
  signature: string;
  /** Signer public key */
  signerPubkey: string;
  /** Epoch ID used for encryption */
  epochId: number;
}

// PUT /api/albums/{id}/sections
interface UpdateSectionsRequest {
  /** Expected current version (optimistic locking) */
  expectedVersion: number;
  /** New encrypted content (base64) */
  encryptedContent: string;
  /** New signature */
  signature: string;
  /** Epoch ID */
  epochId: number;
}

interface UpdateSectionsResponse {
  /** New version number */
  version: number;
  /** Updated timestamp */
  updatedAt: string;
}
```

---

## Appendix B: Full TypeScript Types

```typescript
// ============================================================================
// Section System Types
// ============================================================================

const SECTION_FORMAT_VERSION = 1;
const SECTION_KEY_CONTEXT = "Mosaic_Section_v1";
const SECTION_SIGN_CONTEXT = "Mosaic_SectionSign_v1";

// --- Core Section Type ---

interface Section {
  id: string;
  albumId: string;
  position: string;
  parentId?: string;
  
  title?: string;
  description?: string;
  
  dateRange?: {
    start: string;
    end: string;
  };
  
  location?: {
    name?: string;
    lat?: number;
    lng?: number;
    bounds?: Bounds;
  };
  
  coverPhotoId?: string;
  
  style?: {
    collapsed?: boolean;
    theme?: 'default' | 'hero' | 'minimal';
  };
  
  createdAt: string;
  updatedAt: string;
}

// --- Document Types ---

interface DecryptedSectionDocument {
  version: typeof SECTION_FORMAT_VERSION;
  albumId: string;
  sections: Section[];
  updatedAt: string;
}

interface EncryptedSectionDocument {
  encryptedContent: Uint8Array;
  signature: string;
  signerPubkey: string;
  epochId: number;
  version: number;
}

// --- Photo Extension ---

interface PhotoMetaWithSection extends PhotoMeta {
  sectionId?: string;
  sectionPosition?: string;
}

// --- Auto-Grouping ---

interface AutoGroupOptions {
  byDate?: {
    gapHours: number;
    nameFormat: 'date' | 'dayOfTrip' | 'weekday';
  };
  byLocation?: {
    radiusKm: number;
    minPhotos: number;
  };
}

interface SectionSuggestion {
  section: Omit<Section, 'id' | 'createdAt' | 'updatedAt'>;
  photoIds: string[];
  confidence: number;
}
```

---

**End of Specification**
