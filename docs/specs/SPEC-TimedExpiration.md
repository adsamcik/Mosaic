# SPEC-TimedExpiration

## Status

Authoritative Band 5 contract spec for timed album and photo expiration. This workstream owns the executable contract/focused tests; backend and web implementation lanes may merge before these tests go green.

Related decision record: `docs/adr/ADR-011-timed-expiration.md`.

## Goals

- Let owners opt in to destructive UTC expiration for albums and individual photos.
- Enforce access denial at or after the effective deadline using the server clock.
- Hard-delete expired opaque server content and access-control rows without inspecting encrypted payloads.
- Make destructive UX explicit with confirmations, countdowns, and warning states.
- Purge local decrypted metadata, thumbnails, queued references, and cached encrypted blobs after sync observes server deletion/expiry.

## Non-goals

- No recovery/trash UX after expiration fires.
- No server-side plaintext photo, EXIF, title, description, or key processing.
- No proactive email/push notifications in v1; warnings are in-app only.
- No full all-tests or broad Playwright matrix in this lane.

## Terminology

| Term | Meaning |
| --- | --- |
| Album expiration | Nullable server-visible deadline on an album. When reached, the album and all contained photos become inaccessible and are swept. |
| Photo expiration | Nullable server-visible deadline on a logical photo/manifests row. When reached, that photo becomes inaccessible and its shards are swept. |
| Effective deadline | Earliest non-null deadline from the containing album and the photo. |
| Lifecycle metadata | Server-visible operational metadata needed to enforce deletion; not encrypted user photo metadata. |
| Tombstone | Minimal sync deletion record containing IDs/version only; no encrypted metadata, shard IDs, thumbnails, or keys. |

## Data flow and API contract

All deadlines are UTC ISO 8601 timestamps. Clients MUST send an explicit offset or `Z`; backend normalizes persisted values and JSON responses to UTC.

### Create album with optional expiration

`POST /api/albums`

Request body extends the existing encrypted album creation request:

```json
{
  "initialEpochKey": {
    "recipientId": "018f9b4e-0ef6-7d66-bbbe-79b721ce5c18",
    "epochId": 1,
    "encryptedKeyBundle": "base64-opaque-sealed-epoch-key-bundle",
    "ownerSignature": "base64-ed25519-signature",
    "sharerPubkey": "base64-ed25519-public-key",
    "signPubkey": "base64-ed25519-public-key"
  },
  "encryptedName": "base64-client-encrypted-name-or-omitted",
  "encryptedDescription": "base64-client-encrypted-description-or-omitted",
  "expiresAt": "2026-06-28T00:00:00Z",
  "expirationWarningDays": 7
}
```

Response body:

```json
{
  "id": "018f9b4e-2fd7-7e3a-a1f1-f71ac331272d",
  "ownerId": "018f9b4e-0ef6-7d66-bbbe-79b721ce5c18",
  "currentEpochId": 1,
  "currentVersion": 1,
  "createdAt": "2026-04-28T12:00:00Z",
  "updatedAt": "2026-04-28T12:00:00Z",
  "encryptedName": "base64-client-encrypted-name-or-null",
  "encryptedDescription": "base64-client-encrypted-description-or-null",
  "expiresAt": "2026-06-28T00:00:00Z",
  "expirationWarningDays": 7
}
```

Validation:

- `expiresAt` omitted or `null` means no album deadline.
- Non-null `expiresAt` MUST be strictly greater than backend `UtcNow` at validation time.
- `expirationWarningDays` defaults to `7` when omitted.
- `expirationWarningDays` MUST be non-negative. Web UX clamps displayed warnings to the album lifetime.

### Set or clear album expiration

`PATCH /api/albums/{albumId}/expiration`

Authorization: album owner only. Editors/viewers receive `403`; non-members receive `403` or `404` according to existing membership lookup conventions.

Set request:

```json
{
  "expiresAt": "2026-06-28T00:00:00Z",
  "expirationWarningDays": 14
}
```

Clear request:

```json
{
  "expiresAt": null
}
```

Response body:

```json
{
  "id": "018f9b4e-2fd7-7e3a-a1f1-f71ac331272d",
  "expiresAt": "2026-06-28T00:00:00Z",
  "expirationWarningDays": 14,
  "updatedAt": "2026-04-28T12:05:00Z"
}
```

Response semantics:

- `expiresAt: null` confirms expiration is disabled.
- If `expirationWarningDays` is omitted while setting/changing `expiresAt`, backend preserves the existing warning-day value.
- If `expirationWarningDays` is omitted while clearing, backend preserves the previous value for future re-enable.
- The response MUST NOT include plaintext album names, descriptions, keys, shard IDs, or encrypted photo metadata.

### Set or clear photo expiration

Logical photos are represented by manifest/photo records. The endpoint is album-scoped to make authorization and earlier-album-deadline behavior explicit:

`PATCH /api/albums/{albumId}/photos/{photoId}/expiration`

Where `photoId` is the logical photo/manifest identifier returned in sync/gallery APIs.

Authorization: album owner or editor. Viewers receive `403`; non-members receive `403` or `404` according to existing membership lookup conventions.

Set request:

```json
{
  "expiresAt": "2026-05-05T09:30:00Z"
}
```

Clear request:

```json
{
  "expiresAt": null
}
```

Response body:

```json
{
  "id": "018f9b4f-0e7c-72d6-b421-5c2e1f6738df",
  "albumId": "018f9b4e-2fd7-7e3a-a1f1-f71ac331272d",
  "expiresAt": "2026-05-05T09:30:00Z",
  "albumExpiresAt": "2026-06-28T00:00:00Z",
  "effectiveExpiresAt": "2026-05-05T09:30:00Z",
  "updatedAt": "2026-04-28T12:10:00Z"
}
```

Validation:

- `expiresAt` omitted or `null` clears the photo deadline.
- Non-null `expiresAt` MUST be strictly greater than backend `UtcNow`.
- Photo deadlines later than the album deadline are allowed, but `effectiveExpiresAt` is the album deadline because the earlier deadline wins.
- A missing or already-deleted photo returns `404`.
- A request for a photo outside `{albumId}` returns `404`.

### Photo/manifest read shape

A photo is represented by a manifest plus opaque encrypted shard references. Photo expiration is lifecycle metadata and remains server-visible alongside the existing manifest fields:

```json
{
  "id": "uuid",
  "albumId": "uuid",
  "versionCreated": 2,
  "isDeleted": false,
  "encryptedMeta": "opaque client ciphertext bytes",
  "signature": "client signature over opaque manifest data",
  "signerPubkey": "client epoch signing pubkey",
  "shardIds": ["uuid"],
  "shards": [{ "shardId": "uuid", "tier": 3 }],
  "expiresAt": "2026-05-01T12:00:00Z or null"
}
```

`POST /api/manifests` accepts optional `expiresAt`. The album-scoped `PATCH /api/albums/{albumId}/photos/{photoId}/expiration` (above) is the canonical mutation endpoint; it supersedes the legacy `PATCH /api/manifests/{manifestId}/expiration` shape because authorization and earlier-album-deadline semantics depend on the album scope. `expiresAt: null` disables photo expiration. Non-null deadlines must be strictly greater than backend `UtcNow`.

### Read/list/sync behavior

| API | Before deadline | At/after effective deadline |
| --- | --- | --- |
| `GET /api/albums` | Includes accessible albums with `expiresAt` and `expirationWarningDays`. | Expired albums are omitted once access is denied/swept. |
| `GET /api/albums/{albumId}` | Returns album lifecycle fields. | Returns `410 Gone` until hard-delete removes the album, then `404 Not Found`. |
| `GET /api/albums/{albumId}/sync?since=N` | Returns changes and lifecycle fields needed by web warning UI. | Returns `410 Gone` until hard-delete removes the album, then `404 Not Found`; client purges local album data for either status. |
| `GET /api/shards/{shardId}` | Returns opaque bytes only if user has access and effective deadline is in future. | Returns `410 Gone` for expired photo/album until hard-delete, then `404 Not Found`. |
| `GET /api/manifests/{manifestId}` | Returns encrypted manifest while effective deadline is in future. | Returns `410 Gone` until hard-delete/tombstone cleanup, then `404 Not Found`. |
| Sync photo deletion | Returns normal manifest records. | Emits a minimal tombstone (`id`, `albumId`, `isDeleted: true`, version) before/with sweep so clients purge local photo caches. |

`410 Gone` means the resource existed but is inaccessible due to expiry. Clients MUST treat `410` the same as deletion for local purge, but MAY show an "expired" message if the user is actively viewing the resource.

## Server lifecycle and hard-delete contract

1. Owner/editor sets a future UTC deadline.
2. At `effectiveExpiresAt <= server UtcNow`, backend access checks deny reads/downloads/mutations with `410 Gone`.
3. Background sweep processes expired albums/photos in bounded batches.
4. Album sweep deletes or detaches:
   - album row and album limits;
   - album members/access grants/share links/link epoch keys;
   - epoch keys;
   - manifests/photo rows and manifest-shard joins;
   - shard references, moving active shards to the existing trashed-shard hard-delete pipeline;
   - album content/story blocks.
5. Photo sweep deletes or tombstones the logical photo, detaches all shard joins for that photo, and moves now-unreferenced active shards to the trashed-shard hard-delete pipeline.
6. Storage bytes are physically removed by `CleanTrashedShards()` according to the existing shard trash retention; expiration MUST not leave readable active shard references.
7. Sweep logs MAY include resource IDs, counts, and deadlines. Sweep logs MUST NOT include keys, plaintext metadata, encrypted metadata blobs, shard bytes, signed manifests, or share-link secrets.

## Zero-knowledge invariants

Expiration timestamps are allowed server-visible lifecycle metadata because the server must enforce deletion for offline/stale clients. They reveal only an operator-selected deadline, comparable to `createdAt`, membership rows, quotas, or share-link expiry. They are not photo metadata like title, date taken, EXIF, location, album name, captions, or tags.

The contract preserves zero-knowledge constraints:

- Clients continue to encrypt album names/descriptions and photo metadata before upload.
- Server APIs accept only lifecycle timestamps plus opaque encrypted payloads that already existed in the upload/sync contracts.
- Expiration update APIs never accept plaintext names, photo metadata, passwords, keys, or decrypted thumbnails.
- Server cleanup deletes opaque rows/objects by ID and status; it never decrypts or parses `encryptedMeta`, shard bytes, or key bundles.
- `410`/tombstone responses identify deleted resources by ID/version only; no encrypted photo metadata or shard IDs are needed for local purge.
- Local purge wipes decrypted data and key material. Epoch/read/sign keys remain client-only and must be wiped with existing key-store memory hygiene.

## Component and service tree

### Backend

```text
Controllers
├─ AlbumsController
│  ├─ POST /api/albums accepts expiresAt/expirationWarningDays
│  ├─ PATCH /api/albums/{albumId}/expiration owner-only
│  ├─ GET /api/albums/{albumId} returns 410/404 after expiry
│  └─ GET /api/albums/{albumId}/sync returns 410/404 after expiry
├─ ManifestsController or PhotosController
│  ├─ PATCH /api/albums/{albumId}/photos/{photoId}/expiration editor+owner
│  ├─ manifest/photo reads deny expired resources
│  └─ delete/tombstone photo records for sync purge
└─ ShardsController
   └─ denies shard downloads when containing album/photo effective deadline is expired

Data
├─ Album.ExpiresAt, Album.ExpirationWarningDays
├─ Manifest/Photo lifecycle deadline (e.g. Manifest.ExpiresAt or PhotoLifecycle table)
├─ indexes on non-null expiration deadlines
└─ sync version/tombstone state for photo purge

Services
├─ GarbageCollectionService.CleanExpiredAlbums()
├─ GarbageCollectionService.CleanExpiredPhotos()
├─ ShardReferenceCleanup.DetachManifestShardsAsync()
└─ IStorageService physical shard deletion via existing trashed-shard cleanup
```

### Web

```text
Components
├─ CreateAlbumDialog: optional TTL preset/custom date during creation
├─ AlbumExpirationSettings: destructive confirmation, warning days, clear flow
├─ AlbumCard/GalleryHeader: badge, countdown, warning/expired states
├─ Photo actions/settings: set/clear per-photo expiration with destructive confirmation
└─ Toasts/dialogs: 410 expired resource messaging

Hooks/services
├─ useAlbums: send album expiration fields; purge local album data on deletion
├─ usePhotoActions/usePhotoList: send photo expiration fields; remove expired/tombstoned photos
├─ SyncContext/sync-engine: treat 404 and 410 as deletion signals for local purge
├─ db.worker: clearAlbumPhotos plus photo-level cache deletion
├─ epoch-key-store: clearAlbumKeys for album purge
└─ photo-service/thumbnail caches: revoke blob URLs and evict thumbnails for expired photos/albums
```

### Sync/local purge

```text
Backend 410/404 or tombstone
  → SyncContext/sync-engine catches deletion signal
  → unregister album/photo from auto-sync queues
  → clearAlbumKeys(albumId) for album deletion
  → db.clearAlbumPhotos(albumId) or db.deletePhoto(photoId)
  → revoke blob URLs / clear thumbnail caches / drop queued uploads for deleted resource
  → update React state so gallery/list no longer renders stale decrypted data
```

### Focused tests

```text
Backend xUnit
├─ album expiration endpoint contract response shape
├─ owner/editor/viewer access denial
├─ at-deadline 410 behavior using server UTC clock
├─ sweep detaches opaque shard references and reclaims album slot
└─ photo expiration route contract (red until implementation exists)

Web Vitest
├─ deadline countdown/warning formatting
├─ destructive confirmation before enabling/shortening expiration
├─ API payload for set/clear expiration
└─ local purge when sync sees 410/404 deletion signal

E2E/script
└─ mocked-route Band 5 spec after UI implementation: 410 sync/download route causes expired banner and local gallery removal without requiring production data setup.
```

## Verification plan

### Backend focused tests

Run only expiration-related backend tests:

```powershell
dotnet test apps\backend\Mosaic.Backend.Tests --filter "FullyQualifiedName~AlbumsControllerTests|FullyQualifiedName~GarbageCollectionServiceTests|FullyQualifiedName~ExpirationRouteContractTests"
```

Expected pre-implementation red state on base `642caaa`:

- Album endpoint response shape currently lacks the full `id`/`updatedAt` contract.
- Album `GET` may still return `200` for expired albums while sync returns `410`.
- Photo expiration route/data model is absent until the backend Band 5 lane lands.

Backend contract acceptance criteria the focused tests must cover:

1. Default album/photo expiration is `null` and non-expiring.
2. Owners can set/remove album expiration; non-owners cannot.
3. Editors/owners can set/remove photo expiration; viewers/non-members cannot.
4. Server clock controls future-vs-expired decisions using a fake `TimeProvider`.
5. Expired album access returns gone/not found and a sweep removes album records, manifests, memberships, epoch keys, album content links, and shard references according to existing deletion paths.
6. Expired photo access returns gone/not found and a sweep removes active opaque content from manifest access plus detaches/trashes shard content.
7. Shard download/meta checks exclude expired albums/photos before returning opaque bytes.

### Web focused tests

Run only changed expiration/local-purge Vitest files:

```powershell
npm run test:run -- album-expiration-settings.test.tsx sync-context.test.tsx
```

Expected pre-implementation red state on base `642caaa`:

- Local purge currently handles `404 Not Found`; the Band 5 contract requires the same purge for `410 Gone` from expired album sync/download.
- Per-photo expiration UI/API tests remain pending until the web implementation lane adds the component/service surface.

### E2E/script focus

Do not run full Playwright/all-tests in this lane. Add a route-mocked E2E only after it can run through existing fixtures without backend/data changes, then run:

```powershell
npx playwright test tests\band5-expiration.spec.ts --project=chromium --reporter=list
```

## Merge order and dependencies

1. Backend expiration implementation lane adds photo deadline persistence, route contracts, access denial, and sweep behavior.
2. Web expiration UI/local purge lane adds photo controls, countdowns, and 410 purge handling.
3. This focused test/spec lane merges after the relevant implementation lane(s), turning expected red contract tests green.
4. Band 8 runs the reserved full matrix.

