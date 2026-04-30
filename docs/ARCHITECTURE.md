# Mosaic Architecture Documentation

> **Zero-Knowledge Encrypted Photo Gallery**
> 
> This document provides a comprehensive technical overview of the Mosaic application architecture, generated through automated codebase investigation.

---

## Table of Contents

1. [Overview](#overview)
2. [System Architecture](#system-architecture)
3. [Backend (.NET 10)](#backend-net-10)
4. [Frontend (React 19)](#frontend-react-19)
5. [Rust Client Core](#rust-client-core)
6. [Android Main App](#android-main-app)
7. [Crypto Library](#crypto-library)
8. [Database Schema](#database-schema)
9. [Authentication](#authentication)
10. [Testing Infrastructure](#testing-infrastructure)
11. [Deployment](#deployment)

---

## Overview

Mosaic is a **zero-knowledge encrypted photo gallery** designed for small-scale personal use (≤50 users). The core principle is that the server **never sees plaintext photos or metadata**—all encryption and decryption happens client-side in the browser.

### Key Architectural Features

| Feature | Implementation |
|---------|---------------|
| **Zero-Knowledge** | Server stores only encrypted blobs (opaque `byte[]`) |
| **Client-Side Encryption** | Web Workers + libsodium-wrappers for crypto |
| **Local-First** | SQLite-WASM + OPFS for offline-capable storage |
| **Resumable Uploads** | Tus protocol for large file uploads |
| **Key Rotation** | Epoch-based key management for access revocation |

### Technology Stack

```
┌─────────────────────────────────────────────────────────────┐
│                       FRONTEND                               │
│  React 19 + TypeScript + Vite + TanStack Virtual            │
│  ├── Web Workers (Crypto, Database, Geo)                    │
│  ├── SQLite-WASM + OPFS (local encrypted storage)          │
│  ├── libsodium-wrappers-sumo (legacy crypto surface)        │
│  └── mosaic-wasm (Rust client-core, handle-based facade)    │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS (encrypted blobs)
┌──────────────────────────▼──────────────────────────────────┐
│                       BACKEND                                │
│  .NET 10 + ASP.NET Core + Entity Framework Core             │
│  ├── Tus Protocol (resumable uploads)                       │
│  ├── PostgreSQL (production) / SQLite (development)         │
│  └── LocalAuth or ProxyAuth (trusted reverse proxy)         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                       ANDROID (apps/android-main)            │
│  Kotlin/AGP 8.7.3 + JNA bindings                            │
│  └── mosaic-uniffi (Rust client-core, JNI/UniFFI facade)    │
└─────────────────────────────────────────────────────────────┘
```

Both clients share the same Rust workspace under `crates/` (see
[Rust Client Core](#rust-client-core)) and the same cross-client golden
vector corpus under `tests/vectors/`.

---

## System Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                           BROWSER                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                        MAIN THREAD                            │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │  │
│  │  │ React UI │◄─│  Hooks   │◄─│ Services │◄─│ API      │     │  │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘     │  │
│  └───────┼─────────────┼─────────────┼─────────────┼────────────┘  │
│          │ Comlink     │ Comlink     │             │               │
│  ┌───────┼─────────────┼─────────────┼─────────────┼────────────┐  │
│  │       ▼             ▼             ▼             │ WORKERS    │  │
│  │  ┌─────────┐  ┌─────────────┐  ┌───────────┐   │            │  │
│  │  │ Geo     │  │ Db Worker   │  │ Crypto    │   │            │  │
│  │  │ Worker  │  │ (SQLite)    │  │ Worker    │   │            │  │
│  │  └─────────┘  └──────┬──────┘  └───────────┘   │            │  │
│  │                      │                          │            │  │
│  │                      ▼                          │            │  │
│  │                 ┌─────────┐                     │            │  │
│  │                 │  OPFS   │                     │            │  │
│  │                 └─────────┘                     │            │  │
│  └─────────────────────────────────────────────────┴────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                           BACKEND                                    │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  ASP.NET Core Middleware Pipeline                            │   │
│  │  ┌──────────┬──────────┬──────────┬──────────┬───────────┐  │   │
│  │  │Exception │Correlat. │LogScope  │Timing    │Auth       │  │   │
│  │  │Handler   │ID        │          │          │Middleware │  │   │
│  │  └──────────┴──────────┴──────────┴──────────┴───────────┘  │   │
│  │                              │                               │   │
│  │  ┌──────────────────────────▼────────────────────────────┐  │   │
│  │  │  Controllers (Albums, Manifests, Shards, etc.)        │  │   │
│  │  └──────────────────────────┬────────────────────────────┘  │   │
│  │                              │                               │   │
│  │  ┌──────────────────────────▼────────────────────────────┐  │   │
│  │  │  Entity Framework Core + PostgreSQL/SQLite            │  │   │
│  │  └───────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌────────────────┐  ┌────────────────┐                            │
│  │ Tus Uploads    │  │ Blob Storage   │                            │
│  │ /api/files     │  │ /data/blobs    │                            │
│  └────────────────┘  └────────────────┘                            │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Flow: Photo Upload

```
1. User drops photo in browser
2. Main thread → CryptoWorker: Generate shards (thumb, preview, full)
3. CryptoWorker encrypts each shard with tier-specific epoch key
4. Main thread uploads shards via Tus protocol to /api/files
5. After all shards complete, POST /api/albums/{id}/manifests with metadata
6. Server links shards to manifest, marks as ACTIVE
7. CryptoWorker → DbWorker: Store decrypted metadata in SQLite
8. UI updates to show new photo
```

### Data Flow: Photo View

```
1. UI requests photo from usePhotos hook
2. Hook queries DbWorker for photo metadata
3. On thumbnail click, fetch shard from /api/shards/{id}
4. CryptoWorker decrypts shard using cached epoch key
5. Create Blob URL and cache in LRU (100MB limit)
6. Display in lightbox
```

---

## Backend (.NET 10)

### API Endpoints

#### Health & Authentication

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/health` | Database connectivity check |
| POST | `/api/auth/init` | Request auth challenge (returns salt + nonce) |
| POST | `/api/auth/verify` | Verify Ed25519 signature, create session |
| POST | `/api/auth/register` | Register new user with crypto keys |
| POST | `/api/auth/logout` | Revoke current session |
| GET | `/api/auth/sessions` | List active sessions |
| DELETE | `/api/auth/sessions/{id}` | Revoke specific session |

#### Users

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/users/me` | Get current user profile + quota |
| PUT | `/api/users/me` | Update identity pubkey and/or encrypted salt |
| PUT | `/api/users/me/wrapped-account-key` | Update wrapped account key |
| GET | `/api/users/{userId}` | Get user's public info |
| GET | `/api/users/by-key/{publicKey}` | Lookup user by identity public key |

#### Albums

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/albums` | List all accessible albums |
| POST | `/api/albums` | Create new album |
| GET | `/api/albums/{id}` | Get album details |
| DELETE | `/api/albums/{id}` | Delete album (owner only) |
| PATCH | `/api/albums/{id}/name` | Rename album |
| PATCH | `/api/albums/{id}/expiration` | Update expiration settings |
| GET | `/api/albums/{id}/sync` | Sync changes since version |

#### Album Members & Epoch Keys

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/albums/{id}/members` | List members |
| POST | `/api/albums/{id}/members` | Invite member |
| DELETE | `/api/albums/{id}/members/{userId}` | Remove member |
| GET | `/api/albums/{id}/epochs` | Get epoch keys |
| POST | `/api/albums/{id}/epochs` | Create epoch key for recipient |
| POST | `/api/albums/{id}/epochs/{epochId}/rotate` | Rotate to new epoch |

#### Manifests & Shards

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/albums/{id}/manifests` | Create manifest (link shards) |
| DELETE | `/api/albums/{id}/manifests/{manifestId}` | Delete manifest |
| GET | `/api/shards/{id}` | Download encrypted shard |
| GET | `/api/shards/{id}/meta` | Get shard metadata |

#### Share Links

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/albums/{id}/share-links` | Create share link |
| GET | `/api/albums/{id}/share-links` | List share links |
| DELETE | `/api/albums/{id}/share-links/{linkId}` | Revoke link |
| GET | `/api/s/{linkId}` | Access link info (public) |
| GET | `/api/s/{linkId}/epochs` | Get wrapped keys (public) |
| GET | `/api/s/{linkId}/photos` | Get photos via link (public) |
| GET | `/api/s/{linkId}/shards/{shardId}` | Download via link (public) |

#### Admin

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/admin/users` | List all users with quotas |
| PUT | `/api/admin/users/{id}/quota` | Set custom quota |
| GET | `/api/admin/albums` | List all albums |
| PUT | `/api/admin/albums/{id}/limits` | Set album limits |
| GET | `/api/admin/settings/quota` | Get system quota defaults |
| PUT | `/api/admin/settings/quota` | Update quota defaults |
| GET | `/api/admin/stats` | System-wide statistics |

### Middleware Pipeline

The middleware order is critical:

1. **GlobalExceptionMiddleware** - Error handling
2. **CorrelationIdMiddleware** - Request tracking
3. **LogScopeMiddleware** - Logging context
4. **RequestTimingMiddleware** - Performance logging
5. **LocalAuthMiddleware** OR **TrustedProxyMiddleware** - Authentication
6. **AdminAuthMiddleware** - Admin route protection
7. **Tus endpoint** - `/api/files` resumable uploads
8. **Controllers** - API endpoints

### Background Services

**GarbageCollectionService** runs hourly:
- Mark orphaned uploads (PENDING → TRASHED)
- Delete TRASHED shards older than 7 days
- Clean expired albums
- Remove old share links

---

## Frontend (React 19)

### Directory Structure

```
apps/web/src/
├── components/
│   ├── Admin/          # Admin panel
│   ├── Albums/         # Album list, dialogs
│   ├── App.tsx         # Main shell
│   ├── Auth/           # Login/logout
│   ├── Gallery/        # Photo grid, lightbox, map
│   ├── Members/        # Member management
│   ├── Settings/       # User settings
│   ├── Shared/         # Anonymous share viewer
│   ├── ShareLinks/     # Link management
│   └── Upload/         # Drop zone, upload button
├── contexts/           # React contexts
├── hooks/              # Custom hooks
├── services/           # API, sync, photo services
├── stores/             # In-memory stores
├── types/              # TypeScript definitions
├── utils/              # Utilities
└── workers/            # Web Workers
```

### State Management

Mosaic uses a combination of patterns (no Redux/Zustand):

| Pattern | Usage |
|---------|-------|
| **React Context** | AlbumSyncContext, UploadContext, AlbumPermissionsContext |
| **Custom Hooks** | useAlbums, usePhotos, useSync, useUpload, useSession |
| **Module Singletons** | epochKeyStore, thumbnailUrlStore, sessionStore |

### Web Workers

| Worker | Type | Purpose |
|--------|------|---------|
| **CryptoWorker** | Dedicated | All cryptographic operations |
| **DbWorker** | SharedWorker | SQLite-WASM with OPFS persistence |
| **GeoWorker** | Dedicated | Map point clustering |

All workers use **Comlink** for RPC communication.

### Key Components

| Component | Purpose |
|-----------|---------|
| `App.tsx` | Root with URL-based routing |
| `AppShell.tsx` | Authenticated layout |
| `LoginForm.tsx` | Authentication UI |
| `AlbumList.tsx` | Album grid |
| `Gallery.tsx` | Photo grid + lightbox + map |
| `SharedAlbumViewer.tsx` | Anonymous share access |

---

## Rust Client Core

The Rust workspace under `crates/` is the canonical implementation of every
security-critical primitive. The web frontend and the Android app both consume
it through facade crates so the same audited code runs on both clients.

### Crates

| Crate | Purpose |
|-------|---------|
| **mosaic-domain** | Protocol/domain constants, schema versions, late-v1 lock |
| **mosaic-crypto** | Canonical crypto boundary (envelope, manifest signing, sidecar, link/sealed/account/identity/epoch primitives, plus `ts_canonical` byte-equality helpers) |
| **mosaic-client** | Upload/sync/session state-machine boundary + `ClientErrorCode` mapping |
| **mosaic-media** | Gated media-processing prototype boundary |
| **mosaic-wasm** | `wasm-bindgen` facade consumed by `apps/web` |
| **mosaic-uniffi** | UniFFI/JNI facade consumed by `apps/android-main` |
| **mosaic-vectors** | Loader for the cross-client golden-vector corpus (`tests/vectors/*.json`) |

The Rust toolchain is pinned by `rust-toolchain.toml` (current `1.93.1`,
MSRV `1.85`, with `aarch64-linux-android`, `x86_64-linux-android`, and
`wasm32-unknown-unknown` targets).

### Handle-based opaque-secret API

The web cutover slices (Slices 2–8) replaced direct libsodium calls with a
handle-based contract owned by the Rust core:

* Account, identity, epoch, shard, link, manifest-signing, and metadata-sidecar
  operations all return integer **handles** to callers; plaintext key material
  never crosses the FFI boundary in unwrapped form.
* `apps/web/src/workers/rust-crypto-core.ts` is the **single TypeScript entry
  point** into `apps/web/src/generated/mosaic-wasm/`; an architecture-fitness
  test (`tests/rust-cutover-boundary.test.ts`) enforces that no other worker
  file imports the generated wasm-bindgen module directly.
* On Android, the equivalent contract is provided by `AndroidRust*Api`
  adapters under `apps/android-main/src/main/kotlin/.../bridge/`, which call
  into `uniffi.mosaic_uniffi.*` over JNA.
* Handle close functions explicitly zero the underlying secret bytes inside
  Rust (`zeroize` crate); FFI Debug impls redact byte payloads as
  `<redacted-{N}-bytes>` so panic logs and `Debug` formatting cannot leak key
  material.

### Late-v1 protocol surfaces (shared)

These constants are fixed in `crates/mosaic-domain/src/lib.rs` and locked by
`crates/mosaic-domain/tests/late_v1_protocol_freeze_lock.rs`:

| Surface | Value |
|---------|-------|
| Shard envelope magic | `SGzk` (4 bytes) |
| Shard envelope version | `0x03` |
| Shard envelope header length | `64` bytes |
| Manifest signing context | `Mosaic_Manifest_v1` |
| Metadata sidecar context | `Mosaic_Metadata_v1` |
| Sidecar TLV tags | orientation, device timestamp, dimensions, MIME, caption, filename, camera make/model, GPS |

### Cross-client vector corpus

`tests/vectors/*.json` contains golden inputs/outputs for every primitive
(envelope, manifest transcript, metadata sidecar, identity, auth challenge,
content encrypt, link keys, link secret, sealed bundle, tier key wrap, epoch
derive, account unlock). `mosaic-vectors` loads the corpus and the same
fixtures drive Rust differential tests, web Vitest assertions, and Android
JVM round-trip tests in `apps/android-main/src/test/.../bridge/` — proving
byte-for-byte parity between TS, Rust, and JNA. Outstanding deviations are
tracked in `tests/vectors/deviations.md`.

---

## Android Main App

`apps/android-main` is the first real Android Gradle module in Mosaic. It
consumes `crates/mosaic-uniffi` directly: the cross-compiled
`libmosaic_uniffi.so` ships in the APK and JNA-generated Kotlin bindings
(`uniffi.mosaic_uniffi.*`) call into Rust at runtime.

### Module layout

| Path | Role |
|------|------|
| `apps/android-shell/` | JVM-only Kotlin scaffold; source of truth for `Generated*Api` bridge contracts. No Android SDK required. |
| `apps/android-main/` | Real AGP application module. Implements every `Generated*Api` contract via `AndroidRust*Api` adapters and ships a debug APK. |

### Build chain

| Component | Version |
|-----------|---------|
| Gradle | 8.10.2 (wrapper SHA256 pinned) |
| Android Gradle Plugin | 8.7.3 |
| Kotlin | 2.0.21 (JVM target 17) |
| compileSdk / targetSdk | 35 |
| minSdk | 26 |
| JNA (Android `aar`) | 5.14.0 |
| cargo-ndk | 4.1.2 |
| uniffi-bindgen | 0.31.1 |
| ABI filters | `arm64-v8a` + `x86_64` only |

`scripts/build-android-main.{ps1,sh}` runs `scripts/build-rust-android.{ps1,sh}`
first to produce the `.so` artifacts and Kotlin bindings, then invokes
`gradlew :apps:android-main:assembleDebug`. `scripts/test-android-main.{ps1,sh}`
runs the JVM unit tests (manifest invariants, adapter compilation contract,
auto-import policy, cross-client vector round-trips).

### Privacy invariants

- `android:allowBackup="false"`; no `INTERNET`, `READ_MEDIA_*`, or
  `MANAGE_EXTERNAL_STORAGE` permissions.
- Bridge DTOs use `<redacted>` `toString()` — see
  `apps/android-shell/src/main/kotlin/.../foundation/`.
- The Band 6 auto-import `CoroutineWorker` runs as a `dataSync` foreground
  service when policy allows; capability revocation between enqueue and
  execution is a benign no-op.
- WorkManager unique-work names are SHA-256 hashes of `(serverAccountId,
  albumId)` so account/album identifiers never enter the WorkManager database.

---

## Crypto Library

### Key Hierarchy

```
PASSWORD ──────┐
               ▼
┌─────────────────────────────────────────────────────────────┐
│ L0 (Master Key)                                             │
│ Argon2id(password, userSalt)                                │
│ 32 bytes | NEVER STORED | Memory-only                       │
└────────────────────────────┬────────────────────────────────┘
                             ▼ HKDF-BLAKE2b
┌─────────────────────────────────────────────────────────────┐
│ L1 (Root Key)                                               │
│ HKDF(L0, accountSalt, "Mosaic_RootKey_v1")                 │
│ 32 bytes | NEVER STORED | Memory-only                       │
└────────────────────────────┬────────────────────────────────┘
                             ▼ XChaCha20-Poly1305 wrap
┌─────────────────────────────────────────────────────────────┐
│ L2 (Account Key)                                            │
│ random(32)                                                  │
│ 32 bytes | STORED WRAPPED | Encrypted by L1                 │
└────────────────────────────┬────────────────────────────────┘
                             ▼ Wrap/Derive
┌─────────────────────────────────────────────────────────────┐
│ L3 (Epoch Keys) - Per Album                                 │
│ ├── epochSeed (32 bytes) - Master seed                      │
│ ├── thumbKey   ← HKDF(epochSeed, "tier:thumb")             │
│ ├── previewKey ← HKDF(epochSeed, "tier:preview")           │
│ ├── fullKey    ← HKDF(epochSeed, "tier:full")              │
│ └── signKeypair (Ed25519) - Manifest signing                │
└─────────────────────────────────────────────────────────────┘
```

### Cryptographic Algorithms

| Operation | Algorithm | Parameters |
|-----------|-----------|------------|
| Password Hashing | Argon2id | 64MiB, 3 iterations (desktop) |
| Key Expansion | HKDF-BLAKE2b | Context-based domain separation |
| Symmetric Encryption | XChaCha20-Poly1305 | 24-byte nonce, 32-byte key |
| Key Wrapping | XChaCha20-Poly1305 | Random nonce prepended |
| Signing | Ed25519 | 64-byte signature |
| Key Exchange | X25519 (sealed boxes) | For epoch key distribution |

### Shard Envelope Format (64-byte header)

```
┌────────┬────────┬────────────────────────────────────────────┐
│ Offset │  Size  │ Field                                      │
├────────┼────────┼────────────────────────────────────────────┤
│   0    │   4    │ Magic: "SGzk" (0x53 0x47 0x7a 0x6b)        │
│   4    │   1    │ Version: 0x03                              │
│   5    │   4    │ EpochID: Little-endian u32                 │
│   9    │   4    │ ShardID: Little-endian u32                 │
│  13    │  24    │ Nonce: Random bytes (unique per encrypt)   │
│  37    │   1    │ Tier: 1=THUMB, 2=PREVIEW, 3=ORIGINAL       │
│  38    │  26    │ Reserved: MUST be zero                     │
└────────┴────────┴────────────────────────────────────────────┘
Total = Header (64) + Ciphertext + Tag (16)
```

### Security Invariants

1. **Nonces never reused** - Fresh `randombytes_buf(24)` per encryption
2. **Keys zeroed after use** - Explicit `memzero()` calls (TS) and `zeroize` (Rust)
3. **Reserved bytes validated** - Checked as zero on decrypt
4. **Signature before decrypt** - Prevents processing forged bundles
5. **Domain separation** - Context strings (`Mosaic_Manifest_v1`,
   `Mosaic_Metadata_v1`, tier-specific HKDF labels) prevent cross-protocol
   attacks. The set of contexts and the late-v1 envelope header are locked
   in `crates/mosaic-domain` (see [Rust Client Core](#rust-client-core)).

---

## Database Schema

### Entity Relationship

```
User (1) ─────────< OwnedAlbums (Album)
  │
  ├───< Memberships (AlbumMember)
  ├───< EpochKeys
  ├───< Sessions
  └───1 Quota (UserQuota)

Album (1) ─────────< Members (AlbumMember)
  │
  ├───< EpochKeys
  ├───< Manifests
  ├───< ShareLinks
  └───1 Limits (AlbumLimits)

Manifest (1) ───────< ManifestShards >───── Shard

ShareLink (1) ──────< LinkEpochKeys
```

### Core Entities

| Entity | Key Fields | Purpose |
|--------|------------|---------|
| **User** | Id, Username, IdentityPublicKey, WrappedAccountKey, IsAdmin | User identity |
| **Album** | Id, OwnerId, Name, Version, ExpiresAt | Album container |
| **AlbumMember** | UserId, AlbumId, Role, JoinedAt | Membership |
| **EpochKey** | EpochId, AlbumId, UserId, WrappedEpochKey | Per-user epoch keys |
| **Manifest** | Id, AlbumId, EncryptedMetadata, Signature | Photo metadata |
| **Shard** | Id, Size, Status, ExpiresAt | Encrypted blob |
| **ShareLink** | LinkId, AlbumId, ExpiresAt, MaxViews | Anonymous access |
| **Session** | Id, UserId, TokenHash, ExpiresAt | Auth sessions |

---

## Authentication

### Mode 1: ProxyAuth (Production)

For use with trusted reverse proxies (Authelia, Caddy, nginx):

1. Request arrives from reverse proxy
2. Middleware checks source IP against `Auth:TrustedProxies` CIDR list
3. Extracts `Remote-User` header (set by auth proxy)
4. Sets `HttpContext.Items["AuthenticatedUser"]`

### Mode 2: LocalAuth (Development/Standalone)

Challenge-response authentication with Ed25519:

```
1. Client → POST /api/auth/init { username }
2. Server → { challenge: bytes(32), userSalt: bytes(16) }
3. Client derives Ed25519 keypair from password
4. Client → POST /api/auth/verify { username, signature }
5. Server verifies signature against stored publicKey
6. Server → Sets mosaic_session cookie, returns wrapped keys
```

Session management:
- Token hashed (SHA256) before storage
- Sliding expiration: 7 days since last use
- Absolute expiration: 30 days

---

## Testing Infrastructure

### Test Layers

| Layer | Framework | Location | Coverage Target |
|-------|-----------|----------|-----------------|
| Crypto | Vitest | libs/crypto/tests/ | 85% lines/functions |
| Frontend | Vitest + happy-dom | apps/web/tests/ | - |
| Backend | xUnit + InMemory EF | apps/backend/*.Tests/ | - |
| E2E | Playwright | tests/e2e/ | - |

### Test Commands

```powershell
# Crypto library
cd libs/crypto && npm test
cd libs/crypto && npm run test:coverage

# Frontend
cd apps/web && npm run test:run

# Backend
cd apps/backend/Mosaic.Backend.Tests && dotnet test

# E2E (services must be running)
cd tests/e2e && npx playwright test

# All tests via script
.\scripts\run-tests.ps1 -Suite all
```

### E2E Test Priorities

| Priority | Focus | Examples |
|----------|-------|----------|
| P0 Critical | Core flows | Auth, upload, basic sharing |
| P1 High | Key features | Album CRUD, multi-user sync |
| P2 Medium | Secondary | Settings, accessibility |

---

## Deployment

### Docker Services

| Service | Image | Purpose |
|---------|-------|---------|
| `postgres` | postgres:17-alpine | Database |
| `backend` | mosaic-backend | .NET API |
| `frontend` | mosaic-frontend | React + nginx |

### Development Commands

```powershell
# Start development environment
.\scripts\dev.ps1 start

# Check status
.\scripts\dev.ps1 status

# View logs
.\scripts\dev.ps1 logs backend

# Run tests
.\scripts\dev.ps1 test e2e

# Stop
.\scripts\dev.ps1 stop
```

### Production Deployment

```powershell
# Build images
.\scripts\docker-build.ps1 -Tag v1.0.0

# Start production stack
docker compose up -d

# Manage with script
.\scripts\mosaic.ps1 start
.\scripts\mosaic.ps1 logs
.\scripts\mosaic.ps1 backup
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ConnectionStrings__Default` | - | PostgreSQL connection string |
| `Storage__Path` | `/app/data/blobs` | Blob storage path |
| `Auth__LocalAuthEnabled` | `true` | Enable local auth |
| `Auth__ProxyAuthEnabled` | `true` | Enable proxy auth |
| `Auth__TrustedProxies__0` | Docker networks | Trusted CIDRs |
| `Quota__DefaultMaxBytes` | 10GB | Default user quota |

### Required Headers (nginx)

For SharedArrayBuffer support (required for WASM):

```nginx
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Embedder-Policy "require-corp" always;
```

---

## Security Summary

### Zero-Knowledge Properties

**Server never sees:**
- Plaintext photos or metadata
- L0, L1, L2 keys (derived client-side)
- Link secrets (only derived ID for lookup)
- Epoch seeds (only wrapped keys)

**Server stores:**
- Encrypted shards (opaque blobs)
- Wrapped account keys (encrypted by L1)
- Wrapped epoch keys (encrypted by account key)
- Wrapped link tier keys (encrypted by link secret)

### Key Security Measures

1. All sensitive keys zeroed with `memzero()` after use
2. Ed25519 signatures verified before processing sealed boxes
3. Nonces never reused (fresh random bytes per encryption)
4. Rate limiting on auth endpoints
5. Session tokens hashed before storage
6. Admin routes protected by separate middleware

---

*Generated: December 29, 2025. Last refreshed: April 30, 2026 (post-Slice-0C, post-web-Rust-cutover, post-android-main).*
