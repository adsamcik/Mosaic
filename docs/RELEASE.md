# Release Process

This document describes the candidate release procedure and retains historical protocol-freeze records for traceability.

> **Audit status (2026):** This checkout is not approved for production release.
> The procedures below do not supersede the open production-readiness blockers.
> [RELEASE_STATE.md](RELEASE_STATE.md) is authoritative for current maturity,
> supported surfaces, and the evidence required to prove a stable artifact.

## Stable publication is currently disabled

`.github/release-readiness.json` is machine-enforced by the first stable
release-contract job. It currently has `stable_publication_enabled: false` and
an empty `external_evidence` object, so every stable tag fails closed before
tests or image builds.

Do not create a stable tag or flip the flag until all eight required evidence
records listed in [RELEASE_STATE.md](RELEASE_STATE.md#fail-closed-readiness-manifest)
have been independently reviewed. Each record must be `passed`, link to a
publicly retrievable HTTPS artifact, bind its verified lowercase SHA-256,
identify the same full `assessed_source_commit`, and carry a future
timezone-aware expiry.

The assessed source commit must be the sole parent of the tagged approval
commit. That non-merge approval commit may modify only
`.github/release-readiness.json`; every source, build, workflow, test, and
documentation byte therefore remains the assessed candidate. The workflow
downloads and hashes every artifact, enforces that evidence-only diff, and
attaches the retained evidence bundle to the GitHub Release. Prose, an issue
reference, or an unbound test result cannot substitute for manifest evidence.

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
- **Tus transport semantics** — `POST/PATCH/HEAD/DELETE /api/v1/files`, resume
  semantics, completed-uploads-become-pending-opaque-shards behaviour, and
  `GET /api/v1/shards/{shardId}` `X-Content-SHA256` response header.
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

## Android developer-preview signing secrets

Android is a developer-preview surface and is not part of a stable release. The `android-preview` job inside `.github/workflows/publish.yml` runs only when a maintainer manually dispatches the workflow with `android_preview=true`. It builds and signs preview APK/AAB artifacts only after the five secrets below are present; stable tags never produce Android artifacts.

Operators self-hosting Mosaic must configure these on the repository (or organization) under **Settings → Secrets and variables → Actions → New repository secret**.

| Secret name | Description | How to generate | Consumed by | Failure mode if absent |
|-------------|-------------|------------------|-------------|------------------------|
| `MOSAIC_RELEASE_PINS` | ADR-019 SPKI certificate pins for the operator's reverse-proxy TLS chain. One `sha256/<base64>` pin per line. Injected verbatim into `apps/android-main/src/main/assets/adr019-pins.txt` at build time. | `openssl x509 -in cert.pem -pubkey -noout \| openssl pkey -pubin -outform der \| openssl dgst -sha256 -binary \| base64` — repeat per certificate in the chain you want to pin (leaf + at least one backup). | `android-preview` (`detect-android-preview-secrets` + `Inject preview pins and signing key` step) | Explicit preview dispatch fails before build and names this secret. |
| `MOSAIC_RELEASE_KEYSTORE_BASE64` | Base64-encoded JKS/PKCS12 keystore containing the Android release signing key. Decoded into a temporary file under `$RUNNER_TEMP` and exposed to Gradle via `MOSAIC_RELEASE_KEYSTORE`. | `base64 -w0 -i path/to/release.keystore > keystore.b64` (Linux/macOS) or `[Convert]::ToBase64String([IO.File]::ReadAllBytes('release.keystore')) \| Out-File keystore.b64 -Encoding ascii` (PowerShell). Paste the entire file contents into the secret value. | `android-preview` (`Inject preview pins and signing key` step → Gradle signing config) | Explicit preview dispatch fails before build and names this secret. |
| `MOSAIC_RELEASE_KEYSTORE_PASSWORD` | Password protecting the keystore file itself (the outer password supplied to `keytool` at keystore-creation time). | Whatever password was set with `keytool -genkeypair -storepass …`. Treat as long-lived — losing it locks you out of signing future releases under this key. | `android-preview` (Gradle `signingConfigs.release.storePassword`) | Explicit preview dispatch fails before build and names this secret. |
| `MOSAIC_RELEASE_KEY_ALIAS` | Alias of the signing key entry inside the keystore (the `-alias` value used when the key was generated). | Whatever alias was set with `keytool -genkeypair -alias …`. Default Mosaic guidance is `mosaic-release`. | `android-preview` (Gradle `signingConfigs.release.keyAlias`) | Explicit preview dispatch fails before build and names this secret. |
| `MOSAIC_RELEASE_KEY_PASSWORD` | Password protecting the individual key entry (the `-keypass` value). May equal `MOSAIC_RELEASE_KEYSTORE_PASSWORD` but is configured separately so the operator can rotate key passwords without rotating the keystore password. | Whatever password was set with `keytool -genkeypair -keypass …`. | `android-preview` (Gradle `signingConfigs.release.keyPassword`) | Explicit preview dispatch fails before build and names this secret. |

### Dispatching a preview build

To create a preview build, manually dispatch `publish.yml` with `android_preview=true`. The workflow fails before building if any signing or pin secret is absent.

Preview APK/AAB artifacts are not attached to stable GitHub releases and must not be represented as a supported gallery client.

### Rotating the signing key

Android requires the **same signing key** for every release of a given app installation — replacing the key locks existing installs out of updates unless Play App Signing is used. When rotating:

1. Generate the new keystore (`keytool -genkeypair …`).
2. Re-encode (`base64 -w0`) and update `MOSAIC_RELEASE_KEYSTORE_BASE64`.
3. Update `MOSAIC_RELEASE_KEYSTORE_PASSWORD` / `MOSAIC_RELEASE_KEY_ALIAS` / `MOSAIC_RELEASE_KEY_PASSWORD` to match the new keystore.
4. Communicate the rotation to existing installs (force-reinstall, or Play App Signing migration).

> ⚠️ **Never commit the keystore or its passwords to the repository.** The `.copilotignore` and `.gitignore` exclude `*.keystore` and `*.jks` at the repo root; verify locally with `git check-ignore` before staging.

## Backup Consistency Constraint (Operators)

> **Current operator requirement (historical workstream s44-y3):** Self-hosting operators MUST treat the Postgres
> database and the `data/blobs/` filesystem region as a **single
> point-in-time snapshot pair**. Backing them up at different times
> produces a logically inconsistent restore.

### Why the database and the blobs are coupled

Mosaic stores two halves of every photo:

- **Postgres** holds the signed manifest entries: shard IDs, tier
  pointers, ordering, and ownership. The backend treats manifests as
  authoritative — if a manifest entry exists, the backend believes the
  corresponding shard exists.
- **`data/blobs/`** holds the encrypted shard payloads (the opaque
  `byte[]` blobs the backend never decrypts). The filesystem is the
  authoritative store of shard bytes.

A consistent restore requires that **every manifest row in Postgres
references a shard that exists on disk, and vice versa for any shard
the live system is expected to serve.** Garbage collection assumes this
invariant when it sweeps unreferenced blobs.

### The skew failure mode

If the two backup streams are captured at different points in time, the
restored system enters one of two broken states:

| Order at restore | Symptom | Severity |
|------------------|---------|----------|
| **DB newer than blobs** (Postgres captured after `data/blobs/`) | Manifest rows reference shard IDs whose files are missing on disk. Photo loads 404; clients see "shard not found" decryption failures. | High — user-visible data loss appearance even though plaintext was never on the server. |
| **Blobs newer than DB** (`data/blobs/` captured after Postgres) | Disk holds shard files that no manifest row references. Storage is inflated but the system is otherwise correct. | Low — a normal GC pass reclaims the orphans. |

The dangerous direction is **DB newer than blobs**. Even though no
plaintext is at risk (the zero-knowledge invariant is unaffected — the
server never had plaintext to begin with), users perceive photos as
permanently lost because the client cannot fetch shards that the
manifest claims should exist.

### How to back up safely

Capture both stores at the same logical instant. Three patterns work:

1. **Storage-level snapshot** (preferred): take a filesystem/volume
   snapshot (LVM, ZFS, btrfs, EBS, etc.) on the host that contains
   *both* the Postgres data directory and the `data/blobs/` tree, then
   copy off the snapshot. The snapshot is atomic across both.
2. **Brief read-only window**: quiesce writes (stop the backend, or
   put it in read-only maintenance mode), run `pg_basebackup` /
   `pg_dump --format=custom` and a `rsync`/`borg` of `data/blobs/`
   back-to-back, then resume.
3. **Streaming + checkpoint**: run `pg_basebackup` with WAL streaming
   to the same wall-clock window as a continuous `borg create` of
   `data/blobs/`, then prune both archives to the same checkpoint.

For the supplied Docker Compose deployment, the canonical helpers
`./scripts/mosaic.sh backup` and `./scripts/mosaic.sh restore <dir>`
implement pattern 2: they stop a running backend, capture a custom
Postgres dump and blob archive, hash-bind the pair, and refuse a
restore whose pair does not verify. The PowerShell helper provides the
same paired-snapshot contract. The systemd template in
`docs/operations/BACKUP.md` is for customized non-Compose installations
only.

### Recovery: dangling manifest entries after a skewed restore

If a restore goes wrong and Postgres references shards that are not on
disk:

1. **Stop the backend** so clients do not keep hitting 404s and so GC
   does not race the recovery.
2. **Inventory the gap.** Cross-reference manifest shard IDs against
   `data/blobs/` and produce the set of `missing_shard_ids` whose
   manifest row exists but whose file does not.
3. **Restore the blobs from the newer backup** if one exists (the
   common case after a skew incident is that you have a *later*
   `data/blobs/` snapshot than the DB snapshot you restored from —
   apply it). After this step, the invariant holds.
4. **If no newer blob backup exists**, the affected photos are
   unrecoverable on the server side. Mark the manifest rows so the
   client surfaces a clear error rather than retrying decryption.
   Then **rerun GC**: GC will not delete the dangling rows by itself
   (GC only collects unreferenced *blobs*), so the manifest cleanup is
   an operator action. Once the manifest rows for `missing_shard_ids`
   are removed, **rerun GC** so any half-uploaded blobs that may have
   been left over from the original incident are reclaimed.
5. Restart the backend and verify with a sample of recent uploads.

The full recovery procedure, including a sample inventory script, is
maintained alongside the backup templates in
`docs/operations/BACKUP.md`.

## Release Checklist

### Before Release

- [ ] All tests pass locally: `.\scripts\run-tests.ps1 -Suite all`
- [ ] Tests pass in CI (check GitHub Actions)
- [ ] Docker images build successfully locally:
  ```bash
  docker build -t mosaic-backend-test -f apps/backend/Mosaic.Backend/Dockerfile .
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

1. **Create the evidence-only approval commit and push the version tag:**
   ```bash
   git checkout main
   git pull --ff-only origin main

   # Record this immutable candidate in every assessed_source_commit field.
   assessed_source_commit="$(git rev-parse HEAD)"
   # After independent review, edit only the readiness manifest: add all eight
   # verified records and set stable_publication_enabled to true.
   git add .github/release-readiness.json
   test "$(git diff --cached --name-only)" = ".github/release-readiness.json"
   git commit -m "chore(release): approve v0.0.1 evidence"
   test "$(git rev-parse HEAD^)" = "$assessed_source_commit"

   git tag -a v0.0.1 -m "Release v0.0.1"
   git push origin main
   git push origin v0.0.1
   ```

2. **Monitor the publish workflow:**
   - Go to GitHub Actions → "Publish Mosaic Artifacts"
   - Verify all jobs complete successfully:
     - [ ] Annotated exact SemVer tag peels to an evidence-only, non-merge
       commit on `main` whose sole parent is the assessed source commit
     - [ ] Every public evidence artifact downloads, hashes correctly, remains
       unexpired, and is retained for the GitHub Release
     - [ ] Complete immutable web/backend assurance passes at the tag commit
     - [ ] Backend and frontend candidates are built by digest with SBOM and provenance
     - [ ] Signed GitHub attestations and registry evidence verify
     - [ ] A clean consumer pulls both digests and passes label, health,
       registration, album creation, upload, reload-persistence, and logout checks
     - [ ] Exact-version tags are promoted without moving an existing stable tag
     - [ ] Digest-bound GitHub Release is created

   Stable tags are created only after the external evidence is complete. Image
   promotion and GitHub Release creation occur only after assurance and the
   clean-consumer checks pass. There is no stable E2E bypass or manual
   stable-image publish input.

3. **Verify the release:**
   - Check that the GitHub Release records both immutable image digests.
   - Pull the exact version tags:
     ```bash
     docker pull ghcr.io/adsamcik/mosaic-backend:0.0.1
     docker pull ghcr.io/adsamcik/mosaic-frontend:0.0.1
     ```
   - Verify each digest copied from the release notes:
     ```bash
     gh attestation verify oci://ghcr.io/adsamcik/mosaic-backend@sha256:<digest> --repo adsamcik/Mosaic
     gh attestation verify oci://ghcr.io/adsamcik/mosaic-frontend@sha256:<digest> --repo adsamcik/Mosaic
     ```
   - Run the documented deployment smoke test using those digest references,
     not locally rebuilt substitutes.

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

The publish workflow creates only an exact-version stable tag. Release notes
also record the immutable digest, which is the preferred deployment reference.

| Reference | Example | Purpose |
|-----------|---------|---------|
| Exact version | `0.0.1` | Stable tag; may never move to a different digest |
| Digest | `sha256:…` | Immutable artifact identity used by attestations and release notes |

Temporary `candidate-<run>-<attempt>` tags are non-stable build plumbing and
must not be used in production deployment configuration.

## Troubleshooting

### Publish workflow failed

1. Check the GitHub Actions logs for the first failed assurance, evidence, or
   clean-consumer step.
2. Common issues:
   - Tests failed: fix the source on `main` and issue a new patch version.
   - Candidate build failed: fix the Dockerfile and issue a new patch version.
   - Attestation failed: restore `id-token`/`attestations` permissions; do not
     promote the candidate manually.
   - Existing stable tag points elsewhere: treat this as an integrity incident.

Never delete/re-create a stable Git tag, move a stable image tag, or manually
push a nominally stable replacement. Emergency artifacts require an explicitly
non-stable channel and an independently approved incident record; this workflow
does not provide a stable bypass.

## Files Updated Per Release

| File | Update Needed |
|------|---------------|
| `CHANGELOG.md` | Add release section with date |
| `apps/web/package.json` | Update `version` field |
| `libs/crypto/package.json` | Update `version` field |
| `apps/backend/Mosaic.Backend/Mosaic.Backend.csproj` | Update version properties |
