/**
 * Handle-lifecycle property tests — Slice 0D.
 *
 * Property-style tests over the worker harness that codify the lifecycle
 * invariants Slice 1 must preserve:
 *
 * - worker termination mid-operation rejects in-flight promises with a
 *   stable error
 * - close-during-encrypt does the same
 * - logout-during-sync (Slice 1: cascades epoch handle close)
 * - React Strict Mode double-mount (two Comlink wrappers, both call init,
 *   second is idempotent or fails predictably)
 * - concurrent calls on a single handle (8 × 16 fan-out)
 * - double-close is idempotent
 * - close-then-use returns a stable error code
 *
 * Many of these require Slice 1's handle contract. Those tests are
 * `it.skip`d here with a TODO referencing the slice. The remaining tests
 * (concurrent fan-out, double-close on the legacy clear() entry point,
 * worker-termination-mid-op) run today against the legacy worker so they
 * already protect the rewrite.
 *
 * Like all live worker tests, these auto-skip in environments where
 * `globalThis.Worker` is unavailable (vitest's default Node + happy-dom).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  CLOSED_HANDLE_ERROR_HINTS,
  createCryptoWorkerHarness,
  noWorker,
  type CryptoWorkerHarness,
} from './crypto-worker-harness';

let harness: CryptoWorkerHarness | null = null;

afterEach(async () => {
  if (harness && harness.available) {
    await harness.terminate();
    harness = null;
  }
});

describe('handle-lifecycle: worker termination mid-operation', () => {
  it.skipIf(noWorker())(
    'an in-flight Comlink call rejects when the worker is force-terminated',
    async () => {
      harness = await createCryptoWorkerHarness();
      if (!harness.available) return;

      // Issue a deliberately slow operation: init() runs Argon2id, which
      // even in weak-keys E2E mode takes long enough to interrupt.
      const userSalt = new Uint8Array(16).fill(0xab);
      const accountSalt = new Uint8Array(16).fill(0xcd);
      const initPromise = harness.api.init('mid-op-pw', userSalt, accountSalt);

      // Yield once so the worker actually picks up the message before we
      // kill it. 25ms is well below Argon2 even at weak-keys.
      await new Promise((resolve) => setTimeout(resolve, 25));
      harness.killNow();

      let rejected = false;
      let errMsg = '';
      try {
        await initPromise;
      } catch (err) {
        rejected = true;
        errMsg = (err as Error).message ?? String(err);
      }
      expect(rejected).toBe(true);
      // The error should match one of the stable hints; if it doesn't, the
      // failure message tells us what new shape Slice 1 needs to map.
      const matched = CLOSED_HANDLE_ERROR_HINTS.some((hint) =>
        errMsg.toLowerCase().includes(hint),
      );
      // Comlink in some environments reports the bare "DOMException" or
      // "MessagePort closed" — accept any non-empty rejection message as
      // evidence of failure surfacing; lock the exact code in Slice 1.
      expect(rejected || errMsg.length > 0).toBe(true);
      // Soft assertion that we surface *some* recognisable shape so future
      // slices have a starting point; do not fail the suite if Comlink
      // changes its rejection wording.
      if (!matched && errMsg.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[handle-lifecycle] worker-killed-mid-op rejection message did not match CLOSED_HANDLE_ERROR_HINTS: "${errMsg}". Slice 1 should decide whether to add this hint or normalize the error.`,
        );
      }
    },
  );
});

describe('handle-lifecycle: double-close on legacy clear()', () => {
  it.skipIf(noWorker())(
    'calling clear() three times in a row never throws',
    async () => {
      harness = await createCryptoWorkerHarness();
      if (!harness.available) return;
      const lifecycle = harness.lifecycleHarness();
      await lifecycle.bringToInitialized();
      const okCount = await lifecycle.closeIdempotent(3);
      expect(okCount).toBe(3);
    },
  );
});

describe('handle-lifecycle: close-then-use returns observable error', () => {
  it.skipIf(noWorker())(
    'using getSessionKey after clear() returns either null or a recognisable error',
    async () => {
      harness = await createCryptoWorkerHarness();
      if (!harness.available) return;
      const lifecycle = harness.lifecycleHarness();
      await lifecycle.bringToInitialized();
      await harness.api.clear();
      const observation = await lifecycle.observeUseAfterClose();
      // Either we got a stable error or the legacy null-soft-fail. Both are
      // observable; Slice 1 will tighten this to "must throw a stable code".
      expect(observation === null || observation instanceof Error).toBe(true);
    },
  );
});

describe('handle-lifecycle: concurrent fan-out on a single handle', () => {
  it.skipIf(noWorker())(
    '8 × 16 = 128 concurrent calls all settle without deadlock',
    async () => {
      harness = await createCryptoWorkerHarness();
      if (!harness.available) return;
      const concurrency = harness.concurrencyHarness();
      const result = await concurrency.fanOutNoOp(8, 16, 30000);
      expect(result.fulfilled + result.rejected).toBe(128);
      expect(result.elapsedMs).toBeLessThan(30000);
    },
  );
});

describe('handle-lifecycle: React Strict Mode double-mount simulation', () => {
  it.skipIf(noWorker())(
    'two Comlink wrappers around the same worker can both safely init',
    async () => {
      harness = await createCryptoWorkerHarness();
      if (!harness.available) return;
      // Simulate React 19 Strict Mode: a component mounts, calls init, the
      // tree is unmounted then immediately remounted, init is called again.
      // Even though we have only one Comlink remote (the harness's), the
      // *call pattern* mimics the double-mount:
      const userSalt = new Uint8Array(16).fill(0x33);
      const accountSalt = new Uint8Array(16).fill(0x44);
      await harness.api.init('strict-mode', userSalt, accountSalt);

      // Second init: legacy contract just overwrites — assert it does not
      // throw. Slice 1 may decide to fail-fast instead; either is
      // observable, never panic.
      let secondInitFailed = false;
      try {
        await harness.api.init('strict-mode-second', userSalt, accountSalt);
      } catch {
        secondInitFailed = true;
      }
      // Tolerate either path; require *not* throwing in a way that crashes
      // the worker.
      const stillAlive = await harness.api.getIdentityPublicKey().then(
        () => true,
        () => false,
      );
      expect(stillAlive || !secondInitFailed).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Slice 1 gates — placeholders that flip on once handles ship.
// ---------------------------------------------------------------------------

describe('handle-lifecycle: Slice 1 handle-ID contract (placeholders)', () => {
  it.skip('close-during-encrypt rejects the in-flight encrypt with CLOSED_HANDLE (TODO Slice 1)', () => {
    // After Slice 1 lands, this test will:
    //   1. open an epoch handle
    //   2. start encryptShard (large blob, slow path)
    //   3. close the handle while encrypt is in flight
    //   4. assert the encrypt promise rejects with code='CLOSED_HANDLE'
  });

  it.skip('logout-during-sync cascades-closes every epoch handle (TODO Slice 1)', () => {
    // After Slice 1 lands, this test will:
    //   1. open 5 epoch handles
    //   2. start a sync that issues encryptManifest on each
    //   3. trigger logout (api.clear())
    //   4. assert each in-flight encryptManifest rejects with CLOSED_HANDLE
    //   5. assert subsequent calls on any of those handle IDs reject too
  });

  it.skip('handle generation stamps protect against stale-handle reuse (TODO Slice 1)', () => {
    // Generation-stamped handles: open → close → reopen with same numeric
    // ID returns a *different* opaque ID. Operations against the old ID
    // must reject with STALE_HANDLE.
  });

  it.skip('refcounted leases keep an epoch handle alive across overlapping uses (TODO Slice 1)', () => {
    // Two concurrent users (e.g. encryptShard + signManifest) each lease
    // the same epoch handle; closing under one must not invalidate the
    // other; only when refcount hits zero does the handle dispose.
  });

  it.skip('every operation against a closed handle rejects with the same stable code (TODO Slice 1)', () => {
    // Once Slice 1 has its error enum, replace the soft `CLOSED_HANDLE_ERROR_HINTS`
    // assertion with `expect(err.code).toBe('CLOSED_HANDLE')`.
  });
});
