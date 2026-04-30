# Mosaic

A zero-knowledge encrypted photo gallery for personal use.

## Overview

Mosaic is a self-hosted photo gallery where the server never sees your photos. All encryption and decryption happens in your browser using modern cryptographic primitives.

**Target Scale:** ≤50 users

## Features

- 🔐 **End-to-end encryption** - Photos encrypted before upload, decrypted in browser
- 🖼️ **Gallery management** - Organize photos into albums
- 👥 **Secure sharing** - Share albums with family using epoch-based keys
- 🗺️ **Map view** - Browse photos by location (GPS metadata encrypted)
- 🔍 **Full-text search** - Search photo metadata (client-side)
- 📱 **Offline capable** - Local database with sync
- 🦀 **Shared Rust client core** - Web (`mosaic-wasm`) and Android (`mosaic-uniffi`) call into the same audited Rust workspace; cross-client byte-equality is enforced by the golden-vector corpus under `tests/vectors/`

## Architecture

```text
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Browser   │────▶│   Backend   │────▶│  PostgreSQL │
│  (Encrypt)  │     │  (Storage)  │     │  (Metadata) │
└─────────────┘     └─────────────┘     └─────────────┘
      │                    │
      │                    ▼
      │             ┌─────────────┐
      └────────────▶│ Blob Store  │
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
| Android | Kotlin 2.0 + AGP 8.7 + Rust UniFFI core (`apps/android-main`, foundation slice) |

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
# Edit .env and set POSTGRES_PASSWORD (generate with: openssl rand -base64 32)

# Build and start all services
docker compose up -d

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

### Production Deployment

For production, you should:

1. Set a strong `POSTGRES_PASSWORD` in `.env`
2. Put a reverse proxy (Caddy, Traefik, nginx) in front for TLS termination
3. Configure your reverse proxy to pass the `Remote-User` header for authentication

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

Mosaic uses GitHub Container Registry for Docker images. To create a new release:

```bash
# Tag a version (triggers publish workflow)
git tag v0.0.1
git push origin v0.0.1
```

This will:

1. Run all tests (crypto, frontend, backend)
2. Build multi-architecture Docker images (amd64, arm64)
3. Push to `ghcr.io/eivindholvik/mosaic-backend` and `ghcr.io/eivindholvik/mosaic-frontend`
4. Create a GitHub Release with image digests

### Using Published Images

```bash
# Pull the latest release
docker pull ghcr.io/eivindholvik/mosaic-backend:latest
docker pull ghcr.io/eivindholvik/mosaic-frontend:latest

# Or a specific version
docker pull ghcr.io/eivindholvik/mosaic-backend:0.0.1
docker pull ghcr.io/eivindholvik/mosaic-frontend:0.0.1
```

## Browser Support

| Browser     | Minimum Version |
| ----------- | --------------- |
| Chrome/Edge | 102+            |
| Firefox     | 111+            |
| Safari      | 16.4+           |

Requires `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers for SharedArrayBuffer support.

## License

[MIT](LICENSE)
