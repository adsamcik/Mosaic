import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/epoch-key-service', () => ({
  getOrFetchEpochKey: vi.fn().mockRejectedValue(new Error('no epoch service')),
}));

import { CorruptShardHashError, photosToPlanInput } from '../coordinator-download-runner';
import type { PhotoMeta } from '../../workers/types';

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function makePhoto(overrides: Partial<PhotoMeta>): PhotoMeta {
  const base: PhotoMeta = {
    id: 'photo-1',
    albumId: 'album-1',
    filename: 'one.jpg',
    epochId: 1,
    shardIds: [],
    createdAt: 0,
    updatedAt: 0,
  } as unknown as PhotoMeta;
  return { ...base, ...overrides } as PhotoMeta;
}

describe('photosToPlanInput — shard-hash format', () => {
  // Regression for v3-10 W-A6-6: rust `download_build_plan_v1` returns code
  // 723 (DownloadSnapshotCorrupt) when expectedHash is not exactly 32 bytes.
  // Upload pipeline (`encryptUploadShardWithEpochHandle`) stores SHA-256 as
  // base64url, so the plan-input encoder must decode base64url too.
  it('decodes base64url-encoded originalShardHashes to 32 bytes', async () => {
    const shardIdHex = 'a'.repeat(32); // 16 bytes hex, like tusdotnet
    const hashBytes = new Uint8Array(32).fill(0x42);
    const hashBase64Url = bytesToBase64Url(hashBytes); // 43-char base64url

    const photo = makePhoto({
      originalShardIds: [shardIdHex],
      originalShardHashes: [hashBase64Url],
    });

    const result = await photosToPlanInput('album-1', [photo]);

    expect(result.photos).toHaveLength(1);
    const shard = result.photos[0]!.shards[0]!;
    expect(shard.shardId.byteLength).toBe(16);
    expect(shard.expectedHash.byteLength).toBe(32);
    expect(Array.from(shard.expectedHash)).toEqual(Array.from(hashBytes));
  });

  it('still accepts legacy 64-char hex hashes', async () => {
    const shardIdHex = 'b'.repeat(32);
    const hashBytes = new Uint8Array(32).fill(0x37);
    const hashHex = bytesToHex(hashBytes);

    const photo = makePhoto({
      originalShardIds: [shardIdHex],
      originalShardHashes: [hashHex],
    });

    const result = await photosToPlanInput('album-1', [photo]);
    const shard = result.photos[0]!.shards[0]!;
    expect(shard.expectedHash.byteLength).toBe(32);
    expect(Array.from(shard.expectedHash)).toEqual(Array.from(hashBytes));
  });

  it('returns 32 zero-bytes when hash is missing (legacy path)', async () => {
    const photo = makePhoto({
      originalShardIds: ['c'.repeat(32)],
      // no originalShardHashes / shardHashes
    });
    const result = await photosToPlanInput('album-1', [photo]);
    const shard = result.photos[0]!.shards[0]!;
    expect(shard.expectedHash.byteLength).toBe(32);
    expect(shard.expectedHash.every((b) => b === 0)).toBe(true);
  });

  // Regression for HIGH `security-review-2026-05-22-01`: malformed shard
  // hashes used to be silently substituted with 32 zero bytes, which would
  // mask server-side data corruption or supply-chain tampering as a
  // generic decrypt failure downstream. The decoder MUST fail closed
  // instead — only the explicit "missing hash" path is allowed to emit
  // a zero digest.
  describe('fails closed on malformed shard hashes', () => {
    it('rejects non-hex garbage in a hex-shaped slot', async () => {
      const photo = makePhoto({
        originalShardIds: ['c'.repeat(32)],
        // 64 chars but contains non-hex/non-base64url char ('#')
        originalShardHashes: ['#'.repeat(64)],
      });
      await expect(photosToPlanInput('album-1', [photo])).rejects.toBeInstanceOf(
        CorruptShardHashError,
      );
    });

    it('rejects base64url charset that decodes to wrong length', async () => {
      // Valid base64url charset but decodes to 4 bytes, not 32.
      const photo = makePhoto({
        originalShardIds: ['d'.repeat(32)],
        originalShardHashes: ['zzzzzz'],
      });
      await expect(photosToPlanInput('album-1', [photo])).rejects.toBeInstanceOf(
        CorruptShardHashError,
      );
    });

    it('rejects too-short hex (16 hex chars = 8 bytes)', async () => {
      const photo = makePhoto({
        originalShardIds: ['e'.repeat(32)],
        originalShardHashes: ['a'.repeat(16)],
      });
      await expect(photosToPlanInput('album-1', [photo])).rejects.toBeInstanceOf(
        CorruptShardHashError,
      );
    });

    it('rejects too-long hex (128 hex chars = 64 bytes)', async () => {
      const photo = makePhoto({
        originalShardIds: ['f'.repeat(32)],
        originalShardHashes: ['a'.repeat(128)],
      });
      await expect(photosToPlanInput('album-1', [photo])).rejects.toBeInstanceOf(
        CorruptShardHashError,
      );
    });

    it('rejects entirely-illegal characters ("###")', async () => {
      const photo = makePhoto({
        originalShardIds: ['1'.repeat(32)],
        originalShardHashes: ['###'],
      });
      await expect(photosToPlanInput('album-1', [photo])).rejects.toBeInstanceOf(
        CorruptShardHashError,
      );
    });

    it('accepts the 64-char hex boundary (exactly 32 bytes when decoded)', async () => {
      // Boundary: 64 hex chars is the *valid* length. This ensures the
      // length check stays inclusive of the legitimate format and the
      // throw only fires on truly malformed input.
      const photo = makePhoto({
        originalShardIds: ['2'.repeat(32)],
        originalShardHashes: ['a'.repeat(64)],
      });
      const result = await photosToPlanInput('album-1', [photo]);
      expect(result.photos[0]!.shards[0]!.expectedHash.byteLength).toBe(32);
    });
  });

  // Regression for v3-10 W-A6-6: rust snapshot validator rejects any commit
  // where `photo.bytes_written > plan_entry.total_bytes`. The plan entry's
  // `total_bytes` is the sum of each shard's `declaredSize`. When the visitor
  // flow set declaredSize: 0 (because PhotoMeta does not carry per-shard
  // encrypted sizes), the very first commit-after-write failed with rust
  // code 723 (DownloadSnapshotCorrupt) and the ZIP was finalized empty
  // (22-byte EOCD only). The fix uses a generous per-shard upper bound so
  // the rust check can never be undershot by a real photo.
  it('sets declaredSize to a non-zero upper bound large enough for any real photo', async () => {
    const photo = makePhoto({
      originalShardIds: ['d'.repeat(32), 'e'.repeat(32)],
      originalShardHashes: ['0'.repeat(64), '1'.repeat(64)],
    });
    const result = await photosToPlanInput('album-1', [photo]);
    const planPhoto = result.photos[0]!;
    expect(planPhoto.shards).toHaveLength(2);
    for (const shard of planPhoto.shards) {
      // Must be strictly greater than any plausible bytes_written value
      // (typical real photos are 1-50 MB, hard ceiling ~5 GB).
      expect(shard.declaredSize).toBeGreaterThan(5 * 1024 * 1024 * 1024);
      // Stay safely below u64 max so per-photo sums cannot overflow.
      expect(shard.declaredSize).toBeLessThan(Number.MAX_SAFE_INTEGER);
    }
  });
});
