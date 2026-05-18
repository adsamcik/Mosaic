import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiRequest, RequestTimeoutError } from '../api';

/**
 * Tests for the v1.0.x s45-y3 client-side request timeout. apiRequest now
 * has a 30s default timeout and wraps `AbortSignal.timeout` DOMException
 * aborts as RequestTimeoutError so the UI can distinguish a hung server
 * from network/HTTP errors.
 */
describe('apiRequest default timeout (s45-y3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('throws RequestTimeoutError when fetch never resolves before timeoutMs', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((_input, init) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal !== null && signal !== undefined) {
            signal.addEventListener('abort', () => {
              reject(signal.reason);
            });
          }
        });
      });

    const pending = apiRequest('/health', { unversioned: true, timeoutMs: 50 });

    await vi.advanceTimersByTimeAsync(60);

    await expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);
    await expect(pending).rejects.toMatchObject({
      timeoutMs: 50,
      path: '/health',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('passes through caller AbortSignal abort reasons without wrapping', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal !== null && signal !== undefined) {
          signal.addEventListener('abort', () => {
            reject(signal.reason);
          });
        }
      });
    });

    const controller = new AbortController();
    const pending = apiRequest('/health', {
      unversioned: true,
      signal: controller.signal,
      timeoutMs: 5000,
    });

    controller.abort(new Error('caller-cancelled'));

    await expect(pending).rejects.not.toBeInstanceOf(RequestTimeoutError);
  });
});
