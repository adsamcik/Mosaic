/// <reference lib="webworker" />
/**
 * Mosaic Service Worker — Background Fetch shell.
 *
 * This SW exists to enable Background Fetch on Chromium browsers (especially
 * Android), where downloads need to survive tab close, OS-level kill, and
 * screen lock. It does NOT do offline caching, push, or any other PWA work.
 *
 * SECURITY / ZK INVARIANT
 * -----------------------
 * - The SW NEVER touches keys, plaintext, or decryption logic.
 * - The SW only stores opaque encrypted bytes for URLs it was explicitly
 *   asked to fetch via `backgroundFetch.fetch(...)`.
 * - There is NO `fetch` event handler — we don't intercept or proxy any
 *   network traffic. That keeps the SW invisible to the rest of the app
 *   and avoids accidental plaintext exposure if the network ever serves
 *   non-encrypted resources.
 */
import {
  BG_FETCH_CACHE_NAME,
  handleBackgroundFetchFail,
  handleBackgroundFetchSuccess,
} from './sw-handlers';

declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', () => {
  // Take over as fast as possible so a freshly-loaded page immediately has
  // the new SW available for backgroundFetch dispatch.
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async (): Promise<void> => {
    await self.clients.claim();
    // Best-effort cleanup of stale caches from older SW versions. The
    // current SW only owns BG_FETCH_CACHE_NAME; everything else is
    // foreign and can be dropped.
    const names = await self.caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith('mosaic-bgfetch') && name !== BG_FETCH_CACHE_NAME)
        .map((name) => self.caches.delete(name)),
    );
  })());
});

self.addEventListener('backgroundfetchsuccess', (event) => {
  event.waitUntil(handleBackgroundFetchSuccess({
    registration: event.registration,
    caches: self.caches,
    clients: self.clients,
  }));
});

self.addEventListener('backgroundfetchfail', (event) => {
  event.waitUntil(handleBackgroundFetchFail({
    registration: event.registration,
    clients: self.clients,
    kind: 'fail',
  }));
});

self.addEventListener('backgroundfetchabort', (event) => {
  event.waitUntil(handleBackgroundFetchFail({
    registration: event.registration,
    clients: self.clients,
    kind: 'abort',
  }));
});