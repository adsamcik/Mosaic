/**
 * H4: SHA-384 integrity gate for /sql-wasm.js
 *
 * `db.worker.ts` fetches /sql-wasm.js and evaluates it via `new Function`.
 * A supply-chain compromise of `fts5-sql-bundle` or build-time tampering
 * could silently inject code into the DB worker, which holds the session
 * DB encryption key. To prevent that, the worker pins a SHA-384 digest of
 * the script at build time (via `scripts/copy-sql-wasm.cjs`) and verifies
 * the fetched bytes against the pinned constant before evaluation.
 *
 * These tests pin the contract of the integrity seam:
 *   1. matching digest → resolves quietly
 *   2. one-byte mutation → throws 'sql.js integrity check failed'
 *
 * `comlink` is mocked because importing `db.worker.ts` runs a top-level
 * `Comlink.expose(worker)` that wires the (test) global into a message
 * endpoint we don't need.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('comlink', () => ({
  expose: vi.fn(),
}));

import { verifyIntegrity } from '../db.worker';

async function sha384Sri(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-384', data);
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `sha384-${btoa(binary)}`;
}

describe('verifyIntegrity (sql.js loader gate)', () => {
  // A representative shape of /sql-wasm.js — only the digest matters for
  // these tests, but using realistic bytes makes the failure mode obvious.
  const KNOWN_SCRIPT =
    'var initSqlJs = function () { return Promise.resolve({ Database: function(){} }); };';

  it('resolves silently when the digest matches the pinned constant', async () => {
    const expected = await sha384Sri(KNOWN_SCRIPT);

    await expect(
      verifyIntegrity(KNOWN_SCRIPT, expected),
    ).resolves.toBeUndefined();
  });

  it('throws "sql.js integrity check failed" when a single byte is mutated', async () => {
    const expected = await sha384Sri(KNOWN_SCRIPT);

    // One-byte mutation: swap the trailing semicolon for a space. The pinned
    // digest still references the original bytes, so verification must fail
    // — proving the gate would catch a real injected payload.
    const tampered = KNOWN_SCRIPT.slice(0, -1) + ' ';
    expect(tampered).not.toBe(KNOWN_SCRIPT);
    expect(tampered.length).toBe(KNOWN_SCRIPT.length);

    await expect(verifyIntegrity(tampered, expected)).rejects.toThrow(
      'sql.js integrity check failed',
    );
  });

  it('throws when the pinned constant itself is wrong (defense against build/runtime drift)', async () => {
    const wrongPin =
      'sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    await expect(verifyIntegrity(KNOWN_SCRIPT, wrongPin)).rejects.toThrow(
      'sql.js integrity check failed',
    );
  });
});
