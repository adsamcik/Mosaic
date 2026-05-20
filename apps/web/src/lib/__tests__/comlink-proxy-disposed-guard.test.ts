/**
 * Regression tests for the Comlink-proxy disposed-guard pattern shared
 * by `useDownloadManager`, `useJobThumbnails`, `coordinator-download-runner`,
 * and `save-target-bridge` (P0-IDENTITY-STRESS validation gate).
 *
 * Without the guard, a worker→main message that arrived after the
 * owning React effect tore down its proxy surfaced as the cryptic
 * `TypeError: rawValue.apply is not a function` unhandled rejection
 * burst documented in the validation report. The guard converts that
 * race into a typed `WorkerCryptoError(ClosedHandle)` so callers can
 * branch on the stable error code.
 */
import { describe, expect, it } from 'vitest';
import { guardComlinkProxy } from '../comlink-proxy-guard';
import { WorkerCryptoError } from '../../workers/types';
import { WorkerCryptoErrorCode } from '../../workers/worker-crypto-error-code.generated';

describe('guardComlinkProxy', () => {
  it('forwards calls to the underlying function before dispose()', () => {
    const seen: number[] = [];
    const g = guardComlinkProxy((n: number): number => {
      seen.push(n);
      return n + 1;
    }, 'test.beforeDispose');

    expect(g.isDisposed()).toBe(false);
    expect(g.proxy(7)).toBe(8);
    expect(seen).toEqual([7]);
  });

  it('throws WorkerCryptoError(ClosedHandle) after dispose()', () => {
    const g = guardComlinkProxy((): void => {
      // Intentionally unused — should never run post-dispose.
      throw new Error('should not reach inner body');
    }, 'test.afterDispose');

    g.dispose();
    expect(g.isDisposed()).toBe(true);

    let caught: unknown;
    try {
      g.proxy();
    } catch (err) {
      caught = err;
    }

    // The thrown error MUST be the typed ClosedHandle code, not the
    // Comlink internal "rawValue.apply is not a function" TypeError.
    expect(caught).toBeInstanceOf(WorkerCryptoError);
    expect((caught as WorkerCryptoError).code).toBe(
      WorkerCryptoErrorCode.ClosedHandle,
    );
    expect((caught as WorkerCryptoError).message).toContain('disposed');
    // Critical assertion for the regression: a Comlink-released proxy
    // would throw a generic TypeError. Verify we're NOT that.
    expect((caught as Error).name).toBe('WorkerCryptoError');
    expect((caught as Error).message).not.toContain('rawValue.apply');
  });

  it('dispose() is idempotent', () => {
    const g = guardComlinkProxy((): void => undefined, 'test.idempotent');
    g.dispose();
    g.dispose();
    expect(g.isDisposed()).toBe(true);
  });

  it('releaseProxy() never throws even when called twice', () => {
    const g = guardComlinkProxy((): void => undefined, 'test.releaseTwice');
    expect(() => {
      g.releaseProxy();
      g.releaseProxy();
    }).not.toThrow();
  });

  it('label appears in the disposed error message for debuggability', () => {
    const g = guardComlinkProxy((): void => undefined, 'unique-label-9281');
    g.dispose();
    let caught: unknown;
    try {
      g.proxy();
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toContain('unique-label-9281');
  });

  it('disposed-guard short-circuits even if function would otherwise have side effects', () => {
    let sideEffect = 0;
    const g = guardComlinkProxy((): void => {
      sideEffect += 1;
    }, 'test.sideEffect');

    g.proxy();
    expect(sideEffect).toBe(1);
    g.dispose();
    expect(() => g.proxy()).toThrow(WorkerCryptoError);
    expect(sideEffect).toBe(1); // unchanged
  });
});
