# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

#### Rust client core (Slices 0–8)
- **TypeScript → Rust crypto cutover (Slices 2–8)** — account/session bootstrap, epoch-key lifecycle, manifest sign/verify, share-link key wrapping, album content + UI utility, OPFS DB worker encryption, and sync are now driven through Rust handles via the WASM facade (`apps/web/src/workers/rust-crypto-core.ts`). The legacy `@mosaic/crypto` TypeScript-shadow modules are retained only as compatibility shims; the per-symbol `rust-cutover-boundary.test.ts` guard fails CI when a protocol-class TS helper sneaks into a retired module.
- **Rust workspace bring-up** — `mosaic-domain`, `mosaic-crypto`, `mosaic-client`, `mosaic-media`, `mosaic-uniffi`, `mosaic-wasm` crates with handle-based opaque secret registries, FFI-safe `ClientErrorCode` table (codes 0–222), client-core upload/sync state machines, manifest canonical transcript (`Mosaic_Manifest_v1`), encrypted metadata sidecar (`Mosaic_Metadata_v1`), and 64-byte shard envelope (`SGzk`/`0x03`) primitives.
- **Cross-client crypto vectors (Slice 0C)** — `tests/vectors/` corpus with 13 byte-exact vectors plus deviation manifests; native Rust differential coverage in `mosaic-crypto/tests/golden_vectors.rs`; web parity through `apps/web/tests/cross-client-vectors.test.ts` (4 byte-exact assertions, 6 documented deviations/facade gaps); Android parity through `CrossClientVectorTest.kt` and JVM-side bridge contracts.
- **Cross-client raw-input FFI surface** — `derive_link_keys`, `derive_identity_from_raw_seed`, `build_auth_challenge_transcript`, `sign_auth_challenge_raw_seed`, `verify_auth_challenge_signature`, `verify_and_open_bundle_recipient_seed`, `decrypt_content_raw_key` exposed through `mosaic-uniffi` (UniFFI v9) and `mosaic-wasm`.
- **TS-canonical primitives** (`mosaic-crypto::ts_canonical`) — BLAKE2b-keyed link IDs, BLAKE2b auth-key + L1 derivation, XSalsa20-Poly1305 (`crypto_secretbox`) wrap/unwrap that reproduce the TypeScript reference byte-exact for `auth_keypair.json`, `account_unlock.json`, and `link_keys.json` corpora.

#### Android
- **`apps/android-main` Gradle module** — first real Android application module wiring `mosaic-uniffi` cdylib through JNA Kotlin bindings into a debug APK (~6 MB). `compileSdk 35`, `minSdk 26`, `arm64-v8a` + `x86_64` ABIs only. Strict privacy posture: no `INTERNET`, no `READ_MEDIA_*`, no `MANAGE_EXTERNAL_STORAGE`, `allowBackup="false"`, `hasFragileUserData="true"`.
- **Slice 0C cross-client bridges** — `GeneratedRust{AuthChallenge,Content,IdentitySeed,LinkKeys,SealedBundle}Bridge` foundation contracts and matching `AndroidRust*Api` adapters routing into the Rust core; covered by 30 round-trip JVM tests.
- **Auto-import scheduling worker** — `AutoImportWorker` (`CoroutineWorker`, `dataSync` foreground service per ADR-007) wired through the `apps/android-shell` capability boundary; instrumented enqueue/dedupe/revocation tests pass on emulator.
- **`apps/android-shell` foundation** — JVM-only privacy contracts for state machines (server auth vs crypto unlock), Photo Picker staging, upload queue records, manual upload handoff, work policy, and Slice 0C bridge interfaces.

#### Backend
- **Timed album & photo expiration** — server-clock album/photo expiry, deterministic GC sweeps, access enforcement returning 410 Gone for expired aggregates, focused contract tests (`PhotoExpirationRoute_UsesAlbumScopedPatchContract`, `UpdateExpiration_ReturnsContractResponse_WithIdAndUpdatedAt`).
- **Pagination + cleanup hardening** — share-link list pagination, pagination headers, epoch-rotation page draining, and full cleanup-batch draining.

#### Web
- **Sync conflict resolution** — deterministic three-way block merge with LWW fallback for album content (`SPEC-SyncConflictResolution.md`).
- **Timed expiration UI** — local purge with destructive-acknowledge dialog, expiration presets, expiry badges, photo-expiration adapter; routes 404 (deleted) and 410 (expired) sync responses through `purgeLocalAlbum` with distinct reasons.
- **Photo description editing** — owners/editors edit encrypted photo descriptions from the lightbox without exposing plaintext to the server.
- **Shared album download (ZIP)** — full-access share-link viewers paginate all photos and download client-decrypted ZIPs.
- **Per-symbol rust-cutover boundary guard** expanded from 5 → 24 checks; rejects wildcard imports of legacy `@mosaic/crypto` symbols across cutover-retired modules.

#### Tooling & infrastructure
- Conventional-commits-only direct-to-`main` flow with mandatory `git fetch` + rebase + push before each commit.
- 27 Dependabot advisories on transitive AGP build-script dependencies (Bouncy Castle, Netty, jose4j, protobuf-java, jdom2, commons-{io,compress}) triaged and dismissed as `tolerable_risk`; all 12 packages confirmed absent from runtime/test classpaths (`docs/SECURITY.md` § Dependabot triage 2026-04).
- New architecture guards under `tests/architecture/`: `rust-boundaries.{ps1,sh}`, `kotlin-raw-input-ffi.{ps1,sh}`.
- Repo hygiene: 43 stale `*-output.txt` validation artifacts removed, gitignore tightened with `/*-output.txt`, `/manifest-fix-*.txt`, and `/artifacts/` rules.

### Changed

- **FFI Debug redaction (M5)** — 24 custom `fmt::Debug` implementations across `mosaic-{client,crypto,media,uniffi,wasm}` replace `derive(Debug)` on public FFI surfaces; redacts byte payloads as `<redacted-{N}-bytes>`. 30 mutation-kill tests pin the redaction.
- **Web encrypted local cache** moved from TypeScript-shadow encryption to Rust-handle-based `encryptAlbumContent` / `decryptAlbumContent` via the OPFS DB worker.
- **Snapshot lifecycle** — client-core upload/sync persistence-safe snapshots reject raw handles, plaintext media, plaintext metadata, passwords, content/file URIs, and adapter-private Tus tokens.
- **Backend test stack** — migrated from Moq to NSubstitute; comprehensive MIME type integration tests added.

### Fixed

#### Security
- **Caller-supplied nonces removed** from production encrypt APIs; Rust core owns 24-byte XChaCha20 nonce generation internally.
- **EXIF stripped** from JPEG originals before client-side encryption (H5).
- **Strict response validation** — every web API response is parsed through Zod schemas (M2).
- **TipTap content** parsed via `DOMParser` instead of `innerHTML` to mitigate stored-XSS classes (M6).
- **Filename redaction** — upload pipeline log lines no longer emit user file names (M7).
- **Session lifecycle hardening** — clears worker-held session/account/auth/identity keys + Rust handles on logout (M3, M4, M9, L1–L3).
- **Link-tier encryption key** marked non-extractable (H3).
- **CSP** hardened with `object-src`, `base-uri`, `form-action`, locked `frame-ancestors` (H6).
- **Settings** clamped to a policy ceiling (M8); password autocomplete pinned + clear-session confirm (L4, L5).
- **FFI input validation** — strict snapshot enum decoding, metadata length cap, clamp-as-error (L1, L2, L4); `zeroize` wired across plaintext-bearing media paths (M2, M3, L5); epoch registry mutex released before AEAD; retry budgets capped (M1, L3).
- **Defense-in-depth cleanup** (L6, L7, L8).

#### Reliability
- **Cross-impl parity** closed for tier keys and manifest transcript across Rust, WASM, and UniFFI surfaces.
- **Mutation-kill regression suites** added for `mosaic-crypto`, `mosaic-domain`, `mosaic-media`, and `mosaic-uniffi` coverage gaps.
- Race condition fix in `deriveAuthKeypair` (await `sodium.ready`).
- HEIC detection for files with `mif1` major brand.
- Sync debounce timer cancellation on Gallery unmount; `ResizeObserver` cleanup to prevent leaks.

#### E2E test stability
- `domcontentloaded` instead of `networkidle`; multi-language page objects; retry mechanism for upload trigger; improved sync + share-link handling.

### Security
- Cross-platform hardening static guards (web, Android, Rust) and the late-v1 protocol freeze are landing in the D1–D4 lanes alongside this release.

## [0.0.4] - 2026-01-25

### Added

#### Image Format Support
- AVIF-first image format support with automatic HEIC decoding
- Adaptive thumbnail sizing for HiDPI displays
- Tiered shard support for progressive loading (manifests contain shard tiers)
- ThumbHash placeholders (migrated from BlurHash for better quality)

#### Gallery Enhancements
- Shift-click range selection for multi-photo operations
- Mosaic layout algorithm with story tiles
- Enhanced justified mosaic layout algorithm v2
- Photo grid animation system with stagger effects
- Viewport-aware photo preloading
- Embedded thumbnails in manifests for instant display

#### Internationalization (i18n)
- Language switcher in Settings page
- Full Czech (cs) translation
- Translations for all components: gallery, albums, lightbox, upload, settings

#### Authentication
- Independent LocalAuth and ProxyAuth toggles
- `/api/auth/config` endpoint for frontend auth mode detection
- Secure context check with user-friendly error message

#### User Experience
- URL-based routing with browser history support
- Album title display for shared album visitors
- Self-hosted fonts (Outfit, Inter) via Fontsource

### Changed

#### Performance
- Migrated from immer to mutative for faster state updates
- Optimized expired albums query for PostgreSQL
- Tier-aware decryption for progressive photo loading
- Memory management improvements in workers

#### Testing Infrastructure
- E2E test framework overhaul:
  - Split page-objects into feature modules (15 classes → 10 modules)
  - Consolidated fixtures with parallel-safe enhanced fixtures
  - Test API client for direct user management
  - Pool users expanded to 8 for better parallelization
  - Timeout constants (UI_TIMEOUT, NETWORK_TIMEOUT, CRYPTO_TIMEOUT)
  - Flaky pattern checker script
- Migrated from Moq to NSubstitute for backend tests
- Added comprehensive MIME type integration tests

### Fixed

#### Security
- Path traversal prevention in LocalStorageService
- Rate limiting for authentication endpoints
- MaxLength validation for encrypted blob inputs

#### Reliability
- ResizeObserver cleanup to prevent memory leaks
- Sync debounce timer cancellation on Gallery unmount
- WASM binding checks for libsodium functions
- Race condition fix in deriveAuthKeypair (await sodium.ready)
- HEIC detection for files with mif1 major brand

#### E2E Test Stability

- Replaced networkidle with domcontentloaded for reliability
- Retry mechanism for file upload trigger
- Multi-language support in page objects
- Improved sync and share link handling
- Improved timeout handling and test stability

#### UI

- Settings page now properly styled with glassmorphism design
- Fixed i18n key case mismatch for GitHub link in Settings

### Developer Experience

- Applied consistent code formatting (Prettier, dotnet format)
- Consolidated user creation logic with debug logging
- Standardized NotFound response format across API
- Extracted AlbumRoles constants class

## [0.0.1] - 2024-12-29

### Added

#### Core Features
- Zero-knowledge encrypted photo gallery with end-to-end encryption
- L0-L3 key hierarchy (Master → Root → Account → Epoch keys)
- XChaCha20-Poly1305 encryption for photos
- Ed25519 signing for manifests
- Argon2id key derivation from passwords

#### Photo Management
- Album creation with encrypted metadata
- Photo upload with resumable Tus protocol
- Photo sharding for efficient storage
- Thumbnail generation (encrypted client-side)
- GPS metadata extraction and encrypted storage

#### Gallery Views
- Square grid layout (Instagram-style)
- Justified mosaic layout with smart tiles
- Map view for GPS-tagged photos with clustering
- Timeline view with date grouping
- Full-text search across photo metadata (client-side)

#### Sharing
- Share links with expiration dates
- Epoch-based key distribution for shared albums
- Role-based permissions (viewer, editor, admin)
- Shared album viewer for link recipients

#### User Experience
- Offline-first architecture with local SQLite database
- Progressive sync with server
- URL-based routing with browser history support
- Photo lightbox with keyboard navigation
- Multi-select for batch operations

#### Authentication
- Local authentication (username/password)
- Proxy authentication (Remote-User header)
- Configurable auth modes via environment variables

#### Admin Features
- User quota management
- Album limit configuration
- Storage usage tracking

#### Infrastructure
- Docker deployment with multi-architecture support (amd64, arm64)
- PostgreSQL for server metadata
- SQLite-WASM with OPFS for client-side storage
- Health check endpoints
- Automatic database migrations

### Security

- All photos encrypted before leaving the browser
- Server never sees plaintext photos or metadata
- Manifest signing prevents tampering
- Nonce uniqueness enforced for all encryption operations
- Memory zeroing for sensitive key material

[Unreleased]: https://github.com/adsamcik/Mosaic/compare/v0.0.4...HEAD
[0.0.4]: https://github.com/adsamcik/Mosaic/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/adsamcik/Mosaic/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/adsamcik/Mosaic/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/adsamcik/Mosaic/releases/tag/v0.0.1
