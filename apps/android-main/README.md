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
    res/
      values/{strings.xml,themes.xml}
      mipmap-anydpi-v26/{ic_launcher.xml,ic_launcher_round.xml}
      drawable/{ic_launcher_background.xml,ic_launcher_foreground.xml}
  src/test/
    kotlin/org/mosaic/android/main/bridge/
      AdapterCompilationContractTest.kt # JVM compile-time guard; does NOT load native lib
  src/androidTest/
    kotlin/org/mosaic/android/main/
      RustCoreSmokeTest.kt              # Instrumented end-to-end FFI smoke test
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
- WorkManager scheduling for `dataSync` foreground work.
- Real Tus upload pipeline.
- Real media tier encoding (HEIC/JPEG/WebP via platform encoders).
- Release build signing config.
