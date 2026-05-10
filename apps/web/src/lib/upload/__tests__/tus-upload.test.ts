import { beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedTusUpload {
  readonly file: Blob;
  readonly options: {
    readonly metadata?: Record<string, string>;
    readonly onSuccess?: () => void;
  };
  readonly instance: {
    url: string | null;
    start: ReturnType<typeof vi.fn>;
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
      url: 'http://localhost:5000/api/files/018f0000-0000-7000-8000-000000000201',
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
