# SPEC: Band 6 Auto-Import Media Policy

## Status

Locked at v1. Implemented as a dependency-safe Android shell foundation
seam in `02d7e2f` (`feat(android): add auto-import media policy seam`),
`7f3003d` (`feat(android): add auto-import scheduling seam`),
`e52d599` (`feat(android): add auto-import dedupe drift contracts`),
`38e4f75` (`test(android): harden auto-import capability boundary`), and
`b562f66` / `34b08a6` (test isolation fix-ups). The Lane C scheduling-seam
graduation landed in `ba1cac1` (`feat(android): wire Band 6 auto-import
scheduling seam into a real WorkManager worker`), which produced the real
`AutoImportWorker`, `AutoImportRuntime`, `AutoImportWorkPolicy`, and
`AutoImportWorkScheduler` under `apps/android-main/src/main/kotlin/.../work/`.

## Scope

This slice models optional Android camera-roll auto-import policy under the
JVM-only `apps/android-shell` scaffold. It does not add Android framework
permission requests, WorkManager scheduling, MediaStore queries, upload
networking, or backup behavior.

## Data Flow

```text
Android API level + requested media types
  -> AutoImportMediaPermissionDecision
     -> modern READ_MEDIA_IMAGES/READ_MEDIA_VIDEO abstraction on API 33+
     -> older READ_EXTERNAL_STORAGE abstraction before API 33

explicit user opt-in
  -> selected local album opaque identity + Mosaic destination album
  -> AutoImportMediaPolicyRecord
  -> READY_FOR_PERMISSION_CHECK only when enabled and selected-album scoped

MediaStore acquisition result
  -> opaque local media asset identity and/or encrypted staged reference
  -> AutoImportDurableMediaRecord
```

## Zero-Knowledge and Privacy Invariants

- Auto-import is disabled by default.
- UX framing is import/upload convenience for sharing, not backup.
- Policy state is scoped to an explicit selected-album opt-in.
- Durable policy/acquisition records reject raw `content://` and `file://`
  values.
- Durable records store opaque local asset identities and encrypted staged
  references only.
- Filenames, captions, EXIF/GPS, and device metadata are rejected at the policy
  boundary and redacted from DTO strings.
- Wi-Fi and battery-not-low defaults are represented as constraints only;
  concrete scheduling remains outside this lane.

## Component Tree

```text
apps/android-shell/src/main/kotlin/org/mosaic/android/foundation
  AutoImportMediaPolicy.kt

apps/android-shell/src/test/kotlin/org/mosaic/android/foundation
  AutoImportMediaPolicyTest.kt
```

`AndroidShellFoundationTest.kt` invokes the new test suite because the current
test runner executes a single JVM harness entry point.

## Verification Plan

- `.\scripts\test-android-shell.ps1`
- `git --no-pager diff --check`
