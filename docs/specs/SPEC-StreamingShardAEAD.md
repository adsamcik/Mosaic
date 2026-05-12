# SPEC: Streaming Shard AEAD

## Status

Canonical byte layout, rejection rules, and final-frame commitment semantics
are defined by `docs/adr/ADR-013-streaming-shard-aead.md` and frozen by
`docs/specs/SPEC-LateV1ProtocolFreeze.md`.

## Verification

- `crates/mosaic-domain/tests/late_v1_protocol_freeze_lock.rs` pins v0x04
  header bytes, frame size, salt length, and frame nonce layout.
- `crates/mosaic-crypto/tests/kdf_and_auth_label_lock.rs` pins the streaming
  AAD and HKDF labels.
