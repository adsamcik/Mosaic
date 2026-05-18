# ADR-022: Manifest finalization shape (D7)

## Status

Accepted. Closes [SPEC-LateV1ProtocolFreeze.md](../specs/SPEC-LateV1ProtocolFreeze.md) explicitly-open item #1.

## Context

The Mosaic v1 freeze gate lists the manifest finalization shape as explicitly open:

> Manifest finalization shape. Current backend accepts both legacy `shardIds` and newer `tieredShards`; Rust canonical transcript work is stricter than the live web manifest path. The final late-v1 manifest create/read shape remains open until Android upload proves the exact tier/hash/version fields.

The current state of `POST /api/v1/manifests` (web) accepts both formats simultaneously:

- **Legacy:** flat `shardIds: string[]` — array of all shard IDs (image: thumb/preview/original; video: thumb + chunked originals; legacy single-tier: chunked).
- **New tiered:** `tieredShards: { thumbnail, preview, original[] }` with explicit `shardId` + `tier` per entry.

`SPEC-RustManifestSigning.md` (Rust canonical transcript) requires structured tier information: each shard reference carries `(tier, shard_index, shard_id, sha256, content_length)`. Old manifests that include only `shardIds` cannot round-trip through the Rust canonical transcript without reconstructing tier metadata server-side, which the backend cannot do without inspecting plaintext.

The Rust core completion programme requires this surface to be locked because:

- Lane B (Backend coordination) cannot finish B5 without a frozen JSON contract.
- Lane W (W-A4) cannot cut over web manifest service without final wire shape.
- Lane A (A10 ManifestCommitClient) cannot ship without backend acceptance of the shape and idempotency support.
- Q-final-1 cannot assert manifest transcript byte-equality without a single source of truth.

The 3-reviewer pass (`files/reviews/R1-gpt55-workstreams.md`, `R3-opus47-coherence.md`) flagged that the v1 plan's "W7 ← A11" dependency was the wrong proof point — A11 only fetches sync, not manifest create — and that an explicit backend-lane decision was missing. This ADR provides that decision.

## Decision

The manifest finalization shape is **frozen** as follows for v1.

### Two distinct version fields (decided here)

The freeze-open question said "tier/hash/version fields"; the version-field collision is exactly the disambiguation needed:

| Field | Type | Frozen value (v1) | Semantics |
|---|---|---|---|
| `protocolVersion` | `u32` | `1` | The wire-format/encoding version of the manifest body. Constant for the duration of v1; bumped only when the JSON shape, signature scope, or canonical transcript layout changes. |
| `metadataVersion` | `u64` | starts at `1`, monotonic | Per-manifest optimistic-concurrency counter. Incremented by the server on every accepted metadata edit (description, expiration, sidecar update). Used for `If-Match`/409 conflict resolution. |

`manifestVersion` (the ambiguous v1 name) is **not used** in the wire format. Field rename is forced; backend and clients both ship the rename in lockstep.

### `POST /api/v1/manifests` request shape (frozen)

```json
{
  "protocolVersion": 1,
  "albumId": "<uuid-v7-base64url>",
  "assetType": "Image" | "Video" | "LiveImage",
  "encryptedMeta": "<base64 of encrypted PhotoMeta envelope (SGzk v3, AAD bound to manifest_id)>",
  "encryptedMetaSidecar": "<base64 of encrypted sidecar envelope, optional>",
  "signature": "<base64 of Ed25519 signature over canonical_manifest_transcript_bytes>",
  "signerPubkey": "<base64 of identity public key>",
  "tieredShards": [
    { "tier": 1, "shardIndex": 0, "shardId": "<uuidv7>", "sha256": "<hex>", "contentLength": 12345, "envelopeVersion": 3 },
    { "tier": 2, "shardIndex": 0, "shardId": "<uuidv7>", "sha256": "<hex>", "contentLength": 67890, "envelopeVersion": 3 },
    { "tier": 3, "shardIndex": 0, "shardId": "<uuidv7>", "sha256": "<hex>", "contentLength": 1234567, "envelopeVersion": 3 }
  ]
}
```

Notes:
- `assetType` is the *client-asserted* asset type. Server stores it as opaque metadata and does not validate beyond enum membership. **Per-asset-type tier validation is client-side only** (see ADR-024).
- `envelopeVersion` is a per-shard byte that names the envelope version of `sha256`'s scope: `3` for the v1 single-shot envelope (`SGzk`/v0x03), `4` for the streaming envelope (`SGzs`/v0x04, per ADR-013) once that ships. Manifest readers reject `envelopeVersion` values they cannot decode. v1 backend accepts `3` only; `4` is reserved for v1.x activation per ADR-013.
- `shardId` is **client-generated UUIDv7** sourced from the upload-job snapshot (R-Cl1) prior to Tus upload. The Tus PATCH provides this id; the server uses it as the storage key. Identical client retries (same `Idempotency-Key`, same upload-job) produce identical `shardId`s; cross-client retries cannot collide because UUIDv7 entropy is sufficient.

Required headers:
- `Idempotency-Key: mosaic-finalize-<upload-job-uuidv7>` — sourced from the upload-job snapshot (R-Cl1) and prefixed with the operation namespace to prevent accidental collisions with non-finalize idempotency keys. The canonical string is produced by `mosaic_client::finalize_idempotency_key` and must be consumed by Web/WASM and Android/UniFFI wrappers rather than duplicated in client code. Server stores `(idempotency_key, canonical_request_body, response)` for the **idempotency window** (default 30 days, per ADR-022; never less than `MAX_RETRY_COUNT_LIMIT × max_backoff_with_persistence_recovery_buffer`).
- `If-Match: "<metadataVersion>"` (PATCH only, not POST).

### `POST /api/v1/manifests` response shape (frozen)

```json
{
  "protocolVersion": 1,
  "manifestId": "<uuid-v7>",
  "metadataVersion": 1,
  "createdAt": "<rfc3339>",
  "tieredShards": [ /* echoed back, canonical-CBOR-equivalent ordering */ ]
}
```

### `GET /api/v1/manifests/{manifestId}` response shape (frozen)

```json
{
  "protocolVersion": 1,
  "manifestId": "<uuid-v7>",
  "albumId": "<uuid-v7>",
  "assetType": "Image" | "Video" | "LiveImage",
  "metadataVersion": 1,
  "createdAt": "<rfc3339>",
  "encryptedMeta": "<base64>",
  "encryptedMetaSidecar": "<base64 | null>",
  "signature": "<base64>",
  "signerPubkey": "<base64>",
  "tieredShards": [ /* canonical order */ ]
}
```

### Rules

1. **`tieredShards` is the canonical wire format.** Every new client (web post-W-A4, Android A10) sends `tieredShards`. Backend `protocolVersion` MUST equal `1`; other values rejected.
2. **Legacy `shardIds` is read-only and accepted on `GET` for backward compatibility for ≥ 2 release windows after this programme's G6 closes.** Legacy responses include both: `shardIds` (flat) and a synthesized `tieredShards` reconstructed by the backend from stored tier metadata if available, otherwise omitted (clients fall back to legacy display). Read-side discriminator: presence of `tieredShards` field in response.
3. **No client may write a manifest without `tieredShards`.** Backend rejects `POST /api/v1/manifests` requests that lack `tieredShards` with `400 BAD_REQUEST` and `ClientErrorCode = ManifestShapeRejected`.
4. **`tier` ∈ {1, 2, 3}** with **per-asset-type validation** (per ADR-024):
   - `assetType = Image` → tier 1, tier 2, tier 3 all required (each may have one or more `shardIndex` for chunked originals on tier 3).
   - `assetType = Video` → tier 1 (poster) and tier 3 required; **tier 2 forbidden** (returns `VideoTierShapeRejected` on read).
   - `assetType = LiveImage` → reserved; tier validation TBD by future ADR.
   - Per-asset-type validation is client-side only; the server stores opaque `assetType` and `tieredShards` without inspecting compatibility.
5. **`shardIndex`** is a `u32`. For a tier with N shards, indices are 0..N-1, contiguous, non-repeating. Backend validates contiguity.
6. **`sha256`** is the lowercase hex SHA-256 of the *full envelope bytes* — header + nonce + ciphertext + tag for envelope v3; header + nonce-not-stored-in-header + ciphertext + tag + footer for envelope v4 (when active). The `envelopeVersion` field disambiguates the scope. Same scope as backend `X-Content-SHA256` and Rust `verify_shard_integrity` (R-C2).
7. **`contentLength`** is the encrypted-envelope byte length. Backend cross-checks against the actual stored shard.
8. **`signature`** is over the bytes returned by `canonical_manifest_transcript_bytes(album_id, asset_type, epoch_id, protocol_version, encrypted_meta, encrypted_meta_sidecar, tiered_shards_canonical)` — defined in `SPEC-RustManifestSigning.md` and exposed via P-W4 / P-U3. The `tiered_shards_canonical` form sorts entries by `(tier, shardIndex)` and serializes via canonical CBOR (per ADR-023) before signing.
9. **`encryptedMetaSidecar`** is the encrypted sidecar envelope (`SGzk`/v3 wrapping the canonical sidecar TLV bytes per ADR-017). Optional in v1 (some early manifests lack a sidecar). Omitted when absent. **The TLV body is governed by the sidecar tag registry of ADR-017**; the backend treats the field as opaque bytes.
10. **`metadataVersion`** is incremented by the server on every accepted metadata edit (description, expiration, sidecar update). Optimistic concurrency on PATCH: clients send `If-Match: "<metadataVersion>"`; backend rejects with 409 + current version on mismatch.
11. **Idempotency-Key behavior:** identical `Idempotency-Key` + identical *canonical-CBOR-encoded* request body → identical response. Identical key + different body → `409 IDEMPOTENCY_CONFLICT`. Key TTL **= 30 days** (covers `MAX_RETRY_COUNT_LIMIT = 64` × max 5-min backoff × WorkManager process-death-restore worst case + 7-day buffer). Server-side cache MUST survive backend restart (Redis-style backed by durable storage). On cache eviction within TTL, backend MUST fail closed (`409 IDEMPOTENCY_KEY_EXPIRED`) rather than silently treating retry as fresh.
12. **Persisted snapshot interaction (per ADR-023).** The upload-job snapshot stores `Idempotency-Key` and `shardId`s in CBOR-canonical form per ADR-023's persistence contract. Snapshot loss after manifest POST but before `EffectAck` triggers `RecoverManifestThroughSync` (recovery flow below); snapshot loss without ever attempting POST is benign — the upload restarts with a fresh `Idempotency-Key`.
13. **Streaming envelope readability (per ADR-013).** Manifest readers MUST accept `envelopeVersion = 3` (single-shot, v1 production) and MUST reject `envelopeVersion = 4` until v1.x activates streaming. The `tieredShards[].envelopeVersion` field exists in v1 manifests so v1.x clients can flip to streaming without protocol change.

### Manifest-unknown recovery (executable spec for R-Cl1)

`asset_id` is the encrypted-meta-derived identifier; clients compute it as `BLAKE2b-256(encrypted_meta)[..16]` (the same value embedded in the upload-job snapshot per R-Cl1). The server never sees the plaintext correlation; the recovery scan is purely client-side.

If the network drops during `POST /api/v1/manifests` and the client cannot determine outcome:

1. Reducer transitions to phase `ManifestCommitUnknown` (numeric value `7`, locked by ADR-023's phase-enum lock test).
2. Reducer emits effect `RecoverManifestThroughSync { asset_id, shard_set_hash, since_metadata_version }`.
3. Adapter calls sync via `GET /api/v1/albums/{albumId}/sync?cursor=...&since_version=<since_metadata_version>` and scans returned manifests for matching `asset_id` + `shard_set_hash`. The adapter also has access to `Idempotency-Key` from the snapshot.
4. **Match outcomes** (decision table to keep recovery deadlock-free):
   - **Both `asset_id` and `shard_set_hash` match** → manifest committed successfully; reducer emits `SyncConfirmed { manifest_id, metadata_version }`; transitions to `Confirmed`.
   - **`asset_id` matches but `shard_set_hash` differs** → a stale or parallel client uploaded a different shard set for the same asset; reducer treats this as a *non-recoverable conflict*: emits `NonRetryableFailure { code: ManifestSetConflict }` and stops. User-visible state: "Upload conflict — please retry from a fresh source."
   - **No match within `manifest_recovery_timeout_ms`** (default 60s; configurable per platform) → reducer retries `POST /api/v1/manifests` with **the same Idempotency-Key** *and* the same `signature` (signature is over deterministic transcript bytes; recomputing yields identical bytes). Server idempotency layer handles dedup.
   - **Idempotency-Key TTL expired** → server returns `409 IDEMPOTENCY_KEY_EXPIRED`; reducer treats as `NonRetryableFailure { code: IdempotencyExpired }`. User-visible state: "Upload took too long — please retry from a fresh source."
5. Retry budget bounded by `MAX_RETRY_COUNT_LIMIT = 64` (R-Cl1).

`shard_set_hash` is computed by the reducer over `tieredShards` sorted by `(tier, shardIndex)`, hashed via SHA-256 over the canonical concatenation `tier_le | shardIndex_le | shardId_16 | sha256_32 | envelopeVersion_le` — defined in `SPEC-RustManifestSigning.md`. The `envelopeVersion` byte is included so a v1 manifest and a v1.x streaming-equivalent manifest produce different hashes for the same logical asset.

### ADR-011 (timed expiration) interaction

If sync recovery returns `Album_Deleted` (HTTP 410 Gone) for the album mid-flow:

1. Reducer transitions to `Cancelled { reason: AlbumDeleted }` (phase `11` per ADR-023 lock test).
2. Reducer emits `CleanupStaging` effect to wipe staged plaintext + encrypted shard files locally.
3. Adapters do NOT retry manifest commit.
4. User-visible state: "Upload cancelled — album was deleted."

**Partial-shard-orphan handling.** If shards 1–2 of 5 succeeded but shard 3 returns 410 (album deleted mid-upload):
- Client emits `CleanupStaging` and stops; client-side has no pointer to the orphan shards 1–2.
- Server-side, the orphan shards are reachable via the album's storage prefix but unreferenced by any manifest. Backend MUST GC orphan shards after `orphan_shard_ttl` (default 24h) per `ADR-002` cleanup semantics; this is a backend-enforced invariant referenced here for cross-cutting awareness.
- Client need not retry deletion; backend GC handles it.

## Options Considered

### Keep both `shardIds` and `tieredShards` permanently

- Pros: zero migration; all clients can keep working.
- Cons: Rust canonical transcript needs per-shard tier info that flat `shardIds` doesn't carry; backend cannot reconstruct tier metadata for legacy uploads without server-side inspection (forbidden); two parallel formats forever.
- Conviction: 3/10.

### Drop `shardIds` immediately at G6

- Pros: cleanest wire format.
- Cons: any client running pre-G6 cannot read its own old manifests; user-visible regression on non-upgraded clients during the rollout window.
- Conviction: 4/10.

### Frozen `tieredShards` as canonical write, `shardIds` accepted on read for ≥ 2 release windows (this decision)

- Pros: forward-only at write; backward-compatible at read; Rust canonical transcript is the authoritative byte-shape; idempotency-key handles network failure cleanly.
- Cons: backend retains a synthesized-`tieredShards` path for legacy reads; some manifest read paths are slower until legacy data ages out.
- Conviction: 9/10.

## Consequences

- B5 (backend manifest finalization shape locked) ships referencing this ADR.
- B1 (idempotency-key support) confirms the 30d TTL and the conflict semantics, including durable-storage requirement and `409 IDEMPOTENCY_KEY_EXPIRED` posture.
- B2 (`tieredShards` acceptance for all album types — own + shared + share-link) is a precondition.
- W-A4 (web manifest cutover) sends `tieredShards` only; receives both on read; renders from `tieredShards` when present, falls back to `shardIds` synthesis when not. Writes the `protocolVersion`/`metadataVersion` split.
- A10 (Android manifest commit) sends `tieredShards` only; uses `Idempotency-Key` UUIDv7 from upload-job snapshot persisted per ADR-023.
- R-Cl1 (upload state-machine DTO finalization) implements `ManifestCommitUnknown` + `RecoverManifestThroughSync` + `IdempotencyExpired` + `ManifestSetConflict` exactly per this ADR.
- Q-final-1 asserts `signature` byte-equality across `canonical_manifest_transcript_bytes` outputs from native Rust, WASM (P-W4), and UniFFI (P-U3) for the cross-platform fixture matrix, **and** asserts CBOR-canonical equivalence of `tieredShards` echoed in responses.
- New error codes added under R-C1: `ManifestShapeRejected`, `IdempotencyExpired`, `ManifestSetConflict`, `VideoTierShapeRejected` (last one shared with ADR-024).
- A future ADR drops legacy `shardIds` from the read path after the 2-release-window deprecation completes.
- New SPEC `docs/specs/SPEC-ManifestFinalizationShape.md` documents the wire shape; existing `SPEC-RustManifestSigning.md` documents the transcript byte computation.

## Threat Model

The manifest finalization endpoint is the single binding point between encrypted shards, an album's epoch, and the integrity guarantees that protect a photo's identity. Locking its shape requires an explicit threat model: this section captures what the frozen wire format is defending against and what it deliberately does not.

### Adversary capabilities

- **Server-side compromise (primary).** A hostile or compromised Mosaic backend can read every byte of every manifest POST/GET, store manifests indefinitely, replay or splice manifests across accounts, fabricate manifest IDs, mutate `tieredShards` server-side, and drop or substitute `encryptedMeta` / `encryptedMetaSidecar` between write and read.
- **Cross-client retry attacker.** An attacker observing a client's network can replay a `POST /api/v1/manifests` with the same `Idempotency-Key` after manipulating headers, attempt to cause idempotency-key collisions across albums, or race two clients with the same key + different bodies to confuse server-side dedup.
- **Stale-client / shard-set-mismatch attacker.** A second client (or attacker holding a stolen device snapshot) attempts to commit a different `tieredShards` set for the same logical `asset_id` to coerce a confused-deputy state in the reducer.
- **Network MITM.** On-path attacker mutates the manifest body, signature bytes, idempotency key, or `If-Match` value. TLS pinning (ADR-019 / ADR-012) raises the bar but is not assumed sufficient to exclude mutation for this threat analysis.
- **Old-reader downgrade.** A v1 client receives a manifest crafted with `envelopeVersion = 4` (v1.x streaming) to coerce mis-decoding of tier-3 bytes.
- **Out-of-scope.** Full client-device compromise (rooted phone, memory dump after L2 unwrap); these fall under ADR-002's trust-boundary exclusions.

### Asset under threat

- **Manifest integrity.** The `signature` over `canonical_manifest_transcript_bytes` MUST commit to album-id, asset-type, epoch, protocol version, both encrypted-meta blobs, and the full ordered `tieredShards` list. Any byte mutation by the server invalidates the signature on read.
- **Encrypted-metadata confidentiality.** `encryptedMeta` and `encryptedMetaSidecar` carry photo metadata (filename, timestamps, geolocation, sidecar tags) encrypted under the epoch tier key. The server must never see plaintext; the ADR binds these as opaque `byte[]`.
- **Shard-set binding.** `tieredShards[].shardId`, `sha256`, `contentLength`, and `envelopeVersion` MUST be authenticated bytes so a server cannot swap a shard reference for an attacker-supplied one without breaking the signature.
- **Asset-identity integrity.** `asset_id` (BLAKE2b-derived from `encryptedMeta`) and `shard_set_hash` (over canonical tier-sorted entries) MUST uniquely identify a (logical photo, shard set) pair so manifest-unknown recovery cannot be tricked into accepting a different shard set.
- **Idempotent commit safety.** Replaying a manifest POST MUST be a no-op for honest retries; replaying with a different body MUST be rejected without server-side ambiguity.

### Mitigations

- **Ed25519 signature over canonical transcript bytes.** `canonical_manifest_transcript_bytes(album_id, asset_type, epoch_id, protocol_version, encrypted_meta, encrypted_meta_sidecar, tiered_shards_canonical)` covers every byte that names the photo's identity and shard set. `tiered_shards_canonical` sorts by `(tier, shardIndex)` and serializes via canonical CBOR (per ADR-023) — server cannot reorder, omit, or insert entries without invalidating the signature.
- **`signerPubkey` carried with manifest.** Verifier binds signature against the embedded pubkey; the pubkey is itself cross-checked against the epoch's authorized signer set on read, so server cannot substitute a different signer.
- **Two version fields with disjoint roles.** `protocolVersion` (frozen `1`) binds wire-format semantics into the signed transcript so a future v2 manifest cannot be presented to v1 readers as a v1 manifest. `metadataVersion` is server-controlled, monotonic, and subject to `If-Match` optimistic concurrency — a server cannot silently roll back a metadata edit, and concurrent clients see a 409 instead of a lost update.
- **`tieredShards[].sha256` over the *full envelope bytes*.** Same scope as backend `X-Content-SHA256` (Tus upload header) and `verify_shard_integrity` on download. Server cannot swap a shard's stored bytes without changing its hash; client detects on download and refuses to decrypt.
- **`envelopeVersion` per shard, rejected when unknown.** v1 readers accept `3` only; `4` is reserved (per ADR-013). An attacker cannot present a v1.x streaming shard to a v1 client and coerce mis-parsing — `InvalidEnvelope` reject is the outcome.
- **Idempotency-Key contract** (`mosaic-finalize-<upload-job-uuidv7>`) with 30-day TTL and durable server-side storage. Identical key + identical canonical-CBOR body returns the cached response; identical key + different body returns `409 IDEMPOTENCY_CONFLICT`. Cache eviction within TTL is a fail-closed `409 IDEMPOTENCY_KEY_EXPIRED` — no silent treatment of replay as fresh upload. Upload-job UUIDv7 has sufficient entropy to make cross-client collisions cryptographically negligible.
- **Persistent idempotency cache.** Per §"Rules" #11, the idempotency cache MUST survive backend restart (durable storage). Closes the "kill-backend-mid-retry" denial-of-correctness avenue.
- **Manifest-unknown recovery decision table.** `RecoverManifestThroughSync` distinguishes "asset_id match + shard_set_hash match → success", "asset_id match + shard_set_hash differ → `ManifestSetConflict` non-retryable", and "no match → retry with same Idempotency-Key". The stale-client / shard-set-mismatch attacker cannot land a different shard set without producing a `ManifestSetConflict` on the legitimate client.
- **Server stores `assetType` opaquely**, only validates enum membership. Per-asset-type tier validation (ADR-024) is client-side, so a server cannot use `assetType` as a tier-confusion oracle.
- **Server treats `shardId` as opaque storage key.** Server-generated `shardId` was rejected (per ADR design): client UUIDv7 generation ensures server cannot point a shard reference at attacker-controlled storage.
- **`encryptedMeta` and `encryptedMetaSidecar` are AAD-bound to manifest_id** at the envelope level (`SGzk` v3 with AAD = manifest-id-bound header per ADR-013). Server cannot splice an `encryptedMeta` from manifest A into manifest B without decrypt failure.
- **Sidecar tag registry (ADR-017)** governs TLV bytes inside `encryptedMetaSidecar`; backend never inspects, only stores.
- **Lock test on the wire shape.** Field names, JSON layout, signature scope, and canonical CBOR ordering are all locked by tests under `crates/mosaic-domain/tests/` and the late-v1 freeze lock; CI fails before drift reaches production.

### Residual risks

- **Length / metadata-shape side channel.** The unencrypted JSON envelope reveals: number of tiers, number of shards per tier, per-shard `contentLength`, `envelopeVersion`, and asset-type enum (`Image | Video | LiveImage`). For a video, the server learns the chunk count of the original. This is accepted leakage in v1's threat model — see `docs/SECURITY.md` §"Length leakage" and ADR-002's enumerated leakage budget. Mitigation deferred to v1.x at earliest.
- **Server timing observation.** The server observes manifest POST timing relative to shard uploads; it can correlate "this client uploaded N shards then committed manifest M" even though it cannot read M's content. Out of v1 mitigation scope.
- **Orphan shards on album-deleted mid-upload.** Per §"ADR-011 (timed expiration) interaction", partially-uploaded shards become orphans server-side after an album-delete race. Backend GC after `orphan_shard_ttl` (default 24h) mitigates the storage cost; cryptographically, orphans are opaque ciphertext under a now-revoked epoch and pose no plaintext-disclosure risk.
- **Idempotency-key TTL is policy, not a cryptographic bound.** 30 days is calibrated to `MAX_RETRY_COUNT_LIMIT × max_backoff_with_persistence_recovery_buffer`. A client offline beyond 30 days legitimately fails `IDEMPOTENCY_KEY_EXPIRED` and must retry from a fresh source — accepted UX cost.
- **Server can refuse to commit (denial of service).** Server can return 5xx for every POST, blocking the user's upload. Outside this ADR's cryptographic threat model; standard availability concern.
- **Legacy `shardIds` read-side surface.** Per Rule #2, legacy reads accept a flat `shardIds` for ≥ 2 release windows after G6. The synthesized `tieredShards` for legacy reads relies on backend-stored tier metadata; if that metadata was wrong at upload time, the synthesized view is wrong. Mitigation: legacy `shardIds` reads do not enter the signature scope, so signature still authenticates the original write-time shape; legacy clients render best-effort. Future ADR drops legacy reads entirely.
- **`metadataVersion` is server-asserted.** Optimistic concurrency relies on the server honestly incrementing and reporting `metadataVersion`. A malicious server could lie. Mitigated by `If-Match` discipline + client-side anomaly detection (version going backward triggers a sync re-confirmation), but not cryptographically prevented. Documented as residual.

## Cross-references

- **ADR-013** governs `envelopeVersion` values: `3` (this ADR's only accepted value in v1) and `4` (reserved, locked by ADR-013, v1.x activation).
- **ADR-017** governs the sidecar TLV bytes inside `encryptedMetaSidecar` (opaque to this ADR; structured by the registry).
- **ADR-023** governs the persisted snapshot CBOR encoding from which `Idempotency-Key` and `shardId`s are sourced; phase numerics (`ManifestCommitUnknown = 7`, `Cancelled = 11`) are locked there.
- **ADR-024** narrows §"Rules" #4 with per-asset-type tier validation; readers MUST consult ADR-024 to validate tier completeness against `assetType`.
- **ADR-011** governs `Album_Deleted` semantics and orphan-shard backend GC.
- **ADR-002** governs the zero-knowledge invariant that the server never inspects `encryptedMeta`, `encryptedMetaSidecar`, or `tieredShards.shardId` plaintext content.

## Reversibility

Low at the wire level. Every field name, byte format, header, and rule above is part of the v1 protocol commitment. Changing any of them after G6 is a protocol break requiring a new manifest version *and* a new ADR. The deprecation timeline for legacy `shardIds` (≥ 2 release windows) is the only soft schedule; it can be extended without ADR change.
