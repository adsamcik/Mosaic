import { beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedTusUpload {
  readonly file: Blob;
  readonly options: {
    readonly metadata?: Record<string, string>;
    readonly onShouldRetry?: (error: Error, retryAttempt: number) => boolean;
    readonly onError?: (error: Error) => void;
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
  /** When set, start() invokes onError(detailedError(triggerStatus)) instead of onSuccess. */
  triggerStatus: null as number | null,
  triggerMessage: '',
  /**
   * When true, start() invokes onError with a plain Error that has NO
   * `originalResponse` — modelling network-style failures (DNS / TCP
   * reset / aborted upload) where tus-js-client surfaces only an error
   * message. Used to verify the message-substring fallback in
   * tus-upload.ts (`/\b413\b|quota|too large/i`) still maps to
   * `upload.errors.quotaExceeded`.
   */
  emitMessageOnlyError: false,
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('tus-js-client', () => ({
  Upload: vi.fn().mockImplementation(function TusUploadMock(file: Blob, options: CapturedTusUpload['options']) {
    const instance = {
      url: 'http://localhost:5000/api/v1/files/018f0000-0000-7000-8000-000000000201',
      start: vi.fn(() => {
        if (tusMock.emitMessageOnlyError) {
          // Plain Error: no `originalResponse`, so getTusResponseStatus()
          // returns undefined and the regex branch is the only path that
          // can map to a quota error.
          const err = new Error(tusMock.triggerMessage || 'Upload aborted');
          options.onError?.(err);
          return;
        }
        if (tusMock.triggerStatus !== null) {
          const err = new Error(tusMock.triggerMessage || `HTTP ${tusMock.triggerStatus}`) as TusTestError;
          err.name = 'DetailedError';
          err.originalResponse = { getStatus: () => tusMock.triggerStatus! };
          options.onError?.(err);
          return;
        }
        options.onSuccess?.();
      }),
    };
    tusMock.uploads.push({ file, options, instance });
    return instance;
  }),
}));

import { tusUpload, TusUploadError } from '../tus-upload';
function encryptedEnvelope(): Uint8Array {
  return Uint8Array.of(0x53, 0x47, 0x7a, 0x6b, 3, 1, 2, 3);
}


describe('tusUpload quota error mapping', () => {
  beforeEach(() => {
    tusMock.uploads.length = 0;
    tusMock.triggerStatus = null;
    tusMock.triggerMessage = '';
    tusMock.emitMessageOnlyError = false;
  });

  it('maps HTTP 413 responses to upload.errors.quotaExceeded messageKey', async () => {
    tusMock.triggerStatus = 413;
    tusMock.triggerMessage = 'Storage quota exceeded';

    const err = await tusUpload(
      'album-001',
      encryptedEnvelope(),
      'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      7,
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TusUploadError);
    expect((err as TusUploadError).messageKey).toBe('upload.errors.quotaExceeded');
  });

  it('still maps non-413 non-auth errors to the generic upload.errors.failed key', async () => {
    tusMock.triggerStatus = 422;
    tusMock.triggerMessage = 'Unprocessable';

    const err = await tusUpload(
      'album-001',
      encryptedEnvelope(),
      'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      7,
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TusUploadError);
    expect((err as TusUploadError).messageKey).toBe('upload.errors.failed');
  });

  it('detects "quota" substring in error message even without a status code', async () => {
    // v1.0.2 tus-upload-quota-coverage: previously this case only
    // asserted the regex *literal* — it never exercised tusUpload at
    // all, so a refactor that dropped the message-substring branch
    // from tus-upload.ts would have silently regressed without
    // failing the test. Now we drive the actual upload path through
    // a message-only error (no `originalResponse`) and assert
    // tusUpload maps it to the localized quotaExceeded key.
    tusMock.emitMessageOnlyError = true;
    tusMock.triggerMessage = 'storage quota exceeded';

    const err = await tusUpload(
      'album-001',
      encryptedEnvelope(),
      'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      7,
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TusUploadError);
    expect((err as TusUploadError).messageKey).toBe('upload.errors.quotaExceeded');
    // `originalResponse` was never set on this error, so the only way
    // the branch can fire is via the message-substring regex.
    expect((err as Error).message).toContain('storage quota exceeded');
  });

  it('maps "too large" message-only errors to quotaExceeded', async () => {
    tusMock.emitMessageOnlyError = true;
    tusMock.triggerMessage = 'Payload Too Large';

    const err = await tusUpload(
      'album-001',
      encryptedEnvelope(),
      'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      7,
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TusUploadError);
    expect((err as TusUploadError).messageKey).toBe('upload.errors.quotaExceeded');
  });

  it('falls back to upload.errors.failed for unrelated message-only errors', async () => {
    tusMock.emitMessageOnlyError = true;
    tusMock.triggerMessage = 'Network error: socket hang up';

    const err = await tusUpload(
      'album-001',
      encryptedEnvelope(),
      'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      7,
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TusUploadError);
    expect((err as TusUploadError).messageKey).toBe('upload.errors.failed');
  });
});
