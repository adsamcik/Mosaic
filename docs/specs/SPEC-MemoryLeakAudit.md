# SPEC-MemoryLeakAudit

## Scope

Audit and fixes for memory lifecycle risks across Mosaic web and Android upload/download paths. This document records confirmed leaks, potential leaks, no-leak findings, verification commands, and ongoing guardrails.

## Findings

### Web

| Suspect | Status | Evidence | Fix |
|---|---:|---|---|
| WASM linear memory / wasm-bindgen result objects | ✅ | `apps/web/src/workers/rust-crypto-core.ts:90-109` frees result objects in `consumeResult`; streaming close tests cover explicit/final cleanup. | None. |
| Crypto worker handle registries | 🔴 | `apps/web/src/workers/crypto.worker.ts:459-580` had closed singleton handles left reachable until `clearAll()`, and `clearAll()` attempted to free already-closed handles. Reproduced by `memory-leak.test.ts`. | Added non-sensitive diagnostics, skipped already-closed handles in cascade cleanup, and nulled singleton account/identity pointers when freed. |
| Blob URLs | ✅ | `PendingPhotoThumbnail.tsx:13-18`, `SharedPhotoLightbox.tsx:135,412,461-464`, `photo-store.ts:167,337` revoke created URLs. | None. |
| ImageBitmap | 🟡 | `thumbnail-generator.ts` and `video-frame-extractor.ts` are out of this implementer scope; audit should remain part of image pipeline reviews. | Documented only. |
| Worker postMessage / Comlink queues | ✅ | Crypto pool shutdown terminates workers and clears slots; coordinator subscriptions return `unsubscribe`. | None. |
| Listener cleanup | ✅ | `useSync.ts:74-84`, `useBackgroundFetch.ts:122-123`, `useDownloadManager.ts:147-150` balance add/remove. | Added `tests/architecture/web-listener-cleanup.ps1`. |
| IndexedDB transaction holders | ✅ | `link-tier-key-store.ts` closes DB handles after transactions. | None. |

### Android

| Suspect | Status | Evidence | Fix |
|---|---:|---|---|
| Bitmap decode in media tiers | 🔴 | `MediaTierGenerator.kt:12-17` decoded a source bitmap and passed it to the encoder without recycling. | `MediaTierGenerator.kt:17-20` recycles in `finally`. |
| Bitmap tier intermediates | 🔴 | `BitmapTierEncoder.kt:20-29` created sRGB/scaled tier bitmaps; `ThumbHashCalculator` created a 16x16 sample without recycling. | `BitmapTierEncoder.kt:27-35,87-105,110-116` recycles distinct intermediate/sample bitmaps. |
| Video frame bitmap / rotated bitmap | 🔴 | `VideoFrameExtractor.kt:16-20` decoded a frame and sometimes created a rotated bitmap without recycling either. | `VideoFrameExtractor.kt:18-25` recycles both in `finally`. |
| MediaMetadataRetriever | ✅ | `VideoFrameExtractor.kt:36-46` calls `retriever.release()` in `finally`. | None. |
| Room database / cursors | ✅ | Room DAO APIs are used; `PrivacyAuditPeriodicWorker.kt:38` closes worker-created DBs; Android tests close DBs in teardown. | None. |
| WorkManager handles / observers | ✅ | Foreground service closes reducer subscription on destroy. | None. |
| OkHttp / Tus sessions | ✅ | `MosaicHttpClient` centralizes OkHttp creation; Tus session file streams use `use`. | None. |
| UniFFI handle release | ✅ | `ShardCryptoEngine.kt:73` closes streaming encryptors; epoch handles are caller-owned. | None. |

### Rust

| Suspect | Status | Evidence | Fix |
|---|---:|---|---|
| Arc cycles | ✅ | Handle stores use `OnceLock<Mutex<HashMap<...>>>`, not `Arc` cycles. | None. |
| Static caches / registries | ✅ | `mosaic-client` secret/identity/epoch/link registries expose close functions and zeroizing Drop paths. | None. |
| WASM streaming shard registry | ✅ | Streaming shard close removes handles; tests cover final chunk and idempotent close. | None. |
| WASM master key handles | 🟡 | Rust audit found `MASTER_KEY_HANDLES` lacks a public JS-facing close in the WASM facade. Not touched because Rust source was outside this implementer scope. | Recommend explicit close/zeroize API in Rust/WASM follow-up. |
| WASM sidecar handles | 🟡 | Explicit close functions exist, but abandoned JS callers can leave sidecar handles until worker reset. | Recommend finalizer/age-based purge in Rust/WASM follow-up. |

## Fix Descriptions

1. Android source bitmaps now recycle deterministically after media tier generation.
2. Android video frame extraction now recycles decoded frames and rotated copies after tier encoding.
3. Android bitmap tier encoding now owns and recycles all intermediate bitmaps it creates.
4. Web crypto worker registry cleanup now drops stale singleton references and avoids repeated close calls during `clearAll()`.
5. Web diagnostics expose only handle counts, never key material, so tests can enforce registry baseline recovery.

## Verification Plan and Commands

| Gate | Command |
|---|---|
| Rust format | `cargo fmt --all -- --check` |
| Rust tests | `cargo test --workspace --locked --no-fail-fast` |
| Web build | `cd apps\web ; npm run build` |
| Web tests | `cd apps\web ; npm test` |
| Android assemble | `.\gradlew.bat :apps:android-main:assembleDebug` |
| Android tests | `.\gradlew.bat :apps:android-main:testDebugUnitTest` |
| Listener guard | `pwsh tests\architecture\web-listener-cleanup.ps1` |

Targeted checks added:

- `apps/web/src/lib/__tests__/memory-leak.test.ts` verifies repeated handle lifecycles return to baseline and listener add/remove calls balance.
- `apps/android-main/src/test/kotlin/org/mosaic/android/main/memory/MemoryLeakTest.kt` verifies repeated video extraction recycles decoded bitmaps and repeated shard encryption worker runs complete without bitmap allocation paths.

## Ongoing Leak Detection

- Add LeakCanary as an instrumented Android-only dependency for Activity/Worker/object-retention watchpoints. Keep it out of JVM unit tests.
- Add heap-snapshot smoke tests for web media views using Playwright + MutationObserver lifecycle markers.
- Keep `tests/architecture/web-listener-cleanup.ps1` in CI as a fast heuristic for `useEffect` listener leaks.
- Add Rust/WASM registry-size test exports for master key and sidecar handle stores when those modules are in scope.

## Zero-Knowledge Invariants

- Diagnostics expose only aggregate counts, not keys, salts, encrypted payloads, or plaintext.
- Bitmap recycling happens after encoding only; no server/API data shape changes.
- No backend behavior changed.
