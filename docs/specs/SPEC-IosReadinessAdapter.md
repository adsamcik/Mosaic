# SPEC-IosReadinessAdapter

> **Status**: v1.  
> **Source**: Q-final-2.

## 1. Purpose

This SPEC documents the iOS readiness story for Mosaic. iOS is a future platform target; this SPEC defines the contract that an iOS client consumes to integrate with the existing Rust core.

Q-final-2 chooses the stub-directory approach: `apps/ios-stub/` provides a Swift Package skeleton and compile-time API-surface harness without committing Mosaic to a full iOS app implementation.

## 2. UniFFI Swift Binding Generation

UniFFI auto-generates Swift bindings from the same `crates/mosaic-uniffi/src/lib.rs` that produces Kotlin bindings for Android. Regenerate Swift bindings with:

```bash
cargo run -p mosaic-uniffi --bin uniffi-bindgen -- \
  generate \
  --library target/debug/libmosaic_uniffi.dylib \
  --language swift \
  --out-dir apps/ios-stub/Sources/MosaicCore/
```

Adjust the library path for the active host or Apple target. Production iOS packaging should build `mosaic-uniffi` for device and simulator targets, generate Swift support, and assemble `Generated/MosaicUniFFI.xcframework` for Swift Package Manager.

## 3. Available FFI Surface (Post-Wave-5)

| Surface | Status | Notes |
|---|---|---|
| Crypto handles | ✅ Available | `EpochHandleId`, `SecretHandleId`, `LinkHandleId` per R-C6 / R-C5.5. |
| Sync state machine | ✅ Available | `AlbumSyncSnapshot` / Event / Effect; phase discriminants pinned per R-Cl2. |
| Upload state machine | ✅ Available | `UploadJobSnapshot` / Event / Effect; phase discriminants pinned per R-Cl1.2. |
| Sidecar tags 1-9 | ✅ Available | All active per R-M3 + R-M4. |
| ClientErrorCode | ✅ Available | Enum exported per P-U4. |
| Metadata strip | ✅ Available | JPEG / PNG / WebP via M0; AVIF / HEIC pending R-M1 / R-M2. |
| Video container | ⏸ Pending | R-M6 + R-M7. |
| Streaming AEAD | ⏸ Pending | R-C4. |

## 4. Cross-Platform Parity

The iOS surface is byte-for-byte identical to the Android UniFFI surface because both are generated from the same Rust source. The golden test at `crates/mosaic-uniffi/tests/golden/uniffi_api.txt` is the source-of-truth regression artifact for the exported API.

The `cross-client-vectors` Cargo feature gates corpus-driver exports out of production iOS builds, the same as Android. SwiftPM build wiring must keep the same fail-fast invariant when `cross-client-vectors` is enabled in a future iOS build-infrastructure ticket.

## 5. iOS-Specific Adapter Layer (Pending)

A full iOS client needs:

- Keychain integration for handle persistence, analogous to Android Keystore.
- File-system adapter for sandboxed app files used during staging and upload.
- URLSession-based network layer, analogous to OkHttp.
- TUS upload library integration, analogous to tus-android.
- Background processing through BGTaskScheduler, analogous to WorkManager.
- Photos framework integration, analogous to Android Photo Picker.
- App lifecycle hooks that wipe sensitive client memory before suspension or logout.

These are outside Q-final-2. The readiness stub only proves the Swift packaging and FFI contract story.

## 6. Regression Harness

`apps/ios-stub/Tests/MosaicCoreTests/ApiSurfaceTest.swift` lists the Swift symbols expected from generated bindings and verifies the stable `MosaicCore` facade contract. It is intentionally tied to `Generated/MosaicUniFFI.xcframework`, which is produced by the binding-generation workflow rather than checked into the repository.

No Rust smoke test is added in Q-final-2 because `crates/mosaic-uniffi/` is concurrently owned by P-U4. Adding a Rust test there would create scope overlap. The existing UniFFI golden API artifact remains the regression source of truth until iOS build wiring has a dedicated ticket.

## 7. Forward Tickets

When iOS implementation begins, expected tickets include:

- I1: iOS TUS client adapter, analogous to A5b.
- I2: iOS Photos integration, analogous to A14.
- I3: iOS Keychain handle storage, analogous to A2a / A2b.
- I4: iOS background upload service, analogous to A15.
- I5: iOS file-system staging adapter.
- I6: iOS network and auth adapter.
- I7: iOS UI shell and navigation.

The iOS chain mirrors the Android chain; expected ticket count is about 20.
