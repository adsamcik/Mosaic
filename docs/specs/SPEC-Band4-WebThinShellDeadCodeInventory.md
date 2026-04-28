# Band 4 Web Thin-Shell Dead-Code Inventory

## Scope

Audit date: 2026-04-28.

Worktree: `G:\Github\.worktrees\mosaic-band4-dead-code-audit`.
Base: `642caaa test(e2e): stabilize gallery media interactions`.

This Band 4 / Phase D slice scouts TypeScript crypto, protocol, and
client-core surfaces in `apps/web`, `libs/crypto`, `libs/crypto-ts-reference`
if present, generated WASM bindings, and related tests. Because Band 2
client-core state machines and Band 3 Android upload interop are active in
separate worktrees, this inventory is intentionally dependency-safe: it does
not delete or rewire production upload, sync, login, or sharing behavior.

## Usage searches performed

The audit used repository-wide and scoped searches before classifying any
surface:

| Search | Result |
| --- | --- |
| `Get-ChildItem .\libs` | Only `libs\crypto` exists. `libs\crypto-ts-reference` is absent in this worktree. |
| `apps\web\src` for `@mosaic/crypto` imports | Production importers are `components/Shared/SharedGallery.tsx`, `hooks/useAlbums.ts`, `hooks/useLinkKeys.ts`, `hooks/useShareLinks.ts`, `lib/api-types.ts`, `lib/epoch-key-store.ts`, `lib/epoch-rotation-service.ts`, `lib/error-messages.ts`, `lib/sync-engine.ts`, `lib/thumbnail-generator.ts`, `lib/upload/tiered-upload-handler.ts`, `lib/upload/video-upload-handler.ts`, `workers/crypto.worker.ts`, `workers/db.worker.ts`, and `workers/types.ts`. |
| `apps\web\src` for generated WASM and `rust-crypto-core` imports | Generated `mosaic-wasm` is imported only by `workers/rust-crypto-core.ts`; the Rust facade is imported only by `workers/crypto.worker.ts`. |
| `apps\web\src` for `libsodium-wrappers-sumo` imports | Direct libsodium production imports are confined to `workers/crypto.worker.ts` and `workers/db.worker.ts`. |
| Repository search for `generateTieredShards` | References are `apps\web\src\lib\thumbnail-generator.ts`, `apps\web\tests\thumbnail-generator.test.ts`, `docs\analysis\C2PA-WATERMARKING-FEASIBILITY.md`, and the prior cutover inventory. No production caller outside the defining module was found. |
| `apps\web`, `tests`, and `libs\crypto\tests` for `@mosaic/crypto/mock` or direct `libs/crypto/src/mock` imports | No app or test import of the mock package was found. `libs\crypto\src\mock.ts` remains a package subpath export and is excluded from crypto coverage/mutation configs. |
| `apps\web\src` for worker API calls such as `getCryptoClient`, `encryptShard`, `decryptShard`, `signManifest`, `verifyManifest`, `deriveTierKeys`, `openEpoch`, and upload/sync entry points | Login/session, album creation, member sharing, upload, manifest, sync, thumbnail, and local storage flows still reach TypeScript compatibility crypto through the Comlink worker or direct package imports. |

## Safe-to-delete now

No production file, package export, generated binding, or test oracle is safe to
delete in this slice.

Two surfaces look tempting but are not safe for a dependency-safe Band 4 delete:

| Surface | Why not deleted now |
| --- | --- |
| `apps\web\src\lib\thumbnail-generator.ts` `generateTieredShards` | No production caller was found, but it is covered by `apps\web\tests\thumbnail-generator.test.ts` and documents the legacy three-tier encryption behavior used as a comparison oracle while upload/media interop is still moving. |
| `libs\crypto\src\mock.ts` / `@mosaic/crypto/mock` | No production web import was found, but it is still an explicit package subpath export for development/test harnesses. The audit added a guard so production web source cannot reattach to this reference-only mock. |

## Delete after Band 2 client-core state machines

Delete or shrink these only after Rust client-core state machines own upload and
sync orchestration and the web adapter maps current effects onto those machines:

| Surface | Current blocker |
| --- | --- |
| `apps\web\src\lib\upload\upload-queue.ts` and `apps\web\src\lib\upload\upload-persistence.ts` | Web still owns upload lifecycle, retry, persistence, and pending UI state. |
| `apps\web\src\lib\upload\legacy-upload-handler.ts` | Still calls the worker `encryptShard` compatibility path for non-tiered upload behavior. |
| `apps\web\src\lib\upload\tiered-upload-handler.ts` | Still dynamically imports `deriveTierKeys` from `@mosaic/crypto` for tiered upload planning. |
| `apps\web\src\lib\upload\video-upload-handler.ts` | Still dynamically imports `deriveTierKeys`, `encryptShard`, and `ShardTier` from `@mosaic/crypto` for video shards. |
| `apps\web\src\lib\manifest-service.ts` | Manifest creation is still coordinated by TypeScript web code rather than a Rust state-machine effect boundary. |
| `apps\web\src\lib\sync-engine.ts` | Sync still derives tier keys and applies pages in TypeScript while using Rust only for the manifest verification subset. |
| `apps\web\src\workers\crypto.worker.ts` raw-key shard, epoch, manifest-signing, account, auth, share-link, and content helpers | The worker remains the compatibility facade for raw epoch/account/identity key callers until state-machine handles replace those call sites. |
| `apps\web\src\workers\types.ts` `EncryptedShard` re-export from `@mosaic/crypto` | Worker API typing still reflects TypeScript envelope types used by legacy upload/sync flows. |

## Delete after Band 3 Android/web interop

Delete these only after Android manual upload APIs and web upload paths prove
cross-client encrypted media, manifest, sidecar, and share-link interoperability:

| Surface | Current blocker |
| --- | --- |
| `libs\crypto\src\envelope.ts`, `epochs.ts`, `identity.ts`, `keychain.ts`, `keybox.ts`, `signer.ts`, `sharing.ts`, `link-sharing.ts`, `auth.ts`, and `content.ts` | These remain the TypeScript reference/rollback implementation for protocol parity until Rust/WASM and Android interop are green. |
| `libs\crypto\tests\**` | Tests remain the TypeScript oracle for nonce/header/signature/key-wrapping invariants while Rust vectors and Android consumers converge. |
| `apps\web\src\lib\thumbnail-generator.ts` tier encryption helpers | Image tier byte generation and encryption are still useful as web-side parity references until Android media adapters and Rust metadata sidecar helpers settle. |
| Direct web `@mosaic/crypto` imports for share links and tier keys | `useLinkKeys.ts`, `useShareLinks.ts`, and `epoch-rotation-service.ts` still exercise the existing web share-link protocol until Android/web link compatibility is proven. |

## Keep as platform adapters

These are not dead code; they are platform shell/adaptation seams that should
survive the Rust cutover, though their internals may thin out:

| Surface | Keep rationale |
| --- | --- |
| `apps\web\src\lib\crypto-client.ts` | Web Comlink singleton and worker lifecycle boundary. |
| `apps\web\src\workers\crypto.worker.ts` | Required web worker facade; it should become thinner but remain the browser isolation boundary for crypto calls. |
| `apps\web\src\workers\rust-crypto-core.ts` | Browser-specific Rust WASM initializer and generated-binding adapter. |
| `apps\web\src\generated\mosaic-wasm\*` | Generated Rust WASM artifacts consumed by the web adapter; regenerate from Rust, do not hand-delete. |
| `apps\web\src\workers\db.worker.ts`, `apps\web\src\lib\db-client.ts` | Browser OPFS/SQLite worker adapter; local database encryption is platform storage behavior, not server-visible protocol logic. |
| `apps\web\src\lib\key-cache.ts` and `apps\web\src\lib\link-tier-key-store.ts` | Browser-local cache/storage adapters. Deleting them requires a separate storage design, not a crypto cutover cleanup. |
| `apps\web\src\lib\api-types.ts` `AccessTier` compatibility import | Keep until API/shared-type generation replaces the enum dependency. |

## Keep as test or reference oracle

| Surface | Oracle role |
| --- | --- |
| `libs\crypto\src\**` | TypeScript protocol reference and rollback source while Rust/WASM and Android interop work is incomplete. |
| `libs\crypto\tests\**` | Reference oracle for envelope layout, signatures, key wrapping, auth derivation, sharing, and memory-safety invariants. |
| `apps\web\src\workers\__tests__\rust-crypto-core.test.ts` | Verifies the Rust facade boundary and legacy transcript/header adaptation. |
| `apps\web\tests\rust-cutover-boundary.test.ts` | Guards the web thin-shell boundary by keeping generated WASM behind the Rust facade and keeping unclassified `@mosaic/crypto` imports from appearing in production source. |
| `apps\web\tests\thumbnail-generator.test.ts` | Captures legacy tiered-image encryption behavior, including `generateTieredShards`, until the replacement upload/media path has equivalent coverage. |

## Guardrail added in this slice

`apps\web\tests\rust-cutover-boundary.test.ts` now also asserts that production
web source does not import `@mosaic/crypto/mock` or direct `libs/crypto/src/mock`
paths. This keeps the reference-only mock from being accidentally reattached to
login, upload, sync, or sharing flows while still allowing the package export to
exist for non-production harnesses until a later cleanup can remove it safely.

## Remaining blockers

1. Band 2 must land the Rust client-core upload and sync state machines plus web
   adapter mapping before TypeScript upload/sync orchestration can be deleted.
2. Band 3 must land Android/web encrypted upload interoperability before the
   TypeScript protocol implementation can stop serving as a reference/rollback
   oracle.
3. Rust/WASM must own account unlock, auth challenge signing, epoch handles,
   shard encrypt/decrypt, manifest signing, metadata sidecar encryption, and
   share-link/tier-key compatibility before production `@mosaic/crypto` imports
   can be removed mechanically.
4. Package-level removal of `@mosaic/crypto/mock` needs a separate consumer check
   because it is an exported subpath even though production web does not import
   it today.
