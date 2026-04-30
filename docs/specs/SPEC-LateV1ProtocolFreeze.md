# SPEC: Late-v1 Protocol Freeze Readiness

## Status

**Late-v1 freeze gate: DECLARED on 2026-04-30.** The freeze candidates listed
under §"Freeze candidates when the gate is declared" are now **frozen**
alongside §"Frozen now". Lock tests pin every byte-format constant, FFI API
snapshot, and stable error code (see docs/RELEASE.md → "Late-v1 Protocol
Freeze" → "Lock tests"). The list under §"Explicitly open until Bands 5/6 and
Android upload finish" remains explicitly open and is the only surface that
may evolve before v1.x.

This document was prepared for Band 7 / Phase G (`late-v1 protocol freeze`).
It is a current-main inventory and freeze-gate specification, not a
reimplementation and not a dependency on unmerged Bands 5/6 or Android upload
work.

The freeze gate is intentionally dependency-safe:

- surfaces previously listed as **freeze candidates** are now **frozen** as of
  the 2026-04-30 declaration;
- surfaces listed as **explicitly open** remain changeable until Bands 5/6 and
  Android upload finish and their final shapes are re-inventoried;
- zero-knowledge invariants are already frozen and non-negotiable.

Full all-tests, Playwright, and broad cross-platform validation remain reserved
for Band 8. This spec defines the gates Band 8 must enforce.

## Goals

1. Inventory externally relevant API/protocol surfaces that current clients can
   observe or persist.
2. Define what is frozen, what is a freeze candidate, and what is explicitly
   open while parallel bands land.
3. Define versioning and release-blocker rules for backend API JSON, opaque blob
   formats, Rust FFI DTOs, Android foundation contracts, web WASM adapter
   boundary, and test vectors.
4. Preserve Mosaic's zero-knowledge contract: the server never receives
   plaintext photos, metadata, filenames, captions, device metadata, or keys.

## Non-goals

- No backend, Rust, web, or Android implementation changes.
- No declaration that open Bands 5/6/Android upload surfaces are stable.
- No `docs/FEATURES.md` entry; this is release engineering documentation, not a
  user-facing feature.
- No full test matrix or Playwright run in this lane.

## Current protocol/API surfaces and owners

| Domain | Owner | Current surface on main | Freeze status |
| --- | --- | --- | --- |
| Backend auth/session API | Backend auth/API owner | `GET /api/auth/config`, `POST /api/auth/init`, `POST /api/auth/verify`, `POST /api/auth/register`, `POST /api/auth/logout`, session list/revoke endpoints; LocalAuth cookie `mosaic_session`; ProxyAuth `Remote-User` from trusted proxies. | Freeze candidate after auth-response JSON and cookie/header names are reviewed. |
| Backend album API JSON | Backend album/API owner | `GET/POST /api/albums`, `GET/DELETE /api/albums/{albumId}`, `PATCH /expiration`, `/name`, `/description`, `GET /sync`; server-visible fields are opaque IDs, encrypted name/description, epoch/version, expiration, role. | Freeze candidate except album story/content evolution noted below. |
| Backend album content JSON | Backend album-content owner | `GET/PUT /api/albums/{albumId}/content`; encrypted content bytes, 24-byte nonce, epoch ID, optimistic version. | Explicitly open for final story-block document schema and Band 5/6 content work. |
| Backend photo/manifest API JSON | Backend manifest/API owner | `POST /api/manifests`, `PATCH /api/manifests/{manifestId}/metadata`, `GET/DELETE /api/manifests/{manifestId}`; current create accepts `encryptedMeta`, `signature`, `signerPubkey`, legacy `shardIds`, optional `tier`, and newer `tieredShards`; responses expose IDs/version and manifest reads expose encrypted opaque metadata plus shard links. | Explicitly open until Android upload and manifest canonical transcript cutover finish; legacy and tiered fields must not be removed without compatibility gates. |
| Backend Tus/shard transport | Backend upload/storage owner | Tus endpoint `POST/PATCH/HEAD/DELETE /api/files`; Tus metadata currently includes `albumId` and optional `sha256`; completed uploads become pending opaque shards; `GET /api/shards/{shardId}` streams encrypted bytes with `X-Content-SHA256`; `/meta` exposes server-visible size/status/hash. | Freeze candidate for transport semantics; open for Android upload metadata names only if final Android upload proves a needed additive field. |
| Rust opaque blob formats | Rust domain/protocol owner | `PROTOCOL_VERSION = "mosaic-v1"`; shard envelope magic `SGzk`, version `0x03`, 64-byte header, 24-byte nonce, tier `1/2/3`, reserved bytes zero; manifest transcript context `Mosaic_Manifest_v1`, version `1`; metadata sidecar context `Mosaic_Metadata_v1`, version `1`. | Frozen once late-v1 gate is declared; any byte-layout change requires a new version and vectors. |
| Rust client-core and stable error codes | Rust client-core owner | `ClientErrorCode` numeric codes; account, identity, epoch handle APIs; encrypted shard results; upload/sync state-machine snapshots/events/effects; schema version `1`. | Freeze candidate for numeric codes and non-secret DTO names; upload/sync DTOs remain open until Bands 5/6 complete final reducer semantics. |
| Rust WASM facade DTOs | Web/Rust boundary owner | `mosaic-wasm` exports header parsing, progress, account/identity/epoch handles, shard encrypt/decrypt, metadata helpers, golden-vector snapshots, client-core upload/sync init/advance, and JS classes with camelCase getters. | Freeze candidate after generated binding snapshot is regenerated from final Rust facade. |
| Rust UniFFI DTOs | Android/Rust boundary owner | `mosaic-uniffi` records mirror public/non-secret Rust results, stable codes, account/identity/epoch handles, media inspection/planning, metadata encryption, and client-core upload/sync DTOs. | Freeze candidate; Android upload final handoff may require additive fields before freeze. |
| Web WASM adapter boundary | Web platform owner | `WebClientCoreAdapter` with id `web-current-upload-sync`, runtime `typescript-web-shell`, upload adapter over current upload queue, sync adapter over current sync engine, and privacy-safe unsupported-adapter errors. Rust crypto currently reaches web through `rust-crypto-core.ts` and the existing Comlink worker. | Adapter id/default behavior is freeze candidate; Rust client-core upload/sync adapter remains open until Rust DTOs stabilize. |
| Android foundation contracts | Android platform owner | JVM-only shell under `apps/android-shell`: separate server auth vs crypto unlock states, opaque `AccountKeyHandle`, generated Rust account/media bridge seams, Photo Picker immediate-read/staging, privacy-safe queue records, manual upload handoff DTO, foreground `dataSync` work policy. | Freeze candidate for privacy rules and stable code mapping; real Android app/Room/WorkManager/Tus upload wiring remains open. |
| Golden/test vectors | Protocol verification owner | `tests/vectors` schema and README plus Rust golden vector tests for envelope header, manifest transcript, identity public vector, and WASM/UniFFI snapshots. | Frozen at the fixture schema level after late-v1 declaration; new protocol versions require additive vector files and runner parity. |

## Frozen now vs explicitly open

### Frozen now

These constraints are already release-blocking:

1. **Zero-knowledge server boundary.** Backend stores and coordinates opaque
   encrypted payloads only. It may validate access-control and transport metadata
   but must not parse plaintext media or encrypted metadata internals.
2. **No plaintext import inbox.** Generic WebDAV/SFTP/SMB/S3/plain Tus import
   paths are rejected unless they embed Mosaic client-core encryption and
   manifest logic before bytes reach the backend.
3. **No raw secret FFI outputs by default.** Passwords may enter Rust only as
   bootstrap inputs and must be wiped. L0/L1/L2 keys, epoch seeds, tier keys, and
   signing seeds must not cross WASM/UniFFI as normal outputs.
4. **Shard envelope compatibility budget.** Current clients depend on the 64-byte
   `SGzk`/`0x03` header, exact AAD bytes, 24-byte nonce, tier byte, and zero
   reserved bytes. Changing this after freeze requires a new envelope version.
5. **Leakage budget.** Server-visible fields are limited to authenticated user
   and membership IDs, opaque album/photo/manifest/shard IDs, upload offsets,
   byte counts, quota/status/timestamps, encrypted bytes and lengths, signatures,
   public signing keys, encrypted-blob hashes, roles, sharing metadata, and
   explicit expiration deadlines.

### Freeze candidates when the gate is declared

- Backend auth/album/shard route families and current opaque JSON field classes.
- Tus transport behavior for encrypted shard upload/resume/delete and `albumId`
  plus `sha256` metadata.
- Rust domain constants (`mosaic-v1`, envelope v3, manifest transcript v1,
  metadata sidecar v1) and stable error code numeric meanings.
- Existing WASM/UniFFI record names, public fields, stable error codes, and
  handle-based secret boundary.
- Web adapter default id and privacy-safe selector behavior.
- Android foundation privacy contracts and stable Rust-code mappings.
- Golden-vector schema semantics and required leakage classification fields.

### Explicitly open until Bands 5/6 and Android upload finish

1. **Manifest finalization shape.** Current backend accepts both legacy `shardIds`
   and newer `tieredShards`; Rust canonical transcript work is stricter than the
   live web manifest path. The final late-v1 manifest create/read shape remains
   open until Android upload proves the exact tier/hash/version fields.
2. **Rust upload/sync state-machine DTO semantics.** Snapshot/event/effect names
   exist today, but retry, manifest-unknown recovery, sync confirmation, and
   platform side-effect mapping remain open while Bands 5/6 land.
3. **Web Rust client-core adapter cutover.** The default web adapter intentionally
   delegates to TypeScript upload/sync. Adding a Rust upload/sync adapter remains
   open until generated WASM bindings and web platform ports stabilize.
4. **Android real upload wiring.** The JVM shell has privacy-safe contracts only.
   Real Android app/Gradle module, Room persistence, generated UniFFI Kotlin,
   WorkManager, Tus transport, and manifest commit integration remain open.
5. **Media codec/tier generation adapter.** Dependency-free layout/planning exists;
   real JPEG/WebP/AVIF/HEIC codec choices and deterministic stripping tests remain
   open before Android upload consumes the adapter.
6. **Album story/content document shape.** `album content` API currently stores one
   encrypted opaque document with nonce/version. The internal encrypted block
   schema and any server-visible concurrency fields remain open for Band 5/6
   story/content work.
7. **Web encrypted local cache strategy.** `db.worker.ts` still owns OPFS snapshot
   encryption via TypeScript compatibility code; this is not resolved by Android
   upload and remains open until a separate storage decision.

## Versioning and freeze gate rules

### Backend API JSON

- Route path, HTTP method, auth requirement, status-code class, required field,
  field name casing, enum numeric/string value, byte/base64 encoding, cookie name,
  header name, and Tus metadata key changes are contract changes.
- Additive optional fields are allowed before freeze only when old clients can
  ignore them and tests prove the server does not echo plaintext sentinels.
- After freeze, any breaking JSON change must introduce one of:
  - a new route/version namespace;
  - an additive field with old-field compatibility retained for one migration
    window;
  - a documented protocol version bump with vector and client updates in the same
    release train.
- Backend API JSON must continue to describe encrypted blobs as opaque bytes or
  base64 strings. New plaintext-looking fields such as filename, caption, EXIF,
  GPS, MIME, image dimensions, thumbnail bytes, or raw content URI are blocked
  unless an ADR changes the leakage budget.

### Opaque blob formats

- Shard envelope magic, version, field offsets, nonce length, tier values,
  reserved-byte policy, AAD rule, and encryption algorithm are byte-level frozen
  at the late-v1 gate.
- Manifest transcript and metadata sidecar contexts/versions are byte-level
  frozen at the late-v1 gate. Field order, integer widths, sort order, and length
  encodings are part of the contract.
- Any byte-format change after freeze requires a new explicit version byte or
  context label, new positive and negative vectors, dual-reader compatibility or
  migration plan, and proof that old clients fail safely.

### Rust FFI DTOs

- Stable numeric error codes are append-only after freeze. Existing numeric values
  must not be reused or reinterpreted.
- WASM/UniFFI record/class field names, types, handle semantics, and public
  function names are contract shapes. Additive fields require wrapper tests on
  native Rust, WASM, and UniFFI.
- Raw-secret outputs are forbidden. Adding one is a release blocker pending ADR,
  threat-model update, memory-wipe proof, and cross-wrapper regression tests.
- FFI snapshots must avoid caller-provided plaintext in `Debug`, error strings,
  and generated wrapper diagnostics.

### Android foundation contracts

- `ShellSessionState` separation of server auth and crypto unlock is frozen.
  Upload eligibility continues to require both.
- `AccountKeyHandle` and generated Rust bridge stable code mappings are
  compatibility surfaces; code changes after freeze require aligned Rust and
  Kotlin tests.
- Queue and handoff DTOs may persist only opaque IDs, staged app-private
  references, byte counts, timestamps, retry counts, status, and encrypted shard
  references. Raw Photo Picker URIs, filenames, captions, EXIF/GPS/device
  metadata, decrypted metadata, or keys are forbidden.
- Android app-module additions after freeze must include manifest/static tests for
  no broad storage permission, non-exported defaults, user-visible foreground
  `dataSync` work, and no plaintext queue persistence.

### Web WASM adapter boundary

- The default adapter id `web-current-upload-sync` and generic unsupported-adapter
  error are freeze candidates. Selector errors must not echo caller-supplied ids.
- Generated Rust WASM imports stay behind `rust-crypto-core.ts` or a successor
  single facade. React components and platform services must not import generated
  WASM or crypto primitives directly.
- A future Rust upload/sync adapter must be additive until the current TypeScript
  adapter has migration tests, rollback plan, and vector parity.

### Test vectors

- `tests/vectors` fixture schema semantics are the versioned cross-client truth
  for byte-level behavior.
- Every frozen protocol operation needs native Rust coverage and wrapper coverage
  for WASM and UniFFI; Android JVM/instrumentation and temporary TypeScript
  runners are required where the surface is active.
- Vectors must classify every server-bound output and include forbidden server
  output assertions for plaintext media, metadata, filenames, keys, and logs.
- Updating an expected vector after freeze is a protocol change unless the change
  fixes a test bug without changing produced bytes; the commit must say which.

## Zero-knowledge invariants

These are non-negotiable before and after freeze:

- Server never receives plaintext photos, thumbnails, previews, originals,
  metadata, captions, filenames, EXIF/IPTC/XMP/GPS/device metadata, passwords,
  account keys, identity seeds, epoch seeds, tier keys, signing seeds, link
  secrets, or raw Photo Picker/content URIs.
- Server-side logs, errors, status responses, OpenAPI examples, and test fixtures
  must not expose plaintext sentinels or secrets.
- Backend storage and cleanup operate on opaque encrypted blobs and lifecycle
  metadata only.
- Clients generate nonces with production randomness and never reuse a nonce with
  the same key.
- FFI boundaries use Rust-owned opaque handles for secret material. Password bytes
  are bootstrap inputs only and are wiped by caller and callee where possible.
- Manifest and shard integrity are verified over encrypted bytes and public
  metadata; plaintext validation remains client-side.

## Release-blocker criteria after the freeze gate

A change is a release blocker if it does any of the following without an approved
versioning plan, vectors, and compatibility tests in the same release train:

1. Changes an API route, method, required request field, response field, enum
   value, cookie/header name, Tus metadata key, or status-code semantics used by
   current clients.
2. Removes legacy manifest fields before all active clients have migrated to the
   replacement shape.
3. Changes shard envelope bytes, manifest transcript bytes, metadata sidecar
   bytes, domain labels, protocol version strings, or canonical sort/encoding
   rules.
4. Reuses or reinterprets a stable Rust/WASM/UniFFI error code.
5. Adds an FFI record field or Kotlin DTO field that can carry plaintext media,
   metadata, raw secrets, raw URIs, or caller-provided diagnostic text.
6. Introduces a backend field, log, validation path, or import endpoint that
   encourages plaintext upload or server-side media processing.
7. Updates golden-vector expected outputs without a protocol-version bump or a
   documented test-bug rationale.
8. Wires web or Android production upload/sync through a new adapter without
   wrapper parity tests and rollback-safe migration behavior.
9. Weakens auth/session separation from crypto unlock or allows upload queueing
   without both server authentication and crypto unlock on clients that need local
   encryption.

## Verification plan

Focused Band 7 validation for this spec:

- `cargo test -p mosaic-domain --test late_v1_protocol_freeze_spec --locked`
- `git --no-pager diff --check`

Band 8 full validation must additionally run the backend, Rust, web, Android,
vector, and E2E gates appropriate to the final frozen surfaces.
