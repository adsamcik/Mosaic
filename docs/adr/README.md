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

Supporting baseline:

- [MVP client-core protocol baseline](../protocol/mvp-client-core-baseline.md)
- [Golden vector fixtures](../../tests/vectors/README.md)
