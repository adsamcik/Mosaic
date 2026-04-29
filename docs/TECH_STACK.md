# Mosaic Technology Stack

A comprehensive overview of the technologies used in this zero-knowledge encrypted photo gallery.

## Overview

Mosaic is a self-hosted, end-to-end encrypted photo gallery where all encryption/decryption happens client-side. The server never sees plaintext photos or metadata.

---

## Frontend

### Core Framework
| Technology | Version | Purpose |
|------------|---------|---------|
| **React** | 19.0 | UI component library with the latest concurrent features |
| **TypeScript** | 5.7 | Type-safe JavaScript with strict mode enabled |
| **Vite** | 7.x | Fast build tool and dev server with HMR |

### Key Libraries
| Library | Purpose |
|---------|---------|
| **@tanstack/react-virtual** | Virtualized lists for efficient rendering of large photo grids |
| **Comlink** | Simplified Web Worker communication via proxied async calls |
| **sql.js** | SQLite compiled to WASM for client-side database storage |
| **idb** | Promise-based IndexedDB wrapper |
| **libsodium-wrappers-sumo** | Cryptographic operations (see Crypto section) |
| **tus-js-client** | Resumable file uploads via the Tus protocol |
| **Leaflet** | Interactive map for geolocation-based photo browsing |
| **Supercluster** | Fast point clustering for map markers |

### Browser APIs
| API | Usage |
|-----|-------|
| **Web Workers** | Offload crypto and database operations from main thread |
| **OPFS (Origin Private File System)** | Persistent storage for SQLite database |
| **SharedArrayBuffer** | Required for multithreaded WASM (needs COOP/COEP headers) |
| **Web Crypto API** | Backup for crypto operations |

---

## Backend

### Core Framework
| Technology | Version | Purpose |
|------------|---------|---------|
| **.NET** | 10.0 | Latest LTS runtime with performance improvements |
| **ASP.NET Core** | 10.0 | Web API framework with minimal APIs |

### Data & Storage
| Technology | Purpose |
|------------|---------|
| **Entity Framework Core** | ORM with migrations and LINQ support |
| **Npgsql** | PostgreSQL driver for EF Core |
| **SQLite** | Development/testing database provider |

### Key Libraries
| Library | Version | Purpose |
|---------|---------|---------|
| **tusdotnet** | 2.11 | Server-side Tus protocol for resumable uploads |
| **NSec.Cryptography** | 25.4 | Ed25519 signature verification |
| **System.Linq.Async** | 7.0 | Async LINQ extensions |
| **Microsoft.AspNetCore.OpenApi** | 10.0 | OpenAPI/Swagger documentation |

### Authentication
- **Trusted Reverse Proxy** authentication via `Remote-User` header
- **Ed25519 Challenge-Response** for cryptographic login
- **Development mode** with simplified auth for local testing

---

## Cryptographic Library (`@mosaic/crypto`)

A shared TypeScript library providing all cryptographic primitives.

### Algorithms
| Algorithm | Usage |
|-----------|-------|
| **XChaCha20-Poly1305** | Authenticated encryption for photo shards |
| **Ed25519** | Digital signatures for manifests and identity |
| **Argon2id** | Password-based key derivation (memory-hard) |
| **HKDF-SHA256** | Deterministic key expansion |
| **X25519** | Key exchange for sharing (via Ed25519 conversion) |

### Key Hierarchy
```
L0 (Master)  = Argon2id(password, salt)     # Never stored
L1 (Root)    = HKDF(L0, account_salt)        # Never stored
L2 (Account) = random(32), wrapped by L1    # Stored encrypted
L3 (Epoch)   = ReadKey + SignKey per album  # Distributed to members
```

### Implementation
- **libsodium-wrappers-sumo** - Full libsodium bindings for JavaScript
- 24-byte random nonces (never reused)
- Constant-time comparisons for all sensitive data
- Automatic memory zeroing after key use

### Rust Client Core (in progress)

| Crate | Purpose |
|-------|---------|
| **mosaic-domain** | Canonical protocol/domain types and schema versions |
| **mosaic-crypto** | Canonical Rust cryptographic boundary |
| **mosaic-client** | Shared upload/sync/session state-machine boundary |
| **mosaic-media** | Gated media-processing prototype boundary |
| **mosaic-wasm** | Web Worker/WASM facade |
| **mosaic-uniffi** | Android UniFFI/JNI facade |

Rust is pinned with `rust-toolchain.toml`. The Rust client core powers the
web frontend via `mosaic-wasm` and the Android app via `mosaic-uniffi` (see
the Android section below).

---

## Android (`apps/android-main`)

The first real Android Gradle application module, consuming the Rust UniFFI
core directly via JNA-based generated Kotlin bindings.

### Build chain
| Component | Version | Purpose |
|-----------|---------|---------|
| **Gradle** | 8.10.2 | Build tool (wrapper distribution SHA256 pinned in `gradle/wrapper/gradle-wrapper.properties`) |
| **Android Gradle Plugin** | 8.7.3 | Android application plugin |
| **Kotlin** | 2.0.21 | JVM target 17 |
| **JDK** | 17 | Compile + runtime target |
| **compileSdk / targetSdk** | 35 | Android 15 |
| **minSdk** | 26 | Android 8.0 floor |

### FFI runtime
| Component | Version | Purpose |
|-----------|---------|---------|
| **JNA (Android `aar`)** | 5.14.0 | Required by generated `uniffi.mosaic_uniffi.*` bindings (uses `com.sun.jna.*`). Packages `libjnidispatch.so` per ABI inside the APK. |
| **cargo-ndk** | 4.1.2 | Rust cross-compile orchestrator producing `target/android/{abi}/libmosaic_uniffi.so` |
| **uniffi-bindgen** | 0.31.1 | Generates `target/android/kotlin/uniffi/mosaic_uniffi/mosaic_uniffi.kt` from the host-built `mosaic_uniffi` library |
| **Android NDK** | 29.0.14206865 | Native cross-compile toolchain (also accepts 27/28 if `ANDROID_NDK_HOME` is set explicitly) |

### ABI filters
Native libraries are shipped only for `arm64-v8a` and `x86_64`. No 32-bit
builds. APK size ≈ 5 MB (debug, unminified).

### Bridge architecture
```
apps/android-shell                                      apps/android-main
(JVM-only Kotlin scaffold,                              (Real Gradle module,
 source of truth for                                     consumes the contracts)
 Generated*Api interfaces)
                                                        AndroidRust*Api adapters
  Generated*Api  ──── implemented by ─────────────►     delegate to
                                                        uniffi.mosaic_uniffi.*
                                                                │
                                                                │ JNA Native.register
                                                                ▼
                                                        libmosaic_uniffi.so
                                                        ↓
                                                        crates/mosaic-uniffi
                                                        ↓
                                                        crates/{mosaic-client,
                                                                mosaic-crypto,
                                                                mosaic-domain,
                                                                mosaic-media}
```

### Permissions (manifest invariants)
- `android:allowBackup="false"`.
- No `INTERNET`, no `READ_MEDIA_*`, no `READ_EXTERNAL_STORAGE`,
  no `MANAGE_EXTERNAL_STORAGE`.

---

## Database

### Production
| Technology | Version | Purpose |
|------------|---------|---------|
| **PostgreSQL** | 17 (Alpine) | Primary database with JSONB and full-text search |

### Development/Testing
| Technology | Purpose |
|------------|---------|
| **SQLite** | Lightweight in-memory testing |

### Client-Side
| Technology | Purpose |
|------------|---------|
| **SQLite-WASM** | Browser-based SQLite via sql.js |
| **OPFS** | Persistent file storage for database |
| **FTS5** | Full-text search on encrypted metadata |

---

## Testing

### Frontend Tests
| Tool | Purpose |
|------|---------|
| **Vitest** | Fast unit testing with Vite integration |
| **happy-dom** | Lightweight DOM implementation for testing |
| **@vitest/coverage-v8** | Code coverage via V8's native coverage |

### Backend Tests
| Tool | Purpose |
|------|---------|
| **xUnit** | .NET testing framework |
| **Moq** | Mocking library |
| **Microsoft.EntityFrameworkCore.InMemory** | In-memory database for tests |

### E2E Tests
| Tool | Purpose |
|------|---------|
| **Playwright** | Cross-browser E2E testing |
| Browser targets: Chromium, Firefox, Mobile Chrome |

### Crypto Library
| Tool | Purpose |
|------|---------|
| **Vitest** | Unit tests with 100% coverage |
| **Stryker** | Mutation testing for quality assurance |

---

## Infrastructure

### Containerization
| Technology | Purpose |
|------------|---------|
| **Docker** | Container runtime |
| **Docker Compose** | Multi-container orchestration |
| **nginx** | Frontend static file serving with COOP/COEP headers |

### Required HTTP Headers
The app requires specific security headers for SharedArrayBuffer:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

---

## Development Tools

| Tool | Purpose |
|------|---------|
| **Node.js** | 20+ LTS for frontend tooling |
| **pnpm/npm** | Package management |
| **.NET CLI** | Backend development |
| **Rust** | Shared client-core development |
| **ESLint** | TypeScript/JavaScript linting |
| **TypeScript** | Static type checking |

---

## Browser Support

Modern browsers only (no polyfills):

| Browser | Minimum Version |
|---------|-----------------|
| Chrome/Edge | 102+ |
| Firefox | 111+ |
| Safari | 16.4+ |

Required features: SharedArrayBuffer, WASM, OPFS, Web Workers

---

## Architecture Principles

1. **Zero-Knowledge** - Server stores only encrypted blobs and metadata
2. **Client-Side Crypto** - All encryption/decryption in the browser
3. **Epoch-Based Keys** - Forward secrecy via key rotation
4. **Offline-First** - Local SQLite database with sync
5. **Resumable Uploads** - Tus protocol for large files
6. **Virtualized UI** - Efficient rendering of thousands of photos
