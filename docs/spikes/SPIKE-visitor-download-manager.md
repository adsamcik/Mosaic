# Spike: Share-Link Visitor Download Manager

## TL;DR

**Verdict: defer to Phase 3.** The existing Phase 2 tray does **not** currently ship for share-link visitors: `SharedGallery` injects `resolveOriginal`, and `useAlbumDownload` intentionally routes any resolver-provided call through the legacy ZIP path. Moving visitors onto the coordinator is more than a one-line switch because the coordinator currently assumes authenticated shard fetching and authenticated epoch-key decryption, has no visitor/job scope metadata, shows all OPFS jobs on the same origin, and has no visitor-facing storage disclosure before it writes OPFS bytes.

## Investigation environment

- Worktree: `C:\Users\adam-\GitHub\Mosaic-download-arch-p2`
- Branch: `feat/download-architecture-phase2`
- Pull status: `git pull --ff-only origin feat/download-architecture-phase2` reported already up to date.
- Method: code trace plus targeted tests; no real share-link IDs, photo IDs, or user data were used.
- Duck critique: the requested `duck-20-anon-job-gc` entry was not present in this checkout (`git grep` found no matching `duck-20`/`cross_cutting` file), so this spike used the prompt's summary of that finding.
- Pre-change test run: `npm run test:run -- src/components/Download src/lib --reporter=dot` from `apps/web` passed. A first attempted Jest-style `--runInBand` run failed because Vitest does not support that option; it was rerun with valid Vitest arguments.

## Findings — Q1 through Q10

### Q1 — First-visit flow

**Test scenario:** Trace a FULL-access share-link visitor clicking the shared gallery download button.

**Observation:** `SharedGallery` builds `createShareLinkOriginalResolver({ linkId, grantToken, getTierKey })` and calls:

```ts
albumDownload.startDownload(albumId, albumName ?? 'Shared Album', photos, downloadResolver)
```

`useAlbumDownload` treats a function fourth argument as `{ resolveOriginal }`, then forces the legacy path with:

```ts
const useLegacy = options?.resolveOriginal !== undefined || manager.api === null;
```

So share-link visitors never reach `runCoordinatorDownload`, never call `CoordinatorWorker.startJob`, and therefore do not use the tray-driven coordinator UX. Also, `SharedGallery` does not mount or call `useAlbumDownloadModePicker`; the existing shared button starts legacy ZIP directly.

**Implication:** The exact production change is **not** just removing the `resolveOriginal` guard. The coordinator path also assumes authenticated dependencies:

- `photosToPlanInput` warms `getOrFetchEpochKey(albumId, epochId)`.
- `CoordinatorWorker.pipelineDeps()` fetches via authenticated `downloadShards(...)`.
- `executePhotoTask` decrypts with an authenticated epoch seed, while the share-link legacy resolver decrypts with link tier keys via `decryptShardWithTierKey(...)`.

To allow share-link viewers onto the coordinator path safely, production needs a new coordinator source strategy, for example:

1. Extend `StartDownloadOptions` / `StartJobInput` with a source such as `{ kind: 'shareLink', linkId, grantToken, tierKeysOrHandles, visitorScope }` rather than overloading `resolveOriginal`.
2. Add a share-link pipeline dependency path in the coordinator that fetches with `downloadShardViaShareLink(linkId, shardId, grantToken)` and decrypts/verifies with the share-link tier key, not the authenticated epoch-key service.
3. Wire `SharedGallery` to the mode picker and pass `{ mode, source: 'shareLink', ... }` instead of the legacy resolver.
4. Keep the legacy `resolveOriginal` path untouched until that new source strategy is ready.

### Q2 — Job ownership keying

**Test scenario:** Two tabs at the same FULL share-link URL each click download, causing two `startJob` calls.

**Observation:** `CoordinatorWorker.startJob` generates a fresh random 16-byte UUID-like `jobId` every time and stages data at `/downloads/<jobId>/`. No link ID, visitor ID, or owner key is persisted. This matches the authenticated behavior of one job per explicit start.

**Implication:** Do **not** make `/downloads/<jobId>/` deterministic from `(linkId, albumId)`; that would create cross-tab write races and hard resume conflicts. Keep per-attempt random job IDs, but add a separate visitor ownership/scope key derived from `(linkId, albumId)` so the UI can filter and GC jobs belonging to the current share-link visitor. The POC under `apps/web/src/spikes/visitor-download-manager/` sketches this split: random job ID remains the storage directory key, while a scoped owner/channel key is derived from visitor context.

### Q3 — Storage privacy disclosure

**Test scenario:** Read existing tray and mode-picker strings for whether they tell anonymous users that Mosaic writes device storage.

**Observation:** The mode picker has generic strings such as “Streams to disk”, “Buffered in memory”, and “Make available offline — View this album later in Mosaic without exporting files.” The tray shows progress, pause/resume/cancel, and error states. It does **not** explicitly say that Mosaic stages encrypted/decrypted download bytes in the browser's origin-private device storage before the final ZIP/per-file save completes.

**Implication:** Visitors need an explicit disclosure before the first OPFS write. A passive tray-only notice is too late because OPFS staging starts after “Start download.” A privacy footer is useful but insufficient. The first visitor coordinator download should show a modal/inline confirmation tied to the mode picker; after acceptance, remember it per browser and per share-link scope.

### Q4 — Returning visit

**Test scenario:** Start a coordinator job, close the tab, and later return to the same share link.

**Observation:** `CoordinatorWorker.initialize()` calls `reconcilePersistedJobs()`, which lists **all** valid job directories under `/downloads/` and reconstructs every verified snapshot. `useDownloadManager` then calls `listJobs()` and `listResumableJobs()` without an album/link/account filter. The only job ownership-like field in `JobSummary` is `albumId`; there is no `linkId`, account ID, visitor scope, or source kind.

If the browser has jobs from three different share links, or from a share link plus an authenticated session on the same origin, the tray can observe/list all reconstructed jobs, not only the current share link's job.

**Implication:** Returning-visit resume cannot ship for visitors without scoped job metadata and UI filtering. The current linkage is “all jobs on this origin,” not “jobs for this share link.” Production should persist a source/scope field outside or inside the snapshot and expose filtered `listJobs({ scope })` / `listResumableJobs({ scope })` semantics to the hook.

### Q5 — Revocation mid-download

**Test scenario:** Owner revokes a FULL share link while a visitor coordinator download is running; the next shard fetch returns 403.

**Observation:** The Phase 2 photo pipeline classifies HTTP 403 as `AccessRevoked`. The coordinator marks the photo failed, aborts the job, and sends `ErrorEncountered` with reason `AccessRevoked`. The English locale contains `download.errorCode.AccessRevoked = "Access revoked"`.

However, the mounted tray currently renders only the phase (`Errored`) plus a failure-count badge. `DownloadTray` does not pass failure rows/reasons into `DownloadJobRow`, and `onShowFailures` is not wired there. Also, share-link coordinator fetch is not implemented, so this path is only proven for the generic pipeline classification, not for a real visitor source.

**Implication:** The low-level error classification is good enough, but the visitor UX is not. Production needs a share-link fetch strategy plus tray detail wiring so a revoked link surfaces as “This share link is no longer valid” instead of a generic errored job.

### Q6 — BroadcastChannel for anonymous viewers

**Test scenario:** Compare two tabs on the same share link vs. two tabs on different share links / authenticated plus visitor tab.

**Observation:** Both `useDownloadManager` and `CoordinatorWorker` use the single global channel name `mosaic-download-jobs`. Messages contain `{ kind, jobId, phase, lastUpdatedAtMs }` only. On receipt, the worker attempts to refresh that `jobId` from OPFS, and the hook refreshes all jobs. There is no source/scope in the channel name or payload.

**Implication:** The current global topic is tolerable only if listing is properly scoped, because messages are observe-only and same-origin. Without scoped listing, global broadcasts amplify the Q4 leak/UX issue by causing unrelated tabs to refresh and show unrelated jobs. Recommended production path: either keep the global topic but include `scopeKey` and filter before refresh, or use a scope-specific topic such as `mosaic-download-jobs:<scopeHash>` for visitors. The POC demonstrates a per-link channel name that does not contain the raw link ID.

### Q7 — Storage budget

**Test scenario:** Anonymous visitor downloads a large album, closes the browser, and never returns.

**Observation:** `opfs-staging.ts` has `gcStaleJobs({ nowMs, maxAgeMs, preserveJobIds })`, which purges jobs by verified snapshot `last_updated_at_ms` and preserves corrupt snapshots for twice the window. The coordinator exposes `gc(...)`, but initialization does not apply a visitor-specific policy, and snapshots do not identify visitor jobs.

**Implication:** Visitor jobs need a stricter default TTL than authenticated jobs. Recommendation:

- Visitor incomplete/paused/staged jobs: purge after **24 hours** of no updates unless the user explicitly chose “Make available offline.”
- Visitor “Make available offline” jobs: purge after **7 days** of no visits/updates for v1 unless the user renews retention.
- Authenticated jobs can keep a longer policy, e.g. 30 days, because the user has an account relationship and clearer expectations.

This requires source/scope metadata before GC can distinguish visitor jobs from authenticated jobs.

### Q8 — Resume flow with revoked link

**Test scenario:** Day 1 visitor starts a job, closes the tab. Day 2 the share link is revoked. Visitor returns and clicks resume.

**Observation:** Today, returning visitors are still on the legacy path for new downloads and coordinator resume is not share-link aware. If a share-link job somehow existed in the coordinator, `initialize()` would reconstruct it from OPFS without checking whether the share link is still valid. A resume would schedule the driver; with a future share-link fetch strategy, the first 403 shard response would become `AccessRevoked` and error the job.

**Implication:** Relying on per-shard 403 is too late and noisy. Production should preflight the share-link manifest/access before offering resume. If preflight fails, the tray should show “This share link is no longer valid” and offer “Discard local download data.”

### Q9 — UX for “your download is paused because you closed the tab”

**Test scenario:** Close a tab while a coordinator job snapshot says `Running`, then reopen the app.

**Observation:** `CoordinatorWorker.initializeOnce()` reconstructs jobs and immediately calls `scheduleJobDriver(job.jobId)` for any job whose persisted phase is `Running`. That means current behavior is auto-resume, not prompt. The file header also notes that `DownloadOutputMode` is in-memory only; after reload, resumed jobs default to `keepOffline`, so a ZIP/per-file visitor job can lose its intended finalization behavior.

**Implication:** Auto-resume is risky for visitors because it writes device storage immediately after page load and may resume with the wrong output mode. Visitor jobs should reconstruct as “Paused / ready to resume” and require an explicit user action, ideally after re-showing the storage disclosure if it has not been accepted for this scope. Persisting or re-prompting output mode is also required.

### Q10 — Two share links to the SAME album

**Test scenario:** Two different share links to the same album are opened in different tabs and both start downloads.

**Observation:** Current coordinator snapshots include `albumId` but no `linkId`. Two random jobs would coexist, but the tray could not distinguish which link authorized which job. If future filtering used only `albumId`, these separate share-link sessions would bleed into each other.

**Implication:** Do not de-duplicate across different `linkId`s, even if `albumId` matches. Treat them as separate visitor sessions because revocation, grant tokens, access tier, and user expectations are link-specific. Scope keys should include `linkId` and `albumId`; display should avoid raw IDs.

## Recommended path forward

Defer the visitor tray promise to Phase 3 and keep Phase 2 share-link downloads on the legacy resolver path. The production work needed is cohesive and crosses worker API, snapshot/job metadata, storage policy, and UX disclosure.

If product insists on shipping in Phase 2, the minimum follow-up checklist is:

1. Add a share-link source strategy to the coordinator instead of using `resolveOriginal` as the coordinator seam.
2. Wire `SharedGallery` to `useAlbumDownloadModePicker` and pass selected output mode plus share-link source metadata.
3. Persist a visitor scope/source key for each job and filter `listJobs`/`listResumableJobs` by current visitor scope.
4. Add first-write storage disclosure before `startJob` creates OPFS directories or writes snapshots.
5. Add visitor-specific GC defaults and invoke them during visitor manager initialization.
6. Add revoked-link preflight and tray copy for `AccessRevoked` during active and resumed downloads.
7. Fix reload semantics for visitor jobs: no auto-resume of persisted `Running` jobs without explicit visitor consent, and re-prompt/persist output mode.

## Privacy disclosure UX recommendation

Show this before the first visitor coordinator download for a share-link scope, inside or immediately after the mode picker and before `CoordinatorWorker.startJob`:

> Mosaic will temporarily use storage on this device to prepare this album download. If you close this tab, unfinished download data may remain so you can resume later. You can discard it from the download tray at any time. For visitors, Mosaic removes inactive download data automatically after 24 hours unless you choose offline access.

Buttons:

- **Continue download**
- **Cancel**
- Secondary link: **Learn about device storage**

Remember acceptance in local storage using a scoped key derived from the share link, not a raw link ID. Show it again if the user chooses “Make available offline,” with retention-specific copy:

> Offline access keeps this album's downloaded files in this browser for up to 7 days of inactivity or until you discard them.

## Anonymous job lifecycle proposal

- **Job ID:** keep random per `startJob` and keep OPFS directories as `/downloads/<jobId>/` to avoid cross-tab write races.
- **Visitor scope / ownership key:** derive from `(linkId, albumId)` and store with the job. Use the scope for listing, resume prompts, GC policy, and BroadcastChannel filtering. Do not display or persist raw link IDs where a stable hash is sufficient.
- **Two tabs same link:** both can observe the same scope. If both explicitly start downloads, allow separate random jobs for v1; future dedupe can be a UX enhancement.
- **Two links same album:** no dedupe; different `linkId`s are different authorization sessions.
- **GC TTL:** 24 hours for inactive visitor staging by default; 7 days for explicit offline visitor retention; longer authenticated policy can remain separate.
- **`lease_token` field:** Rust snapshots reserve `lease_token`, but current validation rejects any non-`None` lease token. Do not use it in Phase 2 without a schema/validation change. In Phase 3 it could carry an opaque visitor lease/scope token or active-tab lease after the snapshot schema explicitly allows it.

The POC in `apps/web/src/spikes/visitor-download-manager/visitor-job-scope.ts` demonstrates the intended separation between random job IDs and visitor scope keys/channel names.

## Risks / showstoppers

- Share-link visitors are currently on legacy ZIP, not coordinator/tray.
- Coordinator fetch/decrypt dependencies are authenticated-user specific.
- No persisted link/source/scope metadata means unrelated same-origin jobs can appear in a visitor tab.
- No storage disclosure appears before OPFS writes.
- Running jobs auto-resume on reload, which is not appropriate for anonymous visitors without renewed consent.
- Revocation maps to a good low-level error code, but the tray does not currently surface a visitor-friendly revoked-link message.
- `DownloadOutputMode` is in-memory only, so reload/resume cannot reliably finish a visitor ZIP/per-file job as originally chosen.

## Verdict

**Defer to Phase 3.** The existing tray cannot be shipped as-is for FULL-access share-link visitors, and the required work is not a small UI-only patch. A safe visitor-tray implementation needs a share-link coordinator source strategy, visitor-scoped job metadata/filtering, pre-write storage disclosure, visitor GC policy, revoked-link resume handling, and reload semantics that do not silently auto-write to a stranger's device.

## Follow-up tickets

1. `download(visitor): add share-link source strategy to coordinator pipeline`
2. `download(visitor): wire SharedGallery to mode picker and coordinator start options`
3. `download(visitor): persist and filter jobs by visitor scope key`
4. `download(visitor): add pre-OPFS storage disclosure and scoped acknowledgement`
5. `download(visitor): implement visitor GC TTL and startup cleanup`
6. `download(visitor): surface AccessRevoked as share-link revoked in tray`
7. `download(visitor): pause reconstructed visitor jobs and restore output-mode prompt`
8. `download(visitor): scope BroadcastChannel refreshes or payloads by visitor key`
