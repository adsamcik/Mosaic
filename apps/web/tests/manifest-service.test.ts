/**
 * Tests for manifest-service.ts
 * Verifies that PhotoMeta is built correctly for both photos and videos.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PhotoMeta } from '../src/workers/types';
import type { UploadTask } from '../src/lib/upload-queue';

// Capture the PhotoMeta passed to encryptManifestWithEpoch (decoded from JSON
// bytes) and the epochHandleId argument so tests can assert the Slice 4
// handle-based contract.
let capturedPhotoMeta: PhotoMeta | null = null;
let capturedEncryptHandleId: string | null = null;
let capturedSignHandleId: string | null = null;
let capturedSignedBytes: Uint8Array | null = null;

const ENVELOPE_BYTES = new Uint8Array([1, 2, 3]);

const mockEncryptManifestWithEpoch = vi.fn(
  async (epochHandleId: string, plaintext: Uint8Array) => {
    capturedEncryptHandleId = epochHandleId;
    capturedPhotoMeta = JSON.parse(new TextDecoder().decode(plaintext)) as PhotoMeta;
    return { envelopeBytes: ENVELOPE_BYTES, sha256: 'abc' };
  },
);
const mockSignManifestWithEpoch = vi.fn(
  async (epochHandleId: string, manifestBytes: Uint8Array) => {
    capturedSignHandleId = epochHandleId;
    capturedSignedBytes = manifestBytes;
    return new Uint8Array([4, 5, 6]);
  },
);
const mockCreateManifest = vi.fn(async () => {});

vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: vi.fn(() =>
    Promise.resolve({
      encryptManifestWithEpoch: mockEncryptManifestWithEpoch,
      signManifestWithEpoch: mockSignManifestWithEpoch,
    }),
  ),
}));

vi.mock('../src/lib/api', () => ({
  getApi: vi.fn(() => ({
    createManifest: mockCreateManifest,
  })),
  toBase64: vi.fn((arr: Uint8Array) => Buffer.from(arr).toString('base64')),
}));

import { createManifestForUpload } from '../src/lib/manifest-service';

function makeBaseTask(overrides: Partial<UploadTask> = {}): UploadTask {
  return {
    id: 'task-1',
    file: new File(['data'], 'photo.jpg', { type: 'image/jpeg' }),
    albumId: 'album-1',
    epochId: 1,
    readKey: new Uint8Array(32),
    status: 'complete',
    currentAction: 'finalizing',
    progress: 1,
    completedShards: [
      { index: 0, shardId: 'shard-0', sha256: 'hash-0', tier: 1 },
      { index: 1, shardId: 'shard-1', sha256: 'hash-1', tier: 2 },
    ],
    retryCount: 0,
    lastAttemptAt: 0,
    originalWidth: 1920,
    originalHeight: 1080,
    thumbnailBase64: 'base64-photo-thumb',
    thumbWidth: 300,
    thumbHeight: 169,
    thumbhash: 'photo-thumbhash',
    ...overrides,
  } as UploadTask;
}

const SIGN_PUBLIC_KEY = new Uint8Array(32).fill(7);
const epochKey = {
  epochId: 1,
  epochHandleId: 'epoch-handle-test-1',
  signPublicKey: SIGN_PUBLIC_KEY,
  // Slice 3 zero-filled placeholders kept until Slice 4-7 retire all callers.
  epochSeed: new Uint8Array(0),
  signKeypair: {
    publicKey: SIGN_PUBLIC_KEY,
    secretKey: new Uint8Array(0),
  },
};

describe('manifest-service', () => {
  beforeEach(() => {
    capturedPhotoMeta = null;
    capturedEncryptHandleId = null;
    capturedSignHandleId = null;
    capturedSignedBytes = null;
    vi.clearAllMocks();
  });

  describe('Slice 4 handle-based contract', () => {
    it('passes the epoch handle id (not raw seed) to encryptManifestWithEpoch', async () => {
      const task = makeBaseTask();
      await createManifestForUpload(task, ['shard-0', 'shard-1'], epochKey);

      expect(mockEncryptManifestWithEpoch).toHaveBeenCalledTimes(1);
      expect(capturedEncryptHandleId).toBe('epoch-handle-test-1');
      expect(capturedSignHandleId).toBe('epoch-handle-test-1');
    });

    it('signs the encrypted envelope bytes (not the plaintext)', async () => {
      const task = makeBaseTask();
      await createManifestForUpload(task, ['shard-0'], epochKey);

      expect(mockSignManifestWithEpoch).toHaveBeenCalledTimes(1);
      expect(capturedSignedBytes).toEqual(ENVELOPE_BYTES);
    });

    it('publishes the per-epoch sign public key (not a placeholder secret)', async () => {
      const task = makeBaseTask();
      await createManifestForUpload(task, ['shard-0'], epochKey);

      expect(mockCreateManifest).toHaveBeenCalledTimes(1);
      const request = mockCreateManifest.mock.calls[0]?.[0] as {
        signerPubkey: string;
      };
      expect(Buffer.from(request.signerPubkey, 'base64')).toEqual(
        Buffer.from(SIGN_PUBLIC_KEY),
      );
    });
  });

  describe('photo uploads (no videoMetadata)', () => {
    it('builds PhotoMeta with image dimensions and thumbnail', async () => {
      const task = makeBaseTask();
      await createManifestForUpload(task, ['shard-0', 'shard-1'], epochKey);

      expect(capturedPhotoMeta).not.toBeNull();
      const meta = capturedPhotoMeta!;
      expect(meta.width).toBe(1920);
      expect(meta.height).toBe(1080);
      expect(meta.thumbnail).toBe('base64-photo-thumb');
      expect(meta.thumbWidth).toBe(300);
      expect(meta.thumbHeight).toBe(169);
      expect(meta.thumbhash).toBe('photo-thumbhash');
      expect(meta.filename).toBe('photo.jpg');
    });

    it('does not set video fields for photo uploads', async () => {
      const task = makeBaseTask();
      await createManifestForUpload(task, ['shard-0', 'shard-1'], epochKey);

      const meta = capturedPhotoMeta!;
      expect(meta.isVideo).toBeUndefined();
      expect(meta.duration).toBeUndefined();
      expect(meta.videoCodec).toBeUndefined();
    });

    it('uses detected MIME type over file type', async () => {
      const task = makeBaseTask({ detectedMimeType: 'image/heic' });
      await createManifestForUpload(task, ['shard-0'], epochKey);

      expect(capturedPhotoMeta!.mimeType).toBe('image/heic');
    });
  });

  describe('video uploads (with videoMetadata)', () => {
    it('populates video-specific fields from videoMetadata', async () => {
      const task = makeBaseTask({
        file: new File(['videodata'], 'clip.mp4', { type: 'video/mp4' }),
        detectedMimeType: 'video/mp4',
        videoMetadata: {
          isVideo: true,
          duration: 62.5,
          width: 3840,
          height: 2160,
          videoCodec: 'h264',
          thumbnail: 'base64-video-thumb',
          thumbWidth: 300,
          thumbHeight: 169,
          thumbhash: 'video-thumbhash',
        },
      });

      await createManifestForUpload(task, ['shard-0'], epochKey);

      const meta = capturedPhotoMeta!;
      expect(meta.isVideo).toBe(true);
      expect(meta.duration).toBe(62.5);
      expect(meta.videoCodec).toBe('h264');
      expect(meta.mimeType).toBe('video/mp4');
    });

    it('uses video dimensions over image dimensions', async () => {
      const task = makeBaseTask({
        originalWidth: 640,
        originalHeight: 480,
        videoMetadata: {
          isVideo: true,
          duration: 10,
          width: 1920,
          height: 1080,
          thumbnail: 'vid-thumb',
          thumbWidth: 300,
          thumbHeight: 169,
          thumbhash: 'vid-hash',
        },
      });

      await createManifestForUpload(task, ['shard-0'], epochKey);

      const meta = capturedPhotoMeta!;
      expect(meta.width).toBe(1920);
      expect(meta.height).toBe(1080);
    });

    it('uses video thumbnail over photo thumbnail', async () => {
      const task = makeBaseTask({
        thumbnailBase64: 'photo-thumb',
        thumbWidth: 200,
        thumbHeight: 150,
        thumbhash: 'photo-hash',
        videoMetadata: {
          isVideo: true,
          duration: 5,
          width: 1280,
          height: 720,
          thumbnail: 'video-thumb',
          thumbWidth: 300,
          thumbHeight: 169,
          thumbhash: 'video-hash',
        },
      });

      await createManifestForUpload(task, ['shard-0'], epochKey);

      const meta = capturedPhotoMeta!;
      expect(meta.thumbnail).toBe('video-thumb');
      expect(meta.thumbWidth).toBe(300);
      expect(meta.thumbHeight).toBe(169);
      expect(meta.thumbhash).toBe('video-hash');
    });

    it('omits videoCodec when not detected', async () => {
      const task = makeBaseTask({
        videoMetadata: {
          isVideo: true,
          duration: 30,
          width: 1920,
          height: 1080,
          thumbnail: 'thumb',
          thumbWidth: 300,
          thumbHeight: 169,
          thumbhash: 'hash',
        },
      });

      await createManifestForUpload(task, ['shard-0'], epochKey);

      const meta = capturedPhotoMeta!;
      expect(meta.isVideo).toBe(true);
      expect(meta.duration).toBe(30);
      expect(meta.videoCodec).toBeUndefined();
    });

    it('falls back to task dimensions when videoMetadata has no dimensions', async () => {
      const task = makeBaseTask({
        originalWidth: 800,
        originalHeight: 600,
        // No videoMetadata — pure photo path
      });

      await createManifestForUpload(task, ['shard-0'], epochKey);

      const meta = capturedPhotoMeta!;
      expect(meta.width).toBe(800);
      expect(meta.height).toBe(600);
    });

    it('falls back to photo thumbnail when video has no thumbnail', async () => {
      const task = makeBaseTask({
        thumbnailBase64: 'photo-thumb-fallback',
        thumbWidth: 250,
        thumbHeight: 188,
        thumbhash: 'photo-fallback-hash',
        videoMetadata: {
          isVideo: true,
          duration: 15,
          width: 1920,
          height: 1080,
          // No thumbnail fields — should fall back to task-level
        },
      });

      await createManifestForUpload(task, ['shard-0'], epochKey);

      const meta = capturedPhotoMeta!;
      expect(meta.thumbnail).toBe('photo-thumb-fallback');
      expect(meta.thumbWidth).toBe(250);
      expect(meta.thumbHeight).toBe(188);
      expect(meta.thumbhash).toBe('photo-fallback-hash');
    });
  });

  describe('shard handling', () => {
    it('sorts shard hashes by index', async () => {
      const task = makeBaseTask({
        completedShards: [
          { index: 2, shardId: 's2', sha256: 'h2', tier: 3 },
          { index: 0, shardId: 's0', sha256: 'h0', tier: 1 },
          { index: 1, shardId: 's1', sha256: 'h1', tier: 2 },
        ],
      });

      await createManifestForUpload(task, ['s0', 's1', 's2'], epochKey);

      expect(capturedPhotoMeta!.shardHashes).toEqual(['h0', 'h1', 'h2']);
    });
  });
});
