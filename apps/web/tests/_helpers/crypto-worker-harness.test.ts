/**
 * Crypto-worker harness smoke tests — Slice 0D.
 *
 * Goals
 * -----
 * 1. The harness module loads cleanly and exposes its full surface area.
 * 2. Capability detection reports the same answer twice (no flapping).
 * 3. When a real Worker is present (browser mode / future env), the
 *    harness boots, initializes, double-closes idempotently, and survives
 *    concurrent shard-encrypt fan-out without deadlocking. Those are
 *    `itIfWorker` blocks — they auto-skip in happy-dom because happy-dom
 *    v20 does not ship `globalThis.Worker`.
 * 4. Document — via `it.skip(..., 'gated by Slice 1')` — the methods that
 *    will become exercisable once Slice 1 mints the handle-based contract.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CLOSED_HANDLE_ERROR_HINTS,
  createCryptoWorkerHarness,
  detectWorkerCapability,
  noWorker,
  type CryptoWorkerHarness,
} from './crypto-worker-harness';

describe('crypto-worker-harness: capability detection', () => {
  it('exposes a stable boolean', () => {
    const a = detectWorkerCapability();
    const b = detectWorkerCapability();
    expect(a.hasWorker).toBe(b.hasWorker);
  });

  it('explains why Worker is unavailable when it is unavailable', () => {
    const cap = detectWorkerCapability();
    if (!cap.hasWorker) {
      expect(cap.reason.length).toBeGreaterThan(0);
      expect(cap.reason).toMatch(/happy-dom|Worker/i);
    } else {
      expect(cap.reason).toMatch(/available/);
    }
  });
});

describe('crypto-worker-harness: factory shape', () => {
  it('returns an UnavailableHarness when Worker is not present', async () => {
    if (!noWorker()) {
      // We're in a Worker-capable env — skip this no-worker assertion.
      return;
    }
    const harness = await createCryptoWorkerHarness();
    expect(harness.available).toBe(false);
    if (harness.available === false) {
      expect(typeof harness.reason).toBe('string');
      expect(harness.reason.length).toBeGreaterThan(0);
    }
  });

  it('exposes the documented stable error hints', () => {
    expect(CLOSED_HANDLE_ERROR_HINTS).toContain('closed');
    expect(CLOSED_HANDLE_ERROR_HINTS).toContain('terminated');
  });
});

// ---------------------------------------------------------------------------
// Live harness tests — gated on Worker availability.
// ---------------------------------------------------------------------------

describe('crypto-worker-harness: live worker (Worker-capable env only)', () => {
  let harness: CryptoWorkerHarness | null = null;

  beforeAll(() => {
    if (noWorker()) return;
  });

  afterEach(async () => {
    if (harness && harness.available) {
      await harness.terminate();
      harness = null;
    }
  });

  it.skipIf(noWorker())('boots a real worker and confirms initialization', async () => {
    harness = await createCryptoWorkerHarness();
    expect(harness.available).toBe(true);
    if (harness.available) {
      expect(typeof harness.api.getIdentityPublicKey).toBe('function');
    }
  });

  it.skipIf(noWorker())('double-close is idempotent', async () => {
    harness = await createCryptoWorkerHarness();
    if (!harness.available) return;
    const lifecycle = harness.lifecycleHarness();
    await lifecycle.bringToInitialized();
    const okCount = await lifecycle.closeIdempotent(3);
    expect(okCount).toBe(3);
  });

  it.skipIf(noWorker())(
    'fan-out concurrent calls on a single api do not deadlock',
    async () => {
      harness = await createCryptoWorkerHarness();
      if (!harness.available) return;
      const concurrency = harness.concurrencyHarness();
      const result = await concurrency.fanOutNoOp(8, 16, 30000);
      expect(result.fulfilled + result.rejected).toBe(8 * 16);
      // No deadlock and reasonable wall-clock — 128 noop round-trips
      // through Comlink should comfortably fit in 30s on any CI box.
      expect(result.elapsedMs).toBeLessThan(30000);
    },
  );

  it.skipIf(noWorker())('reports no raw-secret leakage from public methods', async () => {
    harness = await createCryptoWorkerHarness();
    if (!harness.available) return;
    const report = await harness.assertNoRawSecrets();
    expect(report.inspectedMethods.length).toBeGreaterThan(0);
    // Pre-init, all methods either return null or throw — that's fine.
    // The assertion is that nothing fails the entropy/structure check.
  });
});

// ---------------------------------------------------------------------------
// Slice-1-gated tests — documented placeholders.
// ---------------------------------------------------------------------------

describe('crypto-worker-harness: Slice 1 contract (skipped placeholders)', () => {
  it.skip('returns opaque handle IDs from openEpochKeyBundle (gated by Slice 1)', () => {
    // After Slice 1 lands, openEpochKeyBundle returns an `OpaqueHandleId`
    // string instead of `{ epochSeed, signPublicKey, signSecretKey }`.
    // The harness will assert no Uint8Array nested under that return value.
  });

  it.skip('returns opaque handle IDs from generateEpochKey (gated by Slice 1)', () => {
    // Same as above; current return is a raw secret tuple. Slice 1 gates this.
  });

  it.skip('exposes getDbEncryptionHandle in place of getSessionKey (gated by Slice 1)', () => {
    // Slice 1 replaces getSessionKey() → getDbEncryptionHandle() returning a
    // string handle. The lifecycle harness will then assert handle.close()
    // cascades correctly.
  });

  it.skip('exportKeys returns a handle-serialized blob, not raw bytes (gated by Slice 1)', () => {
    // Slice 1 replaces ExportedKeys's six base64 fields with a single
    // opaque blob whose contents are encrypted under the wrapping key only
    // the worker knows.
  });

  it.skip('every operation against a closed handle returns the same stable error code (gated by Slice 1)', () => {
    // Once Slice 1 has the error enum, this test asserts:
    //   await closedHandle.encryptShard(...) → throws { code: 'CLOSED_HANDLE' }
    // For now only the textual hints in CLOSED_HANDLE_ERROR_HINTS are stable.
  });
});
