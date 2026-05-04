# Release Process

This document describes how to release a new version of Mosaic.

## Late-v1 Protocol Freeze (declared 2026-04-30)

The late-v1 protocol freeze gate has been declared. Surfaces listed as
"frozen" below are part of the v1 wire contract: any change to them is a
release blocker unless it is shipped with a version bump, migration vectors,
and a SPEC update in the same release train. See
`docs/specs/SPEC-LateV1ProtocolFreeze.md` for the full policy and rationale.

### Frozen surfaces

The following surfaces are byte-level / contract-level frozen as of the
2026-04-30 declaration. Each entry cites the commit that established the
current shape; the shape itself is now locked by a Rust test (see "Lock
tests" below).

- **Shard envelope header — magic `SGzk` (4 bytes), version `0x03`, total
   length 64 bytes, 24-byte nonce, tier byte `1/2/3`, reserved bytes
   `0x00..=0x00` over offsets `38..64`, AAD = entire 64-byte header.**
   Established by `1aa2baa3` (`build(rust): add ffi facade spike`). Locked by
   `crates/mosaic-domain/tests/late_v1_protocol_freeze_lock.rs`.
- **KDF/auth/bundle domain labels — `mosaic:root-key:v1`,
  `mosaic:auth-signing:v1`, `mosaic:tier:thumb:v1`,
  `mosaic:tier:preview:v1`, `mosaic:tier:full:v1`,
  `mosaic:tier:content:v1`, `mosaic:db-session-key:v1`,
  `Mosaic_Auth_Challenge_v1`, and `Mosaic_EpochBundle_v1`.** Locked by
  `crates/mosaic-crypto/tests/kdf_and_auth_label_lock.rs`.
- **Manifest signing transcript context — `Mosaic_Manifest_v1` (UTF-8) at
  transcript version `1`.** Established by `933382ff`
  (`feat(domain): add manifest signing transcript`). Locked by
  `crates/mosaic-domain/tests/late_v1_protocol_freeze_lock.rs`.
- **Metadata sidecar context — `Mosaic_Metadata_v1` (UTF-8) at sidecar
  version `1`.** Established by `58ca56fc`
  (`feat(domain): add encrypted metadata sidecar`). Locked by
  `crates/mosaic-domain/tests/late_v1_protocol_freeze_lock.rs`.
- **`ClientErrorCode` numeric table 0–706 (49 variants, including the Slice
  0C bundle codes 215–222).** Numeric codes are append-only after freeze.
  Slice 0C codes were established by `ee85b8f2`
  (`feat(rust/uniffi): expose raw-input crypto entry points for cross-client
  byte-equality (Slice 0C)`). Locked by
  `crates/mosaic-uniffi/tests/error_code_table.rs`.
- **UniFFI API snapshot — `mosaic-uniffi ffi-spike:v9 …` (Android/Rust
  boundary).** Current value established by `ee85b8f2`
  (`feat(rust/uniffi): expose raw-input crypto entry points …`). Locked by
  `crates/mosaic-uniffi/tests/ffi_snapshot.rs`.
- **WASM API snapshot — `mosaic-wasm ffi-spike:v6 …` (Web/Rust boundary).**
  Current value established by `eeb96973`
  (`feat(ffi): expose client-core state DTO adapters`). Locked by
  `crates/mosaic-wasm/tests/ffi_snapshot.rs`.
- **`PROTOCOL_VERSION = "mosaic-v1"`** and the
  `client-core-state-machines:v1` DTO surface (init/advance for upload + sync,
  `ClientCore*Snapshot/Event/Transition/Effect` records).
- **Backend auth/album/shard route families and current opaque JSON field
  classes** — route paths, HTTP methods, auth requirements, status-code
  classes, required field names, enum values, byte/base64 encodings, cookie
  name `mosaic_session`, ProxyAuth `Remote-User` header, and Tus metadata
  keys (`albumId`, optional `sha256`).
- **Tus transport semantics** — `POST/PATCH/HEAD/DELETE /api/files`, resume
  semantics, completed-uploads-become-pending-opaque-shards behaviour, and
  `GET /api/shards/{shardId}` `X-Content-SHA256` response header.
- **Existing WASM/UniFFI record names, public field names, stable error
  codes, and handle-based secret boundary** — `AccountKeyHandle`,
  `IdentityHandle`, `EpochKeyHandle`, opaque secret references only.
- **Web adapter default id `web-current-upload-sync` and privacy-safe
  selector behaviour** — selector errors must not echo caller-supplied ids.
- **Android foundation privacy contracts and stable Rust-code mappings** —
  `ShellSessionState` separation of server auth vs crypto unlock; queue and
  handoff DTOs persist only opaque IDs, staged app-private references, byte
  counts, timestamps, retry counts, status, and encrypted shard references.
- **Golden-vector schema semantics and required leakage classification
  fields** — `tests/vectors/` schema is the cross-client byte-level truth
  for every frozen protocol operation.

### Explicitly open until v1.x

The following surfaces remain **explicitly open** until Bands 5/6 and the
Android upload work finish; they are not part of the freeze and may evolve
without a version bump (subject to zero-knowledge invariants which are
non-negotiable). Verbatim from
`docs/specs/SPEC-LateV1ProtocolFreeze.md` §"Explicitly open until Bands 5/6
and Android upload finish":

1. **Manifest finalization shape.** Current backend accepts both legacy
   `shardIds` and newer `tieredShards`; Rust canonical transcript work is
   stricter than the live web manifest path. The final late-v1 manifest
   create/read shape remains open until Android upload proves the exact
   tier/hash/version fields.
2. **Rust upload/sync state-machine DTO semantics.** Snapshot/event/effect
   names exist today, but retry, manifest-unknown recovery, sync confirmation,
   and platform side-effect mapping remain open while Bands 5/6 land.
3. **Web Rust client-core adapter cutover.** The default web adapter
   intentionally delegates to TypeScript upload/sync. Adding a Rust
   upload/sync adapter remains open until generated WASM bindings and web
   platform ports stabilize.
4. **Android real upload wiring.** The JVM shell has privacy-safe contracts
   only. Real Android app/Gradle module, Room persistence, generated UniFFI
   Kotlin, WorkManager, Tus transport, and manifest commit integration remain
   open.
5. **Media codec/tier generation adapter.** Dependency-free layout/planning
   exists; real JPEG/WebP/AVIF/HEIC codec choices and deterministic stripping
   tests remain open before Android upload consumes the adapter.
6. **Album story/content document shape.** `album content` API currently
   stores one encrypted opaque document with nonce/version. The internal
   encrypted block schema and any server-visible concurrency fields remain
   open for Band 5/6 story/content work.
7. **Web encrypted local cache strategy.** `db.worker.ts` still owns OPFS
   snapshot encryption via TypeScript compatibility code; this is not
   resolved by Android upload and remains open until a separate storage
   decision.

### Versioning rules

Per `docs/specs/SPEC-LateV1ProtocolFreeze.md` §"Versioning and freeze gate
rules":

- **Numeric error codes are append-only.** Existing `ClientErrorCode`
  numeric values must not be reused, renumbered, or reinterpreted. Adding a
  variant requires appending it at the end and updating the lock test in the
  same change.
- **Byte-format changes need version-byte bumps + new vectors + a dual-reader
  plan.** Shard envelope magic, version, header layout, nonce length,
  reserved-byte policy, AAD rule, manifest transcript context/version, and
  metadata sidecar context/version are byte-level frozen. Any change requires
  a new explicit version byte or context label, new positive and negative
  vectors under `tests/vectors/`, dual-reader compatibility or migration
  plan, and proof that old clients fail safely.
- **FFI snapshot bumps require an ADR.** Bumping `uniffi_api_snapshot()`
  beyond `ffi-spike:v9` or `wasm_api_snapshot()` beyond `ffi-spike:v6`
  requires a documented architecture decision record, regenerated bindings,
  wrapper parity tests on native Rust + WASM + UniFFI, and a coordinated
  release train. Raw-secret outputs across the FFI boundary remain forbidden
  pending an ADR, threat-model update, and memory-wipe proof.

### Lock tests

The following Rust unit tests fail at compile or assertion time when any
frozen surface drifts. CI runs them as part of `cargo test --workspace
--locked` so a contract change cannot land without an explicit lock-test
update.

| Frozen surface | Lock test file | Asserts |
|---|---|---|
| UniFFI API snapshot (`ffi-spike:v9`) | `crates/mosaic-uniffi/tests/ffi_snapshot.rs` | Byte-exact equality of `uniffi_api_snapshot()` and the version-label prefix. |
| WASM API snapshot (`ffi-spike:v6`) | `crates/mosaic-wasm/tests/ffi_snapshot.rs` | Byte-exact equality of `wasm_api_snapshot()` and the version-label prefix. |
| `ClientErrorCode` numeric table | `crates/mosaic-uniffi/tests/error_code_table.rs` | Variant order, names, and numeric values for all 49 codes (0–706); collision check across the live table. |
| Shard envelope header (`SGzk`/`0x03`/64 bytes/reserved-zero) | `crates/mosaic-domain/tests/late_v1_protocol_freeze_lock.rs` | Magic bytes, version byte, header length, encode-side reserved-zero, decode-side `NonZeroReservedByte` enforcement at every reserved offset. |
| `ShardTier` byte discriminants | `crates/mosaic-domain/tests/late_v1_protocol_freeze_lock.rs::shard_tier_byte_discriminants_locked` | Thumbnail `1`, preview `2`, original `3`; rejects `0` and `4`. |
| Manifest transcript context (`Mosaic_Manifest_v1`, v1) | `crates/mosaic-domain/tests/late_v1_protocol_freeze_lock.rs` | Byte-exact context value, length, and transcript version constant. |
| Metadata sidecar context (`Mosaic_Metadata_v1`, v1) | `crates/mosaic-domain/tests/late_v1_protocol_freeze_lock.rs` | Byte-exact context value, length, and sidecar version constant. |
| Manifest ↔ metadata domain separation | `crates/mosaic-domain/tests/late_v1_protocol_freeze_lock.rs` | The two contexts must remain distinct. |
| KDF/auth/bundle labels | `crates/mosaic-crypto/tests/kdf_and_auth_label_lock.rs` | Byte-exact equality for root/auth/tier/content/DB-session KDF labels plus LocalAuth challenge and epoch-bundle signing contexts. |
| Late-v1 spec coverage | `crates/mosaic-domain/tests/late_v1_protocol_freeze_spec.rs` | The SPEC document continues to reference every contract domain. |

## Prerequisites

- All tests passing on `main` branch
- CHANGELOG.md updated with release notes
- All package versions synchronized

## Release Checklist

### Before Release

- [ ] All tests pass locally: `.\scripts\run-tests.ps1 -Suite all`
- [ ] Tests pass in CI (check GitHub Actions)
- [ ] Docker images build successfully locally:
  ```bash
  docker build -t mosaic-backend-test -f apps/backend/Mosaic.Backend/Dockerfile apps/backend/Mosaic.Backend
  docker build -t mosaic-frontend-test -f apps/web/Dockerfile .
  ```
- [ ] Full stack smoke test:
  ```bash
  docker compose up -d
  # Wait for health checks
  docker compose ps
  # Verify frontend accessible at http://localhost:8080
  docker compose down -v
  ```
- [ ] CHANGELOG.md has entry for new version with today's date
- [ ] Version numbers synchronized:
  - [ ] `apps/web/package.json` - version field
  - [ ] `libs/crypto/package.json` - version field  
  - [ ] `apps/backend/Mosaic.Backend/Mosaic.Backend.csproj` - Version, AssemblyVersion, FileVersion

### Creating the Release

1. **Create and push the version tag:**
   ```bash
   # Ensure you're on main with latest changes
   git checkout main
   git pull origin main
   
   # Create annotated tag
   git tag -a v0.0.1 -m "Release v0.0.1"
   
   # Push the tag
   git push origin v0.0.1
   ```

2. **Monitor the publish workflow:**
   - Go to GitHub Actions → "Publish Docker Images"
   - Verify all jobs complete successfully:
     - [ ] Test job passes
     - [ ] Backend image published to ghcr.io
     - [ ] Frontend image published to ghcr.io
     - [ ] GitHub Release created

3. **Verify the release:**
   - Check the GitHub Release page for correct release notes
   - Verify Docker images are accessible:
     ```bash
     docker pull ghcr.io/eivindholvik/mosaic-backend:0.0.1
     docker pull ghcr.io/eivindholvik/mosaic-frontend:0.0.1
     ```

### After Release

- [ ] Announce the release (if applicable)
- [ ] Update any external documentation
- [ ] Bump version in package files for next development cycle (optional)

## Version Numbering

Mosaic follows [Semantic Versioning](https://semver.org/):

- **MAJOR** (0.x.x → 1.x.x): Breaking changes, API incompatibilities
- **MINOR** (x.0.x → x.1.x): New features, backward compatible
- **PATCH** (x.x.0 → x.x.1): Bug fixes, backward compatible

### Pre-1.0 Versioning

During the 0.x.x phase:
- Minor version bumps may include breaking changes
- API stability is not guaranteed
- Focus is on feature completion and stabilization

## Docker Image Tags

The publish workflow creates the following tags for each release:

| Tag | Example | Purpose |
|-----|---------|---------|
| `version` | `0.0.1` | Specific version |
| `major.minor` | `0.0` | Latest patch for minor version |
| `major` | `0` | Latest for major version (not for v0.x) |
| `latest` | `latest` | Most recent stable release |
| `sha-xxxxx` | `sha-a1b2c3d` | Specific commit (for non-release builds) |

## Troubleshooting

### Publish workflow failed

1. Check the GitHub Actions logs for specific error
2. Common issues:
   - Tests failed: Fix the failing tests and re-tag
   - Docker build failed: Fix Dockerfile and re-tag
   - Authentication failed: Check GITHUB_TOKEN permissions

### Re-releasing a version

If you need to re-release the same version (not recommended):

```bash
# Delete the tag locally and remotely
git tag -d v0.0.1
git push origin :refs/tags/v0.0.1

# Delete the GitHub Release (via web UI)

# Re-create the tag
git tag -a v0.0.1 -m "Release v0.0.1"
git push origin v0.0.1
```

### Manual image push (emergency)

If CI is broken but you need to publish:

```bash
# Login to GHCR
echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin

# Build and push manually
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/eivindholvik/mosaic-backend:0.0.1 \
  -f apps/backend/Mosaic.Backend/Dockerfile \
  apps/backend/Mosaic.Backend --push

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/eivindholvik/mosaic-frontend:0.0.1 \
  -f apps/web/Dockerfile . --push
```

## Files Updated Per Release

| File | Update Needed |
|------|---------------|
| `CHANGELOG.md` | Add release section with date |
| `apps/web/package.json` | Update `version` field |
| `libs/crypto/package.json` | Update `version` field |
| `apps/backend/Mosaic.Backend/Mosaic.Backend.csproj` | Update version properties |
