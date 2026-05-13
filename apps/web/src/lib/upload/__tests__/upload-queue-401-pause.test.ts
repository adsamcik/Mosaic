import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpochHandleId } from '../../../workers/types';
import { UploadAuthRequiredError } from '../tus-upload';
import type { PersistedTask, UploadTask } from '../types';

const mocks = vi.hoisted(() => ({
  getCryptoClient: vi.fn(),
  getMimeType: vi.fn(),
  isSupportedVideoType: vi.fn(),
  isSupportedImageType: vi.fn(),
  processLegacyUpload: vi.fn(),
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../crypto-client', () => ({
  getCryptoClient: () => mocks.getCryptoClient(),
}));
vi.mock('../../mime-type-detection', () => ({
  getMimeType: (...args: unknown[]) => mocks.getMimeType(...args),
  isSupportedVideoType: (...args: unknown[]) => mocks.isSupportedVideoType(...args),
}));
vi.mock('../../thumbnail-generator', () => ({
  isSupportedImageType: (...args: unknown[]) => mocks.isSupportedImageType(...args),
}));
vi.mock('../legacy-upload-handler', () => ({
  processLegacyUpload: (...args: unknown[]) => mocks.processLegacyUpload(...args),
}));
vi.mock('../tiered-upload-handler', () => ({
  processTieredUpload: vi.fn(),
}));
vi.mock('../video-upload-handler', () => ({
  processVideoUpload: vi.fn(),
}));

import { UploadQueue } from '../upload-queue';

function createTask(): UploadTask {
  return {
    id: 'task-401',
    file: new File([new Uint8Array([1, 2, 3])], 'photo.bin'),
    albumId: 'album-1',
    epochId: 7,
    epochHandleId: 'epch_401' as EpochHandleId,
    status: 'queued',
    currentAction: 'pending',
    progress: 0,
    completedShards: [],
    retryCount: 2,
    lastAttemptAt: 123,
  };
}

function createPersistence() {
  return {
    updateTask: vi.fn().mockResolvedValue(undefined),
    getPendingTasks: vi.fn().mockResolvedValue([] as PersistedTask[]),
  };
}

describe('UploadQueue auth expiry handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCryptoClient.mockResolvedValue({});
    mocks.getMimeType.mockResolvedValue('application/octet-stream');
    mocks.isSupportedVideoType.mockReturnValue(false);
    mocks.isSupportedImageType.mockReturnValue(false);
  });

  it('pauses a 401 tus failure without consuming retry budget or marking permanent failure', async () => {
    const queue = new UploadQueue();
    const persistence = createPersistence();
    (queue as unknown as { persistence: typeof persistence }).persistence = persistence;
    const onError = vi.fn();
    const onAuthRequired = vi.fn();
    queue.onError = onError;
    queue.onAuthRequired = onAuthRequired;
    const task = createTask();
    mocks.processLegacyUpload.mockRejectedValue(new UploadAuthRequiredError());

    await (queue as unknown as {
      processTask(task: UploadTask): Promise<void>;
    }).processTask(task);

    expect(task.status).toBe('paused_auth_required');
    expect(task.retryCount).toBe(2);
    expect(task.lastAttemptAt).toBe(123);
    expect(onError).not.toHaveBeenCalled();
    expect(onAuthRequired).toHaveBeenCalledWith(task);
    expect(persistence.updateTask).toHaveBeenCalledWith(task.id, {
      status: 'paused_auth_required',
    });
    expect(persistence.updateTask).not.toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ status: 'permanently_failed' }),
    );
  });
});
