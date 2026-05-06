# Mosaic Feature Documentation

> **Living documentation of implemented features.**
> 
> This document is automatically maintained as features are added or modified.
> Each feature includes its purpose, location, usage, and testing status.

---

## Table of Contents

1. [Authentication & Identity](#authentication--identity)
2. [Albums & Organization](#albums--organization)
3. [Photo Management](#photo-management)
4. [Video Support](#video-support)
5. [Gallery & Viewing](#gallery--viewing)
6. [Sharing & Collaboration](#sharing--collaboration)
7. [Encryption & Security](#encryption--security)
8. [Sync & Offline](#sync--offline)
9. [UI/UX Features](#uiux-features)

---

## Authentication & Identity

### Local Authentication (Dev Mode)

**Purpose:** Development-only authentication using Ed25519 challenge-response.

**Implementation:**
| Layer    | Location                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------ |
| Backend  | [Controllers/DevAuthController.cs](../apps/backend/Mosaic.Backend/Controllers/DevAuthController.cs) |
| Backend  | [Middleware/CombinedAuthMiddleware.cs](../apps/backend/Mosaic.Backend/Middleware/CombinedAuthMiddleware.cs) |
| Frontend | [lib/local-auth.ts](../apps/web/src/lib/local-auth.ts)                                         |
| Frontend | [components/Auth/LoginForm.tsx](../apps/web/src/components/Auth/LoginForm.tsx)                 |

**Flow:**
1. Client requests challenge with username
2. Server returns random challenge bytes
3. Client signs challenge with Ed25519 private key
4. Server verifies signature against stored public key

**Configuration:**
```bash
Auth__LocalAuthEnabled=true   # Enable LocalAuth
Auth__ProxyAuthEnabled=false  # Disable ProxyAuth
```

**Tests:**
- Backend: `Mosaic.Backend.Tests/AuthTests/`
- Frontend: `apps/web/tests/local-auth.test.ts`

---

### Proxy Authentication (Production)

**Purpose:** Production authentication via trusted reverse proxy (Authelia, Authentik, etc.).

**Implementation:**
| Layer   | Location                                                                                           |
| ------- | -------------------------------------------------------------------------------------------------- |
| Backend | [Middleware/CombinedAuthMiddleware.cs](../apps/backend/Mosaic.Backend/Middleware/CombinedAuthMiddleware.cs) |

**Headers:**
- `Remote-User`: Authenticated username
- `Remote-Groups`: User group memberships

**Configuration:**
```bash
Auth__LocalAuthEnabled=false  # Disable LocalAuth
Auth__ProxyAuthEnabled=true   # Enable ProxyAuth
```

---

### Authentication Mode E2E Tests

**Purpose:** Comprehensive E2E test coverage for both LocalAuth and ProxyAuth modes.

**Implementation:**
| Layer        | Location                                                                                |
| ------------ | --------------------------------------------------------------------------------------- |
| E2E Tests    | [tests/e2e/tests/auth-modes.spec.ts](../tests/e2e/tests/auth-modes.spec.ts)             |
| Page Objects | [tests/e2e/page-objects/index.ts](../tests/e2e/page-objects/index.ts) - LoginPage class |

**Test Categories:**

**Mode Detection Tests:**
- Frontend detects auth mode from backend
- `/api/auth/init` returns expected response based on mode
- Health endpoint always accessible
- Protected endpoints require authentication

**LocalAuth Mode Tests:**
- User registration with username/password
- Login after logout
- LocalAuth badge visibility
- Session persistence across reloads
- Logout clears session
- Wrong password fails authentication (challenge-response)

**ProxyAuth Mode Tests:**
- API accepts valid Remote-User header
- User identity consistent across API calls
- Different headers result in different users
- Authelia header forwarding simulation
- Remote-User header format validation

**Usage:**
```bash
# Run against LocalAuth backend
$env:API_URL="http://localhost:5000"
npx playwright test auth-modes.spec.ts --project=chromium

# Run against ProxyAuth backend
$env:API_URL="http://localhost:8080"
npx playwright test auth-modes.spec.ts --project=chromium
```

**Note:** Tests automatically detect the backend mode and skip inapplicable tests. Run against both modes for full coverage.

---

## Albums & Organization

### Album Creation & Management

**Purpose:** Create, edit, and delete encrypted photo albums.

**Implementation:**
| Layer               | Location                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| Backend             | [Controllers/AlbumsController.cs](../apps/backend/Mosaic.Backend/Controllers/AlbumsController.cs) |
| Frontend Hook       | [hooks/useAlbums.ts](../apps/web/src/hooks/useAlbums.ts)                                        |
| Frontend Components | [components/Albums/](../apps/web/src/components/Albums/)                                        |

**Features:**
- Album creation with encrypted metadata
- Album listing with cover photos
- Album deletion with cascade cleanup

**Tests:**
- Backend: `Mosaic.Backend.Tests/AlbumTests/`
- Frontend: `apps/web/tests/album-*.test.ts`

---

### Album Cover Photos

**Purpose:** Display representative cover images for albums.

**Implementation:**
| Layer            | Location                                                                   |
| ---------------- | -------------------------------------------------------------------------- |
| Frontend Hook    | [hooks/useAlbumCover.ts](../apps/web/src/hooks/useAlbumCover.ts)         |
| Frontend Service | [lib/album-cover-service.ts](../apps/web/src/lib/album-cover-service.ts) |

**Behavior:**
- Selects most recent photo or explicit cover selection
- Caches decrypted thumbnails for performance

---

### Timed Album and Photo Expiration

**Purpose:** Albums and individual photos can be configured with nullable server-visible UTC deadlines that make expired encrypted content inaccessible and eligible for deletion while preserving zero-knowledge content opacity.

**Implementation:**
| Layer              | Location                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend Entity     | [Album.cs](../apps/backend/Mosaic.Backend/Data/Entities/Album.cs) — `ExpiresAt`, `ExpirationWarningDays`                                            |
| Backend Entity     | [Manifest.cs](../apps/backend/Mosaic.Backend/Data/Entities/Manifest.cs) — `ExpiresAt`                                                               |
| Backend Service    | [AlbumExpirationService.cs](../apps/backend/Mosaic.Backend/Services/AlbumExpirationService.cs) — deterministic server-clock enforcement and sweeps  |
| Backend GC         | [GarbageCollectionService.cs](../apps/backend/Mosaic.Backend/Services/GarbageCollectionService.cs) — invokes album/photo expiration sweeps          |
| Backend API        | `PATCH /api/albums/{albumId}/expiration`, `POST /api/manifests`, `PATCH /api/manifests/{manifestId}/expiration`                                     |
| Backend Enforcement| Album, manifest, shard, share-link, and Tus upload endpoints block expired content                                                                  |
| Frontend API       | [api.ts](../apps/web/src/lib/api.ts) — album and photo expiration request adapters                                                                  |
| Frontend Settings  | [AlbumExpirationSettings.tsx](../apps/web/src/components/Albums/AlbumExpirationSettings.tsx)                                                        |
| Frontend Create    | [CreateAlbumDialog.tsx](../apps/web/src/components/Albums/CreateAlbumDialog.tsx)                                                                    |
| Frontend Display   | [AlbumCard.tsx](../apps/web/src/components/Albums/AlbumCard.tsx) — expiration badges                                                                |
| Local Purge        | [local-purge.ts](../apps/web/src/lib/local-purge.ts) — local decrypted cache, key, DB, and upload queue cleanup                                     |

**Features:**
- Expiration is opt-in: deadlines default to `null` for albums and photos.
- Album owners can set/remove album expiration; album owners/editors can set/remove photo expiration.
- Server `TimeProvider` authority validates future deadlines and decides expiry; client clocks are ignored.
- Set expiration at album creation (preset durations: 7, 30, 90 days, or custom date)
- Modify/remove expiration on existing albums via settings
- Visual badges on album cards (info/warning/expired states)
- Warning banners when approaching expiration
- Temporary album creation requires explicit destructive acknowledgement before submit
- Expired albums are hard-deleted through the expiration service, removing memberships, epoch keys, manifests, album content, and manifest-shard links.
- Expired photos become deleted tombstones for sync, encrypted metadata is wiped from the active manifest row, and shard links are detached/trash-marked for existing shard cleanup.
- Expired album/photo shards are not downloadable through direct or share-link routes.
- Expired albums block sync, share-link access, and Tus uploads.
- Automatic server-side cleanup via GarbageCollectionService (hourly, batched)
- Cleanup drains all eligible trashed shards and expired upload reservations across batches in one run
- Cascade deletion: all photos (shards), manifests, epoch keys, members cleaned up
- Storage quota reclaimed automatically on expiration
- Share links blocked for expired albums
- Upload prevention for expired albums
- Client-side cleanup (epoch keys wiped, local DB cleared) when album disappears
- Expired/deleted albums and sync-deleted photos purge local decrypted metadata, thumbnails, cached album keys, queued upload references, and in-memory photo state
- Photo expiration uses a lifecycle-metadata-only API adapter (`PATCH /api/manifests/{manifestId}/expiration`)

**Limitations (v1):**
- Garbage collection runs hourly, but endpoint-integrated checks also enforce expiry before serving protected backend content.
- Existing trashed-shard cleanup remains responsible for final storage quota reclamation and opaque blob deletion.
- The web UI exposes album-level expiration controls only; photo-specific expiration is driven through the API adapter without dedicated per-photo UI.
- No proactive member notifications — members see warnings only when opening the album
- GC runs hourly — up to ~60 minute delay before actual deletion
- Batch processing: max 10 expired albums per GC cycle
- No minimum TTL enforcement
- Album expiration/deletion sync is currently observed through 404 cleanup; a dedicated backend deleted-album sync signal is not yet available
- Local purge removes queued/persisted upload references, but in-flight uploads cannot yet be aborted by album purge

**Tests:**
- Backend: `AlbumExpirationControllerTests`, `ManifestExpirationControllerTests`, `ShardExpirationAccessTests`, `AlbumExpirationServiceTests`, GC service tests, expiration endpoint tests, and affected controller/service suites.
- Frontend: `apps/web/tests/` (expiration settings, create dialog, badge formatting, API adapters, sync tombstones, local purge)

---

### Album Content System (Story Blocks)

**Purpose:** Rich, block-based content editing for albums - allows adding headings, text, photo groups, maps, quotes, and dividers alongside photos. Accessible via "Story" view mode in gallery.

**Implementation:**
| Layer    | Location                                                                                      |
| -------- | --------------------------------------------------------------------------------------------- |
| Backend  | [Controllers/AlbumContentController.cs](../apps/backend/Mosaic.Backend/Controllers/AlbumContentController.cs) |
| Backend  | [Data/Entities/AlbumContent.cs](../apps/backend/Mosaic.Backend/Data/Entities/AlbumContent.cs)  |
| Crypto   | [libs/crypto/src/content.ts](../libs/crypto/src/content.ts) - deriveContentKey, encryptContent |
| Frontend | [contexts/AlbumContentContext.tsx](../apps/web/src/contexts/AlbumContentContext.tsx)        |
| Frontend | [lib/content-blocks.ts](../apps/web/src/lib/content-blocks.ts) - Zod schemas & types        |
| Frontend | [components/Content/](../apps/web/src/components/Content/) - BlockRenderers, BlockEditor, SlashCommandMenu, PhotoPickerDialog |
| Frontend | [components/Gallery/Gallery.tsx](../apps/web/src/components/Gallery/Gallery.tsx) - StoryView integration |

**Block Types:**
- `heading` - H1/H2/H3 section headings
- `text` - Rich text paragraphs with formatting (bold, italic, code, links)
- `photo-ref` - Single photo reference with optional caption
- `photo-grid` - Grid/row/masonry layouts of multiple photos (editable via PhotoGridEditor)
- `quote` - Styled quote block with optional attribution
- `map` - Embedded Leaflet map with configurable center, zoom, and markers
- `divider` - Visual separators (line, dots, space)
- `section` - Collapsible sections with nested blocks

**Features:**
- Zero-knowledge encryption (content encrypted client-side with derived key)
- WYSIWYG editing with TipTap editor
- Drag-and-drop block reordering with @dnd-kit
- Slash command menu (`/` at start of empty block) for quick block insertion
- PhotoPickerDialog for selecting album photos in blocks
- Photo caption editing inline
- PhotoGridEditor with drag-to-reorder and add/remove photos
- Block deletion with undo toast (5 second window)
- Optimistic concurrency control (version-based)
- XSS protection via URL sanitization

**Gallery Integration:**
- Story view mode accessible via BookOpen icon in GalleryHeader
- `GalleryViewMode` extended to include `'story'`
- StoryView component wraps ContentEditor with album context
- Seamless switching between grid/mosaic/map/story views

**Key Derivation:**
Content is encrypted using a key derived from the album's epoch key:
```typescript
contentKey = HKDF-SHA256(epochKey.readKey, "mosaic-album-content-v1")
```

**Tests:**
- Backend: `Mosaic.Backend.Tests/AlbumContentTests/`
- Crypto: `libs/crypto/tests/content.test.ts`
- Frontend: `apps/web/tests/lib/content-blocks.test.ts`, `apps/web/tests/components/BlockRenderers.test.tsx`, `apps/web/tests/components/BlockEditor.test.tsx`, `apps/web/tests/components/SlashCommandMenu.test.tsx`, `apps/web/tests/components/PhotoPickerDialog.test.tsx`

---

## Photo Management

### Photo Upload

**Purpose:** Encrypted, resumable photo uploads using Tus protocol.

**Specification:** [SPEC-UploadExperience.md](./specs/SPEC-UploadExperience.md)

**Implementation:**
| Layer            | Location                                                                        |
| ---------------- | ------------------------------------------------------------------------------- |
| Backend          | [Program.cs (Tus config)](../apps/backend/Mosaic.Backend/Program.cs)            |
| Backend          | [Controllers/ShardsController.cs](../apps/backend/Mosaic.Backend/Controllers/ShardsController.cs) |
| Frontend Context | [contexts/UploadContext.tsx](../apps/web/src/contexts/UploadContext.tsx)      |
| Frontend Hook    | [hooks/useUpload.ts](../apps/web/src/hooks/useUpload.ts)                      |
| Frontend UI      | [components/Upload/](../apps/web/src/components/Upload/)                      |
| Frontend Upload Queue | [lib/upload/](../apps/web/src/lib/upload/)                              |

**Features:**
- Client-side encryption before upload
- Resumable uploads (Tus protocol)
- Progress tracking per file
- EXIF extraction (date, GPS, camera info)
- Thumbnail generation (256px, 512px)
- Video file support (MP4, WebM, MOV, MKV) with automatic frame extraction
- Legacy IndexedDB upload queue drain/reset path for pre-R-Cl1 records
- PNG/WebP/AVIF/HEIC metadata-strip migration parity through Rust WASM

---

### Photo Selection & Bulk Actions

**Purpose:** Select multiple photos for bulk operations (delete, download, move).

**Implementation:**
| Layer         | Location                                                                           |
| ------------- | ---------------------------------------------------------------------------------- |
| Frontend Hook | [hooks/useSelection.ts](../apps/web/src/hooks/useSelection.ts)                   |
| Frontend Hook | [hooks/usePhotoActions.ts](../apps/web/src/hooks/usePhotoActions.ts)             |
| Frontend UI   | [components/Gallery/SelectionActionBar.tsx](../apps/web/src/components/Gallery/) |
| Styles        | *(selection styles inlined in components)*                                       |

**Features:**
- Long-press or checkbox selection
- Floating action bar with bulk operations
- Download action is gated by the centralized `canDownload` permission
- Keyboard shortcuts: `Esc` (exit), `Ctrl+A` (select all), `Delete` (delete)
- Visual feedback with scale/glow effects

**Tests:**
- Frontend: `apps/web/tests/selection-action-bar.test.tsx`

---

### Photo Deletion

**Purpose:** Soft-delete photos with undo capability.

**Implementation:**
| Layer         | Location                                                                       |
| ------------- | ------------------------------------------------------------------------------ |
| Backend       | [Controllers/ManifestsController.cs](../apps/backend/Mosaic.Backend/Controllers/ManifestsController.cs) |
| Frontend Hook | [hooks/usePhotoDelete.ts](../apps/web/src/hooks/usePhotoDelete.ts)           |
| Frontend Hook | [hooks/usePhotoActions.ts](../apps/web/src/hooks/usePhotoActions.ts)         |

---

## Video Support

### Video Support

**Purpose:** Upload, store, and play back video files with the same zero-knowledge encryption as photos.

**Implementation:**
| Layer            | Location                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------- |
| MIME Detection   | [lib/mime-type-detection.ts](../apps/web/src/lib/mime-type-detection.ts)                   |
| Frame Extraction | [lib/video-frame-extractor.ts](../apps/web/src/lib/video-frame-extractor.ts)              |
| Upload Pipeline  | [lib/upload-queue.ts](../apps/web/src/lib/upload-queue.ts)                                |
| Manifest         | [lib/manifest-service.ts](../apps/web/src/lib/manifest-service.ts)                        |
| Gallery Overlay  | [components/Gallery/PhotoThumbnail.tsx](../apps/web/src/components/Gallery/PhotoThumbnail.tsx), [JustifiedPhotoThumbnail.tsx](../apps/web/src/components/Gallery/JustifiedPhotoThumbnail.tsx) |
| Lightbox Player  | [components/Gallery/PhotoLightbox.tsx](../apps/web/src/components/Gallery/PhotoLightbox.tsx) |
| Shared Viewer    | [components/Shared/SharedPhotoLightbox.tsx](../apps/web/src/components/Shared/SharedPhotoLightbox.tsx) |
| Schema           | [workers/types.ts](../apps/web/src/workers/types.ts), [workers/db.worker.ts](../apps/web/src/workers/db.worker.ts) |

**Supported Formats:**
- MP4 (H.264) — Universal browser playback
- WebM (VP8/VP9) — Chrome/Firefox
- MOV — Safari primarily
- MKV — Limited browser playback

**Features:**
- Automatic video detection via magic byte analysis (ISOBMFF, EBML headers)
- Client-side thumbnail extraction using HTMLVideoElement frame capture
- ThumbHash generation for instant blur placeholders
- Play icon overlay + duration badge on gallery thumbnails
- Native browser video player with controls in lightbox
- Encrypted storage using same tier system (Tier 1: thumbnail, Tier 3: original chunks)
- Chunked upload for large files (6MB chunks via Tus protocol)
- Zero-knowledge: server never sees video content or metadata
- Share link support with access tier gating (requires ORIGINAL access for playback)

**Limitations (Phase 1):**
- No video preview tier (only thumbnail + original)
- Full video downloaded to memory for playback (no streaming decryption)
- No server-side transcoding (all processing client-side)
- No video-specific metadata extraction (GPS, creation date from MP4 atoms) — deferred to Phase 2

**Tests:**
- Unit: `apps/web/tests/video-frame-extractor.test.ts`, `apps/web/tests/manifest-service.test.ts`
- Format: `apps/web/src/lib/__tests__/format-duration.test.ts`
- MIME: `apps/web/tests/mime-type-detection.test.ts`

---

## Gallery & Viewing

### Photo Grid

**Purpose:** Virtualized, performant photo grid display.

**Specification:** [SPEC-GalleryStreaming.md](./specs/SPEC-GalleryStreaming.md)

**Implementation:**
| Layer              | Location                                                                               |
| ------------------ | -------------------------------------------------------------------------------------- |
| Frontend Component | [components/Gallery/PhotoGrid.tsx](../apps/web/src/components/Gallery/PhotoGrid.tsx) |
| Frontend Hook      | [hooks/usePhotos.ts](../apps/web/src/hooks/usePhotos.ts)                             |
| Frontend Helper    | [lib/photo-query-pagination.ts](../apps/web/src/lib/photo-query-pagination.ts)       |
| Worker             | [workers/db.worker.ts](../apps/web/src/workers/db.worker.ts)                         |

**Features:**
- TanStack Virtual for viewport-based rendering
- Progressive thumbnail loading
- Lazy decryption of visible photos
- Responsive grid layout
- Local SQLite photo and search queries page through all results instead of stopping at fixed 1,000/10,000-photo limits

**Tests:**
- Frontend: `apps/web/tests/photo-query-pagination.test.ts`

---

### Lightbox Viewer

**Purpose:** Full-screen photo viewing with navigation.

**Implementation:**
| Layer              | Location                                                                           |
| ------------------ | ---------------------------------------------------------------------------------- |
| Frontend Hook      | [hooks/useLightbox.ts](../apps/web/src/hooks/useLightbox.ts)                     |
| Frontend Component | [components/Gallery/PhotoLightbox.tsx](../apps/web/src/components/Gallery/PhotoLightbox.tsx) |
| Frontend Service   | [lib/photo-edit-service.ts](../apps/web/src/lib/photo-edit-service.ts)          |
| Worker             | [workers/db.worker.ts](../apps/web/src/workers/db.worker.ts)                    |

**Features:**
- Full-resolution image loading
- Swipe/arrow navigation
- Pinch-to-zoom support
- EXIF metadata display
- Owner/editor inline editing for encrypted photo descriptions

---

### Map View

**Purpose:** Display photos on a map based on GPS coordinates.

**Implementation:**
| Layer              | Location                                                                |
| ------------------ | ----------------------------------------------------------------------- |
| Frontend Component | [components/Gallery/MapView.tsx](../apps/web/src/components/Gallery/) |
| Worker             | [workers/geo.worker.ts](../apps/web/src/workers/geo.worker.ts)        |

**Features:**
- Leaflet-based map rendering
- Clustered markers for performance
- Filter out photos with null/undefined GPS data

---

## Sharing & Collaboration

### Album Members

**Purpose:** Invite users to access shared albums.

**Implementation:**
| Layer            | Location                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| Backend          | [Controllers/AlbumMembersController.cs](../apps/backend/Mosaic.Backend/Controllers/)           |
| Frontend Hook    | [hooks/useAlbumMembers.ts](../apps/web/src/hooks/useAlbumMembers.ts)                         |
| Frontend Hook    | [hooks/useMemberManagement.ts](../apps/web/src/hooks/useMemberManagement.ts)                 |
| Frontend Context | [contexts/AlbumPermissionsContext.tsx](../apps/web/src/contexts/AlbumPermissionsContext.tsx) |
| Frontend UI      | [components/Members/](../apps/web/src/components/Members/)                                   |

**Features:**
- Add members by username
- Role-based permissions (viewer, contributor, admin)
- Epoch key distribution for decryption access

---

### Share Links

**Purpose:** Generate public/private shareable links for albums.

**Implementation:**
| Layer         | Location                                                                           |
| ------------- | ---------------------------------------------------------------------------------- |
| Backend       | [Controllers/ShareLinksController.cs](../apps/backend/Mosaic.Backend/Controllers/) |
| Frontend Hook | [hooks/useShareLinks.ts](../apps/web/src/hooks/useShareLinks.ts)                 |
| Frontend Hook | [hooks/useLinkKeys.ts](../apps/web/src/hooks/useLinkKeys.ts)                     |
| Frontend UI   | [components/ShareLinks/](../apps/web/src/components/ShareLinks/)                 |
| Shared Viewer | [components/Shared/SharedGallery.tsx](../apps/web/src/components/Shared/SharedGallery.tsx) |

**Features:**
- Time-limited share links
- Password-protected links
- View-only or download permissions
- Public shared album galleries page through all photos instead of stopping at the first page
- Full-access share links can download the shared album as a ZIP through client-side decryption
- Member-management views page through all album members instead of stopping at the backend default page
- Authenticated share-link lists support `skip`/`take`; epoch rotation drains every active share link before wrapping new tier keys

---

## Encryption & Security

### Key Hierarchy

**Documentation:** See `libs/crypto/.instructions.md`

**Levels:**
| Level | Name    | Derivation                  | Storage         |
| ----- | ------- | --------------------------- | --------------- |
| L0    | Master  | Argon2id(password, salt)    | Never stored    |
| L1    | Root    | HKDF(L0, account_salt)      | Never stored    |
| L2    | Account | random(32), wrapped by L1   | Encrypted in DB |
| L3    | Epoch   | ReadKey + SignKey per album | Distributed     |

**Implementation:**
| Purpose             | Location                                                         |
| ------------------- | ---------------------------------------------------------------- |
| Key derivation      | [libs/crypto/src/keychain.ts](../libs/crypto/src/keychain.ts)    |
| Envelope encryption | [libs/crypto/src/envelope.ts](../libs/crypto/src/envelope.ts)    |
| Epoch keys          | [hooks/useEpochKeys.ts](../apps/web/src/hooks/useEpochKeys.ts) |

---

### Epoch-Based Key Rotation

**Purpose:** Enable key rotation for access revocation without re-encrypting all photos.

**Concept:**
- Each album has "epochs" (key generations)
- New epoch = new keys for new uploads
- Old epochs retained for historical access
- Revoked members lose access to future epochs

---

### Web Metadata Strip Parity (M0)

**Purpose:** Web uploads use the same Rust metadata stripping surface as native clients before encryption.

**Implementation:**
| Layer | Location |
|-------|----------|
| Rust media | `crates/mosaic-media/src/lib.rs` |
| WASM facade | `crates/mosaic-wasm/src/lib.rs` |
| Frontend | `apps/web/src/lib/exif-stripper.ts` |
| Upload handling | `apps/web/src/lib/upload/tiered-upload-handler.ts` |

**Features:**
- JPEG, PNG, and WebP metadata stripping delegates to `mosaic-media` through WASM.
- HEIC/AVIF/video source-preserved originals fail closed until parser support lands.
- Shared Rust/Web golden corpus enforces byte-identical post-strip output.

**Tests:**
- Rust: `crates/mosaic-media/tests/strip_corpus.rs`
- Frontend: `apps/web/src/lib/__tests__/exif-stripper.test.ts`, `apps/web/src/lib/upload/__tests__/tiered-upload-handler-metadata.test.ts`, `apps/web/tests/strip-parity.test.ts`

---

## Sync & Offline

### Local Database (SQLite-WASM)

**Purpose:** Client-side encrypted storage for offline access.

**Implementation:**
| Layer   | Location                                                         |
| ------- | ---------------------------------------------------------------- |
| Worker  | [workers/db.worker.ts](../apps/web/src/workers/db.worker.ts)   |
| Service | [lib/db-client.ts](../apps/web/src/lib/db-client.ts)           |

**Features:**
- OPFS-backed SQLite database
- Encrypted metadata storage
- Photo manifest sync
- Thumbnail caching

---

### Sync Engine

**Purpose:** Keep local database synchronized with server.

**Implementation:**
| Layer            | Location                                                               |
| ---------------- | ---------------------------------------------------------------------- |
| Frontend Context | [contexts/SyncContext.tsx](../apps/web/src/contexts/SyncContext.tsx) |
| Frontend Hook    | [hooks/useSync.ts](../apps/web/src/hooks/useSync.ts)                 |

**Features:**
- Incremental sync with server
- Conflict resolution
- Background sync on focus
- Event-based UI updates

---

### Sync Conflict Resolution

**Purpose:** Resolve concurrent edits to album content (block-based story documents) deterministically when two clients save against the same epoch, per `docs/specs/SPEC-SyncConflictResolution.md`.

**Implementation:**
| Layer            | Location                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| Pure resolver    | [lib/conflict-resolution.ts](../apps/web/src/lib/conflict-resolution.ts)                       |
| Sync event seam  | [lib/sync-engine.ts](../apps/web/src/lib/sync-engine.ts) (`notifyContentConflict`)             |
| Coordinator API  | [lib/sync-coordinator.tsx](../apps/web/src/lib/sync-coordinator.tsx) (`onContentConflict`)     |
| Save integration | [contexts/AlbumContentContext.tsx](../apps/web/src/contexts/AlbumContentContext.tsx)           |

**Features:**
- Three-way block-level merge with LWW fallback for same-block conflicts (Phase 2).
- Pure LWW (server-wins) when no shared base snapshot is available (Phase 1).
- Deterministic merge: blocks sorted by fractional position with id tiebreak so the merged document is identical across runs and platforms.
- Auto-resolved decisions and manual conflicts are reported separately so UI only nags the user when the merge could not pick a clear winner.
- Conflict-event payloads carry only opaque block ids and resolution counts — never plaintext blocks, never key material — preserving zero-knowledge invariants.

**Tests:**
- Frontend: `apps/web/tests/conflict-resolution.test.ts` (17 unit tests covering the SPEC §7 scenarios — simultaneous adds, simultaneous edits, edit-vs-delete, mutual delete, deterministic ordering, no-base fallback)
- Frontend: `apps/web/tests/sync-coordinator.test.ts` (6 tests for the listener-forwarding seam, including listener-throws isolation and key-material redaction)

---

## UI/UX Features

### Theme Support

**Purpose:** Light/dark/system theme preference.

**Implementation:**
| Layer         | Location                                                                        |
| ------------- | ------------------------------------------------------------------------------- |
| Frontend Hook | [hooks/useTheme.ts](../apps/web/src/hooks/useTheme.ts)                        |
| Frontend UI   | [components/Settings/ThemeSettings.tsx](../apps/web/src/components/Settings/) |

---

### Session Management

**Purpose:** Track authenticated session state.

**Implementation:**
| Layer         | Location                                                     |
| ------------- | ------------------------------------------------------------ |
| Frontend Hook | [hooks/useSession.ts](../apps/web/src/hooks/useSession.ts) |

---

### Photo Grid Animation System

**Purpose:** Smooth enter/exit animations for photo grid items with TanStack Virtual compatibility.

**Implementation:**
| Layer       | Location                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| CSS         | [styles/animations.css](../apps/web/src/styles/animations.css)                                                   |
| Hook        | [hooks/useAnimatedItems.ts](../apps/web/src/hooks/useAnimatedItems.ts)                                           |
| Component   | [components/Gallery/AnimatedTile.tsx](../apps/web/src/components/Gallery/AnimatedTile.tsx)                       |
| Component   | [components/Gallery/PhotoGridSkeleton.tsx](../apps/web/src/components/Gallery/PhotoGridSkeleton.tsx)             |
| Integration | [components/Gallery/MosaicPhotoGrid.tsx](../apps/web/src/components/Gallery/MosaicPhotoGrid.tsx) |
| Spec        | [docs/specs/SPEC-AnimationSystem.md](./specs/SPEC-AnimationSystem.md)                                              |

**Features:**
- Smooth fade-in for newly added photos (staggered batches)
- Smooth fade-out for deleted photos ("phantom entries" pattern)
- No animation on initial load (avoids jarring effect)
- Full virtualization compatibility via CSS-first approach
- 60fps performance with GPU-accelerated transforms/opacity
- `prefers-reduced-motion` accessibility support
- Skeleton loading state with shimmer animation

**Tests:**
- Frontend: `apps/web/tests/use-animated-items.test.ts`
- Frontend: `apps/web/tests/animated-tile.test.ts` (hook + CSS class documentation)
- E2E: `tests/e2e/tests/gallery-animations.spec.ts`

**Known Issues:**
- Unit tests cannot render `AnimatedTile` directly due to happy-dom/RAF incompatibility
- See `docs/TROUBLESHOOTING.md` for workarounds

---

## Admin & System Features

### Admin Dashboard

**Purpose:** System administration panel for managing users, albums, and settings.

**Implementation:**
| Layer    | Location                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------- |
| Backend  | [Controllers/AdminStatsController.cs](../apps/backend/Mosaic.Backend/Controllers/AdminStatsController.cs) |
| Backend  | [Controllers/AdminUsersController.cs](../apps/backend/Mosaic.Backend/Controllers/AdminUsersController.cs) |
| Backend  | [Controllers/AdminAlbumsController.cs](../apps/backend/Mosaic.Backend/Controllers/AdminAlbumsController.cs) |
| Backend  | [Controllers/AdminSettingsController.cs](../apps/backend/Mosaic.Backend/Controllers/AdminSettingsController.cs) |
| Frontend | [components/Admin/](../apps/web/src/components/Admin/)                                        |

**Features:**
- System-wide statistics
- User management (create, edit, delete)
- Album management
- Quota settings management
- Near-limit warnings

---

### Quota & Storage Limits

**Purpose:** Enforce per-user storage quotas and limits.

**Implementation:**
| Layer    | Location                                                                    |
| -------- | --------------------------------------------------------------------------- |
| Backend  | [Services/QuotaSettingsService.cs](../apps/backend/Mosaic.Backend/Services/QuotaSettingsService.cs) |
| Backend  | User quota fields in database                                               |
| Frontend | Quota display in settings and upload UI                                     |

**Features:**
- Per-user storage quotas
- Default quota settings
- Near-quota warnings
- Album-level limits

---

### Garbage Collection

**Purpose:** Clean up orphaned shards and deleted data.

**Implementation:**
| Layer   | Location                                                                              |
| ------- | ------------------------------------------------------------------------------------- |
| Backend | [Services/GarbageCollectionService.cs](../apps/backend/Mosaic.Backend/Services/)      |

**Features:**
- Orphaned shard cleanup
- Background cleanup of deleted data

---

## Internationalization (i18n)

### Multi-Language Support

**Purpose:** Localized user interface in multiple languages.

**Implementation:**
| Layer    | Location                                                     |
| -------- | ------------------------------------------------------------ |
| Frontend | [lib/i18n.ts](../apps/web/src/lib/i18n.ts)                 |
| Locales  | [locales/en.json](../apps/web/src/locales/en.json)         |
| Locales  | [locales/cs.json](../apps/web/src/locales/cs.json)         |

**Features:**
- English and Czech language support
- Browser language detection
- Language switching in settings

---

## Format Conversion

### Image Format Conversion Pipeline

**Purpose:** Convert and optimize images for web display.

**Implementation:**
| Layer    | Location                                                                         |
| -------- | -------------------------------------------------------------------------------- |
| Frontend | [lib/image-decoder.ts](../apps/web/src/lib/image-decoder.ts)                   |
| Tests    | [tests/e2e/tests/format-conversion.spec.ts](../tests/e2e/tests/format-conversion.spec.ts) |

**Features:**
- HEIC/HEIF decoding (iOS photos)
- AVIF/WebP/JPEG output format selection
- Browser capability detection
- EXIF orientation handling

---

### ThumbHash Placeholders

**Purpose:** Progressive image loading with compact, high-quality placeholders that preserve aspect ratio.

**Implementation:**
| Layer    | Location                                                              |
| -------- | --------------------------------------------------------------------- |
| Frontend | [lib/thumbhash-decoder.ts](../apps/web/src/lib/thumbhash-decoder.ts)  |

**Features:**
- ThumbHash generation during upload (~25 bytes, base64-encoded)
- Preserves aspect ratio information in placeholder
- Supports alpha channel (transparency)
- Fast placeholder rendering before thumbnails load
- Backward compatibility with legacy BlurHash data

### Album Download (ZIP Export)

**Purpose:** Download all photos from an album (or selected photos) as a ZIP file with original quality.

**Implementation:**
| Layer | Location |
|-------|----------|
| Service | `apps/web/src/lib/album-download-service.ts` |
| Shared Resolver | `apps/web/src/lib/shared-album-download.ts` |
| Hook | `apps/web/src/hooks/useAlbumDownload.ts` |
| Progress UI | `apps/web/src/components/Gallery/DownloadProgressOverlay.tsx` |
| Integration | `apps/web/src/components/Gallery/Gallery.tsx`, `apps/web/src/components/Shared/SharedGallery.tsx` |

**Features:**
- Downloads original-quality photos (no re-encoding)
- Streaming ZIP creation via `client-zip` — constant memory usage
- File System Access API for true streaming to disk (Chrome/Edge)
- Blob URL fallback for Firefox/Safari
- Progress tracking with file count and current filename
- Cancellation support via AbortController
- Filename deduplication for duplicate names
- Handles photos across multiple epochs (key rotation)
- Multi-shard photo reassembly for large originals
- Zero-knowledge preserved: all decryption client-side
- Full-access share-link viewers can download public shared albums without authenticated shard endpoints

**Access Points:**
- Album Settings dropdown → "Download All Photos"
- Selection Action Bar → "Download (N)" for selected photos
- Full-access shared album header → "Download all (N)"

**Tests:**
- Service: `apps/web/src/lib/__tests__/album-download-service.test.ts`
- Shared Service: `apps/web/src/lib/__tests__/shared-album-download.test.ts`
- Shared Gallery: `apps/web/tests/shared-gallery.test.tsx`

---

## Android

### Android Sync Confirmation and Photo Picker Staging

**Purpose:** Confirm committed manifest versions have reached album sync and route Android Photo Picker results into app-private staging without broad media permissions.

**Implementation:**
| Layer | Location |
|-------|----------|
| Android sync | `apps/android-main/src/main/kotlin/org/mosaic/android/main/sync/SyncConfirmationLoop.kt` |
| Android picker | `apps/android-main/src/main/kotlin/org/mosaic/android/main/picker/PhotoPickerStagingAdapter.kt` |
| Android picker helper | `apps/android-main/src/main/kotlin/org/mosaic/android/main/picker/PhotoPickerStagingLauncher.kt` |

**Features:**
- Polls album sync until `currentVersion` reaches the locally finalized manifest version.
- Uses exponential backoff with full jitter and cooperative coroutine cancellation.
- Treats 404/403 as terminal failures while retrying server errors.
- Stages Photo Picker `Uri` results via `AppPrivateStagingManager`, preserving original MIME types and falling back to `application/octet-stream`.
- Provides Activity Result helper functions for Compose `rememberLauncherForActivityResult` integration without adding broad storage permissions.

**Tests:**
- Android JVM: `apps/android-main/src/test/kotlin/org/mosaic/android/main/sync/SyncConfirmationLoopTest.kt`
- Android JVM: `apps/android-main/src/test/kotlin/org/mosaic/android/main/picker/PhotoPickerStagingAdapterTest.kt`

---

### Android Main Module (Rust UniFFI APK)

**Purpose:** First real Android Gradle application module that consumes the Rust UniFFI core directly. Cross-compiled `libmosaic_uniffi.so` is packaged into the APK; JNA-based generated Kotlin bindings call into Rust at runtime. Smoke-tests the FFI end-to-end on a real device.

**Implementation:**
| Layer | Location |
|-------|----------|
| Rust UniFFI core | `crates/mosaic-uniffi/src/lib.rs` |
| Generated Kotlin bindings | `target/android/kotlin/uniffi/mosaic_uniffi/mosaic_uniffi.kt` (regenerated by `scripts/build-rust-android.{ps1,sh}`) |
| Cross-compiled native libs | `target/android/{arm64-v8a,x86_64}/libmosaic_uniffi.so` |
| Shell-side bridge contracts | `apps/android-shell/src/main/kotlin/org/mosaic/android/foundation/Generated*Bridge.kt` |
| Android-main adapters | `apps/android-main/src/main/kotlin/org/mosaic/android/main/bridge/AndroidRust*Api.kt` |
| Smoke screen Activity | `apps/android-main/src/main/kotlin/org/mosaic/android/main/MainActivity.kt` |
| Application loader | `apps/android-main/src/main/kotlin/org/mosaic/android/main/MosaicApplication.kt` |
| Build orchestrators | `scripts/build-android-main.{ps1,sh}`, `scripts/test-android-main.{ps1,sh}` |
| Gradle module config | `apps/android-main/build.gradle.kts`, `gradle/libs.versions.toml`, `settings.gradle.kts` |

**Features:**
- AGP 8.7.3, Kotlin 2.0.21, JDK 17, compileSdk 35, minSdk 26.
- abiFilters restricted to `arm64-v8a` + `x86_64`.
- 11 `AndroidRust*Api` adapter classes covering account / identity / epoch / shard / metadata-sidecar / media inspection / header parsing / progress probe / diagnostics / upload state machine / album sync state machine.
- `MosaicApplication.onCreate()` eagerly loads the native library via `AndroidRustCoreLibraryLoader.warmUp()` (which calls the generated `uniffiEnsureInitialized()`).
- `MainActivity` proves the FFI by displaying `protocolVersion()` and exercising a deliberately rejectable `unlockAccountKey` round-trip.
- `android:allowBackup="false"`, no `INTERNET`, no `READ_MEDIA_*`, no broad storage permissions.
- Privacy-redacted `toString()` on every bridge DTO; password buffers wiped after `unlockAccountKey`.
- ProGuard/R8 keep rules for `uniffi.mosaic_uniffi.**` + `com.sun.jna.**` (release minify currently disabled).
- Gradle pre-build task `buildRustUniffiArtifacts` invokes `scripts/build-rust-android.{ps1,sh}`, then `syncRustUniffiKotlin` + `syncRustUniffiJniLibs` populate `build/generated/source/uniffi/main/kotlin/` and `build/generated/jniLibs/{abi}/`.

**Tests:**
- Shell contract tests: `apps/android-shell/src/test/kotlin/.../GeneratedRustBridgeContractsTest.kt` (37 contract tests covering all 11 bridges; redaction, error mapping, defensive byte-array copies, value-class redaction).
- JVM compile-time guard: `apps/android-main/src/test/kotlin/.../bridge/AdapterCompilationContractTest.kt`.
- Instrumented FFI smoke: `apps/android-main/src/androidTest/kotlin/.../RustCoreSmokeTest.kt` (protocol version, weak-KDF rejection round-trip, golden-vector determinism, state-machine descriptor).

**CI:**
- `android-shell` job runs `scripts/test-android-shell.sh` on `ubuntu-latest`.
- `android-main` job runs `scripts/build-rust-android.sh` + `gradle :apps:android-main:assembleDebug` + `:testDebugUnitTest` on `ubuntu-latest`. APK uploaded as workflow artifact.

**Status:** v1 foundation slice — proves FFI is wired. Real Photo Picker, Tus upload, codec/tier-generation, and WorkManager scheduling are follow-ups.

### Cross-client cryptographic vector parity (Android, Slice 0C)

**Purpose:** Drive `tests/vectors/*.json` byte-equality assertions from the Android side through the production `AndroidRust*Api` adapters into the host-built `mosaic_uniffi` cdylib. Proves the Rust → Kotlin FFI boundary preserves byte-for-byte agreement with the canonical cross-client corpus for link-key derivation, identity-from-seed, auth-challenge sign/verify, sealed-bundle verify-and-open, and raw-key album content decrypt.

**Implementation:**
| Layer | Location |
|-------|----------|
| Rust UniFFI exports | `crates/mosaic-uniffi/src/lib.rs` (8 new `#[uniffi::export]` fns + 5 new Records) |
| Numeric error code snapshot | `crates/mosaic-uniffi/tests/error_code_table.rs` |
| Shell-side bridge contracts | `apps/android-shell/src/main/kotlin/org/mosaic/android/foundation/GeneratedRust{LinkKeys,IdentitySeed,AuthChallenge,SealedBundle,Content}Bridge.kt` |
| Android-main adapters | `apps/android-main/src/main/kotlin/org/mosaic/android/main/bridge/AndroidRust{LinkKeys,IdentitySeed,AuthChallenge,SealedBundle,Content}Api.kt` |
| Round-trip tests (host-lib JNA override) | `apps/android-main/src/test/kotlin/org/mosaic/android/main/bridge/AndroidRust*ApiRoundTripTest.kt` (30 tests) |
| Shell-side cross-client byte-equality | `apps/android-shell/src/test/kotlin/org/mosaic/android/foundation/CrossClientVectorTest.kt` (5 deferred tests converted) |
| Architecture guard | `tests/architecture/kotlin-raw-input-ffi.{ps1,sh}` |
| SPEC | `docs/specs/SPEC-AndroidSlice0CCryptoBridges.md` |

**Features:**
- 7 new UniFFI exports for cross-client raw-input crypto (`derive_link_keys_from_raw_secret`, `derive_identity_from_raw_seed`, `build_auth_challenge_transcript_bytes`, `sign_auth_challenge_with_raw_seed`, `verify_auth_challenge_signature`, `verify_and_open_bundle_with_recipient_seed`, `decrypt_content_with_raw_key`).
- Sealed-bundle FFI Record intentionally OMITS `sign_secret_seed` from `mosaic_client::OpenedBundleResult` — only public-side fields and `epoch_seed` cross the FFI surface.
- All input byte arrays wiped on the Rust side via `Zeroizing` before return; result records implement custom `fmt::Debug` that redacts byte payloads as `<redacted-{N}-bytes>`.
- Shell-side Kotlin DTOs render every byte field as `<redacted>` in `toString()`; round-trip tests assert no forbidden hex appears in the rendered output.
- Architecture guard fails CI on any non-test Kotlin caller of the 5 new bridges, enforcing test-only usage of the raw-input path.
- New `client_error_code_table_*` snapshot tests in `crates/mosaic-uniffi/tests/error_code_table.rs` pin the full numeric `ClientErrorCode` → `u16` table to detect drift, renumbering, or collision.

**Tests:**
- Rust: `crates/mosaic-uniffi/tests/{ffi_snapshot,error_code_table}.rs` (snapshot + 49-row code table).
- Android shell: `apps/android-shell/src/test/.../CrossClientVectorTest.kt` (5 vector byte-equality tests, all green).
- Android main: 30 round-trip tests across 5 bridges; covers all 11 vector negatives + 4 sealed-bundle edge cases (BundleAlbumIdEmpty / EpochTooOld paths).

**Status:** v1 — five `TODO Slice 0C:` markers closed. Four remaining `tests/vectors/*.json` files (`tier_key_wrap`, `auth_keypair`, `account_unlock`, `epoch_derive`) are tracked in `tests/vectors/deviations.md` and addressed by commit `0e2957a`'s `mosaic-crypto::ts_canonical` module; their Android wiring is a follow-up.

---

## Feature Documentation Template

When adding new features, use this template:

```markdown
### Feature Name

**Purpose:** One-sentence description of what the feature does.

**Implementation:**
| Layer    | Location                         |
| -------- | -------------------------------- |
| Backend  | [path/to/file](../relative/path) |
| Frontend | [path/to/file](../relative/path) |

**Features:**
- Bullet list of capabilities

**Configuration:** (if applicable)
```bash
ENV_VAR=value
```

**Tests:**
- Backend: `path/to/tests/`
- Frontend: `path/to/tests/`
```

---

## Changelog

| Date       | Feature                     | Action   | Notes                                                        |
| ---------- | --------------------------- | -------- | ------------------------------------------------------------ |
| 2026-05-06 | Android Sync Confirmation and Photo Picker Staging | Added | Added album sync confirmation polling with jittered backoff/cancellation plus Photo Picker staging adapter preserving MIME types |
| 2026-05-05 | Web Upload Queue Migration  | Added    | Added legacy IndexedDB upload task detection/drain/reset telemetry and PNG/WebP/AVIF/HEIC strip parity coverage |
| 2026-05-04 | Web Metadata Strip Parity (M0) | Added | Web JPEG/PNG/WebP stripping now delegates to Rust `mosaic-media` WASM; HEIC/AVIF/video source originals reject until parser support lands |
| 2026-04-30 | Cross-client cryptographic vector parity (Android, Slice 0C) | Added | 7 new raw-input UniFFI exports + 5 Generated*Bridge contracts + 5 AndroidRust*Api adapters + 30 round-trip tests; closes 5 `TODO Slice 0C:` markers in `CrossClientVectorTest.kt`; new `kotlin-raw-input-ffi` architecture guard; new `error_code_table.rs` snapshot test |
| 2026-04-30 | TS-Canonical Cryptographic Primitives | Added | `mosaic-crypto::ts_canonical` module: BLAKE2b-keyed link IDs, BLAKE2b auth-key + L1 derivation, XSalsa20-Poly1305 (`crypto_secretbox`) wrap/unwrap; reproduces TS reference byte-exact for `auth_keypair.json`, `account_unlock.json`, `link_keys.json` corpora |
| 2026-04-29 | Sync Conflict Resolution     | Added    | Lane B: deterministic three-way block merge with LWW fallback for album content; expanded rust-cutover boundary guard to per-symbol classification |
| 2026-04-29 | FFI Debug Redaction (M5)     | Added    | 24 custom `fmt::Debug` impls across `mosaic-{client,crypto,media,uniffi,wasm}` replacing `derive(Debug)` on public FFI surfaces; redacts byte payloads as `<redacted-{N}-bytes>`; 30 mutation-kill tests in `mosaic-client/tests/mutation_kills.rs` |
| 2026-04-29 | Android Main Module (Rust UniFFI APK) | Added | First real Android Gradle module wiring `mosaic-uniffi` cdylib + JNA Kotlin bindings into a debug APK; closes 11-bridge FFI drift between `apps/android-shell` and `crates/mosaic-uniffi` |
| 2026-04-28 | Timed Album/Photo Expiration | Modified | Backend adds server-clock album/photo expiry, deterministic sweeps, access enforcement, and focused tests |
| 2026-04-28 | Temporary Albums (TTL)      | Modified | Added explicit destructive acknowledgement, photo expiration adapter, and local purge wiring for expired/deleted client state |
| 2026-04-28 | Photo Description Editing   | Added    | Owners/editors can edit encrypted photo descriptions from the lightbox without exposing plaintext to the server |
| 2026-04-27 | Share Links / Album Download | Modified | Shared album viewers page through all photos; full-access share links can download all photos as a client-side decrypted ZIP |
| 2026-04-27 | Gallery / Member Management | Modified | Local photo/search queries and member-management loads drain all pages; bulk download action now respects `canDownload` |
| 2026-04-28 | Backend Pagination / Cleanup | Modified | Added share-link list pagination, pagination headers, epoch-rotation page draining, and full cleanup-batch draining |
| 2026-04-07 | Video Support             | Added    | Upload, view, and share encrypted videos (MP4, WebM, MOV, MKV) with automatic thumbnail extraction |
| 2026-04-07 | Temporary Albums (TTL)      | Added    | Auto-expiring albums with preset durations, visual badges, server-side GC cleanup |
| 2026-04-07 | Album Download (ZIP Export) | Added    | Download all/selected photos as ZIP with streaming, progress tracking, and cancellation |
| 2026-01-30 | Album Content System Phase 2| Added    | Gallery Story view integration, SlashCommandMenu, PhotoPickerDialog, PhotoGridEditor, QuoteBlock, MapBlock, delete with undo toast |
| 2026-01-29 | Album Content System        | Added    | Block-based content editor with TipTap, dnd-kit, Zod schemas |
| 2026-01-22 | ThumbHash Placeholders      | Modified | Migrated from BlurHash to ThumbHash for better quality and aspect ratio preservation |
| 2026-01-21 | Documentation Update        | Modified | Updated file paths, added missing features (Admin, i18n, Format Conversion, BlurHash) |
| 2026-01-06 | Gallery Animation Tests     | Added    | E2E tests for AnimatedTile, documented happy-dom limitations |
| 2025-07-24 | Photo Grid Animation System | Added    | Enter/exit animations with TanStack Virtual compatibility    |
| 2025-12-29 | Auth Mode E2E Tests         | Added    | Comprehensive tests for LocalAuth and ProxyAuth modes        |
| 2025-12-29 | Photo Selection UX          | Added    | Floating action bar, keyboard shortcuts                      |
| 2025-12-29 | Map View                    | Fixed    | Filter null GPS coordinates                                  |
| 2025-12-29 | Photo Counts                | Fixed    | Load from local SQLite database                              |
