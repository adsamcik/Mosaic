/**
 * Regression: v1.0.1 isolated-v3-08 + security-review-2026-05-21 MED.
 *
 * Before this fix, `processLegacyUpload` would short-circuit any shard
 * whose `completedShards` entry already existed for the requested
 * `index`, regardless of whether that record carried the encrypted
 * envelope `contentLength`. Stale resume records produced before
 * commit 773e7d95 (which started persisting `contentLength`) therefore
 * forwarded shard ids whose finalize payload fell back to
 * `task.file.size` (plaintext size). The backend rejected finalize
 * with HTTP 400 ("tieredShards contentLength does not match stored
 * shard length") and the photo never appeared in the gallery on the
 * reopened tab.
 *
 * After the fix, the legacy handler must re-upload any shard whose
 * persisted record is missing `contentLength` / `envelopeVersion`, so
 * the resulting `completedShards` row carries the encrypted envelope
 * length and finalize succeeds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadHandlerContext, UploadTask } from '../types';
import type { EpochHandleId } from '../../../workers/types';

const mocks = vi.hoisted(() => ({
  getCryptoClient: vi.fn(),
  encryptShardWithEpochHandle: vi.fn(),
  computeContentHashStreaming: vi.fn(),
  contentHashLookup: vi.fn(),
  contentHashRecord: vi.fn(),
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../crypto-client', () => ({
  getCryptoClient: () => mocks.getCryptoClient(),
}));

vi.mock('../../content-hash', async () => {
  const actual = await vi.importActual<typeof import('../../content-hash')>('../../content-hash');
  return {
    ...actual,
    computeContentHashStreaming: (...args: unknown[]) => mocks.computeContentHashStreaming(...args),
  };
});

import { processLegacyUpload } from '../legacy-upload-handler';

const EPOCH_HANDLE = 'epch_legacy-stale-resume' as EpochHandleId;

function createTask(file: File, completed: UploadTask['completedShards']): UploadTask {
  return {
    id: 'task-resume-stale',
    file,
    albumId: 'album-001',
    epochId: 7,
    epochHandleId: EPOCH_HANDLE,
    status: 'queued',
    currentAction: 'pending',
    progress: 0,
    completedShards: completed,
    retryCount: 0,
    lastAttemptAt: 0,
  };
}

function createCtx(): UploadHandlerContext & {
  tusUpload: ReturnType<typeof vi.fn>;
  updatePersistedTask: ReturnType<typeof vi.fn>;
} {
  const dedup = {
    lookup: (...args: unknown[]) => mocks.contentHashLookup(...args),
    record: (...args: unknown[]) => mocks.contentHashRecord(...args),
  } as unknown as NonNullable<UploadHandlerContext['contentHashDedup']>;
  return {
    tusUpload: vi.fn().mockResolvedValue('shard-id-fresh'),
    updatePersistedTask: vi.fn().mockResolvedValue(undefined),
    onProgress: vi.fn(),
    onComplete: vi.fn(),
    contentHashDedup: dedup,
  };
}

describe('legacy upload resume skips stale records lacking envelope length', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.computeContentHashStreaming.mockResolvedValue('hash-stale-resume');
    mocks.contentHashLookup.mockResolvedValue(undefined);
    mocks.contentHashRecord.mockResolvedValue(undefined);
    mocks.getCryptoClient.mockResolvedValue({
      encryptShardWithEpochHandle: mocks.encryptShardWithEpochHandle,
    });
    // Envelope = 64-byte header + ciphertext + 16-byte AEAD tag.
    mocks.encryptShardWithEpochHandle.mockImplementation(
      async (_handle: EpochHandleId, plaintext: Uint8Array) => {
        return new Uint8Array(64 + plaintext.byteLength + 16);
      },
    );
  });

  it('re-uploads when persisted record is missing contentLength', async () => {
    const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
    const file = new File([plaintext], 'resume.bin', { type: 'application/octet-stream' });
    // Stale persisted record: only index + shardId + sha256 + tier, no
    // contentLength / envelopeVersion. Simulates a v0.x resume record.
    const task = createTask(file, [
      {
        index: 0,
        shardId: 'shard-id-stale',
        sha256: 'stale-sha',
        tier: 3,
      },
    ]);
    const ctx = createCtx();
    const crypto = await mocks.getCryptoClient();

    await processLegacyUpload(task, crypto, ctx);

    // The handler must have actually uploaded (not skipped) and replaced the stale row.
    expect(ctx.tusUpload).toHaveBeenCalledTimes(1);
    expect(task.completedShards).toHaveLength(1);
    const shard = task.completedShards[0]!;
    expect(shard.shardId).toBe('shard-id-fresh');
    expect(shard.contentLength).toBe(64 + plaintext.byteLength + 16);
    expect(shard.envelopeVersion).toBe(3);
  });

  it('still skips when persisted record has full envelope metadata', async () => {
    const plaintext = new Uint8Array([9, 9, 9]);
    const file = new File([plaintext], 'resume-ok.bin', { type: 'application/octet-stream' });
    const expectedLength = 64 + plaintext.byteLength + 16;
    const task = createTask(file, [
      {
        index: 0,
        shardId: 'shard-id-already',
        sha256: 'sha-ok',
        tier: 3,
        contentLength: expectedLength,
        envelopeVersion: 3,
      },
    ]);
    const ctx = createCtx();
    const crypto = await mocks.getCryptoClient();

    await processLegacyUpload(task, crypto, ctx);

    expect(ctx.tusUpload).not.toHaveBeenCalled();
    expect(task.completedShards).toHaveLength(1);
    const shard = task.completedShards[0]!;
    expect(shard.shardId).toBe('shard-id-already');
    expect(shard.contentLength).toBe(expectedLength);
  });
});
