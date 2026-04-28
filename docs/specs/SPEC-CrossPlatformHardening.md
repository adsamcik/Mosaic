# SPEC: Cross-Platform Security Hardening Prep

## Status

Band 7 prep checklist and static-guard baseline for v1 release readiness.

This document is dependency-safe against current `main`. It does not require
unmerged Bands 5 or 6 work, and it intentionally avoids replacing the deeper
implementation specs that already own crypto, upload, Android-shell, and
Rust/WASM cutover details.

## Scope

Included:

- threat-focused release checklist for the web client, Android shell, Rust core,
  WASM/UniFFI boundaries, backend, and E2E/infrastructure;
- cross-platform secret, PII, and log redaction rules;
- release hardening cases for low memory, interrupted uploads, flaky networks,
  logout, revoked members, quota exhaustion, reset/recovery, and app upgrades;
- dependency/CVE, generated-binding, nonce, and FFI secret-handle review
  expectations;
- a narrow static guard for obvious direct logging and fixture-secret patterns in
  high-risk Android/Rust/web boundary files.

Excluded:

- broad Playwright, all-tests, or full release-matrix execution;
- implementation changes to upload, sync, crypto, generated bindings, Android
  Gradle app scaffolding, or backend API contracts;
- verification that depends on unmerged Bands 5 or 6.

## Existing Security Baseline Reviewed

This spec builds on, rather than duplicates, the existing baseline:

| Area | Existing source | Relevant coverage |
|------|-----------------|-------------------|
| Zero-knowledge model | `docs/SECURITY.md` | Server knowledge boundaries, key hierarchy, nonce uniqueness, reserved-byte validation, key wiping, shard integrity, session security. |
| Security audit model | `docs/SECURITY_AUDIT.md` | ZK invariants, threat model, implementation security, auth modes, audit checklist, known limitations. |
| Release flow | `docs/RELEASE.md` | Current release checklist and version/tag process. |
| Android shell | `docs/specs/SPEC-AndroidShellFoundation.md` | Server-auth vs crypto-unlock separation, raw picker URI staging boundary, DTO redaction, WorkManager policy expectations. |
| Android media bridge | `docs/specs/SPEC-AndroidMediaCoreBridge.md` | Client-side media inspection/tier planning, metadata sidecar encryption, no raw key exposure. |
| Rust handle flow | `docs/specs/SPEC-RustAccountUnlockIntegration.md`, `SPEC-RustIdentityHandles.md`, `SPEC-RustEpochHandleClientWiring.md` | Password zeroization, opaque handle lifecycle, public-only FFI results, account-close cascade, epoch-handle nonce ownership. |
| Web Rust cutover | `docs/specs/SPEC-WebRustCryptoCutover.md` | Rust-backed worker seam, temporary TypeScript compatibility debt, raw-key output blockers, existing web boundary guard. |
| Client-core recovery | `docs/specs/SPEC-ClientCoreStateMachines.md` | Retry, manifest-unknown recovery, persistence-safe snapshots, no raw handles/URIs/plaintext in snapshots. |
| Supply chain | `deny.toml`, `supply-chain/` | Rust advisory, license, registry, duplicate, and cargo-vet policy inputs. |
| Focused tests/guards | `apps/web/tests/rust-cutover-boundary.test.ts`, `apps/android-shell/src/test/kotlin/org/mosaic/android/foundation/AndroidShellFoundationTest.kt`, `tests/architecture/rust-boundaries.ps1` | Web crypto import classification, Android privacy DTO checks, Rust package dependency boundaries. |

## Threat Model Summary

### Assets

- L0/L1/L2 keys, account handles, identity seeds, epoch seeds, tier keys, signing
  secrets, auth signing secrets, link secrets, and session/database keys.
- Plaintext media, thumbnails/previews/originals, captions, EXIF/GPS/device
  metadata, filenames, sidecar bytes, manifests before encryption, and Photo
  Picker raw URIs.
- Encrypted shards, encrypted sidecars, wrapped keys, signatures, server auth
  state, quota state, upload state, and sync cursors.

### Trust boundaries

- Browser/Android UI to crypto worker or Rust/UniFFI/WASM bridge.
- Android Photo Picker grants to app-private staged media references.
- Rust secret registries to public FFI/WASM records.
- Client encrypted upload/sync state to backend opaque storage APIs.
- Reverse proxy auth headers to backend auth middleware.
- CI/generated artifacts to release binaries and binding packages.

### Primary attacker goals

- Exfiltrate secrets or plaintext through logs, error messages, test fixtures,
  generated bindings, debug formatting, persisted snapshots, or upload queues.
- Force nonce reuse or bypass Rust-owned nonce generation through retry/recovery
  bugs.
- Keep revoked-member or logged-out clients using stale keys/handles.
- Abuse interrupted uploads, flaky network, quota failures, resets, or upgrades
  to replay stale encrypted state, leak raw picker URIs, or wedge recovery.
- Introduce vulnerable dependencies or malicious generated binding changes late
  in release hardening.

## Secret, PII, and Log Redaction Rules

These rules apply to production code, tests, generated bindings, CI logs,
browser console output, Android logs, Rust logs, backend logs, crash reports, and
fixture names.

### Never log or serialize

- Passwords, passphrases, auth challenge signing secrets, L0/L1/L2 keys,
  account/session/database keys, identity seeds, epoch seeds, tier/content keys,
  share-link secrets, wrapped-key plaintext, secret handles that are not already
  intentionally opaque public IDs, or private key material.
- Plaintext media bytes, thumbnails, previews, originals, plaintext sidecars,
  decrypted metadata, captions, filenames, EXIF/GPS/device metadata, or raw
  Photo Picker/content/file URIs.
- Backend `Remote-User` values, session tokens, auth headers, raw upload IDs, or
  quota/admin request bodies when they may identify a user or storage contents.

### Allowed diagnostics

- Stable error codes, correlation IDs, request IDs, elapsed times, byte counts,
  shard/tier indices, protocol versions, boolean state, retry counts, and
  redacted object markers such as `<redacted>`, `<opaque>`, or `<none>`.
- Public keys, detached signatures, encrypted shard hashes, encrypted envelope
  header fields, and encrypted wrapped key bytes only when the owning spec marks
  them as public or server-visible.

### Required controls

- Web production code uses the centralized logger only; no `console.*` calls in
  high-risk crypto/storage/upload boundaries.
- Android production shell code uses no direct `android.util.Log`, `Log.*`,
  `Timber.*`, `println`, or raw DTO `toString` output containing sensitive
  values.
- Rust boundary crates use no `println!`, `eprintln!`, `dbg!`, `tracing::*`, or
  `log::*` in secret-bearing paths unless a reviewed redaction wrapper is added.
- Backend log scopes must include coarse identifiers only and must keep encrypted
  content opaque.
- Tests may use fixed passwords/seeds only inside test files and must not print
  them. Production fixture helpers must not embed dummy passwords, raw secrets,
  raw picker URIs, or plaintext metadata.

## Threat-Focused Release Checklist

### Web client

- [ ] Crypto worker remains the only React-facing crypto boundary; React
  components do not import `libsodium-wrappers-sumo`, generated WASM, or raw Rust
  crypto modules directly.
- [ ] `@mosaic/crypto` imports in production web code are still explicitly
  classified as compatibility debt and do not expand without review.
- [ ] Logout clears worker-held session/account/auth/identity keys and any Rust
  handles, then prevents stale promises from repopulating stores.
- [ ] OPFS/SQLite persistence contains encrypted data and persistence-safe
  snapshots only; no raw handles, raw picker URIs, plaintext media, plaintext
  metadata, or key material.
- [ ] Low-memory handling releases object URLs, WASM result objects, decoded
  image buffers, and thumbnail/preview buffers after use.
- [ ] Upload retry/resume never reuses a caller-supplied nonce; encryption either
  reuses already-persisted ciphertext or asks Rust/crypto worker to encrypt with
  a fresh internally generated nonce.
- [ ] Revoked-member handling rotates/fetches epoch state and fails closed when a
  local stale epoch key can no longer authorize new content.
- [ ] Quota errors leave queued encrypted state recoverable without logging file
  names, captions, raw URIs, or plaintext metadata.
- [ ] Reset/recovery flows clear key caches, link key stores, worker state, and
  sync cursors before accepting new credentials.
- [ ] App upgrade/migration paths reject unsupported snapshot/database versions
  without weakening encryption or silently dropping secure-delete/logout steps.

### Android shell

- [ ] Server authentication and crypto unlock remain separate state machines;
  upload queueing requires both.
- [ ] Photo Picker `content://` grants are read immediately into app-private
  staged references; raw picker/file URIs never enter durable queue records,
  Rust snapshots, logs, or backend requests.
- [ ] Kotlin password `ByteArray` inputs are wiped in `finally` after UniFFI
  calls; generated binding wrappers do not retain password buffers.
- [ ] DTO `toString` methods redact staged sources, handles, plan IDs, and
  request salts/wrapped keys.
- [ ] Future Android manifest checks assert no broad storage permissions,
  non-exported components by default, `allowBackup=false`, and reviewed
  foreground `dataSync` declarations.
- [ ] Low-memory cancellation wipes staged plaintext bytes and keeps only
  privacy-safe queue records.
- [ ] Interrupted upload/retry queues persist idempotent encrypted progress, not
  raw media paths or raw picker grants.
- [ ] Logout, account reset, revoked membership, and app upgrade close Rust
  handles and clear app-private temporary plaintext staging.

### Rust core

- [ ] `unsafe_code` remains forbidden across workspace crates.
- [ ] Secret-bearing types do not implement `Debug`, `Clone`, `Copy`, `Display`,
  serialization, or public raw-secret accessors.
- [ ] Password, L0/L1/L2, identity seed, epoch seed, signing seed, and tier-key
  buffers use `zeroize`/`Zeroizing` and are wiped on success and validation
  failure wherever ownership permits.
- [ ] Shard encryption owns nonce generation internally and uses fresh 24-byte
  XChaCha20 nonces; production APIs do not accept caller-supplied nonces.
- [ ] FFI-safe error results return stable codes and empty byte/string fields on
  failure.
- [ ] Client-core upload/sync snapshots remain persistence-safe: no raw handles,
  plaintext media, plaintext metadata, passwords, content/file URIs, or adapter
  private Tus tokens unless a later threat model approves them.
- [ ] Revocation, logout, reset, and account-close paths cascade-close linked
  identity and epoch handles before removing account-key state.

### WASM and UniFFI

- [ ] Generated binding diffs are reviewed as security-sensitive code, not as
  opaque generated noise.
- [ ] Secret inputs are passed as function parameters that can be wiped, not as
  debug/clone record fields.
- [ ] Records that carry client-local plaintext bytes on success, such as
  decrypted shard results, do not derive or generate debug formatting.
- [ ] WASM result objects that hold public parse results are released with
  `free()` after use; future secret-bearing WASM classes must provide explicit
  release/close paths.
- [ ] Binding snapshots prove stable function names, record fields, numeric error
  codes, and absence of raw secret outputs.
- [ ] Android and web generated artifacts are regenerated from the reviewed Rust
  source and compared against committed snapshots before release.

### Backend

- [ ] Backend remains opaque storage/API: no plaintext media or metadata parsing,
  thumbnailing, EXIF processing, key derivation, or decrypted manifest handling.
- [ ] Authentication middleware order keeps proxy/local auth and authorization
  gates before protected endpoints.
- [ ] Object ownership checks cover albums, members, epoch keys, manifests,
  shards, share links, quotas, and admin settings.
- [ ] Upload/quota errors return sanitized problem details and never log request
  bodies, auth tokens, `Remote-User`, raw upload payloads, filenames, or
  decrypted metadata.
- [ ] Interrupted Tus upload garbage collection cannot activate orphaned
  ciphertext or leak other users' storage usage.
- [ ] Revoked-member and quota/admin changes are auditable with coarse IDs and
  stable action names only.
- [ ] Rate limits, body-size limits, upload-size limits, and timeout limits are
  enabled for auth, upload creation, manifest creation, share links, and admin
  endpoints.

### E2E and infrastructure

- [ ] Release CI uses pinned GitHub Actions and locked package/dependency inputs.
- [ ] Docker images build from lock files, run as non-root where supported, and
  avoid embedding `.env`, test secrets, or generated dev-only fixtures.
- [ ] Reverse proxy deployment enforces TLS, secure headers, and trusted auth
  header stripping at the edge.
- [ ] E2E fixtures use synthetic media and test-only credentials only; traces,
  screenshots, videos, and logs do not contain real user media or raw secrets.
- [ ] Recovery drills cover backend restart, frontend reload, failed upload
  resume, quota failure, logout while work is active, and app upgrade.
- [ ] Full all-tests/Playwright matrix remains a Band 8 gate; Band 7 prep only
  adds deterministic static guards and focused checks.

## Required Hardening Cases

| Case | Required release behavior |
|------|---------------------------|
| Low memory | Abort or retry without logging plaintext; wipe partial plaintext/key buffers; release object URLs/WASM objects; keep only encrypted or opaque recovery state. |
| Interrupted upload | Resume from encrypted shard/upload state; never persist raw picker grants; do not re-encrypt with reused nonces; recover unknown manifest commits through sync. |
| Flaky network | Retry with bounded backoff and stable error codes; preserve encrypted progress; sanitize transport errors; avoid duplicate sync loops. |
| Logout during work | Close Rust handles, clear web worker/Kotlin/session stores, cancel or pause platform jobs, and prevent stale async completions from restoring keys. |
| Revoked member | Stop new writes with stale keys, rotate/fetch epochs where applicable, fail closed on missing epoch access, and keep historical-access limitations explicit. |
| Quota exceeded | Return user-safe quota status; keep queue recoverable; never log filenames, captions, raw URIs, or plaintext metadata in quota diagnostics. |
| Reset/recovery | Clear local encrypted databases, key caches, queued plaintext staging, Rust handles, and sync cursors before accepting fresh credentials or imports. |
| App upgrade | Validate schema/snapshot/protocol versions; reject unsupported versions with redacted errors; run generated binding snapshot checks before publishing. |

## Dependency, CVE, and Generated Binding Review

- Run `npm audit`/Dependabot or the project-approved Node scanner for web and
  crypto packages before v1 release, triaging runtime dependencies before dev
  dependencies.
- Run `cargo deny check` and `cargo vet` for Rust dependency advisories,
  licenses, source registries, yanked crates, duplicate crates, and reviewed
  audits.
- Review GitHub Actions pins, Docker base images, nginx/backend runtime images,
  and Android/Kotlin toolchain provenance for CVEs and unexpected source changes.
- Treat generated WASM/UniFFI/Kotlin binding diffs as security review inputs:
  check new exported functions, records, debug/display behavior, ownership/free
  semantics, error-code mappings, and any field that could carry secrets or
  plaintext.
- Generated binding review must be tied back to Rust snapshot tests and a manual
  diff of public API surface, not only to successful compilation.
- New dependency or generator versions require release notes explaining the
  security reason, CVE status, and any reviewed transitive changes.

## Nonce and FFI Secret-Handle Review

- Production encryption APIs must not expose nonce parameters to web, Android,
  WASM, UniFFI, backend, or tests outside explicit deterministic vector helpers.
- Every shard or wrapped-key encryption must use a fresh 24-byte random
  XChaCha20 nonce generated inside the owning crypto implementation.
- Retry/recovery logic may reuse already-encrypted ciphertext and its existing
  public nonce; it must not decrypt and re-encrypt with a stored or derived nonce.
- Opaque account/identity/epoch handles must be treated as capabilities:
  validate existence, account linkage, open/closed state, and cascade-close
  behavior on every operation.
- FFI errors for missing/closed handles must return stable codes with empty
  output fields and no handle values in logs.
- Secret-bearing inputs should be mutable buffers that the callee or caller wipes
  in `finally`; non-secret salts, public keys, signatures, wrapped keys, and
  encrypted envelopes may cross records when reviewed.
- Public structs/classes carrying plaintext media on success must avoid debug
  formatting and must return empty plaintext on every error path.

## Out of Scope Until Bands 5/6 Land

- Final Android Gradle app/module, Android manifest policy tests, WorkManager
  foreground service wiring, and durable Room queue persistence checks.
- Full Android generated UniFFI binding integration beyond the current JVM shell
  seam and generated-binding adapter probes.
- Complete web Rust crypto cutover for account/session bootstrap, upload
  encryption, manifest signing, link-key operations, and TypeScript crypto debt
  removal.
- Full Rust client-core upload/sync adapter wiring into Android and web
  transports.
- Full media codec adoption and cross-platform encoded-output parity for JPEG,
  PNG, WebP, HEIC/HEIF, and AVIF.
- Full all-tests/Playwright/release matrix execution, long-running chaos testing,
  and production container hardening sign-off.

These surfaces must receive security review when the dependent Bands 5/6 changes
land and before Band 8 release validation starts.

## Focused Band 7 Verification

Run only deterministic focused checks for this prep lane:

1. `cd apps\web ; npm run test:run -- tests/cross-platform-security-boundary.test.ts`
2. `git --no-pager diff --check`

Do not run Playwright or the broad all-tests matrix in this workstream.
