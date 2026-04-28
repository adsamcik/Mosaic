# SPEC: Timed Expiration Backend Contract

## Scope

Backend-only contract for opt-in timed expiration of albums and individual photos (manifest records). Web, Android, Rust, and client-side key handling are out of scope for this workstream.

## Data Flow

### Album create/update/list/get/sync

Album expiration is lifecycle metadata and remains server-visible:

```json
{
  "id": "uuid",
  "ownerId": "uuid",
  "currentEpochId": 1,
  "currentVersion": 1,
  "encryptedName": "opaque client ciphertext or null",
  "encryptedDescription": "opaque client ciphertext or null",
  "expiresAt": "2026-05-01T12:00:00Z or null",
  "expirationWarningDays": 7
}
```

`PATCH /api/albums/{albumId}/expiration` accepts:

```json
{
  "expiresAt": "2026-05-01T12:00:00Z or null",
  "expirationWarningDays": 7
}
```

`expiresAt: null` disables album expiration. Non-null deadlines must be in the future according to the server clock.

### Photo/manifest create/get/sync/update

A photo is represented by a manifest plus opaque encrypted shard references. Photo expiration is lifecycle metadata and remains server-visible:

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

`POST /api/manifests` accepts optional `expiresAt`. `PATCH /api/manifests/{manifestId}/expiration` accepts:

```json
{ "expiresAt": "2026-05-01T12:00:00Z or null" }
```

`expiresAt: null` disables photo expiration. Non-null deadlines must be in the future according to the server clock.

## Authorization

- Album expiration updates require the album owner, matching existing album destructive-management rules.
- Photo expiration updates require existing photo modification rights (`owner` or `editor` album role), matching manifest metadata/delete rules.
- Access to expired content is denied even when membership still exists.

## Enforcement

- Deadlines are evaluated only with the backend server clock (`TimeProvider`). Client clocks are ignored.
- Expiration is opt-in: `expiresAt == null` means no expiration.
- At or after an album deadline, the backend hard-deletes the album through the expiration service before returning content.
- At or after a photo deadline, the backend marks the manifest deleted, wipes its opaque encrypted metadata from the active record, detaches manifest-shard links, and makes shards inaccessible through existing trash/delete cleanup patterns.
- Endpoint-integrated checks run before serving album, manifest, shard, sync, upload, or mutation responses that could expose expired content.
- Background garbage collection calls the same deterministic expiration service so tests can execute sweeps directly.

## Zero-Knowledge Invariants

- The backend stores only UTC deadlines, encrypted album metadata, encrypted photo metadata, encrypted shard bytes, signatures, and public keys.
- The backend never receives or logs plaintext filenames, EXIF/GPS/device data, photo bytes, album names, descriptions, passwords, or keys.
- Expiration responses and errors do not echo encrypted metadata, shard content, key material, or caller-provided plaintext-like values.
- Deletion operates on opaque database rows and storage keys only; no content parsing or decryption occurs.

## Verification Plan

Focused backend tests cover:

1. Default album/photo expiration is `null` and non-expiring.
2. Owners can set/remove album expiration; non-owners cannot.
3. Editors/owners can set/remove photo expiration; viewers/non-members cannot.
4. Server clock controls future-vs-expired decisions using a fake `TimeProvider`.
5. Expired album access returns gone/not found and a sweep removes album records, manifests, memberships, epoch keys, album content links, and shard references according to existing deletion paths.
6. Expired photo access returns gone/not found and a sweep removes active opaque content from manifest access plus detaches/trashes shard content.
7. Shard download/meta checks exclude expired albums/photos before returning opaque bytes.
