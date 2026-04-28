import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpochKeyBundle } from '../src/lib/epoch-key-store';
import type { UploadTask } from '../src/lib/upload-queue';
import type { TieredShardIds } from '../src/workers/types';

interface ContractShard {
  tier: number;
  index: number;
  shardId: string;
  sha256: string;
}

interface ContractFixture {
  androidHandoff: {
    uploadJobId: string;
    albumId: string;
    assetId: string;
    queueRecordId: string;
    stagedSource: string;
    byteCount: number;
    stage: string;
  };
  clientCore: {
    epochId: number;
    completedShards: ContractShard[];
    manifestReceipt: {
      manifestId: string;
      version: number;
    };
  };
  backendManifestRequest: {
    albumId: string;
    encryptedMetaBase64: string;
    signature: string;
    signerPubkey: string;
    shardIds: string[];
    tieredShards: Array<{ shardId: string; tier: number }>;
  };
  webShard: {
    id: string;
    bytesBase64: string;
    sha256: string;
  };
  forbiddenPlaintextTerms: string[];
}

const mocks = vi.hoisted(() => ({
  createManifest: vi.fn(),
  encryptManifest: vi.fn(),
  signManifest: vi.fn(),
}));

vi.mock('../src/lib/api', () => {
  class MockApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly statusText: string,
    ) {
      super(`API Error ${status}: ${statusText}`);
      this.name = 'ApiError';
    }
  }

  return {
    ApiError: MockApiError,
    getApi: vi.fn(() => ({
      createManifest: mocks.createManifest,
    })),
    toBase64: vi.fn((bytes: Uint8Array) =>
      Buffer.from(bytes).toString('base64'),
    ),
  };
});

vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: vi.fn(() =>
    Promise.resolve({
      encryptManifest: mocks.encryptManifest,
      signManifest: mocks.signManifest,
    }),
  ),
}));

import { createManifestForUpload } from '../src/lib/manifest-service';
import { downloadShard } from '../src/lib/shard-service';

const originalFetch = globalThis.fetch;

function loadFixture(): ContractFixture {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const fixturePath = resolve(
    testDir,
    '..',
    '..',
    '..',
    'tests',
    'contracts',
    'android-manual-upload-cross-client.json',
  );
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as ContractFixture;
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function fixtureTask(fixture: ContractFixture): UploadTask {
  return {
    id: fixture.androidHandoff.assetId,
    file: new File(['opaque local bytes'], 'opaque-local-asset.bin', {
      type: 'application/octet-stream',
    }),
    albumId: fixture.androidHandoff.albumId,
    epochId: fixture.clientCore.epochId,
    readKey: new Uint8Array(32),
    status: 'complete',
    currentAction: 'finalizing',
    progress: 1,
    completedShards: fixture.clientCore.completedShards.map((shard) => ({
      index: shard.index,
      shardId: shard.shardId,
      sha256: shard.sha256,
      tier: shard.tier,
    })),
    retryCount: 0,
    lastAttemptAt: 0,
  } as UploadTask;
}

function fixtureTieredShards(fixture: ContractFixture): TieredShardIds {
  const thumbnail = fixture.clientCore.completedShards.find(
    (shard) => shard.tier === 1,
  );
  const preview = fixture.clientCore.completedShards.find(
    (shard) => shard.tier === 2,
  );
  const original = fixture.clientCore.completedShards.filter(
    (shard) => shard.tier === 3,
  );

  if (!thumbnail || !preview || original.length === 0) {
    throw new Error('cross-client fixture must include thumbnail, preview, and original shards');
  }

  return {
    thumbnail: { shardId: thumbnail.shardId, sha256: thumbnail.sha256 },
    preview: { shardId: preview.shardId, sha256: preview.sha256 },
    original: original.map((shard) => ({
      shardId: shard.shardId,
      sha256: shard.sha256,
    })),
  };
}

function fixtureEpochKey(fixture: ContractFixture): EpochKeyBundle {
  return {
    epochId: fixture.clientCore.epochId,
    epochSeed: new Uint8Array(32),
    signKeypair: {
      publicKey: fromBase64(fixture.backendManifestRequest.signerPubkey),
      secretKey: new Uint8Array(64),
    },
  };
}

describe('Android manual upload cross-client contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('finalizes the Android/client-core fixture as the backend opaque manifest request', async () => {
    const fixture = loadFixture();
    const encryptedMeta = fromBase64(
      fixture.backendManifestRequest.encryptedMetaBase64,
    );
    const signature = fromBase64(fixture.backendManifestRequest.signature);
    mocks.encryptManifest.mockResolvedValue({
      ciphertext: encryptedMeta,
      sha256: 'encrypted-manifest-digest-is-client-local',
    });
    mocks.signManifest.mockResolvedValue(signature);
    mocks.createManifest.mockResolvedValue({
      id: fixture.clientCore.manifestReceipt.manifestId,
      version: fixture.clientCore.manifestReceipt.version,
    });

    await createManifestForUpload(
      fixtureTask(fixture),
      fixture.backendManifestRequest.shardIds,
      fixtureEpochKey(fixture),
      fixtureTieredShards(fixture),
    );

    expect(mocks.encryptManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: fixture.androidHandoff.assetId,
        albumId: fixture.androidHandoff.albumId,
        epochId: fixture.clientCore.epochId,
        shardIds: fixture.backendManifestRequest.shardIds,
        thumbnailShardId: fixture.backendManifestRequest.tieredShards[0].shardId,
        previewShardId: fixture.backendManifestRequest.tieredShards[1].shardId,
        originalShardIds: [fixture.backendManifestRequest.tieredShards[2].shardId],
      }),
      expect.any(Uint8Array),
      fixture.clientCore.epochId,
    );
    expect(mocks.signManifest).toHaveBeenCalledWith(
      encryptedMeta,
      expect.any(Uint8Array),
    );
    expect(mocks.createManifest).toHaveBeenCalledWith({
      albumId: fixture.backendManifestRequest.albumId,
      encryptedMeta: fixture.backendManifestRequest.encryptedMetaBase64,
      signature: fixture.backendManifestRequest.signature,
      signerPubkey: fixture.backendManifestRequest.signerPubkey,
      shardIds: fixture.backendManifestRequest.shardIds,
      tieredShards: fixture.backendManifestRequest.tieredShards,
    });

    const backendRequest = mocks.createManifest.mock.calls[0][0];
    expect(Object.keys(backendRequest).sort()).toEqual([
      'albumId',
      'encryptedMeta',
      'shardIds',
      'signature',
      'signerPubkey',
      'tieredShards',
    ]);
    const serializedRequest = JSON.stringify(backendRequest);
    for (const forbidden of fixture.forbiddenPlaintextTerms) {
      expect(serializedRequest).not.toContain(forbidden);
    }
  });

  it('downloads the fixture shard as opaque bytes without decoding plaintext metadata', async () => {
    const fixture = loadFixture();
    const shardBytes = fromBase64(fixture.webShard.bytesBase64);
    const progress = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: vi.fn((name: string) =>
          name.toLowerCase() === 'content-length'
            ? String(shardBytes.byteLength)
            : null,
        ),
      },
      body: null,
      arrayBuffer: vi.fn().mockResolvedValue(asArrayBuffer(shardBytes)),
    });
    globalThis.fetch = fetchMock;

    const downloaded = await downloadShard(fixture.webShard.id, progress);

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/shards/${fixture.webShard.id}`,
      { credentials: 'same-origin' },
    );
    expect(downloaded).toEqual(shardBytes);
    expect(progress).toHaveBeenCalledWith(
      shardBytes.byteLength,
      shardBytes.byteLength,
    );
    const renderedBytes = Buffer.from(downloaded).toString('utf8');
    for (const forbidden of fixture.forbiddenPlaintextTerms) {
      expect(renderedBytes).not.toContain(forbidden);
    }
  });
});
