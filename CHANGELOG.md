# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/eivindholvik/Mosaic/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/eivindholvik/Mosaic/releases/tag/v0.0.1
