import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

// Protocol-class SHA-256 routes through the generated Rust/WASM helper.
// In unit tests we mock the WASM module with a node:crypto-backed SHA-256
// so the integrity comparison still exercises real SHA-256 semantics
// without requiring the WASM binary to load under happy-dom.
const wasmMocks = vi.hoisted(() => {
  const nodeSha256 = (bytes: Uint8Array): Uint8Array => {
    const h = createHash('sha256');
    h.update(bytes);
    return new Uint8Array(h.digest());
  };
  return {
    initRustWasm: vi.fn().mockResolvedValue(undefined),
    sha256OfBytes: vi.fn(nodeSha256),
  };
});

vi.mock('../../generated/mosaic-wasm/mosaic_wasm.js', () => ({
  default: wasmMocks.initRustWasm,
  sha256OfBytes: wasmMocks.sha256OfBytes,
}));

import { CorruptShardHashError } from '../../hooks/coordinator-download-runner';
import {
  CorruptShardManifest,
  ShardIntegrityMismatchError,
  verifyShardIntegrity,
  verifyShardListIntegrity,
} from '../shard-integrity';

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

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return wasmMocks.sha256OfBytes(data);
}

describe('verifyShardIntegrity — fail-closed semantics', () => {
  // Legacy compat: pre-hash manifests have no per-shard hash at all.
  // Those paths must continue to work silently.
  it('skips verification when expected hash is null (legacy)', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    await expect(
      verifyShardIntegrity(payload, null, 'ctx'),
    ).resolves.toBeUndefined();
  });

  it('skips verification when expected hash is undefined (legacy)', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    await expect(
      verifyShardIntegrity(payload, undefined, 'ctx'),
    ).resolves.toBeUndefined();
  });

  // HIGH security-review-2026-05-22-04: empty string is NOT the same as
  // a missing hash — it indicates manifest corruption / tampering and
  // must fail closed.
  it('throws CorruptShardHashError on empty-string expected hash', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    await expect(
      verifyShardIntegrity(payload, '', 'ctx'),
    ).rejects.toBeInstanceOf(CorruptShardHashError);
  });

  it('throws CorruptShardHashError on whitespace-only expected hash', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    await expect(
      verifyShardIntegrity(payload, '   ', 'ctx'),
    ).rejects.toBeInstanceOf(CorruptShardHashError);
    await expect(
      verifyShardIntegrity(payload, '\t\n ', 'ctx'),
    ).rejects.toBeInstanceOf(CorruptShardHashError);
  });

  it('throws CorruptShardHashError on malformed hex (wrong length)', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    await expect(
      verifyShardIntegrity(payload, 'ab'.repeat(8), 'ctx'),
    ).rejects.toBeInstanceOf(CorruptShardHashError);
  });

  it('throws CorruptShardHashError on illegal characters', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    await expect(
      verifyShardIntegrity(payload, '###'.repeat(20), 'ctx'),
    ).rejects.toBeInstanceOf(CorruptShardHashError);
  });

  it('resolves silently when valid base64url hash matches content', async () => {
    const payload = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    const expected = bytesToBase64Url(await sha256(payload));
    await expect(
      verifyShardIntegrity(payload, expected, 'ctx'),
    ).resolves.toBeUndefined();
  });

  it('resolves silently when valid 64-char hex hash matches content', async () => {
    const payload = new Uint8Array([42, 42, 42]);
    const digest = await sha256(payload);
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
    await expect(
      verifyShardIntegrity(payload, hex, 'ctx'),
    ).resolves.toBeUndefined();
  });

  it('throws ShardIntegrityMismatchError when valid hash does not match content', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const otherDigest = await sha256(new Uint8Array([9, 9, 9, 9]));
    const expected = bytesToBase64Url(otherDigest);
    await expect(
      verifyShardIntegrity(payload, expected, 'photo=p1 shard=0'),
    ).rejects.toBeInstanceOf(ShardIntegrityMismatchError);
  });

  it('mismatch error carries the context string', async () => {
    const payload = new Uint8Array([1, 2, 3]);
    const wrong = bytesToBase64Url(await sha256(new Uint8Array([4, 5, 6])));
    await expect(
      verifyShardIntegrity(payload, wrong, 'photo=abc shard=7'),
    ).rejects.toMatchObject({
      name: 'ShardIntegrityMismatchError',
      context: 'photo=abc shard=7',
    });
  });
});

describe('verifyShardListIntegrity — presence-aware semantics', () => {
  // HIGH security-review-2026-05-22-06: present-but-shorter hash arrays
  // must fail closed instead of silently skipping verification on the
  // unmatched tail.

  function makeShard(seed: number): Uint8Array {
    return new Uint8Array([seed, seed + 1, seed + 2, seed + 3]);
  }
  async function hashFor(bytes: Uint8Array): Promise<string> {
    return bytesToBase64Url(await sha256(bytes));
  }

  it('skips verification when expectedHashes is null (legacy)', async () => {
    const shards = [makeShard(1), makeShard(2), makeShard(3)];
    await expect(
      verifyShardListIntegrity(shards, null, 'ctx'),
    ).resolves.toBeUndefined();
  });

  it('skips verification when expectedHashes is undefined (legacy)', async () => {
    const shards = [makeShard(1), makeShard(2)];
    await expect(
      verifyShardListIntegrity(shards, undefined, 'ctx'),
    ).resolves.toBeUndefined();
  });

  it('throws CorruptShardManifest on empty array with shards present', async () => {
    const shards = [makeShard(1), makeShard(2)];
    await expect(
      verifyShardListIntegrity(shards, [], 'photo=p1'),
    ).rejects.toBeInstanceOf(CorruptShardManifest);
  });

  it('throws CorruptShardManifest when hash array is shorter than shards', async () => {
    const shards = [makeShard(1), makeShard(2), makeShard(3)];
    const hashes = [await hashFor(shards[0]!), await hashFor(shards[1]!)];
    await expect(
      verifyShardListIntegrity(shards, hashes, 'photo=p1'),
    ).rejects.toBeInstanceOf(CorruptShardManifest);
  });

  it('throws CorruptShardManifest when hash array is longer than shards', async () => {
    const shards = [makeShard(1)];
    const hashes = [await hashFor(shards[0]!), 'A'.repeat(43)];
    await expect(
      verifyShardListIntegrity(shards, hashes, 'photo=p1'),
    ).rejects.toBeInstanceOf(CorruptShardManifest);
  });

  it('resolves silently with correct count and matching hashes', async () => {
    const shards = [makeShard(1), makeShard(2), makeShard(3)];
    const hashes = await Promise.all(shards.map(hashFor));
    await expect(
      verifyShardListIntegrity(shards, hashes, 'photo=p1'),
    ).resolves.toBeUndefined();
  });

  it('throws CorruptShardHashError when one entry is empty string', async () => {
    const shards = [makeShard(1), makeShard(2), makeShard(3)];
    const hashes = [
      await hashFor(shards[0]!),
      await hashFor(shards[1]!),
      '',
    ];
    await expect(
      verifyShardListIntegrity(shards, hashes, 'photo=p1'),
    ).rejects.toBeInstanceOf(CorruptShardHashError);
  });

  it('throws ShardIntegrityMismatchError when one hash does not match', async () => {
    const shards = [makeShard(1), makeShard(2), makeShard(3)];
    const hashes = [
      await hashFor(shards[0]!),
      await hashFor(makeShard(99)), // wrong hash for shard 1
      await hashFor(shards[2]!),
    ];
    await expect(
      verifyShardListIntegrity(shards, hashes, 'photo=p1'),
    ).rejects.toBeInstanceOf(ShardIntegrityMismatchError);
  });

  it('CorruptShardManifest message includes the context and counts', async () => {
    const shards = [makeShard(1), makeShard(2), makeShard(3)];
    await expect(
      verifyShardListIntegrity(shards, [], 'photo=abc'),
    ).rejects.toMatchObject({
      name: 'CorruptShardManifest',
      context: 'photo=abc',
      message: expect.stringContaining('hash array length 0 != shard count 3'),
    });
  });
});
