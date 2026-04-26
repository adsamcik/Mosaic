# MVP Client-Core Protocol Baseline

This baseline defines the minimum shared behavior needed for the Rust client-core rework, Android manual encrypted upload, future Android auto-import architecture, and web/Rust interoperability. It is not a final public compatibility contract; Mosaic is unreleased, so protocol shapes may change before late v1 stabilization when vectors and dependent clients are updated together.

## Scope

In scope for the Android upload MVP:

- account unlock and key derivation policy,
- canonical encoding rules for security-critical transcripts,
- shard envelope format and AAD,
- encrypted signed photo manifest shape,
- upload lifecycle and sync/decrypt verification,
- FFI secret boundary,
- session/capability lifecycle,
- metadata leakage budget,
- timed expiration semantics,
- golden-vector fixture format.

Out of scope for this baseline:

- full share-link expansion,
- full album story/content evolution,
- Rust media adoption,
- backup semantics,
- protocol stability guarantees after public release.

## Product and security model

Mosaic is an end-to-end encrypted image sharing application. It is not a backup system. Users are expected to keep independent backups outside Mosaic.

Encryption is not configurable. Photos, manifests, preserved metadata, source-original archives, and sensitive local state are always encrypted client-side. Settings may control preservation and export scope, but never whether E2EE is applied.

Server authentication and crypto unlock are distinct states:

- A server-authenticated user may list server-visible album/access-control metadata allowed by the leakage budget.
- A crypto-unlocked session is required to decrypt metadata/media or upload encrypted content.
- When crypto handles expire, clients clear decrypted in-memory metadata/thumbnails and return to a locked state.

## KDF policy

`argon2id-mosaic-interactive-v1` is the first account-unlock profile:

| Field | Value |
| --- | --- |
| Algorithm | Argon2id |
| Output | 32 bytes |
| User salt | 16 random bytes minimum |
| Account salt | 16 random bytes minimum |
| Memory | 64 MiB target and minimum for v1 |
| Iterations | 3 target and minimum for v1 |
| Parallelism | 1 target and minimum for v1 |

Rules:

- KDF profile records are authenticated or bound to account identity.
- Clients reject account-stored profiles below the current minimum unless an explicit migration path is invoked.
- Profile upgrades create a new profile version and vectors.
- Benchmarks must run on target browser and Android devices before raising defaults.
- Password/passphrase bytes are bootstrap inputs only and are wiped after derivation.

## Key hierarchy contract

The Rust v1 key hierarchy is:

```text
L0 master key  = Argon2id(password, user_salt, kdf_profile)
L1 root key    = HKDF-SHA256(L0, account_salt, "mosaic.v1.root")
L2 account key = random(32), wrapped by L1
L3 epoch seed  = random(32), wrapped/distributed to members
tier keys      = HKDF-SHA256(ikm=epoch_seed, salt=tier_context, info=tier_label)
sign keypair   = Ed25519 keypair bound to the album epoch
```

L0 and L1 are never stored. L2, epoch seeds, signing keys, and background capabilities are persisted only as encrypted or OS-keystore-wrapped blobs.

Tier key derivation uses:

- `tier_context = MCEv1(TierKeyContextV1 { album_id, epoch_id })`
- `album_id` as the 16 raw UUID bytes in RFC 4122/network byte order
- `epoch_id` as an explicit `u32`
- `tier_label` as the ASCII bytes of one of the tier domain labels below
- output length 32 bytes

Golden vectors must cover thumbnail, preview, and original tier derivation for the same epoch seed and album ID.

## Domain labels

Security-critical transcripts use ASCII labels with the `mosaic.v1.` prefix:

| Purpose | Label |
| --- | --- |
| L1 derivation | `mosaic.v1.root` |
| L2 wrapping | `mosaic.v1.account-key.wrap` |
| Epoch seed wrapping | `mosaic.v1.epoch-seed.wrap` |
| Signing key wrapping | `mosaic.v1.epoch-signing-key.wrap` |
| Thumbnail tier key | `mosaic.v1.tier.thumbnail` |
| Preview tier key | `mosaic.v1.tier.preview` |
| Original tier key | `mosaic.v1.tier.original` |
| Manifest encryption | `mosaic.v1.manifest.encrypt` |
| Manifest signing | `mosaic.v1.manifest.sign` |
| Shard envelope AAD | `mosaic.v1.shard-envelope.aad` |
| Local restore blob | `mosaic.v1.local-restore.wrap` |
| Android background upload capability | `mosaic.v1.android.background-upload-capability` |

New security-sensitive transcript families require new labels and vectors.

## Canonical encoding

Mosaic Canonical Encoding v1 (MCEv1) is the byte representation for signed, MACed, hashed, encrypted-AAD, auth-challenge, manifest, share-link, and key-wrapping transcripts.

MCEv1 rules:

- Security-critical structures are versioned Rust structs encoded with `postcard`.
- Struct field order is schema order. Reordering fields changes bytes and requires a new schema version.
- Maps and unordered sets are forbidden in security-critical transcripts.
- Repeated fields are ordered arrays with a documented sort key where order is semantically meaningful.
- Integer widths are explicit in schema definitions.
- Timestamps are UTC milliseconds since Unix epoch as signed 64-bit integers.
- Text is UTF-8 normalized to NFC before encoding.
- Unknown critical fields are impossible within a fixed struct version and require a new versioned struct.
- Decoders reject trailing bytes, malformed lengths, invalid enum discriminants, invalid UTF-8, non-NFC text, and out-of-range timestamps.
- Non-canonical JSON is forbidden for security-critical transcripts. JSON may still be used for non-security API wrappers that carry opaque base64 fields.

## Shard envelope format

The Android upload MVP retains the current 64-byte shard header so web and Rust transition vectors can compare against the existing implementation:

| Offset | Size | Field | Encoding |
| --- | --- | --- | --- |
| 0 | 4 | Magic | ASCII `SGzk` |
| 4 | 1 | Version | `0x03` |
| 5 | 4 | Epoch ID | little-endian `u32` |
| 9 | 4 | Shard index | little-endian `u32` |
| 13 | 24 | Nonce | fresh random bytes |
| 37 | 1 | Tier | `1=thumbnail`, `2=preview`, `3=original` |
| 38 | 26 | Reserved | all zero |

AAD is the exact 64 bytes transmitted at the start of the envelope. Implementations must not reconstruct AAD from parsed fields, must not normalize header bytes, and must not modify reserved bytes after envelope creation. Payload encryption is XChaCha20-Poly1305 with the tier key.

Decryptors parse the raw header, validate magic/version/tier/reserved bytes, then decrypt using the original raw 64-byte header as AAD. Reserved bytes are included in AAD and must be rejected before attempting decryption if any reserved byte is non-zero.

Decryptors must reject:

- invalid magic,
- unsupported version,
- invalid tier,
- non-zero reserved bytes,
- missing ciphertext/tag,
- wrong key or tampered AAD/ciphertext.

Every encryption generates a fresh 24-byte nonce inside `mosaic-crypto`. Production nonce generation must not use adapter-supplied randomness.

## Encrypted photo manifest shape

The backend manifest-create request carries only server-visible transport/access-control fields:

| Field | Visibility | Notes |
| --- | --- | --- |
| `albumId` | Server-visible opaque ID | Access-control target |
| `encryptedMeta` | Encrypted opaque bytes | MCEv1 photo metadata encrypted client-side |
| `signature` | Server-visible public signature | Ed25519 over manifest signing transcript |
| `signerPubkey` | Server-visible public key | Epoch signing public key |
| `tieredShards` | Server-visible opaque shard links and tier enum | Links uploaded encrypted shards to the manifest |
| `expiresAtUtc` | Optional server-visible UTC deadline | Only present when photo expiration is enabled |

Encrypted photo metadata includes filenames, captions, tags, recognized metadata, dimensions, media type, local asset identity, thumbnails/thumbhashes, and any preserved EXIF/IPTC/XMP values. Normalized gallery tier media is metadata-stripped. Preserved metadata lives in encrypted manifest or sidecar records.

The manifest signing transcript is:

```text
MCEv1(
  version,
  domain_label = "mosaic.v1.manifest.sign",
  album_id,
  epoch_id,
  encrypted_meta_bytes,
  ordered_tiered_shard_refs,
  optional_expires_at_utc
)
```

`ordered_tiered_shard_refs` is sorted by:

1. ascending tier enum (`1=thumbnail`, `2=preview`, `3=original`),
2. ascending `tier_index` within that tier,
3. lexicographic shard ID as a deterministic tie-breaker.

Each signed shard reference contains at least `tier`, `tier_index`, `shard_id`, encrypted-envelope SHA-256, and encrypted byte length.

## Upload lifecycle

The MVP upload lifecycle is:

1. Client obtains a crypto-unlocked interactive session or album upload capability.
2. Media adapter prepares thumbnail, preview, and original tiers while applying metadata policy.
3. Rust core encrypts each tier into shard envelopes and returns encrypted bytes plus SHA-256 hashes.
4. Client uploads encrypted shards through Tus. Backend stores them as `PENDING`.
5. Client creates and signs the encrypted manifest referencing uploaded shard IDs/hashes/tiers.
6. Backend validates access-control metadata and links shards to the manifest as active opaque resources.
7. Client sync sees the manifest, verifies signature and shard hashes, decrypts metadata, downloads/decrypts shards on demand.

If manifest finalization fails after shard upload, clients retry finalization before re-uploading. Durable Android queue staging keeps encrypted staged shards until manifest finalization succeeds or cleanup policy deletes abandoned encrypted staging.

## Timed expiration semantics

Expiration is destructive and opt-in:

- Off by default.
- Requires explicit destructive confirmation.
- Uses server-visible UTC deadlines.
- Album expiration deletes the album and all contained photos.
- Photo expiration deletes the photo.
- Earlier deadline wins when both album and photo expiration exist.
- Backend denies access at or after the effective deadline.
- Backend cleanup deletes opaque manifests/shards/access-control records without inspecting content.
- Clients purge local decrypted metadata, thumbnails, queue references, and cached encrypted blobs after sync observes deletion.

## FFI secret boundary

All exported WASM/UniFFI functions must be classified:

| Classification | May cross FFI | Examples |
| --- | --- | --- |
| Bootstrap secret input | Into Rust only, immediately wiped | password/passphrase bytes |
| Opaque handle | Yes | interactive session handle, upload capability handle |
| Public bytes | Yes | public keys, signatures, hashes, opaque IDs |
| Encrypted bytes | Yes | encrypted manifests, envelopes, wrapped restore blobs |
| Raw secret bytes | No by default | L0/L1/L2, epoch seeds, tier keys, signing keys |

Allowlisting a raw-secret export requires an ADR and tests. No normal MVP operation is allowlisted.

## Session and capability lifecycle

Interactive handles:

- are Rust-owned,
- expire after 15 minutes of inactivity,
- are wiped on logout, app/browser shutdown, process death, or explicit lock,
- can be restored on Android through user-configurable biometric/device-credential unlock only after an initial password/passphrase unlock.

Background auto-import capability:

- is Android-only architecture for a later phase,
- is opt-in,
- is Android Keystore/device-credential wrapped,
- requires device-unlocked-since-boot,
- is upload-only for selected sharing albums,
- persists until disabled, logout, selected album removal, or album key/epoch rotation,
- cannot decrypt/browse the gallery, open share links, expose normal account/session keys, or imply backup coverage.

## Metadata leakage budget

| Data | Server visibility |
| --- | --- |
| Photo bytes | Forbidden plaintext; encrypted only |
| Thumbnail/preview/original tier bytes | Forbidden plaintext; encrypted only |
| EXIF/IPTC/XMP/GPS/camera/device/lens/settings metadata | Forbidden plaintext; encrypted preservation only |
| Filenames and captions | Forbidden plaintext; encrypted only |
| Dimensions and media type | Encrypted metadata; size may leak indirectly through encrypted blob lengths |
| User identity and memberships | Server-visible access-control metadata |
| Album IDs, manifest IDs, shard IDs | Server-visible opaque IDs |
| Shard byte counts, Tus offsets, upload status | Server-visible operational metadata |
| Shard SHA-256 hash of encrypted envelope | Server-visible integrity/linking metadata |
| Manifest signature and signing public key | Server-visible public cryptographic metadata |
| Expiration deadline | Server-visible only when user enables expiration |
| Logs | Must not contain plaintext media, metadata, keys, passwords, auth tokens, or link secrets |

## Golden-vector requirements

Golden vectors are versioned fixtures under `tests/vectors`. Each vector includes:

- fixture schema version,
- operation name,
- protocol version,
- algorithm identifiers,
- domain labels,
- inputs encoded as hex/base64/text/object values,
- expected outputs encoded as hex/base64/object values,
- negative cases with expected stable error codes,
- leakage classification for every server-bound output.
- forbidden server output assertions for plaintext media, metadata, filenames, keys, and logs.

Vector runners must execute the same fixtures in native Rust, WASM worker wrappers, Android wrappers, and temporary TypeScript reference paths until the TypeScript reference is deleted.
