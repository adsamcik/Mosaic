import { describe, expect, it } from 'vitest';
import {
  manifestShardIdsMatchTranscript,
  manifestTranscriptInputForPhotoMeta,
} from '../manifest-transcript';
import type { PhotoMeta } from '../../workers/types';

/**
 * Regression for v1.0.1 release blocker
 * `v101-upload-pipeline-cross-format-regression`.
 *
 * Backend `/albums/{id}/sync` serializes shard IDs as canonical UUIDs with
 * dashes (`ac6df5b8-5030-4feb-8201-7d8b81bbba37`).
 *
 * The TUS upload client extracts the shard ID from the upload URL and
 * historically receives it without dashes (`ac6df5b850304feb82017d8b81bbba37`),
 * which then gets persisted into the encrypted `PhotoMeta.shardIds` and bound
 * into the signed transcript.
 *
 * Both forms refer to the same UUID. The cross-payload comparator must treat
 * them as equal, otherwise every freshly uploaded photo gets rejected at
 * sync time as `transcript-mismatch` and never appears in the gallery.
 */
describe('manifestShardIdsMatchTranscript — UUID format normalization', () => {
  const DASHED = [
    'ac6df5b8-5030-4feb-8201-7d8b81bbba37',
    '3b0128e5-adfc-4abc-9d24-3973e5f8e072',
    'f9e34d7a-ba23-4899-b30f-ce2946d5d7db',
  ];
  const UNDASHED = DASHED.map((id) => id.replace(/-/g, ''));

  function baseMeta(shardIds: readonly string[]): PhotoMeta {
    return {
      id: '019e42c0-0cc3-73e8-8235-552083323df1',
      assetId: '019e42c0-0cc3-73e8-8235-552083323df1',
      albumId: '019e42c0-070a-738e-8f66-e5607e556fee',
      filename: 'photo.png',
      mimeType: 'image/png',
      width: 1024,
      height: 768,
      tags: [],
      createdAt: '2026-05-20T00:00:00.000Z',
      updatedAt: '2026-05-20T00:00:00.000Z',
      shardIds: [...shardIds],
      shardHashes: shardIds.map(() => 'a'.repeat(64)),
      epochId: 1,
      thumbnailShardId: shardIds[0]!,
      thumbnailShardHash: 'a'.repeat(64),
      previewShardId: shardIds[1]!,
      previewShardHash: 'a'.repeat(64),
      originalShardIds: [shardIds[2]!],
      originalShardHashes: ['a'.repeat(64)],
    } as PhotoMeta;
  }

  it('matches when both sides use the canonical dashed UUID form', () => {
    const meta = baseMeta(DASHED);
    const transcript = manifestTranscriptInputForPhotoMeta(meta, new Uint8Array());
    expect(manifestShardIdsMatchTranscript(DASHED, transcript)).toBe(true);
  });

  it('matches when both sides use the undashed 32-hex form', () => {
    const meta = baseMeta(UNDASHED);
    const transcript = manifestTranscriptInputForPhotoMeta(meta, new Uint8Array());
    expect(manifestShardIdsMatchTranscript(UNDASHED, transcript)).toBe(true);
  });

  it('matches when sync payload uses dashed form but PhotoMeta uses undashed form (v1.0.1 regression)', () => {
    const meta = baseMeta(UNDASHED);
    const transcript = manifestTranscriptInputForPhotoMeta(meta, new Uint8Array());
    expect(manifestShardIdsMatchTranscript(DASHED, transcript)).toBe(true);
  });

  it('matches when sync payload uses undashed form but PhotoMeta uses dashed form', () => {
    const meta = baseMeta(DASHED);
    const transcript = manifestTranscriptInputForPhotoMeta(meta, new Uint8Array());
    expect(manifestShardIdsMatchTranscript(UNDASHED, transcript)).toBe(true);
  });

  it('still rejects when shard IDs refer to different UUIDs', () => {
    const meta = baseMeta(DASHED);
    const transcript = manifestTranscriptInputForPhotoMeta(meta, new Uint8Array());
    const tampered = [...DASHED];
    tampered[1] = '00000000-0000-0000-0000-000000000000';
    expect(manifestShardIdsMatchTranscript(tampered, transcript)).toBe(false);
  });

  it('still rejects when the ordering differs', () => {
    const meta = baseMeta(DASHED);
    const transcript = manifestTranscriptInputForPhotoMeta(meta, new Uint8Array());
    const reordered = [DASHED[2]!, DASHED[1]!, DASHED[0]!];
    expect(manifestShardIdsMatchTranscript(reordered, transcript)).toBe(false);
  });

  it('still rejects when lengths differ', () => {
    const meta = baseMeta(DASHED);
    const transcript = manifestTranscriptInputForPhotoMeta(meta, new Uint8Array());
    expect(manifestShardIdsMatchTranscript(DASHED.slice(0, 2), transcript)).toBe(false);
  });

  it('still rejects malformed shard IDs that are not valid UUIDs', () => {
    const meta = baseMeta(DASHED);
    const transcript = manifestTranscriptInputForPhotoMeta(meta, new Uint8Array());
    const bogus = [...DASHED];
    bogus[0] = 'not-a-uuid';
    expect(manifestShardIdsMatchTranscript(bogus, transcript)).toBe(false);
  });
});
