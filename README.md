# Mosaic

A zero-knowledge encrypted photo gallery for personal use.

> **Preview status:** This checkout is not production-ready. Use only disposable or independently backed-up data until the audit release blockers have been independently resolved. See the authoritative [release-state and evidence page](docs/RELEASE_STATE.md).

## Overview

Mosaic is a self-hosted photo gallery where the server never sees your photos. All encryption and decryption happens client-side using modern cryptographic primitives.

**Target Scale:** ≤50 users

## Features

- 🔐 **End-to-end encryption** - Photos encrypted before upload, decrypted on the client
- 📱 **Android developer preview** - Rust/UniFFI foundation and FFI smoke-test surface; not a releasable gallery client
- 🖼️ **Gallery management** - Organize photos into albums
- 👥 **Secure sharing** - Share albums with family using epoch-based keys
- 🗺️ **Map view** - Browse photos by location (GPS metadata encrypted)
- 🔍 **Full-text search** - Search photo metadata (client-side)
- 📱 **Offline capable** - Local database with sync
- 📡 **Sidecar Beacon (beta)** - download an album directly to a second device (phone/tablet) over an end-to-end encrypted WebRTC channel; the server only relays opaque PAKE+AEAD bytes. Build with `VITE_FEATURE_SIDECAR=1` to enable. See [docs/architecture/SIDECAR.md](docs/architecture/SIDECAR.md), [docs/sidecar-beta-rollout.md](docs/sidecar-beta-rollout.md), and [docs/sidecar-test-matrix.md](docs/sidecar-test-matrix.md).
- 🦀 **Shared Rust client core** - Web (`mosaic-wasm`) and Android (`mosaic-uniffi`) call into the same Rust workspace; cross-client byte-equality is enforced by the golden-vector corpus under `tests/vectors/`

## Architecture

```text
┌─────────────┐
│   Browser   │────┐
│ Encrypt/Dec │    │
└─────────────┘    │     ┌─────────────┐     ┌─────────────┐
                   ├────▶│   Backend   │────▶│  PostgreSQL │
┌─────────────┐    │     │  (Storage)  │     │  (Metadata) │
│   Android   │────┘     └─────────────┘     └─────────────┘
│ Encrypt/Dec │                │
└─────────────┘                ▼
                         ┌─────────────┐
                         │ Blob Store  │
                         │  (Shards)   │
                         └─────────────┘
```

## Technology Stack

| Layer | Technology |
| ----- | ---------- |
| Frontend | React 19, Vite 8, TypeScript 5.9 |
| Backend | .NET 10, ASP.NET Core |
| Database | PostgreSQL 16+ |
| Crypto | libsodium (legacy surface) + Rust client core (`crates/`, handle-based facade) |
| Local DB | SQLite-WASM (`fts5-sql-bundle`) + OPFS |
| Uploads | Tus protocol (resumable) |
| Android | Kotlin + Rust UniFFI foundation (`apps/android-main`, developer preview; not a stable release surface) |

## Project Structure

```text
mosaic/
├── apps/
│   ├── web/            # React frontend
│   ├── backend/        # .NET API
│   ├── android-main/   # Android Gradle module (Rust UniFFI APK, foundation slice)
│   └── android-shell/  # JVM-only Kotlin scaffold for the Android bridge contracts
├── crates/             # Rust client-core workspace (mosaic-{domain,crypto,client,
│                       #   media,wasm,uniffi,vectors})
├── libs/
│   └── crypto/         # TypeScript crypto/reference library (@mosaic/crypto)
├── docs/               # Documentation
├── tests/              # Integration, E2E, vectors, architecture checks
└── scripts/            # Deployment scripts
```

## Docker Deployment

> **First time?** See the [Deployment Guide](docs/DEPLOYMENT.md) for step-by-step instructions.

### Quick Start

```bash
# Clone the repository
git clone https://github.com/adsamcik/Mosaic.git
cd Mosaic

# Configure environment
cp .env.example .env
# Edit .env and set strong POSTGRES_PASSWORD and AUTH_SERVER_SECRET values
# (generate each separately with: openssl rand -base64 32)

# Start PostgreSQL, apply the schema explicitly, then start serving
docker compose up -d postgres
docker compose run --rm backend --migrate-only
docker compose up -d --wait

# Check status
docker compose ps

# View logs
docker compose logs -f
```

The application will be available at `http://localhost:8080`.

### Using the Helper Script

For convenience, use the helper script for common operations:

```bash
# Windows (PowerShell)
.\scripts\mosaic.ps1 start     # Start services
.\scripts\mosaic.ps1 status    # Check health
.\scripts\mosaic.ps1 logs      # View logs
.\scripts\mosaic.ps1 backup    # Create backup

# Linux/macOS
./scripts/mosaic.sh start
./scripts/mosaic.sh status
./scripts/mosaic.sh logs
./scripts/mosaic.sh backup
```

`start` assumes the explicit `--migrate-only` initialization above has already
succeeded; it does not apply schema changes. Repeat that boundary before each
schema-bearing upgrade.

### Production Deployment

Before evaluating a production candidate, you should:

1. Set a strong `POSTGRES_PASSWORD` in `.env`
2. Generate and preserve a stable `AUTH_SERVER_SECRET`
3. Put a reverse proxy (Caddy, Traefik, nginx) in front for TLS termination
4. Keep LocalAuth enabled by default; enable ProxyAuth only with an exact,
   independently tested trusted-proxy boundary

**Documentation:**

| Guide | Description |
| ----- | ----------- |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Beginner-friendly deployment guide |
| [DOCKER.md](docs/DOCKER.md) | Complete Docker reference |
| [AUTHELIA.md](docs/AUTHELIA.md) | SSO integration with Authelia |

Topics covered: Building images, reverse proxy setup (Caddy, Traefik, nginx), SSO authentication, backup/restore, multi-architecture builds, CI/CD, and troubleshooting.

### Development with Docker

Use the development compose file for a PostgreSQL database while running the app locally:

```bash
# Start only the database
docker compose -f docker-compose.dev.yml up -d

# Optionally include pgAdmin for DB management
docker compose -f docker-compose.dev.yml --profile tools up -d
```


## Development

### Prerequisites

| Requirement | Version | Check Command |
| ----------- | ------- | ------------- |
| Node.js | 20+ | `node --version` |
| .NET SDK | 10+ | `dotnet --version` |
| Rust | 1.93.1 toolchain; 1.85 MSRV | `rustc --version` |
| Docker | Latest | `docker --version` |

### 🚀 Quick Start (Recommended)

The fastest way to get the development environment running:

```powershell
# Windows (PowerShell)
.\scripts\dev.ps1 start      # Starts database + backend + frontend
.\scripts\dev.ps1 status     # Verify everything is running
```

```bash
# Linux/macOS
./scripts/dev.sh start
./scripts/dev.sh status
```

Once started, open <http://localhost:5173> in your browser.

| Service | URL |
| ------- | --- |
| Frontend | <http://localhost:5173> |
| Backend API | <http://localhost:5000> |
| API Docs | <http://localhost:5000/openapi/v1.json> |

### Development Script Commands

```powershell
# Service Management
.\scripts\dev.ps1 start              # Start all services
.\scripts\dev.ps1 start backend      # Start only backend
.\scripts\dev.ps1 stop               # Stop all services
.\scripts\dev.ps1 restart            # Restart all services
.\scripts\dev.ps1 status             # Show service status

# Logs
.\scripts\dev.ps1 logs backend       # View backend logs (last 50 lines)
.\scripts\dev.ps1 logs frontend      # View frontend logs
.\scripts\dev.ps1 logs backend -f    # Live tail (Ctrl+C to exit)

# Testing
.\scripts\dev.ps1 test               # Run all unit tests
.\scripts\dev.ps1 test e2e           # Run E2E tests

# Maintenance
.\scripts\dev.ps1 reset              # Reset development database
.\scripts\dev.ps1 reset --full       # Reset + remove node_modules
```

### VS Code Tasks

For integrated development, use VS Code tasks:

1. Open the workspace in VS Code
2. Press `Ctrl+Shift+P` → "Tasks: Run Task" → select:

   - **start-all** - Start crypto build → backend → frontend
   - **watch-backend** - Backend with hot reload
   - **watch-frontend** - Vite dev server
   - **test-all** - Run all test suites

Or use launch configurations (F5):

- **Backend + Frontend** - Start both, opens <http://localhost:5173>
- **Full Stack (Debug Both)** - Debug both simultaneously
- **Backend (.NET)** - Just the API with Swagger

### Visual Studio 2022/2026

1. Open `Mosaic.slnx` in Visual Studio
2. Set **Mosaic.Backend** as startup project
3. Press **F5** to run (Swagger opens automatically)
4. For frontend: Run `cd apps/web && npm install && npm run dev` in terminal

### Manual Setup (Without Scripts)

If you prefer to run services manually:

```bash
# 1. Start PostgreSQL (required)
docker compose -f docker-compose.dev.yml up -d

# 2. Build crypto library (required for frontend)
cd libs/crypto && npm install && npm run build

# 3. In terminal 1: Run backend
cd apps/backend/Mosaic.Backend
dotnet run

# 4. In terminal 2: Run frontend
cd apps/web && npm install && npm run dev
```

## Security Model

- **L0-L3 Key Hierarchy** - Master key never leaves the browser
- **Epoch Keys** - Per-album keys that rotate on member changes
- **Manifest Signing** - All photo metadata is signed by uploader
- **Shard Verification** - Downloaded chunks verified against signed hashes

See [docs/SECURITY.md](docs/SECURITY.md) for the full security model.

## Documentation

| Guide | Description |
| ----- | ----------- |
| [Development Guide](docs/DEVELOPMENT.md) | Complete local development setup |
| [Deployment Guide](docs/DEPLOYMENT.md) | Production deployment instructions |
| [Security Model](docs/SECURITY.md) | Threat model and cryptographic design |
| [Architecture](docs/ARCHITECTURE.md) | System design and components |
| [Features](docs/FEATURES.md) | List of implemented features |
| [Changelog](CHANGELOG.md) | Version history and release notes |

## Releases

This checkout is a production-readiness candidate, not a stable release. The
audited repository tag history ends at `v0.2.0`; the v1.0.0 notes and roadmap
are unreleased historical planning records. See
[docs/RELEASE_STATE.md](docs/RELEASE_STATE.md) before interpreting any version
label or artifact claim.

Stable publication is currently fail-closed:
`.github/release-readiness.json` sets `stable_publication_enabled` to `false`
until all eight publicly retrievable, digest-verified, source-commit-bound,
unexpired external evidence records pass independent review. Evidence names
the immutable candidate source commit. A stable tag may point only to its
single non-merge child that changes `.github/release-readiness.json` and
nothing else, avoiding a self-referential commit while preventing unassessed
source or workflow changes.
The publication
workflow then runs the complete supported web/backend suite, builds
multi-architecture candidates by digest, generates SBOM/provenance, verifies a
clean consumer, creates immutable exact-version image tags, and records both
digests in the GitHub Release. Android remains a separately dispatched
developer preview and is never attached to the stable release.

### Using a Verified Published Release

Copy the immutable digests from the matching GitHub Release and verify them
before deployment:

```bash
gh attestation verify oci://ghcr.io/adsamcik/mosaic-backend@sha256:<backend-digest> --repo adsamcik/Mosaic
gh attestation verify oci://ghcr.io/adsamcik/mosaic-frontend@sha256:<frontend-digest> --repo adsamcik/Mosaic

docker pull ghcr.io/adsamcik/mosaic-backend@sha256:<backend-digest>
docker pull ghcr.io/adsamcik/mosaic-frontend@sha256:<frontend-digest>
```

Mosaic does not publish a supported `latest` or moving major/minor tag. A tag,
digest, attestation, or release record that is absent or disagrees is an
unsupported preview artifact.

## Browser Support

These are candidate minimums, not completed production evidence. The
Firefox/WebKit OPFS durability matrix remains a required external release
record while stable publication is disabled.

| Browser     | Minimum Version |
| ----------- | --------------- |
| Chrome/Edge | 102+            |
| Firefox     | 111+            |
| Safari      | 17.4+           |

Requires `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers for SharedArrayBuffer support. Safari 17.4+ is required because earlier Safari versions do not support `Cross-Origin-Embedder-Policy: credentialless`.

## License

[MIT](LICENSE)
