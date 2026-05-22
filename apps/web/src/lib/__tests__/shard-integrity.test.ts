import { describe, expect, it } from 'vitest';

import { CorruptShardHashError } from '../../hooks/coordinator-download-runner';
import {
  ShardIntegrityMismatchError,
  verifyShardIntegrity,
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
  const buf = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return new Uint8Array(buf);
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
