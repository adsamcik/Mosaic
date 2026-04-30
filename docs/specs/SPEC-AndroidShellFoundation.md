# SPEC: Android Shell Foundation

## Status

Locked at v1. Implemented in `ea1c3b2` (`feat(android): add upload shell
foundation`) — JVM-only Kotlin scaffold under `apps/android-shell` with
the privacy-safe upload queue records, immediate-read Photo Picker abstraction,
crypto-unlock vs server-auth state-machine separation, and the
`GeneratedRustAccountBridge` seam. The Gradle/Android conversion landed via
`SPEC-AndroidMainGradleModule` (`fe49557`); the shell foundation contracts
remain authoritative.

## Scope

This slice creates the first Android upload/import companion foundation for Mosaic. It is intentionally a shell/foundation slice only: no real upload, no Tus networking, no image codec/media-tier generation, no generated UniFFI Kotlin wiring, and no full gallery/backup behavior.

The current repository has Rust account-unlock/identity UniFFI surfaces and media tier layout planning, but no Android or Gradle project. The local environment has an Android SDK and Android Studio Kotlin compiler, but no Gradle command on `PATH`. This slice therefore uses a JVM-only Kotlin scaffold under `apps/android-shell` plus a repository script that compiles and runs tests with the local Kotlin compiler. Converting the contracts into an Android app module remains a follow-up once the Gradle/Android app baseline and media-tier adapter are available.

## Data Flow

```text
server auth success
  -> ServerAuthState.Authenticated(serverAccountId)
  -> does NOT unlock local crypto

account password + non-secret unlock parameters
  -> GeneratedRustAccountBridge / RustAccountBridge.unlockAccount(...)
  -> AccountUnlockResult(success, opaque AccountKeyHandle)
  -> CryptoUnlockState.Unlocked(handle, protocol_version)

Photo Picker selection content://...
  -> PhotoPickerImmediateReadPort.readImmediately(selection)
  -> app-private staged media reference (mosaic-staged://...)
  -> PrivacySafeUploadQueueRecord
  -> future worker drains staged encrypted/opaque source after crypto unlock
```

Queue records never use Photo Picker raw URIs as their retry source. The immediate-read abstraction forces callers to convert an ephemeral picker grant into an app-private staged source before queueing.

## Zero-Knowledge and Privacy Invariants

- Android shell code never sends plaintext photos, captions, EXIF/GPS, device metadata, decrypted metadata, passwords, raw keys, or filenames to the server.
- Server authentication and crypto unlock are separate state machines; upload eligibility requires both.
- Rust bridge outputs are opaque handles, stable status codes, and protocol version strings only.
- Upload queue records contain only opaque local identifiers, app-private staged source references, lengths, timestamps, retry counts, and coarse state.
- Queue construction rejects filenames, captions, EXIF/GPS/device metadata, decrypted metadata, raw keys, and raw URI fields.
- Staged source references must use the `mosaic-staged://` scheme, not `content://`, `file://`, or media-store paths.
- Work policy defaults require a foreground, user-visible `dataSync` drain. Broad storage permissions are not represented by the policy model.

## Component Tree

```text
apps/android-shell
  README.md
  src/main/kotlin/org/mosaic/android/foundation
    AuthSessionState.kt        # server auth vs crypto unlock model
    MediaPort.kt               # future media-tier-generation seam and stub
    PhotoPickerContracts.kt    # immediate-read picker abstraction
    UploadQueueRecord.kt       # privacy-safe queue record and validation
    WorkPolicy.kt              # WorkManager/foreground dataSync policy model
    RustAccountBridge.kt       # UniFFI bridge seam for account unlock lifecycle
    GeneratedRustAccountBridge.kt # generated-binding adapter/probe for stable Rust account codes
  src/test/kotlin/org/mosaic/android/foundation
    AndroidShellFoundationTest.kt

scripts/test-android-shell.ps1 # Kotlin/JVM validation without Gradle
```

No Android manifest is added in this slice. When an Android app module is introduced, static manifest tests must assert no `READ_EXTERNAL_STORAGE` or `MANAGE_EXTERNAL_STORAGE`, `allowBackup=false`, non-exported components by default, and planned foreground service `dataSync` declarations.

No durable queue persistence is added in this slice. When Room or another Android storage layer is introduced, persistence-boundary tests must enforce the same prohibited-field invariant so queue records cannot serialize filenames, captions, EXIF/GPS/device metadata, decrypted metadata, raw keys, or raw URI fields regardless of factory call path.

## Verification Plan

TDD cycle:

1. Add Kotlin tests first for state separation, queue privacy, fake/generated Rust bridge lifecycle, media/photo-picker seams, and work policy defaults.
2. Run `.\scripts\test-android-shell.ps1` and confirm RED from missing foundation contracts.
3. Implement the narrow foundation contracts.
4. Re-run Android shell tests until green.

Focused gates:

1. `.\scripts\test-android-shell.ps1`
2. `cargo test -p mosaic-client --test account_unlock --locked`
3. `cargo test -p mosaic-uniffi --test ffi_snapshot --locked`
4. `.\scripts\build-rust-android.ps1` if the local Android/Rust toolchain can complete it without excessive cost
5. `git --no-pager diff --check`
