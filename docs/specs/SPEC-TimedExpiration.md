# SPEC-TimedExpiration

## Status

Partially superseded. Album expiration and share-link expiration are supported.
The per-photo portions of this specification are historical and
non-authoritative: both former photo-expiration handlers are non-routable,
public v2 manifest finalization rejects non-null `expiresAt`, and the backend
does not run an automatic per-photo expiration sweep.

The earlier Lane I/Lane H commits documented below proved a prototype, not the
current public photo-lifecycle contract. Per-photo expiration may be restored
only after a later decision defines a reservation-backed mutation whose
positive sequence is included in a fresh client signature and verified by
per-manifest replay checkpoints. The current decision record is
[ADR-011](../adr/ADR-011-timed-expiration.md), and the generated HTTP contract is
[`docs/openapi.json`](../openapi.json).

## Historical implementation record

The original combined album/photo design was tracked by backend commits
`f83b688`, `f6b88b7`, and `efb02ed`, web commits `3131cfa`, `66ae297`,
`54105e0`, and `34a90ad`, sync commit `3e9fb5d`, and contract-coverage commit
`757a496`. Those references are retained for archaeology and do not re-enable
withdrawn routes.

## Goals

- Let owners opt in to destructive UTC expiration for albums.
- Enforce album and share-link access denial at or after their deadlines using the server clock.
- Hard-delete expired album-owned opaque content and access-control rows without inspecting encrypted payloads.
- Make destructive album-expiration UX explicit with confirmations, countdowns, and warning states.
- Purge local decrypted metadata, thumbnails, queued references, keys, and cached encrypted blobs after sync observes album deletion/expiry.

## Non-goals

- No per-photo expiration mutation, enforcement, or automatic sweep in the current public contract.
- No recovery/trash UX after album expiration fires.
- No server-side plaintext photo, EXIF, title, description, or key processing.
- No proactive email/push notifications; warnings are in-app only.

## Terminology

| Term | Meaning |
| --- | --- |
| Album expiration | Nullable server-visible deadline on an album. When reached, the album and all contained photos become inaccessible and are swept. |
| Share-link expiration | Nullable server-visible access deadline on one share link; it does not create a photo lifecycle. |
| Deferred photo expiration | Historical nullable manifest field and prototype only; there is no supported mutation route or automatic sweep. |
| Lifecycle metadata | Server-visible operational metadata needed to enforce album/link expiration; not encrypted user photo metadata. |
| Tombstone | Signed ordered manifest deletion record; it is a normal client mutation, not an automatic photo-expiration mechanism. |

## Data flow and API contract

All deadlines are UTC ISO 8601 timestamps. Clients MUST send an explicit offset or `Z`; backend normalizes persisted values and JSON responses to UTC.

### Create album with optional expiration

`POST /api/v1/albums`

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

`PATCH /api/v1/albums/{albumId}/expiration`

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

### Deferred: per-photo expiration

There is no routable per-photo expiration endpoint. In particular, neither
`PATCH /api/v1/albums/{albumId}/photos/{photoId}/expiration` nor
`PATCH /api/v1/manifests/{manifestId}/expiration` is part of the public API.
`POST /api/v1/manifests/{manifestId}/finalize` rejects a non-null `expiresAt`.
The `Manifest.ExpiresAt` storage field may remain visible in legacy rows and
exports for compatibility, but it is not a supported producer capability.

A future design must use the ordered manifest lifecycle: reserve a
`MetadataUpdate` (or a new explicitly specified operation), sign its positive
`manifestSeq`, consume the matching target-bound reservation atomically, and
store replay state per logical manifest in encrypted client security state.
Until that design is accepted and implemented, clients must not render or call
photo-expiration controls.

### Read/list/sync behavior

| API | Before album deadline | At/after album deadline |
| --- | --- | --- |
| `GET /api/v1/albums` | Includes accessible albums with `expiresAt` and `expirationWarningDays`. | Expired albums are omitted once access is denied or swept. |
| `GET /api/v1/albums/{albumId}` | Returns album lifecycle fields. | Returns `410 Gone` until hard-delete removes the album, then `404 Not Found`. |
| `GET /api/v1/albums/{albumId}/sync?since=N` | Returns changes and lifecycle fields needed by web warning UI. | Returns `410 Gone` until hard-delete removes the album, then `404 Not Found`; clients purge local album data for either status. |
| Manifest and shard reads | Return opaque content only while the containing album remains accessible. | Deny content beneath the expired album until deletion completes, then return not found. |
| Share-link access | Enforces both the containing album deadline and the share link's own deadline. | Returns the relevant gone/denied result without serving opaque content. |

Clients treat an album-level `410` or subsequent `404` as deletion for local
purge. Ordinary per-photo deletion continues through the signed ordered
tombstone contract and must not be described as automatic expiration.

## Server lifecycle and hard-delete contract

1. An owner sets a future UTC album deadline, or a supported share-link flow sets a future link deadline.
2. At `Album.ExpiresAt <= server UtcNow`, backend access checks deny reads, downloads, sync, and mutations beneath the album.
3. The background album sweep processes expired albums in bounded batches and deletes or detaches album limits, memberships, grants, share links, epoch keys, manifests, manifest-shard joins, story content, and opaque shard references through the existing deletion paths.
4. Expired share links are denied immediately and later removed under the share-link retention policy.
5. Physical shard bytes are removed by the existing trashed-shard pipeline; expiration must not leave readable active references.
6. No automatic query or sweep uses `Manifest.ExpiresAt` to expire an individual photo.
7. Logs may include resource IDs, counts, and deadlines, but never keys, plaintext metadata, encrypted metadata blobs, shard bytes, signed manifests, or share-link secrets.

## Zero-knowledge invariants

Expiration timestamps are allowed server-visible lifecycle metadata because the server must enforce deletion for offline/stale clients. They reveal only an operator-selected deadline, comparable to `createdAt`, membership rows, quotas, or share-link expiry. They are not photo metadata like title, date taken, EXIF, location, album name, captions, or tags.

The contract preserves zero-knowledge constraints:

- Clients continue to encrypt album names/descriptions and photo metadata before upload.
- Server APIs accept only lifecycle timestamps plus opaque encrypted payloads that already existed in the upload/sync contracts.
- Supported album/share-link expiration APIs never accept plaintext names, photo metadata, passwords, keys, or decrypted thumbnails.
- Server cleanup deletes opaque rows/objects by ID and status; it never decrypts or parses `encryptedMeta`, shard bytes, or key bundles.
- Album-level `410` responses and signed tombstones identify affected resources without exposing plaintext; no encrypted photo metadata is needed for local purge.
- Local purge wipes decrypted data and key material. Epoch/read/sign keys remain client-only and must be wiped with existing key-store memory hygiene.

## Component and service tree

### Supported backend and web surface

```text
Backend
├─ AlbumsController
│  ├─ POST /api/v1/albums accepts expiresAt/expirationWarningDays
│  ├─ PATCH /api/v1/albums/{albumId}/expiration is owner-only
│  └─ album reads/sync deny access after expiry
├─ ShareLinksController / ShareLinkAccessController
│  ├─ share-link create and expiration update accept link deadlines
│  └─ access enforces both album and link deadlines
├─ AlbumExpirationService + GarbageCollectionService
│  └─ enforce and delete expired albums through opaque cleanup paths
└─ Manifest/shard/Tus endpoints
   └─ deny content beneath an expired album

Web
├─ CreateAlbumDialog + AlbumExpirationSettings
├─ AlbumCard/GalleryHeader expiration badge and warnings
├─ SyncContext/sync-engine maps album 410/404 to local purge
└─ local-purge/db/key/thumbnail/upload stores remove album-local state
```

### Explicitly absent photo surface

```text
No routable album/photo expiration PATCH
No routable manifest-expiration PATCH
No non-null expiresAt on public v2 finalize
No CleanExpiredPhotos automatic sweep
No supported photo-expiration UI or API adapter
```

Ordinary photo deletion remains a reservation-backed signed `Tombstone`
mutation and local sync purge; it is not part of timed expiration.

## Verification plan

### Backend focused checks

Expiration coverage must prove:

1. Album expiration defaults to `null`; owners can set/remove it and non-owners cannot.
2. The server clock controls future-vs-expired decisions.
3. Expired album access returns gone/not-found and cleanup removes all album-owned opaque references through existing deletion paths.
4. Share-link access enforces both link and album deadlines.
5. The two former photo-expiration handlers have no route metadata, public v2 finalize rejects non-null `expiresAt`, and garbage collection does not expire manifests by `Manifest.ExpiresAt`.
6. Manifest/shard/Tus reads exclude content beneath expired albums before returning opaque bytes.

Run the focused backend suites that own album expiration, share-link expiry,
garbage collection, manifest finalization, and route-contract assertions. The
generated OpenAPI drift check must also remain clean so withdrawn routes cannot
silently reappear.

### Web focused checks

Web tests must cover destructive album-expiration acknowledgement, deadline
formatting, album-level 410/404 local purge, and absence of calls to withdrawn
photo-expiration routes. Per-photo expiration UI/API tests are not an expected
future-red suite; they require a new accepted signed-lifecycle design first.

## Reintroducing per-photo expiration

A future change must land in this order:

1. Accept a replacement ADR/spec defining the signed lifecycle operation and transcript fields.
2. Implement reserve → sign → mutate semantics with target-bound sequence consumption.
3. Persist client replay checkpoints per manifest in separate encrypted security state.
4. Add backend access/cleanup behavior, generated OpenAPI, web controls, and cross-client tests together.
5. Remove the deferred markers only after the complete public path is drift-gated and verified.
