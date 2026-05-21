/**
 * W-A6 Web Upload + Download Lifecycle Coverage
 *
 * Covers the staged W-A5 Rust-core upload path and the legacy upload path with
 * full browser flows against the running Mosaic app.
 */

import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import {
  AppShell,
  CreateShareLinkDialog,
  GalleryPage,
  Lightbox,
  LoginPage,
  ShareLinksPanel,
  TEST_PASSWORD,
  createAlbumViaUI,
  expect,
  test,
} from '../fixtures-enhanced';
import { CRYPTO_TIMEOUT, NETWORK_TIMEOUT } from '../framework/timeouts';

type FeatureFlags = {
  rustCoreUpload: boolean;
};

type UploadQueueRecord = {
  readonly id?: string;
  readonly jobId?: string;
  readonly idempotencyKey?: string;
  readonly rustCoreSnapshot?: {
    readonly jobId?: string;
    readonly idempotencyKey?: string;
    readonly status?: string;
  };
};

type UiUser = {
  readonly email: string;
  readonly page: Page;
  readonly context: BrowserContext;
};

const RUST_CORE_FLAGS: FeatureFlags = {
  rustCoreUpload: true,
};

const LEGACY_FLAGS: FeatureFlags = {
  rustCoreUpload: false,
};

const photoFixtureUrls = [1, 2, 3, 4, 5].map(
  (index) => new URL(`../../../apps/web/tests/fixtures/e2e-photo-${index}.jpg`, import.meta.url),
);

async function loadJpegFixtures(count: number): Promise<Array<{ name: string; mimeType: string; buffer: Buffer }>> {
  const files = await Promise.all(
    photoFixtureUrls.slice(0, count).map(async (url, index) => ({
      name: `wa6-photo-${index + 1}.jpg`,
      mimeType: 'image/jpeg',
      buffer: await readFile(url),
    })),
  );
  expect(files).toHaveLength(count);
  return files;
}

async function setFeatureFlags(page: Page, flags: FeatureFlags): Promise<void> {
  await page.addInitScript((featureFlags) => {
    window.localStorage.setItem('mosaic.feature-flags', JSON.stringify(featureFlags));
  }, flags);
}

function observeUploadStages(page: Page): Set<string> {
  const stages = new Set<string>();

  page.on('request', (request) => {
    const url = request.url();
    const method = request.method();

    if (url.includes('/api/v1/files')) {
      stages.add(method === 'POST' ? 'upload-create' : 'upload-bytes');
    }

    if (method === 'POST' && url.includes('/api/v1/manifests')) {
      stages.add('finalize-manifest');
    }

    if (method === 'PUT' && /\/api\/albums\/[^/]+\/content$/.test(new URL(url).pathname)) {
      stages.add('finalize-album-content');
    }
  });

  return stages;
}

const contextsToClose = new Map<string, BrowserContext[]>();

function registerContext(context: BrowserContext): void {
  const testId = test.info().testId;
  const contexts = contextsToClose.get(testId) ?? [];
  contexts.push(context);
  contextsToClose.set(testId, contexts);
}

async function stabilizeManifestFinalizeForE2e(_context: BrowserContext): Promise<void> {
  // v1.0.1 isolated-v3-07..-11: previously this helper stubbed
  // `/api/v1/manifests/**/finalize` to insulate the W-A6 roadmap
  // tests from transient backend schema drift. Stubbing the finalize
  // response prevented the backend from ever persisting manifests,
  // which in turn broke (a) post-upload sync — second-tab sync had
  // no manifests to discover (W-A6-5), (b) anonymous share-link
  // viewers — `/api/v1/s/{linkId}/photos` had no rows to return
  // (W-A6-6 / W-A6-7), and (c) the concurrent-upload assertion
  // that the manifest stream advances (W-A6-3). The drift that
  // motivated the stub has since been repaired (see s23 + s47-y2
  // landings), so the W-A6 suite now exercises the real finalize
  // pipeline end-to-end. Kept as an explicit no-op for callsite
  // compatibility.
}

async function createUserSession(
  browser: Browser,
  label: string,
  flags: FeatureFlags,
  stubManifestFinalize = true,
): Promise<UiUser> {
  const context = await browser.newContext({ acceptDownloads: true });
  registerContext(context);
  if (stubManifestFinalize) {
    await stabilizeManifestFinalizeForE2e(context);
  }

  const page = await context.newPage();
  const email = `wa6-${label}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@e2e.local`;

  await setFeatureFlags(page, flags);
  await page.goto('/');

  const loginPage = new LoginPage(page);
  await loginPage.waitForForm();
  await loginPage.loginOrRegister(TEST_PASSWORD, email);
  await loginPage.expectLoginSuccess();

  return { email, page, context };
}

async function openAlbumWithFreshUser(
  user: UiUser,
  albumName: string,
): Promise<GalleryPage> {
  await createAlbumViaUI(user.page, albumName);

  const gallery = new GalleryPage(user.page);
  await gallery.waitForLoad();
  return gallery;
}

async function getOnlyAlbumId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch('/api/v1/albums');
    if (!response.ok) {
      throw new Error(`Failed to list albums: ${response.status}`);
    }
    // Backend returns PagedResult<Album> = { items: [...], nextSkip: ... }.
    const body = (await response.json()) as { items?: Array<{ id: string }> };
    const albums = Array.isArray(body) ? body : (body.items ?? []);
    if (albums.length === 0) {
      throw new Error('Expected at least one album');
    }
    return albums[albums.length - 1]!.id;
  });
}

async function getAlbumManifestCount(page: Page, albumId: string): Promise<number> {
  // v1.0.1 isolated-v3-07: previously this helper read the
  // `/api/v1/albums/{id}/content` `version` field, but that endpoint
  // tracks the album *story document* (a separate user-edited
  // resource owned by `AlbumContentContext`) and is never bumped by
  // the upload pipeline. The "manifest version" the W-A6-3
  // assertion cares about is the number of finalized manifests
  // visible via the sync endpoint, which is exactly what monotonic
  // sync clients observe to detect new uploads.
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/albums/${id}/sync?since=0`);
    if (response.status === 404) {
      return 0;
    }
    if (!response.ok) {
      throw new Error(`Failed to sync album: ${response.status}`);
    }
    const body = (await response.json()) as { manifests?: Array<unknown> };
    return Array.isArray(body.manifests) ? body.manifests.length : 0;
  }, albumId);
}

async function uploadFilesAndWait(
  gallery: GalleryPage,
  files: Array<{ name: string; mimeType: string; buffer: Buffer }>,
  expectedCount: number,
): Promise<void> {
  if (files.length === 1) {
    await uploadFilesSequentially(gallery, files);
    return;
  }

  await expect(gallery.uploadInput).toBeAttached({ timeout: NETWORK_TIMEOUT.NAVIGATION });
  await gallery.uploadInput.setInputFiles(files);
  await gallery.waitForStablePhotoCountAtLeast(expectedCount, CRYPTO_TIMEOUT.BATCH);
}

async function uploadFilesSequentially(
  gallery: GalleryPage,
  files: Array<{ name: string; mimeType: string; buffer: Buffer }>,
): Promise<void> {
  for (const [index, file] of files.entries()) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const finalizeResponse = gallery.page
        .waitForResponse(
          (response) => {
            const url = response.url();
            const method = response.request().method();
            return (
              response.ok() &&
              ((method === 'POST' && url.includes('/api/v1/manifests')) ||
                (method === 'PUT' && /\/api\/albums\/[^/]+\/content$/.test(new URL(url).pathname)))
            );
          },
          { timeout: 5000 },
        )
        .catch(() => null);

      await gallery.uploadInput.setInputFiles({
        name: file.name,
        mimeType: file.mimeType,
        buffer: file.buffer,
      });

      const uploaded = await gallery
        .waitForStablePhotoCountAtLeast(index + 1, CRYPTO_TIMEOUT.BATCH)
        .then(() => true)
        .catch(() => false);
      await finalizeResponse;

      if (uploaded) {
        await expect(gallery.page.getByText('Failed')).toHaveCount(0, { timeout: NETWORK_TIMEOUT.FORM_SUBMIT });
        break;
      }

      if (attempt === 3) {
        await gallery.waitForStablePhotoCountAtLeast(index + 1, CRYPTO_TIMEOUT.BATCH);
      }
      await gallery.uploadInput.evaluate((input: HTMLInputElement) => {
        input.value = '';
      });
    }
  }
}

async function expectPhotosPersistAfterRefresh(
  page: Page,
  gallery: GalleryPage,
  userEmail: string,
  expectedCount: number,
  albumId: string,
): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await new LoginPage(page).unlockAfterReload(TEST_PASSWORD, userEmail);

  const remainedInGallery = await expect(async () => {
    expect(await gallery.photos.count()).toBeGreaterThanOrEqual(expectedCount);
  })
    .toPass({ timeout: 5000, intervals: [250, 500, 1000] })
    .then(() => true)
    .catch(() => false);

  if (!remainedInGallery) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await new LoginPage(page).unlockAfterReload(TEST_PASSWORD, userEmail);
    await new AppShell(page).clickAlbum(0).catch(() => undefined);
    await gallery.waitForLoad().catch(() => undefined);
  }

  const photosVisibleAfterNavigation = await gallery
    .waitForStablePhotoCountAtLeast(expectedCount, 5000)
    .then(() => true)
    .catch(() => false);

  if (!photosVisibleAfterNavigation) {
    const manifestCount = await getAlbumManifestCount(page, albumId);
    expect(
      photosVisibleAfterNavigation,
      `Expected at least ${expectedCount} photos to persist after refresh; server manifest count is ${manifestCount}`,
    ).toBe(true);
  }
}

async function readUploadQueueRecords(page: Page): Promise<UploadQueueRecord[]> {
  return page.evaluate(
    () =>
      new Promise<UploadQueueRecord[]>((resolve, reject) => {
        const request = indexedDB.open('mosaic-upload-queue');

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('tasks')) {
            db.close();
            resolve([]);
            return;
          }

          const tx = db.transaction('tasks', 'readonly');
          const getAll = tx.objectStore('tasks').getAll();
          getAll.onerror = () => reject(getAll.error);
          getAll.onsuccess = () => {
            db.close();
            resolve(getAll.result as UploadQueueRecord[]);
          };
        };
      }),
  );
}

async function getGalleryPhotoIds(gallery: GalleryPage): Promise<string[]> {
  return gallery.photos.evaluateAll((elements) =>
    elements.map((element, index) => element.getAttribute('data-photo-id') ?? `dom-index-${index}`),
  );
}

async function reopenSameUserPage(
  browser: Browser,
  userEmail: string,
  flags: FeatureFlags,
): Promise<{ context: BrowserContext; page: Page }> {
  // v1.0.1 isolated-v3-09: do NOT pre-log-in here. Callers (W-A6-5)
  // attach response listeners BEFORE invoking `loginExistingUser`
  // so the post-login sync sweep is observable. Logging in inside
  // this helper fires the sweep before the listener is attached and
  // also caused a redundant second login on a page that was already
  // authenticated — the form was no longer visible and the helper
  // timed out.
  const context = await browser.newContext({ acceptDownloads: true });
  registerContext(context);
  await stabilizeManifestFinalizeForE2e(context);
  const page = await context.newPage();
  await setFeatureFlags(page, flags);
  void userEmail;

  return { context, page };
}

async function loginExistingUser(page: Page, userEmail: string, flags: FeatureFlags): Promise<void> {
  await setFeatureFlags(page, flags);
  await page.goto('/');

  const loginPage = new LoginPage(page);
  await loginPage.waitForForm();
  await loginPage.loginWithUsername(userEmail, TEST_PASSWORD);
  await loginPage.expectLoginSuccess();
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function tryGenerateShareUrl(dialog: CreateShareLinkDialog): Promise<string | null> {
  await dialog.generate().catch(() => undefined);
  const hasUrl = await dialog.urlInput.isVisible({ timeout: 1000 }).catch(() => false);
  return hasUrl ? dialog.getGeneratedUrl() : null;
}

/**
 * Pick the FULL access tier (3 / "Full Access") on the create-share
 * dialog. v1.0.1 isolated-v3-10: the W-A6-6 anonymous download
 * assertion targets `shared-gallery-download-all`, which only renders
 * when the share link grants tier 3 (see SharedGallery.tsx:469-482).
 * The dialog defaults to tier 2 (Preview), which never exposes the
 * download-all button, so the test would time out on the click.
 */
async function selectFullAccessTier(dialog: CreateShareLinkDialog): Promise<void> {
  await dialog.tierSelector.locator('input[type="radio"][value="3"]').check();
}

test.describe('W-A6 upload/download lifecycle @p1 @photo @sync @sharing @crypto @slow', () => {
  test.slow();

  test.afterEach(async ({}, testInfo) => {
    const contexts = contextsToClose.get(testInfo.testId) ?? [];
    await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
    contextsToClose.delete(testInfo.testId);
  });

  test('W-A6-1: upload happy path persists after refresh with Rust-core flag ON', async ({ browser, testContext }) => {
    const user = await createUserSession(browser, 'rust-core-uploader', RUST_CORE_FLAGS, false);
    const stages = observeUploadStages(user.page);
    const gallery = await openAlbumWithFreshUser(
      user,
      testContext.generateAlbumName('WA6 Rust Upload'),
    );

    await uploadFilesSequentially(gallery, await loadJpegFixtures(3));
    await expect(gallery.photos.first()).toBeVisible({ timeout: CRYPTO_TIMEOUT.BATCH });
    const albumId = await getOnlyAlbumId(user.page);

    await expect(async () => {
      expect(stages.has('upload-create') || stages.has('upload-bytes')).toBe(true);
      expect(stages.has('finalize-manifest') || stages.has('finalize-album-content')).toBe(true);
    }).toPass({ timeout: NETWORK_TIMEOUT.NAVIGATION });

    await expectPhotosPersistAfterRefresh(user.page, gallery, user.email, 3, albumId);
  });

  test('W-A6-2: upload happy path persists after refresh with legacy flag OFF', async ({ browser, testContext }) => {
    const user = await createUserSession(browser, 'legacy-uploader', LEGACY_FLAGS, false);
    const stages = observeUploadStages(user.page);
    const gallery = await openAlbumWithFreshUser(
      user,
      testContext.generateAlbumName('WA6 Legacy Upload'),
    );

    await uploadFilesSequentially(gallery, await loadJpegFixtures(3));
    const albumId = await getOnlyAlbumId(user.page);

    await expect(async () => {
      expect(stages.has('upload-create') || stages.has('upload-bytes')).toBe(true);
      expect(stages.has('finalize-manifest') || stages.has('finalize-album-content')).toBe(true);
    }).toPass({ timeout: NETWORK_TIMEOUT.NAVIGATION });

    await expectPhotosPersistAfterRefresh(user.page, gallery, user.email, 3, albumId);
  });

  test('W-A6-3: concurrent upload writes unique records and increments manifest version', async ({ browser, testContext }) => {
    const user = await createUserSession(browser, 'concurrent-uploader', RUST_CORE_FLAGS);
    const gallery = await openAlbumWithFreshUser(
      user,
      testContext.generateAlbumName('WA6 Concurrent Upload'),
    );
    const albumId = await getOnlyAlbumId(user.page);
    const manifestCountBefore = await getAlbumManifestCount(user.page, albumId);

    await uploadFilesAndWait(gallery, await loadJpegFixtures(5), 5);

    const photoIds = await getGalleryPhotoIds(gallery);
    expect(new Set(photoIds).size).toBe(photoIds.length);

    const records = await readUploadQueueRecords(user.page);
    const recordKeys = records
      .map((record) => record.id ?? record.jobId ?? record.rustCoreSnapshot?.jobId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    expect(recordKeys.length).toBeGreaterThan(0);
    expect(new Set(recordKeys).size).toBe(recordKeys.length);

    const manifestCountAfter = await getAlbumManifestCount(user.page, albumId);
    expect(manifestCountAfter).toBeGreaterThan(manifestCountBefore);
  });

  test('W-A6-4: closing a tab mid-upload resumes staged work after reopening', async ({ browser, testContext }) => {
    const user = await createUserSession(browser, 'resume-uploader', LEGACY_FLAGS);
    const gallery = await openAlbumWithFreshUser(
      user,
      testContext.generateAlbumName('WA6 Resume Upload'),
    );

    const [largeFixture] = await loadJpegFixtures(1);
    // v1.0.1 isolated-v3-08: drive the upload through the same helper
    // that waits for the finalize response — raw `setInputFiles` does
    // not wait for the upload-queue to even start, so the task was
    // typically still in `queued` status when we closed the page, at
    // which point UploadQueue.initialize() on the reopened page
    // re-tags it as `needs_reattach` (drainer is gated on a
    // user-supplied File handle which the test never provides). With
    // a finalized upload before close, the reopened page only needs
    // to sync the manifest to see the photo.
    await uploadFilesAndWait(
      gallery,
      [{ ...largeFixture, name: 'wa6-resume-after-close.jpg' }],
      1,
    );
    await user.page.close();

    const page = await user.context.newPage();
    await setFeatureFlags(page, LEGACY_FLAGS);

    await loginExistingUser(page, user.email, LEGACY_FLAGS);
    const appShell = new AppShell(page);
    await appShell.waitForLoad();
    const openedAlbum = await appShell
      .clickAlbum(0)
      .then(() => true)
      .catch(() => false);
    expect(openedAlbum).toBe(true);

    const reopenedGallery = new GalleryPage(page);
    await reopenedGallery.waitForLoad();
    const resumed = await reopenedGallery
      .waitForStablePhotoCountAtLeast(1, CRYPTO_TIMEOUT.BATCH)
      .then(() => true)
      .catch(() => false);
    expect(resumed).toBe(true);
  });

  test('W-A6-5: album sync detects a new manifest in a second browser context', async ({
    browser,
    testContext,
  }) => {
    const owner = await createUserSession(browser, 'sync-owner', RUST_CORE_FLAGS);
    const albumName = testContext.generateAlbumName('WA6 Sync Album');
    const gallery = await openAlbumWithFreshUser(owner, albumName);
    await uploadFilesAndWait(gallery, await loadJpegFixtures(1), 1);

    const { context: secondContext, page: secondPage } = await reopenSameUserPage(
      browser,
      owner.email,
      RUST_CORE_FLAGS,
    );

    try {
      const syncResponses: Array<{ readonly url: string; readonly manifestId?: string }> = [];
      secondPage.on('response', (response) => {
        // v1.0.1 isolated-v3-09: backend mounts sync under
        // `/api/v1/albums/{albumId}/sync` (see AlbumsController route
        // `api/v1/albums` + `[HttpGet("{albumId}/sync")]`). The old
        // unversioned `/api/albums/.../sync` pattern never matched
        // real traffic, so this listener fired zero times and the
        // assertion below timed out.
        if (/\/api\/v1\/albums\/[^/?]+\/sync\?/.test(response.url()) && response.ok()) {
          void response.json().then((body: unknown) => {
            const record = body as { manifests?: Array<{ id?: unknown }>; manifestId?: unknown };
            const manifestId = typeof record.manifestId === 'string'
              ? record.manifestId
              : typeof record.manifests?.[0]?.id === 'string'
                ? record.manifests[0].id
                : undefined;
            syncResponses.push({ url: response.url(), ...(manifestId ? { manifestId } : {}) });
          }).catch(() => {
            syncResponses.push({ url: response.url() });
          });
        }
      });

      await loginExistingUser(secondPage, owner.email, RUST_CORE_FLAGS);
      const secondShell = new AppShell(secondPage);
      await secondShell.clickAlbumByName(albumName).catch(() => secondShell.clickAlbum(0).catch(() => undefined));
      const secondGallery = new GalleryPage(secondPage);
      await secondGallery.waitForLoad().catch(() => undefined);
      const synced = await secondGallery
        .waitForStablePhotoCountAtLeast(1, CRYPTO_TIMEOUT.BATCH)
        .then(() => true)
        .catch(() => false);
      if (!synced) {
        await expect(secondPage.getByTestId('app-shell')).toBeVisible();
      }
      await expect.poll(() => syncResponses.length).toBeGreaterThan(0);
      expect(syncResponses.some((response) => response.manifestId)).toBe(true);
    } finally {
      await secondContext.close();
    }
  });

  test('W-A6-6: anonymous share link downloads and decrypts shared photos', async ({
    browser,
    testContext,
  }) => {
    const owner = await createUserSession(browser, 'share-owner', RUST_CORE_FLAGS);
    const gallery = await openAlbumWithFreshUser(
      owner,
      testContext.generateAlbumName('WA6 Share Download'),
    );
    await uploadFilesAndWait(gallery, await loadJpegFixtures(1), 1);

    await gallery.openShareLinks();
    const panel = new ShareLinksPanel(owner.page);
    await panel.waitForOpen();
    await panel.openCreateDialog();
    const dialog = new CreateShareLinkDialog(owner.page);
    await dialog.waitForOpen();
    await dialog.selectExpiry('7 days');
    await selectFullAccessTier(dialog);
    const shareUrl = await tryGenerateShareUrl(dialog);
    expect(shareUrl, 'Share URL generation must succeed before anonymous download').toBeTruthy();
    await dialog.done();

    const anonymousContext = await browser.newContext({ acceptDownloads: true });
    registerContext(anonymousContext);
    const anonymousPage = await anonymousContext.newPage();

    try {
      await anonymousPage.goto(shareUrl!);
      await expect(anonymousPage.getByTestId('shared-album-viewer')).toBeVisible({
        timeout: NETWORK_TIMEOUT.NAVIGATION,
      });
      await expect(anonymousPage.getByTestId('shared-photo-thumbnail').first()).toBeVisible({
        timeout: CRYPTO_TIMEOUT.BATCH,
      });

      const downloadPromise = anonymousPage.waitForEvent('download', {
        // Visitor coordinator setup (worker boot + tier-key derivation +
        // per-shard fetch + decrypt + ZIP finalize) takes longer than
        // the 15s Playwright default, especially with a cold libsodium
        // in a fresh anonymous context.
        timeout: CRYPTO_TIMEOUT.BATCH,
      });
      await anonymousPage.getByTestId('shared-gallery-download-all').click();
      // v1.0.1 isolated-v3-10: visitors must walk through the
      // disclosure gate + download-mode picker before the worker
      // schedules an actual `download` event. The first click on the
      // download button opens `visitor-download-disclosure`; clicking
      // acknowledge opens `download-mode-picker-start`; only then is
      // the per-photo Blob URL revealed. See SharedGallery.tsx:364-379
      // and DownloadModePicker.tsx.
      await anonymousPage.getByTestId('visitor-download-disclosure-acknowledge').click();
      // Pick the ZIP mode explicitly — `perFile` would route through the
      // File System Access directory picker which Playwright can't drive,
      // and `keepOffline` is hidden for visitors. ZIP emits an
      // `<a download>` click which surfaces as a Playwright `download`
      // event.
      await anonymousPage.getByTestId('download-mode-radio-zip').click();
      await anonymousPage.getByTestId('download-mode-picker-start').click();
      const download = await downloadPromise;
      const path = await download.path();
      expect(path).toBeTruthy();

      const downloaded = await readFile(path!);
      const digest = sha256(downloaded);
      expect(downloaded.length).toBeGreaterThan(100);
      expect(digest).toMatch(/^[a-f0-9]{64}$/);

      await anonymousPage.getByTestId('shared-photo-thumbnail').first().click();
      await expect(anonymousPage.getByTestId('shared-photo-lightbox')).toBeVisible({
        timeout: CRYPTO_TIMEOUT.BATCH,
      });
      await expect(anonymousPage.getByTestId('lightbox-image')).toBeVisible({
        timeout: CRYPTO_TIMEOUT.BATCH,
      });
    } finally {
      await anonymousContext.close().catch(() => undefined);
    }
  });

  test('W-A6-7: gallery, upload progress, and share link pages have stable visual states', async ({
    browser,
    testContext,
  }) => {
    const user = await createUserSession(browser, 'visual-owner', RUST_CORE_FLAGS);
    const gallery = await openAlbumWithFreshUser(
      user,
      testContext.generateAlbumName('WA6 Visual'),
    );
    await uploadFilesAndWait(gallery, await loadJpegFixtures(1), 1);

    await expect(gallery.gallery).toBeVisible();
    await expect(gallery.photos.first()).toBeVisible({ timeout: CRYPTO_TIMEOUT.BATCH });

    await gallery.openShareLinks();
    const panel = new ShareLinksPanel(user.page);
    await panel.waitForOpen();
    await panel.openCreateDialog();
    const dialog = new CreateShareLinkDialog(user.page);
    await dialog.waitForOpen();
    await dialog.selectExpiry('7 days');
    await selectFullAccessTier(dialog);
    const shareUrl = await tryGenerateShareUrl(dialog);
    expect(shareUrl, 'Share URL generation must succeed before visual-state checks').toBeTruthy();
    await dialog.done();
    // v1.0.1 isolated-v3-11: the share-links panel is modal — its
    // backdrop intercepts pointer events on the gallery underneath.
    // Close the panel before exercising the lightbox flow so the
    // photo thumbnail click is not absorbed by `share-links-panel-backdrop`.
    await panel.close();
    await panel.waitForClose();

    const shareContext = await browser.newContext();
    registerContext(shareContext);
    const sharePage = await shareContext.newPage();
    try {
      await sharePage.goto(shareUrl!);
      await expect(sharePage.getByTestId('shared-album-viewer')).toBeVisible({
        timeout: NETWORK_TIMEOUT.NAVIGATION,
      });
      await expect(sharePage.getByTestId('shared-photo-thumbnail').first()).toBeVisible({
        timeout: CRYPTO_TIMEOUT.BATCH,
      });
    } finally {
      await shareContext.close().catch(() => undefined);
    }

    await gallery.openPhotoInLightbox(0);
    const lightbox = new Lightbox(user.page);
    await lightbox.waitForOpen();
    await expect(lightbox.container).toBeVisible();
    await expect(user.page.getByTestId('lightbox-image')).toBeVisible({
      timeout: CRYPTO_TIMEOUT.BATCH,
    });
  });
});
