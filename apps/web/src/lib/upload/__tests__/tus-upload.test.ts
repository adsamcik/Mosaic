import { beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedTusUpload {
  readonly file: Blob;
  readonly options: {
    readonly metadata?: Record<string, string>;
    readonly onShouldRetry?: (error: Error, retryAttempt: number) => boolean;
    readonly onSuccess?: () => void;
  };
  readonly instance: {
    url: string | null;
    start: ReturnType<typeof vi.fn>;
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
  createLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

vi.mock('tus-js-client', () => ({
  Upload: vi.fn().mockImplementation(function TusUploadMock(file: Blob, options: CapturedTusUpload['options']) {
    const instance = {
      url: 'http://localhost:5000/api/v1/files/018f0000-0000-7000-8000-000000000201',
      start: vi.fn(() => options.onSuccess?.()),
    };
    tusMock.uploads.push({ file, options, instance });
    return instance;
  }),
}));

import { tusUpload } from '../tus-upload';

describe('tusUpload metadata', () => {
  beforeEach(() => {
    tusMock.uploads.length = 0;
  });

  it('sends client-computed ciphertext SHA-256 as lowercase hex content-sha256 metadata', async () => {
    const shardId = await tusUpload(
      'album-001',
      new Uint8Array([1, 2, 3]),
      'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      7,
    );

    expect(shardId).toBe('018f0000-0000-7000-8000-000000000201');
    expect(tusMock.uploads).toHaveLength(1);
    expect(tusMock.uploads[0]!.options.metadata).toEqual({
      albumId: 'album-001',
      shardIndex: '7',
      'content-sha256': '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    });
  });
});

describe('tusUpload retry classification', () => {
  beforeEach(() => {
    tusMock.uploads.length = 0;
  });

  async function captureOnShouldRetry(): Promise<NonNullable<CapturedTusUpload['options']['onShouldRetry']>> {
    await tusUpload(
      'album-001',
      new Uint8Array([1, 2, 3]),
      'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      7,
    );
    const onShouldRetry = tusMock.uploads[0]?.options.onShouldRetry;
    if (onShouldRetry === undefined) {
      throw new Error('Expected tus onShouldRetry callback to be configured');
    }
    return onShouldRetry;
  }

  function detailedError(status: number): TusTestError {
    const error = new Error(`HTTP ${status}`) as TusTestError;
    error.name = 'DetailedError';
    error.originalResponse = {
      getStatus: () => status,
    };
    return error;
  }

  it('retries server errors', async () => {
    const onShouldRetry = await captureOnShouldRetry();

    expect(onShouldRetry(detailedError(503), 0)).toBe(true);
  });

  it('retries request timeout responses', async () => {
    const onShouldRetry = await captureOnShouldRetry();

    expect(onShouldRetry(detailedError(408), 0)).toBe(true);
  });

  it('does not retry non-retryable client errors', async () => {
    const onShouldRetry = await captureOnShouldRetry();

    expect(onShouldRetry(detailedError(422), 0)).toBe(false);
  });

  it('retries network errors without an original response', async () => {
    const onShouldRetry = await captureOnShouldRetry();

    expect(onShouldRetry(new Error('NetworkError'), 0)).toBe(true);
  });
});
