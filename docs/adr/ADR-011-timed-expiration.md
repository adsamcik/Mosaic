# ADR-011: Support opt-in server-enforced timed album and photo expiration

## Status

Accepted

## Context

Image sharing often needs temporary albums or photos. Since Mosaic is not a backup product, destructive expiration can be a useful sharing feature as long as the user clearly opts in and understands deletion semantics.

The backend must know an expiration deadline to enforce deletion for offline clients. That deadline is lifecycle/access-control metadata, not encrypted photo metadata.

## Decision

Mosaic supports opt-in timed expiration for albums and individual photos.

Rules:

- Expiration is off by default.
- Enabling expiration requires clear destructive confirmation.
- Expiration deadlines are server-visible UTC timestamps.
- Album expiration hard-deletes the album and all contained photos.
- Photo expiration hard-deletes that photo.
- If both album and photo expiration exist, the earlier deadline wins.
- Backend authorization denies access at or after the effective deadline.
- Backend cleanup deletes opaque manifests, shards, access-control records, and storage objects without inspecting encrypted content.
- Clients show expiration badges, countdowns, and warnings.
- After sync observes deletion, clients purge local decrypted metadata, thumbnails, queue references, and cached encrypted blobs for the deleted resources.

## Options Considered

### Client-only hidden expiration

- Pros: server learns no deadline.
- Cons: cannot enforce for offline/stale clients; server still stores content after deadline.
- Conviction: 3/10.

### Server-visible hard-delete expiration

- Pros: enforceable; simple user model; aligns with sharing/not-backup framing.
- Cons: server learns deadline; destructive mistakes need strong UX prevention.
- Conviction: 9/10.

### Soft-delete/trash with recovery window

- Pros: safer accidental recovery.
- Cons: weaker expiration semantics; more server state; may imply backup-like retention.
- Conviction: 5/10.

## Consequences

- Expiration timestamps are included in the server-visible metadata leakage budget.
- Expiration tests must cover exact-deadline behavior, UTC clock authority, membership access after expiry, cleanup of linked opaque blobs, and client local purge.
- Photo-level expiration may require a manifest/photo lifecycle field separate from encrypted photo metadata.
- Current album-only expiration behavior can evolve to this ADR before late v1 stabilization.

## Reversibility

Medium before release. If hard-delete UX proves too risky, the ADR must be revised before implementation changes semantics.
