# Mosaic v1.0.0

> First stable release. Protocol surfaces are now frozen per
> [SPEC-ReleaseTagFreezePolicy.md](specs/SPEC-ReleaseTagFreezePolicy.md).
> Future v1.x releases will preserve wire-format compatibility; protocol
> breaks are reserved for v2.

## What Mosaic is

Mosaic is a zero-knowledge encrypted photo gallery for personal and small-group
use. It lets a web client and an Android client store, sync, search, and share
photos while keeping photo bytes, metadata, passwords, account keys, identity
keys, epoch keys, tier keys, and link secrets out of server memory. The backend
stores opaque encrypted blobs and lifecycle metadata; decryption remains on the
client that owns the keys.

## What v1.0.0 means

v1.0.0 is the first stable protocol lock for Mosaic.

The important plain-language promise is simple: photos uploaded by a v1 client
must remain readable by compatible v1.x clients, and v1.x clients must not
silently reinterpret protected bytes under a different protocol shape.

The engineering promise is narrower and stricter. At the moment the `v1.0.0`
tag is cut, the protocol surfaces listed in
[`docs/IMPLEMENTATION_PLAN.md` §11](IMPLEMENTATION_PLAN.md#11-late-v1-irreversibility-register)
become frozen under [SPEC-ReleaseTagFreezePolicy.md](specs/SPEC-ReleaseTagFreezePolicy.md).
That tag's tree is the v1 protocol version.

The freeze covers the surfaces that make stored encrypted data interoperable:

- shard envelope magic, version, header length, tier discriminants, nonce
  fields, and reserved-byte validation;
- streaming shard envelope `0x04`, including 64 KiB frames, stream salt,
  frame count, final-frame-size handling, and per-frame AAD construction;
- AEAD AAD labels for epoch seeds, identity seeds, account data, account-key
  wraps, link-tier-key wraps, and streaming frames;
- KDF labels for root keys, auth signing keys, tier keys, content keys, and
  the retained OPFS DB-session label;
- manifest transcript context and canonical byte layout;
- metadata sidecar context, tag table behavior, forbidden-tag error contract,
  and total sidecar byte cap;
- auth-challenge and epoch-bundle signing contexts;
- LocalAuth account-salt and sidecar room-id KDF parameters;
- stable public non-secret FFI DTO/error surfaces and the raw-secret-output
  prohibition.

The freeze policy is tag-driven rather than document-driven. Before the tag,
lock tests describe the candidate bytes. After the tag, the same tests enforce
the v1 compatibility contract. A post-tag breaking protocol change requires a
major version boundary and migration evidence; patch and minor v1 releases must
preserve the frozen v1 surfaces.

Companion specs used by this release include
[SPEC-LateV1ProtocolFreeze.md](specs/SPEC-LateV1ProtocolFreeze.md),
[SPEC-AeadDomainSeparation.md](specs/SPEC-AeadDomainSeparation.md),
[SPEC-ManifestCanonicalTranscript.md](specs/SPEC-ManifestCanonicalTranscript.md),
[SPEC-CanonicalSidecarTags.md](specs/SPEC-CanonicalSidecarTags.md),
[SPEC-CrossPlatformCryptoVectors.md](specs/SPEC-CrossPlatformCryptoVectors.md),
[SPEC-FfiSecretClassifiers.md](specs/SPEC-FfiSecretClassifiers.md), and
[SPEC-UploadContentHash.md](specs/SPEC-UploadContentHash.md).

## Headline changes since the start of the migration

### 🔒 Zero-knowledge invariants

- Protocol-class cryptography now routes through the Rust core crates under
  `crates/mosaic-*`.
- Web and Android facades use the same core byte algorithms rather than
  maintaining parallel TypeScript and Kotlin implementations.
- WASM and UniFFI paths are locked by cross-platform parity tests so hashed,
  signed, encrypted, and canonicalized bytes match web ↔ Android.
- The backend continues to store encrypted blobs and lifecycle metadata only.
- Server-side upload handling no longer fingerprints ciphertext as a source of
  truth; Tus SHA-256 metadata is advisory and client-supplied.
- Client manifests remain the integrity authority for shard content hashes.
- Raw epoch, account, identity, link-tier, and tunnel secrets are represented as
  Rust-owned handles on production FFI paths.
- Raw-secret-shaped production FFI exports are blocked by architecture guards.
- Comlink worker calls no longer carry raw tier-key bytes for share-link shard
  decrypts.
- Logs and diagnostics are treated as part of the zero-knowledge boundary.
- Console/log hygiene is explicitly governed by
  [SPEC-LoggingHygiene.md](specs/SPEC-LoggingHygiene.md).
- The release accepts that the backend sees timing, size, object identifiers,
  upload lifecycle state, and sharing topology metadata; it must not see
  plaintext media or cryptographic secret material.

### 🔐 Cryptographic primitives

- XChaCha20-Poly1305 is the shard, streaming-frame, and secret-wrap AEAD.
- Argon2id derives password-rooted L0 material.
- HKDF-SHA-256 derives L1 root material, auth signing material, sidecar room IDs,
  and other frozen labels named in §11.
- HMAC-SHA-256 derives LocalAuth account salts from user salt inputs.
- Ed25519 signs manifest transcripts, auth challenges, and epoch-bundle payloads.
- BLAKE2b derives tier/content keys and replaced legacy TypeScript BLAKE2b
  routes in the Rust migration arc.
- SHA-256 remains the content hash and signed-manifest integrity digest for
  source-of-truth upload bytes.
- Password input is NFKC-normalized before Argon2id on both web and Android.
- Key-wrap AAD labels are domain-separated so cross-domain unwrap and replay
  attempts fail.
- Streaming v0x04 derives per-frame keys and nonces from the frozen stream-salt
  and frame-index construction.
- Reserved envelope bytes are zero on encode and rejected on decode.
- The `weak-kdf` Rust feature remains test-only and is not a production release
  profile.

### 📱 Cross-platform consistency

- The parity suite covers default client behavior and feature-gated
  cross-client vector paths.
- Release evidence includes 32 default parity checks and 42
  `cross-client-vectors` checks, 74 cross-platform checks in total.
- The Rust parity file currently contains 42 Rust `#[test]` blocks and 145
  direct assertion calls across default and feature-gated coverage.
- WASM ↔ UniFFI parity now covers manifest transcript bytes, manifest signing,
  auth challenge transcripts, account-salt KDFs, sidecar room IDs, upload and
  download snapshot CBOR, encrypted content, sealed bundles, sidecar tunnels,
  streaming shards, link-tier wraps, and corrupted-input error behavior.
- Property-based parity tests exercise hashing, username validation, and
  identity-keypair derivation.
- Negative parity tests assert identical `ClientErrorCode` results for the same
  invalid input.
- Non-ASCII corpus coverage includes NFC/NFD text, emoji length boundaries,
  non-ASCII filenames in manifest transcripts, non-ASCII salts, and sidecar
  payloads.
- Password normalization prevents silent cross-device lockout for users whose
  password contains non-ASCII characters.
- Manifest transcript generation is canonicalized in Rust. The web client no
  longer hand-rolls divergent transcript layouts in TypeScript.
- Android content-hash dedup now uses the Rust SHA-256 route through UniFFI.
- Web content hashing already routes through WASM.
- Android test-only raw-vector wrappers were moved out of production source
  sets.
- Cross-client-vector CI now fails when required native bridge availability is
  missing instead of silently skipping corpus checks.
- CI exercises `cargo test --all-features` for the Rust workspace.
- CI checks that generated web WASM artifacts are committed and fresh.

### 🛡️ Architecture guards

- Nine guard families enforce Rust-core-only protocol-class crypto and adjacent
  secrecy boundaries.
- PowerShell and shell variants are kept in sync by a Vitest equivalence test.
- The guard set covers Rust crate boundaries.
- The guard set covers Rust secret logging.
- The guard set covers web direct console logging under the approved scope list.
- The guard set covers Android direct logging.
- The guard set covers raw-secret-shaped FFI exports.
- The guard set covers web raw-input FFI bypasses.
- The guard set covers Kotlin raw-input FFI bypasses.
- The guard set covers web listener cleanup.
- The guard set covers web Rust-core protocol completeness.
- Banned web patterns include direct WebCrypto `subtle.deriveKey` and
  `subtle.deriveBits` for protocol-class KDFs.
- Banned web patterns include direct `sodium.crypto_*` calls for
  protocol-class operations.
- Banned web patterns include named imports such as `import { crypto_* } from
  'libsodium-wrappers-sumo'`.
- Banned FFI patterns include production exports that look like raw account,
  identity, epoch, tier, link, auth, or tunnel secrets.
- Banned worker-boundary patterns include Comlink parameters shaped as raw
  secret bytes for protocol operations.
- Banned Android patterns include JVM stdout/stderr and SLF4J direct logging in
  protected areas.
- Banned Rust logging patterns include qualified-path logging macro bypasses.
- Retired TypeScript crypto helper paths are blocked so protocol logic does not
  drift back out of Rust.

### 🔍 Architecture-guard hardening

The architecture guards themselves went through adversarial review sweeps. The
sixth sweep found protocol-class KDFs still running in TypeScript because the
banned-pattern list was too narrow. Those KDFs were migrated to Rust core and
entered the §11 register as LocalAuth account-salt and sidecar room-id
parameters. A later sweep found a one-line bypass through libsodium named
imports; that import form is now blocked as well.

This matters because v1.0.0 does not only freeze crypto bytes. It also freezes
an operational discipline: future protocol-class crypto must be implemented in
Rust core first, surfaced through reviewed WASM/UniFFI facades, covered by
parity tests, and protected by architecture guards.

### 📋 Test coverage

- Cross-platform parity covers 32 default checks plus 42 feature-gated
  `cross-client-vectors` checks.
- The Rust parity file includes 42 `#[test]` functions and 145 direct
  assertions.
- Property-based parity uses small proptest corpora for deterministic byte
  invariants.
- Negative tests check corrupted input and invalid domain behavior.
- Lock tests freeze shard-envelope magic, version, header length, reserved-byte
  behavior, and `ShardTier` discriminants.
- Lock tests freeze manifest and metadata sidecar contexts.
- Lock tests freeze KDF labels and AEAD AAD labels.
- Lock tests freeze streaming v0x04 layout and streaming AAD labels.
- Web Vitest coverage includes architecture-guard equivalence checks.
- Android Gradle tests cover bridge behavior and WorkManager retry/dedup
  regressions.
- Backend xUnit coverage includes strict JSON and upload validation behavior.
- Rust workspace checks include feature-gated vector paths and all-features
  compilation.
- Generated WASM artifact freshness is checked in CI.
- The upload content-hash contract is documented in
  [SPEC-UploadContentHash.md](specs/SPEC-UploadContentHash.md) and covered by
  parity assertions.
- Media metadata stripping and orientation behavior are documented in
  [SPEC-MetadataStripParity.md](specs/SPEC-MetadataStripParity.md) and
  [SPEC-MediaOrientationNormalization.md](specs/SPEC-MediaOrientationNormalization.md).

### 🐛 Critical fixes in the final stretch

- EXIF double-rotation: modern browsers applied EXIF orientation during
  `createImageBitmap`, then Mosaic applied the manual transform again. The web
  pipeline now passes `imageOrientation: 'none'`, making manual orientation the
  single source of truth for Samsung, Pixel, Xiaomi, and other portrait JPEGs.
- Manifest sign+verify routing: the web client previously had three divergent
  TypeScript transcript layouts. v1 routes signing and verification through the
  Rust canonical `manifestTranscriptBytes` path, preventing web-uploaded photos
  from disappearing after reload or Android sync.
- Android self-dedup: `ShardEncryptionWorker` treated its own recorded
  `(album, hash, photoId)` row as a duplicate after WorkManager retry. The
  dedup check now skips rows whose `photoId` matches the current photo.
- Multi-tier upload retry: the same self-match bug could abort after one tier
  recorded successfully. The self-match guard covers this path as well.
- Tus SHA-256 source of truth: backend upload SHA-256 is now advisory metadata,
  while signed client manifests remain authoritative.
- Comlink raw-key crossing: shared-link shard decrypt now passes Rust-managed
  handle IDs across the worker boundary instead of raw tier-key bytes.
- Android content hash: content-hash dedup SHA-256 now routes through Rust core
  via UniFFI instead of `java.security.MessageDigest`.
- Password NFKC: web and Android normalize password text before Argon2id so
  canonically equivalent non-ASCII passwords unlock the same account.
- Sidecar telemetry JSON strictness: backend telemetry rejects unknown JSON
  fields using the correct unmapped-member handling setting.
- Test-only raw-vector wrappers: Android corpus-driver wrappers moved from
  production source sets into test source sets.
- Defensive bridge validation: web/backend validation and web/Android equality
  semantics were tightened before tag freeze.
- Cross-client parity gaps: sidecar tunnels, manifest signing, upload/download
  snapshots, sealed bundles, streaming shards, account-data wraps, encrypted
  sidecars, link-tier wraps, and corrupted-input paths gained parity coverage.

### 🔧 Internal infrastructure

- [SPEC-ReleaseTagFreezePolicy.md](specs/SPEC-ReleaseTagFreezePolicy.md)
  defines the tag-driven freeze rule.
- [SPEC-LateV1ProtocolFreeze.md](specs/SPEC-LateV1ProtocolFreeze.md)
  inventories candidate v1 surfaces before the tag.
- [SPEC-UploadContentHash.md](specs/SPEC-UploadContentHash.md) defines the
  per-photo source-of-truth byte contract.
- [SPEC-LoggingHygiene.md](specs/SPEC-LoggingHygiene.md) records the console-log
  scope inclusion rationale.
- [SPEC-WebRustCryptoCutover.md](specs/SPEC-WebRustCryptoCutover.md) records the
  web migration from TypeScript protocol crypto to Rust WASM routes.
- [SPEC-WebTypeScriptCryptoProtocolClassification.md](specs/SPEC-WebTypeScriptCryptoProtocolClassification.md)
  classifies retired and permitted TypeScript crypto surfaces.
- [SPEC-RustEpochHandleClientWiring.md](specs/SPEC-RustEpochHandleClientWiring.md)
  records handle-based epoch/tier-key client wiring.
- [SPEC-RustIdentityHandles.md](specs/SPEC-RustIdentityHandles.md) records
  identity-handle migration work.
- [SPEC-RustManifestSigning.md](specs/SPEC-RustManifestSigning.md) records Rust
  canonical manifest signing migration.
- [SPEC-RustEncryptedMetadataSidecar.md](specs/SPEC-RustEncryptedMetadataSidecar.md)
  records encrypted metadata sidecar work.
- [SPEC-RustMediaMetadataSidecarIntegration.md](specs/SPEC-RustMediaMetadataSidecarIntegration.md)
  records media sidecar integration work.
- [SPEC-AndroidMediaCoreBridge.md](specs/SPEC-AndroidMediaCoreBridge.md) and
  [SPEC-AndroidManualUploadCrossClientProof.md](specs/SPEC-AndroidManualUploadCrossClientProof.md)
  record Android bridge and cross-client upload proof work.
- [SPEC-IosReadinessAdapter.md](specs/SPEC-IosReadinessAdapter.md) records the
  first iOS-readiness seam without claiming an iOS client exists.

## Protocol-freeze register summary

The §11 register in `docs/IMPLEMENTATION_PLAN.md` remains the authoritative
list of v1 frozen protocol surfaces. This release note summarizes it for tag
readers; it does not replace the register.

| Surface | v1 status |
| --- | --- |
| AEAD domain labels | Frozen on tag; cross-domain unwrap/replay must fail. |
| Shard envelope v0x03 | Frozen magic `SGzk`, version `0x03`, 64-byte header, zero reserved bytes. |
| Streaming envelope v0x04 | Frozen 64-byte header, 64 KiB frames, stream salt, frame metadata, reserved-byte checks. |
| `ShardTier` values | Frozen `thumb=1`, `preview=2`, `full=3`. |
| Manifest transcript | Frozen `Mosaic_Manifest_v1` context and canonical bytes. |
| Metadata sidecar | Frozen `Mosaic_Metadata_v1` context, tag behavior, total cap. |
| KDF labels | Frozen root/auth/tier/content/DB-session label set. |
| Auth and bundle contexts | Frozen `Mosaic_Auth_Challenge_v1` and `Mosaic_EpochBundle_v1`. |
| LocalAuth account salt | Frozen HMAC-SHA-256 info string and 16-byte output rule. |
| Sidecar room ID | Frozen HKDF-SHA-256 info string and 16-byte output rule. |
| FFI public contract | Stable non-secret DTO/error surface; raw secret outputs are release blockers. |

## Recent commit map

The final pre-tag stretch is useful audit material because it shows which risks
were still being closed immediately before v1.0.0:

| Commit | Area | Release-note meaning |
| --- | --- | --- |
| `757fe0a` | Security | Closed FFI and web protocol KDF bypasses that kept some protocol KDFs outside Rust core. |
| `f5a5680` | Register | Recorded account-salt and sidecar-room KDF parameters in §11. |
| `28b7a4d` | Guards | Hardened architecture guards after sweeps 4 and 5. |
| `18dd299` | Backend | Made sidecar telemetry strict JSON rejection match the comment and intent. |
| `91eb4d3` | Web media | Fixed browser EXIF double-rotation by disabling implicit bitmap orientation. |
| `d3ea340` | Android crypto | Routed Android dedup SHA-256 through Rust UniFFI. |
| `845acde` | Android tests | Moved corpus-driver UniFFI wrappers into test source sets. |
| `138f77b` | Upload ZK | Made Tus shard SHA-256 advisory client metadata. |
| `11af6d3` | Worker boundary | Replaced raw tier-key Comlink crossing with handle-based decrypt. |
| `dc2856b` | Android upload | Prevented WorkManager retry self-dedup aborts. |
| `80d9c9b` | Manifest | Routed web manifest sign+verify through Rust canonical transcript bytes. |
| `d3f9075` | Unicode | NFKC-normalized passwords before Argon2id on web and Android. |
| `eed3207` | Bridges | Tightened web/Android type bridges and equality semantics. |
| `9549a76` | Validation | Added backend and web defensive validations. |
| `dc4be0c` | Parity | Closed six cross-platform parity gaps from sweep D. |
| `f23f1a3` | Spec | Locked the upload content-hash source-of-truth invariant before tier generation lands. |
| `df3d6d4` | CI | Hardened cross-client vectors, WASM artifact freshness, and all-features tests. |
| `1355eb7` | UniFFI | Added handle-based sealed-bundle support for reverse R5 parity. |
| `3c5a322` | Parity | Added R7/R8/R9 and negative-parity round trips. |
| `a44d20e` | Parity | Added property-based and non-ASCII corpus tests. |

The pattern is intentional: late fixes were either user-visible correctness
problems, zero-knowledge boundary tightening, or test/guard gaps that would make
the v1 freeze less auditable.

## Reviewer reading order

For future reviewers who need to re-audit v1 quickly:

1. Read this release note for the plain-language contract.
2. Read [SPEC-ReleaseTagFreezePolicy.md](specs/SPEC-ReleaseTagFreezePolicy.md)
   for the tag-driven freeze rule.
3. Read `docs/IMPLEMENTATION_PLAN.md` §11 for the authoritative register.
4. Read [SPEC-LateV1ProtocolFreeze.md](specs/SPEC-LateV1ProtocolFreeze.md) for
   the candidate inventory prose.
5. Inspect `crates/mosaic-crypto/src/lib.rs` constants and public exports.
6. Inspect `crates/mosaic-wasm/src/lib.rs` and `crates/mosaic-uniffi/src/lib.rs`
   for facade exposure.
7. Run or inspect `crates/mosaic-parity-tests/tests/cross_platform_parity.rs`.
8. Run or inspect `tests/architecture/` guard scripts and their equivalence
   tests.

## Breaking changes

There are no expected breaking changes for external users because v1.0.0 is the
first stable public protocol release.

For contributors who worked on pre-v1 builds, the internal breaking changes are
substantial:

- legacy TypeScript protocol crypto routes are retired or guarded;
- production FFI routes use handles rather than raw-secret byte outputs;
- manifest transcript bytes come from Rust canonical code;
- web/Android password inputs are normalized before KDF;
- backend upload SHA-256 is advisory metadata rather than a server-derived
  ciphertext fingerprint;
- Android production source sets no longer include raw-vector corpus wrappers;
- architecture guards treat guard-script drift as a release-blocking problem.

No migration is promised for data produced by arbitrary untagged pre-v1 commits.
The compatibility contract begins at the `v1.0.0` release tag.

## Security-relevant changes for reviewers

Security reviewers should start here:

- Confirm every §11 surface is guarded by a lock test or parity vector.
- Confirm no production FFI export returns raw account, identity, epoch, tier,
  link, auth, tunnel, or password-derived secret bytes.
- Confirm no protocol-class KDF, hash, AEAD, signature, transcript, or key-wrap
  path bypasses Rust core.
- Confirm web does not call direct WebCrypto or direct libsodium protocol-class
  primitives outside allowed wrappers.
- Confirm Android production code does not use Java/Kotlin crypto primitives for
  protocol-class bytes that Rust owns.
- Confirm Comlink worker calls use handles for secret material.
- Confirm the backend treats shard data as opaque and validates only lifecycle
  metadata and declared formats.
- Confirm signed manifests, not server-side inspection, remain the integrity
  source of truth for encrypted shard content.
- Confirm errors and logs expose stable codes and operational context without
  plaintext media, secrets, raw URIs, passwords, or keys.
- Confirm `weak-kdf` and `cross-client-vectors` remain test/corpus features, not
  production profiles.
- Confirm password normalization happens before Argon2id everywhere password
  text enters the protocol.
- Confirm the manifest transcript has one canonical Rust layout.
- Confirm sidecar forbidden tags reject with the frozen error contract.
- Confirm streaming v0x04 rejects malformed reserved bytes and impossible final
  frame sizes.
- Confirm upload content-hash inputs are the original user-selected source
  bytes as specified in [SPEC-UploadContentHash.md](specs/SPEC-UploadContentHash.md).

## Known limitations / deferred to v2

These are known and explicit at v1.0.0:

- Cross-device deduplication is not implemented; deduplication is per-device and
  based on the source-of-truth byte contract.
- The iOS client is not implemented. Adapter seams exist for future porting, but
  v1 ships web and Android protocol surfaces.
- Android `MediaTierGenerator` per-tier transforms are not wired into production
  upload generation at this tag.
- Some non-ASCII surrogate-pair edge cases are documented by parity tests as
  cross-facade byte-risk areas rather than hidden assumptions.
- `cargo doc` warnings remain non-blocking for this tag.
- A small number of clippy findings remain non-blocking for this tag.
- Metadata sidecar decoder hardening tracked after R-M5.2 remains outside the
  v1 runtime requirement unless promoted by a later compatible release.
- Server operators still learn unavoidable operational metadata such as account
  identifiers, album membership, object sizes, timing, IP-level transport data,
  and upload lifecycle state.
- v1 does not provide deniable storage, traffic analysis resistance, or server
  blindness to object counts.
- v1 does not promise compatibility with untagged pre-v1 data produced during
  the migration arc.
- The release does not claim third-party cryptographic audit completion.

## Threat model + non-goals

Mosaic v1 protects photo bytes and sensitive metadata from the storage server by
keeping encryption and decryption client-side. The server is trusted for
availability, authentication integration, blob retention, sync coordination, and
access-control bookkeeping. The server is not trusted with plaintext media,
plaintext metadata, passwords, or cryptographic keys.

Mosaic v1 is not a general-purpose anonymous photo network. It does not hide
that a user has an account, that an upload happened, the approximate size of an
encrypted object, the time of sync, or the membership graph needed to share
albums. It also does not protect a compromised client device after secrets have
been unlocked in that client.

The zero-knowledge line for v1 is therefore precise: the server stores and moves
opaque encrypted blobs and authenticated metadata, while clients own the bytes
that make those blobs meaningful.

## Verification performed for this release note

This document was drafted from:

- `git log --oneline 757fe0a^..HEAD`;
- `git log --pretty=format:'%H%n%s%n%b%n---' 757fe0a^..HEAD`;
- `git log --oneline --since='2025-09-01'`;
- `git log --pretty=format:'%H %s' --invert-grep --grep='^chore\|^style\|^docs'`;
- `crates/mosaic-crypto/src/lib.rs` first 200 lines;
- `crates/mosaic-wasm/src/lib.rs` and `crates/mosaic-uniffi/src/lib.rs` public
  facade surfaces;
- `docs/IMPLEMENTATION_PLAN.md` §11;
- `tests/architecture/` guard inventory;
- `crates/mosaic-parity-tests/tests/cross_platform_parity.rs` test and assertion
  inventory;
- `docs/specs/` link existence check.

The release note intentionally does not edit `docs/IMPLEMENTATION_PLAN.md`. The
§11 register is orchestrator-owned.

## Acknowledgements

The v1.0.0 release note reflects a long migration arc across Rust core, WASM,
UniFFI, web, Android, backend upload handling, parity tests, and architecture
guards.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
