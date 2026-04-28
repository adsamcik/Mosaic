# Web Rust Crypto Cutover

## Problem

The web app currently routes security-critical Mosaic protocol operations through `apps/web/src/workers/crypto.worker.ts`, but that worker is implemented with TypeScript helpers from `libs/crypto` and direct `libsodium-wrappers-sumo` calls. Android and future client-core work require Rust to be the canonical implementation for crypto/protocol behavior while preserving the existing React UI and worker boundary.

This cutover replaces the website-facing crypto core behind the existing Comlink `CryptoWorkerApi` seam with Rust WASM operations wherever the Rust core owns the operation today. TypeScript fallback/reference code may remain only for operations whose Rust client-core state-machine support is not yet available, and those fallbacks must be explicit and tested.

## Data flow

### Account unlock and session bootstrap

```text
React/session.ts
  -> crypto-client.ts
  -> crypto.worker.ts
  -> mosaic-wasm unlockAccountKey/createIdentityHandle/createEpochKeyHandle/openEpochKeyHandle
```

Inputs crossing from web shell to worker:

```ts
{
  password: string | Uint8Array,
  userSalt: Uint8Array,
  accountSalt: Uint8Array,
  wrappedAccountKey?: Uint8Array
}
```

Worker-owned Rust state:

```ts
{
  accountHandle: bigint | number,
  identityHandle?: bigint | number,
  epochHandlesBySeedOrBundle: Map<string, bigint | number>
}
```

Outputs crossing back to the web shell:

```ts
{
  wrappedAccountKey?: Uint8Array,
  sessionKey: Uint8Array,
  publicIdentityKeys: Uint8Array,
  wrappedIdentitySeed?: Uint8Array,
  wrappedEpochSeed?: Uint8Array
}
```

Raw account keys, identity seeds, epoch seeds, tier keys, and signing secrets must not be introduced as new web-visible outputs. Existing raw-key outputs remain compatibility debt until the Rust client-core state machines replace those APIs.

### Shard encryption/decryption

```text
upload/sync/photo service
  -> CryptoWorkerApi.encryptShard/decryptShard/peekHeader/verifyShard
  -> Rust WASM epoch handle operations where an epoch handle is available
  -> temporary TypeScript compatibility fallback only for legacy raw epoch-seed callers
```

Rust-owned success shape:

```ts
{
  ciphertext: Uint8Array, // complete Mosaic shard envelope bytes
  sha256: string          // base64url SHA-256 of envelope bytes
}
```

### Manifest signing and verification

```text
manifest-service/sync-engine
  -> CryptoWorkerApi.signManifest/verifyManifest
  -> Rust WASM signManifestWithIdentity/verifyManifestWithIdentity
```

The manifest byte array must already be the canonical transcript bytes. Rust verifies:

```ts
{
  transcriptBytes: Uint8Array,
  signature: Uint8Array,        // 64 bytes
  signingPublicKey: Uint8Array  // 32 bytes
}
```

### Metadata sidecars

The web worker will use Rust WASM metadata helpers for canonical sidecar byte generation and encrypted sidecar envelopes once the web upload path supplies album/photo IDs and metadata fields. Plaintext sidecar bytes remain client-local only and must be encrypted before manifest binding or upload.

## Zero-knowledge invariants

- The backend receives only encrypted shard envelopes, encrypted metadata envelopes, signatures, wrapped keys, opaque IDs, and approved access-control metadata.
- Rust WASM owns nonce generation, shard envelope parsing, shard encrypt/decrypt, identity-backed manifest signing/verification, and canonical metadata sidecar byte construction.
- TypeScript/React components never import Rust crypto primitives directly; they call the crypto worker facade.
- No new API returns raw account keys, identity seeds, epoch tier keys, signing seeds, plaintext metadata sidecars, or plaintext media.
- Password bytes passed into Rust are zeroized in the WASM facade after account unlock attempts.
- Existing raw-key TypeScript compatibility paths are temporary rollback/reference paths and must stay isolated in the crypto worker until the Rust client-core upload/sync state machines remove their callers.

## Component tree

```text
apps/web/src/lib/crypto-client.ts
  Comlink singleton, unchanged public API

apps/web/src/workers/crypto.worker.ts
  Initializes Rust WASM
  Maintains Rust handle lifecycle
  Routes supported CryptoWorkerApi methods to Rust WASM
  Keeps explicit compatibility fallback for not-yet-migrated raw-key operations

crates/mosaic-wasm/src/lib.rs
  Adds missing web exports:
    - verifyManifestWithIdentity
    - canonicalMetadataSidecarBytes
    - encryptMetadataSidecarWithEpochHandle

crates/mosaic-wasm/tests/ffi_snapshot.rs
  Snapshot/parity tests for new WASM exports and stable error codes
```

## Verification plan

1. Add failing Rust tests for missing WASM exports:
   - valid identity manifest signature verifies through WASM;
   - tampered transcript/signature returns authentication failure;
   - invalid public key/signature lengths return stable validation codes;
   - canonical metadata sidecar bytes match `mosaic-domain`;
   - encrypted metadata sidecar uses epoch handles and decrypts as a thumbnail-tier envelope.
2. Implement the missing Rust WASM exports and update the WASM API snapshot.
3. Add/adjust web worker tests proving Rust WASM is initialized and called for supported operations.
4. Build Rust WASM and wire the web worker through the generated module.
5. Run:
   - `cargo test -p mosaic-wasm --test ffi_snapshot --locked`
   - `.\scripts\build-rust-wasm.ps1`
   - `cd apps/web ; npm run build`
   - `cd apps/web ; npm run test:run`
   - `.\scripts\run-e2e-tests.ps1`

## Audit snapshot: web Rust cutover state

Snapshot date: 2026-04-28. Source state: `agent/web-rust-audit` at `2b75e44`.

This snapshot classifies the current web crypto/client-core paths. It does not
authorize deletion of TypeScript crypto; it identifies which paths are canonical
Rust/WASM today, which paths are intentional rollback/reference code, and which
paths still block a web-thin-shell cleanup.

### 1. Canonical Rust/WASM path already used

| Path | Current role | Evidence |
|------|--------------|----------|
| `apps/web/src/generated/mosaic-wasm/*` | Generated Rust WASM binding artifact | Exports Rust account, identity, epoch, shard, manifest, metadata, and header functions. Web production currently consumes only the header-parse and manifest-verify subset through `rust-crypto-core.ts`. |
| `apps/web/src/workers/rust-crypto-core.ts` | Canonical web Rust facade | Imports generated WASM, initializes it once, builds legacy manifest transcripts, verifies manifest signatures with Rust, and parses 64-byte envelope headers with Rust. |
| `apps/web/src/workers/crypto.worker.ts` `peekHeader` / `verifyManifest` | Rust-backed worker API methods | `peekHeader` calls `parseEnvelopeHeaderFromRust`; `verifyManifest` calls `verifyLegacyManifestWithRust`. React code still reaches these through the existing Comlink worker seam. |
| `crates/mosaic-crypto/**` and `crates/mosaic-wasm/**` | Canonical Rust implementation and WASM facade | Rust tests cover envelope crypto, identity, epoch keys, manifest signing, auth challenge signing, and WASM FFI snapshots. |
| `apps/web/src/workers/__tests__/rust-crypto-core.test.ts` | Boundary unit coverage | Verifies legacy manifest transcript construction, Rust verifier delegation, input length rejection, header-only parsing, and result-object release. |

### 2. Intentional rollback/reference path

| Path | Current role | Evidence |
|------|--------------|----------|
| `libs/crypto/src/**` | TypeScript reference and rollback implementation | ADR-001 and ADR-003 keep TypeScript crypto as the temporary reference/rollback path until cross-client Rust upload/decrypt interoperability is proven. |
| `libs/crypto/tests/**` and `libs/crypto/stryker.config.json` | Reference oracle test suite | Maintains security-invariant, envelope, auth, keychain, sharing, and mutation-test coverage for the TypeScript reference while migration is active. |
| `libs/crypto/src/mock.ts` | Development/test mock implementation | No production web import was found. Keep only while tests or local harnesses need it. |

### 3. Still-production TypeScript path blocking web-thin-shell cleanup

| Path | Blocking behavior |
|------|-------------------|
| `apps/web/src/workers/crypto.worker.ts` | Most worker methods still use `@mosaic/crypto` or direct libsodium: account init/unlock, identity derivation, auth challenge signing, shard encryption/decryption, manifest encryption/signing, epoch bundle open/create, share-link wrapping, account-key wrapping, key export/import, and album content encryption. |
| `apps/web/src/lib/session.ts` | Session restore/login still derives and exports raw web-visible account/session/identity keys through the TypeScript worker and uses browser WebCrypto for user-salt encryption. |
| `apps/web/src/lib/local-auth.ts` | LocalAuth derives auth keys, signs challenges, initializes account keys, and registers public keys through the TypeScript worker path. |
| `apps/web/src/lib/epoch-key-service.ts` and `apps/web/src/lib/epoch-key-store.ts` | Epoch bundles are opened through the TypeScript worker and unwrapped seeds/signing keys remain cached in TypeScript memory, with explicit memzero on replacement/logout. |
| `apps/web/src/lib/manifest-service.ts` and `apps/web/src/lib/sync-engine.ts` | Upload manifests are encrypted/signed through TypeScript worker methods; sync verifies with Rust but still derives tier keys and decrypts metadata with TypeScript compatibility keys. |
| `apps/web/src/lib/thumbnail-generator.ts`, `apps/web/src/lib/upload/tiered-upload-handler.ts`, `apps/web/src/lib/upload/video-upload-handler.ts`, and `apps/web/src/lib/upload/legacy-upload-handler.ts` | Image/video/non-image upload encryption is still TypeScript. Tiered image/video paths import `@mosaic/crypto` directly for tier keys and shard encryption; legacy upload calls the worker TypeScript encryption method. |
| `apps/web/src/hooks/useLinkKeys.ts`, `apps/web/src/hooks/useShareLinks.ts`, and `apps/web/src/lib/epoch-rotation-service.ts` | Share-link ID/secret derivation, tier-key wrapping/unwrapping, and epoch-rotation link rewraps still use TypeScript crypto helpers. |
| `apps/web/src/workers/db.worker.ts`, `apps/web/src/lib/key-cache.ts`, and `apps/web/src/lib/link-tier-key-store.ts` | Local-only storage encryption remains web TypeScript/browser crypto. This is not server-visible plaintext, but it is still client crypto outside the Rust core. |

### 4. Dead code safe to remove later

| Path | Removal condition |
|------|-------------------|
| `apps/web/src/lib/thumbnail-generator.ts` `generateTieredShards` | No production caller was found; current references are tests and feasibility docs. Remove only with targeted test/doc updates or after replacing callers with the Rust-backed upload pipeline. |
| `libs/crypto/src/mock.ts` | No production web caller was found. Remove once no tests, examples, or local harnesses rely on the mock `CryptoLib`. |

### Boundary guard added by this audit

`apps/web/tests/rust-cutover-boundary.test.ts` scans `apps/web/src` and enforces:

- generated `mosaic-wasm` imports stay behind `workers/rust-crypto-core.ts`;
- the Rust crypto facade is imported only by `workers/crypto.worker.ts`;
- every production `@mosaic/crypto` import remains explicitly classified as
  compatibility debt.

The guard is intentionally asymmetric: removing TypeScript imports does not fail
the test, but adding a new unclassified TypeScript crypto import does.

### Recommended cutover order

1. Wire Rust WASM handle lifecycle in `crypto.worker.ts` for account unlock,
   identity handles, and epoch handles before changing upload/sync callers.
2. Move shard encryption/decryption and metadata sidecar encryption to the Rust
   handle APIs, then migrate tiered image/video/legacy upload paths through the
   worker instead of direct `@mosaic/crypto` imports.
3. Move manifest signing to Rust identity handles and keep Rust verification as
   the only verification path.
4. Move LocalAuth challenge signing and session key export/import semantics to
   Rust-backed opaque handles.
5. After web↔Android encrypted media interoperability is green, remove the
   TypeScript production crypto surfaces in a dedicated cleanup change while
   keeping vector/reference tests until Rust coverage fully replaces them.
