/**
 * DbWorker — Slice 8 OPFS snapshot envelope tests.
 *
 * Verifies the Slice 8 hard-cutover contract:
 *   1. The DB worker no longer imports libsodium-wrappers-sumo or
 *      `@mosaic/crypto`. Encryption is delegated to the supplied
 *      `DbCryptoBridge` (which in production routes through the crypto
 *      worker's Rust-backed `wrapDbBlob` / `unwrapDbBlob`).
 *   2. `init(bridge)` round-trips a v4 snapshot through the bridge:
 *      `[u8 SNAPSHOT_VERSION][...account-handle wrap blob...]`.
 *   3. A snapshot whose leading version byte does not match
 *      `SNAPSHOT_VERSION` is silently discarded and the DB worker
 *      reinitializes from an empty database — the migration policy that
 *      "existing OPFS snapshots are invalidated at the cutover boundary".
 *
 * Uses a stubbed bridge whose wrap/unwrap are XOR-based — sufficient to
 * exercise the persistence codepath without booting the real crypto
 * worker, while still proving the wrap/unwrap callbacks are wired
 * through the worker's encryptBlob / decryptBlob seams.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('comlink', () => ({
  expose: vi.fn(),
}));

const { sqlBootstrap } = vi.hoisted(() => ({
  sqlBootstrap: `
function initSqlJs() {
  return Promise.resolve({
    Database: class Database {
      close() {}
      run() {}
      exec() { return []; }
      export() { return new Uint8Array([1, 2, 3, 4]); }
      prepare() {
        return { run() {}, free() {} };
      }
    }
  });
}
`,
}));

vi.mock('../src/generated/sql-wasm-integrity', async () => {
  const data = new TextEncoder().encode(sqlBootstrap);
  const hashBuffer = await crypto.subtle.digest('SHA-384', data);
  const bytes = new Uint8Array(hashBuffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { SQL_WASM_SHA384: 'sha384-' + btoa(binary) };
});

import { DbWorker, SNAPSHOT_VERSION } from '../src/workers/db.worker';
import type { DbCryptoBridge } from '../src/workers/types';

function makePassthroughBridge() {
  return {
    wrap: vi.fn(async (plaintext: Uint8Array) => {
      // Tag the wrapped form so we can assert the bridge was invoked
      // (XOR-flip the first byte — trivial round-trip-able transform).
      const out = new Uint8Array(plaintext.length);
      out.set(plaintext);
      if (out.length > 0) out[0] = (out[0] ?? 0) ^ 0x55;
      return out;
    }),
    unwrap: vi.fn(async (wrapped: Uint8Array) => {
      const out = new Uint8Array(wrapped.length);
      out.set(wrapped);
      if (out.length > 0) out[0] = (out[0] ?? 0) ^ 0x55;
      return out;
    }),
  } satisfies DbCryptoBridge & {
    wrap: ReturnType<typeof vi.fn>;
    unwrap: ReturnType<typeof vi.fn>;
  };
}

describe('DbWorker — Slice 8 source-level invariants', () => {
  it('does not import libsodium-wrappers-sumo or @mosaic/crypto', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const dbWorkerPath = resolve(here, '../src/workers/db.worker.ts');
    const source = readFileSync(dbWorkerPath, 'utf8');

    expect(source).not.toMatch(/from\s+['"]libsodium-wrappers-sumo['"]/);
    expect(source).not.toMatch(/from\s+['"]@mosaic\/crypto['"]/);
  });

  it('exports SNAPSHOT_VERSION = 4 (R-C6 AAD-bound account-data envelope)', () => {
    expect(SNAPSHOT_VERSION).toBe(4);
  });
});

describe('DbWorker — OPFS snapshot wrap/unwrap', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      text: () => Promise.resolve(sqlBootstrap),
    } as Response);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('init() with no existing snapshot calls neither wrap nor unwrap on the bridge', async () => {
    const worker = new DbWorker();
    const internal = worker as unknown as {
      loadFromOPFS: () => Promise<Uint8Array | null>;
      runMigrations: () => Promise<void>;
    };
    vi.spyOn(internal, 'loadFromOPFS').mockResolvedValue(null);
    vi.spyOn(internal, 'runMigrations').mockResolvedValue(undefined);

    const bridge = makePassthroughBridge();
    await worker.init(bridge);

    expect(bridge.unwrap).not.toHaveBeenCalled();
    expect(bridge.wrap).not.toHaveBeenCalled();
  });

  it('round-trips a v4 snapshot through the crypto bridge on encryptBlob/decryptBlob', async () => {
    const worker = new DbWorker();
    const internal = worker as unknown as {
      loadFromOPFS: () => Promise<Uint8Array | null>;
      runMigrations: () => Promise<void>;
      encryptBlob: (data: Uint8Array) => Promise<Uint8Array>;
      decryptBlob: (data: Uint8Array) => Promise<Uint8Array>;
    };
    vi.spyOn(internal, 'loadFromOPFS').mockResolvedValue(null);
    vi.spyOn(internal, 'runMigrations').mockResolvedValue(undefined);

    const bridge = makePassthroughBridge();
    await worker.init(bridge);

    const plaintext = new Uint8Array([10, 20, 30, 40, 50]);
    const wrapped = await internal.encryptBlob(plaintext);

    // Envelope contract: leading byte is SNAPSHOT_VERSION; remainder is
    // whatever the bridge produced.
    expect(wrapped[0]).toBe(SNAPSHOT_VERSION);
    expect(wrapped.length).toBe(plaintext.length + 1);
    expect(bridge.wrap).toHaveBeenCalledTimes(1);

    const unwrapped = await internal.decryptBlob(wrapped);
    expect(unwrapped).toEqual(plaintext);
    expect(bridge.unwrap).toHaveBeenCalledTimes(1);

    // The bridge saw the leading version byte stripped on the way back in.
    const unwrapInputArg = bridge.unwrap.mock.calls[0]?.[0] as Uint8Array;
    expect(unwrapInputArg.length).toBe(plaintext.length);
  });

  it('discards a snapshot whose leading byte does not match SNAPSHOT_VERSION and reinitialises', async () => {
    const worker = new DbWorker();
    const internal = worker as unknown as {
      loadFromOPFS: () => Promise<Uint8Array | null>;
      deleteFromOPFS: () => Promise<void>;
      runMigrations: () => Promise<void>;
    };

    // A "v1" snapshot would lack the version-byte prefix; emulate by
    // serving a blob whose first byte is 0x99 (≠ SNAPSHOT_VERSION).
    const v1Snapshot = new Uint8Array(64);
    v1Snapshot[0] = 0x99;
    vi.spyOn(internal, 'loadFromOPFS').mockResolvedValue(v1Snapshot);

    const deleteSpy = vi
      .spyOn(internal, 'deleteFromOPFS')
      .mockResolvedValue(undefined);
    const runMigrationsSpy = vi
      .spyOn(internal, 'runMigrations')
      .mockResolvedValue(undefined);

    const bridge = makePassthroughBridge();

    await expect(worker.init(bridge)).resolves.toBeUndefined();

    // Hard-migration policy: discard the stale snapshot, run migrations
    // against an empty DB, never invoke the bridge unwrap (the version
    // mismatch short-circuits decryption).
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(runMigrationsSpy).toHaveBeenCalledTimes(1);
    expect(bridge.unwrap).not.toHaveBeenCalled();
  });

  it('keeps the SNAPSHOT_DECRYPT_FAILED fail-closed path for a current-version snapshot whose unwrap rejects', async () => {
    const { DbWorkerErrorCode } = await import('../src/workers/db.worker');
    const worker = new DbWorker();
    const internal = worker as unknown as {
      loadFromOPFS: () => Promise<Uint8Array | null>;
    };

    // Properly-versioned envelope but the bridge's unwrap rejects (e.g.
    // genuine corruption / auth-tag mismatch).
    const versionedSnapshot = new Uint8Array(64);
    versionedSnapshot[0] = SNAPSHOT_VERSION;
    vi.spyOn(internal, 'loadFromOPFS').mockResolvedValue(versionedSnapshot);

    const bridge = {
      wrap: vi.fn(async (b: Uint8Array) => b),
      unwrap: vi.fn(async () => {
        throw new Error('authentication failed');
      }),
    } satisfies DbCryptoBridge & {
      wrap: ReturnType<typeof vi.fn>;
      unwrap: ReturnType<typeof vi.fn>;
    };

    await expect(worker.init(bridge)).rejects.toMatchObject({
      code: DbWorkerErrorCode.SNAPSHOT_DECRYPT_FAILED,
    });
    expect(bridge.unwrap).toHaveBeenCalledTimes(1);
  });
});
