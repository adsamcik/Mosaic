import { createHash } from 'node:crypto';
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

interface ContractWebShard {
  id: string;
  bytesBase64: string;
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
  webShards: ContractWebShard[];
  forbiddenPlaintextTerms: string[];
}

const mocks = vi.hoisted(() => ({
  createManifest: vi.fn(),
  encryptManifestWithEpoch: vi.fn(),
  signManifestWithEpoch: vi.fn(),
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
      encryptManifestWithEpoch: mocks.encryptManifestWithEpoch,
      signManifestWithEpoch: mocks.signManifestWithEpoch,
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

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function verifiedShardBytes(shard: ContractWebShard): Uint8Array {
  const bytes = fromBase64(shard.bytesBase64);
  expect(
    sha256Hex(bytes),
    `fixture bytes for shard ${shard.id} must match declared sha256`,
  ).toBe(shard.sha256);
  return bytes;
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
  const publicKey = fromBase64(fixture.backendManifestRequest.signerPubkey);
  return {
    epochId: fixture.clientCore.epochId,
    epochHandleId: `test-epoch-handle-${fixture.clientCore.epochId}`,
    signPublicKey: publicKey,
    epochSeed: new Uint8Array(0),
    signKeypair: {
      publicKey,
      secretKey: new Uint8Array(0),
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
    mocks.encryptManifestWithEpoch.mockResolvedValue({
      envelopeBytes: encryptedMeta,
      sha256: 'encrypted-manifest-digest-is-client-local',
    });
    mocks.signManifestWithEpoch.mockResolvedValue(signature);
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

    // Slice 4 — manifest sign/verify routes through the Rust epoch handle.
    // The mock only sees the opaque epoch handle id (string) and the
    // JSON-encoded plaintext; the per-epoch sign secret never crosses
    // Comlink. The handle id and JSON byte payload are what we anchor on.
    expect(mocks.encryptManifestWithEpoch).toHaveBeenCalledTimes(1);
    const [encryptHandleArg, encryptPlaintextArg] =
      mocks.encryptManifestWithEpoch.mock.calls[0];
    expect(encryptHandleArg).toBe(
      `test-epoch-handle-${fixture.clientCore.epochId}`,
    );
    expect(encryptPlaintextArg).toBeInstanceOf(Uint8Array);

    // Decode the JSON payload and assert the manifest fields the
    // backend cross-client contract pins.
    const decodedManifest = JSON.parse(
      new TextDecoder().decode(encryptPlaintextArg as Uint8Array),
    );
    expect(decodedManifest).toEqual(
      expect.objectContaining({
        assetId: fixture.androidHandoff.assetId,
        albumId: fixture.androidHandoff.albumId,
        epochId: fixture.clientCore.epochId,
        shardIds: fixture.backendManifestRequest.shardIds,
        thumbnailShardId: fixture.backendManifestRequest.tieredShards[0].shardId,
        previewShardId: fixture.backendManifestRequest.tieredShards[1].shardId,
        originalShardIds: [fixture.backendManifestRequest.tieredShards[2].shardId],
      }),
    );

    expect(mocks.signManifestWithEpoch).toHaveBeenCalledWith(
      `test-epoch-handle-${fixture.clientCore.epochId}`,
      encryptedMeta,
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

  it('cryptographically verifies every completed shard hash against fixture bytes', () => {
    const fixture = loadFixture();
    const completedShardIds = fixture.clientCore.completedShards
      .map((shard) => shard.shardId)
      .sort();
    const webShardIds = fixture.webShards.map((shard) => shard.id).sort();

    expect(new Set(completedShardIds).size).toBe(completedShardIds.length);
    expect(new Set(webShardIds).size).toBe(webShardIds.length);
    expect(webShardIds).toEqual(completedShardIds);
    expect([...fixture.backendManifestRequest.shardIds].sort()).toEqual(
      completedShardIds,
    );
    expect(
      fixture.backendManifestRequest.tieredShards
        .map((shard) => shard.shardId)
        .sort(),
    ).toEqual(completedShardIds);

    const webShardsById = new Map(
      fixture.webShards.map((shard) => [shard.id, shard]),
    );
    for (const completedShard of fixture.clientCore.completedShards) {
      const webShard = webShardsById.get(completedShard.shardId);
      if (!webShard) {
        throw new Error(
          `completed shard ${completedShard.shardId} must include fixture bytes`,
        );
      }

      expect(completedShard.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(webShard.sha256).toBe(completedShard.sha256);
      expect(sha256Hex(fromBase64(webShard.bytesBase64))).toBe(
        completedShard.sha256,
      );
    }
  });

  it('downloads the fixture shards as opaque bytes without decoding plaintext metadata', async () => {
    const fixture = loadFixture();
    const shardBytesById = new Map(
      fixture.webShards.map((shard) => [shard.id, verifiedShardBytes(shard)]),
    );
    const progress = vi.fn();
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const requestUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.pathname
            : input.url;
      const shardId = requestUrl.slice(requestUrl.lastIndexOf('/') + 1);
      const shardBytes = shardBytesById.get(shardId);
      if (!shardBytes) {
        throw new Error(`unexpected shard download request for ${shardId}`);
      }

      return Promise.resolve({
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
    });
    globalThis.fetch = fetchMock;

    for (const webShard of fixture.webShards) {
      const expectedBytes = shardBytesById.get(webShard.id);
      if (!expectedBytes) {
        throw new Error(
          `missing verified bytes for fixture shard ${webShard.id}`,
        );
      }

      const downloaded = await downloadShard(webShard.id, progress);

      expect(downloaded).toEqual(expectedBytes);
      const renderedBytes = Buffer.from(downloaded).toString('utf8');
      for (const forbidden of fixture.forbiddenPlaintextTerms) {
        expect(renderedBytes).not.toContain(forbidden);
      }
    }
    for (const [index, webShard] of fixture.webShards.entries()) {
      expect(fetchMock).toHaveBeenNthCalledWith(
        index + 1,
        `/api/shards/${webShard.id}`,
        { credentials: 'same-origin' },
      );
      const shardBytes = shardBytesById.get(webShard.id);
      if (!shardBytes) {
        throw new Error(
          `missing verified bytes for fixture shard ${webShard.id}`,
        );
      }
      expect(progress).toHaveBeenCalledWith(
        shardBytes.byteLength,
        shardBytes.byteLength,
      );
    }
  });
});
