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

### Temporary Albums (TTL Expiration)

**Purpose:** Albums can be configured to automatically expire and be permanently deleted after a set period, useful for temporary sharing of event photos.

**Implementation:**
| Layer            | Location                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| Backend Entity   | [Album.cs](../apps/backend/Mosaic.Backend/Data/Entities/Album.cs) — `ExpiresAt`, `ExpirationWarningDays`          |
| Backend GC       | [GarbageCollectionService.cs](../apps/backend/Mosaic.Backend/Services/GarbageCollectionService.cs) — `CleanExpiredAlbums()` |
| Backend API      | `PATCH /api/albums/{albumId}/expiration`                                                                          |
| Frontend Settings| [AlbumExpirationSettings.tsx](../apps/web/src/components/Albums/AlbumExpirationSettings.tsx)                     |
| Frontend Create  | [CreateAlbumDialog.tsx](../apps/web/src/components/Albums/CreateAlbumDialog.tsx)                                 |
| Frontend Display | [AlbumCard.tsx](../apps/web/src/components/Albums/AlbumCard.tsx) — expiration badges                             |

**Features:**
- Set expiration at album creation (preset durations: 7, 30, 90 days, or custom date)
- Modify/remove expiration on existing albums via settings
- Visual badges on album cards (info/warning/expired states)
- Warning banners when approaching expiration
- Automatic server-side cleanup via GarbageCollectionService (hourly, batched)
- Cleanup drains all eligible trashed shards and expired upload reservations across batches in one run
- Cascade deletion: all photos (shards), manifests, epoch keys, members cleaned up
- Storage quota reclaimed automatically on expiration
- Share links blocked for expired albums
- Upload prevention for expired albums
- Client-side cleanup (epoch keys wiped, local DB cleared) when album disappears

**Limitations (v1):**
- No proactive member notifications — members see warnings only when opening the album
- GC runs hourly — up to ~60 minute delay before actual deletion
- Batch processing: max 10 expired albums per GC cycle
- No minimum TTL enforcement

**Tests:**
- Backend: `apps/backend/Mosaic.Backend.Tests/` (GC service tests, expiration endpoint tests)
- Frontend: `apps/web/tests/` (expiration settings, create dialog, badge formatting)

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

**Features:**
- Client-side encryption before upload
- Resumable uploads (Tus protocol)
- Progress tracking per file
- EXIF extraction (date, GPS, camera info)
- Thumbnail generation (256px, 512px)
- Video file support (MP4, WebM, MOV, MKV) with automatic frame extraction

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
