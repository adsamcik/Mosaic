import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('comlink', () => ({
  expose: vi.fn(),
}));

import {
  DbWorker,
  DbWorkerError,
  DbWorkerErrorCode,
} from '../src/workers/db.worker';

const sqlBootstrap = `
function initSqlJs() {
  return Promise.resolve({
    Database: class Database {
      close() {}
      run() {}
      exec() { return []; }
      export() { return new Uint8Array([1, 2, 3]); }
      prepare() {
        return { run() {}, free() {} };
      }
    }
  });
}
`;

describe('DbWorker failure handling', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      text: () => Promise.resolve(sqlBootstrap),
    } as Response);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('fails closed when an existing encrypted snapshot cannot be decrypted', async () => {
    const worker = new DbWorker();
    const internalWorker = worker as unknown as {
      loadFromOPFS: () => Promise<Uint8Array | null>;
      decryptBlob: (data: Uint8Array) => Promise<Uint8Array>;
    };

    vi.spyOn(internalWorker, 'loadFromOPFS').mockResolvedValue(
      new Uint8Array([1, 2, 3, 4]),
    );
    vi.spyOn(internalWorker, 'decryptBlob').mockRejectedValue(
      new Error('authentication failed'),
    );

    await expect(worker.init(new Uint8Array(32).fill(1))).rejects.toMatchObject({
      code: DbWorkerErrorCode.SNAPSHOT_DECRYPT_FAILED,
    });

    await expect(worker.setAlbumVersion('album-1', 1)).rejects.toMatchObject({
      code: DbWorkerErrorCode.SNAPSHOT_DECRYPT_FAILED,
    });

    try {
      await worker.getAlbumVersion('album-1');
      expect.fail('Expected reads to stay blocked after decrypt failure');
    } catch (error) {
      expect(error).toBeInstanceOf(DbWorkerError);
      expect((error as DbWorkerError).code).toBe(
        DbWorkerErrorCode.SNAPSHOT_DECRYPT_FAILED,
      );
    }
  });

  it('requires init before resetStorage can recreate the database', async () => {
    const worker = new DbWorker();

    await expect(worker.resetStorage()).rejects.toMatchObject({
      code: DbWorkerErrorCode.NOT_INITIALIZED,
    });
  });
});
