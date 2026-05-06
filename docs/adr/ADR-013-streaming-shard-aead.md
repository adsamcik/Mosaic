# ADR-013: Streaming Shard AEAD design (D2)

## Status

Implemented in R-C4. Decision: ship the Rust domain/crypto implementation and lock tests for streaming shard AEAD envelope `v0x04`; production callers remain on `v0x03` until a later activation ticket wires this path through client surfaces.

## Context

The Mosaic v1 shard envelope is `SGzk`/version `0x03`, 64-byte header, 24-byte XChaCha20-Poly1305 nonce, tier byte, 26 reserved zero bytes, AAD = entire 64-byte header. This frames *one* AEAD operation per shard. The streaming envelope keeps the same `SGzk` family magic and uses version byte `0x04`; the version byte distinguishes the two wire layouts. The largest tiers (originals) currently flow through this single-shot path, requiring the full plaintext in memory at encrypt time.

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

The streaming envelope is composed of a **64-byte stream header** followed by a sequence of fixed-order encrypted frames. Backend storage treats the result as one opaque shard blob keyed by `shardId`.

#### Stream header — exactly 64 bytes (matches v3 envelope length for layout reuse)

| Offset | Length | Field | Notes |
|---|---|---|---|
| 0 | 4 | `magic` | `SGzk` (0x53 0x47 0x7A 0x6B). Same family magic as v3; version byte distinguishes layout. |
| 4 | 1 | `version` | `0x04`. |
| 5 | 1 | `tier` | `1` thumbnail, `2` preview, `3` original. |
| 6 | 16 | `stream_salt` | Random bytes from CSPRNG. Per-stream uniqueness root. |
| 22 | 4 | `frame_count` (`u32 LE`) | Number of frames that follow. Range `1..=u32::MAX`; `0` rejected in finalized headers. |
| 26 | 4 | `final_frame_size` (`u32 LE`) | Plaintext byte length of the final frame. Range `1..=65536`; `0` rejected in finalized headers. |
| 30 | 34 | `reserved` | All zero bytes; non-zero rejected on decrypt (matches v3's reserved-bytes policy). |

Header is **not encrypted**. The frame AEAD AAD includes `STREAM_FRAME_AAD || header_context || frame_index_le`. Non-final frames use a provisional `header_context`: the v0x04 header with `frame_count = 0` and `final_frame_size = 0`. The final frame uses the finalized header bytes with the real `frame_count` and `final_frame_size`.

This final-frame AAD binds the stream length without a separate footer tag. If an attacker mutates an on-wire 3-frame header to claim `frame_count = 2`, drops the third frame, and sets `final_frame_size = 65536`, decrypt treats frame 1 as the claimed final frame and authenticates it with the finalized header. Frame 1 was encrypted as a non-final frame with provisional AAD, so XChaCha20-Poly1305 returns `AuthenticationFailed` before any truncated prefix is accepted. One-frame streams encrypt their only frame with finalized-header AAD.

#### Frame envelope (variable length)

| Offset | Length | Field | Notes |
|---|---|---|---|
| 0 | 24 | `nonce` | Deterministic XChaCha20-Poly1305 nonce: `stream_salt[0..16] || frame_index_le_u32 || 0x04 00 00 00`. |
| 24 | `plaintext_len + 16` | `ciphertext` | XChaCha20-Poly1305 output (ciphertext + tag). Non-final plaintext frames are exactly 64 KiB; the final frame length is `final_frame_size`. |

The serialized nonce is also checked against the deterministic reconstruction so copied/reordered frames fail before or during AEAD authentication.

### Per-chunk nonce derivation (frozen by this ADR — RFC 5869 conventional usage)

```text
frame_key_32 = HKDF-SHA256(
  ikm  = epoch_tier_key_32,
  salt = stream_salt_16,
  info = "mosaic:stream-frame-key:v1" || frame_index_4_le,
  L    = 32,
)
frame_nonce_24 = stream_salt_16 || frame_index_4_le || 0x04 00 00 00
```

`epoch_tier_key_32` is materialized only inside the secret registry; **no FFI surface exposes it** (preserves the no-raw-secret-FFI invariant of ADR-006).

Two frames under one `epoch_tier_key` derive the same key/nonce pair only if both `stream_salt` and `frame_index` match. `stream_salt` is CSPRNG-generated per stream; replay under another stream fails because both key derivation and nonce reconstruction bind the salt.

### Per-chunk AAD (frozen by this ADR)

```text
AAD(non-final) = "mosaic:stream-frame:v1" ||
                 (magic_4 || version_1 || tier_1 || stream_salt_16 ||
                  0_u32_le frame_count_placeholder || 0_u32_le final_size_placeholder ||
                  reserved_zero_34) ||
                 frame_index_4_le

AAD(final)     = "mosaic:stream-frame:v1" ||
                 finalized_header_64_with_real_frame_count_and_final_frame_size ||
                 frame_index_4_le
```

`is_final_byte` is true exactly on `chunk_idx == total_chunks - 1`. Decrypt rejects:

- monotonicity violation (received frame is not the next expected frame index),
- duplicate frames within one stream,
- cross-stream replay (`stream_salt` mismatch),
- non-final plaintext frame length not equal to 64 KiB,
- mutated `frame_count`/`final_frame_size` plus dropped tail frames (`AuthenticationFailed` on the claimed final frame),
- missing final frame (`InvalidInputLength` in the current crypto crate error surface),
- extra frame bytes after declared `frame_count` (`InvalidInputLength`).

These rejections produce stable crypto errors without exposing plaintext or key material: `AuthenticationFailed`, `InvalidInputLength`, or `InvalidEnvelope`. Per ADR-022's `envelopeVersion` field, manifest readers in v1 reject `envelopeVersion = 4` until v1.x activation.

### Edge cases (frozen by this ADR)

- **`frame_count = 0`** is rejected at finalized header decode (`InvalidEnvelope`).
- **`frame_count = 1`** is the smallest valid stream: frame 0 is the final frame and must have `final_frame_size` in `1..=65536`.
- **Variable-size frames within a stream** are forbidden except for the final frame. Intermediate plaintext frames MUST equal 64 KiB exactly.
- **Encrypt-side caller commitment** requires `expected_frame_count = Some(n)` for `n >= 1`. `None` is rejected because the encryptor must know which frame is final in order to bind the finalized header into that frame's AAD. Non-final plaintext frames MUST be exactly 64 KiB; final plaintext frames MUST be non-empty and no larger than 64 KiB.
- **Retries** must start a fresh stream salt unless replaying identical already-produced bytes.

### API shape (frozen by this ADR)

```rust
// Encrypt side
streaming_encrypt_init(epoch_handle: &EpochHandle, tier: ShardTier, expected_frame_count: Option<u32>) -> Result<StreamingEncryptor, MosaicCryptoError>
StreamingEncryptor::encrypt_frame(&mut self, plaintext: &[u8]) -> Result<EncryptedFrame, MosaicCryptoError>
StreamingEncryptor::finalize(self) -> Result<StreamingEnvelope, MosaicCryptoError>

// Decrypt side
streaming_decrypt_init(epoch_handle: &EpochHandle, envelope: &[u8]) -> Result<StreamingDecryptor, MosaicCryptoError>
StreamingDecryptor::decrypt_frame(&mut self, frame: &[u8]) -> Result<Vec<u8>, MosaicCryptoError>
StreamingDecryptor::finalize(self) -> Result<(), MosaicCryptoError>
decrypt_envelope(epoch_handle: &EpochHandle, envelope_bytes: &[u8]) -> Result<Vec<u8>, MosaicCryptoError>
```

Stream handles drop wipe internal state via `ZeroizeOnDrop`. Panic-firewall: every method `catch_unwind`s and translates panics to a stable `ClientErrorCode` *without* re-throwing the panic message and without leaving plaintext on the worker scope.

**Caller commitment contract.** A non-final `ChunkEnvelope` returned by `encrypt_chunk` is independently authenticated with provisional-header AAD; the final chunk is authenticated with the finalized header. The caller MAY upload chunks before `finalize()`, but readers accept the stream only when the claimed final frame authenticates against the real `frame_count` and `final_frame_size`. There is no separate footer tag: the final frame's AEAD tag is the footer-equivalent commitment.

### What this programme ships

R-C4 ships:

- the framing and KDF spec frozen above,
- pure-Rust implementation behind `#[cfg(feature = "shard_streaming")]`. The CI guard `no-streaming-export-without-feature` rejects any WASM/UniFFI export of streaming symbols when the feature is off; fuzz/test entry points use a separate `[dev-dependencies]` test feature.
- `SPEC-StreamingShardAEAD.md` documenting the byte layout, rejection rules, and final-frame commitment verification,
- golden vectors for: known plaintexts, multi-chunk streams, single-chunk streams (`total_chunks = 1`), last-byte truncation, mid-stream truncation, header mutation plus tail truncation, duplicate chunk, swapped chunks, replay across streams (cross-`stream_salt`), mutated `total_chunks`, mismatched `chunk_size_class`, old-reader-rejection (a v3-only reader given a v4 envelope must produce `InvalidEnvelope`),
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
- The Rust crypto crate maps v0x04 stream-state failures onto its existing `MosaicCryptoError` surface to preserve downstream exhaustive matches in `mosaic-client`; future FFI activation can map those to the pre-allocated client error codes without changing the wire bytes.
- Panic firewall: every streaming entry point calls `std::panic::catch_unwind` and zeroes any plaintext-bearing temporary on panic.
- Q-final-4 budgets cap originals at the size that single-shot AEAD can handle without OOM on the device matrix; programme documents this cap and ties Android 4 GiB to v1.x.
- A future "activate streaming for production" decision lands as a separate ADR + a feature-flag flip; no protocol bytes change.

## Reversibility

The framing decisions (magic, version, KDF context, AAD layout) are **irreversible** after this ADR ships into `crates/`: any deviation breaks future v1.x clients that round-trip vectors generated against this spec. The decision to **not wire production callers** in this programme is fully reversible — flipping the feature flag in v1.x activates the protocol that ADR-013 already locks. This is the maximum reversibility achievable for an irreversible byte-format commitment: lock the bytes early, defer the activation.
