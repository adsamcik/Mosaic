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

