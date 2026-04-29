# Android Main App Module

`apps/android-main` is the first real Android application module in Mosaic. It
consumes the Rust UniFFI core (`crates/mosaic-uniffi`) directly: the cross-compiled
`libmosaic_uniffi.so` is packaged into the APK, and JNA-based generated Kotlin
bindings (`uniffi.mosaic_uniffi.*`) call into Rust at runtime. The shell-side
contracts in `apps/android-shell` define the bridge interfaces; this module
provides the real adapter implementations.

## Status

This is a **foundation slice**: the module produces a debug APK that proves the
Rust↔Android FFI is wired end-to-end. It does **not** yet ship a real Photo
Picker UI, Tus upload, codec/tier-generation, account creation, or WorkManager
scheduling. Those land in follow-up slices.

## Contents

```
apps/android-main/
  build.gradle.kts                      # AGP 8.7.3 application module
  proguard-rules.pro                    # JNA + uniffi.mosaic_uniffi.** keep rules
  src/main/
    AndroidManifest.xml                 # allowBackup=false, no INTERNET, no media perms
    kotlin/org/mosaic/android/main/
      MainActivity.kt                   # Smoke screen — protocolVersion() + bogus unlock
      MosaicApplication.kt              # Eager-loads native lib via warmUp()
      bridge/
        AndroidRustCoreLibraryLoader.kt # Centralizes uniffiEnsureInitialized()
        AndroidRustAccountApi.kt        # GeneratedRustAccountApi → uniffi.mosaic_uniffi
        AndroidRustHeaderApi.kt
        AndroidRustProgressApi.kt
        AndroidRustIdentityApi.kt
        AndroidRustEpochApi.kt
        AndroidRustShardApi.kt
        AndroidRustMediaApi.kt
        AndroidRustMetadataSidecarApi.kt
        AndroidRustDiagnosticsApi.kt
        AndroidRustUploadApi.kt
        AndroidRustAlbumSyncApi.kt
      work/
        AutoImportRuntime.kt            # Process-scoped settings/runtime providers
        AutoImportWorkPolicy.kt         # Pure decision + SHA-256 unique-work name
        AutoImportWorkScheduler.kt      # WorkManager glue (enqueue/dedupe/cancel)
        AutoImportWorker.kt             # CoroutineWorker — dataSync foreground service
    res/
      values/{strings.xml,themes.xml}
      mipmap-anydpi-v26/{ic_launcher.xml,ic_launcher_round.xml}
      drawable/{ic_launcher_background.xml,ic_launcher_foreground.xml}
  src/test/
    kotlin/org/mosaic/android/main/bridge/
      AdapterCompilationContractTest.kt # JVM compile-time guard; does NOT load native lib
    kotlin/org/mosaic/android/main/
      MergedManifestInvariantsTest.kt   # Manifest privacy + foreground-service invariants
    kotlin/org/mosaic/android/main/work/
      AutoImportWorkPolicyTest.kt       # JVM unit test: pure decision + dedupe name
  src/androidTest/
    kotlin/org/mosaic/android/main/
      RustCoreSmokeTest.kt              # Instrumented end-to-end FFI smoke test
    kotlin/org/mosaic/android/main/work/
      AutoImportWorkInstrumentedTest.kt # Enqueue/dedupe/revocation on WorkManager
```

## How to build

```powershell
# Windows
.\scripts\build-android-main.ps1
.\scripts\test-android-main.ps1
```

```bash
# Linux/macOS
./scripts/build-android-main.sh
./scripts/test-android-main.sh
```

The build orchestrator runs `scripts/build-rust-android.{ps1,sh}` first to
produce the `.so` files and Kotlin bindings, then invokes `gradlew
:apps:android-main:assembleDebug`. The Gradle module's `preBuild` task also
invokes the Rust build script, so `gradlew assembleDebug` works as a one-shot
command after Gradle and the Rust toolchain are installed.

## How it loads the native library

1. `MosaicApplication.onCreate()` calls `AndroidRustCoreLibraryLoader.warmUp()`.
2. `warmUp()` calls the generated `uniffi.mosaic_uniffi.uniffiEnsureInitialized()`.
3. That triggers JNA's `Native.register("mosaic_uniffi")`, which loads
   `libmosaic_uniffi.so` from the APK's `lib/{abi}/` directory and verifies the
   exported function table checksum against the bindings.
4. Adapter classes (`AndroidRust*Api`) also call `warmUp()` defensively in their
   `init` blocks, so any direct adapter use prior to `MosaicApplication` is safe.

## Privacy / security invariants

- `android:allowBackup="false"` — no auto-backup of app-private state.
- No `INTERNET` permission. No `READ_MEDIA_IMAGES`. No
  `MANAGE_EXTERNAL_STORAGE`.
- abiFilters restricted to `arm64-v8a` + `x86_64`.
- The smoke `unlockAccountKey` call uses synthetic non-secret inputs that the
  Rust core rejects with stable code 208 (`KDF_PROFILE_TOO_WEAK`); no real
  account material is exercised in the smoke flow.
- Bridge DTOs continue the `<redacted>` `toString()` pattern from the
  android-shell foundation.

## Background-work invariants (Band 6 auto-import)

The `work/` package wires the
[android-shell auto-import scheduling seam](../android-shell/src/main/kotlin/org/mosaic/android/foundation/AutoImportScheduler.kt)
into a real `androidx.work` `CoroutineWorker`. The invariants below are
enforced by `MergedManifestInvariantsTest`, `AutoImportWorkPolicyTest` (JVM),
and `AutoImportWorkInstrumentedTest` (emulator).

- **Policy-conditional enqueue.** `MosaicApplication.onCreate` calls
  `AutoImportWorkScheduler.enqueueIfPolicyAllows(this)`. The default settings
  are `AutoImportScheduleSettings.disabled()`, so the boot path short-circuits
  through `AutoImportWorkPolicy.Decision.SHORT_CIRCUIT_DISABLED` and never
  enqueues work in the absence of explicit user opt-in.
- **Foreground service type.** When the schedule plan reaches
  `READY_TO_SCHEDULE`, the worker promotes itself to a foreground service via
  `setForeground(...)` with `ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC`.
  The merged AndroidManifest patches WorkManager's `SystemForegroundService`
  with `android:foregroundServiceType="dataSync"` so Android 14+ accepts the
  promotion at runtime.
- **Capability-boundary contract.** The worker re-reads the live
  `AutoImportScheduleSettings` inside `doWork()` and re-evaluates the plan via
  `AutoImportSchedulerContract.evaluate(...)`. If the auto-import capability
  has been revoked between enqueue and execution, the worker returns
  `Result.success()` without promoting itself or doing any upload work — i.e.
  capability revocation is handled as a benign no-op rather than a crash or
  retry storm.
- **Dedupe.** `AutoImportWorkPolicy.uniqueWorkName(destination)` derives a
  deterministic SHA-256 hash of the `(serverAccountId, albumId)` tuple under
  the `auto-import.` namespace prefix. Re-submitting the same destination
  resolves to the same WorkManager unique-work name and is collapsed by
  `ExistingWorkPolicy.KEEP`. The hash keeps account / album identifiers out of
  the WorkManager database in line with the privacy-redacted `<opaque>` /
  `<redacted>` patterns enforced by the shell foundation.
- **Permissions.** The manifest declares only `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_DATA_SYNC`, and `POST_NOTIFICATIONS` — the minimum set
  required to run a `dataSync` foreground service on Android 14+ and post the
  user-visible notification. No `INTERNET`, no `READ_MEDIA_*`, and no
  `MANAGE_EXTERNAL_STORAGE` are added; the Photo Picker integration owns
  picking, not background scanning.
- **No DI.** v1 ships no Hilt / Dagger graph, so the worker resolves runtime
  state through the process-scoped `AutoImportRuntime` registry instead of
  `HiltWorker`. Tests install a custom `AutoImportSettingsProvider` /
  `AutoImportRuntimeProvider` for deterministic fixture setup.

## Dependencies

| Component | Version |
|---|---|
| Gradle | 8.10.2 (wrapper distribution SHA256 in `gradle/wrapper/gradle-wrapper.properties`) |
| Android Gradle Plugin | 8.7.3 |
| Kotlin | 2.0.21 |
| JDK target | 17 (host JDK 17 or higher) |
| compileSdk / targetSdk | 35 |
| minSdk | 26 |
| JNA (Android `aar`) | 5.14.0 |

## Follow-ups (not in scope for this slice)

- Real account creation / login flow.
- Real Photo Picker integration (Android 13+ system Photo Picker, with API 26
  fallback path that does NOT request `READ_EXTERNAL_STORAGE`).
- Real Tus upload pipeline inside `AutoImportWorker.doWork()` (the foreground
  promotion + capability-boundary contract are wired in this slice; the
  encrypt → upload payload arrives in the next Band 6 slice).
- Real media tier encoding (HEIC/JPEG/WebP via platform encoders).
- Release build signing config.
