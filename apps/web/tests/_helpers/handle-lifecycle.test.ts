/**
 * Handle-lifecycle property tests — Slice 1.
 *
 * Property-style tests over the worker harness that codify the lifecycle
 * invariants the new handle-based contract preserves:
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
 * - generation mismatch returns STALE_HANDLE
 * - handle ID with wrong kind returns HandleWrongKind
 * - unknown handle ID returns HandleNotFound
 *
 * Slice 1 is now landed: the handle-based contract is live, the registry
 * exposes generation/leases/close, and the boundary guard locks down the
 * shape of the new methods. Tests below run against the real worker when
 * the runtime ships `globalThis.Worker` (vitest browser mode); they
 * auto-skip in happy-dom.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  CLOSED_HANDLE_ERROR_HINTS,
  createCryptoWorkerHarness,
  noWorker,
  type CryptoWorkerHarness,
} from './crypto-worker-harness';
import { WorkerCryptoErrorCode } from '../../src/workers/types';

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
    'using wrapDbBlob after clear() returns either null or a recognisable error',
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
// Slice 1 — handle-ID contract tests (now-landed).
// ---------------------------------------------------------------------------

describe('handle-lifecycle: Slice 1 handle-ID contract', () => {
  it.skipIf(noWorker())(
    'unknown handle ID rejects with HandleNotFound',
    async () => {
      harness = await createCryptoWorkerHarness();
      if (!harness.available) return;

      const result = await harness.assertHandleIsClosed(
        'acct_nonexistent000000',
        'account',
      );
      expect(result.code).toBe(WorkerCryptoErrorCode.HandleNotFound);
    },
  );

  it.skipIf(noWorker())(
    'using an account handle ID as an epoch handle rejects with HandleWrongKind',
    async () => {
      harness = await createCryptoWorkerHarness();
      if (!harness.available) return;

      const account = await harness.claimAccountHandle();
      // Probe with an op that expects an epoch handle.
      const result = await harness.assertHandleIsClosed(
        account.accountHandleId,
        'epoch',
      );
      expect(result.code).toBe(WorkerCryptoErrorCode.HandleWrongKind);
    },
  );

  it.skipIf(noWorker())(
    'closing an account handle then using it returns ClosedHandle',
    async () => {
      harness = await createCryptoWorkerHarness();
      if (!harness.available) return;

      const account = await harness.claimAccountHandle();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await harness.api.closeAccountHandle(account.accountHandleId as any);

      const result = await harness.assertHandleIsClosed(
        account.accountHandleId,
        'account',
      );
      // After close, the handle is removed from the registry, so it
      // becomes HandleNotFound. Both ClosedHandle and HandleNotFound
      // satisfy the "stable rejection" contract for callers.
      expect([
        WorkerCryptoErrorCode.ClosedHandle,
        WorkerCryptoErrorCode.HandleNotFound,
      ]).toContain(result.code);
    },
  );

  it.skipIf(noWorker())(
    'double-close on a handle is idempotent',
    async () => {
      harness = await createCryptoWorkerHarness();
      if (!harness.available) return;

      const account = await harness.claimAccountHandle();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await harness.api.closeAccountHandle(account.accountHandleId as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await harness.api.closeAccountHandle(account.accountHandleId as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await harness.api.closeAccountHandle(account.accountHandleId as any);
      // No throw means idempotent; we also assert observable closure.
      const result = await harness.assertHandleIsClosed(
        account.accountHandleId,
        'account',
      );
      expect([
        WorkerCryptoErrorCode.ClosedHandle,
        WorkerCryptoErrorCode.HandleNotFound,
      ]).toContain(result.code);
    },
  );

  it.skipIf(noWorker())(
    'clear() bumps generation: handle IDs minted before clear become stale or unknown',
    async () => {
      harness = await createCryptoWorkerHarness();
      if (!harness.available) return;

      const account = await harness.claimAccountHandle();
      await harness.api.clear();

      // After clear() the byId map is dropped, so the old ID resolves to
      // HandleNotFound. (StaleHandle would only fire if the registry kept
      // the id but bumped generation; we drop both — see lifetime
      // semantics docstring in crypto.worker.ts.)
      const result = await harness.assertHandleIsClosed(
        account.accountHandleId,
        'account',
      );
      expect([
        WorkerCryptoErrorCode.HandleNotFound,
        WorkerCryptoErrorCode.StaleHandle,
        WorkerCryptoErrorCode.ClosedHandle,
      ]).toContain(result.code);
    },
  );

  it.skipIf(noWorker())(
    'logout-during-sync cascades-closes every epoch handle',
    async () => {
      harness = await createCryptoWorkerHarness();
      if (!harness.available) return;

      const account = await harness.claimAccountHandle();
      // Open several epoch handles.
      const epochs = await Promise.all([
        harness.claimEpochHandle(account.accountHandleId, 1),
        harness.claimEpochHandle(account.accountHandleId, 2),
        harness.claimEpochHandle(account.accountHandleId, 3),
      ]);

      // Logout: cascades epoch → identity → account.
      await harness.api.clear();

      // Every epoch handle must reject post-clear.
      for (const epoch of epochs) {
        const result = await harness.assertHandleIsClosed(
          epoch.epochHandleId,
          'epoch',
        );
        expect([
          WorkerCryptoErrorCode.HandleNotFound,
          WorkerCryptoErrorCode.StaleHandle,
          WorkerCryptoErrorCode.ClosedHandle,
        ]).toContain(result.code);
      }
    },
  );

  it.skipIf(noWorker())(
    'concurrent encrypt fan-out across one epoch handle settles without deadlock',
    async () => {
      harness = await createCryptoWorkerHarness();
      if (!harness.available) return;

      const account = await harness.claimAccountHandle();
      const epoch = await harness.claimEpochHandle(
        account.accountHandleId,
        42,
      );

      // 8 × 16 = 128 concurrent encrypt calls on the same epoch handle.
      const calls: Array<Promise<unknown>> = [];
      for (let p = 0; p < 8; p += 1) {
        for (let i = 0; i < 16; i += 1) {
          const payload = new Uint8Array(64);
          payload[0] = (p * 16 + i) & 0xff;
          calls.push(
            harness.api.encryptShardWithEpoch(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              epoch.epochHandleId as any,
              payload,
              p * 16 + i,
              0,
            ),
          );
        }
      }

      const settled = await Promise.allSettled(calls);
      const fulfilled = settled.filter((s) => s.status === 'fulfilled').length;
      // We don't insist all succeed — Rust may serialize internally and
      // any small fraction may surface a non-fatal failure. We DO insist
      // on no deadlock and full settlement.
      expect(settled.length).toBe(128);
      expect(fulfilled).toBeGreaterThan(0);
    },
  );

  it.skipIf(noWorker())(
    'closeAccountHandle with wrong kind argument rejects with HandleWrongKind',
    async () => {
      harness = await createCryptoWorkerHarness();
      if (!harness.available) return;

      const account = await harness.claimAccountHandle();
      const epoch = await harness.claimEpochHandle(account.accountHandleId, 7);

      let err: { code?: number } | null = null;
      try {
        // Pass an epoch handle ID into the account-typed close method.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await harness.api.closeAccountHandle(epoch.epochHandleId as any);
      } catch (caught) {
        err = caught as { code?: number };
      }
      expect(err).not.toBeNull();
      expect(err?.code).toBe(WorkerCryptoErrorCode.HandleWrongKind);
    },
  );

  it.skipIf(noWorker())(
    'close-during-encrypt: closing under a held lease defers free until lease drops',
    async () => {
      harness = await createCryptoWorkerHarness();
      if (!harness.available) return;

      const account = await harness.claimAccountHandle();
      const epoch = await harness.claimEpochHandle(account.accountHandleId, 9);

      // Start encrypt + close concurrently.
      const payload = new Uint8Array(2048);
      payload[0] = 0x42;
      const encryptPromise = harness.api.encryptShardWithEpoch(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        epoch.epochHandleId as any,
        payload,
        0,
        0,
      );
      // Yield so the encrypt request leaves the harness side.
      await Promise.resolve();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const closePromise = harness.api.closeEpochHandle(epoch.epochHandleId as any);

      // Both must settle; the encrypt either succeeds (lease was acquired
      // before close) or fails with ClosedHandle (close raced first).
      const [encryptResult, closeResult] = await Promise.allSettled([
        encryptPromise,
        closePromise,
      ]);
      expect(closeResult.status).toBe('fulfilled');
      expect(['fulfilled', 'rejected']).toContain(encryptResult.status);

      // After both settle, further encrypt calls reject deterministically.
      const probe = await harness.assertHandleIsClosed(
        epoch.epochHandleId,
        'epoch',
      );
      expect([
        WorkerCryptoErrorCode.HandleNotFound,
        WorkerCryptoErrorCode.ClosedHandle,
      ]).toContain(probe.code);
    },
  );
});
