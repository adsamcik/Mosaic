# Android instrumented E2E tests

This source set contains emulator/device tests for the Android upload lifecycle, including the A18a-g scenarios in `org.mosaic.android.main.e2e.UploadLifecycleE2ETest`.

## Local run

```powershell
.\gradlew.bat :apps:android-main:connectedDebugAndroidTest
```

Build the instrumentation APK without a connected device:

```powershell
.\gradlew.bat :apps:android-main:assembleDebugAndroidTest
```

## Device prerequisites

- Android emulator or real device using one of the packaged ABIs: `x86_64` or `arm64-v8a`.
- API 26 minimum, with CI coverage expected on API 26, API 30, API 34, and API 35.
- 2 GB RAM minimum; 4 GB RAM recommended for API 34/35 emulator images.
- Hardware acceleration enabled for local emulator runs.

## Backend mode

The E2E support layer starts an OkHttp `MockWebServer` per test so the suite does not require a separately running Mosaic backend. Tests seed a programmatic instrumented user and drive reducer/effect flows against deterministic mock upload, manifest-finalize, and sync-confirmation responses.

## Fixtures

Small image fixtures live in `src/androidTest/assets/` and are each under 100 KB. The staging helper copies them through `PhotoPickerStagingAdapter` into app-private staging before each lifecycle test.

## A18 real-device matrix

Run the same `connectedDebugAndroidTest` suite on:

| Lane | API | Purpose |
|------|-----|---------|
| min | 26 | Lowest supported API |
| mid | 30 | Mid-range device behavior |
| current | 34 | Android 14 foreground-service behavior |
| latest | 35 | Latest compile/target SDK lane |

CI runner configuration must provision these emulator images and invoke `:apps:android-main:connectedDebugAndroidTest` once per lane. When no emulator is available, `:apps:android-main:assembleDebugAndroidTest` is the compile gate.
