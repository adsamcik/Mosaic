import * as Comlink from 'comlink';
import { WorkerCryptoError } from '../workers/types';
import { WorkerCryptoErrorCode } from '../workers/worker-crypto-error-code.generated';

/**
 * Lifetime envelope returned by {@link guardComlinkProxy}.
 *
 * `dispose()` flips an internal flag so any subsequently-arriving
 * invocation throws a typed `WorkerCryptoError(ClosedHandle)` instead
 * of bubbling out as Comlink's cryptic
 * `TypeError: rawValue.apply is not a function` unhandled rejection
 * (observed after every coordinator-worker mount in the
 * P0-IDENTITY-STRESS validation gate).
 *
 * The proxy reference is kept alive after `dispose()` so any
 * worker-side messages still in transit land on the guarded function
 * (which short-circuits) rather than on a released-and-collected slot.
 * Call `[Comlink.releaseProxy]()` from `releaseProxy` only AFTER you
 * have awaited the upstream `unsubscribe()` / `finalize()` round-trip,
 * if you want to free the worker-side handle eagerly.
 */
export interface GuardedComlinkProxy<TFn extends (...args: never[]) => unknown> {
  /** The Comlink-proxied callable to hand to the worker. */
  readonly proxy: TFn;
  /** Mark the proxy disposed; future invocations throw ClosedHandle. */
  readonly dispose: () => void;
  /** Best-effort release of the worker-side handle. Safe to call multiple times. */
  readonly releaseProxy: () => void;
  /** Test/diagnostic hook — true once dispose() has been called. */
  readonly isDisposed: () => boolean;
}

/**
 * Wrap a function so it is safe to expose across a Comlink boundary
 * even when the owning React hook / async flow may tear down before
 * every worker-issued invocation arrives.
 *
 * Without this wrapper, the burst of in-flight worker→main messages
 * that arrives between "we asked the worker to unsubscribe" and
 * "Comlink.releaseProxy() actually cleared the handler table" lands on
 * a released raw value and surfaces as
 * `TypeError: rawValue.apply is not a function`.
 *
 * @param fn The underlying callable to expose.
 * @param label A short label used in the thrown error message; helps
 *   distinguish disposed-proxy stack traces in logs.
 */
export function guardComlinkProxy<TFn extends (...args: never[]) => unknown>(
  fn: TFn,
  label: string,
): GuardedComlinkProxy<TFn> {
  let disposed = false;

  const guarded = ((...args: Parameters<TFn>): ReturnType<TFn> => {
    if (disposed) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.ClosedHandle,
        `${label} proxy disposed`,
      );
    }
    return fn(...args) as ReturnType<TFn>;
  }) as TFn;

  const proxy = Comlink.proxy(guarded);

  return {
    proxy,
    dispose: (): void => {
      disposed = true;
    },
    releaseProxy: (): void => {
      try {
        (proxy as unknown as { [Comlink.releaseProxy]?: () => void })[
          Comlink.releaseProxy
        ]?.();
      } catch {
        // Best-effort release; never throw from cleanup paths.
      }
    },
    isDisposed: (): boolean => disposed,
  };
}
