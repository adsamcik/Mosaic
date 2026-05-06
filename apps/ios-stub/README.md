# Mosaic iOS Readiness Stub

This directory is an iOS readiness stub for Mosaic. It is **not** a full iOS app and it does not contain checked-in UniFFI-generated Swift bindings. Its purpose is to document and pin the shape of the Swift Package that a future iOS client will use once the generated framework is produced.

Mosaic remains zero-knowledge on iOS: plaintext photos, metadata, passwords, and key material stay inside the client process. The server-facing API continues to receive only opaque encrypted payloads.

## How iOS consumes Mosaic core

Mosaic's Rust core exposes its mobile API through `crates/mosaic-uniffi/src/lib.rs`. UniFFI can generate Swift bindings from the same FFI definitions used for Android Kotlin bindings. A future iOS client consumes those bindings through Swift Package Manager:

1. Build the `mosaic-uniffi` library for the Apple target.
2. Generate Swift bindings with `uniffi-bindgen`.
3. Package the generated Swift support and native library as `MosaicUniFFI.xcframework`.
4. Point `Package.swift` in this directory at that generated framework.
5. Import `MosaicCore` from the iOS application target.

`Sources/MosaicCore/MosaicCore.swift` conditionally re-exports the generated `MosaicUniFFI` module so application code can depend on the stable package name `MosaicCore`.

## Regenerating Swift bindings

The exact library extension and target output path depend on the host and Apple target. The intended invocation is:

```bash
cargo run -p mosaic-uniffi --bin uniffi-bindgen -- \
  generate \
  --library target/debug/libmosaic_uniffi.dylib \
  --language swift \
  --out-dir apps/ios-stub/Sources/MosaicCore/
```

For device builds, generate after building `mosaic-uniffi` for `aarch64-apple-ios`; for simulator builds, use the matching simulator target and combine artifacts into an XCFramework before wiring `Generated/MosaicUniFFI.xcframework`.

## Available FFI surface for iOS

The post-Wave-5 iOS surface is expected to match Android's UniFFI surface:

| Surface | iOS contract |
|---|---|
| Handle-based crypto | `SecretHandleId`, `EpochHandleId`, and `LinkHandleId` are consumed as opaque handle identifiers. |
| Sync state machine | `AlbumSyncSnapshot`, sync events, sync effects, and pinned phase discriminants are exported. |
| Upload state machine | `UploadJobSnapshot`, upload events, upload effects, and pinned phase discriminants are exported. |
| Sidecar tags 1-9 | Active sidecar tag discriminants remain stable for clients. |
| Error codes | `ClientErrorCode` provides stable client-visible error mapping. |
| Metadata stripping | JPEG, PNG, WebP, AVIF, HEIC/HEIF, and supported video stripping are available in Rust core; future iOS upload wiring must call the same inspect/strip/sidecar path before encryption. |

## Regression harness

`Tests/MosaicCoreTests/ApiSurfaceTest.swift` is a compile-time readiness harness. It documents the Swift symbols that must be available when UniFFI Swift bindings are generated and connected. The package is not expected to compile in this repository until `Generated/MosaicUniFFI.xcframework` exists.

The Rust-side golden API test remains the cross-platform source of truth because Swift and Kotlin bindings are generated deterministically from the same Rust UniFFI surface.

## Missing pieces for a full iOS client

A production iOS app still needs:

- SwiftUI or UIKit application UI.
- Keychain integration for handle and account state persistence.
- Sandboxed file-system staging for uploads and downloads.
- URLSession-based API and download adapter.
- TUS upload integration.
- BGTaskScheduler-based background upload orchestration.
- Photos framework import/export integration.
- AVIF/HEIC/video upload adapter wiring to call Rust media inspect, strip, and sidecar generation before encryption.
- App lifecycle handling for key wiping and worker shutdown.
- XCTest and UI test suites for iOS-specific behavior.

## Forward ticket

Future iOS implementation work should start with an iOS client epic that mirrors the Android chain, including tickets for TUS upload, Photos integration, Keychain handle storage, background uploads, and platform UI.
