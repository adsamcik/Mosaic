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
4. [Gallery & Viewing](#gallery--viewing)
5. [Sharing & Collaboration](#sharing--collaboration)
6. [Encryption & Security](#encryption--security)
7. [Sync & Offline](#sync--offline)
8. [UI/UX Features](#uiux-features)

---

## Authentication & Identity

### Local Authentication (Dev Mode)

**Purpose:** Development-only authentication using Ed25519 challenge-response.

**Implementation:**
| Layer | Location |
|-------|----------|
| Backend | [Controllers/DevAuthController.cs](../apps/backend/Mosaic.Backend/Controllers/DevAuthController.cs) |
| Backend | [Services/LocalAuthService.cs](../apps/backend/Mosaic.Backend/Services/LocalAuthService.cs) |
| Frontend | [lib/local-auth.ts](../apps/admin/src/lib/local-auth.ts) |
| Frontend | [components/Auth/LocalAuthLogin.tsx](../apps/admin/src/components/Auth/LocalAuthLogin.tsx) |

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
- Frontend: `apps/admin/tests/local-auth.test.ts`

---

### Proxy Authentication (Production)

**Purpose:** Production authentication via trusted reverse proxy (Authelia, Authentik, etc.).

**Implementation:**
| Layer | Location |
|-------|----------|
| Backend | [Middleware/ProxyAuthMiddleware.cs](../apps/backend/Mosaic.Backend/Middleware/) |
| Backend | [Services/ProxyAuthService.cs](../apps/backend/Mosaic.Backend/Services/) |

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
| Layer | Location |
|-------|----------|
| E2E Tests | [tests/e2e/tests/auth-modes.spec.ts](../tests/e2e/tests/auth-modes.spec.ts) |
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
| Layer | Location |
|-------|----------|
| Backend | [Controllers/AlbumsController.cs](../apps/backend/Mosaic.Backend/Controllers/AlbumsController.cs) |
| Frontend Hook | [hooks/useAlbums.ts](../apps/admin/src/hooks/useAlbums.ts) |
| Frontend Components | [components/Albums/](../apps/admin/src/components/Albums/) |

**Features:**
- Album creation with encrypted metadata
- Album listing with cover photos
- Album deletion with cascade cleanup

**Tests:**
- Backend: `Mosaic.Backend.Tests/AlbumTests/`
- Frontend: `apps/admin/tests/album-*.test.ts`

---

### Album Cover Photos

**Purpose:** Display representative cover images for albums.

**Implementation:**
| Layer | Location |
|-------|----------|
| Frontend Hook | [hooks/useAlbumCover.ts](../apps/admin/src/hooks/useAlbumCover.ts) |
| Frontend Service | [lib/album-cover-service.ts](../apps/admin/src/lib/album-cover-service.ts) |

**Behavior:**
- Selects most recent photo or explicit cover selection
- Caches decrypted thumbnails for performance

---

### Album Expiration

**Purpose:** Time-limited album access with automatic cleanup.

**Documentation:** [FEATURE_EXPIRATION.md](./FEATURE_EXPIRATION.md)

**Implementation:**
| Layer | Location |
|-------|----------|
| Backend | Album entity `ExpiresAt` field |
| Frontend | [components/Albums/AlbumExpirationSettings.tsx](../apps/admin/src/components/Albums/) |

---

## Photo Management

### Photo Upload

**Purpose:** Encrypted, resumable photo uploads using Tus protocol.

**Specification:** [SPEC-UploadExperience.md](./specs/SPEC-UploadExperience.md)

**Implementation:**
| Layer | Location |
|-------|----------|
| Backend | [Controllers/UploadsController.cs](../apps/backend/Mosaic.Backend/Controllers/) |
| Frontend Context | [contexts/UploadContext.tsx](../apps/admin/src/contexts/UploadContext.tsx) |
| Frontend Hook | [hooks/useUpload.ts](../apps/admin/src/hooks/useUpload.ts) |
| Frontend UI | [components/Upload/](../apps/admin/src/components/Upload/) |

**Features:**
- Client-side encryption before upload
- Resumable uploads (Tus protocol)
- Progress tracking per file
- EXIF extraction (date, GPS, camera info)
- Thumbnail generation (256px, 512px)

---

### Photo Selection & Bulk Actions

**Purpose:** Select multiple photos for bulk operations (delete, download, move).

**Implementation:**
| Layer | Location |
|-------|----------|
| Frontend Hook | [hooks/useSelection.ts](../apps/admin/src/hooks/useSelection.ts) |
| Frontend Hook | [hooks/usePhotoActions.ts](../apps/admin/src/hooks/usePhotoActions.ts) |
| Frontend UI | [components/Gallery/SelectionActionBar.tsx](../apps/admin/src/components/Gallery/) |
| Styles | [styles/selection-ux.css](../apps/admin/src/styles/selection-ux.css) |

**Features:**
- Long-press or checkbox selection
- Floating action bar with bulk operations
- Keyboard shortcuts: `Esc` (exit), `Ctrl+A` (select all), `Delete` (delete)
- Visual feedback with scale/glow effects

---

### Photo Deletion

**Purpose:** Soft-delete photos with undo capability.

**Implementation:**
| Layer | Location |
|-------|----------|
| Backend | [Controllers/PhotosController.cs](../apps/backend/Mosaic.Backend/Controllers/) |
| Frontend Hook | [hooks/usePhotoActions.ts](../apps/admin/src/hooks/usePhotoActions.ts) |

---

## Gallery & Viewing

### Photo Grid

**Purpose:** Virtualized, performant photo grid display.

**Specification:** [SPEC-GalleryStreaming.md](./specs/SPEC-GalleryStreaming.md)

**Implementation:**
| Layer | Location |
|-------|----------|
| Frontend Component | [components/Gallery/PhotoGrid.tsx](../apps/admin/src/components/Gallery/PhotoGrid.tsx) |
| Frontend Hook | [hooks/usePhotos.ts](../apps/admin/src/hooks/usePhotos.ts) |

**Features:**
- TanStack Virtual for viewport-based rendering
- Progressive thumbnail loading
- Lazy decryption of visible photos
- Responsive grid layout

---

### Lightbox Viewer

**Purpose:** Full-screen photo viewing with navigation.

**Implementation:**
| Layer | Location |
|-------|----------|
| Frontend Hook | [hooks/useLightbox.ts](../apps/admin/src/hooks/useLightbox.ts) |
| Frontend Component | [components/Gallery/Lightbox.tsx](../apps/admin/src/components/Gallery/) |

**Features:**
- Full-resolution image loading
- Swipe/arrow navigation
- Pinch-to-zoom support
- EXIF metadata display

---

### Map View

**Purpose:** Display photos on a map based on GPS coordinates.

**Implementation:**
| Layer | Location |
|-------|----------|
| Frontend Component | [components/Gallery/MapView.tsx](../apps/admin/src/components/Gallery/) |
| Worker | [workers/geo.worker.ts](../apps/admin/src/workers/geo.worker.ts) |

**Features:**
- Leaflet-based map rendering
- Clustered markers for performance
- Filter out photos with null/undefined GPS data

---

## Sharing & Collaboration

### Album Members

**Purpose:** Invite users to access shared albums.

**Implementation:**
| Layer | Location |
|-------|----------|
| Backend | [Controllers/AlbumMembersController.cs](../apps/backend/Mosaic.Backend/Controllers/) |
| Frontend Hook | [hooks/useAlbumMembers.ts](../apps/admin/src/hooks/useAlbumMembers.ts) |
| Frontend Hook | [hooks/useMemberManagement.ts](../apps/admin/src/hooks/useMemberManagement.ts) |
| Frontend Context | [contexts/AlbumPermissionsContext.tsx](../apps/admin/src/contexts/AlbumPermissionsContext.tsx) |
| Frontend UI | [components/Members/](../apps/admin/src/components/Members/) |

**Features:**
- Add members by username
- Role-based permissions (viewer, contributor, admin)
- Epoch key distribution for decryption access

---

### Share Links

**Purpose:** Generate public/private shareable links for albums.

**Implementation:**
| Layer | Location |
|-------|----------|
| Backend | [Controllers/ShareLinksController.cs](../apps/backend/Mosaic.Backend/Controllers/) |
| Frontend Hook | [hooks/useShareLinks.ts](../apps/admin/src/hooks/useShareLinks.ts) |
| Frontend Hook | [hooks/useLinkKeys.ts](../apps/admin/src/hooks/useLinkKeys.ts) |
| Frontend UI | [components/ShareLinks/](../apps/admin/src/components/ShareLinks/) |

**Features:**
- Time-limited share links
- Password-protected links
- View-only or download permissions

---

## Encryption & Security

### Key Hierarchy

**Documentation:** See `libs/crypto/.instructions.md`

**Levels:**
| Level | Name | Derivation | Storage |
|-------|------|------------|---------|
| L0 | Master | Argon2id(password, salt) | Never stored |
| L1 | Root | HKDF(L0, account_salt) | Never stored |
| L2 | Account | random(32), wrapped by L1 | Encrypted in DB |
| L3 | Epoch | ReadKey + SignKey per album | Distributed |

**Implementation:**
| Purpose | Location |
|---------|----------|
| Key derivation | [libs/crypto/src/key-derivation.ts](../libs/crypto/src/) |
| Envelope encryption | [libs/crypto/src/envelope.ts](../libs/crypto/src/) |
| Epoch keys | [hooks/useEpochKeys.ts](../apps/admin/src/hooks/useEpochKeys.ts) |

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
| Layer | Location |
|-------|----------|
| Worker | [workers/db.worker.ts](../apps/admin/src/workers/db.worker.ts) |
| Service | [lib/db-service.ts](../apps/admin/src/lib/db-service.ts) |

**Features:**
- OPFS-backed SQLite database
- Encrypted metadata storage
- Photo manifest sync
- Thumbnail caching

---

### Sync Engine

**Purpose:** Keep local database synchronized with server.

**Implementation:**
| Layer | Location |
|-------|----------|
| Frontend Context | [contexts/SyncContext.tsx](../apps/admin/src/contexts/SyncContext.tsx) |
| Frontend Hook | [hooks/useSync.ts](../apps/admin/src/hooks/useSync.ts) |

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
| Layer | Location |
|-------|----------|
| Frontend Hook | [hooks/useTheme.ts](../apps/admin/src/hooks/useTheme.ts) |
| Frontend UI | [components/Settings/ThemeSettings.tsx](../apps/admin/src/components/Settings/) |

---

### Session Management

**Purpose:** Track authenticated session state.

**Implementation:**
| Layer | Location |
|-------|----------|
| Frontend Hook | [hooks/useSession.ts](../apps/admin/src/hooks/useSession.ts) |

---

### Photo Grid Animation System

**Purpose:** Smooth enter/exit animations for photo grid items with TanStack Virtual compatibility.

**Implementation:**
| Layer | Location |
|-------|----------|
| CSS | [styles/animations.css](../apps/admin/src/styles/animations.css) |
| Hook | [hooks/useAnimatedItems.ts](../apps/admin/src/hooks/useAnimatedItems.ts) |
| Component | [components/Gallery/AnimatedTile.tsx](../apps/admin/src/components/Gallery/AnimatedTile.tsx) |
| Component | [components/Gallery/PhotoGridSkeleton.tsx](../apps/admin/src/components/Gallery/PhotoGridSkeleton.tsx) |
| Integration | [components/Gallery/EnhancedMosaicPhotoGrid.tsx](../apps/admin/src/components/Gallery/EnhancedMosaicPhotoGrid.tsx) |
| Spec | [docs/specs/SPEC-AnimationSystem.md](./specs/SPEC-AnimationSystem.md) |

**Features:**
- Smooth fade-in for newly added photos (staggered batches)
- Smooth fade-out for deleted photos ("phantom entries" pattern)
- No animation on initial load (avoids jarring effect)
- Full virtualization compatibility via CSS-first approach
- 60fps performance with GPU-accelerated transforms/opacity
- `prefers-reduced-motion` accessibility support
- Skeleton loading state with shimmer animation

**Tests:**
- Frontend: `apps/admin/tests/use-animated-items.test.ts`

---

## Feature Documentation Template

When adding new features, use this template:

```markdown
### Feature Name

**Purpose:** One-sentence description of what the feature does.

**Implementation:**
| Layer | Location |
|-------|----------|
| Backend | [path/to/file](../relative/path) |
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

| Date | Feature | Action | Notes |
|------|---------|--------|-------|
| 2025-07-24 | Photo Grid Animation System | Added | Enter/exit animations with TanStack Virtual compatibility |
| 2025-12-29 | Auth Mode E2E Tests | Added | Comprehensive tests for LocalAuth and ProxyAuth modes |
| 2025-12-29 | Photo Selection UX | Added | Floating action bar, keyboard shortcuts |
| 2025-12-29 | Map View | Fixed | Filter null GPS coordinates |
| 2025-12-29 | Photo Counts | Fixed | Load from local SQLite database |
