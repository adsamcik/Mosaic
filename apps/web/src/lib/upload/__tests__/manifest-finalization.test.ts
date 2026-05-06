import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpochHandleId, TieredShardIds } from '../../../workers/types';
import type { EpochKeyBundle } from '../../epoch-key-store';
import type { UploadTask, UploadHandlerContext } from '../types';
import type { UploadEvent } from '../../rust-core/upload-adapter-port';

const mockData = vi.hoisted(() => ({
  initRustWasm: vi.fn(async () => undefined),
  manifestTranscriptBytes: vi.fn(() => ({
    code: 0,
    bytes: new Uint8Array([9, 8, 7, 6]),
    free: vi.fn(),
  })),
  getCryptoClient: vi.fn(),
  generateTieredImages: vi.fn(),
  generateThumbnail: vi.fn(),
  stripExifFromBlob: vi.fn(),
  shouldStripExifFromOriginals: vi.fn().mockReturnValue(false),
  shouldStoreOriginalsAsAvif: vi.fn().mockReturnValue(false),
  getThumbnailQualityValue: vi.fn().mockReturnValue(0.8),
}));

vi.mock('../../../generated/mosaic-wasm/mosaic_wasm.js', () => ({
  default: mockData.initRustWasm,
  manifestTranscriptBytes: mockData.manifestTranscriptBytes,
}));

vi.mock('../../crypto-client', () => ({
  getCryptoClient: () => mockData.getCryptoClient(),
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../thumbnail-generator', () => ({
  generateTieredImages: (...args: unknown[]) => mockData.generateTieredImages(...args),
  generateThumbnail: (...args: unknown[]) => mockData.generateThumbnail(...args),
}));

vi.mock('../../settings-service', () => ({
  shouldStripExifFromOriginals: () => mockData.shouldStripExifFromOriginals(),
  shouldStoreOriginalsAsAvif: () => mockData.shouldStoreOriginalsAsAvif(),
  getThumbnailQualityValue: () => mockData.getThumbnailQualityValue(),
}));

vi.mock('../../exif-stripper', () => ({
  stripExifFromBlob: (...args: unknown[]) => mockData.stripExifFromBlob(...args),
}));

import {
  executeManifestFinalizationEffect,
  finalizeIdempotencyKey,
  finalizeManifestForUpload,
  ManifestFinalizationError,
  MANIFEST_INVALID_SIGNATURE,
  MANIFEST_TRANSCRIPT_MISMATCH,
  type FinalizeManifestEffect,
} from '../../manifest-finalization';
import { processTieredUpload } from '../tiered-upload-handler';

const JOB_ID = '018f0000-0000-7000-8000-000000000101';
const ALBUM_ID = '018f0000-0000-7000-8000-000000000102';
const SHARD_ID = '018f0000-0000-7000-8000-000000000103';
const SIGNATURE = new Uint8Array(64).fill(7);
const SIGNER_PUBKEY = new Uint8Array(32).fill(8);
const SHA256_HEX = '00'.repeat(32);
const SHA256_B64URL = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function finalizeResponse(manifestId = JOB_ID) {
  return {
    protocolVersion: 1,
    manifestId,
    metadataVersion: 12,
    createdAt: '2026-05-06T00:00:00.000Z',
    tieredShards: [
      {
        shardId: SHARD_ID,
        tier: 3,
        shardIndex: 0,
        sha256: SHA256_HEX,
        contentLength: 3,
        envelopeVersion: 3,
      },
    ],
  };
}

function effect(): FinalizeManifestEffect {
  return {
    kind: 'FinalizeManifest',
    effectId: JOB_ID,
    manifestId: JOB_ID,
    protocolVersion: 1,
    albumId: ALBUM_ID,
    assetType: 'Image',
    encryptedMeta: new Uint8Array([1, 2, 3]),
    signature: SIGNATURE,
    signerPubkey: SIGNER_PUBKEY,
    tieredShards: finalizeResponse().tieredShards,
  };
}

function task(): UploadTask {
  return {
    id: JOB_ID,
    file: new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' }),
    albumId: ALBUM_ID,
    epochId: 42,
    epochHandleId: 'epoch-handle-42' as EpochHandleId,
    status: 'queued',
    currentAction: 'pending',
    progress: 0,
    completedShards: [
      {
        index: 0,
        shardId: SHARD_ID,
        sha256: SHA256_B64URL,
        tier: 3,
        contentLength: 3,
        envelopeVersion: 3,
      },
    ],
    retryCount: 0,
    lastAttemptAt: 0,
    originalWidth: 1,
    originalHeight: 1,
  };
}

function epochKey(): EpochKeyBundle {
  return {
    epochId: 42,
    epochHandleId: 'epoch-handle-42' as EpochHandleId,
    signPublicKey: SIGNER_PUBKEY,
    signKeypair: {
      publicKey: SIGNER_PUBKEY,
      secretKey: new Uint8Array(),
    },
  };
}

function adapter() {
  return {
    submit: vi.fn(async (_event: UploadEvent) => undefined),
  };
}

describe('manifest finalization cutover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockData.getCryptoClient.mockResolvedValue({
      encryptManifestWithEpoch: vi.fn(async () => ({
        envelopeBytes: new Uint8Array([1, 2, 3]),
        sha256: SHA256_B64URL,
      })),
      signManifestWithEpoch: vi.fn(async () => SIGNATURE),
      finalizeIdempotencyKey: vi.fn(async (jobId: string) => `mosaic-finalize-${jobId}`),
      encryptShardWithEpochHandle: vi.fn(
        async (_handle: EpochHandleId, _plaintext: Uint8Array, tier: number, shardIndex: number) =>
          new Uint8Array([tier, shardIndex, 99]),
      ),
    });
    mockData.generateThumbnail.mockResolvedValue({ data: new Uint8Array([4]), thumbhash: 'thumbhash' });
    mockData.generateTieredImages.mockResolvedValue({
      thumbnail: { data: new Uint8Array([1]), width: 100, height: 75, tier: 1 },
      preview: { data: new Uint8Array([2]), width: 800, height: 600, tier: 2 },
      original: { data: new Uint8Array([3]), width: 1600, height: 1200, tier: 3 },
      originalWidth: 1600,
      originalHeight: 1200,
    });
  });

  it('posts finalize after shards are uploaded and advances the adapter to Finalized', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(finalizeResponse()));
    const rustAdapter = adapter();

    const result = await executeManifestFinalizationEffect(effect(), {
      jobId: JOB_ID,
      adapter: rustAdapter,
      fetchImpl,
    });

    expect(result).toMatchObject({
      kind: 'ManifestFinalized',
      response: { manifestId: JOB_ID },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/manifests/${JOB_ID}/finalize`,
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: expect.objectContaining({
          'Idempotency-Key': await finalizeIdempotencyKey(JOB_ID),
        }),
      }),
    );
    expect(rustAdapter.submit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'ManifestFinalized',
      effectId: JOB_ID,
      assetId: JOB_ID,
      sinceMetadataVersion: 12n,
    }));
  });

  it('treats 409 idempotency replay as the same finalized adapter state', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(
      finalizeResponse(),
      409,
      { 'Idempotency-Replayed': 'true' },
    ));
    const rustAdapter = adapter();

    await expect(executeManifestFinalizationEffect(effect(), {
      jobId: JOB_ID,
      adapter: rustAdapter,
      fetchImpl,
    })).resolves.toMatchObject({
      kind: 'ManifestFinalized',
      response: { manifestId: JOB_ID, metadataVersion: 12 },
    });

    expect(rustAdapter.submit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'ManifestFinalized',
      assetId: JOB_ID,
    }));
  });

  it('treats 409 without idempotency replay header as already finalized error body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      error: 'manifest_already_finalized',
      detail: 'manifest is already finalized',
      manifestId: JOB_ID,
    }, 409));
    const rustAdapter = adapter();

    await expect(executeManifestFinalizationEffect(effect(), {
      jobId: JOB_ID,
      adapter: rustAdapter,
      fetchImpl,
    })).resolves.toEqual({
      kind: 'AlreadyFinalized',
      manifestId: JOB_ID,
      detail: 'manifest is already finalized',
    });

    expect(rustAdapter.submit).not.toHaveBeenCalled();
  });

  it('maps 400 invalid signature to a non-retryable manifest failure event', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'invalid signature' }, 400));
    const rustAdapter = adapter();

    await expect(executeManifestFinalizationEffect(effect(), {
      jobId: JOB_ID,
      adapter: rustAdapter,
      fetchImpl,
    })).rejects.toMatchObject({
      name: 'ManifestFinalizationError',
      status: 400,
      code: MANIFEST_INVALID_SIGNATURE,
    } satisfies Partial<ManifestFinalizationError>);

    expect(rustAdapter.submit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'ManifestFailed',
      errorCode: MANIFEST_INVALID_SIGNATURE,
      targetPhase: 'Failed',
    }));
  });

  it('maps 422 transcript mismatch to manifest-out-of-sync failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'transcript mismatch' }, 422));
    const rustAdapter = adapter();

    await expect(executeManifestFinalizationEffect(effect(), {
      jobId: JOB_ID,
      adapter: rustAdapter,
      fetchImpl,
    })).rejects.toMatchObject({
      status: 422,
      code: MANIFEST_TRANSCRIPT_MISMATCH,
    } satisfies Partial<ManifestFinalizationError>);

    expect(rustAdapter.submit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'ManifestFailed',
      errorCode: MANIFEST_TRANSCRIPT_MISMATCH,
    }));
  });

  it('runs the Tus upload sequence before the final manifest POST', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(finalizeResponse()));
    const calls: string[] = [];
    const uploadTask = task();
    uploadTask.completedShards = [];
    const tieredShards: TieredShardIds = {
      thumbnail: { shardId: '018f0000-0000-7000-8000-000000000201', sha256: SHA256_B64URL },
      preview: { shardId: '018f0000-0000-7000-8000-000000000202', sha256: SHA256_B64URL },
      original: [{ shardId: '018f0000-0000-7000-8000-000000000203', sha256: SHA256_B64URL }],
    };
    const ctx: UploadHandlerContext = {
      tusUpload: vi.fn(async () => {
        calls.push('tus');
        const next = calls.filter((call) => call === 'tus').length;
        return next === 1
          ? tieredShards.thumbnail.shardId
          : next === 2
            ? tieredShards.preview.shardId
            : tieredShards.original[0]!.shardId;
      }),
      updatePersistedTask: vi.fn(async () => undefined),
      onProgress: vi.fn(),
      onComplete: vi.fn(async (completedTask, shardIds, completedTieredShards) => {
        calls.push('finalize');
        await finalizeManifestForUpload(completedTask, shardIds, epochKey(), completedTieredShards, { fetchImpl });
      }),
    };

    await processTieredUpload(uploadTask, ctx);

    expect(ctx.tusUpload).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['tus', 'tus', 'tus', 'finalize']);
    const fetchCalls = vi.mocked(fetchImpl).mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(String(fetchCalls[0]![1].body)) as {
      tieredShards: Array<{ tier: number; shardIndex: number; contentLength: number; envelopeVersion: number }>;
    };
    expect(body.tieredShards).toEqual([
      expect.objectContaining({ tier: 1, shardIndex: 0, contentLength: 3, envelopeVersion: 3 }),
      expect.objectContaining({ tier: 2, shardIndex: 0, contentLength: 3, envelopeVersion: 3 }),
      expect.objectContaining({ tier: 3, shardIndex: 0, contentLength: 3, envelopeVersion: 3 }),
    ]);
  });

  it('keeps the finalize endpoint isolated to manifest-finalization.ts', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join, relative } = await import('node:path');
    const root = join(process.cwd(), 'src');
    const matches: string[] = [];

    async function walk(directory: string): Promise<void> {
      const entries = await readdir(directory, { withFileTypes: true });
      await Promise.all(entries.map(async (entry) => {
        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'generated') await walk(fullPath);
          return;
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) return;
        const repoPath = relative(process.cwd(), fullPath).replace(/\\/g, '/');
        if (repoPath.includes('__tests__/')) return;
        const contents = await readFile(fullPath, 'utf8');
        if (contents.includes('/finalize')) matches.push(repoPath);
      }));
    }

    await walk(root);

    expect(matches).toEqual(['src/lib/manifest-finalization.ts']);
  });
});
