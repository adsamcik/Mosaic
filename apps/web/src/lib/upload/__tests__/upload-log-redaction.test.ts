/**
 * M7 — Filename redaction in upload-pipeline log lines.
 *
 * Verifies that `task.file.name` (which frequently encodes PII such as
 * Passport.jpg or Paycheck_2024.jpg) does NOT appear anywhere in the log
 * stream of the tiered or video upload pipelines, while the redacted
 * identity (taskId / mimeType / sizeBytes) IS present.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadHandlerContext, UploadTask } from '../types';

// ---------------------------------------------------------------------------
// Hoisted log capture — vi.hoisted runs before vi.mock, so calls are tracked
// from the very first log call by any module under test.
// ---------------------------------------------------------------------------
const captured = vi.hoisted(() => {
  const calls: { method: string; args: unknown[] }[] = [];
  const makeFn = (method: string) =>
    vi.fn((...args: unknown[]) => {
      calls.push({ method, args });
    });
  return {
    calls,
    reset: () => {
      calls.length = 0;
    },
    makeFn,
  };
});

const mocks = vi.hoisted(() => ({
  generateTieredImages: vi.fn(),
  encryptTieredImages: vi.fn(),
  generateThumbnail: vi.fn(),
  shouldStripExifFromOriginals: vi.fn().mockReturnValue(false),
  shouldStoreOriginalsAsAvif: vi.fn().mockReturnValue(false),
  getThumbnailQualityValue: vi.fn().mockReturnValue(0.8),
  stripExifFromBlob: vi.fn(),
  extractVideoFrame: vi.fn(),
  getCryptoClient: vi.fn().mockResolvedValue({
    encryptShardWithEpoch: vi.fn().mockResolvedValue({
      envelopeBytes: new Uint8Array([9, 9, 9]),
      sha256: 'legacy-sha',
    }),
  }),
  deriveTierKeys: vi.fn().mockReturnValue({
    thumbKey: new Uint8Array(32).fill(1),
    previewKey: new Uint8Array(32).fill(2),
    fullKey: new Uint8Array(32).fill(3),
  }),
  encryptShardWithEpoch: vi.fn().mockResolvedValue({
    envelopeBytes: new Uint8Array([7, 7, 7]),
    sha256: 'mock-shard-sha',
  }),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('../../logger', () => ({
  createLogger: () => ({
    debug: captured.makeFn('debug'),
    info: captured.makeFn('info'),
    warn: captured.makeFn('warn'),
    error: captured.makeFn('error'),
    startTimer: () => ({ end: vi.fn(), elapsed: () => 0 }),
    child: () => ({
      debug: captured.makeFn('debug'),
      info: captured.makeFn('info'),
      warn: captured.makeFn('warn'),
      error: captured.makeFn('error'),
    }),
    scope: 'test',
  }),
}));

vi.mock('../../thumbnail-generator', () => ({
  generateTieredImages: (...a: unknown[]) => mocks.generateTieredImages(...a),
  encryptTieredImages: (...a: unknown[]) => mocks.encryptTieredImages(...a),
  generateThumbnail: (...a: unknown[]) => mocks.generateThumbnail(...a),
  isSupportedImageType: () => true,
}));

vi.mock('../../settings-service', () => ({
  shouldStripExifFromOriginals: () => mocks.shouldStripExifFromOriginals(),
  shouldStoreOriginalsAsAvif: () => mocks.shouldStoreOriginalsAsAvif(),
  getThumbnailQualityValue: () => mocks.getThumbnailQualityValue(),
}));

vi.mock('../../exif-stripper', () => ({
  stripExifFromBlob: (...a: unknown[]) => mocks.stripExifFromBlob(...a),
}));

vi.mock('../../video-frame-extractor', () => ({
  extractVideoFrame: (...a: unknown[]) => mocks.extractVideoFrame(...a),
}));

vi.mock('../../crypto-client', () => ({
  getCryptoClient: () => mocks.getCryptoClient(),
}));

vi.mock('@mosaic/crypto', () => ({
  deriveTierKeys: (...a: unknown[]) => mocks.deriveTierKeys(...a),
  encryptShard: (...a: unknown[]) => mocks.encryptShardWithEpoch(...a),
  ShardTier: { THUMB: 1, PREVIEW: 2, ORIGINAL: 3 },
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------
import { processTieredUpload } from '../tiered-upload-handler';
import { processVideoUpload } from '../video-upload-handler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SECRET_FILENAME = 'SECRET-PII-12345.jpg';
const SECRET_VIDEO_FILENAME = 'SECRET-PII-12345.mp4';
const SECRET_TOKEN = 'SECRET-PII-12345';
const TASK_ID = 'task-redaction-001';
const FILE_SIZE = 5000;

function createFile(name: string, type: string, size = FILE_SIZE): File {
  return new File([new ArrayBuffer(size)], name, { type });
}

function createTask(file: File): UploadTask {
  return {
    id: TASK_ID,
    file,
    albumId: 'album-001',
    epochId: 42,
    epochHandleId: 'epoch-handle-42' as never,
    status: 'queued',
    currentAction: 'pending',
    progress: 0,
    completedShards: [],
    retryCount: 0,
    lastAttemptAt: 0,
  };
}

function createCtx(): UploadHandlerContext {
  let shardN = 0;
  return {
    tusUpload: vi.fn().mockImplementation(async () => `shard-${shardN++}`),
    updatePersistedTask: vi.fn().mockResolvedValue(undefined),
    onProgress: vi.fn(),
    onComplete: vi.fn(),
  };
}

/** Recursively search any value (incl. nested objects, arrays, errors) for a
 *  literal substring or numeric value. Skips Uint8Array/ArrayBuffer entries
 *  which are byte payloads, not user-visible strings. */
function deepIncludes(
  value: unknown,
  needle: string | number,
  seen = new WeakSet<object>(),
): boolean {
  const target = typeof needle === 'number' ? String(needle) : needle;
  if (value == null) return false;
  if (typeof value === 'string') return value.includes(target);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value).includes(target);
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return false;
    seen.add(value);
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) return false;
    if (value instanceof Error) {
      return (
        deepIncludes(value.message, needle, seen) ||
        deepIncludes(value.stack ?? '', needle, seen)
      );
    }
    if (Array.isArray(value)) {
      return value.some((v) => deepIncludes(v, needle, seen));
    }
    // Plain object / File / etc.
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (key.includes(target)) return true;
      if (deepIncludes((value as Record<string, unknown>)[key], needle, seen)) {
        return true;
      }
    }
    return false;
  }
  return false;
}

function offendingCalls(needle: string | number): { method: string; args: unknown[] }[] {
  return captured.calls.filter((c) => deepIncludes(c.args, needle));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('M7 — upload pipeline log redaction', () => {
  beforeEach(() => {
    captured.reset();
    vi.clearAllMocks();

    // Default tiered mocks: full happy path
    mocks.generateTieredImages.mockResolvedValue({
      thumbnail: { data: new Uint8Array(10), width: 200, height: 150 },
      preview: { data: new Uint8Array(20), width: 800, height: 600 },
      original: { data: new Uint8Array(30), width: 1920, height: 1080 },
      originalWidth: 1920,
      originalHeight: 1080,
    });
    mocks.getCryptoClient.mockResolvedValue({
      encryptShardWithEpoch: mocks.encryptShardWithEpoch,
    });
    mocks.encryptShardWithEpoch.mockResolvedValue({
      envelopeBytes: new Uint8Array([7, 7, 7]),
      sha256: 'mock-shard-sha',
    });
    mocks.generateThumbnail.mockResolvedValue({
      data: new Uint8Array([4, 5, 6]),
      thumbhash: 'th-base64',
    });
    mocks.shouldStripExifFromOriginals.mockReturnValue(false);

    // Default video mocks
    mocks.extractVideoFrame.mockResolvedValue({
      metadata: { duration: 5, width: 1920, height: 1080, codec: 'h264' },
      thumbnailBlob: new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' }),
      embeddedThumbnail: 'base64-thumb',
      embeddedWidth: 300,
      embeddedHeight: 169,
      thumbhash: 'th-base64',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('processTieredUpload', () => {
    it('does not leak file.name into any log call', async () => {
      const task = createTask(createFile(SECRET_FILENAME, 'image/jpeg'));
      const ctx = createCtx();

      await processTieredUpload(task, ctx);

      expect(captured.calls.length).toBeGreaterThan(0);
      const leaks = offendingCalls(SECRET_TOKEN);
      expect(
        leaks,
        `Filename leaked in log calls: ${JSON.stringify(leaks, null, 2)}`,
      ).toHaveLength(0);
    });

    it('uses the redacted identity shape (taskId + mimeType + sizeBytes)', async () => {
      const task = createTask(createFile(SECRET_FILENAME, 'image/jpeg'));
      const ctx = createCtx();

      await processTieredUpload(task, ctx);

      const hasTaskId = captured.calls.some((c) => deepIncludes(c.args, TASK_ID));
      const hasMime = captured.calls.some((c) => deepIncludes(c.args, 'image/jpeg'));
      const hasSize = captured.calls.some((c) => deepIncludes(c.args, FILE_SIZE));

      expect(hasTaskId, 'expected at least one log call to include task.id').toBe(true);
      expect(hasMime, 'expected at least one log call to include mimeType').toBe(true);
      expect(hasSize, 'expected at least one log call to include sizeBytes').toBe(true);
    });

    it('does not leak file.name in error path either', async () => {
      mocks.encryptShardWithEpoch.mockRejectedValueOnce(new Error('boom'));
      const task = createTask(createFile(SECRET_FILENAME, 'image/jpeg'));
      const ctx = createCtx();

      await expect(processTieredUpload(task, ctx)).rejects.toThrow('boom');

      const leaks = offendingCalls(SECRET_TOKEN);
      expect(leaks).toHaveLength(0);
    });
  });

  describe('processVideoUpload', () => {
    it('does not leak file.name into any log call', async () => {
      const task = createTask(createFile(SECRET_VIDEO_FILENAME, 'video/mp4'));
      const ctx = createCtx();

      await processVideoUpload(task, ctx);

      expect(captured.calls.length).toBeGreaterThan(0);
      const leaks = offendingCalls(SECRET_TOKEN);
      expect(
        leaks,
        `Filename leaked in log calls: ${JSON.stringify(leaks, null, 2)}`,
      ).toHaveLength(0);
    });

    it('uses the redacted identity shape (taskId + mimeType + sizeBytes)', async () => {
      const task = createTask(createFile(SECRET_VIDEO_FILENAME, 'video/mp4'));
      const ctx = createCtx();

      await processVideoUpload(task, ctx);

      const hasTaskId = captured.calls.some((c) => deepIncludes(c.args, TASK_ID));
      const hasMime = captured.calls.some((c) => deepIncludes(c.args, 'video/mp4'));
      const hasSize = captured.calls.some((c) => deepIncludes(c.args, FILE_SIZE));

      expect(hasTaskId, 'expected at least one log call to include task.id').toBe(true);
      expect(hasMime, 'expected at least one log call to include mimeType').toBe(true);
      expect(hasSize, 'expected at least one log call to include sizeBytes').toBe(true);
    });

    it('does not leak file.name when frame extraction fails (fallback path)', async () => {
      mocks.extractVideoFrame.mockRejectedValueOnce(new Error('codec broken'));
      const task = createTask(createFile(SECRET_VIDEO_FILENAME, 'video/mp4'));
      const ctx = createCtx();

      await processVideoUpload(task, ctx);

      const leaks = offendingCalls(SECRET_TOKEN);
      expect(
        leaks,
        `Filename leaked in fallback log: ${JSON.stringify(leaks, null, 2)}`,
      ).toHaveLength(0);
    });

    it('does not leak file.name in error path either', async () => {
      mocks.encryptShardWithEpoch.mockRejectedValueOnce(new Error('encrypt failed'));
      const task = createTask(createFile(SECRET_VIDEO_FILENAME, 'video/mp4'));
      const ctx = createCtx();

      await expect(processVideoUpload(task, ctx)).rejects.toThrow('encrypt failed');

      const leaks = offendingCalls(SECRET_TOKEN);
      expect(leaks).toHaveLength(0);
    });
  });
});
