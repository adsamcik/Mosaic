# Architecture Decision Records

This directory contains architecture decisions for the Mosaic Rust client-core rework.

The records are intentionally scoped to decisions that unblock the Android encrypted upload MVP and the web/Rust transition. API and protocol details may still evolve while Mosaic is unreleased, but changes to security-sensitive behavior must update the protocol baseline and golden-vector fixtures.

| ADR | Decision |
| --- | --- |
| [ADR-001](ADR-001-rust-client-core.md) | Adopt a Rust client core with web and Android adapter frontends |
| [ADR-002](ADR-002-backend-zero-knowledge-boundary.md) | Keep the backend as zero-knowledge opaque storage and API coordination |
| [ADR-003](ADR-003-rust-domain-crypto-canonical.md) | Make Rust domain and crypto contracts canonical |
| [ADR-004](ADR-004-ports-and-adapters.md) | Use ports and adapters around platform capabilities |
| [ADR-005](ADR-005-rust-crypto-dependencies.md) | Prefer audited pure-Rust crypto dependencies for the Rust core |
| [ADR-006](ADR-006-ffi-api-secret-handles.md) | Expose Rust through handle-based WASM and UniFFI APIs |
| [ADR-007](ADR-007-android-media-background-model.md) | Use Photo Picker for manual upload and least-privilege MediaStore/WorkManager for future auto-import |
| [ADR-008](ADR-008-media-processing-gate.md) | Gate Rust media processing behind cross-platform prototype results |
| [ADR-009](ADR-009-android-sharing-shell-not-backup.md) | Build Android as an image-sharing upload/import shell, not a backup product |
| [ADR-010](ADR-010-reject-plaintext-protocol-inbox.md) | Reject generic plaintext protocol import inboxes |
| [ADR-011](ADR-011-timed-expiration.md) | Support opt-in server-enforced timed album and photo expiration |
| [ADR-012](ADR-012-android-internet-trust-boundary.md) | Grant INTERNET on Android with TLS-only, no-body-logging, static-guard constraints |
| [ADR-013](ADR-013-streaming-shard-aead.md) | Freeze streaming shard AEAD framing in v1; ship vectors but defer production wiring to v1.x |
| [ADR-014](ADR-014-codec-choice-parity-strictness.md) | Codec choice: platform codecs with Rust-side deterministic strip + sidecar (closes ADR-008) |
| [ADR-015](ADR-015-album-story-content-deferral.md) | Defer album story/content document shape decisions to v1.x |
| [ADR-016](ADR-016-web-opfs-encrypted-cache-deferral.md) | Defer web encrypted local cache (OPFS) strategy to v1.x |
| [ADR-017](ADR-017-sidecar-tag-registry-policy.md) | Sidecar tag numbers governed by an append-only, lock-tested, ADR-changeable registry |
| [ADR-018](ADR-018-telemetry-kill-switch.md) | Opaque-error-code-only telemetry, opt-in operator aggregates, no server-driven kill-switch |
| [ADR-019](ADR-019-android-cert-pinning.md) | Public-key pin to operator CA + backup pin in release; disabled in dev/E2E |
| [ADR-020](ADR-020-supply-chain-amendment.md) | Amend ADR-005 supply-chain posture for media + transport crates |
| [ADR-021](ADR-021-legacy-raw-key-fallback-sunset.md) | Retain legacy raw-key shard fallback in v1; telemetry-gated sunset in v1.x |
| [ADR-022](ADR-022-manifest-finalization-shape.md) | Manifest finalization shape: `tieredShards` canonical write, legacy `shardIds` read-only |
| [ADR-023](ADR-023-persisted-snapshot-schema.md) | Snapshot persistence: CBOR canonical encoding, schema_version migration coordinate |
| [ADR-024](ADR-024-video-preview-tier-policy.md) | Video assets ship tier 1 + tier 3; tier 2 forbidden for video |

Supporting baseline:

- [MVP client-core protocol baseline](../protocol/mvp-client-core-baseline.md)
- [Golden vector fixtures](../../tests/vectors/README.md)
