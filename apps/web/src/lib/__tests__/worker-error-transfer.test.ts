/**
 * Regression tests for security-review-2026-05-19-17:
 * `WorkerCryptoError.code` must be preserved across the Comlink boundary.
 *
 * Comlink's default `'throw'` transfer handler reconstructs thrown errors
 * via `Object.assign(new Error(message), { name, stack })`, dropping any
 * subclass-specific fields. The DB-crypto bridge's `ClosedHandle`
 * classification depends on `error.code` and `instanceof WorkerCryptoError`,
 * so we install a custom handler that round-trips both.
 */
import { describe, expect, it } from 'vitest';
import * as Comlink from 'comlink';
import {
  workerCryptoErrorThrowHandler,
  registerWorkerCryptoErrorTransferHandler,
} from '../worker-error-transfer';
import { WorkerCryptoError } from '../../workers/types';
import { WorkerCryptoErrorCode } from '../../workers/worker-crypto-error-code.generated';

// Helper: synthesise the same wrap shape Comlink internally produces for
// thrown values. The marker symbol is module-private in Comlink, so we
// mint our own with the same description — `workerCryptoErrorThrowHandler`
// detects it structurally.
function wrapThrown(value: unknown): { value: unknown } {
  const marker = Symbol('Comlink.thrown');
  return { value, [marker]: 0 } as { value: unknown };
}

describe('worker-error-transfer — direct serialize/deserialize', () => {
  it('canHandle matches Comlink throw-wrap envelopes', () => {
    expect(workerCryptoErrorThrowHandler.canHandle(wrapThrown(new Error('x')))).toBe(true);
  });

  it('canHandle rejects unrelated objects and primitives', () => {
    expect(workerCryptoErrorThrowHandler.canHandle({ value: 'oops' })).toBe(false);
    expect(workerCryptoErrorThrowHandler.canHandle(null)).toBe(false);
    expect(workerCryptoErrorThrowHandler.canHandle('throw me')).toBe(false);
  });

  it('round-trips a WorkerCryptoError with code preserved', () => {
    const original = new WorkerCryptoError(
      WorkerCryptoErrorCode.ClosedHandle,
      'lease closed',
    );
    const [serialized] = workerCryptoErrorThrowHandler.serialize(wrapThrown(original));

    let caught: unknown;
    try {
      workerCryptoErrorThrowHandler.deserialize(serialized);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(WorkerCryptoError);
    expect((caught as WorkerCryptoError).code).toBe(WorkerCryptoErrorCode.ClosedHandle);
    expect((caught as WorkerCryptoError).message).toBe('lease closed');
    expect((caught as WorkerCryptoError).name).toBe('WorkerCryptoError');
  });

  it('round-trips each WorkerCryptoErrorCode variant unchanged', () => {
    const codes = [
      WorkerCryptoErrorCode.ClosedHandle,
      WorkerCryptoErrorCode.StaleHandle,
      WorkerCryptoErrorCode.HandleNotFound,
      WorkerCryptoErrorCode.WorkerNotInitialized,
      WorkerCryptoErrorCode.AuthenticationFailed,
    ];
    for (const code of codes) {
      const err = new WorkerCryptoError(code, `code ${code}`);
      const [serialized] = workerCryptoErrorThrowHandler.serialize(wrapThrown(err));
      let caught: unknown;
      try {
        workerCryptoErrorThrowHandler.deserialize(serialized);
      } catch (e) {
        caught = e;
      }
      expect((caught as WorkerCryptoError).code).toBe(code);
    }
  });

  it('falls back to plain Error reconstruction for non-WorkerCryptoError throws', () => {
    const original = new TypeError('boom');
    original.stack = 'fake-stack';
    const [serialized] = workerCryptoErrorThrowHandler.serialize(wrapThrown(original));

    let caught: unknown;
    try {
      workerCryptoErrorThrowHandler.deserialize(serialized);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(WorkerCryptoError);
    expect((caught as Error).message).toBe('boom');
    expect((caught as Error).name).toBe('TypeError');
    expect((caught as Error).stack).toBe('fake-stack');
  });

  it('rethrows non-Error values verbatim', () => {
    const [serialized] = workerCryptoErrorThrowHandler.serialize(wrapThrown('plain string'));
    let caught: unknown;
    try {
      workerCryptoErrorThrowHandler.deserialize(serialized);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe('plain string');
  });
});

describe('worker-error-transfer — registration', () => {
  it('replaces the default throw handler in Comlink.transferHandlers', () => {
    registerWorkerCryptoErrorTransferHandler();
    expect(Comlink.transferHandlers.get('throw')).toBe(workerCryptoErrorThrowHandler);
  });

  it('is idempotent', () => {
    registerWorkerCryptoErrorTransferHandler();
    registerWorkerCryptoErrorTransferHandler();
    expect(Comlink.transferHandlers.get('throw')).toBe(workerCryptoErrorThrowHandler);
  });
});

describe('worker-error-transfer — integration via Comlink + MessageChannel', () => {
  // End-to-end proof: spin up two Comlink endpoints connected by a
  // MessageChannel, throw a WorkerCryptoError on the server side, and
  // verify the client receives a real WorkerCryptoError with `.code`
  // intact. This exercises the full toWireValue/fromWireValue path.

  interface FailingApi {
    fail(): Promise<void>;
  }

  it('preserves code and prototype across a real Comlink port pair', async () => {
    registerWorkerCryptoErrorTransferHandler();

    const api: FailingApi = {
      async fail(): Promise<void> {
        throw new WorkerCryptoError(
          WorkerCryptoErrorCode.ClosedHandle,
          'lease closed',
        );
      },
    };

    const channel = new MessageChannel();
    Comlink.expose(api, channel.port1);
    const remote = Comlink.wrap<FailingApi>(channel.port2);

    let caught: unknown;
    try {
      await remote.fail();
    } catch (e) {
      caught = e;
    } finally {
      channel.port1.close();
      channel.port2.close();
    }

    expect(caught).toBeInstanceOf(WorkerCryptoError);
    expect((caught as WorkerCryptoError).code).toBe(WorkerCryptoErrorCode.ClosedHandle);
    expect((caught as WorkerCryptoError).message).toBe('lease closed');
    expect((caught as WorkerCryptoError).name).toBe('WorkerCryptoError');
  });

  it('preserves code for handle-lifecycle codes used by makeDbCryptoBridge', async () => {
    registerWorkerCryptoErrorTransferHandler();

    const api = {
      async stale(): Promise<void> {
        throw new WorkerCryptoError(WorkerCryptoErrorCode.StaleHandle, 'stale');
      },
      async closed(): Promise<void> {
        throw new WorkerCryptoError(WorkerCryptoErrorCode.ClosedHandle, 'closed');
      },
    };

    const channel = new MessageChannel();
    Comlink.expose(api, channel.port1);
    const remote = Comlink.wrap<typeof api>(channel.port2);

    try {
      let staleErr: unknown;
      try {
        await remote.stale();
      } catch (e) {
        staleErr = e;
      }
      expect((staleErr as WorkerCryptoError).code).toBe(
        WorkerCryptoErrorCode.StaleHandle,
      );
      expect(staleErr).toBeInstanceOf(WorkerCryptoError);

      let closedErr: unknown;
      try {
        await remote.closed();
      } catch (e) {
        closedErr = e;
      }
      expect((closedErr as WorkerCryptoError).code).toBe(
        WorkerCryptoErrorCode.ClosedHandle,
      );
      expect(closedErr).toBeInstanceOf(WorkerCryptoError);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });

  it('still delivers plain Errors with message and name intact', async () => {
    registerWorkerCryptoErrorTransferHandler();

    const api = {
      async boom(): Promise<void> {
        throw new TypeError('plain typeerror');
      },
    };

    const channel = new MessageChannel();
    Comlink.expose(api, channel.port1);
    const remote = Comlink.wrap<typeof api>(channel.port2);

    let caught: unknown;
    try {
      await remote.boom();
    } catch (e) {
      caught = e;
    } finally {
      channel.port1.close();
      channel.port2.close();
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(WorkerCryptoError);
    expect((caught as Error).message).toBe('plain typeerror');
    expect((caught as Error).name).toBe('TypeError');
  });
});
