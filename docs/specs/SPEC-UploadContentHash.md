# SPEC: Upload Content-Hash Dedup

## Status

**Locked before MediaTierGenerator upload wiring.** This SPEC documents the
upload-time content-hash invariant introduced in `b5b30f9` and guarded by the
Rust/WASM/UniFFI parity surfaces added through `d3ea340`.

Android now enforces the lock at the worker boundary: shard encryption receives
the album-level source-byte hash as WorkData instead of recomputing it from
staging bytes. The lock exists so the future MediaTierGenerator /
BitmapTierEncoder wiring preserves the album-level source-byte hash and fails
loudly if callers omit or malform it.

## Purpose

Define the contract for client-local content-hash deduplication:

1. what bytes are hashed;
2. where web and Android currently invoke the hash;
3. what cross-platform parity proves;
4. what future Android tier generation must not silently change;
5. what this hash is and is not trusted to do.

The content hash answers one UX question only:

```text
Has this client already uploaded this same source photo into this same album?
```

It is not a manifest hash, ciphertext integrity check, authentication tag,
server-visible identity, or cross-user deduplication primitive.

## Invariant

The hash that goes into the dedup table is:

```text
contentHashHex = lowercase_hex(SHA-256(source_of_truth_user_file_bytes))
```

Where `source_of_truth_user_file_bytes` means the exact bytes the user picked
for upload, before any platform-specific transformation:

- no EXIF or metadata strip;
- no transcoding;
- no AVIF/JPEG/WebP re-encoding;
- no canonical orientation rewrite;
- no thumbnail generation;
- no preview tier generation;
- no per-tier resize or compression;
- no chunking/sharding boundary transform;
- no encryption envelope bytes.

The invariant is per photo, not per shard and not per media tier. A future
thumbnail and a future original tier derived from the same source file must
share the same album content hash.

## Field shape

The current public/client field name is `plaintextSha256Hex` in Android worker
output and related encryption cache inputs. The web upload queue stores the
same semantic value as `contentHash`.

The wire-adjacent byte/string rules are:

| Surface | Rule |
| --- | --- |
| Digest algorithm | SHA-256 |
| Input bytes | Source-of-truth user file bytes |
| String encoding | Lowercase hexadecimal |
| String length | 64 characters |
| Dedup key | `(albumId, contentHashHex)` |
| Scope | Client-local, per device |

The name `plaintextSha256Hex` means "SHA-256 over plaintext source media bytes";
it does not imply the server or backend ever receives plaintext.

## Web invocation

Web already follows the invariant by reading the picked `File` before any
media-tier work:

| Path | Current evidence |
| --- | --- |
| `apps/web/src/lib/upload/legacy-upload-handler.ts:16-21` | Reads `task.file.arrayBuffer()` into `originalBytes`, then calls `computeContentHash(originalBytes)` before chunk encryption. |
| `apps/web/src/lib/upload/tiered-upload-handler.ts:79-84` | Reads `task.file.arrayBuffer()` into `originalBytes`, then calls `computeContentHash(originalBytes)` before `generateTieredImages`, metadata stripping, or encryption. |
| `apps/web/src/lib/upload/video-upload-handler.ts:35-40` | Reads `task.file.arrayBuffer()` into `originalBytes`, then calls `computeContentHash(originalBytes)` before video frame extraction or fallback handling. |
| `apps/web/src/lib/content-hash.ts:27-35` | Initializes generated WASM and delegates to `computePlaintextContentHash(bytes)`. |
| `crates/mosaic-wasm/src/lib.rs:5259-5263` | Exposes `computePlaintextContentHash` to JS and delegates to Rust `compute_plaintext_content_hash`. |
| `crates/mosaic-wasm/src/lib.rs:5231-5242` | Exposes `sha256OfBytes` / `sha256HexOfBytes` for raw byte parity and fixture tests. |

The important detail is ordering: all web upload handlers compute the dedup
hash immediately after reading the source file. Later code may strip metadata,
generate thumbnails/previews, transcode originals, chunk large files, and
encrypt shards, but those later bytes are not the album content-hash input.

## Android invocation

Android obtains the same semantics by computing the hash upstream of shard
encryption and passing it through WorkData:

| Path | Current evidence |
| --- | --- |
| `apps/android-main/src/main/kotlin/org/mosaic/android/main/picker/PhotoPickerStagingAdapter.kt` | Opens the picked source URI and computes `albumContentHashHex` from source-of-truth bytes before staging output can become tier-specific. |
| `apps/android-main/src/main/kotlin/org/mosaic/android/main/staging/AppPrivateStagingManager.kt:34-43` | Opens the picked source URI and copies it into app-private staging for the current copy-only stager. |
| `apps/android-main/src/main/kotlin/org/mosaic/android/main/crypto/ShardEnvelopeStore.kt:14-25` | Reads the staged file or content URI bytes back as the encryption worker input. |
| `apps/android-main/src/main/kotlin/org/mosaic/android/main/crypto/ShardEncryptionScheduler.kt` | Passes precomputed `KEY_ALBUM_CONTENT_HASH_HEX` into `ShardEncryptionWorker` WorkData. |
| `apps/android-main/src/main/kotlin/org/mosaic/android/main/crypto/ShardEncryptionWorker.kt` | Reads and validates `KEY_ALBUM_CONTENT_HASH_HEX` and uses it for dedup lookup/recording without hashing staging input. |
| `apps/android-main/src/main/kotlin/org/mosaic/android/main/picker/PhotoPickerStagingAdapter.kt` | Production path delegates `computeAlbumContentHash` to `RustContentHasher.sha256Hex(stagedFile.file)` before shard scheduling. |
| `apps/android-main/src/main/kotlin/org/mosaic/android/main/upload/RustContentHasher.kt` | Calls the UniFFI Rust core `sha256OfBytes` export for files up to 32 MiB and preserves streaming SHA-256 behavior for larger staged files. |
| `crates/mosaic-uniffi/src/lib.rs:2451-2459` | Exposes `sha256_of_bytes` and `sha256_hex_of_bytes` to native clients. |
| `crates/mosaic-uniffi/src/lib.rs:2476-2480` | Exposes `compute_plaintext_content_hash(bytes)` as SHA-256 lowercase hex. |

Because the worker no longer hashes staging input, Android's dedup key
is intended to be independent of the stager remaining copy-only;
verify via the cross-impl test suite in
[`crates/mosaic-parity-tests/tests/cross_platform_parity.rs`](../../crates/mosaic-parity-tests/tests/cross_platform_parity.rs)
(see in particular `compute_plaintext_content_hash_matches_sha256_across_wasm_and_uniffi`
at lines 608-618 and
`content_hash_dedup_fixture_hashes_source_file_bytes_across_wasm_and_uniffi`
at lines 622-648, which are the contracts that *lock* this
independence). The wording was softened in v1.0.x s47-y4: the prior
"is fully independent" phrasing overstated the guarantee, because the
independence is a property maintained by the parity tests, not a
property that the code structure alone enforces. If a future stager
change (e.g. a tier-specific transformation in
`AppPrivateStagingManager` or a re-entry of hashing into
`ShardEncryptionWorker`) is introduced, the parity tests above MUST
be rerun and must remain green before that change can land.

## Cross-platform parity assertion

For every byte vector `B`:

```text
web.computePlaintextContentHash(B)
  == android.RustContentHasher.sha256Hex(B)
  == lowercase_hex(SHA-256(B))
```

The algorithm-level parity is locked by:

- `crates/mosaic-parity-tests/tests/cross_platform_parity.rs:608-618`
  `compute_plaintext_content_hash_matches_sha256_across_wasm_and_uniffi`

The caller-input fixture is locked by:

- `tests/vectors/content_hash_dedup.json`
- `crates/mosaic-parity-tests/tests/cross_platform_parity.rs:622-648`
  `content_hash_dedup_fixture_hashes_source_file_bytes_across_wasm_and_uniffi`
- `apps/web/src/lib/__tests__/content-hash-parity.test.ts:83-93`
  exercises the web `File.arrayBuffer()` caller layer and `computeContentHash`
- `apps/android-main/src/test/kotlin/org/mosaic/android/main/upload/RustContentHasherTest.kt:24-37`
  exercises the Android RustContentHasher caller layer with the same fixture
- `crates/mosaic-vectors/tests/differential.rs:123-138`
  asserts the fixture's golden hash against native Rust SHA-256

The shared fixture is a deterministic 64-byte JPEG-like byte sequence with a
SOI marker, APP1/Exif marker, TIFF header, pseudo-random payload, and EOI. Its
golden `plaintextSha256Hex` is:

```text
8be347a00517761ba396a7da425acd6c85df5b4cdff8b59c5fc67445f2a69fe3
```

This proves that if web and Android feed the same source bytes, all core hash
surfaces produce the same digest and lowercase hex string.

## Future risk: MediaTierGenerator

When `MediaTierGenerator` and `BitmapTierEncoder` are wired into Android
upload, the Android staging input can stop being the user-picked source file.
The stager may instead contain per-tier encoded bytes:

```text
source URI bytes
  -> decode/normalize
  -> Skia resize / encode thumbnail JPEG
  -> Skia resize / encode preview JPEG
  -> optional original re-encode or metadata-strip output
  -> staging URI per tier
```

If `ShardEncryptionWorker` continues to compute `plaintextSha256Hex` from that
per-tier staging URI, the dedup key silently changes from:

```text
Have I seen this photo in this album?
```

to:

```text
Have I seen this encoded thumbnail/preview/original shard in this album?
```

That is the Sweep A Finding 4.2 semantic divergence.

### Lock status update

The Android `ShardEncryptionWorker` no longer recomputes the content hash from
the staging input. It now consumes a precomputed
`KEY_ALBUM_CONTENT_HASH_HEX` parameter from WorkData (regex
`^[0-9a-f]{64}$`). The hash is computed UPSTREAM of the worker by the
scheduler (or its caller) over the source-of-truth user file bytes. This
guarantees the contract holds even when `MediaTierGenerator` /
`BitmapTierEncoder` lands and the staging output becomes tier-specific encoded
bytes.

## Implemented Android mitigation

Android computes one album-level content hash over the source URI bytes before
tier generation and passes it into shard encryption:

```text
albumContentHashHex = SHA-256(source URI bytes)

ShardEncryptionWorker(
  stagingUri = per-tier plaintext bytes,
  albumContentHashHex = albumContentHashHex,
  shardPlaintextHashHex = SHA-256(per-tier plaintext bytes)
)
```

The worker uses `albumContentHashHex` for dedup lookup/recording. Any future
per-shard hash may only be used for envelope cache keys, local integrity, or
shard diagnostics. Recomputing the dedup hash from per-tier staging input after
tier generation violates this SPEC.

## Dedup semantics

Deduplication is:

- per album;
- per source photo/file;
- per client device;
- stored in the client-local upload queue database;
- keyed by `(albumId, contentHashHex)`.

Web stores the key shape in IndexedDB:

- `apps/web/src/lib/content-hash.ts:52-60` creates `albumContentHashes` with
  key path and unique index `['albumId', 'contentHash']`.
- `apps/web/src/lib/upload/types.ts:185-205` defines the persisted
  `AlbumContentHashRecord` and `UploadQueueDB.albumContentHashes` key shape.

Android stores the same key shape in Room:

- `apps/android-main/src/main/kotlin/org/mosaic/android/main/db/UploadQueueEntities.kt:91-104`
  declares `album_content_hashes` with primary key `["album_id", "content_hash"]`.
- `apps/android-main/src/main/kotlin/org/mosaic/android/main/db/UploadQueueDaos.kt:129-138`
  looks up rows by album and content hash.
- `apps/android-main/src/main/kotlin/org/mosaic/android/main/upload/ContentHashDedup.kt:17-35`
  wraps DAO lookup/record operations behind the upload dedup interface.

Cross-device deduplication is explicitly out of scope for v1. Commit `b5b30f9`
introduced upload-time content-hash dedup as a client-local UX optimization,
not a server-side global dedup system.

## Negative scope

The content hash is not a security primitive.

It must not replace or weaken:

- XChaCha20-Poly1305 AEAD authentication;
- signed manifest validation;
- shard envelope header AAD;
- shard ciphertext SHA-256 integrity checks;
- server authorization checks;
- zero-knowledge boundaries.

The backend must continue to treat photos, metadata, manifests, and shards as
opaque encrypted blobs. No server feature may depend on plaintext content-hash
equality.

## Cryptographic note

The content hash is computed over plaintext bytes on the client, but it remains
client-local. It is not uploaded as a public cross-user identifier.

Under Mosaic's fresh-nonce AEAD semantics, encrypting the same plaintext twice
produces randomized ciphertext. Mosaic also does not compress media before
encryption, so content-aware compression does not create a matching pre-AEAD
compression transcript. The local dedup table only matters when the same user
on the same device uploads the same file twice into the same album.

Therefore this hash does not create a server-visible linkage channel beyond
what an authorized local client already knows: the user selected identical
source file bytes for the same album.

## Verification plan

| Gate | Command |
| --- | --- |
| Rust workspace | `cargo test --workspace --locked` |
| Rust parity | `cargo test -p mosaic-parity-tests` |
| Web content hash | `cd apps/web && npm run test:run -- content-hash` |
| Android unit tests | `cd apps/android-main && ..\..\gradlew.bat :apps:android-main:testDebugUnitTest` |
| Architecture guards | `tests/architecture/{guard}.sh` and `tests/architecture/{guard}.ps1` for the six configured raw-secret/logging guards |

## Lock status

This SPEC locks the content-hash invariant. The output bytes of
`sha256_of_bytes` are deterministic per the SHA-256 standard;
cross-platform parity is asserted by:
`crates/mosaic-parity-tests/tests/cross_platform_parity.rs::compute_plaintext_content_hash_matches_sha256_across_wasm_and_uniffi`

When the v1.0.0 release tag is cut, the content-hash field name
(`plaintextSha256Hex`), its hex casing (lowercase), and the dedup
table key shape (`(albumId, contentHashHex)`) become protocol-class
and freeze along with the rest of the protocol surfaces per
SPEC-ReleaseTagFreezePolicy.md.
