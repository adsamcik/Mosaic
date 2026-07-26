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
 *      `SNAPSHOT_VERSION` is rebuilt only after the independent replay-
 *      security sidecar authenticates. A missing or corrupt sidecar fails
 *      closed and requires explicit Clear Local Data.
 *
 * Uses a stubbed bridge whose wrap/unwrap are XOR-based — sufficient to
 * exercise the persistence codepath without booting the real crypto
 * worker, while still proving the wrap/unwrap callbacks are wired
 * through the worker's encryptBlob / decryptBlob seams.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transferHandlers: new Map(),
}));

vi.mock('fts5-sql-bundle', () => ({
  default: vi.fn(async () => ({
    Database: class Database {
      close() {}
      run() {}
      exec() {
        return [];
      }
      export() {
        return new Uint8Array([1, 2, 3, 4]);
      }
      prepare() {
        return { run() {}, free() {} };
      }
    },
  })),
}));

import {
  DbWorker,
  DbWorkerErrorCode,
  SNAPSHOT_VERSION,
} from '../src/workers/db.worker';
import type {
  AlbumEpochHighWaterMark,
  DbCryptoBridge,
  ManifestReplayCheckpoint,
  ManifestSeqHighWaterMark,
} from '../src/workers/types';

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

type ReplaySecurityState = {
  epochHighWaters: Map<string, AlbumEpochHighWaterMark>;
  highWaters: Map<string, ManifestSeqHighWaterMark>;
  checkpoints: Map<string, ManifestReplayCheckpoint>;
};

type ReplaySecurityInternals = {
  applySecurityCandidates(
    base: ReplaySecurityState,
    highWaters: readonly ManifestSeqHighWaterMark[],
    checkpoints: readonly ManifestReplayCheckpoint[],
    epochHighWaters: readonly AlbumEpochHighWaterMark[],
  ): ReplaySecurityState;
  serializeSecurityState(state: ReplaySecurityState): Uint8Array;
};

describe('DbWorker — replay-security sidecar state', () => {
  const albumId = 'album-1';
  const signerA = 'aa'.repeat(32);
  const signerB = 'bb'.repeat(32);
  const epochA = { albumId, epochId: 7, signerKey: signerA } as const;
  const floorA = { albumId, signerKey: signerA, manifestSeq: 10 } as const;
  const headA = {
    albumId,
    signerKey: signerA,
    epochId: 7,
    manifestId: 'manifest-1',
    manifestSeq: 10,
    operationKind: 'Live',
    signatureFingerprint: '11'.repeat(64),
  } as const;

  function internals(): ReplaySecurityInternals {
    return new DbWorker() as unknown as ReplaySecurityInternals;
  }

  function emptyState(): ReplaySecurityState {
    return {
      epochHighWaters: new Map(),
      highWaters: new Map(),
      checkpoints: new Map(),
    };
  }

  it('rejects epoch/key rebinding, global sequence regression, and conflicting exact heads', () => {
    const worker = internals();
    const state = worker.applySecurityCandidates(
      emptyState(),
      [floorA],
      [headA],
      [epochA],
    );

    expect(() =>
      worker.applySecurityCandidates(
        state,
        [],
        [],
        [{ ...epochA, epochId: 6 }],
      ),
    ).toThrow(/epoch would regress/i);
    expect(() =>
      worker.applySecurityCandidates(
        state,
        [],
        [],
        [{ ...epochA, signerKey: signerB }],
      ),
    ).toThrow(/bound to a different key/i);
    expect(() =>
      worker.applySecurityCandidates(
        state,
        [{ ...floorA, manifestSeq: 9 }],
        [],
        [epochA],
      ),
    ).toThrow(/durable high-water/i);
    expect(() =>
      worker.applySecurityCandidates(
        state,
        [],
        [{ ...headA, signatureFingerprint: '22'.repeat(64) }],
        [epochA],
      ),
    ).toThrow(/different signed state/i);
  });

  it('accepts an exact head and lets a higher authenticated epoch supersede it', () => {
    const worker = internals();
    const initial = worker.applySecurityCandidates(
      emptyState(),
      [floorA],
      [headA],
      [epochA],
    );
    const exact = worker.applySecurityCandidates(
      initial,
      [],
      [headA],
      [epochA],
    );
    const epochB = { albumId, epochId: 8, signerKey: signerB } as const;
    const floorB = { albumId, signerKey: signerB, manifestSeq: 1 } as const;
    const headB = {
      ...headA,
      epochId: 8,
      signerKey: signerB,
      manifestSeq: 1,
      signatureFingerprint: '33'.repeat(64),
    } as const;
    const advanced = worker.applySecurityCandidates(
      exact,
      [floorB],
      [headB],
      [epochB],
    );

    expect(advanced.epochHighWaters.get(albumId)).toEqual(epochB);
    expect(
      advanced.checkpoints.get(`${albumId}\u0000${headA.manifestId}`),
    ).toEqual(headB);
    expect(
      JSON.parse(
        new TextDecoder().decode(worker.serializeSecurityState(advanced)),
      ),
    ).toMatchObject({
      magic: 'MOSAIC_SECURITY_STATE',
      version: 1,
    });
  });
  it('accepts historical checkpoints under a newer album floor without regressing it', () => {
    const worker = internals();
    const epochB = { albumId, epochId: 8, signerKey: signerB } as const;
    const current = worker.applySecurityCandidates(
      emptyState(),
      [],
      [],
      [epochB],
    );
    const withHistoricalHead = worker.applySecurityCandidates(
      current,
      [floorA],
      [headA],
      [],
    );

    expect(withHistoricalHead.epochHighWaters.get(albumId)).toEqual(epochB);
    expect(
      withHistoricalHead.checkpoints.get(`${albumId}\u0000${headA.manifestId}`),
    ).toEqual(headA);
    expect(() =>
      worker.applySecurityCandidates(
        withHistoricalHead,
        [],
        [{ ...headA, manifestId: 'future', epochId: 9 }],
        [],
      ),
    ).toThrow(/authenticated album epoch floor/i);
    expect(() =>
      worker.applySecurityCandidates(
        withHistoricalHead,
        [],
        [{ ...headA, manifestId: 'rebound', epochId: 8 }],
        [],
      ),
    ).toThrow(/authenticated album epoch floor/i);
  });
});

describe('DbWorker — OPFS snapshot wrap/unwrap', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not misclassify a cache read failure as an absent cache', async () => {
    const worker = new DbWorker();
    const internal = worker as unknown as {
      loadFromOPFS: () => Promise<Uint8Array | null>;
    };
    const readFailure = new Error('OPFS access denied');
    readFailure.name = 'SecurityError';
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockRejectedValue(readFailure),
      },
    });

    await expect(internal.loadFromOPFS()).rejects.toBe(readFailure);
  });

  it('requires Web Locks whenever persistent OPFS is available', async () => {
    const worker = new DbWorker();
    const internal = worker as unknown as {
      withSecurityStateLock<T>(operation: () => Promise<T>): Promise<T>;
    };
    const operation = vi.fn(async () => 'unlocked');
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn(),
      },
    });

    await expect(internal.withSecurityStateLock(operation)).rejects.toThrow(
      /Web Locks are required/i,
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it('takes an exclusive cross-worker lock for persistent security state', async () => {
    const worker = new DbWorker();
    const internal = worker as unknown as {
      withSecurityStateLock<T>(operation: () => Promise<T>): Promise<T>;
    };
    const request = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        operation: () => Promise<string>,
      ) => operation(),
    );
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn(),
      },
      locks: { request },
    });

    await expect(
      internal.withSecurityStateLock(async () => 'locked'),
    ).resolves.toBe('locked');
    expect(request).toHaveBeenCalledWith(
      'mosaic-security-state-v1',
      { mode: 'exclusive' },
      expect.any(Function),
    );
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
      saveToOPFS: () => Promise<void>;
      runMigrations: () => Promise<void>;
    };

    // A "v1" snapshot would lack the version-byte prefix; emulate by
    // serving a blob whose first byte is 0x99 (≠ SNAPSHOT_VERSION).
    const v1Snapshot = new Uint8Array(64);
    v1Snapshot[0] = 0x99;
    vi.spyOn(internal, 'loadFromOPFS').mockResolvedValue(v1Snapshot);

    const saveSpy = vi
      .spyOn(internal, 'saveToOPFS')
      .mockResolvedValue(undefined);
    const runMigrationsSpy = vi
      .spyOn(internal, 'runMigrations')
      .mockResolvedValue(undefined);

    const bridge = makePassthroughBridge();

    await expect(worker.init(bridge)).resolves.toBeUndefined();

    // The authenticated security sidecar makes this file disposable.
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(runMigrationsSpy).toHaveBeenCalledTimes(1);
    expect(bridge.unwrap).not.toHaveBeenCalled();
  });

  it('rebuilds a current-version cache whose unwrap rejects', async () => {
    const worker = new DbWorker();
    const internal = worker as unknown as {
      loadFromOPFS: () => Promise<Uint8Array | null>;
      runMigrations: () => Promise<void>;
      saveToOPFS: () => Promise<void>;
    };

    // Properly-versioned envelope but the bridge's unwrap rejects (e.g.
    // genuine corruption / auth-tag mismatch).
    const versionedSnapshot = new Uint8Array(64);
    versionedSnapshot[0] = SNAPSHOT_VERSION;
    vi.spyOn(internal, 'loadFromOPFS').mockResolvedValue(versionedSnapshot);

    vi.spyOn(internal, 'runMigrations').mockResolvedValue(undefined);
    const saveSpy = vi
      .spyOn(internal, 'saveToOPFS')
      .mockResolvedValue(undefined);

    const bridge = {
      wrap: vi.fn(async (b: Uint8Array) => b),
      unwrap: vi.fn(async () => {
        throw new Error('authentication failed');
      }),
    } satisfies DbCryptoBridge & {
      wrap: ReturnType<typeof vi.fn>;
      unwrap: ReturnType<typeof vi.fn>;
    };

    await expect(worker.init(bridge)).resolves.toBeUndefined();
    expect(bridge.unwrap).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a cache exists but its security sidecar is missing', async () => {
    const worker = new DbWorker();
    const internal = worker as unknown as {
      loadFromOPFS: () => Promise<Uint8Array | null>;
      readSecurityStateFromOPFS: () => Promise<unknown>;
      decryptBlob: (data: Uint8Array) => Promise<Uint8Array>;
    };
    vi.spyOn(internal, 'loadFromOPFS').mockResolvedValue(
      new Uint8Array([SNAPSHOT_VERSION, 1, 2, 3]),
    );
    vi.spyOn(internal, 'readSecurityStateFromOPFS').mockResolvedValue(null);
    const decryptSpy = vi.spyOn(internal, 'decryptBlob');

    await expect(worker.init(makePassthroughBridge())).rejects.toMatchObject({
      code: DbWorkerErrorCode.RESET_REQUIRED,
    });
    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it('fails closed before cache recovery when the security sidecar is corrupt', async () => {
    const worker = new DbWorker();
    const internal = worker as unknown as {
      loadFromOPFS: () => Promise<Uint8Array | null>;
      readSecurityStateFromOPFS: () => Promise<unknown>;
      runMigrations: () => Promise<void>;
    };
    vi.spyOn(internal, 'loadFromOPFS').mockResolvedValue(null);
    vi.spyOn(internal, 'readSecurityStateFromOPFS').mockRejectedValue(
      new Error('security authentication failed'),
    );
    const migrationSpy = vi.spyOn(internal, 'runMigrations');

    await expect(worker.init(makePassthroughBridge())).rejects.toMatchObject({
      code: DbWorkerErrorCode.RESET_REQUIRED,
    });
    expect(migrationSpy).not.toHaveBeenCalled();
  });
});
