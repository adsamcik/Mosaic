# Mosaic cross-platform parity harness

`mosaic-parity-tests` is the Q-final-1 Rust parity harness. It compares the
Rust-side WASM facade (`mosaic-wasm`) with the Android UniFFI facade
(`mosaic-uniffi`). Android JVM cross-process parity is not covered here; the
harness relies on UniFFI's Rust implementation as the source consumed by the
generated Kotlin bindings.

Run:

```powershell
cargo test -p mosaic-parity-tests --features parity-tests
```

Covered categories:

1. Manifest transcript bytes: WASM facade vs UniFFI facade.
2. Encrypted envelope round-trip: WASM encrypt → UniFFI decrypt and UniFFI
   encrypt → WASM decrypt using shared wrapped epoch seeds.
3. Canonical upload snapshot CBOR: equivalent WASM/UniFFI facade DTOs encoded
   into the same integer-key canonical snapshot bytes.
4. Metadata strip parity: JPEG, PNG, WebP, AVIF, HEIC, and synthetic MP4.
5. Streaming AEAD parity: v0x04 streaming envelope encrypted through UniFFI and
   decrypted by the shared core dispatcher used by the WASM/UniFFI facades.
6. Sidecar canonical bytes parity: explicit TLV metadata sidecar and video
   sidecar bytes.

Fixture sources:

- `apps/web/tests/fixtures/strip-corpus/` for JPEG/PNG/WebP strip corpus.
- `crates/mosaic-media/tests/avif_corpus/` for AVIF strip corpus.
- `crates/mosaic-media/tests/heic_corpus/` for HEIC strip corpus.
- Synthetic MP4 bytes are generated locally in the harness from the
  `crates/mosaic-media/tests/video_container.rs` pattern.
