# Mosaic Web App

The web app is a React 19 + Vite shell around client-side storage, upload,
metadata processing, and a Rust-backed crypto worker. The backend remains
zero-knowledge: plaintext media, metadata, account keys, epoch seeds, tier
keys, signing secrets, and link secrets stay client-local.

## Crypto Worker API

The web app communicates with `mosaic-wasm` through a Web Worker boundary:

```text
React / services / hooks
  -> apps/web/src/lib/crypto-client.ts
  -> apps/web/src/workers/crypto.worker.ts
  -> apps/web/src/workers/rust-crypto-core.ts
  -> apps/web/src/generated/mosaic-wasm/mosaic_wasm.js
```

Post P-W7 and R-C6.1, normal crypto operations use opaque handle IDs instead
of raw key bytes. Handle IDs are branded strings in
`apps/web/src/workers/types.ts` (`AccountHandleId`, `IdentityHandleId`,
`EpochHandleId`, `LinkShareHandleId`, and `LinkTierHandleId`) and are only
meaningful inside the worker that minted them.

Primary handle-based worker methods include:

- `generateEpochKey(epochId)` — creates a Rust-owned epoch handle and returns
  `{ epochHandleId, wrappedSeed, signPublicKey }`.
- `openEpochKeyBundle(bundle, senderPubkey, albumId, minEpochId, options)` —
  verifies and imports a sealed bundle directly into a Rust-owned epoch handle.
- `createEpochKeyBundle(epochHandleId, albumId, recipientPubkey)` — seals a
  bundle from an existing epoch handle without exporting bundle plaintext.
- `encryptManifestWithEpoch(epochHandleId, plaintext)` — encrypts manifest
  metadata via the epoch handle.
- `decryptManifestWithEpoch(epochHandleId, envelopeBytes)` — decrypts manifest
  metadata via the epoch handle.
- `signManifestWithEpoch(epochHandleId, manifestBytes)` — signs with the
  per-epoch signing key held by Rust.
- `decryptShardWithTierKey(envelope, tierKey)` — accepts either a legacy
  `Uint8Array` link tier key or a `LinkTierHandleId`; share-link flows should
  pass the handle form.
- `wrapDbBlob(plaintext)` / `unwrapDbBlob(wrapped)` — wrap and unwrap OPFS
  snapshot bytes through the active account handle.

Ticket shorthand maps to the current code as follows:

- `encryptShardWithEpoch(epochHandleId, plaintext, shardIndex, tier)` maps to
  Rust facade `encryptShardWithEpochHandle(handle, plaintext, shardIndex,
  tierByte)`.
- `decryptShardWithEpoch(epochHandleId, envelope)` maps to Rust facade
  `decryptShardWithEpochHandle(handle, envelopeBytes)`.
- `wrapWithAccountHandle(accountHandle, plaintext, aadLabel)` maps to
  `wrapWithAccountHandle(accountHandle, plaintext)`. The AAD label is fixed in
  Rust as `mosaic:account-wrapped-data:v1`, not supplied by TypeScript callers.
- `unwrapWithAccountHandle(accountHandle, ciphertext, aadLabel)` maps to
  `unwrapWithAccountHandle(accountHandle, ciphertext)` with the same fixed AAD
  label.

The typed Rust facade in `apps/web/src/workers/rust-crypto-core.ts` maps these
worker methods to WASM exports such as:

- `encryptShardWithEpochHandle(handle, plaintext, shardIndex, tierByte)`
- `decryptShardWithEpochHandle(handle, envelopeBytes)`
- `wrapWithAccountHandle(accountHandle, plaintext)`
- `unwrapWithAccountHandle(accountHandle, ciphertext)`

The account-data wrap label is fixed by
[`SPEC-AeadDomainSeparation.md`](../../docs/specs/SPEC-AeadDomainSeparation.md)
as `mosaic:account-wrapped-data:v1`.

Never pass raw account keys, epoch seeds, tier keys, signing secrets, or link
secrets across the worker boundary. Handles are opaque IDs; if a caller cannot
complete an operation with a handle, the call path needs a reviewed migration
rather than a raw-key escape hatch.

## Error Codes

`apps/web/src/workers/worker-crypto-error-code.generated.ts` is auto-generated
from `crates/mosaic-client/src/lib.rs::ClientErrorCode` by
`scripts/generate-worker-crypto-error-codes.mjs`.

Do not edit the generated file by hand. Regenerate with:

```powershell
cd apps\web
npm run generate:error-codes
```

Drift is checked by `npm run check:error-codes`, the web `prebuild` script,
`crates/mosaic-uniffi/tests/error_code_parity.rs`, and CI. Worker-only handle
lifecycle codes start at `1000` to avoid collisions with Rust client-core
codes.

## Metadata Stripping (M0)

Upload metadata stripping is backed by Rust `mosaic-media` through WASM and is
implemented in `apps/web/src/lib/exif-stripper.ts`.

- JPEG uses `stripJpegMetadata`.
- PNG uses `stripPngMetadata`.
- WebP uses `stripWebpMetadata`.
- Source-preserved AVIF uses `stripAvifMetadata`.
- Source-preserved HEIC/HEIF uses `stripHeicMetadata`.
- Source-preserved video uses `stripVideoMetadata` for supported MP4/MOV/WebM/
  Matroska containers.
- `inspectImage`, `inspectVideoContainer`, `canonicalMetadataSidecarBytes`, and
  `videoMetadataSidecarBytes` expose client-local inspection/sidecar helpers
  through WASM without adding server plaintext behavior.
- Canvas-generated AVIF originals bypass strip because browser re-encoding
  sheds the source metadata before encryption.

The canonical strip set per format is
[`SPEC-MetadataStripParity.md`](../../docs/specs/SPEC-MetadataStripParity.md).
Stripping runs before upload encryption; stripped and original plaintext bytes
must not be logged.

## Rust-Core Boundary

Web modules calling into Rust/WASM:

- `apps/web/src/workers/rust-crypto-core.ts` — the single typed facade over
  generated `mosaic-wasm` imports.
- `apps/web/src/workers/crypto.worker.ts` — Comlink crypto worker, handle
  registry, and high-level worker API.
- `apps/web/src/workers/db.worker.ts` — OPFS SQLite snapshot wrap/unwrap through
  the account-handle bridge.
- `apps/web/src/lib/exif-stripper.ts` — M0 metadata strip delegation.
- `apps/web/src/lib/album-download-service.ts` — Rust-handle decrypt path for
  downloaded album content.
- Upload and sync adapter modules call Rust-owned handles indirectly through
  `crypto-client.ts` and worker APIs rather than importing WASM directly.

Pure TypeScript layers:

- `apps/web/src/components/` — UI components.
- `apps/web/src/hooks/` — React state and orchestration; crypto-touching hooks
  delegate to the worker/client facade.
- `apps/web/src/stores/` — client-side app state.
- `apps/web/src/locales/` and `apps/web/src/styles/` — localization and styling.

`apps/web/tests/rust-cutover-boundary.test.ts` enforces that generated WASM is
imported through `rust-crypto-core.ts` instead of directly from arbitrary web
modules. Architecture guard scripts in `tests/architecture/` enforce the
post-P-W7.7 no-raw-secret FFI boundary.

## OPFS Snapshot Compatibility

Current `SNAPSHOT_VERSION`: v4
(`apps/web/src/workers/db.worker.ts`).

See
[`SPEC-OpfsSnapshotCompat.md`](../../docs/specs/SPEC-OpfsSnapshotCompat.md)
for the v3 -> v4 invalidation history, the relationship between
`SNAPSHOT_VERSION` and the OPFS account-data wire format, and the required
protocol for future bumps.
