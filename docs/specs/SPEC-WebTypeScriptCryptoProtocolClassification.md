# Web TypeScript Crypto/Protocol Responsibility Classification

## Status

Band 4 / Phase D classification for the `ts-crypto-classification` lane. This is a deletion map, not a deletion approval. It records which `apps/web` TypeScript surfaces still own crypto/protocol/client-core behavior while Band 2/3 Rust state-machine, epoch-handle, upload, sync, and Android interop work is still landing.

## Classification legend

| Category | Meaning |
|---|---|
| Rust-backed production path | Production behavior already calls generated Rust WASM for the protocol surface. |
| Platform adapter glue around Rust-backed behavior | TypeScript should remain thin: worker loading, Comlink, DTO conversion, or UI orchestration around Rust-backed calls. |
| Still TypeScript production behavior pending Band 2/3 APIs | Do not delete yet. This code still performs live web crypto/protocol/upload/sync work until replacement APIs land and are wired. |
| Rollback/reference-only path | Kept only for legacy compatibility, rollback, mock/reference, or old-data migration. Remove after explicit migration/rollback-window close. |
| Test-only/reference oracle | Tests or golden/reference checks only; may import TS/Rust crypto directly to prove compatibility. |

## Production classification

| Surface | Category | Current responsibility | Removal/blocker notes |
|---|---|---|---|
| `apps/web/src/generated/mosaic-wasm/mosaic_wasm.js` and `mosaic_wasm.d.ts` | Rust-backed production path | Generated WASM exports for account handles, identity handles, epoch handles, shard encrypt/decrypt records, envelope parsing, and manifest verification. | Keep generated files. Later cleanup should expand callers, not hand-edit these files. |
| `apps/web/src/workers/rust-crypto-core.ts` | Rust-backed production path | Loads generated WASM once and exposes `parseEnvelopeHeaderFromRust` plus `verifyLegacyManifestWithRust`. | Keep as the current Rust boundary. Expand or replace with a broader Rust client-core facade after Band 2/3 APIs land. |
| `apps/web/src/workers/crypto.worker.ts` (`peekHeader`, `verifyManifest`) | Rust-backed production path | Uses `rust-crypto-core` for envelope header parsing and legacy manifest verification. | Already Rust-backed for these methods. Deletion blocker is only the surrounding mixed TS compatibility class. |
| `apps/web/src/lib/crypto-client.ts` | Platform adapter glue around Rust-backed behavior | Comlink singleton that owns the web worker lifecycle and exposes `CryptoWorkerApi` to React/lib callers. | Should remain thin even after Rust cutover; may point to a new Rust-backed worker facade. |
| `apps/web/src/workers/types.ts` | Platform adapter glue around Rust-backed behavior | Worker API DTOs and `PhotoMeta`/manifest/upload shapes crossing worker and UI boundaries. | Keep until Rust/API DTOs are generated or narrowed. `EncryptedShard` import from `@mosaic/crypto` is type-only compatibility debt. |
| `apps/web/src/lib/api.ts` and `apps/web/src/lib/api-types.ts` | Platform adapter glue around Rust-backed behavior | HTTP DTOs, sync endpoint shape, upload/share-link/epoch-key requests; `api-types.ts` re-exports `AccessTier`. | Keep as web transport contract. Replace crypto enum import only after Rust/shared protocol types are generated for web. |
| `apps/web/src/lib/album-metadata-service.ts` | Platform adapter glue around Rust-backed behavior | Converts base64 album-name envelopes and delegates decrypts to the crypto worker. | Keep as UI-facing metadata adapter; should not grow direct primitive imports. |
| `apps/web/src/components/Shared/SharedGallery.tsx` | Platform adapter glue around Rust-backed behavior | Shared-link gallery fetch/decrypt orchestration; only direct crypto import is `fromBase64`. | Keep UI shell. Base64 helper can move to a non-crypto utility when shared-link Rust facade lands. |
| `apps/web/src/contexts/AlbumContentContext.tsx` | Platform adapter glue around Rust-backed behavior | Serializes story-block documents, delegates content encryption/decryption to the worker, then sends opaque ciphertext/nonce to API. | Keep UI shell. Worker methods remain TS-backed until Rust content-key API is wired. |
| `apps/web/src/workers/crypto.worker.ts` (account/key/shard/manifest/link/auth/content methods) | Still TypeScript production behavior pending Band 2/3 APIs | Live web crypto facade: libsodium readiness, L0/L1/L2 account opening, identity/auth derivation, shard encrypt/decrypt, manifest encrypt/sign, epoch bundle open/create, share-link secret/key wrapping, account-key wrapping, session export/import, and album-content encryption. | Major deletion blocker. Needs Rust WASM client-core coverage for account unlock, opaque account/identity/epoch handles, shard encrypt/decrypt, manifest sign/encrypt, share-link wrapping, auth challenge signing, content-key encryption, and session restore semantics before shrinking. |
| `apps/web/src/workers/db.worker.ts` | Still TypeScript production behavior pending Band 2/3 APIs | Local SQLite-WASM database plus OPFS snapshot encryption with libsodium `crypto_secretbox_*` using session key from crypto worker. | Not directly replaced by Android upload APIs. Keep until a web storage/encrypted-cache adapter decision exists; direct libsodium import is intentionally allowlisted. |
| `apps/web/src/lib/epoch-key-service.ts` | Still TypeScript production behavior pending Band 2/3 APIs | Fetches epoch-key bundles, asks worker to open them, handles legacy empty-album-id retry, and caches raw epoch seeds/sign keys. | Blocked on Rust account/identity/epoch handle wiring plus a web cache model that avoids raw epoch seeds in TS. |
| `apps/web/src/lib/epoch-key-store.ts` | Still TypeScript production behavior pending Band 2/3 APIs | In-memory raw epoch seed/sign-key cache with `memzero` cleanup and race-preserving replacement rules. | Delete or shrink only after web can store opaque Rust epoch handles or wrapped seeds instead of raw seeds. |
| `apps/web/src/lib/epoch-rotation-service.ts` | Still TypeScript production behavior pending Band 2/3 APIs | Generates new epoch keys through worker, seals member bundles, unwraps owner-encrypted link secrets, derives/wraps tier keys for active links, and calls rotate API. | Blocked on Rust epoch rotation/share-link wrapping APIs and Android-compatible rotation request assembly. |
| `apps/web/src/hooks/useAlbums.ts` | Still TypeScript production behavior pending Band 2/3 APIs | Album create/rename/delete flow: generates initial epoch key, encrypts album names, creates/re-seals owner epoch bundle, caches raw epoch key, wipes failure buffers. | Blocked on Rust account/epoch handles, encrypted album metadata helper, and bootstrap bundle API. |
| `apps/web/src/hooks/useShareLinks.ts` | Still TypeScript production behavior pending Band 2/3 APIs | Creates share links by generating link secrets, deriving link IDs/wrapping keys, wrapping tier keys per epoch, and owner-wrapping link secrets. | Blocked on Rust share-link/key-wrap facade and typed AccessTier replacement. |
| `apps/web/src/hooks/useLinkKeys.ts` | Still TypeScript production behavior pending Band 2/3 APIs | Validates URL link secret/id, derives wrapping key, unwraps server tier keys, and caches tier keys for shared-link viewing. | Blocked on Rust share-link open/unwrap facade and a secure web tier-key cache strategy. |
| `apps/web/src/lib/link-tier-key-store.ts` | Still TypeScript production behavior pending Band 2/3 APIs | Persists unwrapped share-link tier keys in IndexedDB encrypted with WebCrypto AES-GCM session key. | Keep until shared-link viewing can use opaque Rust handles or wrapped-key persistence without plaintext tier keys in TS. |
| `apps/web/src/lib/sync-engine.ts` | Still TypeScript production behavior pending Band 2/3 APIs | Owns sync cursor loop, pagination guards, epoch-key lookup, signer pubkey checks, manifest signature verification, manifest decryption, DB insertion, version cursor updates, cancellation, and queued sync draining. | Blocked on Band 2 Rust client sync state machine and web adapter for DB/API side effects. Do not rewire while other bands are unmerged. |
| `apps/web/src/contexts/SyncContext.tsx` and `apps/web/src/lib/sync-coordinator.tsx` | Still TypeScript production behavior pending Band 2/3 APIs | React auto-sync registration/locking plus upload-complete promotion coordination over `syncEngine` events and local DB reads. | Keep as web UI shell. May remain as platform glue after Rust sync core but should no longer own cursor/manifest crypto. |
| `apps/web/src/lib/manifest-service.ts` | Still TypeScript production behavior pending Band 2/3 APIs | Assembles `PhotoMeta`, embeds tiered shard hashes/IDs, encrypts manifest metadata through worker, signs encrypted metadata, and finalizes with `api.createManifest`. | Blocked on Rust/Android manifest assembly/finalization APIs and agreed canonical transcript cutover. |
| `apps/web/src/lib/thumbnail-generator.ts` | Still TypeScript production behavior pending Band 2/3 APIs | Browser image decode/resize/ThumbHash plus direct `@mosaic/crypto` tier encryption for thumbnail/preview/original shards. | Blocked on Rust media/upload APIs and web codec strategy. Do not delete because web upload still uses this for supported images. |
| `apps/web/src/lib/upload/upload-queue.ts`, `types.ts`, `upload-persistence.ts`, `tus-upload.ts`, and `index.ts` | Still TypeScript production behavior pending Band 2/3 APIs | Web upload state machine, retry/resume persistence, TUS transport, handler context, and compatibility exports. | Blocked on Rust upload planning/finalization state machine and Android upload APIs. Keep dependency-safe until Bands 2/3 merge. |
| `apps/web/src/lib/upload/tiered-upload-handler.ts` | Still TypeScript production behavior pending Band 2/3 APIs | Image upload path: derives tier keys, generates/encrypts tier images, uploads TUS shards, records tiered shard refs. | Blocked on Rust epoch-handle encryption and media tier upload adapter. |
| `apps/web/src/lib/upload/video-upload-handler.ts` | Still TypeScript production behavior pending Band 2/3 APIs | Video path: extracts thumbnail, directly encrypts thumbnail/original chunks, uploads TUS shards, builds tiered refs, falls back to legacy upload. | Blocked on Android/web media upload API and Rust shard encryption wrappers. |
| `apps/web/src/lib/upload/legacy-upload-handler.ts` | Still TypeScript production behavior pending Band 2/3 APIs | Non-image fallback: chunked original-only encrypted upload through `CryptoWorkerApi.encryptShard`. | Keep as production fallback until replacement upload state machine covers unsupported formats or explicitly removes support. |
| `apps/web/src/lib/upload-store-bridge.ts` | Still TypeScript production behavior pending Band 2/3 APIs | Bridges upload queue lifecycle to photo store and sync coordinator. | Likely remains web UI glue, but promotion semantics depend on the TS sync/upload queues today. |
| `apps/web/src/lib/error-messages.ts` | Platform adapter glue around Rust-backed behavior | User-safe error mapping for `CryptoError`/`EpochKeyError`/upload/API errors. | Keep; replace `@mosaic/crypto` error-class dependency after Rust/client error codes become the web source of truth. |

## Rollback/reference-only and legacy compatibility paths

| Surface | Category | Current responsibility | Removal/blocker notes |
|---|---|---|---|
| `apps/web/src/lib/api-mock.ts` | Rollback/reference-only path | Mock API implementation mirrors sync, album content, upload, share-link, and epoch-key DTOs for local/reference flows. | Not a production crypto owner. Update alongside DTO changes; delete only if mock mode is retired. |
| `apps/web/src/workers/crypto.worker.ts` legacy fallback branches | Rollback/reference-only path | `decryptShard` and `decryptManifest` retry with raw epoch seed/read key for data encrypted before tier-key derivation. | Remove only after old-data migration/compatibility window is explicitly closed. |
| `apps/web/src/hooks/useAlbums.ts` bootstrap empty-album-id bundle path | Rollback/reference-only path | Creates a temporary legacy self-sealed bundle before immediately re-sealing with the server album id. | Remove only when backend/API can create albums with strict album-id-bound initial bundles in one transaction. |

## Test-only/reference oracle surfaces

| Surface | Category | Current responsibility | Removal/blocker notes |
|---|---|---|---|
| `apps/web/tests/rust-cutover-boundary.test.ts` | Test-only/reference oracle | Static guard that keeps generated Rust WASM behind `rust-crypto-core`, keeps Rust facade behind `crypto.worker`, classifies every production `@mosaic/crypto` import, and allowlists direct libsodium worker adapters. | Keep and update allowlists with justification whenever production crypto imports move. |
| `apps/web/src/workers/__tests__/rust-crypto-core.test.ts` | Test-only/reference oracle | Unit tests for Rust manifest verification adapter and 64-byte envelope header parsing. | Keep as Rust/TS adapter regression coverage. |
| `apps/web/tests/base64-compatibility.test.ts`, `thumbnail-generator.test.ts`, `e2e-flows.test.ts` | Test-only/reference oracle | Direct libsodium or `@mosaic/crypto` imports act as compatibility/vector checks for existing TS behavior. | Keep until Rust vectors fully cover these behaviors and tests are migrated. |
| `apps/web/tests/*` files that `vi.mock('@mosaic/crypto')` | Test-only/reference oracle | Mock TS crypto behavior to isolate hooks/services (`sync-engine`, share links, uploads, epoch rotation). | Update with production surface migration; these are not production blockers by themselves. |

## Static guard policy

`apps/web/tests/rust-cutover-boundary.test.ts` is the focused guard for this classification. New production imports of generated Rust WASM, `rust-crypto-core`, `@mosaic/crypto`, or `libsodium-wrappers-sumo` must either fail this test or be added to an explicit allowlist with a blocker note. This keeps web thin-shell cleanup dependency-safe while Bands 2 and 3 are still unmerged.

### Lane B (Band 5) hardening

The Lane B work expanded the boundary guard from a file-level fence to a
**per-symbol fence**. Every entry in `tsCryptoCompatibility` now declares
the exact set of `@mosaic/crypto` identifiers the file is allowed to
import. Adding a new identifier — even to an already-classified file —
fails the test until the SPEC is updated.

The guard also enforces:

- A `PROTOCOL_CLASS_SYMBOLS` set listing every symbol that touches
  encryption, signing, key derivation, or envelope construction. Any
  allowlist entry that exposes a protocol-class symbol must justify it
  with rationale containing `facade`, `compatibility`, or
  `pending Rust`.
- Wildcard imports (`import * as crypto from '@mosaic/crypto'`) are
  rejected because they bypass per-symbol classification.
- The new `apps/web/src/lib/conflict-resolution.ts` module is verified
  to be shell-class — it must never import `@mosaic/crypto`,
  libsodium, or `rust-crypto-core`.
- The new `notifyContentConflict` seam in `apps/web/src/lib/sync-engine.ts`
  is statically checked against accidentally referencing `epochSeed`,
  `signSecretKey`, `identitySecret`, or `accountKey` — i.e. the
  conflict-event payload cannot leak key material.

### Sync conflict resolution (Lane B addition)

`apps/web/src/lib/conflict-resolution.ts` is the deterministic
three-way merge implementation described in
`docs/specs/SPEC-SyncConflictResolution.md` Phase 1+2:

- Pure functions, no I/O, no crypto, no logging.
- Falls back to LWW (server wins) when no base snapshot is available.
- Performs three-way block-level merge with LWW fallback for same-block
  conflicts when a base is available.
- Surfaces conflicts via the new `content-conflict` event on
  `syncEngine`, which `SyncCoordinator.onContentConflict` forwards to UI
  listeners with a sanitised payload (opaque ids and counts only).

## Deletion sequencing blockers

1. Do not remove web upload, manifest, sync, epoch/share-link, or crypto-worker TypeScript until Band 2/3 Rust WASM APIs are merged and wired in this worktree.
2. Do not delete the legacy raw-key decrypt fallbacks until an old-data migration/compatibility decision is recorded.
3. Do not shrink `db.worker.ts` crypto until the web encrypted-cache/storage strategy is decided; it is not covered by Android upload APIs.
4. Keep UI/Comlink/API adapters thin but present. Cleanup should move primitive ownership out of these files, not remove user-facing orchestration.
