# SPEC: E2E Coverage Matrix

## Status

**Q-final-3 status: frozen for v1 quality gate.** This matrix records the required end-to-end coverage for the v1 freeze across web Playwright, Android instrumented/UI Automator, Rust cross-platform parity, and Android device classes.

## Scope

- Web Playwright coverage from `tests/e2e/tests/web-upload-download-lifecycle.spec.ts`.
- Android instrumented coverage from `apps/android-main/src/androidTest/kotlin/org/mosaic/android/main/e2e/UploadLifecycleE2ETest.kt`.
- Cross-platform parity coverage from `crates/mosaic-parity-tests/`.
- Android API/device matrix for manual and CI emulator execution.

## Non-goals

- No application source changes.
- No weakening of existing E2E assertions.
- No replacement for feature-specific unit or integration tests.

## Web coverage: Playwright W-A6

| ID | Scenario | Source test | Required signal |
| --- | --- | --- | --- |
| W-A6-1 | Upload happy path with Rust-core flag ON | `web-upload-download-lifecycle.spec.ts` | Upload persists after refresh while Rust-core path is active. |
| W-A6-2 | Upload happy path with legacy flag OFF | `web-upload-download-lifecycle.spec.ts` | Legacy-disabled path still uploads, stores, and reloads encrypted photos. |
| W-A6-3 | Concurrent uploads (W-A2 concurrency) | `web-upload-download-lifecycle.spec.ts` | Five concurrent uploads create unique records and advance manifest version. |
| W-A6-4 | Tab close mid-upload plus resume | `web-upload-download-lifecycle.spec.ts` | Staged upload resumes after browser tab closure and reopen. |
| W-A6-5 | Album sync across tabs | `web-upload-download-lifecycle.spec.ts` | Second browser context observes new manifest through album sync. |
| W-A6-6 | Share link download | `web-upload-download-lifecycle.spec.ts` | Anonymous share link downloads and decrypts shared photos client-side. |
| W-A6-7 | Visual regression for key screens | `web-upload-download-lifecycle.spec.ts` | Gallery, upload progress, and share-link pages match stable visual states. |

### Web coverage notes

- W-A6-3 and W-A6-4 previously had silent-pass risk before the Wave 14 strictness fix. They are now required to prove unique manifest writes and actual resume behavior.
- W-A6 runs remain a web-shell E2E gate; they do not replace Rust/WASM/UniFFI byte parity tests.

## Android coverage: instrumented/UI Automator A18

| ID | Scenario | Source test | Required signal |
| --- | --- | --- | --- |
| A18-1 | Photo happy path | `UploadLifecycleE2ETest.kt` | All shards upload and manifest finalization completes. |
| A18-2 | Process death/resume | `UploadLifecycleE2ETest.kt` | Persisted snapshot resumes after simulated process death. |
| A18-3 | Network failure/retry | `UploadLifecycleE2ETest.kt` | Upload retries after network failure and reaches success. |
| A18-4 | Manifest commit unknown / sync recovery | `UploadLifecycleE2ETest.kt` | Unknown finalization result recovers through album sync. |
| A18-5 | Cleanup / privacy scan | `UploadLifecycleE2ETest.kt` | Staging cleanup completes and privacy audit finds no plaintext residue. |
| A18-6 | Album deleted mid-upload | `UploadLifecycleE2ETest.kt` | Upload transitions to canceled without leaking plaintext. |
| A18-7 | Real device matrix | `UploadLifecycleE2ETest.kt` | Same suite is documented for multi-API execution. |

## Cross-platform parity: Q-final-1

| Category | Source | Required signal |
| --- | --- | --- |
| Manifest transcript parity | `crates/mosaic-parity-tests/tests/cross_platform_parity.rs` | WASM and UniFFI produce byte-identical manifest transcript bytes. |
| Encrypted envelope round-trip | `crates/mosaic-parity-tests/tests/cross_platform_parity.rs` | WASM encrypts/UniFFI decrypts and UniFFI encrypts/WASM decrypts. |
| Canonical snapshot CBOR parity | `crates/mosaic-parity-tests/tests/cross_platform_parity.rs` | Equivalent upload snapshots encode to identical canonical CBOR bytes. |
| Metadata strip parity | `crates/mosaic-parity-tests/tests/cross_platform_parity.rs` | JPEG, PNG, WebP, AVIF, HEIC, and synthetic MP4 stripping match. |
| Streaming AEAD parity | `crates/mosaic-parity-tests/tests/cross_platform_parity.rs` | v0x04 streaming envelope decrypts across facade/shared-core boundaries. |
| Sidecar canonical bytes parity | `crates/mosaic-parity-tests/tests/cross_platform_parity.rs` | TLV metadata sidecar and video sidecar bytes match. |
| Finalize idempotency key parity | `crates/mosaic-parity-tests/tests/cross_platform_parity.rs` | Native Rust, WASM, and UniFFI produce `mosaic-finalize-{jobId}` identically. |

### Cross-platform coverage notes

- Finalize idempotency key parity was added in the Wave 13 blocker fix.
- WASM-artifact parity coverage from Wave 13 mediums includes `js_shim_parity.rs`; it remains part of the release evidence even though the matrix groups it under parity/artifact gates.

## Android device matrix

| Class | API | Android version | v1 requirement |
| --- | --- | --- | --- |
| Legacy floor | API 26 | Android 8.0 | Required manual/device-lab lane until CI emulator coverage exists. |
| Mid-tier baseline | API 30 | Android 11 | Required manual/device-lab lane; representative of older active devices. |
| Current stable | API 34 | Android 14 | Required manual/device-lab lane and preferred emulator lane. |
| Latest supplemental | API 35 | Android 15 | Supplemental lane when runner/device availability permits. |

## Coverage gaps and mitigations

| Gap | Impact | Current mitigation | v1 disposition |
| --- | --- | --- | --- |
| Real-device Android lanes require manual provisioning until CI emulator lanes are configured. | Device-specific lifecycle failures can escape normal CI. | A18 documents the multi-API matrix; release evidence must record manual/API runs. | Accepted with manual proof for v1 freeze. |
| W-A6-3/W-A6-4 had silent passes before Wave 14. | Concurrent upload/resume regressions could be hidden. | Strict assertions now require unique records, manifest version movement, and resume completion. | Closed for v1. |
| WASM artifact parity was added as Wave 13 medium coverage (`js_shim_parity.rs`). | Generated JS/WASM shim drift could break web clients after Rust parity passes. | Keep artifact parity in release evidence alongside `mosaic-parity-tests`. | Closed for v1 evidence; keep in CI where currently wired. |

## Required release evidence

1. Web: `tests/e2e/tests/web-upload-download-lifecycle.spec.ts` reports all W-A6 scenarios passing.
2. Android: `UploadLifecycleE2ETest.kt` reports all A18 scenarios passing on the required API/device matrix or documented manual device-lab runs.
3. Parity: `cargo test -p mosaic-parity-tests --features parity-tests --locked` reports all Q-final-1 categories passing.
4. Architecture guards continue to prove no raw secret FFI export and no plaintext queue/log regressions.
