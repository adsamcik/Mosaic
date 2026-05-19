/**
 * Comlink transfer handler that preserves `WorkerCryptoError.code` across
 * the worker boundary (security-review-2026-05-19-17).
 *
 * Background
 * ----------
 * Comlink's built-in `'throw'` transfer handler treats every `Error`
 * uniformly: it extracts `{ message, name, stack }` and reconstructs a
 * plain `Error` on the receiving side via
 * `Object.assign(new Error(message), { name, stack })`. Custom subclass
 * fields — notably `WorkerCryptoError.code` — are dropped, and the
 * `instanceof WorkerCryptoError` check fails on the consumer.
 *
 * This module replaces the `'throw'` entry in
 * `Comlink.transferHandlers` with one that recognises `WorkerCryptoError`
 * specifically and round-trips its `code` plus reinstates the prototype
 * chain so `instanceof` works again. All non-WorkerCryptoError throws
 * fall back to Comlink's original behaviour.
 *
 * Importing this module has the side-effect of registering the handler.
 * Import it once from every Comlink endpoint — the worker entry that
 * calls `Comlink.expose`, AND the main-thread site that calls
 * `Comlink.wrap`. Registration is idempotent.
 */
import * as Comlink from 'comlink';
import { WorkerCryptoError } from '../workers/types';
import { WorkerCryptoErrorCode } from '../workers/worker-crypto-error-code.generated';

const isObject = (val: unknown): val is Record<PropertyKey, unknown> =>
  (typeof val === 'object' && val !== null) || typeof val === 'function';

/**
 * Detect Comlink's `throwMarker` wrap structurally. Comlink wraps thrown
 * values as `{ value, [throwMarker]: 0 }` where `throwMarker` is a
 * module-private `Symbol("Comlink.thrown")`. The symbol itself is not
 * exported, so we match by description on the value's own symbols.
 */
function hasThrowMarker(value: unknown): value is { value: unknown } {
  if (!isObject(value)) return false;
  const symbols = Object.getOwnPropertySymbols(value);
  for (const s of symbols) {
    if (s.description === 'Comlink.thrown') return true;
  }
  return false;
}

interface SerializedWorkerCryptoError {
  readonly isError: true;
  readonly isWorkerCryptoError: true;
  readonly value: {
    readonly message: string;
    readonly name: string;
    readonly stack?: string | undefined;
    readonly code: WorkerCryptoErrorCode;
  };
}

interface SerializedPlainError {
  readonly isError: true;
  readonly isWorkerCryptoError?: false;
  readonly value: {
    readonly message: string;
    readonly name: string;
    readonly stack?: string | undefined;
  };
}

interface SerializedNonError {
  readonly isError: false;
  readonly value: unknown;
}

type SerializedThrow =
  | SerializedWorkerCryptoError
  | SerializedPlainError
  | SerializedNonError;

/**
 * Drop-in replacement for Comlink's default `'throw'` transfer handler that
 * preserves `WorkerCryptoError.code` and prototype identity.
 */
export const workerCryptoErrorThrowHandler: Comlink.TransferHandler<
  { value: unknown },
  SerializedThrow
> = {
  canHandle: (value): value is { value: unknown } => hasThrowMarker(value),

  serialize: ({ value }): [SerializedThrow, Transferable[]] => {
    if (value instanceof WorkerCryptoError) {
      const serialized: SerializedWorkerCryptoError = {
        isError: true,
        isWorkerCryptoError: true,
        value: {
          message: value.message,
          name: value.name,
          stack: value.stack,
          code: value.code,
        },
      };
      return [serialized, []];
    }
    if (value instanceof Error) {
      const serialized: SerializedPlainError = {
        isError: true,
        value: {
          message: value.message,
          name: value.name,
          stack: value.stack,
        },
      };
      return [serialized, []];
    }
    const serialized: SerializedNonError = { isError: false, value };
    return [serialized, []];
  },

  deserialize: (serialized): never => {
    if (serialized.isError) {
      if ('isWorkerCryptoError' in serialized && serialized.isWorkerCryptoError) {
        const err = new WorkerCryptoError(
          serialized.value.code,
          serialized.value.message,
        );
        if (serialized.value.stack) {
          err.stack = serialized.value.stack;
        }
        throw err;
      }
      const plain = serialized.value;
      throw Object.assign(new Error(plain.message), {
        name: plain.name,
        stack: plain.stack,
      });
    }
    throw serialized.value;
  },
};

let registered = false;

/**
 * Register the WorkerCryptoError-aware `'throw'` transfer handler on the
 * current realm's Comlink instance. Idempotent — safe to call from every
 * worker entry and every main-thread Comlink wrap site.
 */
export function registerWorkerCryptoErrorTransferHandler(): void {
  if (registered) return;
  // Replace the built-in 'throw' entry. Using the same key guarantees
  // our handler is consulted in lieu of Comlink's default.
  Comlink.transferHandlers.set(
    'throw',
    workerCryptoErrorThrowHandler as unknown as Comlink.TransferHandler<
      unknown,
      unknown
    >,
  );
  registered = true;
}

// Side-effect: register immediately on import so a single
// `import './worker-error-transfer';` line at any Comlink endpoint
// activates the handler before any Comlink.wrap/expose call.
registerWorkerCryptoErrorTransferHandler();
