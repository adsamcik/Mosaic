import { beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedTusUpload {
  readonly options: {
    readonly onShouldRetry?: (error: Error, retryAttempt: number) => boolean;
    readonly onError?: (error: Error) => void;
    readonly onSuccess?: () => void;
  };
}

interface TusTestError extends Error {
  originalResponse?: {
    getStatus(): number;
  };
}

const tusMock = vi.hoisted(() => ({
  uploads: [] as CapturedTusUpload[],
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('tus-js-client', () => ({
  Upload: vi.fn().mockImplementation(function TusUploadMock(
    _file: Blob,
    options: CapturedTusUpload['options'],
  ) {
    const instance = {
      url: 'http://localhost:5000/api/v1/files/018f0000-0000-7000-8000-000000000201',
      start: vi.fn(() => {
        // Don't auto-fire — tests below trigger onShouldRetry directly.
      }),
    };
    tusMock.uploads.push({ options });
    return instance;
  }),
}));

import { tusUpload } from '../tus-upload';

function makeStatusError(status: number, message = `HTTP ${status}`): TusTestError {
  const err = new Error(message) as TusTestError;
  err.name = 'DetailedError';
  err.originalResponse = { getStatus: () => status };
  return err;
}

describe('tusUpload onShouldRetry server-error cap', () => {
  beforeEach(() => {
    tusMock.uploads.length = 0;
  });

  it('retries 5xx errors at most twice (3 total attempts) so failures surface quickly', () => {
    // Kick off upload — we only need the captured options, not completion.
    void tusUpload(
      'album-001',
      new Uint8Array([1, 2, 3]),
      'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      7,
    ).catch(() => {
      /* not relevant for this test */
    });

    const { onShouldRetry } = tusMock.uploads[0]!.options;
    expect(onShouldRetry).toBeDefined();

    const err500 = makeStatusError(500);
    expect(onShouldRetry!(err500, 0)).toBe(true); // retry 1
    expect(onShouldRetry!(err500, 1)).toBe(true); // retry 2
    expect(onShouldRetry!(err500, 2)).toBe(false); // give up — surface error
  });

  it('caps 503 retries the same way as 500', () => {
    void tusUpload('a', new Uint8Array([1]), 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 0).catch(() => {
      /* swallow */
    });
    const { onShouldRetry } = tusMock.uploads[0]!.options;
    const err503 = makeStatusError(503);
    expect(onShouldRetry!(err503, 0)).toBe(true);
    expect(onShouldRetry!(err503, 1)).toBe(true);
    expect(onShouldRetry!(err503, 2)).toBe(false);
  });

  it('still retries network errors (status === undefined) at every attempt', () => {
    void tusUpload('a', new Uint8Array([1]), 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 0).catch(() => {
      /* swallow */
    });
    const { onShouldRetry } = tusMock.uploads[0]!.options;
    const networkErr = new Error('Failed to fetch');
    expect(onShouldRetry!(networkErr, 0)).toBe(true);
    expect(onShouldRetry!(networkErr, 5)).toBe(true);
    expect(onShouldRetry!(networkErr, 99)).toBe(true);
  });

  it('does not retry 4xx errors except the explicit transient set', () => {
    void tusUpload('a', new Uint8Array([1]), 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 0).catch(() => {
      /* swallow */
    });
    const { onShouldRetry } = tusMock.uploads[0]!.options;
    expect(onShouldRetry!(makeStatusError(400), 0)).toBe(false);
    expect(onShouldRetry!(makeStatusError(404), 0)).toBe(false);
    expect(onShouldRetry!(makeStatusError(413), 0)).toBe(false);
    expect(onShouldRetry!(makeStatusError(429), 0)).toBe(true);
    expect(onShouldRetry!(makeStatusError(408), 0)).toBe(true);
  });
});
