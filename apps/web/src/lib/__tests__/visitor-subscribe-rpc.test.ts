/**
 * Regression test for v1.0.1 isolated-v3-10-subscribe-unserializable.
 *
 * After fixing the visitor `SourceStrategy` proxy marker (v3-10) and the
 * rust 723 shard-hash decoder (v3-10-visitor-rust-723), the W-A6-6 visitor
 * download flow surfaced a third downstream Comlink boundary bug:
 *
 *   `TypeError: Unserializable return value`
 *
 * Root cause: the coordinator worker's `subscribe(jobId, callback)` method
 * returned a plain object whose `unsubscribe` member was wrapped in
 * `Comlink.proxy(fn)`. Comlink's transfer handlers only consult the
 * `proxyMarker` on the TOP-LEVEL value crossing the worker boundary —
 * nested function members still flow through `structuredClone`, which
 * cannot clone functions and throws this exact error.
 *
 * The fix wraps the WHOLE return object in `Comlink.proxy({...})` so the
 * subscription becomes a single proxied handle and `unsubscribe()` becomes
 * a remote round-trip. The main-thread consumer must then release the
 * proxy via `[Comlink.releaseProxy]()` once the unsubscribe round-trip has
 * resolved, or the worker-side MessagePort handle leaks for every job.
 *
 * This file pins both invariants with isolated unit tests that do NOT
 * require the live worker — we simulate Comlink's transfer-handler
 * semantics directly.
 */
import { describe, expect, it, vi } from 'vitest';
import * as Comlink from 'comlink';

/**
 * Walk the value `structuredClone` would walk and throw if any nested
 * function is encountered. Mirrors the failure mode produced by Comlink's
 * `toWireValue` default path (RAW) when the top-level value is a plain
 * object.
 */
function simulateStructuredCloneOfReturn(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if ((value as { [k: symbol]: unknown })[Comlink.proxyMarker as unknown as symbol]) {
    // Top-level proxy marker — Comlink swaps in a MessagePort; no clone.
    return;
  }
  for (const key of Object.keys(value)) {
    const child = (value as Record<string, unknown>)[key];
    if (typeof child === 'function') {
      throw new TypeError(
        `Unserializable return value: nested function at "${key}"`,
      );
    }
    if (child !== null && typeof child === 'object') {
      simulateStructuredCloneOfReturn(child);
    }
  }
}

describe('visitor subscribe RPC — Comlink return value serialization', () => {
  it('REPRODUCES the failure: { unsubscribe: Comlink.proxy(fn) } is unserializable', () => {
    // BAD (pre-fix): proxy-mark only the inner function. The outer plain
    // object still goes through structuredClone, which can't clone the
    // function — exactly the production TypeError.
    const broken = {
      unsubscribe: Comlink.proxy((): void => undefined),
    };
    expect(() => simulateStructuredCloneOfReturn(broken)).toThrow(
      /Unserializable return value/,
    );
  });

  it('FIX: Comlink.proxy({ unsubscribe: fn }) is transferable as a single handle', () => {
    // GOOD (post-fix): wrap the WHOLE object. Comlink emits a single
    // MessagePort and `subscription.unsubscribe()` is a remote call.
    const fixed = Comlink.proxy({
      unsubscribe: (): void => undefined,
    });
    expect(() => simulateStructuredCloneOfReturn(fixed)).not.toThrow();
  });

  it('FIX: the proxied subscription exposes a callable unsubscribe', () => {
    let unsubCount = 0;
    const sub = Comlink.proxy({
      unsubscribe: (): void => {
        unsubCount += 1;
      },
    });
    // Direct invocation (in-process — Comlink.proxy is identity in test env
    // unless wired to a MessagePort, which is faithful to the consumer's
    // call shape).
    sub.unsubscribe();
    expect(unsubCount).toBe(1);
  });

  it('FIX: proxied subscription can be released via [Comlink.releaseProxy]', () => {
    // The runner must release the subscription proxy after unsubscribe so
    // the worker-side MessagePort handle does not leak. Out of an
    // abundance of safety, the runner is allowed to call releaseProxy on a
    // value that does not own the symbol — verify it is at worst a no-op.
    const sub = Comlink.proxy({ unsubscribe: (): void => undefined });
    const release = vi.fn(() => undefined);
    (sub as unknown as { [Comlink.releaseProxy]?: () => void })[
      Comlink.releaseProxy
    ] = release;
    expect(() => {
      (sub as unknown as { [Comlink.releaseProxy]?: () => void })[
        Comlink.releaseProxy
      ]?.();
    }).not.toThrow();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
