# ADR-013: Streaming Shard AEAD design (D2)

## Status

Accepted. Decision: **defer streaming shard AEAD shipping to v1.x**; in this programme, ship only the framing design + golden vectors so that v1 envelopes remain forward-compatible.

## Context

The Mosaic v1 shard envelope is `SGzk`/version `0x03`, 64-byte header, 24-byte XChaCha20-Poly1305 nonce, tier byte, 26 reserved zero bytes, AAD = entire 64-byte header. This frames *one* AEAD operation per shard. The largest tiers (originals) currently flow through this single-shot path, requiring the full plaintext in memory at encrypt time.

The Rust core completion programme targets Android originals up to **4 GiB** and web originals up to **1 GiB** (`plan.md` v2 §G5 fixture matrix). Single-shot AEAD on those sizes:

- requires the full plaintext to be allocated and held in memory while encryption runs,
- forces the JNI/Comlink boundary to copy the full plaintext into Rust-owned memory,
- has no incremental progress signal,
- has no recovery path between chunks,
- doubles or triples peak memory through unavoidable platform copies.

The plan's draft v1 design (R4 in v1) proposed `HKDF(epoch_seed, "Mosaic_ShardChunk_v1", chunk_idx)` for per-chunk nonces. The 3-reviewer pass (`files/reviews/R2-gpt55-technical.md`, `R3-opus47-coherence.md`) flagged this as a **catastrophic nonce-reuse risk**: chunk 0 of shard A and chunk 0 of shard B share an epoch+tier key and would derive the same nonce. v1 freeze invariants forbid nonce reuse with the same key (`SPEC-LateV1ProtocolFreeze.md` §"Frozen now"). Once any streaming envelope is uploaded, the KDF context is fossilized; shipping a flawed design is irreversible.

The plan also requires a **panic firewall** posture: a Rust panic inside the streaming codepath must not propagate decrypted bytes into a JS error string or logcat line and must zeroize plaintext on the worker scope. The streaming API must be designed for that.

## Decision

The Rust core completion programme **freezes the design** of the streaming shard AEAD and ships **only the framing, golden vectors, and rejection tests**. Production callers continue to use the single-shot envelope (`v0x03`) for the duration of this programme; the streaming envelope (`v0x04`) is only exercised by tests and by an explicit future-flag that no production caller sets.

### Streaming envelope framing (frozen by this ADR)

The streaming envelope is composed of a **stream header** (written once per stream) plus a sequence of **chunk envelopes** (one per encrypted chunk) plus a **stream footer** (written once at the end). Each is an independent byte string; backend storage stitches them together as one shard blob keyed by `shardId`.

#### Stream header — exactly 64 bytes (matches v3 envelope length for layout reuse)

| Offset | Length | Field | Notes |
|---|---|---|---|
| 0 | 4 | `magic` | `SGzs` (0x53 0x47 0x7A 0x73). Distinct from v3's `SGzk`. |
| 4 | 1 | `version` | `0x04`. |
| 5 | 16 | `stream_salt` | Random bytes from CSPRNG. Authenticated. Per-stream uniqueness root. |
| 21 | 16 | `asset_id` | UUIDv7 of the upload job. Authenticated. |
| 37 | 16 | `shard_id` | Client-generated UUIDv7 of *this* shard within the upload job. Authenticated. Sourced from upload-job snapshot per ADR-022 + ADR-023; identical client retries produce identical `shard_id` (idempotency). |
| 53 | 4 | `total_chunks` (`u32 LE`) | Number of chunk envelopes that follow. Range `1..=u32::MAX`. `0` rejected. Authenticated. |
| 57 | 1 | `tier` | `1` thumbnail, `2` preview, `3` original. ADR-024 governs per-asset-type validity. |
| 58 | 1 | `chunk_size_class` | `0` = uniform-256KiB chunks (last chunk may be smaller); `1` = uniform-1MiB chunks; `2` = uniform-4MiB chunks; `3` = uniform-16MiB chunks. Other values reserved; rejected. Encoder MUST emit one chunk_size_class per stream; decoder MUST reject any chunk whose ciphertext length implies a different class. Bounds adversarial tiny-chunk amplification. |
| 59 | 5 | `reserved` | All zero bytes; non-zero rejected on decrypt (matches v3's reserved-bytes policy). |

Header is **not encrypted**; it is fully covered by every chunk's AAD.

#### Chunk envelope (variable length)

| Offset | Length | Field | Notes |
|---|---|---|---|
| 0 | 4 | `chunk_idx` (`u32 LE`) | Strictly monotonically increasing within a stream; first chunk = `0`. |
| 4 | 1 | `is_final` | `0x01` exactly when `chunk_idx == total_chunks - 1`; `0x00` otherwise. Mismatch rejected. |
| 5 | 4 | `ciphertext_len` (`u32 LE`) | Length of the AEAD output (ciphertext + 16-byte tag); upper-bounded by `chunk_size_class` × buffer + 16. |
| 9 | `ciphertext_len` | `ciphertext` | XChaCha20-Poly1305 output (ciphertext + tag). |

Chunk-level nonces are **derived, not stored** (per below); decryptor reconstructs them from header fields + `chunk_idx`.

#### Stream footer — exactly 32 bytes

| Offset | Length | Field | Notes |
|---|---|---|---|
| 0 | 4 | `footer_magic` | `SGzf` (0x53 0x47 0x7A 0x66). Distinguishes footer from chunk envelope. |
| 4 | 4 | `final_chunk_idx` (`u32 LE`) | Must equal `total_chunks - 1`; mismatch rejected. |
| 8 | 8 | `total_plaintext_bytes` (`u64 LE`) | Sum of plaintext byte counts across all chunks. Independently authenticated by `footer_tag`; allows upload-time integrity check. |
| 16 | 16 | `footer_tag` | Poly1305 tag of `(magic_4 || version_1 || stream_salt_16 || asset_id_16 || shard_id_16 || total_chunks_4_le || final_chunk_idx_4_le || total_plaintext_bytes_8_le)` keyed by HKDF-SHA256(`epoch_tier_key`, `salt = "Mosaic_StreamFooter_v1" || stream_salt || asset_id`, `info = empty`, L = 32). Verified at decrypt before any chunk is treated as committed. |

The footer ensures that a partial-write or premature-close adversary cannot fool a reader into accepting a truncated stream as complete.

### Per-chunk nonce derivation (frozen by this ADR — RFC 5869 conventional usage)

```text
chunk_nonce_24 = HKDF-SHA256(
  ikm  = epoch_tier_key_32,                                   // secret material
  salt = "Mosaic_ShardChunk_v1",                              // fixed protocol label (public, deterministic)
  info = stream_salt_16 || asset_id_16 || shard_id_16
       || tier_byte_1   || total_chunks_4_le || chunk_idx_4_le, // per-instance + per-chunk public context
  L    = 24,
)
```

`epoch_tier_key_32` is materialized only inside the secret registry; **no FFI surface exposes it** (preserves the no-raw-secret-FFI invariant of ADR-006).

The `info` argument carries the per-stream public context (`stream_salt`, `asset_id`, `shard_id`, `tier`, `total_chunks`) plus the per-chunk index. Two chunks across any two streams under any one `epoch_tier_key` derive the same nonce only if every byte of `info` matches — i.e. only on legitimate replay of the *same* chunk of the *same* stream, never on cross-stream reuse. Property test enforces uniqueness over ≥ 2²⁰ random `(stream_salt, asset_id, shard_id, total_chunks, tier, chunk_idx)` tuples.

### Per-chunk AAD (frozen by this ADR)

```text
AAD = magic_4 || version_1 || stream_salt_16 || asset_id_16 || shard_id_16 ||
      tier_byte_1 || chunk_size_class_1 || total_chunks_4_le || chunk_idx_4_le ||
      is_final_byte_1 || ciphertext_len_4_le
```

`is_final_byte` is true exactly on `chunk_idx == total_chunks - 1`. Decrypt rejects:

- `is_final_byte = true` with `chunk_idx != total_chunks - 1`,
- `is_final_byte = false` with `chunk_idx == total_chunks - 1`,
- monotonicity violation (received chunk indices not strictly increasing within a stream),
- duplicate chunks within one stream,
- `total_chunks` mismatch between any two chunks of the same stream,
- `stream_salt` / `asset_id` / `shard_id` / `tier` / `chunk_size_class` mismatch,
- `ciphertext_len` exceeding `chunk_size_class`'s nominal bound (+ 16 for tag).

These rejections produce stable error codes: `StreamingChunkOutOfOrder`, `StreamingTotalChunkMismatch`, `InvalidEnvelope`. Per ADR-022's `envelopeVersion` field, manifest readers in v1 reject `envelopeVersion = 4` until v1.x activation.

### Edge cases (frozen by this ADR)

- **`total_chunks = 0`** is rejected at `EncryptionStream::init` and at decode (`InvalidEnvelope`).
- **`total_chunks = 1`** is the smallest valid stream: chunk 0 has `chunk_idx = 0`, `is_final = 0x01`. Footer's `final_chunk_idx = 0`.
- **Variable-size chunks within a stream** are forbidden by `chunk_size_class`. The final chunk MAY be smaller than the class (its `ciphertext_len` is allowed to be less than the class bound + 16); intermediate chunks MUST equal the class size + 16 exactly.
- **Retries that re-encrypt the same chunk_idx with same plaintext** produce identical ciphertext (deterministic from staged file) — fine. **Retries that re-encrypt the same chunk_idx with different plaintext** reuse the chunk_nonce: this is the standard "do not re-use a key/nonce with two different messages" rule. The encrypt API panics (`StreamingPlaintextDivergence`) if the same `chunk_idx` is offered twice with bytes that hash differently; encoders MUST handle the panic by aborting the stream and starting fresh with a new `stream_salt`.

### API shape (frozen by this ADR)

```rust
// Encrypt side
EncryptionStream::init(handle: EpochHandle, tier: ShardTier, total_chunks: u32, chunk_size_class: ChunkSizeClass) -> StreamHandle
StreamHandle::header() -> [u8; 64]                              // serialized stream header
StreamHandle::encrypt_chunk(chunk_idx: u32, plaintext: &[u8]) -> Result<Vec<u8>, MosaicCryptoError>  // returns chunk envelope bytes
StreamHandle::finalize() -> Result<[u8; 32], MosaicCryptoError> // returns stream footer bytes; consumes the handle

// Decrypt side
DecryptionStream::open(handle: EpochHandle, header: &[u8; 64]) -> Result<StreamHandle, MosaicCryptoError>
StreamHandle::decrypt_chunk(envelope: &[u8]) -> Result<Vec<u8>, MosaicCryptoError>  // chunk_idx parsed from envelope; reducer maintains expectation
StreamHandle::finalize(footer: &[u8; 32]) -> Result<(), MosaicCryptoError>          // verifies footer_tag + total_plaintext_bytes
```

Stream handles drop wipe internal state via `ZeroizeOnDrop`. Panic-firewall: every method `catch_unwind`s and translates panics to a stable `ClientErrorCode` *without* re-throwing the panic message and without leaving plaintext on the worker scope.

**Caller commitment contract.** A `ChunkEnvelope` returned by `encrypt_chunk` is independently authenticated (ciphertext + tag); the caller MAY upload it before `finalize()`. Until `finalize()` succeeds, the *stream* is not committed; readers will reject any prefix that lacks a valid footer. This permits parallel chunk upload while preserving stream integrity.

### What this programme ships

R-C4 ships:

- the framing and KDF spec frozen above,
- pure-Rust implementation behind `#[cfg(feature = "shard_streaming")]`. The CI guard `no-streaming-export-without-feature` rejects any WASM/UniFFI export of streaming symbols when the feature is off; fuzz/test entry points use a separate `[dev-dependencies]` test feature.
- `SPEC-StreamingShardAEAD.md` documenting the byte layout, rejection rules, and footer verification,
- golden vectors for: known plaintexts, multi-chunk streams, single-chunk streams (`total_chunks = 1`), last-byte truncation, mid-stream truncation, missing footer, mutated footer, duplicate chunk, swapped chunks, replay across streams (cross-`stream_salt`), mutated `total_chunks`, mutated `is_final_byte`, mismatched `chunk_size_class`, old-reader-rejection (a v3-only reader given a v4 envelope must produce `InvalidEnvelope`),
- `cargo fuzz` corpora,
- nonce-uniqueness property test (≥ 2²⁰ random tuples per the derivation above),
- `StreamingPlaintextDivergence` test (re-encrypting same `chunk_idx` with different plaintext panics with the right error code).

R-C4 **does not** ship:

- production caller routing originals through the streaming path,
- WASM/UniFFI exports beyond test-only entry points (P-W5 / P-U5 are *conditional* tickets gated by a future "ship streaming" decision in v1.x); the `envelopeVersion = 4` byte in `tieredShards` (per ADR-022) is reserved but never written by v1 production callers,
- Android 4 GiB upload integration (defers to v1.x; v1 caps original tier at the largest size that the single-shot path can handle on the Q-final-4 device matrix). This cap is documented in ADR-014's `Q-final-4` budget.

A future ADR-NNN will activate streaming for production callers in v1.x, after this programme's foundations land and the fuzz/golden-vector corpora are mature.

## Options Considered

### Ship a flawed nonce derivation (`HKDF(epoch_seed, ctx, chunk_idx)`)

- Pros: simplest possible API.
- Cons: nonce reuse across shards. Catastrophic. Irreversible once shipped.
- Conviction: 0/10.

### Ship streaming for production now with the corrected design

- Pros: Android 4 GiB originals work end-to-end in v1.
- Cons: ships a new envelope version + new memory model + new state machine in the same programme that lands Slice 5 + Lane A foundations; quadruples test surface; couples Q-final-4 to streaming correctness; risks v1 launch on a young protocol.
- Conviction: 5/10.

### Defer streaming entirely (no design, no vectors)

- Pros: zero new protocol surface in v1.
- Cons: v1.x cannot land streaming without a fresh design pass; Android 4 GiB originals remain unsupported; risk of pressure-driven shortcut decisions later.
- Conviction: 3/10.

### Ship design + vectors, defer production wiring (this decision)

- Pros: locks the irreversible bytes (magic, version, KDF, AAD layout) in v1 with full test coverage; allows v1.x to flip on production wiring without redesigning protocol; production callers continue on `v0x03` for known-safe single-shot path; Android 4 GiB defers to v1.x.
- Cons: Android 4 GiB originals not supported in v1; programme ships dead-but-tested code.
- Conviction: 9/10.

## Consequences

- **`v0x04` envelope magic and KDF context are frozen** by this ADR. Any change requires a new envelope version *and* a new ADR.
- New SPEC `docs/specs/SPEC-StreamingShardAEAD.md` documents the framing.
- `crates/mosaic-domain/tests/sidecar_tag_table.rs` (per ADR-017) and a parallel `streaming_envelope_lock.rs` lock-test pin the byte layout.
- `mosaic-crypto/Cargo.toml` adds `shard_streaming` feature; default off.
- ClientErrorCode allocations: `StreamingChunkOutOfOrder` (already in R-C1), `StreamingTotalChunkMismatch` (added by R-C1).
- Panic firewall: every streaming entry point calls `std::panic::catch_unwind` and zeroes any plaintext-bearing temporary on panic.
- Q-final-4 budgets cap originals at the size that single-shot AEAD can handle without OOM on the device matrix; programme documents this cap and ties Android 4 GiB to v1.x.
- A future "activate streaming for production" decision lands as a separate ADR + a feature-flag flip; no protocol bytes change.

## Reversibility

The framing decisions (magic, version, KDF context, AAD layout) are **irreversible** after this ADR ships into `crates/`: any deviation breaks future v1.x clients that round-trip vectors generated against this spec. The decision to **not wire production callers** in this programme is fully reversible — flipping the feature flag in v1.x activates the protocol that ADR-013 already locks. This is the maximum reversibility achievable for an irreversible byte-format commitment: lock the bytes early, defer the activation.
