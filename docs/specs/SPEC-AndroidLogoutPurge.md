# SPEC: Android Logout / Account-Switch Purge Cascade

> **Status:** Design contract — no implementation exists yet.
> **Target version:** v1.1+ (gating multi-account / logout UI work).
> **Authoritative scope:** the Android client (`apps/android-main`). Web client
> logout is out of scope; see `docs/SECURITY.md` for the existing web flows.
> **Companion work:** lands alongside the multi-account UI; this SPEC defines
> the contract a `LogoutPurger` must satisfy when that UI is wired up.

---

## 1. Background & Motivation

### 1.1 Current state

The Android app (`apps/android-main`) is **single-tenant by construction**:

- One in-process `AccountKeyHandle` is held by
  `ProcessActiveAccountHandleProvider`
  (`apps/android-main/src/main/kotlin/org/mosaic/android/main/crypto/EpochHandleResolver.kt:27-40`).
- No `Logout` button exists in any screen. `MainActivity` only smoke-tests the
  FFI by deliberately calling `unlockAccountWipingAll` with synthetic input and
  closing whatever handle comes back
  (`apps/android-main/src/main/kotlin/org/mosaic/android/main/MainActivity.kt:80-97`).
- All Room and filesystem regions assume a single owner. There is no
  account-scoped sub-path anywhere on disk.
- `android:allowBackup="false"` is set in `AndroidManifest.xml`, so cloud
  Auto-Backup never copies the storage regions enumerated below off-device.

### 1.2 Why this SPEC exists

When multi-account or a "Log out" affordance ships in v1.1+, the residual
single-tenant assumption becomes a **zero-knowledge violation hazard**:

- Account B logging in after account A could decrypt residual envelopes still
  on disk if A's wrapped epoch seeds are still in `album_epoch_keys` and the
  associated `*.envelope` blobs are still under `filesDir/encrypted-shards/`.
- A foreground service notification originally posted for account A could
  still be visible while account B is using the app.
- An OS-restored process (after a kill) could re-open A's
  `AccountKeyHandle` if the unlock flow naively reuses persisted state.

This SPEC defines **exactly** which surfaces must be purged, **in what order**,
**with what crash-safety guarantees**, and **with what test coverage** before a
Logout button can ship.

### 1.3 Connection to prior work

| Prior slice | Commit(s) | Relevance |
|---|---|---|
| **v1.0.1 s34** per-album envelope dir + `AlbumPurger` epoch-key clearing | `96bb345`, `682ad5f`, `842c767`, `0a2a64a` | Established per-album subdirectory layout (`filesDir/encrypted-shards/<albumId>/`) and the precedent that **file I/O purge runs after the Room transaction commits**. This SPEC generalises that pattern from single-album to whole-account. |
| **v1.0.1 s15** right-to-erasure (web Delete Account flow) | `eba45ad`, `9e4bd6c`, `71253dc` | Establishes the server-side cascade. **Logout is not deletion** — server retains the account — but local purge must be at least as thorough as right-to-erasure for on-device state. See §8 for audit-log retention question. |
| **v1.0.1 s24** expedited shard workers + notification channels | `c56185d`, `1771675`, `8488513` | Adds the `UploadForegroundService` and per-worker notification channels that must be cancelled on logout. |

### 1.4 Threat model addressed

1. **Multi-account exposure on the same device.** Account B, logging in
   immediately after A, must not be able to read, even partially, any of A's
   ciphertext, plaintext metadata, derived caches, or wrapped key material.
2. **Logout-from-shared-device.** A user logs out on a borrowed device; the
   next holder of the device (with no Mosaic credentials) must find no
   residue of the previous session that an offline analysis (e.g. ADB pull
   from a rooted device) could correlate to a real identity.
3. **Crash mid-logout.** If logout is interrupted (process kill, OOM, device
   reboot, low-storage), the next launch must complete the purge **before**
   the login screen accepts new credentials.

Out of scope: hardware key recovery from flash after the platform's
file-based encryption layer has been re-keyed (this is platform-provided when
the user resets the device).

---

## 2. Storage Inventory

The exhaustive set of on-device storage surfaces, established by inspecting
the codebase at HEAD `f0ffb06`. Every region listed here MUST appear in the
`LogoutPurger` cascade or be justified for exclusion in §8.

### 2.1 Room database (`mosaic_upload_queue.db`)

Single Room database, version 3, defined at
`apps/android-main/src/main/kotlin/org/mosaic/android/main/db/UploadQueueDatabase.kt:10-22`.
Path: `context.getDatabasePath("mosaic_upload_queue.db")` (plus the WAL
sidecars `-shm`, `-wal`).

| Table | Source | Contains | Purge action |
|---|---|---|---|
| `upload_queue_records` | `UploadQueueEntities.kt:9-31` | Per-job phase, idempotency keys, snapshot revision, last effect/event IDs (opaque IDs only — privacy triggers in `UploadQueueDatabase.kt:97-141` reject plaintext PII markers). | `DELETE FROM` |
| `shard_staging_refs` | `UploadQueueEntities.kt:33-51` | Shard ID, job ID, SHA-256 of staged plaintext. | `DELETE FROM` (also FK-cascades from `upload_queue_records`) |
| `staged_picker_blobs` | `UploadQueueEntities.kt:53-71` | Blob ID, MIME, size of picker-staged file. | `DELETE FROM` |
| `upload_job_snapshots` | `UploadQueueEntities.kt:73-80` | Canonical CBOR of upload job FSM (opaque to server but contains plaintext-derived state locally). | `DELETE FROM` |
| `album_sync_snapshots` | `UploadQueueEntities.kt:82-89` | Canonical CBOR per-album sync state. | `DELETE FROM` |
| `album_content_hashes` | `UploadQueueEntities.kt:91-104` | (albumId, contentHash, photoId) dedup index — plaintext-derived. | `DELETE FROM` |
| `album_epoch_keys` | `UploadQueueEntities.kt:106-116` | **L3 wrapped epoch seeds** — encrypted at rest with the account L2 key, but their *presence* leaks album epoch counts. | `DELETE FROM` (already purged per-album by `AlbumPurger.kt:36`) |

**Whole-DB purge action:** The cleanest cascade is to **close the
`RoomDatabase`, `context.deleteDatabase("mosaic_upload_queue.db")`, then
re-create lazily on next sign-in**. This eliminates SQLite WAL/SHM residue
and matches the precedent set for per-album purges (the Room transaction
runs first, then file I/O — except here the "file" is the DB file itself,
which is purged last). See §3 for ordering.

### 2.2 Filesystem regions under `context.filesDir`

All paths are app-private (Android FBE-protected, not Auto-Backupped because
of `allowBackup="false"`).

| Path | Owner | Contains | Purge action |
|---|---|---|---|
| `filesDir/encrypted-shards/<albumId>/<cacheKey>.envelope` | `ShardEnvelopeStore.kt:86-89` (root), `ShardEnvelopeStore.kt:73-81` (per-album delete) | Mosaic-encrypted shard envelopes (XChaCha20-Poly1305 ciphertext + 64-byte header). Opaque to attacker without L3 key, but **presence + filename leaks album graph**. | Recursive delete of `encrypted-shards/` root. |
| `filesDir/encrypted-shards/<sha>.envelope` (legacy flat layout) | `EnvelopeLayoutMigrator.kt:9-12` | Pre-v1.0.1 leftover envelopes that the s34 migrator may not yet have processed (the migrator is idempotent and gated by `mosaic.envelope_layout` SharedPreferences). | Recursive delete of `encrypted-shards/` covers this. |
| `filesDir/staging/<uuid>.blob` | `AppPrivateStagingManager.kt:31-32, 169-171` | **Plaintext** copies of SAF-picked source files awaiting encryption. Highest-sensitivity on-disk region. | Recursive delete of `staging/`. |
| `filesDir/staging/<uuid>.properties` | `AppPrivateStagingManager.kt:152-158, 171` | Plaintext metadata (`displayName`, `lastAccessMs`) for staged blobs. | Same recursive delete. |
| `filesDir/upload-manifests/` | `ShardUploadWorker.kt:228` | Per-job upload manifest scratch dir used by the TUS worker. | Recursive delete. |

**Crash-safety note for staging:** `AppPrivateStagingManager` writes the
`.blob` payload before the `.properties` sidecar, so a partial-write at
logout time may leave orphan blobs. Recursive delete handles both cases
identically.

### 2.3 Rust FFI handle registries

Rust owns the cleartext key material; the JVM only holds opaque `ULong`
handle IDs. Logout **must** close every handle to drop the Rust-owned
secret-material `zeroize`-on-drop guarantees.

| Handle type | Tracker / lifecycle | Close FFI |
|---|---|---|
| `AccountKeyHandle` (L2) | `ProcessActiveAccountHandleProvider` singleton, `EpochHandleResolver.kt:27-40`. One live per process. | `AndroidRustAccountApi.closeAccountKeyHandle(handle)` (`AndroidRustAccountApi.kt:9, 58`). |
| `EpochKeyHandle` (L3) | Per-decrypt/encrypt scope: `OpenedEpochHandle` is `AutoCloseable` and closed in a `use {}` block by `ShardEncryptionWorker` (`EpochHandleResolver.kt:16-21, 53-55`). Should be **zero open at logout** under correct usage. | `AndroidRustEpochApi.closeEpochKeyHandle` (`AndroidRustEpochApi.kt:7, 58`). |
| `IdentityHandle` (Ed25519 signing) | Opened/closed around manifest-sign calls. Should be **zero open at logout**. | `AndroidRustIdentityApi.closeIdentityHandle` (`AndroidRustIdentityApi.kt:6, 61-62`). |

**Inventory gap (file as open question in §8):** there is no central handle
registry — handle leaks are caught only by the FFI's per-handle `is_open`
predicate and by `AutoCloseable` discipline at call sites. A `LogoutPurger`
that relies on "close everything" needs either (a) a global registry to
iterate, or (b) a Rust-side `closeAllHandlesForAccount(accountKeyHandle)`
sweep that walks the Rust handle table. The simplest contract: on logout,
call `closeAccountKeyHandle` on the active handle and have Rust invalidate
all transitively derived `EpochKeyHandle` / `IdentityHandle` instances
(verify this is what the Rust side actually does; if not, file follow-up).

### 2.4 In-memory caches

| Cache | Owner | Purge action |
|---|---|---|
| `ProcessActiveAccountHandleProvider.accountKeyHandle` | `EpochHandleResolver.kt:29` | `ProcessActiveAccountHandleProvider.clear()` (`EpochHandleResolver.kt:37-39`). |
| Any future in-memory `EpochKeyHandle` cache | (none today) | Must be cleared before §3 Phase 1 closes the account handle. |

### 2.5 SharedPreferences files

Enumerated from `getSharedPreferences(...)` call sites.

| Prefs name | Source | Contents | Purge action |
|---|---|---|---|
| `mosaic.envelope_layout` | `EnvelopeLayoutMigrator.kt:29, 53` | `envelope_layout_migrated_v1_0_1` bool — pure migration idempotency flag. | **Retain** across logout (migration state is account-independent). |
| `mosaic_staging_privacy` | `AppPrivateStagingManager.kt:181` (`CLEANUP_PREFS_NAME`), accessed at `:101, :174` | `lastCleanupAt` long — privacy-audit timestamp, account-independent. | **Retain** (or clear; no data leakage either way). |
| `org.mosaic.android.main.migrations` | `ShellStubRecordMigration.kt:11` (`MIGRATION_PREFS_NAME`) | Migration completion flags. | **Retain** (account-independent). |
| `org.mosaic.android.shell.stub_records` | `ShellStubRecordMigration.kt:12` (`SHELL_STUB_PREFS_NAME`) | Pre-existing shell stub records being migrated out. | **Retain** (account-independent). |

**Auth tokens — current state:** the codebase has **no `authToken`,
`bearerToken`, `cookieJar`, or `Remote-User`-storing SharedPreferences**. Auth
flows through the trusted reverse proxy (`Remote-User` header) and the
Android client does not persist a session token. **When multi-account ships
this changes** — the new account-identity persistence file (likely an
`EncryptedSharedPreferences` keyed by Android Keystore) MUST be added to
this inventory before the Logout button ships. See §8 OQ-3.

### 2.6 WorkManager persistent state

WorkManager has its own internal SQLite DB
(`databases/androidx.work.workdb`) that persists scheduled and finished work
records.

| Region | Purge action |
|---|---|
| Per-job tagged work (`ShardEncryptionScheduler.uploadJobTag(jobId)`) | `WorkManager.cancelAllWorkByTag(tag)` for every tag of every job belonging to the logging-out account. `AlbumPurger.kt:51-55` shows the existing precedent for per-album. |
| `AutoImportWorker` periodic + one-shot work | `WorkManager.cancelUniqueWork(...)` and `cancelAllWorkByTag(...)`. |
| `PrivacyAuditPeriodicWorker` | Cancel; reschedule lazily on next sign-in. |
| `androidx.work.workdb` itself | **Do not delete the DB file** — WorkManager owns its own schema lifecycle and deleting under it corrupts the singleton. Use `WorkManager.cancelAllWork()` (whole-process scope, safe for single-account today) or `cancelAllWorkByTag` per known tag. |

### 2.7 Foreground service & notification channels

Notification channels created at app startup (`MosaicApplication.kt:37, 57-58, 81-82`)
and on-demand by workers:

| Channel ID source | Behaviour on logout |
|---|---|
| `UploadForegroundService.NOTIFICATION_CHANNEL_ID` (`service/UploadForegroundService.kt:103-108`) | Cancel all active notifications via `NotificationManager.cancelAll()` scoped to Mosaic's channels. Channel itself is account-independent and can remain registered. |
| `ShardWorkerForegroundInfo.CHANNEL_ID` (`upload/ShardWorkerForegroundInfo.kt:64-69`) | Same: cancel notifications, keep channel registered. |
| `AutoImportWorker.CHANNEL_ID` (`work/AutoImportWorker.kt:90-96`) | Same. |
| `PrivacyAuditPeriodicWorker.CHANNEL_ID` (`privacy/PrivacyAuditPeriodicWorker.kt:60-65`) | Same. |

**Active foreground service:** if `UploadForegroundService` is running at
logout time, it must be stopped (`stopService` + `stopForeground`) **before**
Phase 1 closes the account handle — otherwise it will try to acquire an
`EpochKeyHandle` against an already-closed account and crash.

### 2.8 WebView / OAuth state

Grep for `WebView`, `CookieManager`, `CookieJar`, `oauth` returns **no
matches** in `apps/android-main/src/main/kotlin`. No WebView is currently
embedded. If a future OAuth flow embeds one, this inventory must be updated
to include `CookieManager.getInstance().removeAllCookies(...)`, `WebStorage`,
and `WebViewDatabase` wipes.

### 2.9 Out-of-band caches (cacheDir, externalCacheDir)

Grep for `cacheDir` returns no Mosaic-owned writes inside `apps/android-main/src/main/kotlin`.
`externalCacheDir` is never used. If future work adds a `cacheDir`
thumbnail/derived-image cache, this inventory must be extended.

---

## 3. Purge Cascade Order

The cascade is split into **four phases** with strict ordering. Each later
phase MAY rely on the success of every earlier phase; earlier phases MUST
NOT depend on later ones.

### 3.1 Phase 1 — Synchronous, before the UI returns to login

**Goal:** make the app *unable* to make authenticated requests or decrypt
ciphertext, even if everything below this point fails.

1. Stop `UploadForegroundService` (`stopService` + `stopForeground(STOP_FOREGROUND_REMOVE)`).
2. `NotificationManager.cancelAll()` for Mosaic-owned notifications.
3. Clear any in-memory account-identity state (the future
   account-identity persistence file from §2.5, once it exists, MUST be
   wiped here — *before* any in-memory handle close).
4. Call `closeAccountKeyHandle(activeAccountKeyHandle)`; this MUST also
   invalidate every derived `EpochKeyHandle` / `IdentityHandle` either via
   Rust-side cascade or via an explicit registry sweep (see §7 and §8 OQ-2).
5. `ProcessActiveAccountHandleProvider.clear()`.

After Phase 1 completes, the UI navigates to the login screen. The remaining
phases run **with the user already logged out**, so even a crash mid-purge
cannot leak fresh requests against the logged-out account.

### 3.2 Phase 2 — Atomic Room transaction

**Goal:** make on-disk metadata internally consistent ("all gone") in a
single commit.

Run inside `database.withTransaction { ... }`:

1. `uploadQueueDao().deleteAll()` (and all child tables via FK cascade or
   explicit `deleteAll()` per DAO).
2. `albumSyncSnapshotDao().clear()`, `albumContentHashDao().clear()`,
   `albumEpochKeyDao().clear()`, `uploadJobSnapshotDao().clear()`,
   `stagedPickerBlobDao().clear()`, `shardStagingDao().clear()` — each
   exposes a parameterless wipe (or this SPEC mandates one is added).
3. Set the **resume marker** (§4) inside the same transaction so the marker
   and the row deletions commit together.

The transaction commits or rolls back atomically. After commit, the Room DB
is observably empty.

### 3.3 Phase 3 — Post-transaction filesystem purge

**Goal:** drop all on-disk ciphertext, plaintext staging, and derived caches.
This phase runs after the Phase 2 commit, mirroring the precedent in
`AlbumPurger.kt:56-60`.

Order (independent operations, but listed for determinism):

1. Recursively delete `filesDir/staging/` (plaintext — highest sensitivity).
2. Recursively delete `filesDir/encrypted-shards/`.
3. Recursively delete `filesDir/upload-manifests/`.
4. Close the `RoomDatabase` instance, then
   `context.deleteDatabase("mosaic_upload_queue.db")` to drop the DB file,
   `-shm`, and `-wal` sidecars. (Phase 2 already emptied the rows; this step
   ensures no WAL residue survives.)

Each step is best-effort: a failure logs but does not abort the cascade.
The resume marker (§4) records which steps succeeded so a later launch can
re-run only the failed steps.

### 3.4 Phase 4 — Best-effort, background

**Goal:** clean up state that survives a process restart and can safely be
deferred.

1. `WorkManager.cancelAllWorkByTag(...)` for every Mosaic upload-job tag
   recorded in the pre-purge `upload_queue_records` snapshot (collected
   into a list before Phase 2). For the "switch account" variant (§6), this
   becomes `cancelAllWorkByTag` for tags of the *outgoing* account only.
2. After cancellation completes, clear the resume marker (§4) — this is the
   *only* point at which the cascade is considered finished.

This phase may run inside a one-shot WorkManager job scheduled in Phase 1
with `ExistingWorkPolicy.REPLACE`. Crucially the *purge job itself must not
require the account handle* — it operates on tags (opaque strings) only.

### 3.5 Why this order

- Closing the account handle first means even an OOM mid-Phase-2 cannot
  trigger a network roundtrip using the old credentials.
- Room transaction before filesystem matches `AlbumPurger`: if the FS delete
  fails, the Room state is still consistent with "everything gone" and the
  next launch's resume run sees the marker and finishes the FS wipe without
  re-reading any stale rows.
- Deleting the DB file last (within Phase 3) means Phase 2's transaction is
  durable on disk before the file goes away — so a crash between commit and
  delete leaves the DB readable for the resume path.
- WorkManager cleanup is last because it is the only step that may
  legitimately race with workers already scheduled (we want them to be
  cancelled, not to re-enqueue against a half-purged state).

---

## 4. Crash-Safety Guarantees

### 4.1 The resume marker

A single file in `filesDir/logout-purge.marker` written **before Phase 1
begins** and deleted **at the end of Phase 4**. Contents (JSON):

```json
{
  "schemaVersion": 1,
  "startedAtMs": 1730000000000,
  "phasesCompleted": ["phase1", "phase2"],
  "purgeId": "<uuid>"
}
```

Alternatives considered: a SharedPreferences key. Rejected because the
preferences file lives under `shared_prefs/` and is itself a region the
cascade may touch in a future revision; a standalone file in `filesDir` is
easier to reason about and survives DB deletion in Phase 3.

### 4.2 Resume contract

On every app launch, **before** any login UI is shown:

1. Check for `filesDir/logout-purge.marker`.
2. If present, run a `LogoutPurger.resumeFromMarker()` that:
   - Skips phases listed in `phasesCompleted`.
   - Re-runs every later phase (idempotent operations only — all deletes
     and `cancelAllWorkByTag` calls are idempotent by construction).
   - Updates the marker after each phase.
   - Deletes the marker once Phase 4 completes.
3. **Only after the marker is gone** may the login screen accept credentials.

### 4.3 Idempotency keys

| Operation | Idempotency basis |
|---|---|
| `DELETE FROM <table>` | No-op on empty table. |
| `dir.deleteRecursively()` | No-op when dir does not exist. |
| `context.deleteDatabase(name)` | Returns `false` for already-absent file. |
| `WorkManager.cancelAllWorkByTag(tag)` | No-op for unknown tag. |
| `closeAccountKeyHandle(handle)` | Already-closed handle returns a non-zero code; ignored. |

### 4.4 Failure modes explicitly handled

- **OOM mid-Phase-2:** Room transaction rolls back; marker still says
  Phase 2 not done; resume re-runs Phase 2 from scratch.
- **Process kill mid-Phase-3:** marker says Phase 2 done, Phase 3 in
  progress; resume re-runs entire Phase 3 (all operations idempotent).
- **Device reboot mid-Phase-4:** marker present, Phase 4 not done; resume
  re-runs Phase 4 (`cancelAllWorkByTag` against now-mostly-cleared
  WorkManager state is a no-op).
- **Storage full while writing marker:** the marker write is the *first*
  IO of the cascade. If it fails, the cascade aborts and the user is shown
  an error before any state is touched. The Logout button stays available.

---

## 5. Test Plan

Required tests when implementation lands. Mirrors the existing
`AlbumPurgerTest` (`apps/android-main/src/test/kotlin/org/mosaic/android/main/sync/AlbumPurgerTest.kt`)
pattern: in-memory Room + temp `filesDir` + mocked WorkManager.

### 5.1 Unit — `LogoutPurgerTest`

| Test | Asserts |
|---|---|
| `purges every enumerated Room table` | After `purge()`, every DAO in §2.1 reports zero rows. |
| `deletes encrypted-shards root recursively` | `File(filesDir, "encrypted-shards")` does not exist. |
| `deletes staging root recursively` | `File(filesDir, "staging")` does not exist. |
| `deletes upload-manifests root` | `File(filesDir, "upload-manifests")` does not exist. |
| `deletes the Room DB file` | `context.getDatabasePath("mosaic_upload_queue.db")` does not exist. |
| `cancels every upload-job tag` | Mock `WorkManager` records `cancelAllWorkByTag(tag)` for each pre-purge job's tag. |
| `closes account handle exactly once` | Mock `AndroidRustAccountApi` records exactly one `closeAccountKeyHandle` call with the active handle ID. |
| `clears ProcessActiveAccountHandleProvider` | `currentAccountKeyHandle()` returns null after purge. |
| `respects cascade ordering` | Use an order-recording mock that fails the test if Room transaction commit observed *after* DB file delete, or if FS delete observed *before* Room commit. |
| `crash mid-Phase-2 leaves marker, resume re-runs from Phase 1 forward` | Inject a transaction-failure mock; assert marker is still present; assert resume call drains everything. |
| `crash mid-Phase-3 leaves marker, resume re-runs Phase 3+ only` | Inject FS delete failure on first run; assert marker `phasesCompleted` contains `phase2` but not `phase3`; assert second run completes successfully. |
| `marker is removed only after Phase 4 completes` | Assert marker present after any earlier phase and absent only after `cancelAllWorkByTag` resolves. |
| `idempotent: second purge on already-purged state is a no-op` | Run `purge()` twice; assert no exceptions and second run records zero deletions. |

### 5.2 Regression — storage inventory enforcement

A regression test that **enforces this SPEC stays in sync with the code**:

- `LogoutPurgerInventoryTest` reflects over every `@Entity` in
  `UploadQueueDatabase` and asserts each entity name appears in the
  `LogoutPurger` implementation's known-tables list. Adding a new
  `@Entity` without updating the purger fails the build.
- Similar walk for every `File(filesDir, "...")` literal: a custom
  Detekt/Konsist rule (or simple JUnit reflection over filesDir-using
  classes) flags any new on-disk root directory not present in the
  purger's known-roots list.

This is the closest analogue Android has to the
`dotnet-no-crypto-bypass`-style arch guards used on the .NET side.

### 5.3 Integration — round-trip multi-account

End-to-end on an Android emulator or Robolectric host:

1. Sign in as user A.
2. Upload one photo (full encrypt → TUS → manifest sign).
3. Verify Phase 1-3 surfaces are populated: at least one
   `upload_queue_records` row, at least one `*.envelope` file under
   `encrypted-shards/<albumId>/`, at least one staging blob (or staged
   then cleaned).
4. Tap Logout. Wait for marker absence.
5. Assert every region from §2 is empty / absent / closed.
6. Sign in as user B (different L0 password).
7. Attempt to enumerate albums: assert UI shows user B's empty state, not
   A's album. Attempt to read raw filesystem from a debuggable build:
   assert no `*.envelope` from A's album remains.

This integration test is the **proof** that the cascade satisfies the
multi-account threat in §1.4.

---

## 6. Multi-Account Variant — "Switch Account" vs "Log Out"

The cascade above is the **whole-app logout** variant. Multi-account
introduces a second variant: **switch account** keeps another account
locally available without re-typing its password (subject to UX policy).

### 6.1 Account-scoped storage layout

For multi-account to be safe with non-destructive switching, **every
account-scoped region must be physically partitioned by account ID** on disk,
not merely filtered by foreign key. Required changes:

| Region | Single-tenant today | Multi-account v1.1+ |
|---|---|---|
| Room DB filename | `mosaic_upload_queue.db` | `mosaic_upload_queue_<accountId>.db` (one Room instance per account; the Room schema itself does not change) |
| Envelope dir | `filesDir/encrypted-shards/<albumId>/` | `filesDir/encrypted-shards/<accountId>/<albumId>/` |
| Staging dir | `filesDir/staging/` | `filesDir/staging/<accountId>/` |
| Upload manifests | `filesDir/upload-manifests/` | `filesDir/upload-manifests/<accountId>/` |
| SharedPreferences | flat name | `mosaic_<accountId>.<purpose>` namespace |
| Account-identity persistence file | (does not exist yet) | per-account `EncryptedSharedPreferences` keyed by Android Keystore |

This is a non-trivial migration; see §9 risk.

### 6.2 Variant semantics

| Variant | Effect on outgoing account | Effect on incoming account |
|---|---|---|
| **Log out** (no other account stays signed in) | Run full §3 cascade scoped to outgoing account, plus delete that account's persisted identity. Return to login screen. | Login screen with no auto-fill. |
| **Switch account** (another account stays signed in) | Run **Phase 1** (close handles, in-memory clear) and **Phase 4** (cancel workers) scoped to outgoing account. **Skip Phase 2 + 3** — outgoing account's on-disk state is retained for fast switch-back. | Activate incoming account: open its `AccountKeyHandle`, set as active. Workers scheduled by the outgoing account remain cancelled; the incoming account's queue resumes normally. |
| **Switch + remove outgoing** (user removes a saved account) | Full §3 cascade scoped to outgoing account only (Phase 2 + 3 delete only that account's sub-paths and that account's per-account DB file). | Continue as the still-active account. |

### 6.3 Cross-account leakage tests

Beyond the §5.3 round-trip, when multi-account ships add:

- Test: with accounts A and B both saved, run Switch A→B. Assert B's
  workers never see A's `accountKeyHandle`. Use a tagging assertion on
  the `EpochHandleResolver`.
- Test: with A and B both saved, delete A. Assert B's regions are
  byte-for-byte unchanged by inspecting checksum of B's DB file, envelope
  dir, and staging dir before and after.

---

## 7. Hooks for Wave 4 / Rust Core

The Rust core (`mosaic-crypto` via UniFFI) is the canonical owner of all
key material. The JVM never sees an L0/L1/L2 byte buffer — only opaque
`ULong` handle IDs. The logout cascade thus relies on Rust's `zeroize`-on-drop
guarantees, invoked via these FFI surfaces:

| Concern | FFI call | Source |
|---|---|---|
| Drop the live account L2 | `closeAccountKeyHandle(handle: ULong) -> Int` | `bridge/AndroidRustAccountApi.kt:9, 58` |
| Drop a derived epoch L3 | `closeEpochKeyHandle(handle: ULong) -> Int` | `bridge/AndroidRustEpochApi.kt:7, 58` |
| Drop a derived Ed25519 identity | `closeIdentityHandle(handle: ULong) -> Int` | `bridge/AndroidRustIdentityApi.kt:6, 61-62` |

### 7.1 Contract the Rust side must satisfy

For the cascade in §3 Phase 1 step 4 to be sufficient, **one of the
following MUST hold** on the Rust side:

- **(A) Cascading close:** `closeAccountKeyHandle(parent)` invalidates every
  `EpochKeyHandle` and `IdentityHandle` derived from `parent`, zeroizing the
  Rust-side buffers as part of the close.
- **(B) No outstanding derived handles at logout time:** `EpochKeyHandle`
  and `IdentityHandle` are *always* used inside `AutoCloseable` `use {}`
  blocks (see `EpochHandleResolver.kt:16-21`, `ShardEncryptionWorker.kt:103-107`)
  and Phase 1 happens only when no worker is running.

The current code follows pattern (B) by convention but does not enforce it.
Phase 1's step 1 (stop `UploadForegroundService`) is the chokepoint that
makes (B) true at logout time — provided workers finish their in-flight
encrypt step before being killed. If they don't, the Rust-side cascade
(A) is needed. **OQ-2 below tracks which guarantee the Rust core
actually provides.**

### 7.2 Suggested Rust-side API for the implementer

```kotlin
// Proposed addition to AndroidRustAccountApi:
fun closeAccountAndDerived(handle: ULong): RustAccountCascadeCloseResult
```

returning the count of derived handles closed. This makes Phase 1 a
single FFI call and makes the §5.1 "closes account handle exactly once"
assertion trivially testable. **Implementer of this SPEC should pick (A)
or (B) explicitly and document the chosen guarantee in the
`LogoutPurger` KDoc.**

---

## 8. Open Questions

| ID | Question | Where to decide |
|---|---|---|
| **OQ-1** | Do we cryptographically wipe (`zeroize`-then-delete) `staging/*.blob` plaintext files, or rely on EXT4/F2FS delete + FBE re-key on device reset? **Recommendation:** rely on FBE — Mosaic-level overwrite gives no meaningful guarantee against forensic flash analysis on modern phones, and the staging files are short-lived anyway. Document the decision in `docs/SECURITY.md`. | Implementer + security reviewer. |
| **OQ-2** | Does `closeAccountKeyHandle` cascade-close derived `EpochKeyHandle` / `IdentityHandle` instances in Rust? If not, add a `closeAccountAndDerived` API in `libs/mosaic-crypto` and route Phase 1 step 4 through it. | Rust core owner. |
| **OQ-3** | Where will the future account-identity persistence file live (filename, encryption scheme, Android Keystore alias) and what fields will it hold? This SPEC must be amended **before** that file lands so the cascade can wipe it. Likely an `EncryptedSharedPreferences` per account at `mosaic_identity_<accountId>.xml`. | Multi-account UI designer. |
| **OQ-4** | Audit-log retention on logout: should `privacy/PrivacyAuditor` logs be retained (legitimate interest, debugging) or deleted (parallels Art.17 right-to-erasure, see `docs/SECURITY.md:229-235`)? **Recommendation:** delete on logout; retention requires user consent that the logout UX flow cannot collect. | Privacy reviewer + product. |
| **OQ-5** | The Android manifest sets `allowBackup="false"`, which makes Auto-Backup a non-concern. If that ever flips to `true`, the cascade must additionally call `BackupManager.dataChanged()` and document the backup-restore interaction — a restored backup could re-introduce purged state. **Recommendation:** keep `allowBackup="false"`. Add an Android arch guard. | Android lead. |
| **OQ-6** | The legacy SharedPreferences `mosaic.envelope_layout`, `mosaic_staging_privacy`, `org.mosaic.android.main.migrations`, `org.mosaic.android.shell.stub_records` are flagged "retain" in §2.5. With multi-account, the staging-privacy prefs become account-scoped (per §6.1). Confirm during implementation. | Implementer. |
| **OQ-7** | Pre-existing minor inconsistency observed during this SPEC's investigation: there is no central handle registry on the JVM side (§2.3). For single-account this is fine, but multi-account makes per-account "close all my derived handles" harder. Not fixing in this SPEC per task constraints — flagged for the multi-account implementer. | Multi-account implementer. |

---

## 9. Implementation Estimate

### 9.1 Effort

- **Pure logout (single-account, no UI multi-account):** **small.**
  Adds `LogoutPurger` class (~150 LOC), a Logout button, a resume hook in
  `MosaicApplication.onCreate`, and the test suite in §5. Reuses
  `AlbumPurger`'s patterns verbatim. ~1-2 engineer-days including tests.

- **Multi-account scoping (per-account Room DB filenames, per-account sub-dirs):**
  **medium.** Requires touching every `File(filesDir, ...)` literal and the
  `RoomDatabase.create` factory, plus a one-shot legacy-to-multi-account
  migration analogous to `EnvelopeLayoutMigrator`. ~5-7 engineer-days.

- **Per-account identity persistence (`EncryptedSharedPreferences` + Keystore):**
  **medium**, parallelisable with the above. ~3 engineer-days.

### 9.2 Risk

- **Low** if logout ships first against the existing single-account layout
  and the cascade simply wipes everything. The `AlbumPurger` precedent and
  `AndroidManifest`'s `allowBackup="false"` keep the blast radius tiny.

- **Medium** if multi-account scoping ships in the same release: the
  per-account path migration is a one-shot data move with the same crash-
  safety constraints as the s34 envelope migrator. Plan for a dedicated
  migration test matrix.

### 9.3 Dependencies

1. **Multi-account UI must land alongside the Logout button.** A
   single-account Logout button that returns the user to a login screen
   with the same credentials being the only option is UX-pointless. (One
   exception: a Logout button on a public/shared device. If that's the
   product justification, ship Logout against single-account first; the
   cascade itself is identical.)
2. **OQ-2 must be resolved** (Rust-side cascade or strict
   `AutoCloseable` discipline) **before** the Logout button is wired up.
3. **OQ-3 must be resolved** (identity persistence file shape) before
   §2.5 can be finalised.

---

## Cross-references

- `apps/android-main/src/main/kotlin/org/mosaic/android/main/sync/AlbumPurger.kt` — the precedent this SPEC generalises.
- `apps/android-main/src/main/kotlin/org/mosaic/android/main/crypto/ShardEnvelopeStore.kt` — per-album envelope dir owner.
- `apps/android-main/src/main/kotlin/org/mosaic/android/main/crypto/EnvelopeLayoutMigrator.kt` — pattern for idempotent one-shot migration + SharedPreferences gate.
- `apps/android-main/src/main/kotlin/org/mosaic/android/main/crypto/EpochHandleResolver.kt` — `ProcessActiveAccountHandleProvider` and Rust handle lifecycle.
- `apps/android-main/src/test/kotlin/org/mosaic/android/main/sync/AlbumPurgerTest.kt` — test pattern `LogoutPurgerTest` should mirror.
- `docs/SECURITY.md` §"Right-to-Erasure" — the server-side parallel; the client logout cascade should be at least as thorough locally.
- `docs/ARCHITECTURE.md` §"Privacy invariants" — the `allowBackup="false"` invariant that this SPEC relies on.
- Prior commits: `96bb345`, `682ad5f`, `842c767`, `0a2a64a` (v1.0.1 s34 per-album envelope dir + `AlbumPurger` epoch-key clearing); `c56185d`, `1771675`, `8488513` (v1.0.1 s24 expedited workers + notification channels); `eba45ad`, `9e4bd6c`, `71253dc` (v1.0.1 s15 right-to-erasure).
