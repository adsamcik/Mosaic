/**
 * Regression: v1.0.1 isolated-v2-05.
 *
 * When `processVideoUpload` falls back to `processLegacyUpload` because video
 * frame extraction fails (e.g. for minimal/malformed MP4 fixtures), the
 * legacy handler must populate `contentLength` and `envelopeVersion` on every
 * completed shard. Otherwise the finalize request builder defaults
 * contentLength to `task.file.size` (the *plaintext* byte count), which
 * mismatches the encrypted envelope length the backend stored. The backend
 * then rejects finalize with HTTP 400 ("tieredShards contentLength does not
 * match stored shard length") and the video upload never appears in the
 * gallery.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadHandlerContext, UploadTask } from '../types';
import type { EpochHandleId } from '../../../workers/types';

const mocks = vi.hoisted(() => ({
  extractVideoFrame: vi.fn(),
  getCryptoClient: vi.fn(),
  encryptShardWithEpochHandle: vi.fn(),
  computeContentHashStreaming: vi.fn(),
  contentHashLookup: vi.fn(),
  contentHashRecord: vi.fn(),
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../video-frame-extractor', () => ({
  extractVideoFrame: (...args: unknown[]) => mocks.extractVideoFrame(...args),
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
import { processVideoUpload } from '../video-upload-handler';

const EPOCH_HANDLE = 'epch_legacy-content-length' as EpochHandleId;

function createTask(file: File): UploadTask {
  return {
    id: 'task-legacy-cl',
    file,
    albumId: 'album-001',
    epochId: 7,
    epochHandleId: EPOCH_HANDLE,
    status: 'queued',
    currentAction: 'pending',
    progress: 0,
    completedShards: [],
    retryCount: 0,
    lastAttemptAt: 0,
  };
}

function createCtx(): UploadHandlerContext {
  const dedup = {
    lookup: (...args: unknown[]) => mocks.contentHashLookup(...args),
    record: (...args: unknown[]) => mocks.contentHashRecord(...args),
  } as unknown as NonNullable<UploadHandlerContext['contentHashDedup']>;
  return {
    tusUpload: vi.fn().mockResolvedValue('shard-id-legacy'),
    updatePersistedTask: vi.fn().mockResolvedValue(undefined),
    onProgress: vi.fn(),
    onComplete: vi.fn(),
    contentHashDedup: dedup,
  };
}

describe('legacy upload fallback persists encrypted envelope length', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.computeContentHashStreaming.mockResolvedValue('hash-legacy');
    mocks.contentHashLookup.mockResolvedValue(undefined);
    mocks.contentHashRecord.mockResolvedValue(undefined);
    mocks.getCryptoClient.mockResolvedValue({
      encryptShardWithEpochHandle: mocks.encryptShardWithEpochHandle,
    });
    // Simulate the wire envelope: 64-byte header + ciphertext + 16-byte AEAD tag.
    mocks.encryptShardWithEpochHandle.mockImplementation(
      async (_handle: EpochHandleId, plaintext: Uint8Array, tier: number) => {
        const envelope = new Uint8Array(64 + plaintext.byteLength + 16);
        envelope[0] = tier;
        return envelope;
      },
    );
  });

  it('legacy upload records contentLength = encrypted envelope size, not plaintext size', async () => {
    const plaintextBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const file = new File([plaintextBytes], 'opaque.bin', {
      type: 'application/octet-stream',
    });
    const task = createTask(file);
    const ctx = createCtx();
    const crypto = await mocks.getCryptoClient();

    await processLegacyUpload(task, crypto, ctx);

    expect(task.completedShards).toHaveLength(1);
    const shard = task.completedShards[0]!;
    // Encrypted envelope = 64 (header) + 5 (plaintext) + 16 (AEAD tag) = 85.
    expect(shard.contentLength).toBe(64 + plaintextBytes.byteLength + 16);
    expect(shard.contentLength).not.toBe(file.size);
    expect(shard.envelopeVersion).toBe(3);
    expect(shard.tier).toBe(3);
  });

  it('video frame-extraction failure falls back via legacy path and still records contentLength', async () => {
    mocks.extractVideoFrame.mockRejectedValueOnce(new Error('Rust video container inspection failed'));
    const plaintextBytes = new Uint8Array([10, 11, 12]);
    const file = new File([plaintextBytes], 'tiny.mp4', { type: 'video/mp4' });
    const task = createTask(file);
    const ctx = createCtx();

    await processVideoUpload(task, ctx);

    expect(task.completedShards).toHaveLength(1);
    const shard = task.completedShards[0]!;
    expect(shard.contentLength).toBe(64 + plaintextBytes.byteLength + 16);
    expect(shard.contentLength).not.toBe(file.size);
    expect(shard.envelopeVersion).toBe(3);
    expect(shard.tier).toBe(3);
    // videoMetadata is still set so the manifest is finalized as a Video asset.
    expect(task.videoMetadata?.isVideo).toBe(true);
  });
});
