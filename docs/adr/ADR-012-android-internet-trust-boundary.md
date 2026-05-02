# ADR-012: INTERNET trust boundary on Android

## Status

Accepted. Gates Lane A (Android upload pipeline) ticket A1 and downstream tickets that depend on network access (A4, A5b, A10, A11, A18*).

## Context

`apps/android-main/AndroidManifest.xml` currently declares **no INTERNET permission.** The manifest comment (line 8) states: *"No INTERNET permission. This module does not contact a server."* This is accurate for the foundation slice that ships only Rust core linkage, the `AutoImportWorker` no-op stub, and bridge contracts.

Lane A of the Rust core completion programme adds real upload, manifest commit, and album sync — all of which require network access. INTERNET must be granted before any of A4 (`OkHttp` shared client), A5b (Tus client), A10 (manifest commit), A11 (album sync fetcher), or A12 (sync confirmation loop) can ship.

The 3-reviewer pass (`files/reviews/R3-opus47-coherence.md`) flagged that adding INTERNET expands the threat model and that no ADR currently documents the trust-boundary change. ADR-002 (backend zero-knowledge boundary) governs *what* the server may see; it does not govern *whether* the Android app talks to a server. ADR-007 (Photo Picker + foreground service) governs work scheduling, not network trust.

This is a once-per-product trust-boundary decision: INTERNET cannot be revoked at runtime once granted (uninstall/reinstall is the only revocation path), the manifest invariants test (`MergedManifestInvariantsTest`) currently asserts INTERNET *absent* and must flip, and Mosaic's privacy posture must remain that the server sees only opaque encrypted bytes regardless of INTERNET being granted.

## Decision

Mosaic Android grants the `android.permission.INTERNET` permission for v1 upload and sync support, **with the following constraints applied at the manifest, network, and code-review boundaries.**

### Manifest changes (A17 permission flip)

Required-present (manifest invariants test enforces *presence*):

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />  <!-- Android 14+ -->
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />            <!-- runtime; degraded UX if denied -->
<uses-permission android:name="android.permission.WAKE_LOCK" />                     <!-- partial wake locks for Doze-bypassed upload windows -->
```

`POST_NOTIFICATIONS` is allowed-but-runtime: the user may deny, in which case the foreground-service notification falls back to the system default (still required by FGS contract; just less informative). `WAKE_LOCK` is allowed because long Tus uploads need partial wake locks during active byte-pumping while the screen is off — the foreground service keeps the *process* alive, but the CPU still enters Doze without an explicit `WakeLock.acquire()`. Use is restricted to the upload worker (`apps/android-main/src/main/kotlin/.../upload/`) by static guard `android-wakelock-only-in-upload`.

Forbidden permissions (manifest invariants test enforces *absence*):

- **Storage / media (broad access — Photo Picker is the only allowed media path):**
  - `android.permission.READ_EXTERNAL_STORAGE`
  - `android.permission.WRITE_EXTERNAL_STORAGE`
  - `android.permission.MANAGE_EXTERNAL_STORAGE`
  - `android.permission.READ_MEDIA_IMAGES`
  - `android.permission.READ_MEDIA_VIDEO`
  - `android.permission.READ_MEDIA_AUDIO`
  - `android.permission.READ_MEDIA_VISUAL_USER_SELECTED` (Photo Picker uses non-permission-gated grant flow; this permission is its non-Picker counterpart)

- **Sensor / capture (no on-device capture surfaces in v1):**
  - `android.permission.RECORD_AUDIO`
  - `android.permission.CAMERA`
  - `android.permission.ACCESS_FINE_LOCATION`
  - `android.permission.ACCESS_COARSE_LOCATION`
  - `android.permission.ACCESS_BACKGROUND_LOCATION`

- **Identity / contact / messaging (zero need; common silent-expansion vector via JVM SDKs):**
  - `android.permission.GET_ACCOUNTS`
  - `android.permission.READ_CONTACTS`
  - `android.permission.WRITE_CONTACTS`
  - `android.permission.READ_SMS`
  - `android.permission.SEND_SMS`
  - `android.permission.READ_PHONE_STATE`
  - `android.permission.READ_PHONE_NUMBERS`

- **Connectivity / radio (not needed; bypassing them keeps fingerprint surface minimal):**
  - `android.permission.BLUETOOTH`
  - `android.permission.BLUETOOTH_ADMIN`
  - `android.permission.BLUETOOTH_CONNECT`
  - `android.permission.BLUETOOTH_SCAN`
  - `android.permission.NFC`
  - `android.permission.UWB_RANGING`

- **System / privileged (silent-expansion classes):**
  - `android.permission.QUERY_ALL_PACKAGES`           <!-- API 30+ silent app-fingerprinting -->
  - `android.permission.SYSTEM_ALERT_WINDOW`
  - `android.permission.REQUEST_INSTALL_PACKAGES`
  - `android.permission.RECEIVE_BOOT_COMPLETED`       <!-- no boot-time scheduling -->
  - `android.permission.SCHEDULE_EXACT_ALARM`
  - `android.permission.USE_EXACT_ALARM`
  - `android.permission.PACKAGE_USAGE_STATS`
  - `android.permission.READ_LOGS`

`MergedManifestInvariantsTest` (A17) is updated to:
1. Assert every entry in the required-present list is present.
2. Assert every entry in the forbidden-permissions list is absent.
3. Assert `<application android:allowBackup="false" android:hasFragileUserData="true">`.
4. Assert `<application android:usesCleartextTraffic="false">` (defensive; default is false on API 28+).
5. Assert `<application android:networkSecurityConfig="@xml/network_security_config">` is set and the file declares **zero exemption domains** (`<base-config cleartextTrafficPermitted="false">`, `<domain-config>` blocks list only the operator-configured hostnames from `operatorConfig`).
6. Assert no `<intent-filter>` declares deep-link auto-handlers that could leak metadata (only the explicit auth callback intent filter is allowed).

### Permission-grant flow + upgrade-time disclosure

INTERNET is a `normal` permission and is granted at install time. No runtime prompt is required. `ACCESS_NETWORK_STATE` is `normal`. `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_DATA_SYNC` are `normal`. `WAKE_LOCK` is `normal`. The user-visible disclosure happens via:

- **Play Store data-safety section** (must accurately list "uploaded encrypted to server").
- **App-internal "Privacy & Network" settings screen** documents the network behavior in plain language.
- **Upgrade-time onboarding screen.** A user who installed a pre-A1 build and updates to a build with INTERNET sees a one-time onboarding card on first launch summarising the new network capability and linking to the Privacy & Network settings. The card is dismissible but not auto-dismissed; user must tap "I understand" (or "Open settings"). Recorded in IDB-equivalent local-only flag store; never sent to operator.

`android.permission.POST_NOTIFICATIONS` (Android 13+) for foreground-service notifications is a separate runtime permission handled in A15; denial degrades but does not block uploads.

### Network trust posture

- **TLS 1.2 minimum.** OkHttp `ConnectionSpec.MODERN_TLS`. TLS 1.3 preferred.
- **No cleartext.** `usesCleartextTraffic="false"` enforced; `network_security_config.xml` declares no exemption domains.
- **Cert pinning** posture is set by ADR-019 (separate ADR).
- **No HTTP body logging.** Boundary guard `android-no-okhttp-body-logging` rejects any code that wires `HttpLoggingInterceptor.Level.BODY` or any extending interceptor that could capture body bytes.
- **No third-party crash reporters that auto-upload error payloads.** Crash payloads that include bodies, headers, or URLs are equivalent to body logging.
- **No analytics SDKs that auto-collect network metadata.** Telemetry is opaque-error-codes-only per ADR-018.

### Code-review boundary

The following code patterns are forbidden by static guards (added under `tests/architecture/`):
- `HttpLoggingInterceptor.Level.BODY` anywhere.
- Direct construction of `OkHttpClient` outside the shared `MosaicHttpClient` singleton (forces every code path through the same TLS/pin/no-body-logging policy).
- `URL("http://...").openConnection()` style imperative HTTP without TLS guarantees.
- Network calls outside `apps/android-main/src/main/kotlin/.../net/` package.
- Network calls *not* invoked from a `WorkManager` worker, a `CoroutineWorker`, or a clearly user-initiated `ViewModel` flow that holds a foreground UI lock (no silent background fetches).

### What the server may *not* see (unchanged from ADR-002)

- plaintext media bytes,
- plaintext metadata, EXIF, GPS, captions, file names,
- raw account / identity / epoch keys,
- raw Photo Picker URIs,
- analytics payloads identifying user content.

What the server *may* see is bounded to the v1 leakage budget (`SPEC-LateV1ProtocolFreeze.md` §"Frozen now" item 5).

### Permission-grant flow

INTERNET is a `normal` permission and is granted at install time. No runtime prompt is required. `ACCESS_NETWORK_STATE` is also `normal`. The user-visible disclosure happens via:
- Play Store data-safety section (must accurately list "uploaded encrypted to server").
- App-internal "Privacy & Network" settings screen documents the network behavior in plain language.
- Upgrade-time onboarding card (per "Permission-grant flow + upgrade-time disclosure" above).

`android.permission.POST_NOTIFICATIONS` (Android 13+) for foreground-service notifications is a separate runtime permission handled in A15.

## Options Considered

### Add INTERNET without an ADR

- Pros: zero ADR overhead.
- Cons: silent expansion of the threat model; future contributors don't know which constraints are policy vs convention; manifest-invariants test cannot diff against a documented baseline.
- Conviction: 1/10.

### Stay offline-only (no INTERNET) and ship a separate "upload" app

- Pros: Mosaic-main stays "viewer/editor only"; risk minimised.
- Cons: dramatic UX regression; doubles the Android codebase; Play Store policy concerns (two apps for one feature); does not actually solve the problem (the upload app would face the same ADR question).
- Conviction: 2/10.

### Grant INTERNET; document constraints; static-guard everything (this decision)

- Pros: minimal manifest delta; static guards make policy violations CI failures, not code-review failures; trust-boundary change is documented and reviewable; existing privacy posture (no-broad-media, no-cleartext, no-body-logging) is codified.
- Cons: trust-boundary expansion is real; once shipped, cannot trivially un-ship.
- Conviction: 9/10.

### Grant INTERNET via a `WorkManager`-only sandboxed sub-process

- Pros: stronger isolation between UI and network.
- Cons: Android does not cleanly support per-process permission scoping; `INTERNET` is granted at app level, not process level; complexity for negligible gain.
- Conviction: 3/10.

## Consequences

- A1 ships this ADR. A17 flips the manifest and the invariants test.
- A4 (shared OkHttp client) is the *only* network entry point. Boundary guard rejects alternatives.
- A5b (Tus adapter), A10 (manifest commit), A11 (album sync fetcher), A12 (sync confirmation loop) all consume `MosaicHttpClient`.
- ADR-019 owns the cert pinning posture decision.
- ADR-018 owns the telemetry / kill-switch posture; this ADR commits to no body logging and no auto-uploaded crash payloads regardless of ADR-018's outcome.
- Boundary guards added: `android-no-okhttp-body-logging`, `android-net-only-from-shared-client`, `android-no-imperative-http`, `android-net-package-scope`.
- Play Store data-safety form must be updated before A18g (real-device matrix) ships to internal testing.
- `docs/SECURITY.md` adds a "Network trust boundary" section referencing this ADR.

## Reversibility

Permission addition is **runtime irreversible**: shipping a build that requests INTERNET cannot be retroactively undone for users who installed it. The static-guard / no-body-logging / TLS-only constraints are reversible at low cost (boundary guards can evolve). The forbidden-permissions list is reversible by ADR amendment. The decision to grant INTERNET at all is the irreversible part; the constraints around it are not.
