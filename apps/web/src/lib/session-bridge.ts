/**
 * Session DB-crypto bridge + activity-event constants.
 *
 * Extracted from `session.ts` (Sweep 39). These are small, stable pieces of
 * the session module that don't need to live alongside the SessionManager
 * class.
 */
import * as Comlink from 'comlink';
import type { CryptoWorkerApi, DbCryptoBridge } from '../workers/types';

/**
 * Build a Comlink-proxied {@link DbCryptoBridge} that the DB SharedWorker
 * uses to wrap/unwrap OPFS snapshots.
 *
 * Slice 8 hard-cutover replaces the old `getDbSessionKey()` -> raw bytes
 * -> `db.init(sessionKey)` plumbing: the DB worker no longer holds key
 * material, and instead invokes these callbacks across the worker
 * boundary, which round-trip through the crypto worker's Rust-backed
 * `wrapDbBlob` / `unwrapDbBlob` methods.
 */
export function makeDbCryptoBridge(
  cryptoClient: Comlink.Remote<CryptoWorkerApi>,
): DbCryptoBridge {
  return Comlink.proxy({
    wrap: (plaintext: Uint8Array): Promise<Uint8Array> =>
      cryptoClient.wrapDbBlob(plaintext),
    unwrap: (wrapped: Uint8Array): Promise<Uint8Array> =>
      cryptoClient.unwrapDbBlob(wrapped),
  });
}

/** Events that reset the idle timer.
 *
 * Includes pointer/wheel input (covers trackpad-only users and mouse
 * wheels who never fire mousedown) and `visibilitychange` (re-focusing
 * the tab from another window/app should keep the session alive — a
 * more reliable signal than `focus` because `focus` doesn't fire when
 * a tab is restored from a background browser window). `pointermove`
 * and `mousemove` are deliberately omitted — they would fire dozens
 * of times per second and defeat the idle timeout entirely.
 */
export const ACTIVITY_EVENTS = [
  'mousedown',
  'keydown',
  'touchstart',
  'scroll',
  'pointerdown',
  'wheel',
  'visibilitychange',
] as const;

export const UPLOAD_ACTIVE_EVENT = 'mosaic:upload-active';

/** BroadcastChannel name used to propagate logout across browser tabs. */
export const SESSION_BROADCAST_CHANNEL = 'mosaic-session';

/** Session state stored in sessionStorage for page reload detection. */
export const SESSION_STATE_KEY = 'mosaic:sessionState';
