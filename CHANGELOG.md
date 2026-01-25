# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
