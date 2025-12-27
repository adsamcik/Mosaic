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

## Development

### Prerequisites

- Node.js 20+
- .NET 10 SDK
- PostgreSQL 16+
- pnpm (recommended)

### Getting Started

```bash
# Clone the repository
git clone https://github.com/your-org/mosaic.git
cd mosaic

# Install frontend dependencies
cd apps/admin
pnpm install

# Run frontend dev server
pnpm dev

# In another terminal, run backend
cd apps/backend
dotnet run
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

## Browser Support

| Browser | Minimum Version |
|---------|-----------------|
| Chrome/Edge | 102+ |
| Firefox | 111+ |
| Safari | 16.4+ |

Requires `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers for SharedArrayBuffer support.

## License

[MIT](LICENSE)
