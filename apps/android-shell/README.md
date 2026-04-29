# Android Shell Foundation

This is a JVM-only Kotlin scaffold that defines the **bridge contracts and
shell-side DTOs** consumed by `apps/android-main`. It is intentionally
toolchain-light: no Gradle plugin and no Android SDK are required to validate
this module — `scripts/test-android-shell.{ps1,sh}` invokes the bundled
Kotlin compiler directly and runs the JVM-only contract tests in seconds.

The module is the source of truth for the cross-platform Kotlin `Generated*Api`
interfaces. Real implementations (calling into the Rust UniFFI core) live in
`apps/android-main/src/main/kotlin/org/mosaic/android/main/bridge/`.

## What lives here

- **Auth + crypto state separation** (`AuthSessionState.kt`).
- **Bridge contracts** for the Rust core, one per subsystem:
  - account unlock/status/close (`GeneratedRustAccountBridge.kt`),
  - identity create/open/sign/close (`GeneratedRustIdentityBridge.kt`),
  - epoch-key create/open/status/close (`GeneratedRustEpochBridge.kt`),
  - shard encrypt/decrypt (`GeneratedRustShardBridge.kt`),
  - metadata sidecar canonical/encrypt + media variants
    (`GeneratedRustMetadataSidecarBridge.kt`),
  - media inspect + tier-layout planning (`GeneratedRustMediaBridge.kt`),
  - shard envelope header parsing (`GeneratedRustHeaderBridge.kt`),
  - cross-language progress probe (`GeneratedRustProgressBridge.kt`),
  - manual upload state machine (`GeneratedRustUploadBridge.kt`),
  - album sync state machine (`GeneratedRustAlbumSyncBridge.kt`),
  - protocol version + golden vectors + state-machine descriptors
    (`GeneratedRustDiagnosticsBridge.kt`).
- **Privacy-safe upload queue + auto-import contracts** (queue records, durable
  drift records, manifest finalization idempotency, scheduling, work policy,
  Photo Picker abstractions).
- **Test fakes** (`src/test/kotlin/...`) for every `Generated*Api` interface.

## How to validate

```powershell
.\scripts\test-android-shell.ps1
```

```bash
./scripts/test-android-shell.sh
```

## Relationship to `apps/android-main`

`apps/android-main` is the real Android Gradle application that consumes
these contracts. The relationship is:

```
apps/android-shell/src/main/kotlin     # Source of truth: interfaces + DTOs
       ↓
       (added as an extra Kotlin sourceSet of apps/android-main)
       ↓
apps/android-main/src/main/kotlin/.../bridge/AndroidRust*Api.kt
       ↓ delegates to
target/android/kotlin/uniffi/mosaic_uniffi/mosaic_uniffi.kt   (generated)
       ↓ via JNA Native.register("mosaic_uniffi")
target/android/{abi}/libmosaic_uniffi.so   (cargo-ndk)
       ↓ which is mosaic-uniffi → mosaic-client / mosaic-crypto / mosaic-domain / mosaic-media
```

When extending the bridge contracts here:

1. Add a `Generated*Api` interface, FFI-shaped DTOs, stable code constants,
   and a `Generated*Bridge` adapter that translates the FFI DTOs into shell
   high-level result types.
2. Add a JVM test fake for the new `Generated*Api` in
   `src/test/kotlin/.../GeneratedRustBridgeContractsTest.kt`.
3. Validate via `scripts/test-android-shell.{ps1,sh}` (red → green).
4. Add a real implementation in
   `apps/android-main/src/main/kotlin/.../bridge/AndroidRustXxxApi.kt`
   that delegates to the generated `uniffi.mosaic_uniffi` top-level
   functions.
5. Add a JVM compile-time guard in
   `apps/android-main/src/test/.../AdapterCompilationContractTest.kt`.
6. Add an instrumented round-trip in
   `apps/android-main/src/androidTest/.../RustCoreSmokeTest.kt`.

## Status

- Foundation contracts: **implemented** (this module).
- Real Android Gradle app: **landed** in `apps/android-main`.
- Real Photo Picker, Tus upload, codec/tier-generation, WorkManager
  scheduling: **follow-up** — not in scope for the v1 baseline.
