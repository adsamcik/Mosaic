import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EpochKeyBundle } from '../src/lib/epoch-key-store';
import { finalizeManifestForUpload } from '../src/lib/manifest-finalization';
import type { UploadTask } from '../src/lib/upload/types';
import { cryptoWorker } from '../src/workers/crypto.worker';
import type {
  AccountHandleId,
  CryptoWorkerApi,
  EpochHandleId,
  ManifestTranscriptInput,
} from '../src/workers/types';
import { initializeRustWasmForTests } from './wasm-test-init';

const cryptoClient = vi.hoisted(() => ({
  current: undefined as CryptoWorkerApi | undefined,
}));

vi.mock('../src/lib/crypto-client', () => ({
  getCryptoClient: async () => {
    if (!cryptoClient.current) {
      throw new Error('crypto worker test client not initialized');
    }
    return cryptoClient.current;
  },
}));

const ALBUM_ID = '00010203-0405-0607-0809-0a0b0c0d0e0f';
const MANIFEST_ID = '018f0000-0000-7000-8000-000000000401';
const SHARD_IDS = [
  '10101010-1010-4010-8010-10101010101a',
  '20202020-2020-4020-8020-20202020202b',
  '30303030-3030-4030-8030-30303030303c',
] as const;
const SHARD_HASHES = [
  '11'.repeat(32),
  '22'.repeat(32),
  '33'.repeat(32),
] as const;

interface CapturedFinalizeBody {
  albumId: string;
  encryptedMeta: string;
  signature: string;
  signerPubkey: string;
  tieredShards: Array<{
    shardId: string;
    tier: number;
    sha256: string;
  }>;
}

function fixedSalt(seed: number): Uint8Array {
  const out = new Uint8Array(16);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = (seed + index) & 0xff;
  }
  return out;
}

function fromHex(value: string): Uint8Array {
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function hexToUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mutateHexByte(hex: string): string {
  const bytes = fromHex(hex);
  bytes[0] ^= 0xff;
  return bytesToHex(bytes);
}

function uploadTask(epochHandleId: EpochHandleId): UploadTask {
  return {
    id: MANIFEST_ID,
    file: new File([new Uint8Array([1, 2, 3])], 'roundtrip.jpg', { type: 'image/jpeg' }),
    albumId: ALBUM_ID,
    epochId: 0x42424242,
    epochHandleId,
    status: 'queued',
    currentAction: 'pending',
    progress: 0,
    completedShards: [
      {
        index: 0,
        shardId: SHARD_IDS[0],
        sha256: SHARD_HASHES[0],
        tier: 1,
        contentLength: 3,
        envelopeVersion: 3,
      },
      {
        index: 0,
        shardId: SHARD_IDS[1],
        sha256: SHARD_HASHES[1],
        tier: 2,
        contentLength: 3,
        envelopeVersion: 3,
      },
      {
        index: 0,
        shardId: SHARD_IDS[2],
        sha256: SHARD_HASHES[2],
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

function transcriptInputFromFinalizeBody(body: CapturedFinalizeBody): ManifestTranscriptInput {
  return {
    albumId: body.albumId,
    epochId: 0x42424242,
    encryptedMeta: fromBase64(body.encryptedMeta),
    shards: body.tieredShards.map((shard, chunkIndex) => ({
      chunkIndex,
      tier: shard.tier,
      shardId: shard.shardId,
      sha256: shard.sha256,
    })),
  };
}

describe('manifest signing canonical round trip', () => {
  beforeAll(async () => {
    await initializeRustWasmForTests();
    cryptoClient.current = cryptoWorker;
  });

  afterAll(async () => {
    await cryptoWorker.clear();
    cryptoClient.current = undefined;
  });

  it('finalizes with Rust canonical transcript bytes that verify with the epoch public key', async () => {
    const account = await cryptoWorker.createNewAccount({
      password: 'manifest-roundtrip-password',
      userSalt: fixedSalt(0x10),
      accountSalt: fixedSalt(0x20),
      kdf: { memoryKib: 64 * 1024, iterations: 3, parallelism: 1 },
    });
    const epoch = await cryptoWorker.createEpochHandle(
      account.accountHandleId as AccountHandleId,
      0x42424242,
    );
    const epochKey: EpochKeyBundle = {
      epochId: 0x42424242,
      epochHandleId: epoch.epochHandleId,
      signPublicKey: epoch.signPublicKey,
      signKeypair: {
        publicKey: epoch.signPublicKey,
        secretKey: new Uint8Array(),
      },
    };

    let finalizeBody: CapturedFinalizeBody | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const captured = JSON.parse(String(init?.body)) as CapturedFinalizeBody;
      finalizeBody = captured;
      return new Response(JSON.stringify({
        protocolVersion: 1,
        manifestId: MANIFEST_ID,
        metadataVersion: 1,
        createdAt: '2026-05-10T00:00:00.000Z',
        tieredShards: captured.tieredShards,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await finalizeManifestForUpload(
      uploadTask(epoch.epochHandleId),
      [...SHARD_IDS],
      epochKey,
      undefined,
      { fetchImpl },
    );

    if (!finalizeBody) {
      throw new Error('finalize request body was not captured');
    }
    const body = finalizeBody;
    const input = transcriptInputFromFinalizeBody(body);
    const signature = fromBase64(body.signature);
    const signerPubkey = fromBase64(body.signerPubkey);

    await expect(
      cryptoWorker.verifyManifestWithEpoch(input, signature, signerPubkey),
    ).resolves.toBe(true);

    const tamperedMeta = new Uint8Array(input.encryptedMeta);
    tamperedMeta[0] ^= 0xff;
    await expect(
      cryptoWorker.verifyManifestWithEpoch(
        { ...input, encryptedMeta: tamperedMeta },
        signature,
        signerPubkey,
      ),
    ).resolves.toBe(false);

    await expect(
      cryptoWorker.verifyManifestWithEpoch(
        {
          ...input,
          shards: input.shards.map((shard, index) =>
            index === 0 ? { ...shard, sha256: mutateHexByte(shard.sha256) } : shard,
          ),
        },
        signature,
        signerPubkey,
      ),
    ).resolves.toBe(false);
  });

  it('matches the Rust canonical manifest transcript golden vector byte-for-byte', async () => {
    const vector = JSON.parse(
      readFileSync(
        resolve(process.cwd(), '..', '..', 'tests', 'vectors', 'manifest_transcript.json'),
        'utf8',
      ),
    ) as {
      inputs: {
        albumIdHex: string;
        epochId: number;
        encryptedMetaHex: string;
        shards: Array<{
          chunkIndex: number;
          tier: number;
          shardIdHex: string;
          sha256Hex: string;
        }>;
      };
      expected: { transcriptHex: string };
    };

    const transcript = await cryptoWorker.manifestTranscriptBytes({
      albumId: hexToUuid(vector.inputs.albumIdHex),
      epochId: vector.inputs.epochId,
      encryptedMeta: fromHex(vector.inputs.encryptedMetaHex),
      shards: vector.inputs.shards.map((shard) => ({
        chunkIndex: shard.chunkIndex,
        tier: shard.tier,
        shardId: hexToUuid(shard.shardIdHex),
        sha256: shard.sha256Hex,
      })),
    });

    expect(bytesToHex(transcript)).toBe(vector.expected.transcriptHex);
  });
});
