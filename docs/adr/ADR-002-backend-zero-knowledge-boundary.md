# ADR-002: Keep the backend as zero-knowledge opaque storage and API coordination

## Status

Accepted

## Context

Mosaic's security model depends on the server never seeing plaintext photos, photo metadata, filenames, EXIF, GPS data, captions, thumbnails, or cryptographic keys. The backend currently coordinates authentication, albums, memberships, Tus uploads, manifests, shards, quotas, and garbage collection.

The Rust client-core rework must not turn the backend into a media processor, metadata interpreter, protocol oracle, or plaintext import service.

## Decision

The .NET backend remains a zero-knowledge server that stores and coordinates opaque encrypted client payloads. It may validate transport and access-control metadata, but it must not parse encrypted photo metadata or inspect image content.

Allowed server-visible data is limited to:

- authenticated user and membership identifiers,
- album/photo/manifest/shard opaque identifiers,
- upload status, Tus offsets, byte counts, quota accounting, and server timestamps,
- encrypted manifest/blob bytes and their lengths,
- manifest signatures and signer public keys,
- shard hashes supplied for encrypted-blob integrity linking,
- access-control roles and sharing metadata,
- timed expiration UTC deadlines when a user explicitly enables expiration.

All photo content, preserved metadata, thumbnails, captions, filenames, device metadata, GPS data, and media-derived dimensions stay encrypted client-side unless a later ADR explicitly changes the leakage budget.

## Options Considered

### Server-side import inbox for plaintext uploads

- Pros: integrates with generic Android/WebDAV/SFTP/S3-style upload tools.
- Cons: violates zero-knowledge guarantees; requires server media parsing and encryption; creates a high-value plaintext staging area.
- Conviction: 1/10.

### Backend validates encrypted-payload structure deeply

- Pros: can reject malformed client protocol payloads earlier.
- Cons: tempts server-side knowledge of client schemas; increases coupling to encrypted metadata; risks plaintext metadata creeping into API contracts.
- Conviction: 4/10.

### Backend validates only opaque storage/access-control lifecycle

- Pros: preserves zero knowledge; keeps backend simple; makes Rust client core the protocol owner.
- Cons: malformed encrypted client payloads are mostly detected by clients.
- Conviction: 9/10.

## Consequences

- Backend tests must prove encrypted payloads are treated as opaque bytes.
- API contracts should make all server-visible fields explicit and reject plaintext media/metadata fields.
- Backend cleanup may delete opaque resources by lifecycle state, ownership, quota, or expiration deadline without inspecting content.
- Contract evolution is allowed while Mosaic is unreleased, but leakage-budget changes require ADR and vector/test updates.

## Reversibility

Low-cost before release. Any accidental plaintext API field must be removed immediately and covered by regression tests because retaining it would alter the threat model.
