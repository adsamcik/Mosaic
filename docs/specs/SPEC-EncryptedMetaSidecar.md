# SPEC-EncryptedMetaSidecar

> **Status:** Locked at late-v1 protocol freeze.
> **Scope:** Wire format of the `encryptedMetaSidecar` field carried on `Manifest` rows and exposed via `POST /api/v1/manifests` and `GET /api/v1/manifests/{id}`.
> **Audience:** Backend, frontend, Android, and Rust core implementers; auditors verifying zero-knowledge invariants.

## Purpose

`encryptedMetaSidecar` carries encrypted **album-/photo-local metadata** that does not belong in the primary `encryptedMeta` PhotoMeta envelope. Concretely, it stores the canonical sidecar TLV record set governed by **ADR-017** — capture-time fields, content-classification flags, and other tag values that may be edited independently of the photo body. The backend stores it as **opaque bytes**; it never sees plaintext.

The sidecar is the only field on the manifest that:

1. Has a tag registry of its own (`SidecarTagRegistry` in `crates/mosaic-domain/src/lib.rs`).
2. May legitimately be **absent** on early-v1 manifests (the column is nullable; pre-A2 clients may have committed manifests without a sidecar).
3. Is **AAD-bound to the manifest id at envelope construction time** so the server cannot splice a sidecar from manifest A onto manifest B without decrypt failure.

## Wire format

### Top-level field

The sidecar is a single base64-encoded byte string on the JSON wire. It is the entire output of the AEAD seal operation (header + ciphertext + tag) — there is no wrapping JSON object, no separate nonce field, no separate AAD field on the wire.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `encryptedMetaSidecar` | `string` (base64) \| `null` | No | `null` (or omitted) when the manifest has no sidecar (legacy or empty-TLV case). |

Persisted as `Manifest.EncryptedMetaSidecar` (`byte[]?`) in `apps/backend/Mosaic.Backend/Data/Entities/Manifest.cs:16`. Max persisted length is **65,616 bytes** (`[MaxLength(ManifestSizeLimits.EncryptedMetaSidecarMaxBytes)]` on `ManifestRequests.cs`), computed as the 65,536-byte plaintext cap plus the 64-byte SGzk v3 header plus the 16-byte Poly1305 tag. Requests exceeding this bound are rejected by the model binder with HTTP 400 (security-review-2026-05-18-04).

### Inner envelope (SGzk v3)

The byte string is a single-shot **SGzk envelope v3** (ADR-013 §"v3 single-shot format"). Its layout is fixed and identical to the shard envelope used by `encryptedMeta`:

```
Offset  Size  Field           Notes
------  ----  --------------  -----------------------------------------------------------
 0       4    magic           ASCII "SGzk" (0x53 0x47 0x7A 0x6B)
 4       1    version         0x03 (single-shot)
 5       4    epoch           u32 LE; the epoch under which the sidecar was sealed
 9       4    shard           u32 LE; reserved for sidecar envelopes — set to 0
13      24    nonce           24 random bytes from CSPRNG (sodium.randombytes_buf(24))
37       1    tier            ShardTier byte: 1=thumb, 2=preview, 3=original — for the
                              sidecar, this byte names the *content tier the sidecar
                              describes* and is treated as opaque metadata by the
                              backend; readers MUST validate it matches the manifest's
                              asset semantics (ADR-024).
38      26    reserved        All zero. Validated on decrypt; non-zero rejects.
------  ----  --------------
64       N    ciphertext      XChaCha20-Poly1305 ciphertext of the canonical sidecar
                              TLV bytes (see "Plaintext shape" below).
N+64    16    tag             Poly1305 authentication tag.
```

**AAD** = the entire 64-byte header concatenated with the **manifest id** bytes (binding sidecar to the parent manifest, ADR-022 §"Mitigations"). A sidecar from a different manifest will fail authentication.

### Plaintext shape (inside the AEAD)

The inner plaintext is the canonical sidecar TLV byte sequence produced by `canonical_metadata_sidecar_bytes` in `crates/mosaic-domain/src/lib.rs`. The format:

```
Offset  Size      Field
------  --------  -------------------------------------------------------------
 0       4        context = METADATA_SIDECAR_CONTEXT = b"Mosaic_Metadata_v1"
 …      18        (the context is 18 bytes — see crates/mosaic-domain/src/lib.rs:103)
18       1        format version = METADATA_SIDECAR_VERSION = 1
19       N        TLV records, each:
                    - tag:    u16 BE (governed by ADR-017 + SPEC-CanonicalSidecarTags)
                    - length: u32 BE
                    - value:  `length` bytes (tag-specific encoding)
```

Total encoded byte length **MUST NOT exceed** `MAX_SIDECAR_TOTAL_BYTES = 65,536` (`crates/mosaic-domain/src/lib.rs:138`). Decoders reject larger inputs even if the AEAD verifies.

The full TLV tag table and reserved ranges are governed by **ADR-017** and live at `docs/specs/SPEC-CanonicalSidecarTags.md`. This SPEC does not duplicate the registry.

## Encryption — which key, which function

### Wrap key

The sidecar is sealed under the **epoch tier key** for the metadata tier — the same key family that seals `encryptedMeta`. The tier key is derived from the L3 epoch read key per `SPEC-RustEpochTierKeys.md` using the metadata-tier HKDF context. The key is **client-side only** (zero-knowledge invariant: ADR-002). Backend never has access to plaintext key material.

> **Key hierarchy reminder:** `L3_epoch_read_key → HKDF(ctx="MosaicTier_v1/meta") → metadata_tier_key`. The metadata tier key is wiped from process memory after use via `sodium.memzero()` (frontend) or `Zeroizing` (Rust core).

### Wrap / unwrap functions

| Layer | Wrap (encrypt + seal) | Unwrap (verify + decrypt) | Source |
|-------|----------------------|---------------------------|--------|
| Rust core (canonical reference) | `mosaic_crypto::sidecar::seal_metadata_sidecar` | `mosaic_crypto::sidecar::open_metadata_sidecar` | `crates/mosaic-crypto/` |
| TypeScript (browser fallback for legacy paths) | `cryptoWorker.encryptShard` with the metadata tier key + AAD = manifest header | `cryptoWorker.decryptShard` mirrored | `apps/web/src/workers/crypto.worker.ts` |
| UniFFI (Android binding) | `MosaicCrypto.sealMetadataSidecar` | `MosaicCrypto.openMetadataSidecar` | `crates/mosaic-uniffi/` |
| WASM (browser primary) | `mosaic_wasm.seal_metadata_sidecar` | `mosaic_wasm.open_metadata_sidecar` | `crates/mosaic-wasm/` |

> The Rust core implementation is the **canonical source of truth**. TS / WASM / UniFFI bindings call into the same primitive so cross-platform manifests round-trip byte-for-byte. The boundary is locked by `crates/mosaic-domain/tests/manifest_transcript.rs` and the cross-platform crypto vector suite (`SPEC-CrossPlatformCryptoVectors.md`).

### Zero-knowledge invariants

1. **Server NEVER sees plaintext sidecar bytes.** Backend reads/writes `byte[]` only (`Manifest.EncryptedMetaSidecar`).
2. **24 fresh random bytes per nonce.** No counter; CSPRNG only. Reuse with the same key would invalidate the IND-CCA security of XChaCha20-Poly1305.
3. **AAD binds the sidecar to the manifest id.** A server that splices a sidecar between manifests produces a verifier-detectable authentication failure on read.
4. **Reserved bytes MUST be zero on decode** (`crates/mosaic-domain/src/lib.rs` reserved-byte check). A future v4 sidecar envelope MUST set a different `version` byte rather than repurposing reserved bytes.

## Versioning and migration

| Version | Status | Notes |
|---------|--------|-------|
| `METADATA_SIDECAR_VERSION = 1` | **Active** (frozen at late-v1 protocol freeze, 2026-04-30) | All v1 manifests use version 1. Any future schema change requires a new `METADATA_SIDECAR_VERSION` value and an ADR amendment to ADR-017. |
| envelope `version = 0x03` | **Active** | Locked by ADR-013. |
| envelope `version = 0x04` (streaming AEAD) | **Reserved** | Not valid for sidecars in v1 — sidecars are bounded by `MAX_SIDECAR_TOTAL_BYTES = 64 KiB` so streaming is unnecessary. Readers MUST reject `version = 0x04` on sidecar envelopes in v1. |

### Migration story

- **Legacy manifests without a sidecar** (`EncryptedMetaSidecar IS NULL` on the row): readers MUST treat as "no sidecar present" and **MUST NOT** synthesise a default TLV record set; the signature transcript explicitly encodes the absent case (`canonical_manifest_transcript_bytes` writes a length-zero placeholder for the missing sidecar — see ADR-022 §"Rules" #8).
- **Metadata edits**: A client editing sidecar contents produces a new envelope (fresh nonce, same tier key) and submits a `PATCH` with the new `encryptedMetaSidecar` and an incremented `metadataVersion` (server-controlled — see ADR-022 §"Rules" #10). Concurrent edits are resolved via `If-Match` optimistic concurrency (409 on stale).
- **Epoch rotation**: When the album rotates to a new epoch, sidecars sealed under the old metadata tier key remain readable by anyone holding the old `L3_epoch_read_key`. The recipient list distribution mechanism (ADR-014) ensures all current members retain access. Re-encryption under the new epoch is deferred (a v1.x sweep activity; not required for v1.0.0).
- **TLV tag governance**: New tag numbers are append-only and governed by **ADR-017**. Deprecation requires a separate ADR; existing tag bytes never change semantics.

## Example JSON shape

```json
{
  "manifestId": "01HZQR8X5K3V4MNCYE8P3X9D7B",
  "albumId": "01HZQR8X5K3V4MNCYE8P3X9D7A",
  "protocolVersion": 1,
  "assetType": "Image",
  "versionCreated": 1730419200,
  "metadataVersion": 1,
  "isDeleted": false,
  "encryptedMeta": "U0d6awMAAAAAAQAAAAAAAAA...PLACEHOLDER_CIPHERTEXT_BYTES==",
  "encryptedMetaSidecar": "U0d6awMAAAAAAQAAAAEAAAA...PLACEHOLDER_SIDECAR_CIPHERTEXT_BYTES==",
  "signature": "PLACEHOLDER_ED25519_SIGNATURE_64B==",
  "signerPubkey": "PLACEHOLDER_ED25519_PUBKEY_32B==",
  "createdAt": "2026-05-18T14:30:00.000Z",
  "updatedAt": "2026-05-18T14:30:00.000Z"
}
```

The `encryptedMetaSidecar` value is the full 64-byte SGzk-v3 header + ciphertext + 16-byte Poly1305 tag, base64-encoded. The example uses placeholder bytes — real ciphertext is opaque random-looking bytes.

When the sidecar is absent (legacy manifest), the field is **`null`** on `GET` responses and **omitted or `null`** on `POST` requests. Clients MUST NOT send the empty string `""` — that would be parsed as a zero-byte envelope and rejected by the AEAD verifier.

## Cross-references

| Authority | Subject | Document |
|-----------|---------|----------|
| **ADR-002** | Zero-knowledge invariant (server stores opaque bytes only) | `docs/adr/ADR-002-zero-knowledge-architecture.md` |
| **ADR-013** | SGzk envelope format (v3 single-shot, v4 streaming) | `docs/adr/ADR-013-streaming-shard-aead.md` |
| **ADR-017** | Canonical sidecar TLV tag registry, reserved ranges, decode validation | `docs/adr/ADR-017-canonical-sidecar-tags.md` |
| **ADR-022** | Manifest finalization wire shape — sidecar field placement, signing transcript binding, AAD-to-manifest-id binding, threat model | `docs/adr/ADR-022-manifest-finalization-shape.md` |
| **ADR-024** | Per-asset-type tier validation that determines whether a sidecar with a given `tier` byte is acceptable for the parent asset | `docs/adr/ADR-024-video-preview-tier-policy.md` |
| **SPEC-CanonicalSidecarTags** | Full TLV tag registry, encoding rules, allocation workflow | `docs/specs/SPEC-CanonicalSidecarTags.md` |
| **SPEC-RustEpochTierKeys** | Metadata tier key derivation from `L3_epoch_read_key` | `docs/specs/SPEC-RustEpochTierKeys.md` |
| **SPEC-RustManifestSigning** | `canonical_manifest_transcript_bytes` — how the sidecar bytes participate in the Ed25519 signing transcript | `docs/specs/SPEC-RustManifestSigning.md` |
| **SPEC-CrossPlatformCryptoVectors** | Round-trip vectors that prove web, Android, and Rust core agree byte-for-byte on sidecar seal/open | `docs/specs/SPEC-CrossPlatformCryptoVectors.md` |

## Lock tests

Drift in any of the values below fails CI before reaching production:

- `crates/mosaic-domain/tests/manifest_transcript.rs` — pins canonical transcript byte sequence including the sidecar slot.
- `crates/mosaic-domain/tests/sidecar_tag_table.rs` — pins the tag registry.
- `apps/backend/Mosaic.Backend.Tests/Controllers/ManifestProtocolContractTests.cs` — pins JSON wire shape (`encryptedMetaSidecar` field present, nullable, base64).
- `docs/openapi.json` — exported OpenAPI schema (drift-gated by `tests.yml` "OpenAPI drift gate" step).
