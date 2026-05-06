# SPEC: Late-v1 Protocol Freeze Declaration

## Status

**Final v1 protocol freeze: DECLARED on 2026-05-06 at `be7c6da07fbe036beea114c785072c878bd4646d` (`origin/main`).**

Freeze approver: **orchestrator**.

**All v1 protocol surfaces are now frozen. Any changes require a v2 break with snapshot version bump and migration plan.**

This reissue closes the prior pre-freeze inventory. The open/in-flight/todo list for v1 protocol surfaces is empty.

## Non-goals

- No backend, Rust, web, Android, or test implementation changes.
- No edits to `docs/IMPLEMENTATION_PLAN.md`; this spec references §11 as the source register.
- No new user-facing feature documentation; this is release-engineering protocol documentation.

## Freeze source of truth

- Freeze commit: `be7c6da07fbe036beea114c785072c878bd4646d`.
- Freeze date: 2026-05-06.
- Irreversibility register: `docs/IMPLEMENTATION_PLAN.md` §11, “Late-v1 Irreversibility Register”.
- Finalization ADR: `docs/adr/ADR-022-manifest-finalization-shape.md`.
- Cross-platform parity evidence: `crates/mosaic-parity-tests/`.

## Open list

| Item | Status | Disposition |
| --- | --- | --- |
| v1 protocol/API open items | Empty | All late-v1 protocol surfaces are frozen at the freeze commit. |
| In-flight v1 protocol shape decisions | Empty | Any further shape change is a v2 break. |
| Todo before v1 freeze declaration | Empty | Q-final-3, Q-final-4, and Q-final-5 provide the final quality-gate declarations. |


## Closed pre-freeze domains

The prior readiness spec tracked these contract domains while Bands 5/6 and Android upload were still in flight. They are now closed for v1 and remain referenced here for lock-test continuity:

- Backend API JSON.
- Opaque blob formats.
- Rust FFI DTOs.
- Android foundation contracts.
- Web WASM adapter boundary.
- Test vectors.
- Bands 5/6 follow-up surfaces.
- Android upload final protocol surfaces.

## Frozen invariants and surfaces

The following surfaces are frozen for v1. Citations point to §11 entries unless otherwise noted.

| Surface | Frozen value / rule | Citation |
| --- | --- | --- |
| L0/L1/L2/L3 key hierarchy | L0 password-derived master, L1 root, L2 account, L3 epoch/tier/signing material remain client-side; raw secrets do not cross normal FFI outputs. | §11 AEAD domain labels, KDF labels, auth/bundle contexts; zero-knowledge invariants in this spec. |
| AEAD domain-separation labels | Freeze set covers `mosaic:l3-epoch-seed:v1`, `mosaic:l3-identity-seed:v1`, `mosaic:account-wrapped-data:v1`, `mosaic:l2-account-key:v1`, `mosaic:l3-link-tier-key:v1`, `mosaic:stream-frame-key:v1`, `mosaic:stream-frame:v1`, plus the shard-envelope/header AAD domain for v0x03/v0x04 encryption. Cross-domain unwrap/replay must fail. | §11 “AEAD domain-separation labels”, “Streaming AEAD frame labels”, “Shard envelope wire format”, and “Streaming shard envelope wire format”. |
| Shard envelope v0x03 | Magic `SGzk`; version `0x03`; 64-byte header; reserved bytes zero; 24-byte nonce; AAD is the exact header bytes. | §11 “Shard envelope wire format”. |
| Streaming shard envelope v0x04 | Magic `SGzk`; version `0x04`; 64-byte header with tier, 16-byte stream salt, frame count, final frame size, 34 reserved-zero bytes; 64 KiB frames; deterministic per-frame nonce from `(stream_salt, frame_index)`; v0x03 dispatcher compatibility. | §11 “Streaming shard envelope wire format”. |
| `ShardTier` discriminants | `thumb=1`, `preview=2`, `full=3`; Rust names `Thumbnail`, `Preview`, `Original`. | §11 “`ShardTier` discriminants”. |
| Manifest transcript context | `Mosaic_Manifest_v1`; byte order, canonical encoding, and transcript inputs are frozen. | §11 “Manifest transcript context”. |
| Metadata sidecar context | `Mosaic_Metadata_v1`; canonical sidecar byte encoding is frozen. | §11 “Metadata sidecar context”. |
| KDF labels | `mosaic:root-key:v1`, `mosaic:auth-signing:v1`, `mosaic:tier:thumb:v1`, `mosaic:tier:preview:v1`, `mosaic:tier:full:v1`, `mosaic:tier:content:v1`, `mosaic:db-session-key:v1`. | §11 “KDF labels”. |
| Auth and bundle contexts | `Mosaic_Auth_Challenge_v1`, `Mosaic_EpochBundle_v1`. | §11 “Auth & bundle contexts”. |
| Sidecar tag table | Frozen active/forbidden tag behavior; forbidden tags map to `MetadataSidecarError::ForbiddenTag`; complete canonical sidecar cap is `MAX_SIDECAR_TOTAL_BYTES = 65_536`. | §11 “Metadata sidecar total byte cap” and “Forbidden sidecar tag error contract”. |
| `tieredShards` JSON shape (B2) | Canonical manifest write shape uses `tieredShards` with explicit shard id, tier, index/hash/version semantics; legacy `shardIds` remains read compatibility only per ADR-022. | ADR-022, especially “Decision” and “Compatibility and migration rules”. |
| Manifest finalization shape (B5/ADR-022) | New clients write `tieredShards`; `protocolVersion` is `1`; idempotent finalization binds canonical request body; read responses preserve compatibility fields. | ADR-022 “Manifest create request”, “Manifest read response”, and “Compatibility and migration rules”. |
| Idempotency-Key format | `Idempotency-Key: mosaic-finalize-{jobId}` with `{jobId}` as the upload-job UUIDv7 string. | ADR-022; parity lock `crates/mosaic-parity-tests/tests/cross_platform_parity.rs::finalize_idempotency_key_parity`. |
| Canonical tier dimensions | Thumbnail `256`, preview `1024`, original/full `4096` canonical tier dimensions for v1 tier generation and manifest expectations. | B2/B5 tiered-shard decision set and ADR-022 tier semantics. |
| Stable error and FFI contract surfaces | Existing stable numeric error codes, public non-secret DTO names/fields, and raw-secret-output prohibition are frozen. | §11 lock citations and architecture guard `tests/architecture/no-raw-secret-ffi-export.ps1`. |

## Zero-knowledge invariants

These invariants remain non-negotiable after freeze:

1. The server never receives plaintext photos, thumbnails, previews, originals, metadata, captions, filenames, EXIF/IPTC/XMP/GPS/device metadata, passwords, account keys, identity seeds, epoch seeds, tier keys, signing seeds, link secrets, or raw Photo Picker/content URIs.
2. Backend storage, Tus upload, manifest commit, sync, cleanup, and share-link delivery operate on opaque encrypted blobs and lifecycle metadata only.
3. Client encryption uses fresh nonces or deterministic streaming nonces only in the frozen v0x04 construction where stream salt and frame index define the domain.
4. FFI boundaries expose handles and stable non-secret DTOs; raw secret output is a release blocker.
5. Logs, errors, OpenAPI examples, snapshots, vectors, and diagnostics must not expose plaintext sentinels or secrets.

## Versioning rule after freeze

Any change to a frozen surface requires all of the following in the same release train:

1. v2 protocol declaration or explicit v1.x additive-compatibility ADR;
2. snapshot version bump when persisted client-core state changes;
3. migration plan covering old clients, old persisted snapshots, old manifests, and partial upload recovery;
4. positive and negative vectors for native Rust, WASM, UniFFI, web, and Android where applicable;
5. rollback/fail-safe behavior proving old clients do not decrypt or accept mismatched bytes silently.

## Release-blocker criteria

A post-freeze change is a release blocker if it changes any frozen bytes, labels, JSON field names, discriminants, context strings, idempotency semantics, canonical tier dimensions, FFI public non-secret DTO shapes, stable error code meanings, or zero-knowledge leakage budget without the versioning rule above.

## Final declaration

The final v1 freeze gate is closed. The previous “explicitly open” pre-freeze list is no longer active for v1. All v1 protocol surfaces are now frozen. Any changes require a v2 break with snapshot version bump and migration plan.

## Verification plan

Release evidence for this declaration includes:

1. `cargo fmt --all -- --check`.
2. `cargo test --workspace --locked --no-fail-fast`.
3. `pwsh tests/architecture/no-raw-secret-ffi-export.ps1`.
4. Q-final-3 E2E coverage evidence from `docs/specs/SPEC-E2ECoverageMatrix.md`.
5. Q-final-4 performance budget evidence from `docs/specs/SPEC-PerformanceBudgets.md` and `scripts/run-perf-budgets.ps1`.


