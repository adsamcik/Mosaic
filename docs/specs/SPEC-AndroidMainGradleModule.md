# SPEC: Android Main Gradle Module — wire Rust core into a real Android app

## Status

Approved by user; implemented at commit time.

This SPEC explicitly overrides the gate stated in `apps/android-shell/README.md`
("*Do not add real upload/networking or codec work until those dependencies
land*") at the user's direction. The override is scoped to standing up the
Gradle/Android baseline and consuming the existing UniFFI bindings — not to
adding real upload/networking or codec work.

## Goals

1. Stand up the first real Android Gradle application module, `apps/android-main`,
   that compiles and produces an APK (`assembleDebug`).
2. Consume the already-generated UniFFI Kotlin bindings produced by
   `scripts/build-rust-android.{ps1,sh}` (currently at
   `target/android/kotlin/uniffi/mosaic_uniffi/mosaic_uniffi.kt`, ~87 KB,
   2 139 lines, JNA-based, package `uniffi.mosaic_uniffi`).
3. Package the Rust `cdylib` (`libmosaic_uniffi.so`) for the two ABIs the
   existing build script produces (`arm64-v8a`, `x86_64`) and load it via
   JNA at runtime.
4. Replace every test-fake `GeneratedRust*Api` consumer in `apps/android-shell`
   with a real adapter (`apps/android-main`) that delegates to the generated
   `uniffi.mosaic_uniffi.*` top-level functions.
5. Close the FFI surface drift identified in the audit: surface the missing
   identity, epoch, shard encrypt/decrypt, media inspect / tier-plan, metadata
   sidecar, album-sync, header, and progress-probe operations to the Kotlin
   contract layer.
6. Add a minimal but real APK that proves the wiring works end-to-end (a
   `MainActivity` that calls `protocolVersion()` and an instrumented smoke
   test that round-trips an `unlockAccountKey` error).
7. Document the new module per repo conventions and add it to CI.

## Non-Goals

- Real photo picker integration with the Android system Photo Picker UI.
- Real Tus upload / network plumbing.
- Real media codec / tier-generation work.
- Real WorkManager scheduling.
- Real account creation / login flow.
- A polished UI.
- Migrating existing `apps/android-shell` tests away from the JVM-only
  scaffold; android-shell remains the fast JVM-only contract layer and the
  source of truth for `GeneratedRust*Api` interfaces.

## Data Flow

```text
1. Build pipeline (developer / CI):

   cargo ndk -p mosaic-uniffi --release  (arm64-v8a, x86_64)
     -> target/android/{abi}/libmosaic_uniffi.so

   cargo build -p mosaic-uniffi --release   (host)
     -> target/release/mosaic_uniffi.{dll|so|dylib}

   uniffi-bindgen generate --library --language kotlin
     -> target/android/kotlin/uniffi/mosaic_uniffi/mosaic_uniffi.kt

   apps/android-main pre-assemble Gradle task:
     - copies target/android/kotlin/.../mosaic_uniffi.kt
       into apps/android-main/build/generated/uniffi/  (NOT committed)
     - copies target/android/{arm64-v8a,x86_64}/libmosaic_uniffi.so
       into apps/android-main/build/generated/jniLibs/{abi}/

   gradlew :apps:android-main:assembleDebug
     -> apps/android-main/build/outputs/apk/debug/android-main-debug.apk
        (contains lib/{arm64-v8a,x86_64}/libmosaic_uniffi.so + JNA aar)

2. Runtime (Android device or emulator):

   Activity onCreate
     -> AndroidRustAccountApi (delegates to uniffi.mosaic_uniffi.unlockAccountKey)
     -> uniffi.mosaic_uniffi.UniffiLib.INSTANCE   (JNA)
     -> Native.register("mosaic_uniffi")
     -> System.loadLibrary("mosaic_uniffi") via JNA
     -> Rust mosaic_uniffi::unlock_account_key(...)
     -> mosaic_client / mosaic_crypto / Argon2id / chacha20poly1305
     -> AccountUnlockResult { code, handle: u64 }
     -> Kotlin AccountUnlockResult
     -> AccountKeyHandle wrapper (opaque Long)

3. Plaintext never leaves the device. The data crossing the
   client / server boundary in this slice is: NONE. This module does not
   talk to the backend. The only data crossing the JVM↔native boundary
   is opaque (handles, status codes, ciphertext, AAD bytes).
```

## Zero-Knowledge and Privacy Invariants

- The new `apps/android-main` module never logs plaintext photos, captions,
  EXIF/GPS, device metadata, decrypted metadata, passwords, raw keys, or
  filenames. All `toString()` overrides on bridge DTOs continue the
  `<redacted>` pattern established in `apps/android-shell`.
- The Activity's smoke `unlockAccountKey` call uses synthetic non-secret
  test parameters (zero-byte salts of fixed length, a deliberately weak KDF
  profile that the Rust core will reject with `KDF_PROFILE_TOO_WEAK = 208`).
  Real account material is never used in the smoke path.
- Password buffers passed across FFI are wiped immediately after the call
  via the existing `RustAccountBridge.unlockAccountAndWipePassword` helper.
- Native libraries are loaded only from the APK's own `lib/{abi}/` via
  `System.loadLibrary("mosaic_uniffi")` — no `dlopen` of arbitrary paths,
  no app-private filesystem unpack of `.so` files, no `setProperty(
  "uniffi.component.mosaic_uniffi.libraryOverride", ...)` in production
  code (test-only override is permitted in `androidTest/`).
- The APK is built with `android:allowBackup="false"`,
  `android:debuggable` only in debug builds (default behavior),
  no exported components other than the launcher activity, and minSdk
  ≥ 26 to ensure scoped storage / SafetyNet baselines.
- abiFilters are restricted to `arm64-v8a` and `x86_64`; no 32-bit `.so`
  is shipped (matches what `cargo-ndk` produces in the existing pipeline).
- No INTERNET permission, no READ_EXTERNAL_STORAGE, no
  MANAGE_EXTERNAL_STORAGE, no READ_MEDIA_* in this slice. The manifest
  policy stub from `apps/android-shell/AutoImportMediaPolicy.kt` continues
  to govern *future* permission additions.
- Static manifest test asserts the above forbidden permissions are absent.

## Component Tree

```text
apps/android-main/
  README.md
  .instructions.md
  build.gradle.kts                     # AGP 8.7.x application module
  proguard-rules.pro                   # keep rules for uniffi.mosaic_uniffi.*
  src/main/
    AndroidManifest.xml
    kotlin/org/mosaic/android/main/
      MainActivity.kt                  # smoke screen — protocolVersion() + bogus unlock
      MosaicApplication.kt             # Application class, no-op for now
      bridge/
        AndroidRustAccountApi.kt       # delegates to uniffi.mosaic_uniffi.*
        AndroidRustIdentityApi.kt
        AndroidRustEpochApi.kt
        AndroidRustShardApi.kt
        AndroidRustMediaApi.kt
        AndroidRustMetadataSidecarApi.kt
        AndroidRustAlbumSyncApi.kt
        AndroidRustUploadApi.kt
        AndroidRustHeaderApi.kt
        AndroidRustProgressApi.kt
      ui/
        ProtocolVersionView.kt         # tiny @Composable or AppCompat TextView
    res/
      values/strings.xml               # opaque, no plaintext
      values/themes.xml
      mipmap-*/                        # adaptive launcher icon
  src/test/
    kotlin/org/mosaic/android/main/bridge/
      AndroidRustAccountApiTest.kt     # JVM unit test with override library — see below
      ... one per bridge ...
  src/androidTest/
    kotlin/org/mosaic/android/main/
      RustCoreSmokeTest.kt             # instrumented; calls protocolVersion(), bogus unlock
      MainActivityTest.kt              # launches activity and asserts protocol version visible

apps/android-shell/
  src/main/kotlin/org/mosaic/android/foundation/
    GeneratedRustIdentityBridge.kt     # NEW interface contract + adapter shape
    GeneratedRustEpochBridge.kt        # NEW
    GeneratedRustShardBridge.kt        # NEW (encrypt/decrypt)
    GeneratedRustMetadataSidecarBridge.kt  # NEW
    GeneratedRustAlbumSyncBridge.kt    # NEW
    GeneratedRustHeaderBridge.kt       # NEW
    GeneratedRustProgressBridge.kt     # NEW
    GeneratedRustMediaBridge.kt        # AMENDED — add inspectMediaImage + planMediaTierLayout
    RustAccountBridge.kt               # AMENDED — expose protocolVersion publicly
    (existing files retained)
  src/test/kotlin/org/mosaic/android/foundation/
    GeneratedRustIdentityBridgeTest.kt # NEW — fakes covering each new bridge
    ...
  README.md                            # updated to point at android-main as consumer

scripts/
  build-rust-android.ps1               # AMENDED — emit a deterministic copy
  build-rust-android.sh                #   of the generated .kt under
                                       #   apps/android-shell/build/generated-bindings/
                                       #   ONLY for visibility; android-main consumes
                                       #   the canonical target/android/kotlin output.
  build-android-main.ps1               # NEW — wraps build-rust-android + gradlew
  build-android-main.sh                # NEW
  test-android-main.ps1                # NEW — runs ./gradlew :apps:android-main:test
  test-android-main.sh                 # NEW
  test-android-shell.ps1               # AMENDED — adds the new bridge test files

settings.gradle.kts                    # NEW (repo root) — single-module include
gradle.properties                      # NEW (repo root) — kotlin compiler args
gradle/wrapper/gradle-wrapper.properties  # NEW
gradle/wrapper/gradle-wrapper.jar      # NEW (binary; bootstrap path TBD — see Risks)
gradlew                                # NEW
gradlew.bat                            # NEW

.gitignore                             # AMENDED — ignore apps/android-main/build/
.editorconfig                          # AMENDED — add [*.{kt,kts,gradle,gradle.kts}] section
docs/INSTRUCTION_TREE.md               # AMENDED — add android-main row
docs/FEATURES.md                       # AMENDED — add Android Main Module entry + changelog row
docs/TECH_STACK.md                     # AMENDED — note Gradle/AGP/Kotlin/JNA versions
.github/workflows/tests.yml            # AMENDED — new job: android-main-build (Linux runner)
```

## Concrete versions (proposed)

| Component | Version | Rationale |
|---|---|---|
| Gradle | 8.10.2 | Latest stable supporting AGP 8.7. |
| Android Gradle Plugin | 8.7.3 | Latest stable, JDK 17 host. |
| Kotlin | 2.0.21 | Matches AGP 8.7 default. |
| JDK target (`compileOptions` + `kotlinOptions.jvmTarget`) | 17 | Matches existing `scripts/test-android-shell.ps1` `-jvm-target 17`. |
| compileSdk / targetSdk | 35 | Highest installed on host (android-35); avoids API-36 churn. |
| minSdk | 26 | Modern floor; existing `AutoImportMediaPolicy.kt` API-level branches still hold. |
| ABI filters | arm64-v8a, x86_64 | Matches `scripts/build-rust-android.{ps1,sh}` output. No 32-bit. |
| JNA (Android `aar`) | net.java.dev.jna:jna:5.14.0@aar | Required by generated UniFFI Kotlin bindings (`com.sun.jna.*`). |
| AndroidX Activity (Compose-free) | androidx.activity:activity-ktx:1.9.3 | Plain `ComponentActivity`; no Compose to keep this slice tiny. |
| AndroidX Test (instrumentation) | androidx.test.ext:junit:1.2.1, androidx.test.espresso:espresso-core:3.6.1 | One smoke test only. |
| JUnit (unit) | junit:junit:4.13.2 | Standard for AGP unit-test source set. |

These are pinned in `gradle/libs.versions.toml` (AGP version-catalog convention).

## Bridge contracts to add (drift closure)

For each Rust UniFFI function not yet covered by a Kotlin contract, this
slice introduces:

1. A `Generated*Api` interface in `apps/android-shell/src/main/kotlin/org/mosaic/android/foundation/`
   with FFI request/result data classes and stable-code constants.
2. A bridge adapter (`Generated*Bridge`) translating `Generated*Api` results
   into existing high-level Kotlin contracts (e.g. `MediaPort`,
   `RustAccountBridge`, etc.) where one exists.
3. A real implementation of the `Generated*Api` in `apps/android-main` that
   delegates to the corresponding `uniffi.mosaic_uniffi.*` top-level
   function (e.g. `AndroidRustIdentityApi.createIdentityHandle(...)` →
   `uniffi.mosaic_uniffi.createIdentityHandle(...)`).
4. JVM-only fakes in `apps/android-shell/src/test/kotlin/...` for fast tests.

Drift closure mapping:

| Rust function | New `Generated*Api` method | High-level contract |
|---|---|---|
| `protocol_version()` | already on `GeneratedRustAccountApi` | exposed on `RustAccountBridge` |
| `parse_envelope_header()` | `GeneratedRustHeaderApi.parseEnvelopeHeader` | new `RustHeaderBridge` |
| `android_progress_probe()` | `GeneratedRustProgressApi.probe` | test-only contract |
| `create_identity_handle()` etc. (6 fns) | `GeneratedRustIdentityApi.{createIdentity, openIdentity, signingPubkey, encryptionPubkey, signManifest, closeIdentity}` | new `RustIdentityBridge` |
| `create_epoch_key_handle()` etc. (4 fns) | `GeneratedRustEpochApi.{createEpoch, openEpoch, isEpochOpen, closeEpoch}` | new `RustEpochBridge` |
| `encrypt_shard_with_epoch_handle()`, `decrypt_shard_with_epoch_handle()` | `GeneratedRustShardApi.{encryptShard, decryptShard}` | new `RustShardBridge` |
| `inspect_media_image()`, `plan_media_tier_layout()` | `GeneratedRustMediaApi.{inspect, planLayout}` (extend) | `MediaPort` (extend with new methods, keep existing `planTiers`) |
| 4 metadata-sidecar fns | `GeneratedRustMetadataSidecarApi.{canonicalSidecar, encryptSidecar, canonicalMediaSidecar, encryptMediaSidecar}` | new `RustMetadataSidecarBridge` |
| `init_album_sync()`, `advance_album_sync()` | `GeneratedRustAlbumSyncApi.{initAlbumSync, advanceAlbumSync}` | new `AlbumSyncClientCoreHandoff` |
| existing `init_upload_job()`, `advance_upload_job()` | already on `GeneratedRustUploadApi` | already wired |
| `crypto_domain_golden_vector_snapshot()`, `client_core_state_machine_snapshot()` | dev/test introspection — exposed on a single `GeneratedRustDiagnosticsApi` | not surfaced on a bridge |

For each new bridge, the stable-code object follows the established
`RustClientStableCode` pattern with the relevant subset of the 38 Rust
error codes. Codes already present in `RustClientStableCode` are reused
when shared (e.g. `OK = 0`, `INVALID_KEY_LENGTH = 201`,
`OPERATION_CANCELLED = 300`, `INTERNAL_STATE_POISONED = 500`).

## Verification Plan

TDD cycle, per existing repo discipline:

### Phase 0 — bootstrap blockers (must resolve before any code runs)

* The host has JDK 21, Android SDK (platforms 34–36), NDK (3 versions),
  cargo-ndk 4.1.2, uniffi-bindgen 0.31.1, Rust 1.93.1 with the Android
  targets. **It does NOT have Gradle on PATH and the repo has no `gradlew`
  wrapper.** We need exactly one of:
  - **Path A (preferred):** Install Gradle 8.10.2 on the host (e.g.
    `winget install --id Gradle.Gradle -v 8.10.2` or
    `choco install gradle --version 8.10.2`), then run
    `gradle wrapper --gradle-version 8.10.2 --distribution-type bin`
    once at the repo root to generate `gradlew`, `gradlew.bat`, and
    `gradle/wrapper/gradle-wrapper.{properties,jar}`. Commit those.
  - **Path B (binary fetch):** Download
    `gradle-wrapper.jar` and the matching `gradlew`/`gradlew.bat` from
    the Gradle 8.10.2 distribution (`https://services.gradle.org/distributions/gradle-8.10.2-bin.zip`),
    extract the wrapper artifacts, commit. This is functionally
    equivalent but binary-fetch-driven.
  - **Path C (deferred verification):** Author all files, do not
    bootstrap a wrapper, rely on CI runner's `setup-java` +
    `gradle/actions/setup-gradle@v4` to provide Gradle. Local
    `Definition of Done` ("Tests executed locally with output reported")
    cannot be satisfied on this host until either Path A or Path B is
    completed afterwards.

* `ANDROID_NDK_HOME` is unset; `cargo-ndk` discovers the NDK from
  `$ANDROID_HOME/ndk/` automatically when only one NDK is present, but
  the host has three. We must export
  `ANDROID_NDK_HOME=$ANDROID_HOME/ndk/29.0.14206865` (latest installed)
  in `scripts/build-rust-android.{ps1,sh}` if not already set, so the
  Gradle pre-build is reproducible.

### Phase 1 — Red

1. Write Kotlin tests for each new `Generated*Api` interface in
   `apps/android-shell/src/test/kotlin/...` using fakes. They reference
   the not-yet-written interfaces / types.
2. Run `.\scripts\test-android-shell.ps1` → confirm RED (compile failures).
3. Write Kotlin unit tests in `apps/android-main/src/test/...` that
   instantiate `AndroidRustAccountApi` against a fake JNA library
   (using JNA's `Native.setProtected(true)` test pattern OR the
   `uniffi.component.mosaic_uniffi.libraryOverride` system property
   pointing at a host-built `mosaic_uniffi.{dll|so|dylib}`). They
   reference not-yet-written adapter classes.
4. Run `./gradlew :apps:android-main:test` → confirm RED.
5. Write an `androidTest/` smoke test that asserts `protocolVersion() == "mosaic-v1"`.

### Phase 2 — Green

1. Add the new `Generated*Api` interfaces and bridge adapters in
   `apps/android-shell`. Re-run `test-android-shell.ps1` → green.
2. Add `apps/android-main` skeleton: `build.gradle.kts`,
   `AndroidManifest.xml`, `MainActivity.kt`, adapter classes.
3. Write Gradle pre-build task that:
   - invokes `scripts/build-rust-android.{ps1,sh}` (skipped on CI if a
     prior step already produced the artifacts);
   - copies `target/android/kotlin/.../mosaic_uniffi.kt` into
     `build/generated/source/uniffi/main/`;
   - registers that path on the `main` Kotlin source set;
   - copies `target/android/{arm64-v8a,x86_64}/libmosaic_uniffi.so` into
     `build/generated/jniLibs/{abi}/`;
   - registers that path as `jniLibs.srcDirs`.
4. Run `./gradlew :apps:android-main:assembleDebug` → APK builds.
5. Run `./gradlew :apps:android-main:test` → JVM tests green.
6. Run instrumented test on a running emulator (manual; not gated in CI
   for this slice).

### Phase 3 — Refactor

1. Replace `apps/android-shell` test fakes with a delegation layer where
   identical contract behavior can be proven via cross-module test
   helpers (out of scope for v1; deferred).
2. Run final gates listed below.

### Focused gates

1. `cargo fmt --all -- --check`
2. `cargo clippy -p mosaic-uniffi --all-targets -- -D warnings`
3. `cargo test -p mosaic-uniffi --locked`
4. `cargo check -p mosaic-uniffi --target aarch64-linux-android --locked`
5. `cargo check -p mosaic-uniffi --target x86_64-linux-android --locked`
6. `.\scripts\build-rust-android.ps1` (full build of `.so` + Kotlin bindings)
7. `.\scripts\test-android-shell.ps1` (JVM-only foundation tests)
8. `.\scripts\build-android-main.ps1` (`assembleDebug`)
9. `.\scripts\test-android-main.ps1` (`gradlew :apps:android-main:test`)
10. `git --no-pager diff --check`

CI mirror: `.github/workflows/tests.yml` adds a single `android-main-build`
job on `ubuntu-latest` with `actions/setup-java@v4` (JDK 17),
`gradle/actions/setup-gradle@v4`, then runs gates 6, 8, 9.

## Risks

1. **Gradle wrapper bootstrap.** Without Gradle on PATH and without a
   committed wrapper, `./gradlew` cannot be invoked. The user must
   choose Path A / B / C in Phase 0 above.
2. **Generated `mosaic_uniffi.kt` drift.** The file is regenerated from
   the Rust crate every build; it is `.gitignore`d (under `target/`).
   The Gradle pre-build copies it into `build/generated/`, also
   ignored. There is no committed copy — the `cargo-ndk` /
   `uniffi-bindgen` step is the single source of truth. CI must
   always run `scripts/build-rust-android.{ps1,sh}` before Gradle.
3. **JNA `aar` size.** `net.java.dev.jna:jna:5.14.0@aar` adds ~1.4 MB
   of native code per ABI to the APK. Mitigated by abiFilters limiting
   to two ABIs only. Acceptable for v1.
4. **`unsafe_code = "forbid"`** — the Rust workspace lint forbids unsafe.
   UniFFI macros generate FFI shims internally; verified that
   `mosaic-uniffi` already compiles under this lint (workspace-wide
   policy, no exceptions). No change needed.
5. **`unwrap_used = "deny"`, `expect_used = "deny"`.** These workspace
   clippy lints apply to `mosaic-uniffi`. The new SPEC does not modify
   `mosaic-uniffi`; bridges go through existing exported functions.
6. **Cross-platform script parity.** Existing scripts come in
   `*.ps1` + `*.sh` pairs (verified). New scripts must follow the same
   convention.
7. **CI runner cost.** Adding Android SDK + Gradle to CI inflates the
   matrix. `gradle/actions/setup-gradle@v4` provides effective caching;
   `android-actions/setup-android@v3` provisions SDK on Linux.
8. **Static manifest tests.** A Gradle unit test parses
   `src/main/AndroidManifest.xml` and asserts forbidden permissions are
   absent and `allowBackup="false"`. Standard pattern.
9. **Recovery path if approval is partial.** If the user later wants to
   pause at Phase 2 step 2 (skeleton without bridge drift closure), the
   SPEC can be split: the FFI drift contracts in `apps/android-shell`
   stand alone and remain green under `test-android-shell.ps1`.

## Decision points the user must confirm before code lands

1. **Module name:** `apps/android-main`? (alternatives: `apps/android-app`,
   `apps/android`, `apps/android-mobile`)
2. **Gradle wrapper bootstrap path:** A / B / C above.
3. **minSdk:** 26 acceptable? (29 = scoped storage required;
   30 = Photo Picker compat; 33 = native Photo Picker)
4. **compileSdk / targetSdk:** 35 acceptable?
5. **Drift closure scope:** wire ALL missing Rust surfaces in this slice,
   or stage in two commits (skeleton-only, then drift closure)?
6. **CI gating:** add Android Gradle build to `tests.yml` in this slice,
   or land as a follow-up commit?
7. **APK signing:** debug-only signing in this slice (default keystore);
   release signing config deferred?
8. **Existing `apps/android-shell` README:** rewrite to reflect new
   consumer relationship, or leave intact and add a "Status updated"
   note?

## Approval

Author: Mosaic Sentinel.
Status: Approved by user (`apps/android-main` selected; Path B wrapper
bootstrap; minSdk 26; compileSdk 35; full drift closure; CI added; debug
signing; android-shell README rewritten). All eight decision points
confirmed.

## Implementation notes (post-approval addendum)

The following implementation choices were finalized during execution per
rubber-duck feedback:

1. Wrapper bootstrap (Path B) used `https://github.com/gradle/gradle/raw/v8.10.2/`
   for the wrapper jar (43 583 bytes, SHA256
   `2DB75C40782F5E8BA1FC278A5574BAB070ADCCB2D21CA5A6E5ED840888448046`) and
   the matching `gradlew` / `gradlew.bat` scripts. The wrapper itself
   verifies the Gradle 8.10.2 distribution against
   `distributionSha256Sum=31c55713e40233a8303827ceb42ca48a47267a0ad4bab9177123121e71524c26`
   on first download. CI additionally runs `gradle/actions/setup-gradle@v4`
   with `validate-wrappers: true` for a second line of defense.
2. Generated source path standardized on
   `apps/android-main/build/generated/source/uniffi/main/kotlin/`. Native
   libs land at `apps/android-main/build/generated/jniLibs/{abi}/`. Both
   ignored by `.gitignore`.
3. `preBuild` is the AGP hook the Rust sync tasks bind to (verified runs
   before `compileDebugKotlin` and `mergeDebugNativeLibs`).
4. `RustClientCoreUploadJobFfiSnapshot` did not yet carry `maxRetryCount`
   on the shell side; the AndroidRustUploadApi adapter defaults this field
   to `0u` when converting shell→UniFFI. Once the shell schema is extended,
   replace the default. Documented in adapter source.
5. The android-shell module's `src/main/kotlin` is added as an additional
   Kotlin source root of `apps/android-main` — this keeps the shell
   independently validateable via `scripts/test-android-shell.{ps1,sh}`
   while reusing the same `Generated*Api` interfaces and DTOs in the
   Gradle build.
6. CI added an `android-shell` job (Linux, runs the new
   `scripts/test-android-shell.sh`) and an `android-main` job (Linux,
   installs JDK 17 + Android cmdline-tools + platform-35 + NDK 29 +
   cargo-ndk + uniffi-bindgen, then runs `assembleDebug` +
   `testDebugUnitTest` + uploads the debug APK as a workflow artifact).
7. Adapter classes split per-subsystem (11 files) instead of a monolithic
   facade, matching the established `Generated*Api` granularity in the
   shell. Library loading is centralized in `AndroidRustCoreLibraryLoader`.
8. Manifest invariants verified: `allowBackup="false"`, no `INTERNET`, no
   `READ_MEDIA_*`, abiFilters `arm64-v8a` + `x86_64` only, single launcher
   activity with `android:exported="true"`.

## Verification evidence (this session)

- `scripts/test-android-shell.ps1` → 124 passes / 0 fails (37 of which are
  new bridge contract tests in `GeneratedRustBridgeContractsTest.kt`).
- `gradlew :apps:android-main:assembleDebug` → BUILD SUCCESSFUL,
  `apps/android-main/build/outputs/apk/debug/android-main-debug.apk`
  (5.07 MB) produced with both ABIs of `libmosaic_uniffi.so` packaged
  inside `lib/{arm64-v8a,x86_64}/`.
- `gradlew :apps:android-main:testDebugUnitTest` → BUILD SUCCESSFUL.
- The instrumented `RustCoreSmokeTest.kt` is present but requires a
  running emulator and is not gated in CI for this slice; it is the
  canonical end-to-end FFI proof.
