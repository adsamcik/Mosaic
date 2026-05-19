/**
 * Regression tests for v1.0.x crypto / Comlink stability fixes.
 *
 * - `comlink-bridge-liveness` (Issue #1): `makeDbCryptoBridge` must throw
 *   `WorkerCryptoError(ClosedHandle)` after `dispose()` instead of forwarding
 *   to a torn-down Comlink port, which would surface as the cryptic
 *   `rawValue.apply is not a function` error.
 */
import { describe, expect, it, vi } from 'vitest';
import { makeDbCryptoBridge } from '../session-bridge';
import { WorkerCryptoError } from '../../workers/types';
import { WorkerCryptoErrorCode } from '../../workers/worker-crypto-error-code.generated';
import type { CryptoWorkerApi } from '../../workers/types';
import type * as Comlink from 'comlink';

function fakeCryptoClient(): Comlink.Remote<CryptoWorkerApi> {
  // Only the two methods used by the bridge need to be implemented.
  return {
    wrapDbBlob: vi.fn(async (b: Uint8Array) => new Uint8Array([...b, 0xff])),
    unwrapDbBlob: vi.fn(async (b: Uint8Array) => b.slice(0, -1)),
  } as unknown as Comlink.Remote<CryptoWorkerApi>;
}

describe('makeDbCryptoBridge — comlink-bridge-liveness', () => {
  it('forwards wrap/unwrap when the bridge is live', async () => {
    const client = fakeCryptoClient();
    const { bridge } = makeDbCryptoBridge(client);

    const wrapped = await bridge.wrap(new Uint8Array([1, 2, 3]));
    expect(wrapped).toEqual(new Uint8Array([1, 2, 3, 0xff]));

    const unwrapped = await bridge.unwrap(new Uint8Array([9, 9, 0xff]));
    expect(unwrapped).toEqual(new Uint8Array([9, 9]));
  });

  it('throws WorkerCryptoError(ClosedHandle) on wrap after dispose', async () => {
    const client = fakeCryptoClient();
    const { bridge, dispose } = makeDbCryptoBridge(client);
    dispose();

    await expect(bridge.wrap(new Uint8Array([1]))).rejects.toMatchObject({
      name: 'WorkerCryptoError',
      code: WorkerCryptoErrorCode.ClosedHandle,
    });
    expect(client.wrapDbBlob).not.toHaveBeenCalled();
  });

  it('throws WorkerCryptoError(ClosedHandle) on unwrap after dispose', async () => {
    const client = fakeCryptoClient();
    const { bridge, dispose } = makeDbCryptoBridge(client);
    dispose();

    let caught: unknown;
    try {
      await bridge.unwrap(new Uint8Array([1]));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkerCryptoError);
    expect((caught as WorkerCryptoError).code).toBe(WorkerCryptoErrorCode.ClosedHandle);
    expect(client.unwrapDbBlob).not.toHaveBeenCalled();
  });

  it('does NOT surface the bare "rawValue.apply is not a function" error', async () => {
    const client = fakeCryptoClient();
    const { bridge, dispose } = makeDbCryptoBridge(client);
    dispose();

    const result = await bridge.wrap(new Uint8Array([1])).catch((err) => err);
    expect(String((result as Error).message)).not.toContain('rawValue.apply');
    expect((result as { code?: number }).code).toBe(WorkerCryptoErrorCode.ClosedHandle);
  });

  it('multiple dispose() calls are idempotent', () => {
    const client = fakeCryptoClient();
    const { dispose } = makeDbCryptoBridge(client);
    expect(() => {
      dispose();
      dispose();
      dispose();
    }).not.toThrow();
  });
});
