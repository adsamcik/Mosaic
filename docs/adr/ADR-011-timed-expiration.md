# ADR-011: Support opt-in server-enforced timed album and photo expiration

## Status

Accepted for album expiration; amended to defer per-photo expiration.

## Current implementation amendment (2026-07-26)

The supported contract is narrower than the original decision:

- Opt-in, server-enforced album expiration remains supported. Expiring an album
  makes all content beneath it inaccessible and schedules opaque cleanup.
- Share-link expiration remains supported as a separate link-access deadline.
- Per-photo expiration is unsupported. The former photo/manifest expiration
  handlers are non-routable, v2 manifest finalization rejects a non-null
  `expiresAt`, and automatic photo-expiration deletion is disabled.
- A future photo lifecycle change must reserve an ordered manifest mutation,
  bind its positive sequence into a fresh client signature, and consume the
  matching reservation atomically. Persisted legacy `Manifest.ExpiresAt`
  values do not make the old mutation routes supported.

Where the original photo-level decision below conflicts with this amendment,
this amendment controls. The older text is retained as design history.

## Context

Image sharing often needs temporary albums or photos. Since Mosaic is not a backup product, destructive expiration can be a useful sharing feature as long as the user clearly opts in and understands deletion semantics.

The backend must know an expiration deadline to enforce deletion for offline clients. That deadline is lifecycle/access-control metadata, not encrypted photo metadata.

## Decision

Mosaic supports opt-in timed expiration for albums. Share links can carry
their own independent access deadline. Individual-photo expiration was part of
the original design but is deferred by the current implementation amendment.

Rules for the supported album surface:

- Expiration is off by default.
- Enabling expiration requires clear destructive confirmation.
- Expiration deadlines are server-visible UTC timestamps.
- Album expiration hard-deletes the album and all contained photos.
- Backend authorization denies access at or after the album deadline.
- Backend cleanup deletes opaque manifests, shards, access-control records, and storage objects without inspecting encrypted content.
- Clients show expiration badges, countdowns, and warnings.
- After sync observes deletion, clients purge local decrypted metadata, thumbnails, queue references, and cached encrypted blobs for the deleted album.
- No public per-photo expiration route or automatic per-photo sweep is part of this contract.

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
- The withdrawn photo-level prototype demonstrated that a lifecycle field alone
  is insufficient: a supported update also needs a reservation-backed signed
  sequence and client replay-checkpoint design.
- The original photo-level intent remains historical until a later ADR defines
  that signed lifecycle and explicitly re-enables the surface.

## Reversibility

Medium before release. If hard-delete UX proves too risky, the ADR must be revised before implementation changes semantics.
