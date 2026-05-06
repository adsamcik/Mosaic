import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { UploadTask, VideoUploadMetadata } from '../src/lib/upload-queue';

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted runs before vi.mock, so these are available
// ---------------------------------------------------------------------------
const {
  mockPut,
  mockGet,
  mockDelete,
  mockGetAll,
  mockEncryptShard,
  mockExtractVideoFrame,
  mockGetMimeType,
  mockIsSupportedVideoType,
  mockDeriveTierKeys,
  mockEncryptShardCrypto,
} = vi.hoisted(() => ({
  mockPut: vi.fn().mockResolvedValue(undefined),
  mockGet: vi.fn().mockResolvedValue(undefined),
  mockDelete: vi.fn().mockResolvedValue(undefined),
  mockGetAll: vi.fn().mockResolvedValue([]),
  mockEncryptShard: vi.fn().mockResolvedValue({
    envelopeBytes: new Uint8Array([1, 2, 3]),
    sha256: 'mock-sha256-hash',
  }),
  mockExtractVideoFrame: vi.fn(),
  mockGetMimeType: vi.fn(),
  mockIsSupportedVideoType: vi.fn(),
  mockDeriveTierKeys: vi.fn().mockReturnValue({
    thumbKey: new Uint8Array(32).fill(1),
    previewKey: new Uint8Array(32).fill(2),
    fullKey: new Uint8Array(32).fill(3),
  }),
  mockEncryptShardCrypto: vi.fn().mockResolvedValue({
    envelopeBytes: new Uint8Array([10, 20, 30]),
    sha256: 'encrypted-sha256',
  }),
}));

// ---------------------------------------------------------------------------
// Module mocks — use the hoisted variables
// ---------------------------------------------------------------------------

vi.mock('../src/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('idb', () => ({
  openDB: vi.fn().mockResolvedValue({
    put: mockPut,
    get: mockGet,
    delete: mockDelete,
    getAll: mockGetAll,
    createObjectStore: vi.fn(),
  }),
}));

let tusShardCounter = 0;
const mockTusUpload = vi.fn();
vi.mock('tus-js-client', () => ({
  Upload: vi.fn(),
}));

vi.mock('../src/lib/api', () => ({
  TUS_ENDPOINT: 'http://localhost:5000/api/files',
}));

vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: vi.fn().mockResolvedValue({
    encryptShardWithEpochHandle: mockEncryptShardCrypto,
  }),
}));

vi.mock('../src/lib/video-frame-extractor', () => ({
  extractVideoFrame: (...args: unknown[]) => mockExtractVideoFrame(...args),
}));

vi.mock('../src/lib/mime-type-detection', () => ({
  getMimeType: (...args: unknown[]) => mockGetMimeType(...args),
  isSupportedVideoType: (...args: unknown[]) => mockIsSupportedVideoType(...args),
}));

vi.mock('../src/lib/thumbnail-generator', () => ({
  generateThumbnail: vi.fn(),
  generateTieredImages: vi.fn(),
  encryptTieredImages: vi.fn(),
  isSupportedImageType: vi.fn().mockReturnValue(false),
  getPreferredImageFormat: vi.fn().mockReturnValue('image/jpeg'),
}));

vi.mock('../src/lib/settings-service', () => ({
  getThumbnailQualityValue: vi.fn().mockReturnValue(0.8),
  // H5: tiered-upload-handler now reads these to decide EXIF stripping.
  // Mock to defaults that exercise the real code paths in tests.
  shouldStripExifFromOriginals: vi.fn().mockReturnValue(true),
  shouldStoreOriginalsAsAvif: vi.fn().mockReturnValue(false),
}));

vi.mock('../src/lib/exif-stripper', () => ({
  stripExifFromBlob: vi.fn().mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]),
    stripped: false,
  }),
}));

vi.mock('@mosaic/crypto', () => ({
  deriveTierKeys: (...args: unknown[]) => mockDeriveTierKeys(...args),
  encryptShard: (...args: unknown[]) => mockEncryptShard(...args),
  ShardTier: { THUMB: 1, PREVIEW: 2, ORIGINAL: 3 },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { uploadQueue } from '../src/lib/upload-queue';
import { isSupportedImageType } from '../src/lib/thumbnail-generator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fake File of the given size */
function createFakeFile(
  name: string,
  sizeBytes: number,
  type: string,
): File {
  // Build a buffer of the requested size
  const buffer = new ArrayBuffer(sizeBytes);
  return new File([buffer], name, { type });
}

/** Standard video frame result returned by extractVideoFrame mock */
function createFrameResult(overrides: Record<string, unknown> = {}) {
  return {
    metadata: {
      duration: 62.5,
      width: 1920,
      height: 1080,
      codec: 'h264',
      ...(overrides.metadata as Record<string, unknown> ?? {}),
    },
    thumbnailBlob: new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' }),
    thumbnailWidth: 600,
    thumbnailHeight: 338,
    embeddedThumbnail: 'base64-embedded-thumb',
    embeddedWidth: 300,
    embeddedHeight: 169,
    thumbhash: 'dGh1bWJoYXNo',
    ...overrides,
  };
}

/** Create a minimal UploadTask for testing */
function createTask(overrides: Partial<UploadTask> = {}): UploadTask {
  const file = overrides.file ?? createFakeFile('test.mp4', 1024, 'video/mp4');
  return {
    id: 'task-001',
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
    ...overrides,
  };
}

// We need to access private methods for testing. Use prototype access.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const queue = uploadQueue as any;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UploadQueue — Video Upload Pipeline', () => {
  let progressEvents: UploadTask[];

  beforeEach(async () => {
    vi.clearAllMocks();
    tusShardCounter = 0;
    progressEvents = [];

    // Spy on the private tusUpload method to bypass tus-js-client entirely
    mockTusUpload.mockImplementation(() => {
      const shardId = `shard-${String(tusShardCounter++).padStart(3, '0')}`;
      return Promise.resolve(shardId);
    });
    vi.spyOn(queue, 'tusUpload' as keyof typeof queue).mockImplementation(mockTusUpload);

    // Reset callbacks
    uploadQueue.onProgress = (task: UploadTask) => {
      progressEvents.push({ ...task });
    };
    uploadQueue.onComplete = vi.fn();
    uploadQueue.onError = vi.fn();

    // Init the queue (mocked IndexedDB)
    await uploadQueue.init();
  });

  afterEach(() => {
    delete uploadQueue.onProgress;
    delete uploadQueue.onComplete;
    delete uploadQueue.onError;
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Routing tests
  // =========================================================================

  describe('File type routing', () => {
    it('routes video files to processVideoUpload', async () => {
      mockGetMimeType.mockResolvedValue('video/mp4');
      mockIsSupportedVideoType.mockReturnValue(true);
      mockExtractVideoFrame.mockResolvedValue(createFrameResult());

      const task = createTask();
      // Call processTask via the private method
      await queue.processTask(task);

      expect(mockIsSupportedVideoType).toHaveBeenCalledWith('video/mp4');
      expect(mockExtractVideoFrame).toHaveBeenCalledWith(task.file);
    });

    it('routes image files to processTieredUpload (not video path)', async () => {
      mockGetMimeType.mockResolvedValue('image/jpeg');
      mockIsSupportedVideoType.mockReturnValue(false);
      (isSupportedImageType as Mock).mockReturnValue(true);

      // Mock the tiered upload dependencies
      const { generateTieredImages, encryptTieredImages } = await import(
        '../src/lib/thumbnail-generator'
      );
      (generateTieredImages as Mock).mockResolvedValue({
        thumbnail: { data: new Uint8Array(10), width: 200, height: 150 },
        preview: { data: new Uint8Array(20), width: 800, height: 600 },
        original: { data: new Uint8Array(30), width: 1920, height: 1080 },
        thumbhash: 'abc123',
        embeddedThumbnail: 'base64data',
        embeddedWidth: 300,
        embeddedHeight: 225,
      });
      (encryptTieredImages as Mock).mockResolvedValue({
        thumbnail: { ciphertext: new Uint8Array(10), sha256: 'sha-t' },
        preview: { ciphertext: new Uint8Array(20), sha256: 'sha-p' },
        original: { ciphertext: new Uint8Array(30), sha256: 'sha-o' },
      });

      const task = createTask({
        file: createFakeFile('photo.jpg', 5000, 'image/jpeg'),
      });
      await queue.processTask(task);

      // extractVideoFrame should NOT have been called
      expect(mockExtractVideoFrame).not.toHaveBeenCalled();
      // Image-specific functions SHOULD have been called
      expect(generateTieredImages).toHaveBeenCalled();
    });

    it('waits for async image completion before resolving the upload task', async () => {
      mockGetMimeType.mockResolvedValue('image/png');
      mockIsSupportedVideoType.mockReturnValue(false);
      (isSupportedImageType as Mock).mockReturnValue(true);

      const { generateTieredImages, encryptTieredImages } = await import(
        '../src/lib/thumbnail-generator'
      );
      (generateTieredImages as Mock).mockResolvedValue({
        thumbnail: { data: new Uint8Array(10), width: 200, height: 150 },
        preview: { data: new Uint8Array(20), width: 800, height: 600 },
        original: { data: new Uint8Array(30), width: 1920, height: 1080 },
        originalWidth: 1920,
        originalHeight: 1080,
      });
      (encryptTieredImages as Mock).mockResolvedValue({
        originalWidth: 1920,
        originalHeight: 1080,
        thumbnail: {
          width: 200,
          height: 150,
          encrypted: { ciphertext: new Uint8Array([1]), sha256: 'sha-t' },
        },
        preview: {
          width: 800,
          height: 600,
          encrypted: { ciphertext: new Uint8Array([2]), sha256: 'sha-p' },
        },
        original: {
          encrypted: { ciphertext: new Uint8Array([3]), sha256: 'sha-o' },
        },
      });

      let releaseCompletion!: () => void;
      let completionStarted = false;
      let processResolved = false;
      uploadQueue.onComplete = vi.fn(async () => {
        completionStarted = true;
        await new Promise<void>((resolve) => {
          releaseCompletion = resolve;
        });
      });

      const task = createTask({
        file: createFakeFile('photo.png', 5000, 'image/png'),
      });
      const processing = queue.processTask(task).then(() => {
        processResolved = true;
      });

      await vi.waitFor(() => expect(completionStarted).toBe(true));
      await Promise.resolve();
      expect(processResolved).toBe(false);

      releaseCompletion();
      await processing;
      expect(processResolved).toBe(true);
    });

    it('routes unsupported files to processLegacyUpload', async () => {
      mockGetMimeType.mockResolvedValue('application/pdf');
      mockIsSupportedVideoType.mockReturnValue(false);
      (isSupportedImageType as Mock).mockReturnValue(false);

      const task = createTask({
        file: createFakeFile('doc.pdf', 1024, 'application/pdf'),
      });
      await queue.processTask(task);

      // Neither video nor image-specific functions should be called
      expect(mockExtractVideoFrame).not.toHaveBeenCalled();
      // Legacy uses crypto-client handle encryption directly.
      expect(mockEncryptShardCrypto).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Frame extraction fallback
  // =========================================================================

  describe('Frame extraction fallback', () => {
    beforeEach(() => {
      mockGetMimeType.mockResolvedValue('video/mp4');
      mockIsSupportedVideoType.mockReturnValue(true);
    });

    it('falls back to legacy upload when frame extraction fails', async () => {
      mockExtractVideoFrame.mockRejectedValue(new Error('Codec not supported'));

      const task = createTask();
      await queue.processTask(task);

      // Should have fallen back to legacy upload path (uses crypto-client)
      expect(mockEncryptShardCrypto).toHaveBeenCalled();
      // The fallback still preserves video identity so manifest/UI render it as video.
      expect(task.videoMetadata).toEqual({
        isVideo: true,
        duration: 0,
        width: 0,
        height: 0,
      });
    });

    it('does not call encryptShard from @mosaic/crypto on fallback', async () => {
      mockExtractVideoFrame.mockRejectedValue(new Error('Timeout'));

      const task = createTask();
      await queue.processTask(task);

      // @mosaic/crypto encryptShard should NOT be called (that's the video path)
      expect(mockEncryptShard).not.toHaveBeenCalled();
      // crypto-client handle encryption SHOULD be called (legacy path)
      expect(mockEncryptShardCrypto).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Video metadata population
  // =========================================================================

  describe('Video metadata population', () => {
    beforeEach(() => {
      mockGetMimeType.mockResolvedValue('video/mp4');
      mockIsSupportedVideoType.mockReturnValue(true);
    });

    it('populates task.videoMetadata with frame extraction results', async () => {
      mockExtractVideoFrame.mockResolvedValue(createFrameResult());

      const task = createTask();
      await queue.processTask(task);

      expect(task.videoMetadata).toBeDefined();
      expect(task.videoMetadata!.isVideo).toBe(true);
      expect(task.videoMetadata!.duration).toBe(62.5);
      expect(task.videoMetadata!.width).toBe(1920);
      expect(task.videoMetadata!.height).toBe(1080);
    });

    it('sets isVideo=true on videoMetadata', async () => {
      mockExtractVideoFrame.mockResolvedValue(createFrameResult());

      const task = createTask();
      await queue.processTask(task);

      expect(task.videoMetadata!.isVideo).toBe(true);
    });

    it('copies duration and dimensions from frame metadata', async () => {
      mockExtractVideoFrame.mockResolvedValue(
        createFrameResult({
          metadata: { duration: 120.3, width: 3840, height: 2160, codec: 'vp9' },
        }),
      );

      const task = createTask();
      await queue.processTask(task);

      const meta = task.videoMetadata!;
      expect(meta.duration).toBe(120.3);
      expect(meta.width).toBe(3840);
      expect(meta.height).toBe(2160);
    });

    it('sets videoCodec when codec is detected', async () => {
      mockExtractVideoFrame.mockResolvedValue(
        createFrameResult({
          metadata: { duration: 10, width: 640, height: 480, codec: 'h264' },
        }),
      );

      const task = createTask();
      await queue.processTask(task);

      expect(task.videoMetadata!.videoCodec).toBe('h264');
    });

    it('omits videoCodec when codec is undefined', async () => {
      mockExtractVideoFrame.mockResolvedValue(
        createFrameResult({
          metadata: { duration: 10, width: 640, height: 480 },
        }),
      );

      const task = createTask();
      await queue.processTask(task);

      expect(task.videoMetadata!.videoCodec).toBeUndefined();
    });

    it('copies embedded thumbnail data to top-level task fields', async () => {
      mockExtractVideoFrame.mockResolvedValue(createFrameResult());

      const task = createTask();
      await queue.processTask(task);

      expect(task.thumbnailBase64).toBe('base64-embedded-thumb');
      expect(task.thumbWidth).toBe(300);
      expect(task.thumbHeight).toBe(169);
      expect(task.originalWidth).toBe(1920);
      expect(task.originalHeight).toBe(1080);
      expect(task.thumbhash).toBe('dGh1bWJoYXNo');
    });

    it('sets thumbnail and thumbhash from frame result on videoMetadata', async () => {
      mockExtractVideoFrame.mockResolvedValue(createFrameResult());

      const task = createTask();
      await queue.processTask(task);

      expect(task.videoMetadata!.thumbnail).toBe('base64-embedded-thumb');
      expect(task.videoMetadata!.thumbWidth).toBe(300);
      expect(task.videoMetadata!.thumbHeight).toBe(169);
      expect(task.videoMetadata!.thumbhash).toBe('dGh1bWJoYXNo');
    });
  });

  // =========================================================================
  // Progress reporting
  // =========================================================================

  describe('Progress reporting', () => {
    beforeEach(() => {
      mockGetMimeType.mockResolvedValue('video/mp4');
      mockIsSupportedVideoType.mockReturnValue(true);
    });

    it('reports converting progress during frame extraction (0-10%)', async () => {
      mockExtractVideoFrame.mockResolvedValue(createFrameResult());

      const task = createTask();
      await queue.processTask(task);

      // First event should be converting at 0%
      const convertingEvents = progressEvents.filter(
        (e) => e.currentAction === 'converting',
      );
      expect(convertingEvents.length).toBeGreaterThanOrEqual(1);
      expect(convertingEvents[0]!.progress).toBe(0);
    });

    it('reaches 10% after frame extraction completes', async () => {
      mockExtractVideoFrame.mockResolvedValue(createFrameResult());

      const task = createTask();
      await queue.processTask(task);

      // Should have a progress event at exactly 0.1 (10%)
      const tenPctEvents = progressEvents.filter(
        (e) => Math.abs(e.progress - 0.1) < 0.001,
      );
      expect(tenPctEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('reports encrypting/uploading for thumbnail (10-20%)', async () => {
      mockExtractVideoFrame.mockResolvedValue(createFrameResult());

      const task = createTask();
      await queue.processTask(task);

      // Should have encrypting events around 10%
      const encryptEvents = progressEvents.filter(
        (e) => e.currentAction === 'encrypting' && e.progress >= 0.1 && e.progress < 0.2,
      );
      expect(encryptEvents.length).toBeGreaterThanOrEqual(1);

      // Should reach 20% after thumbnail upload
      const twentyPctEvents = progressEvents.filter(
        (e) => Math.abs(e.progress - 0.2) < 0.001,
      );
      expect(twentyPctEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('reports uploading progress for chunks (20-95%)', async () => {
      // 15MB file = 3 chunks of 6MB
      mockExtractVideoFrame.mockResolvedValue(createFrameResult());
      const bigFile = createFakeFile('big.mp4', 15 * 1024 * 1024, 'video/mp4');

      const task = createTask({ file: bigFile });
      await queue.processTask(task);

      // Chunk progress should be between 0.2 and 0.95
      const chunkProgress = progressEvents
        .filter((e) => e.progress > 0.2 && e.progress <= 0.95)
        .map((e) => e.progress);
      expect(chunkProgress.length).toBeGreaterThanOrEqual(3);

      // Verify progression is monotonically increasing
      for (let i = 1; i < chunkProgress.length; i++) {
        expect(chunkProgress[i]).toBeGreaterThanOrEqual(chunkProgress[i - 1]!);
      }
    });

    it('reports finalizing progress (95-100%)', async () => {
      mockExtractVideoFrame.mockResolvedValue(createFrameResult());

      const task = createTask();
      await queue.processTask(task);

      const finalizingEvents = progressEvents.filter(
        (e) => e.currentAction === 'finalizing',
      );
      expect(finalizingEvents.length).toBeGreaterThanOrEqual(1);
      expect(finalizingEvents[0]!.progress).toBeCloseTo(0.95, 2);

      // Final progress should be 1.0
      expect(task.progress).toBe(1);
    });
  });

  // =========================================================================
  // Chunk handling
  // =========================================================================

  describe('Chunk handling', () => {
    const CHUNK_SIZE = 6 * 1024 * 1024; // 6MB

    beforeEach(() => {
      mockGetMimeType.mockResolvedValue('video/mp4');
      mockIsSupportedVideoType.mockReturnValue(true);
      mockExtractVideoFrame.mockResolvedValue(createFrameResult());
    });

    it('splits video into correct number of 6MB chunks', async () => {
      // 15MB = 3 chunks (6MB + 6MB + 3MB)
      const fileSize = 15 * 1024 * 1024;
      const expectedChunks = Math.ceil(fileSize / CHUNK_SIZE);
      const bigFile = createFakeFile('big.mp4', fileSize, 'video/mp4');

      const task = createTask({ file: bigFile });
      await queue.processTask(task);

      // encryptShard should be called once for thumbnail + once per chunk
      // Calls: 1 thumbnail + 3 original chunks = 4 total
      expect(mockEncryptShardCrypto).toHaveBeenCalledTimes(1 + expectedChunks);

      // Verify original chunk shards (tier 3)
      const originalShards = task.completedShards.filter((s) => s.tier === 3);
      expect(originalShards).toHaveLength(expectedChunks);
    });

    it('handles single-chunk video (< 6MB)', async () => {
      const smallFile = createFakeFile('small.mp4', 2 * 1024 * 1024, 'video/mp4');

      const task = createTask({ file: smallFile });
      await queue.processTask(task);

      // 1 thumbnail + 1 original chunk = 2 encryptShard calls
      expect(mockEncryptShardCrypto).toHaveBeenCalledTimes(2);

      const originalShards = task.completedShards.filter((s) => s.tier === 3);
      expect(originalShards).toHaveLength(1);
    });

    it('encrypts thumbnail as Tier 1 shard', async () => {
      mockExtractVideoFrame.mockResolvedValue(createFrameResult());

      const task = createTask();
      await queue.processTask(task);

      // First encryptShardWithEpochHandle call should use the epoch handle and tier 1.
      expect(mockEncryptShardCrypto).toHaveBeenCalledWith(
        'epoch-handle-42',
        expect.any(Uint8Array),
        1,  // ShardTier.THUMB
        0,  // shard index
      );

      // Should have a tier-1 shard in completedShards
      const thumbShard = task.completedShards.find((s) => s.tier === 1);
      expect(thumbShard).toBeDefined();
      expect(thumbShard!.index).toBe(0);
    });

    it('encrypts original video chunks as Tier 3 shards', async () => {
      const file = createFakeFile('vid.mp4', 7 * 1024 * 1024, 'video/mp4');
      const task = createTask({ file });
      await queue.processTask(task);

      // Should have 2 original chunks (7MB → 6MB + 1MB)
      const origCalls = mockEncryptShardCrypto.mock.calls.filter(
        (call: unknown[]) => call[2] === 3, // ShardTier.ORIGINAL
      );
      expect(origCalls).toHaveLength(2);

      // Each should use the epoch handle.
      for (const call of origCalls) {
        expect(call[0]).toBe('epoch-handle-42');
      }
    });
  });

  // =========================================================================
  // Tiered shard references (manifest)
  // =========================================================================

  describe('Tiered shard references', () => {
    beforeEach(() => {
      mockGetMimeType.mockResolvedValue('video/mp4');
      mockIsSupportedVideoType.mockReturnValue(true);
      mockExtractVideoFrame.mockResolvedValue(createFrameResult());
    });

    it('builds tieredShards with thumbnail, preview (=thumbnail), and original chunks', async () => {
      // 13MB → 3 chunks
      const file = createFakeFile('vid.mp4', 13 * 1024 * 1024, 'video/mp4');
      const task = createTask({ file });
      await queue.processTask(task);

      expect(task.tieredShards).toBeDefined();
      const ts = task.tieredShards!;

      // Thumbnail and preview should be the same shard (Phase 1 behavior)
      expect(ts.thumbnail.shardId).toBe(ts.preview.shardId);
      expect(ts.thumbnail.sha256).toBe(ts.preview.sha256);

      // Original should have correct number of entries
      expect(ts.original).toHaveLength(3);
    });

    it('calls onComplete with allShardIds and tieredShards', async () => {
      const task = createTask();
      await queue.processTask(task);

      expect(uploadQueue.onComplete).toHaveBeenCalledTimes(1);
      const [completedTask, allShardIds, tieredShards] = (
        uploadQueue.onComplete as Mock
      ).mock.calls[0];

      // allShardIds = [thumbShardId, ...originalShardIds]
      expect(allShardIds.length).toBeGreaterThanOrEqual(2); // at least thumb + 1 chunk

      // tieredShards should be defined
      expect(tieredShards).toBeDefined();
      expect(tieredShards.thumbnail).toBeDefined();
      expect(tieredShards.preview).toBeDefined();
      expect(tieredShards.original).toBeDefined();
    });

    it('marks task as complete with progress 1', async () => {
      const task = createTask();
      await queue.processTask(task);

      expect(task.status).toBe('complete');
      expect(task.progress).toBe(1);
    });
  });

  // =========================================================================
  // Persistence
  // =========================================================================

  describe('Persistence during video upload', () => {
    beforeEach(() => {
      mockGetMimeType.mockResolvedValue('video/mp4');
      mockIsSupportedVideoType.mockReturnValue(true);
      mockExtractVideoFrame.mockResolvedValue(createFrameResult());
      // Return a valid persisted task on get so updatePersistedTask works
      mockGet.mockImplementation((_store: string, id: string) =>
        Promise.resolve({
          id,
          albumId: 'album-001',
          fileName: 'test.mp4',
          fileSize: 1024,
          epochId: 42,
          totalChunks: 1,
          completedShards: [],
          status: 'uploading',
          retryCount: 0,
          lastAttemptAt: 0,
        }),
      );
    });

    it('persists video metadata after completion', async () => {
      const task = createTask();
      await queue.processTask(task);

      // Find a put call that includes videoMetadata
      const putCalls = mockPut.mock.calls;
      const hasVideoMeta = putCalls.some(
        (call: unknown[]) => {
          const arg = call[1] as Record<string, unknown> | undefined;
          return arg?.videoMetadata !== undefined;
        },
      );
      expect(hasVideoMeta).toBe(true);
    });

    it('persists completedShards after each chunk upload', async () => {
      const file = createFakeFile('vid.mp4', 13 * 1024 * 1024, 'video/mp4');
      const task = createTask({ file });
      await queue.processTask(task);

      // Multiple persistence calls for chunk progress
      const putCallsWithShards = mockPut.mock.calls.filter(
        (call: unknown[]) => {
          const arg = call[1] as Record<string, unknown> | undefined;
          return arg?.completedShards !== undefined;
        },
      );
      // At least one per chunk (3 chunks for 13MB)
      expect(putCallsWithShards.length).toBeGreaterThanOrEqual(3);
    });
  });

  // =========================================================================
  // Error propagation
  // =========================================================================

  describe('Error propagation in video upload', () => {
    beforeEach(() => {
      mockGetMimeType.mockResolvedValue('video/mp4');
      mockIsSupportedVideoType.mockReturnValue(true);
      mockExtractVideoFrame.mockResolvedValue(createFrameResult());
    });

    it('sets error status when encryptShard fails during video upload', async () => {
      mockEncryptShardCrypto.mockRejectedValueOnce(new Error('Encryption failed'));

      const task = createTask();
      await queue.processTask(task);

      // processTask catches errors and sets error status (does not rethrow)
      expect(task.status).toBe('error');
      expect(task.retryCount).toBe(1);
    });
  });
});

// =============================================================================
// VideoUploadMetadata type tests (compile-time checks)
// =============================================================================

describe('VideoUploadMetadata type shape', () => {
  it('has required fields', () => {
    const meta: VideoUploadMetadata = {
      isVideo: true,
      duration: 60,
      width: 1920,
      height: 1080,
    };
    expect(meta.isVideo).toBe(true);
    expect(meta.duration).toBe(60);
    expect(meta.width).toBe(1920);
    expect(meta.height).toBe(1080);
  });

  it('supports optional videoCodec', () => {
    const meta: VideoUploadMetadata = {
      isVideo: true,
      duration: 10,
      width: 640,
      height: 480,
      videoCodec: 'vp9',
    };
    expect(meta.videoCodec).toBe('vp9');
  });

  it('supports optional thumbnail fields', () => {
    const meta: VideoUploadMetadata = {
      isVideo: true,
      duration: 10,
      width: 640,
      height: 480,
      thumbnail: 'base64data',
      thumbWidth: 300,
      thumbHeight: 169,
      thumbhash: 'hash123',
    };
    expect(meta.thumbnail).toBe('base64data');
    expect(meta.thumbWidth).toBe(300);
    expect(meta.thumbHeight).toBe(169);
    expect(meta.thumbhash).toBe('hash123');
  });
});
