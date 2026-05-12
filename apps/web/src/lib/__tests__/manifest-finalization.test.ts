import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeManifestFinalizationEffect,
  MANIFEST_ALBUM_GONE,
  ManifestFinalizationError,
  ManifestFinalizationTimeoutError,
  type FinalizeManifestEffect,
  type ManifestFinalizationAdapter,
} from '../manifest-finalization';
import { purgeLocalAlbum } from '../local-purge';

vi.mock('../crypto-client', () => ({
  getCryptoClient: () => Promise.resolve({
    finalizeIdempotencyKey: () => Promise.resolve('mosaic-finalize-test-job'),
  }),
}));

vi.mock('../local-purge', () => ({
  purgeLocalAlbum: vi.fn(async () => ({
    albumId: '018f0000-0000-7000-8000-000000000002',
    purgedAlbum: true,
    purgedPhotoIds: [],
    removedUploadTasks: 0,
    blockers: [],
  })),
}));

describe('executeManifestFinalizationEffect error events', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it.each([
    ['extra field', {
      protocolVersion: 1,
      manifestId: '018f0000-0000-7000-8000-000000000001',
      metadataVersion: 12,
      createdAt: '2026-05-06T00:00:00.000Z',
      tieredShards: effect().tieredShards,
      unexpected: true,
    }],
    ['missing field', {
      protocolVersion: 1,
      manifestId: '018f0000-0000-7000-8000-000000000001',
      createdAt: '2026-05-06T00:00:00.000Z',
      tieredShards: effect().tieredShards,
    }],
    ['wrong tier value', {
      protocolVersion: 1,
      manifestId: '018f0000-0000-7000-8000-000000000001',
      metadataVersion: 12,
      createdAt: '2026-05-06T00:00:00.000Z',
      tieredShards: [{ ...effect().tieredShards[0]!, tier: 4 }],
    }],
  ])('rejectsMalformedFinalizeResponse: %s', async (_name, body) => {
    const events: unknown[] = [];

    await expect(executeManifestFinalizationEffect(effect(), {
      jobId: 'test-job',
      adapter: adapterFor(events),
      fetchImpl: async () => new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    })).rejects.toMatchObject({
      code: 'MALFORMED_FINALIZE_RESPONSE',
    } satisfies Partial<ManifestFinalizationError>);

    expect(events).toEqual([{
      kind: 'NonRetryableFailure',
      effectId: 'effect-1',
      errorCode: 0,
      targetPhase: 'Failed',
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

  it('routes410ToPurgeLocalAlbum', async () => {
    const events: unknown[] = [];
    await expect(executeManifestFinalizationEffect(effect(), {
      jobId: 'test-job',
      adapter: adapterFor(events),
      fetchImpl: async () => new Response('gone', { status: 410 }),
    })).rejects.toMatchObject({
      status: 410,
      code: MANIFEST_ALBUM_GONE,
    } satisfies Partial<ManifestFinalizationError>);

    expect(events).toEqual([{
      kind: 'NonRetryableFailure',
      effectId: 'effect-1',
      errorCode: 410,
      targetPhase: 'Failed',
    }]);
    expect(purgeLocalAlbum).toHaveBeenCalledWith({
      albumId: '018f0000-0000-7000-8000-000000000002',
      reason: 'album-410',
    });
  });

  it('emitsManifestOutcomeUnknownOnTimeout', async () => {
    vi.useFakeTimers();
    const events: unknown[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
        setTimeout(() => reject(new TypeError('network timeout')), 60_000);
      });
      return new Response('{}', { status: 200 });
    });

    const promise = expect(executeManifestFinalizationEffect(effect(), {
      jobId: 'test-job',
      adapter: adapterFor(events),
      fetchImpl,
    })).rejects.toBeInstanceOf(ManifestFinalizationTimeoutError);

    await vi.advanceTimersByTimeAsync(30_000);
    await promise;

    expect(events).toEqual([{
      kind: 'ManifestOutcomeUnknown',
      effectId: 'effect-1',
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


