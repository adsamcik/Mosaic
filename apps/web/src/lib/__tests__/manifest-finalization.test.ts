import { describe, expect, it, vi } from 'vitest';
import {
  executeManifestFinalizationEffect,
  MANIFEST_AUTH_DENIED,
  MANIFEST_TRANSIENT_SERVER_ERROR,
  ManifestFinalizationError,
  type FinalizeManifestEffect,
  type ManifestFinalizationAdapter,
} from '../manifest-finalization';

vi.mock('../crypto-client', () => ({
  getCryptoClient: () => Promise.resolve({
    finalizeIdempotencyKey: () => Promise.resolve('mosaic-finalize-test-job'),
  }),
}));

describe('executeManifestFinalizationEffect error events', () => {
  it.each([401, 403])('submits ManifestFailed for auth status %i', async (status) => {
    const events: unknown[] = [];
    await expect(executeManifestFinalizationEffect(effect(), {
      jobId: 'test-job',
      adapter: adapterFor(events),
      fetchImpl: async () => new Response(JSON.stringify({ detail: 'denied' }), { status }),
    })).rejects.toBeInstanceOf(ManifestFinalizationError);

    expect(events).toEqual([{
      kind: 'ManifestFailed',
      effectId: 'effect-1',
      errorCode: MANIFEST_AUTH_DENIED,
      detail: 'denied',
      targetPhase: 'Failed',
    }]);
  });

  it.each([500, 502, 503, 504])('submits retriable ManifestFailed for server status %i', async (status) => {
    const events: unknown[] = [];
    await expect(executeManifestFinalizationEffect(effect(), {
      jobId: 'test-job',
      adapter: adapterFor(events),
      fetchImpl: async () => new Response('temporarily unavailable', { status }),
    })).rejects.toBeInstanceOf(ManifestFinalizationError);

    expect(events).toEqual([{
      kind: 'ManifestFailed',
      effectId: 'effect-1',
      errorCode: MANIFEST_TRANSIENT_SERVER_ERROR,
      detail: 'temporarily unavailable',
      retriable: true,
      targetPhase: 'Failed',
    }]);
  });
});

function adapterFor(events: unknown[]): ManifestFinalizationAdapter {
  return {
    submit: async (event) => {
      events.push(event);
    },
  };
}

function effect(): FinalizeManifestEffect {
  return {
    kind: 'FinalizeManifest',
    effectId: 'effect-1',
    manifestId: '018f0000-0000-7000-8000-000000000001',
    protocolVersion: 1,
    albumId: '018f0000-0000-7000-8000-000000000002',
    assetType: 'Image',
    encryptedMeta: new Uint8Array([1, 2, 3]),
    signature: new Uint8Array([4, 5, 6]),
    signerPubkey: new Uint8Array([7, 8, 9]),
    tieredShards: [{
      shardId: '018f0000-0000-7000-8000-000000000003',
      tier: 3,
      shardIndex: 0,
      sha256: 'a'.repeat(64),
      contentLength: 3,
      envelopeVersion: 4,
    }],
  };
}
