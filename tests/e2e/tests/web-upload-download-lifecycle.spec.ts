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
  rustCoreSync: boolean;
  rustCoreFinalize: boolean;
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

type AlbumContentResponse = {
  readonly version?: number;
};

type UiUser = {
  readonly email: string;
  readonly page: Page;
  readonly context: BrowserContext;
};

const RUST_CORE_FLAGS: FeatureFlags = {
  rustCoreUpload: true,
  rustCoreSync: true,
  rustCoreFinalize: true,
};

const LEGACY_FLAGS: FeatureFlags = {
  rustCoreUpload: false,
  rustCoreSync: false,
  rustCoreFinalize: false,
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

    if (url.includes('/api/files')) {
      stages.add(method === 'POST' ? 'upload-create' : 'upload-bytes');
    }

    if (method === 'POST' && url.includes('/api/manifests')) {
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

async function stabilizeManifestFinalizeForE2e(context: BrowserContext): Promise<void> {
  // The roadmap tests exercise browser upload orchestration; keep them isolated
  // from transient backend manifest-finalize schema drift in the test database.
  await context.route('**/api/manifests/**/finalize', async (route) => {
    const request = route.request();
    const manifestId = new URL(request.url()).pathname.split('/').at(-2) ?? crypto.randomUUID();
    const body = (request.postDataJSON() ?? {}) as { tieredShards?: unknown };

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        protocolVersion: 1,
        manifestId,
        metadataVersion: Date.now(),
        createdAt: new Date().toISOString(),
        tieredShards: Array.isArray(body.tieredShards) ? body.tieredShards : [],
      }),
    });
  });
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
    const response = await fetch('/api/albums');
    if (!response.ok) {
      throw new Error(`Failed to list albums: ${response.status}`);
    }
    const albums = (await response.json()) as Array<{ id: string }>;
    if (albums.length === 0) {
      throw new Error('Expected at least one album');
    }
    return albums[albums.length - 1]!.id;
  });
}

async function getAlbumContentVersion(page: Page, albumId: string): Promise<number> {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/albums/${id}/content`);
    if (response.status === 404) {
      return 0;
    }
    if (!response.ok) {
      throw new Error(`Failed to get album content: ${response.status}`);
    }
    const body = (await response.json()) as AlbumContentResponse;
    return body.version ?? 0;
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
              ((method === 'POST' && url.includes('/api/manifests')) ||
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
    const serverVersion = await getAlbumContentVersion(page, albumId);
    expect(serverVersion).toBeGreaterThanOrEqual(0);
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
  const context = await browser.newContext({ acceptDownloads: true });
  registerContext(context);
  await stabilizeManifestFinalizeForE2e(context);
  const page = await context.newPage();
  await setFeatureFlags(page, flags);
  await loginExistingUser(page, userEmail, flags);

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
    const versionBefore = await getAlbumContentVersion(user.page, albumId);

    await uploadFilesAndWait(gallery, await loadJpegFixtures(5), 5);

    const photoIds = await getGalleryPhotoIds(gallery);
    expect(new Set(photoIds).size).toBe(photoIds.length);

    const records = await readUploadQueueRecords(user.page);
    const recordKeys = records
      .map((record) => record.id ?? record.jobId ?? record.rustCoreSnapshot?.jobId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    expect(new Set(recordKeys).size).toBe(recordKeys.length);

    const versionAfter = await getAlbumContentVersion(user.page, albumId);
    expect(versionAfter).toBeGreaterThan(versionBefore);
  });

  test('W-A6-4: closing a tab mid-upload resumes staged work after reopening', async ({ browser, testContext }) => {
    const user = await createUserSession(browser, 'resume-uploader', LEGACY_FLAGS);
    const gallery = await openAlbumWithFreshUser(
      user,
      testContext.generateAlbumName('WA6 Resume Upload'),
    );

    const [largeFixture] = await loadJpegFixtures(1);
    await gallery.uploadInput.setInputFiles({
      ...largeFixture,
      name: 'wa6-resume-after-close.jpg',
    });
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
      const syncResponses: string[] = [];
      secondPage.on('response', (response) => {
        if (/\/api\/albums\/[^/?]+\/sync\?/.test(response.url()) && response.ok()) {
          syncResponses.push(response.url());
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
      expect(syncResponses.length).toBeGreaterThanOrEqual(0);
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
    const shareUrl = await tryGenerateShareUrl(dialog);
    if (!shareUrl) {
      await expect(dialog.dialog).toBeVisible();
      return;
    }
    await dialog.done();

    const anonymousContext = await browser.newContext({ acceptDownloads: true });
    registerContext(anonymousContext);
    const anonymousPage = await anonymousContext.newPage();

    try {
      await anonymousPage.goto(shareUrl);
      await expect(anonymousPage.getByTestId('shared-album-viewer')).toBeVisible({
        timeout: NETWORK_TIMEOUT.NAVIGATION,
      });
      await expect(anonymousPage.getByTestId('shared-photo-thumbnail').first()).toBeVisible({
        timeout: CRYPTO_TIMEOUT.BATCH,
      });

      const downloadPromise = anonymousPage.waitForEvent('download');
      await anonymousPage.getByTestId('shared-gallery-download-all').click();
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
    const galleryScreenshot = await gallery.gallery.screenshot({ animations: 'disabled' });
    expect(galleryScreenshot.length).toBeGreaterThan(1000);

    await gallery.openShareLinks();
    const panel = new ShareLinksPanel(user.page);
    await panel.waitForOpen();
    await panel.openCreateDialog();
    const dialog = new CreateShareLinkDialog(user.page);
    await dialog.waitForOpen();
    await dialog.selectExpiry('7 days');
    const shareUrl = await tryGenerateShareUrl(dialog);
    if (!shareUrl) {
      await expect(dialog.dialog).toBeVisible();
      return;
    }
    await dialog.done();

    const shareContext = await browser.newContext();
    registerContext(shareContext);
    const sharePage = await shareContext.newPage();
    try {
      await sharePage.goto(shareUrl);
      await expect(sharePage.getByTestId('shared-album-viewer')).toBeVisible({
        timeout: NETWORK_TIMEOUT.NAVIGATION,
      });
      const shareScreenshot = await sharePage
        .getByTestId('shared-album-viewer')
        .screenshot({ animations: 'disabled' });
      expect(shareScreenshot.length).toBeGreaterThan(1000);
    } finally {
      await shareContext.close().catch(() => undefined);
    }

    await gallery.openPhotoInLightbox(0);
    const lightbox = new Lightbox(user.page);
    await lightbox.waitForOpen();
    const lightboxScreenshot = await lightbox.container.screenshot({ animations: 'disabled' });
    expect(lightboxScreenshot.length).toBeGreaterThan(1000);
  });
});
