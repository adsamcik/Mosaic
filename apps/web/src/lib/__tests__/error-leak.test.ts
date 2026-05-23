/**
 * Regression coverage for HIGH `security-review-2026-05-22-07`.
 *
 * Generic error logging / telemetry / `JSON.stringify` MUST NOT be able
 * to extract shard-hash manifest bytes from any shard-integrity error.
 * Each error class either omits hash material entirely, or stores only
 * caller-provided context strings (which are screened separately).
 *
 * The tests assert four invariants per class:
 *  1. Own-property surface (`Object.keys`, `Object.getOwnPropertyNames`)
 *     contains no field named `expectedHash` / `actualHash` / `hash` /
 *     `expected` / `actual`.
 *  2. The error message does not contain a 64-hex-char run.
 *  3. The error message does not contain a ≥32-char base64url run.
 *  4. `JSON.stringify` output likewise contains no 64-hex or 32-byte
 *     base64url runs.
 *
 * The same checks are applied to `PhotoAssemblyError` wrapping a
 * `ShardIntegrityError`, since `PhotoAssemblyError` preserves the cause
 * and its message embeds `cause.message`.
 */

import { describe, expect, it } from 'vitest';

import {
  PhotoAssemblyError,
  ShardIntegrityError,
} from '../photo-service';
import {
  CorruptShardManifest,
  ShardIntegrityMismatchError,
} from '../shard-integrity';
import { CorruptShardHashError } from '../../hooks/coordinator-download-runner';

// 64 hex chars = a full SHA-256 digest. Allow lowercase or uppercase.
const HEX_DIGEST_RE = /[0-9a-fA-F]{64}/;
// 43 base64url chars = a 32-byte SHA-256 encoded without padding.
// Be generous on lower bound (≥32) so we catch any partial leak too.
const BASE64URL_LONG_RE = /[A-Za-z0-9_-]{32,}/;
const LEAKY_PROP_NAMES = new Set([
  'expectedHash',
  'actualHash',
  'hash',
  'expected',
  'actual',
  'shardHashes',
  // v1.0.2 `v102-corrupt-shard-hash-value-leak`: the original
  // `CorruptShardHashError` exposed the entire malformed manifest string
  // as a `public readonly value`. `JSON.stringify(err)` therefore echoed
  // the full attacker-controlled blob into telemetry / logs. The field
  // must NOT reappear on any of these error classes.
  'value',
]);

function assertNoLeakyOwnProps(err: Error): void {
  const keys = new Set([
    ...Object.keys(err),
    ...Object.getOwnPropertyNames(err),
  ]);
  for (const banned of LEAKY_PROP_NAMES) {
    expect(keys.has(banned)).toBe(false);
  }
}

function assertNoHashRuns(text: string): void {
  expect(HEX_DIGEST_RE.test(text)).toBe(false);
  expect(BASE64URL_LONG_RE.test(text)).toBe(false);
}

function assertErrorLeakFree(err: Error): void {
  assertNoLeakyOwnProps(err);
  assertNoHashRuns(err.message);
  // Error's own enumerable surface (what telemetry typically grabs).
  assertNoHashRuns(JSON.stringify(err));
  // Plus a full snapshot of every own property value, to make sure we
  // don't ship hash bytes via a non-enumerable backdoor either.
  const ownDump = Object.getOwnPropertyNames(err)
    .map((k) => {
      const v = (err as unknown as Record<string, unknown>)[k];
      return typeof v === 'string' ? v : '';
    })
    .join('\n');
  assertNoHashRuns(ownDump);
}

describe('ShardIntegrityError (HIGH security-review-2026-05-22-07)', () => {
  it('does not expose expectedHash / actualHash as own properties', () => {
    const err = new ShardIntegrityError('shard-abc');
    assertNoLeakyOwnProps(err);
    expect(err.shardId).toBe('shard-abc');
    expect(err.name).toBe('ShardIntegrityError');
  });

  it('default message does not echo any hash bytes', () => {
    const err = new ShardIntegrityError('shard-abc');
    assertErrorLeakFree(err);
  });

  it('caller-supplied message cannot smuggle hash bytes via JSON', () => {
    // Even if a future caller passes a benign message, JSON.stringify
    // must still emit no hash runs. (We pre-screen: this message itself
    // contains no hash; we only verify the surface does not regress to
    // include any new hash-bearing field.)
    const err = new ShardIntegrityError('shard-xyz', 'mismatch');
    assertErrorLeakFree(err);
  });

  it('survives JSON.stringify round-trip without resurrecting hash fields', () => {
    const err = new ShardIntegrityError('shard-abc');
    const json = JSON.stringify(err);
    // Error's default toJSON-less behavior yields '{}' in most engines.
    // The important invariant is that no hash key/value re-appears.
    expect(json).not.toMatch(/expectedHash|actualHash/);
  });
});

describe('ShardIntegrityMismatchError', () => {
  it('stores only caller-provided context, no hash bytes', () => {
    const err = new ShardIntegrityMismatchError('photo-service photo=p1[0]');
    assertErrorLeakFree(err);
    expect(err.context).toBe('photo-service photo=p1[0]');
  });
});

describe('CorruptShardManifest', () => {
  it('stores only caller-provided context + detail counts', () => {
    const err = new CorruptShardManifest(
      'shared-album original photo=p1',
      'hash array length 1 != shard count 2',
    );
    assertErrorLeakFree(err);
    expect(err.context).toBe('shared-album original photo=p1');
  });
});

describe('CorruptShardHashError', () => {
  it('does not echo a full 64-hex digest into the message', () => {
    const hex = 'a'.repeat(64);
    const err = new CorruptShardHashError(hex);
    // Message slices to 32 chars, which is well under the 64-hex
    // threshold we screen for.
    expect(err.message.length).toBeLessThan(80);
    expect(HEX_DIGEST_RE.test(err.message)).toBe(false);
  });

  // v1.0.2 `v102-corrupt-shard-hash-value-leak`: the previous shape
  // attached the entire malformed input as `public readonly value`, so a
  // generic `JSON.stringify(err)` or telemetry serializer would echo the
  // full attacker-controlled blob into logs. Assert the field is gone
  // from every relevant surface.
  it('does not expose the raw malformed value as an own property', () => {
    // Use '#' so the value cannot match the base64url/hex screening regex.
    // We are validating the SHAPE of the error here (no `value` field), not
    // the leak-free hash regression that the other test already covers.
    const ugly = '#'.repeat(2048);
    const err = new CorruptShardHashError(ugly);
    const own = new Set([
      ...Object.keys(err),
      ...Object.getOwnPropertyNames(err),
    ]);
    expect(own.has('value')).toBe(false);
    // Generic JSON serialization must not resurrect the field either.
    const json = JSON.stringify(err);
    expect(json).not.toMatch(/"value"/);
    expect(json).not.toContain(ugly.slice(0, 64));
    // And the full leak-free audit must pass.
    assertErrorLeakFree(err);
  });
});

describe('PhotoAssemblyError wrapping ShardIntegrityError', () => {
  it('does not leak hash bytes via cause chain or message', () => {
    const cause = new ShardIntegrityError('shard-abc');
    const err = new PhotoAssemblyError('photo-1', cause);
    assertErrorLeakFree(err);
    // The cause itself must also be leak-free.
    assertErrorLeakFree(err.cause);
    // And the JSON snapshot of the full error (which includes cause
    // since cause is an own enumerable property) must be clean.
    const fullDump = JSON.stringify({
      err: { name: err.name, message: err.message, photoId: err.photoId },
      cause: {
        name: err.cause.name,
        message: err.cause.message,
        own: Object.getOwnPropertyNames(err.cause),
      },
    });
    assertNoHashRuns(fullDump);
    expect(fullDump).not.toMatch(/expectedHash|actualHash/);
  });
});
