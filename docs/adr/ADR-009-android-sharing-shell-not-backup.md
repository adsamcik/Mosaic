# ADR-009: Build Android as an image-sharing upload/import shell, not a backup product

## Status

Accepted

## Context

Mosaic's primary product is encrypted image sharing for small personal groups. Android support should make it easy to add photos from a device, but Mosaic should not imply it is the user's authoritative photo backup or long-term preservation system.

Backup semantics would require stronger guarantees around completeness, background reliability, retention, recovery, deduplication, conflict history, undelete, device replacement, and storage durability than the current product should promise.

## Decision

The Android app starts as a thin image-sharing shell:

- unlock account/session,
- choose destination album,
- select photos through Photo Picker,
- encrypt/upload/share through Rust client core,
- later enable opt-in camera-roll auto-import for selected sharing albums.

Android camera-roll automation is described as import/upload convenience for sharing, not backup. Users are expected to maintain independent backups outside Mosaic.

Default UX favors simple E2EE sharing flows. Advanced settings expose granular controls for metadata preservation, export stripping, source-original archival, auto-import constraints, and background behavior.

## Options Considered

### Build Android as a full gallery replacement

- Pros: complete mobile experience.
- Cons: much larger scope; delays encrypted upload; duplicates browsing/editing features.
- Conviction: 4/10.

### Build Android as a backup agent

- Pros: familiar camera-roll automation value.
- Cons: changes reliability expectations; encourages users to treat Mosaic as source of truth; conflicts with current product goal.
- Conviction: 2/10.

### Build Android as a sharing upload/import shell first

- Pros: focused value; aligns with zero-knowledge architecture; supports future expansion.
- Cons: some users may expect backup semantics and need clear wording.
- Conviction: 9/10.

## Consequences

- Product copy must avoid "backup" for Android auto-import unless a future backup product is explicitly designed.
- Auto-import can skip backup-grade promises such as exhaustive historical reconciliation and permanent local source retention.
- Source-original archival remains a user-configurable encrypted option, not a default backup guarantee.
- Timed expiration and hard delete are acceptable product features because Mosaic is not the preservation source of truth.

## Reversibility

Medium. A future backup product would require a separate roadmap and ADRs for retention, restore, reliability, storage, and UX guarantees.
