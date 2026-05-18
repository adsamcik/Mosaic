# Mosaic Export Format (v1.0)

> GDPR Article 20 (right to data portability) — see [`SECURITY.md`](SECURITY.md#right-to-portability-gdpr-article-20).

Mosaic users can download their entire data footprint as a streaming zip
archive via `GET /api/v1/export` (UI: **Settings → Data → Download Export**).
This document is the authoritative reference for the archive layout, the
embedded JSON schemas, and the offline-decryption procedure.

The archive contains **only ciphertext, wrapped keys, and public metadata**
— the server never decrypts user content during export. Decryption is the
exporter's responsibility and requires the password the user used to
register the account.

---

## Top-level layout

```
mosaic-export-<user-id>-<yyyyMMdd-HHmmss>.zip
├── metadata.json                          # Export header
├── kdf-params.json                        # Argon2id + HKDF parameters
├── account-key-wrapped.bin                # L2 wrapped by L1 (~48 bytes)
├── identity-seed-wrapped.bin              # Ed25519 seed wrapped by L1 (optional)
├── salt.bin                               # 16-byte Argon2id user salt
├── account-salt.bin                       # 16-byte HKDF account salt
└── albums/
    └── <album-id>/
        ├── album.json                     # Album row metadata
        ├── members.json                   # Member roster
        ├── share-links.json               # Share links + access tiers
        ├── epoch-keys.json                # Per-recipient wrapped epoch keys
        ├── manifests/
        │   ├── <manifest-id>.json
        │   ├── <manifest-id>.encrypted-meta.bin
        │   └── <manifest-id>.encrypted-meta-sidecar.bin   # (optional)
        └── shards/
            ├── <shard-id>.bin             # XChaCha20-Poly1305 ciphertext
            └── <shard-id>.bin.missing     # Marker for GCed blob (optional)
```

Only albums **owned** by the exporting user appear. Albums where the user
is merely a member are excluded — exporting them would leak another user's
content, and each owner can produce their own export.

---

## JSON files

### `metadata.json`

```json
{
  "userId": "<UUIDv7>",
  "exportedAt": "2025-04-01T12:34:56.7890123Z",
  "version": "1.0",
  "note": "Mosaic GDPR Article 20 export. All blobs are ciphertext; decrypt offline with your password. See docs/EXPORT_FORMAT.md."
}
```

### `kdf-params.json`

The Argon2id + HKDF parameters pinned at registration. Required to
re-derive L0 (master) → L1 (root) → unwrap L2 (account).

```json
{
  "SaltVersion": 1,
  "KdfAlgVersion": 19,
  "KdfMemoryKib": 65536,
  "KdfIterations": 3,
  "KdfParallelism": 1
}
```

`KdfAlgVersion = 19` (`0x13`) is Argon2id v1.3.

### `albums/<id>/album.json`

```json
{
  "Id": "<UUIDv7>",
  "OwnerId": "<UUIDv7>",
  "CurrentEpochId": 1,
  "CurrentVersion": 1,
  "CreatedAt": "...",
  "UpdatedAt": "...",
  "EncryptedName": "<base64 ciphertext>",
  "EncryptedDescription": "<base64 ciphertext>",
  "ExpiresAt": null,
  "ExpirationWarningDays": 7,
  "MemberRosterSignature": "<base64 bytes or null>",
  "MemberRosterSignerEpochId": 1,
  "MemberRosterVersion": 0
}
```

### `albums/<id>/members.json`

Array of `{AlbumId, UserId, Role, InvitedBy, JoinedAt, RevokedAt}`. The
`UserId` values are opaque UUIDs — they only resolve to identities if the
exporter has the same identity directory available offline.

### `albums/<id>/share-links.json`

Array of share-link rows including `LinkId` (16 bytes), `AccessTier`
(1=thumb, 2=preview, 3=full), `OwnerEncryptedSecret` (allows the owner to
recover the link secret offline), `ExpiresAt`, `MaxUses`, `UseCount`,
`IsRevoked`, `CreatedAt`.

### `albums/<id>/epoch-keys.json`

Array of `{Id, AlbumId, RecipientId, EpochId, EncryptedKeyBundle,
OwnerSignature, SharerPubkey, SignPubkey, CreatedAt}`. The
`EncryptedKeyBundle` is the per-recipient wrapped epoch read/sign key
bundle — only the recipient's account key can unwrap it.

### `albums/<id>/manifests/<id>.json`

```json
{
  "Id": "<UUIDv7>",
  "AlbumId": "<UUIDv7>",
  "ProtocolVersion": 1,
  "AssetType": "Image",
  "VersionCreated": 1,
  "MetadataVersion": 1,
  "IsDeleted": false,
  "Signature": "<base64>",
  "SignerPubkey": "<base64>",
  "CreatedAt": "...",
  "UpdatedAt": "...",
  "TombstoneSignature": null,
  "TombstoneSignerEpochId": null,
  "ManifestSeq": 42,
  "ExpiresAt": null,
  "ManifestShards": [
    {
      "ShardId": "<UUIDv7>",
      "ChunkIndex": 0,
      "ShardIndex": 0,
      "Tier": 3,
      "Sha256": "<hex>",
      "ContentLength": 4096,
      "EnvelopeVersion": 3
    }
  ]
}
```

Tombstone-deleted manifests (`IsDeleted: true`) are included so the user
sees their full history. The `ManifestShards` array is ordered by
`(ChunkIndex, ShardIndex)`.

---

## Binary files

### `account-key-wrapped.bin`

The L2 account key wrapped under L1. This is exactly the byte sequence
returned by `GET /api/v1/users/me` in the `WrappedAccountKey` field. The
server stores it at rest and includes it here so the user can unwrap it
offline.

### `identity-seed-wrapped.bin`

The Ed25519 identity seed wrapped under L1, if the user uploaded one
during registration. Used for sealed-box invite encryption.

### `salt.bin` / `account-salt.bin`

The 16-byte Argon2id user salt and 16-byte HKDF account salt. These are
non-secret per the threat model (plaintext at rest in the database).

### `albums/<id>/manifests/<id>.encrypted-meta.bin`

Per-manifest encrypted metadata blob. AEAD-encrypted under the album's
epoch read key — content includes the original filename, dimensions,
EXIF (if not stripped at upload), and creation timestamps.

### `albums/<id>/manifests/<id>.encrypted-meta-sidecar.bin`

Optional secondary metadata sidecar (e.g. heavy EXIF / IPTC blobs kept
out of the main manifest entry for performance). Same encryption as the
primary `encrypted-meta.bin`.

### `albums/<id>/shards/<shard-id>.bin`

The raw shard blob as stored on disk: a 64-byte envelope header (see
[`SECURITY.md`](SECURITY.md#envelope-format)) followed by
XChaCha20-Poly1305 ciphertext + 16-byte authentication tag. Decrypt with
the album's epoch read key for the tier matching the envelope's `Tier`
field.

The exporter uses `CompressionLevel.NoCompression` for these entries —
ciphertext is already high-entropy, and deflate-on-ciphertext is a CPU
waste that typically *grows* the output by a few bytes.

### `<shard-id>.bin.missing`

Empty marker written instead of a shard blob when the storage backend
reports the blob as missing (already garbage-collected). The shard row
itself is still preserved in the relevant `manifest.json` so the user
can audit what was lost.

---

## Offline decryption

1. Read `kdf-params.json` and `salt.bin`. Run Argon2id over your password
   with those parameters to derive **L0** (32 bytes).
2. Read `account-salt.bin`. Run HKDF-SHA256(L0, account_salt,
   "Mosaic_RootKey_v1") to derive **L1** (32 bytes).
3. Read `account-key-wrapped.bin`. Unwrap with L1 (XChaCha20-Poly1305) to
   obtain **L2**, the account encryption key.
4. For each `albums/<id>/epoch-keys.json` entry where `RecipientId` is
   your own user id, unwrap `EncryptedKeyBundle` with L2 to obtain the
   per-epoch read key (and sign key, if you need to verify signatures).
5. For each `albums/<id>/shards/<shard-id>.bin`:
   - Parse the 64-byte envelope header.
   - Look up the matching epoch read key from step 4 (by `EpochId` in the
     envelope and the manifest's `Tier`).
   - Decrypt the ciphertext using AEAD with the full 64-byte header as
     additional authenticated data.
6. Use `albums/<id>/manifests/<manifest-id>.json` to reassemble shards in
   `(ChunkIndex, ShardIndex)` order back into the original photo.
7. Decrypt `encrypted-meta.bin` (and `encrypted-meta-sidecar.bin` where
   present) with the same epoch read key to recover the original
   filename, EXIF, and other metadata.

Reference implementations of every step live in
[`libs/crypto/`](../libs/crypto/) — clone the repository and run the
crypto library against your archive offline.

---

## Versioning

`metadata.json.version` follows semver-major.minor. Breaking changes
(file relocations, schema renames) bump the major; additive fields
(new optional binary blobs, new JSON fields) bump the minor. A consumer
written for `1.x` MUST tolerate unknown keys and unknown top-level files.

| Version | Date       | Notes |
| ------- | ---------- | ----- |
| `1.0`   | 2025-04-01 | Initial release (v1.0.x s38, GDPR Article 20). |
