/**
 * Worker black-box harness — Slice 0D test infrastructure
 *
 * Intent: every later slice (1-11) gets the same battle-tested entry point for
 * "boot the real crypto worker, exercise it across the Comlink boundary, prove
 * lifecycle invariants". Built **before** Slice 1 so the migration slices have
 * tests ready to land alongside their code.
 *
 * Capability detection
 * --------------------
 * The harness tries to spawn the production `crypto.worker.ts` via
 * `new Worker(new URL('../../src/workers/crypto.worker.ts', import.meta.url),
 * { type: 'module' })` and wrap it with `Comlink.wrap`. In a real browser
 * (and in vitest's `browser` mode) this just works.
 *
 * Vitest's default Node + happy-dom environment does **not** ship a Worker
 * implementation — happy-dom v20 omits it on purpose. In that environment the
 * harness factory returns `{ available: false, reason }` so callers can use
 * `it.skipIf(!harness.available)` instead of failing the suite. Slice 11
 * adds a parallel browser-mode test pass that flips these from skipped to
 * exercised; the harness API is identical in both cases so the migration
 * slices write tests once.
 *
 * Black-box only
 * --------------
 * Even when a worker is booted in-process during tests, the harness only ever
 * touches it through Comlink — no peeking inside private fields, no reaching
 * for module-level globals. That is the contract Slice 1 will lock in.
 */

import * as Comlink from 'comlink';
import type { CryptoWorkerApi } from '../../src/workers/types';

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

interface WorkerCapability {
  readonly hasWorker: boolean;
  readonly hasModuleWorker: boolean;
  readonly reason: string;
}

let cachedCapability: WorkerCapability | null = null;

export function detectWorkerCapability(): WorkerCapability {
  if (cachedCapability) return cachedCapability;
  // We don't actually probe-construct here — that would race with vite's
  // worker bundler. We only check the constructor exists.
  const w = (globalThis as { Worker?: unknown }).Worker;
  if (typeof w !== 'function') {
    cachedCapability = {
      hasWorker: false,
      hasModuleWorker: false,
      reason:
        'globalThis.Worker is not a constructor (happy-dom default — run vitest browser mode or wire up a worker_threads polyfill to exercise this path).',
    };
    return cachedCapability;
  }
  cachedCapability = {
    hasWorker: true,
    hasModuleWorker: true,
    reason: 'globalThis.Worker available',
  };
  return cachedCapability;
}

// Convenience helper for `it.skipIf(noWorker())` blocks.
export function noWorker(): boolean {
  return !detectWorkerCapability().hasWorker;
}

// ---------------------------------------------------------------------------
// Harness contract
// ---------------------------------------------------------------------------

/**
 * Stable error code returned when the harness reports that an operation was
 * issued against a closed handle / closed worker. Slice 1 will mint the
 * production-side equivalents; this constant gives the lifecycle tests a
 * stable string to assert against without coupling to a Slice-1 enum yet.
 */
export const CLOSED_HANDLE_ERROR_HINTS = [
  'closed',
  'terminated',
  'cleared',
  'not initialized',
  // Comlink itself surfaces port-closed errors with these substrings:
  'data clone error',
  'port closed',
] as const;

export interface UnavailableHarness {
  readonly available: false;
  readonly reason: string;
}

export interface AvailableHarness {
  readonly available: true;
  readonly api: Comlink.Remote<CryptoWorkerApi>;
  readonly worker: Worker;
  /** Termination — gracefully clears keys then terminates the underlying worker. */
  readonly terminate: () => Promise<void>;
  /** Force-terminates without calling clear (used by lifecycle tests for crash-mid-op). */
  readonly killNow: () => void;
  /** Best-effort no-secret-leak check; see assertNoRawSecrets below. */
  readonly assertNoRawSecrets: (
    options?: AssertNoRawSecretsOptions,
  ) => Promise<NoSecretsAssertionReport>;
  /** Lifecycle helpers — claim/exercise/close/double-close/use-after-close. */
  readonly lifecycleHarness: () => LifecycleHarness;
  /** Concurrency helpers — N parallel ops on the same handle, no deadlock. */
  readonly concurrencyHarness: () => ConcurrencyHarness;
  /**
   * Slice 1 — claim a fresh account handle for tests that need one. Uses
   * `unlockAccount` if `wrappedAccountKey` is supplied, otherwise creates
   * a new account via `createNewAccount`. Returns the handle ID and (for
   * the create flow) the wrapped account key bytes the caller must persist.
   */
  readonly claimAccountHandle: (
    opts?: ClaimAccountHandleOptions,
  ) => Promise<ClaimedAccountHandle>;
  /**
   * Slice 1 — claim an epoch handle bound to the supplied account handle.
   * Always uses `createEpochHandle` (returns wrappedSeed for re-open).
   */
  readonly claimEpochHandle: (
    accountHandleId: string,
    epochId?: number,
  ) => Promise<ClaimedEpochHandle>;
  /**
   * Slice 1 — assert that an operation against the given handle ID rejects
   * with a `WorkerCryptoErrorCode.ClosedHandle` or `StaleHandle` /
   * `HandleNotFound` error. Returns the error for further inspection.
   */
  readonly assertHandleIsClosed: (
    handleId: string,
    kind: 'account' | 'identity' | 'epoch',
  ) => Promise<{ code: number; message: string }>;
}

export type CryptoWorkerHarness = AvailableHarness | UnavailableHarness;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const WORKER_MODULE_URL = new URL(
  '../../src/workers/crypto.worker.ts',
  import.meta.url,
);

/**
 * Create a fresh harness. Each call boots a brand-new worker — callers that
 * need isolation between tests should call this in `beforeEach` and call
 * `terminate()` in `afterEach`.
 *
 * @param options.readyTimeoutMs - max wait for the worker to ack a no-op
 *   round-trip after construction (default 8000ms).
 */
export async function createCryptoWorkerHarness(options?: {
  readyTimeoutMs?: number;
}): Promise<CryptoWorkerHarness> {
  const cap = detectWorkerCapability();
  if (!cap.hasWorker) {
    return { available: false, reason: cap.reason };
  }

  const readyTimeoutMs = options?.readyTimeoutMs ?? 8000;

  let worker: Worker;
  try {
    worker = new Worker(WORKER_MODULE_URL, {
      type: 'module',
      name: 'mosaic-crypto-worker-harness',
    });
  } catch (err) {
    return {
      available: false,
      reason: `Worker construction failed: ${(err as Error).message}`,
    };
  }

  const api = Comlink.wrap<CryptoWorkerApi>(worker);

  // Confirm initialization. The current contract has no `ensureReady` method,
  // so we issue a cheap no-op that exercises the Comlink boundary: getDbSessionKey
  // returns null (or throws "not initialized") — both confirm the worker is
  // alive and responsive.
  try {
    await waitForRoundTrip(api, readyTimeoutMs);
  } catch (err) {
    try {
      worker.terminate();
    } catch {
      // ignore
    }
    return {
      available: false,
      reason: `Worker ready check failed: ${(err as Error).message}`,
    };
  }

  let terminated = false;
  const terminate = async (): Promise<void> => {
    if (terminated) return;
    terminated = true;
    try {
      await api.clear();
    } catch {
      // best-effort — worker may already be dead
    }
    try {
      worker.terminate();
    } catch {
      // ignore
    }
  };

  const killNow = (): void => {
    if (terminated) return;
    terminated = true;
    try {
      worker.terminate();
    } catch {
      // ignore
    }
  };

  return {
    available: true,
    api,
    worker,
    terminate,
    killNow,
    assertNoRawSecrets: (opts) => assertNoRawSecrets(api, opts),
    lifecycleHarness: () => buildLifecycleHarness(api),
    concurrencyHarness: () => buildConcurrencyHarness(api),
    claimAccountHandle: (opts) => claimAccountHandle(api, opts),
    claimEpochHandle: (accountHandleId, epochId) =>
      claimEpochHandle(api, accountHandleId, epochId),
    assertHandleIsClosed: (handleId, kind) =>
      assertHandleIsClosed(api, handleId, kind),
  };
}

async function waitForRoundTrip(
  api: Comlink.Remote<CryptoWorkerApi>,
  timeoutMs: number,
): Promise<void> {
  const probe = (async () => {
    // getIdentityPublicKey is safe pre-init: the current contract documents
    // it as returning null when no identity is derived yet. If the worker is
    // alive, this round-trip resolves quickly; if it's broken, it rejects.
    await api.getIdentityPublicKey();
  })();

  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(
      () => reject(new Error(`Comlink round-trip timed out after ${String(timeoutMs)}ms`)),
      timeoutMs,
    );
    void probe.finally(() => clearTimeout(t));
  });

  await Promise.race([probe, timeout]);
}

// ---------------------------------------------------------------------------
// No-secret-leakage heuristic
// ---------------------------------------------------------------------------

export interface AssertNoRawSecretsOptions {
  /**
   * If `init()` is required to populate the secret-bearing fields the harness
   * inspects, callers may pass a setup function that prepares the worker
   * (e.g. `init(weak password, salts)`).
   */
  readonly setup?: (api: Comlink.Remote<CryptoWorkerApi>) => Promise<void>;
}

export interface NoSecretsAssertionReport {
  readonly inspectedMethods: ReadonlyArray<string>;
  /**
   * Methods that returned a Uint8Array. We classify the bytes as "expected
   * opaque" — they may be public (identity pubkey) or wrapped (account key)
   * but must never be the same bytes as a known plaintext seed. The bench
   * suite cross-checks the worst case: that exporting and re-importing keys
   * doesn't reveal the underlying L0/L1/L2 plaintext.
   */
  readonly opaqueByteSamples: ReadonlyArray<{
    readonly method: string;
    readonly byteLen: number;
    readonly entropyEstimate: number;
  }>;
  /**
   * Methods that the harness *would* like to call but Slice 1 hasn't yet
   * minted a TS-side runner for. Tracked so future slices know what to fill in.
   */
  readonly skippedMethods: ReadonlyArray<{
    readonly method: string;
    readonly reason: string;
  }>;
}

const SECRET_BEARING_METHODS: ReadonlyArray<{
  name: keyof CryptoWorkerApi;
  /** A textual reason why we expect the bytes to be opaque/public/wrapped. */
  classification: 'public' | 'wrapped' | 'random';
}> = [
  { name: 'getWrappedAccountKey', classification: 'wrapped' },
  { name: 'getIdentityPublicKey', classification: 'public' },
  { name: 'getAuthPublicKey', classification: 'public' },
  // Slice 2 renamed `getSessionKey` → `getDbSessionKey`. The bytes are
  // still random and only emitted while the worker is initialised; the
  // harness keeps treating them as opaque.
  { name: 'getDbSessionKey', classification: 'random' },
];

async function assertNoRawSecrets(
  api: Comlink.Remote<CryptoWorkerApi>,
  options?: AssertNoRawSecretsOptions,
): Promise<NoSecretsAssertionReport> {
  if (options?.setup) {
    await options.setup(api);
  }

  const inspectedMethods: string[] = [];
  const opaqueByteSamples: NoSecretsAssertionReport['opaqueByteSamples'] = [];
  const skippedMethods: NoSecretsAssertionReport['skippedMethods'] = [];

  for (const { name, classification } of SECRET_BEARING_METHODS) {
    inspectedMethods.push(name as string);
    let result: unknown;
    try {
      // The current legacy methods accept zero args — Slice 1 will narrow this
      // shape. We deliberately call without args to detect any caller path
      // that breaks under that assumption.
      const fn = api[name] as unknown as () => Promise<unknown>;
      result = await fn();
    } catch (err) {
      (skippedMethods as Array<NoSecretsAssertionReport['skippedMethods'][number]>).push({
        method: name as string,
        reason: `threw before init: ${(err as Error).message}`,
      });
      continue;
    }

    if (result === null || result === undefined) {
      (skippedMethods as Array<NoSecretsAssertionReport['skippedMethods'][number]>).push({
        method: name as string,
        reason: `returned ${result === null ? 'null' : 'undefined'} (worker not initialized)`,
      });
      continue;
    }

    if (result instanceof Uint8Array) {
      const sample = sampleBytes(result);
      (opaqueByteSamples as Array<NoSecretsAssertionReport['opaqueByteSamples'][number]>).push({
        method: name as string,
        byteLen: result.length,
        entropyEstimate: sample.entropyEstimate,
      });
      // For wrapped/random classifications, low entropy is a smell.
      if (classification !== 'public' && sample.entropyEstimate < 3.0 && result.length >= 16) {
        throw new Error(
          `assertNoRawSecrets: ${name as string} returned ${String(result.length)} bytes with low entropy (${sample.entropyEstimate.toFixed(2)} bits/byte) — likely leaking constant or zero data.`,
        );
      }
    } else {
      // Future-proofing: allow handle objects/structures; we only fail on
      // explicit Uint8Array fields nested at top level.
      const inspected = inspectObjectForRawSecrets(result);
      if (inspected.foundRawSecret) {
        throw new Error(
          `assertNoRawSecrets: ${name as string} returned a structure containing nested Uint8Array(s) suspicious of raw key leakage. Path: ${inspected.path}.`,
        );
      }
    }
  }

  return {
    inspectedMethods,
    opaqueByteSamples,
    skippedMethods,
  };
}

function sampleBytes(bytes: Uint8Array): { entropyEstimate: number } {
  if (bytes.length === 0) return { entropyEstimate: 0 };
  const counts = new Uint32Array(256);
  for (let i = 0; i < bytes.length; i++) counts[bytes[i]!]++;
  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    if (counts[i]! === 0) continue;
    const p = counts[i]! / bytes.length;
    entropy -= p * Math.log2(p);
  }
  return { entropyEstimate: entropy };
}

function inspectObjectForRawSecrets(
  value: unknown,
  path = '',
): { foundRawSecret: boolean; path: string } {
  if (value instanceof Uint8Array) {
    const stats = sampleBytes(value);
    if (value.length >= 32 && stats.entropyEstimate > 6.5) {
      return { foundRawSecret: true, path: `${path} (${String(value.length)}B, ${stats.entropyEstimate.toFixed(2)} bits/byte)` };
    }
    return { foundRawSecret: false, path };
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const inner = inspectObjectForRawSecrets(value[i], `${path}[${String(i)}]`);
      if (inner.foundRawSecret) return inner;
    }
    return { foundRawSecret: false, path };
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const inner = inspectObjectForRawSecrets(
        (value as Record<string, unknown>)[key],
        path === '' ? key : `${path}.${key}`,
      );
      if (inner.foundRawSecret) return inner;
    }
    return { foundRawSecret: false, path };
  }
  return { foundRawSecret: false, path };
}

// ---------------------------------------------------------------------------
// Lifecycle harness — Slice 1 deliverable, exposed early so 0D tests can
// codify the contract.
// ---------------------------------------------------------------------------

export interface LifecycleHarness {
  /**
   * Initialize a session with weak Argon2 params (E2E mode). Returns true
   * once `getDbSessionKey()` produces non-null bytes.
   */
  readonly bringToInitialized: (
    password?: string,
    userSalt?: Uint8Array,
    accountSalt?: Uint8Array,
  ) => Promise<boolean>;
  /** Idempotent close — calls `clear()` repeatedly and returns success count. */
  readonly closeIdempotent: (rounds: number) => Promise<number>;
  /**
   * After `clear()` was called, attempt an operation that requires init and
   * return the resulting `Error`. Slice 1 will lock the message to a stable
   * code; for now we just confirm the call rejects/resolves in a recognizable
   * way (see CLOSED_HANDLE_ERROR_HINTS).
   */
  readonly observeUseAfterClose: () => Promise<Error | null>;
}

function buildLifecycleHarness(
  api: Comlink.Remote<CryptoWorkerApi>,
): LifecycleHarness {
  return {
    async bringToInitialized(password = 'lifecycle-test-pw', userSalt, accountSalt) {
      const us = userSalt ?? makeFixedSalt(0x11);
      const as = accountSalt ?? makeFixedSalt(0x22);
      await api.init(password, us, as);
      const key = await api.getDbSessionKey();
      return key instanceof Uint8Array && key.length === 32;
    },
    async closeIdempotent(rounds: number) {
      let okCount = 0;
      for (let i = 0; i < rounds; i++) {
        try {
          await api.clear();
          okCount += 1;
        } catch {
          // count as failure but don't throw — idempotency rule says repeat
          // close should not raise.
        }
      }
      return okCount;
    },
    async observeUseAfterClose() {
      try {
        // After clear(), getDbSessionKey should reject with a "not initialized"
        // -shaped error. We treat both reject and a "null" result as
        // observable, but reject is the contract Slice 1 will enforce.
        const result = await api.getDbSessionKey();
        if (result === null || result === undefined) {
          // current legacy behaviour returns null; surface it as an Error
          // so the test can assert on either branch.
          return new Error('null returned (legacy soft-fail)');
        }
        return null;
      } catch (err) {
        return err as Error;
      }
    },
  };
}

function makeFixedSalt(seed: number): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = (seed + i) & 0xff;
  return out;
}

// ---------------------------------------------------------------------------
// Concurrency harness
// ---------------------------------------------------------------------------

export interface ConcurrencyHarness {
  /**
   * Issue `parallelism` × `iterations` calls to a non-stateful method on the
   * same Comlink channel and verify all promises settle.
   *
   * Returns wall-clock plus a settled-results breakdown so callers can
   * detect deadlocks (timeout) or aliasing (mismatched results).
   */
  readonly fanOutNoOp: (
    parallelism: number,
    iterations: number,
    timeoutMs?: number,
  ) => Promise<{
    fulfilled: number;
    rejected: number;
    elapsedMs: number;
  }>;
}

function buildConcurrencyHarness(
  api: Comlink.Remote<CryptoWorkerApi>,
): ConcurrencyHarness {
  return {
    async fanOutNoOp(parallelism, iterations, timeoutMs = 30000) {
      const start = performance.now();
      const all: Array<Promise<unknown>> = [];
      for (let p = 0; p < parallelism; p++) {
        for (let i = 0; i < iterations; i++) {
          all.push(api.getIdentityPublicKey());
        }
      }

      const settled = await Promise.race<
        | PromiseSettledResult<unknown>[]
        | { __timeout: true }
      >([
        Promise.allSettled(all),
        new Promise((resolve) => {
          setTimeout(() => resolve({ __timeout: true }), timeoutMs);
        }),
      ]);

      if ('__timeout' in settled) {
        throw new Error(
          `concurrencyHarness.fanOutNoOp: deadlock — ${String(parallelism * iterations)} calls did not settle within ${String(timeoutMs)}ms`,
        );
      }

      let fulfilled = 0;
      let rejected = 0;
      for (const r of settled) {
        if (r.status === 'fulfilled') fulfilled += 1;
        else rejected += 1;
      }
      const elapsedMs = performance.now() - start;
      return { fulfilled, rejected, elapsedMs };
    },
  };
}

// ---------------------------------------------------------------------------
// Slice 1 handle helpers — used by handle-lifecycle tests.
// ---------------------------------------------------------------------------

export interface ClaimAccountHandleOptions {
  readonly password?: string;
  readonly userSalt?: Uint8Array;
  readonly accountSalt?: Uint8Array;
  /** When supplied, calls `unlockAccount`. Otherwise calls `createNewAccount`. */
  readonly wrappedAccountKey?: Uint8Array;
  readonly kdf?: { memoryKib: number; iterations: number; parallelism: number };
}

export interface ClaimedAccountHandle {
  readonly accountHandleId: string;
  /** Present only when the helper called `createNewAccount`. */
  readonly wrappedAccountKey?: Uint8Array;
}

export interface ClaimedEpochHandle {
  readonly epochHandleId: string;
  readonly wrappedSeed: Uint8Array;
  readonly epochId: number;
}

/**
 * Default Argon2 params for tests. With `VITE_E2E_WEAK_KEYS=true` the
 * worker's `getArgon2Params()` already returns these or weaker, but the
 * Slice 1 handle methods accept the params explicitly so tests can stay
 * deterministic across config changes.
 */
const DEFAULT_TEST_KDF = {
  memoryKib: 8192,
  iterations: 1,
  parallelism: 1,
} as const;

async function claimAccountHandle(
  api: Comlink.Remote<CryptoWorkerApi>,
  opts: ClaimAccountHandleOptions = {},
): Promise<ClaimedAccountHandle> {
  const password = opts.password ?? 'harness-pw';
  const userSalt = opts.userSalt ?? makeFixedSalt(0x55);
  const accountSalt = opts.accountSalt ?? makeFixedSalt(0x66);
  const kdf = opts.kdf ?? DEFAULT_TEST_KDF;

  if (opts.wrappedAccountKey) {
    const out = await api.unlockAccount({
      password,
      userSalt,
      accountSalt,
      wrappedAccountKey: opts.wrappedAccountKey,
      kdf,
    });
    return { accountHandleId: out.accountHandleId };
  }

  const out = await api.createNewAccount({
    password,
    userSalt,
    accountSalt,
    kdf,
  });
  return {
    accountHandleId: out.accountHandleId,
    wrappedAccountKey: out.wrappedAccountKey,
  };
}

async function claimEpochHandle(
  api: Comlink.Remote<CryptoWorkerApi>,
  accountHandleId: string,
  epochId = 1,
): Promise<ClaimedEpochHandle> {
  const out = await api.createEpochHandle(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    accountHandleId as any,
    epochId,
  );
  return {
    epochHandleId: out.epochHandleId,
    wrappedSeed: out.wrappedSeed,
    epochId,
  };
}

async function assertHandleIsClosed(
  api: Comlink.Remote<CryptoWorkerApi>,
  handleId: string,
  kind: 'account' | 'identity' | 'epoch',
): Promise<{ code: number; message: string }> {
  // Pick an op for each kind that goes through `withLease` and so will
  // surface ClosedHandle / StaleHandle / HandleNotFound deterministically.
  const probe = async (): Promise<unknown> => {
    switch (kind) {
      case 'account':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await api.getAuthPublicKeyForAccount(handleId as any);
      case 'identity':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await api.signManifestWithIdentity(handleId as any, new Uint8Array(8));
      case 'epoch':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await api.encryptShardWithEpoch(handleId as any, new Uint8Array(8), 0, 0);
    }
  };

  let err: unknown = null;
  try {
    await probe();
  } catch (caught) {
    err = caught;
  }
  if (err === null) {
    throw new Error(
      `assertHandleIsClosed: ${kind} handle ${handleId} did not reject — operation succeeded`,
    );
  }
  const e = err as { code?: unknown; message?: unknown };
  return {
    code: typeof e.code === 'number' ? e.code : -1,
    message: typeof e.message === 'string' ? e.message : String(err),
  };
}
