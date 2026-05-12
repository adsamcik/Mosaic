import { describe, expect, it, vi } from 'vitest';
import {
  executeManifestFinalizationEffect,
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
  it('emitsManifestCreatedOnSuccess', async () => {
    const events: unknown[] = [];

    await expect(executeManifestFinalizationEffect(effect(), {
      jobId: 'test-job',
      adapter: adapterFor(events),
      fetchImpl: async () => new Response(JSON.stringify({
        protocolVersion: 1,
        manifestId: '018f0000-0000-7000-8000-000000000001',
        metadataVersion: 12,
        createdAt: '2026-05-06T00:00:00.000Z',
        tieredShards: effect().tieredShards,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    })).resolves.toMatchObject({ kind: 'ManifestCreated' });

    expect(events).toEqual([{
      kind: 'ManifestCreated',
      effectId: 'effect-1',
      assetId: '018f0000-0000-7000-8000-000000000001',
      sinceMetadataVersion: 12n,
    }]);
  });

  it('rejects malformed shard UUIDs before submitting the finalize request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('{}', { status: 200 }),
    );
    const malformed = {
      ...effect(),
      tieredShards: [{
        ...effect().tieredShards[0]!,
        shardId: 'not-a-uuid',
      }],
    };

    await expect(executeManifestFinalizationEffect(malformed, {
      jobId: 'test-job',
      fetchImpl,
    })).rejects.toThrow(/UUID/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects malformed shard SHA-256 values before submitting the finalize request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('{}', { status: 200 }),
    );
    const malformed = {
      ...effect(),
      tieredShards: [{
        ...effect().tieredShards[0]!,
        sha256: 'not-a-sha256',
      }],
    };

    await expect(executeManifestFinalizationEffect(malformed, {
      jobId: 'test-job',
      fetchImpl,
    })).rejects.toThrow(/SHA-256/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([401, 403])('submits NonRetryableFailure for auth status %i', async (status) => {
    const events: unknown[] = [];
    await expect(executeManifestFinalizationEffect(effect(), {
      jobId: 'test-job',
      adapter: adapterFor(events),
      fetchImpl: async () => new Response(JSON.stringify({ detail: 'denied' }), { status }),
    })).rejects.toBeInstanceOf(ManifestFinalizationError);

    expect(events).toEqual([{
      kind: 'NonRetryableFailure',
      effectId: 'effect-1',
      errorCode: status,
      targetPhase: 'Failed',
    }]);
  });

  it('emitsNonRetryableFailureOn403', async () => {
    const events: unknown[] = [];
    await expect(executeManifestFinalizationEffect(effect(), {
      jobId: 'test-job',
      adapter: adapterFor(events),
      fetchImpl: async () => new Response('denied', { status: 403 }),
    })).rejects.toBeInstanceOf(ManifestFinalizationError);

    expect(events).toEqual([{
      kind: 'NonRetryableFailure',
      effectId: 'effect-1',
      errorCode: 403,
      targetPhase: 'Failed',
    }]);
  });

  it.each([500, 502, 503, 504])('submits RetryableFailure for server status %i', async (status) => {
    const events: unknown[] = [];
    await expect(executeManifestFinalizationEffect(effect(), {
      jobId: 'test-job',
      adapter: adapterFor(events),
      fetchImpl: async () => new Response('temporarily unavailable', { status }),
    })).rejects.toBeInstanceOf(ManifestFinalizationError);

    expect(events).toEqual([{
      kind: 'RetryableFailure',
      effectId: 'effect-1',
      errorCode: status,
      targetPhase: 'Failed',
    }]);
  });

  it('emitsRetryableFailureOn5xx', async () => {
    const events: unknown[] = [];
    await expect(executeManifestFinalizationEffect(effect(), {
      jobId: 'test-job',
      adapter: adapterFor(events),
      fetchImpl: async () => new Response('temporarily unavailable', { status: 503 }),
    })).rejects.toBeInstanceOf(ManifestFinalizationError);

    expect(events).toEqual([{
      kind: 'RetryableFailure',
      effectId: 'effect-1',
      errorCode: 503,
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


