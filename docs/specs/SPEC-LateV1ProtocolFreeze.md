# SPEC: Late-v1 Protocol Candidate Inventory

## Status

**Candidate. Final freeze occurs on git tag `v1.0.0`.**

This document inventories the protocol surfaces that are candidates for v1.0.0. It is not a freeze declaration. The canonical freeze policy is [`SPEC-ReleaseTagFreezePolicy.md`](SPEC-ReleaseTagFreezePolicy.md): protocol surfaces become irreversible when the project owner cuts a release tag for a distributed build.

The current v1 candidate tree is `bd0cd7ba6650933ec5e88ad64c3a953621fdc6cb` (`origin/main`). Until `v1.0.0` is tagged, the surfaces below remain changeable through the standard review, parity, and architecture-guard processes.

Final freeze occurs when the project owner runs `git tag v1.0.0 && git push --tags`; that commit's bytes become the v1 wire/AAD/schema.

## Non-goals

- No backend, Rust, web, Android, or test implementation changes.
- No edits outside release-engineering protocol documentation and the §11 candidate-register framing.
- No new user-facing feature documentation; this is release-engineering protocol documentation.

## Candidate source of truth

- Candidate commit: `bd0cd7ba6650933ec5e88ad64c3a953621fdc6cb`.
- Candidate date: 2026-05-12.
- Canonical freeze policy: [`SPEC-ReleaseTagFreezePolicy.md`](SPEC-ReleaseTagFreezePolicy.md).
- Candidate inventory register: [`docs/IMPLEMENTATION_PLAN.md` §11](../IMPLEMENTATION_PLAN.md#11-late-v1-irreversibility-register), “Late-v1 Irreversibility Register”.
- Finalization ADR: [`docs/adr/ADR-022-manifest-finalization-shape.md`](../adr/ADR-022-manifest-finalization-shape.md).
- Cross-platform parity evidence: [`crates/mosaic-parity-tests/`](../../crates/mosaic-parity-tests/).

## Open list

| Item | Status | Disposition |
| --- | --- | --- |
| v1 protocol/API open items | Empty | All late-v1 protocol surfaces are candidate-locked by tests and remain changeable until the `v1.0.0` tag. |
| In-flight v1 protocol shape decisions | Empty | Further shape changes before `v1.0.0` update the candidate; changes after `v1.0.0` follow the release-tag policy. |
| Todo before v1 tag | Empty | Q-final-3 and Q-final-4 provide quality-gate evidence; Q-final-5 is the project-owner tag action. |

## Closed pre-tag domains

The prior readiness spec tracked these contract domains while Bands 5/6 and Android upload were still in flight. They are now closed as v1 candidates and remain referenced here for lock-test continuity:

- Backend API JSON.
- Opaque blob formats.
- Rust FFI DTOs.
- Android foundation contracts.
- Web WASM adapter boundary.
- Test vectors.
- Bands 5/6 follow-up surfaces.
- Android upload final protocol surfaces.

## Candidate invariants and surfaces

The following surfaces are the v1.0.0 freeze candidates. They are what the `v1.0.0` tag will lock if the project owner tags the current candidate tree. Until that tag, they remain conventionally locked by tests and architecture guards but may still be amended for cause. Citations point to §11 entries unless otherwise noted.

| Surface | Candidate value / rule | Citation |
| --- | --- | --- |
| L0/L1/L2/L3 key hierarchy | L0 password-derived master, L1 root, L2 account, L3 epoch/tier/signing material remain client-side; raw secrets do not cross normal FFI outputs. | §11 AEAD domain labels, KDF labels, auth/bundle contexts; zero-knowledge invariants in this spec. |
| AEAD domain-separation labels | Candidate set covers `mosaic:l3-epoch-seed:v1`, `mosaic:l3-identity-seed:v1`, `mosaic:account-wrapped-data:v1`, `mosaic:l2-account-key:v1`, `mosaic:l3-link-tier-key:v1`, `mosaic:stream-frame-key:v1`, `mosaic:stream-frame:v1`, plus the shard-envelope/header AAD domain for v0x03/v0x04 encryption. Cross-domain unwrap/replay must fail. | §11 “AEAD domain-separation labels”, “Streaming AEAD frame labels”, “Shard envelope wire format”, and “Streaming shard envelope wire format”. |
| Shard envelope v0x03 | Magic `SGzk`; version `0x03`; 64-byte header; reserved bytes zero; 24-byte nonce; AAD is the exact header bytes. | §11 “Shard envelope wire format”. |
| Streaming shard envelope v0x04 | Magic `SGzk`; version `0x04`; 64-byte header with tier, 16-byte stream salt, frame count, final frame size, 34 reserved-zero bytes; 64 KiB frames; deterministic per-frame nonce from `(stream_salt, frame_index)`; v0x03 dispatcher compatibility. | §11 “Streaming shard envelope wire format”. |
| `ShardTier` discriminants | `thumb=1`, `preview=2`, `full=3`; Rust names `Thumbnail`, `Preview`, `Original`. | §11 “`ShardTier` discriminants”. |
| Manifest transcript context | `Mosaic_Manifest_v1`; byte order, canonical encoding, and transcript inputs are candidates. | §11 “Manifest transcript context”. |
| Metadata sidecar context | `Mosaic_Metadata_v1`; canonical sidecar byte encoding is candidate-locked. | §11 “Metadata sidecar context”. |
| KDF labels | `mosaic:root-key:v1`, `mosaic:auth-signing:v1`, `mosaic:tier:thumb:v1`, `mosaic:tier:preview:v1`, `mosaic:tier:full:v1`, `mosaic:tier:content:v1`, `mosaic:db-session-key:v1`. | §11 “KDF labels”. |
| Auth and bundle contexts | `Mosaic_Auth_Challenge_v1`, `Mosaic_EpochBundle_v1`. | §11 “Auth & bundle contexts”. |
| Sidecar tag table | Candidate active/forbidden tag behavior; forbidden tags map to `MetadataSidecarError::ForbiddenTag`; complete canonical sidecar cap is `MAX_SIDECAR_TOTAL_BYTES = 65_536`. | §11 “Metadata sidecar total byte cap” and “Forbidden sidecar tag error contract”. |
| `tieredShards` JSON shape (B2) | Canonical manifest write shape uses `tieredShards` with explicit shard id, tier, index/hash/version semantics; legacy `shardIds` remains read compatibility only per ADR-022. | ADR-022, especially “Decision” and “Compatibility and migration rules”. |
| Manifest finalization shape (B5/ADR-022) | New clients write `tieredShards`; `protocolVersion` is `1`; idempotent finalization binds canonical request body; read responses preserve compatibility fields. | ADR-022 “Manifest create request”, “Manifest read response”, and “Compatibility and migration rules”. |
| Idempotency-Key format | `Idempotency-Key: mosaic-finalize-{jobId}` with `{jobId}` as the upload-job UUIDv7 string. | ADR-022; parity lock `crates/mosaic-parity-tests/tests/cross_platform_parity.rs::finalize_idempotency_key_parity`. |
| Canonical tier dimensions | Thumbnail `256`, preview `1024`, original/full `4096` canonical tier dimensions for v1 tier generation and manifest expectations. | B2/B5 tiered-shard decision set and ADR-022 tier semantics. |
| Stable error and FFI contract surfaces | Existing stable numeric error codes, public non-secret DTO names/fields, and raw-secret-output prohibition are candidate-locked. | §11 lock citations and architecture guard `tests/architecture/no-raw-secret-ffi-export.ps1`. |

## Zero-knowledge invariants

These invariants remain non-negotiable for every candidate and tagged release:

1. The server never receives plaintext photos, thumbnails, previews, originals, metadata, captions, filenames, EXIF/IPTC/XMP/GPS/device metadata, passwords, account keys, identity seeds, epoch seeds, tier keys, signing seeds, link secrets, or raw Photo Picker/content URIs.
2. Backend storage, Tus upload, manifest commit, sync, cleanup, and share-link delivery operate on opaque encrypted blobs and lifecycle metadata only.
3. Client encryption uses fresh nonces or deterministic streaming nonces only in the v0x04 construction where stream salt and frame index define the domain.
4. FFI boundaries expose handles and stable non-secret DTOs; raw secret output is a release blocker.
5. Logs, errors, OpenAPI examples, snapshots, vectors, and diagnostics must not expose plaintext sentinels or secrets.

## Versioning rule after tag

After `v1.0.0` is tagged, any change to a frozen surface requires all of the following in the same release train:

1. A major-version protocol tag (`v2.0.0` minimum) for breaking changes, or an explicit v1.x additive-compatibility ADR for non-breaking additions.
2. Snapshot version bump when persisted client-core state changes.
3. Migration plan covering old clients, old persisted snapshots, old manifests, and partial upload recovery.
4. Positive and negative vectors for native Rust, WASM, UniFFI, web, and Android where applicable.
5. Rollback/fail-safe behavior proving old clients do not decrypt or accept mismatched bytes silently.
6. A §11 register row citing both the source and target release tags.

## Release-blocker criteria

A post-tag change is a release blocker if it changes any frozen bytes, labels, JSON field names, discriminants, context strings, idempotency semantics, canonical tier dimensions, FFI public non-secret DTO shapes, stable error code meanings, or zero-knowledge leakage budget without satisfying the release-tag policy.

## Q-final-5 tag gate

Q-final-5 is not a document-authored freeze declaration. It is the project-owner action to run `git tag v1.0.0 && git push --tags` when they decide all candidate surfaces are right. The resulting tag is the v1 protocol freeze point.

## Verification plan

Release evidence for this candidate includes:

1. `cargo fmt --all -- --check`.
2. `cargo test --workspace --locked --no-fail-fast`.
3. `pwsh tests/architecture/no-raw-secret-ffi-export.ps1`.
4. Q-final-3 E2E coverage evidence from `docs/specs/SPEC-E2ECoverageMatrix.md`.
5. Q-final-4 performance budget evidence from `docs/specs/SPEC-PerformanceBudgets.md` and `scripts/run-perf-budgets.ps1`.
