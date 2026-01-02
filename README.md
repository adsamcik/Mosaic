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

## Architecture

```
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
|-------|------------|
| Frontend | React 19, Vite, TypeScript |
| Backend | .NET 10, ASP.NET Core |
| Database | PostgreSQL 16+ |
| Crypto | libsodium (XChaCha20-Poly1305, Ed25519, Argon2id) |
| Local DB | SQLite-WASM + OPFS |
| Uploads | Tus protocol (resumable) |

## Project Structure

```
mosaic/
├── apps/
│   ├── admin/          # React frontend
│   └── backend/        # .NET API
├── libs/
│   └── crypto/         # Shared crypto library
├── docs/               # Documentation
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
|-------|-------------|
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Beginner-friendly deployment guide |
| [DOCKER.md](docs/DOCKER.md) | Complete Docker reference |

Topics covered: Building images, reverse proxy setup (Caddy, Traefik, nginx), backup/restore, multi-architecture builds, CI/CD, and troubleshooting.

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

- Node.js 20+
- .NET 10 SDK
- PostgreSQL 16+ (or use Docker, or use SQLite in development)

### VS Code (Recommended)

1. Open the workspace in VS Code
2. Press **F5** or select a launch configuration:
   - **Backend + Frontend** - Start both, opens http://localhost:5173
   - **Full Stack (Debug Both)** - Debug both simultaneously
   - **Backend (.NET)** - Just the API with Swagger
3. SQLite database auto-created in `./data/mosaic.db`

No Docker required for development!

### Visual Studio 2022/2026

1. Open `Mosaic.slnx` in Visual Studio
2. Set **Mosaic.Backend** as startup project
3. Press **F5** to run (Swagger opens automatically)
4. For frontend: Open terminal, run:
   ```bash
   cd apps/admin
   npm install
   npm run dev
   ```

Backend runs on http://localhost:5000, frontend on http://localhost:5173.

### Command Line

```bash
# Start PostgreSQL (optional - SQLite used by default in dev)
docker compose -f docker-compose.dev.yml up -d

# Install frontend dependencies
cd apps/admin
npm install

# Run frontend dev server
npm run dev

# In another terminal, run backend
cd apps/backend/Mosaic.Backend
dotnet run
```

### Helper Scripts

Use `dev.ps1` / `dev.sh` for Docker-based development:

```bash
# Windows
.\scripts\dev.ps1 up         # Start PostgreSQL
.\scripts\dev.ps1 backend    # Run backend with hot-reload
.\scripts\dev.ps1 frontend   # Run Vite dev server

# Linux/macOS
./scripts/dev.sh up
./scripts/dev.sh backend
./scripts/dev.sh frontend
```

## Security Model

- **L0-L3 Key Hierarchy** - Master key never leaves the browser
- **Epoch Keys** - Per-album keys that rotate on member changes
- **Manifest Signing** - All photo metadata is signed by uploader
- **Shard Verification** - Downloaded chunks verified against signed hashes

See [docs/SECURITY.md](docs/SECURITY.md) for the full security model.

## Documentation

- [Implementation Plan](docs/IMPLEMENTATION_PLAN.md) - Detailed technical specification
- [Security Model](docs/SECURITY.md) - Threat model and cryptographic design
- [Changelog](CHANGELOG.md) - Version history and release notes

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
