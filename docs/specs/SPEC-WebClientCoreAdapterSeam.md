# SPEC: Web Client-Core Adapter Seam

## Status

Locked at v1. Adapter seam implemented in `aca0695` (`feat(web): add
client-core adapter seam`) at `apps/web/src/lib/client-core-adapter.ts`,
with the cleanup-debt inventory captured in `a08ab14` (`docs(web): inventory
crypto cleanup debt`). The seam selects the existing TypeScript web upload
queue and sync engine by default; the subsequent Rust handle cutover landed
under `SPEC-WebRustCryptoCutover.md` (Slices 1–8).

## Scope

This slice prepares the web shell for later Rust `mosaic-client` upload/sync
state-machine integration without depending on Band 2 API names or changing
current runtime behavior.

Included:

- a TypeScript adapter boundary in `apps/web/src/lib/client-core-adapter.ts`;
- default selection of the existing TypeScript web upload queue and sync engine;
- focused tests proving default selection and privacy-safe unsupported-adapter
  errors.

Excluded:

- calls into unmerged Rust upload/sync state-machine APIs;
- changes to upload handler, manifest, sync engine, or UI behavior;
- Rust WASM package or generated binding changes;
- broad E2E or full all-tests validation.

## Current Boundary Scout

| Boundary | Current Web Location | Band 4 Decision |
| --- | --- | --- |
| Rust crypto facade | `apps/web/src/workers/rust-crypto-core.ts` | Already isolated for pure crypto/WASM helpers; do not expand for upload/sync state machines until Band 2 exports are stable. |
| Crypto worker/client | `apps/web/src/workers/crypto.worker.ts`, `apps/web/src/lib/crypto-client.ts` | Preserve existing Comlink worker behavior. Upload/sync orchestration must not bypass this facade for keys. |
| Upload queue | `apps/web/src/lib/upload/upload-queue.ts` and `apps/web/src/lib/upload-queue.ts` | Wrap current singleton through `WebUploadAdapter`; no routing changes yet. |
| Upload handlers | `apps/web/src/lib/upload/*-upload-handler.ts` | Unsafe to alter before Band 2 defines state-machine effects and Band 3 confirms Android manual upload mapping. |
| Manifest finalization | `apps/web/src/lib/manifest-service.ts` | Remains current implementation; manifest commit recovery semantics are blocked on Band 2. |
| Sync engine/coordinator | `apps/web/src/lib/sync-engine.ts`, `apps/web/src/lib/sync-coordinator.tsx` | Wrap current singleton through `WebSyncAdapter`; preserve queueing, abort, and `sync-complete` semantics. |
| Stores/hooks/contexts | `apps/web/src/stores/photo-store.ts`, `apps/web/src/contexts/UploadContext.tsx`, `apps/web/src/contexts/SyncContext.tsx` | No behavior changes. These can be migrated to the adapter after Rust DTOs stabilize. |

## Adapter Contract

The web shell owns platform effects and exposes a narrow adapter object:

```text
WebClientCoreAdapter
  id: "web-current-upload-sync"
  runtime: "typescript-web-shell"
  upload: WebUploadAdapter
  sync: WebSyncAdapter
```

`WebUploadAdapter` delegates to the current upload queue for:

- initialization;
- adding, cancelling, retrying, and clearing tasks;
- pending/failed task queries;
- progress, complete, and error callback registration.

`WebSyncAdapter` delegates to the current sync engine for:

- per-album sync;
- cancellation and cache clearing;
- cached epoch key accessors;
- `sync-complete` event listener registration.

The only supported selector value in this slice is
`web-current-upload-sync`. Unsupported selections throw a generic error that
does not echo the requested adapter id, because adapter ids may originate from
configuration and must not become a plaintext exfiltration channel.

## Zero-Knowledge Invariants

- The adapter stores no keys, plaintext media, plaintext metadata, passwords, or
  file contents.
- The default adapter only references existing browser-side singletons.
- Unsupported-adapter errors do not include caller-supplied strings.
- The adapter does not log selection, callback registration, keys, media, or
  metadata.
- Backend behavior is unchanged: upload/sync code still sends only encrypted
  blobs and encrypted metadata through existing services.

## Data Flow

Current default path:

```text
UploadContext / SyncContext / upload-store-bridge
  -> existing uploadQueue / syncEngine imports
  -> existing crypto worker, manifest, DB, and API services
```

Prepared adapter path:

```text
future web shell caller
  -> getWebClientCoreAdapter()
  -> WebUploadAdapter / WebSyncAdapter
  -> current TypeScript uploadQueue / syncEngine
```

Later Rust cutover path, after Band 2/3 unblock it:

```text
future web shell caller
  -> selectWebClientCoreAdapter("rust-client-core")
  -> Rust WASM client-core adapter
  -> web platform ports for media, transport, local store, logging, and timers
```

## Explicit Blockers Waiting on Bands 2/3

1. Band 2 must publish stable Rust upload/sync state-machine DTOs, effect names,
   event names, snapshot schemas, and WASM export names.
2. Band 2 must prove snapshots contain no raw keys, plaintext media, plaintext
   metadata, passwords, or raw file/blob URLs.
3. Band 2 must define manifest commit-unknown recovery and sync confirmation
   semantics so web does not diverge from Android.
4. Band 3 must finish Android manual upload prep mapping enough to align shared
   adapter terminology and effect boundaries.
5. Golden vectors must cover upload/sync reducer transitions and privacy-safe
   serialization before web routes production upload/sync orchestration to Rust.
6. The web generated WASM package must expose the client-core state-machine API
   behind a single facade before `UploadContext`, `SyncContext`, or upload
   handlers are switched over.

## Verification Plan

- `cd apps/web; npm run test:run -- tests/client-core-adapter.test.ts`
- `cd apps/web; npm run typecheck`

Full Playwright and all-tests matrix remain reserved for Band 8.
