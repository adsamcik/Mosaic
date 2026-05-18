/**
 * Crypto-worker handle registry.
 *
 * Extracted from `crypto.worker.ts` (Sweep 39). Manages the lifetime of
 * Rust-owned WASM handles (account, identity, epoch, link-share,
 * link-tier) inside the crypto worker. The CryptoWorker class owns a
 * single instance of {@link HandleRegistry} and delegates all handle
 * lifecycle / lease operations to it.
 *
 * See the "Slice 1 — Handle registry & lifetime semantics" block below
 * for the full lifetime contract (lease semantics, generation counter,
 * cascade order, idempotent close, etc).
 */
import sodium from 'libsodium-wrappers-sumo';
import { createLogger } from '../../lib/logger';
import { WorkerCryptoError, WorkerCryptoErrorCode } from '../types';
import type { RustHandleFacade } from '../rust-crypto-core';

const log = createLogger('CryptoWorker.HandleRegistry');

// =============================================================================
// Slice 1 — Handle registry & lifetime semantics
// =============================================================================
//
// Lifetime invariants — Slice 1 contract:
//
//  - Handle IDs are stable opaque strings of the form
//    `acct_<12b64url>` / `idnt_<12b64url>` / `epch_<12b64url>`. They are
//    minted by the worker and meaningful only inside the worker; callers
//    treat them as opaque.
//
//  - Each handle carries a generation counter incremented on every
//    `clearAll()` cycle. Operations that present a handle with the wrong
//    generation reject with `WorkerCryptoErrorCode.StaleHandle`.
//
//  - Operations on a handle take a refcounted *lease* (`withLease`).
//    Closing a handle while a lease is held marks it closed but defers
//    the actual WASM `closeXxxHandle` call until the last lease drops.
//    No timeouts on leases — they release when the wrapped callback
//    settles. Promise rejections still drop the lease (finally block).
//
//  - `closeHandle` is idempotent. Double-close (or close after `clear()`)
//    is a silent no-op.
//
//  - `clearAll()` (invoked by `clear()`) cascades closures in the order:
//        epoch → identity → account.
//    This ordering matches the dependency order: epoch handles reference
//    the account, identity handles reference the account, so children
//    must close first. The generation counter increments AFTER the
//    cascade so handles minted before the cycle become stale.
//
//  - Worker termination: callers should always `await api.clear()` before
//    calling `worker.terminate()`. If they don't, in-flight Comlink calls
//    reject with whatever the runtime surfaces (typically a port-closed
//    error) — `clearAll()` is the only deterministic shutdown path.
//
//  - `init()` / `unlockAccount()` called twice is idempotent: the prior
//    state is `clearAll()`-ed first, so the second call always wins. This
//    matches the React Strict Mode double-mount expectation.
//
//  - Concurrency: shard encrypt/decrypt is parallelizable (multiple
//    concurrent leases on one epoch handle are allowed). Account unlock,
//    identity creation, and epoch creation/open are serialized inside
//    Rust (the underlying handle table is mutex-guarded). The worker does
//    not add extra serialization on top.
//
//  - Generation rollover: counter is `number` (~2^53 capacity); a sustained
//    1000 cycles/sec workload would still take >285k years to wrap. We do
//    not implement explicit rollover handling.
// =============================================================================

export type WasmHandleKind = 'account' | 'identity' | 'epoch' | 'linkShare' | 'linkTier';

export interface WasmHandle {
  /** Stable string ID exposed across Comlink. */
  readonly id: string;
  /** Underlying Rust bigint from wasm-bindgen. */
  readonly rustHandle: bigint;
  /** Generation counter — incremented on every `clearAll()`. */
  readonly generation: number;
  /** Type discriminator for asserts/telemetry. */
  readonly kind: WasmHandleKind;
  /** Closed flag. Operations on closed handles return ClosedHandle. */
  closed: boolean;
  /** Active leases (in-flight ops). Close defers free until count==0. */
  leaseCount: number;
}

const HANDLE_PREFIX_BY_KIND: Record<WasmHandleKind, string> = {
  account: 'acct',
  identity: 'idnt',
  epoch: 'epch',
  linkShare: 'lnks',
  linkTier: 'lnkt',
};

function mintHandleId(kind: WasmHandleKind): string {
  // 12 random bytes → 16-char base64url. Plenty of collision resistance for
  // a single-worker registry.
  const bytes = sodium.randombytes_buf(12);
  const id = sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
  return `${HANDLE_PREFIX_BY_KIND[kind]}_${id}`;
}

function epochKey(albumId: string, epochId: number): string {
  return `${albumId}|${String(epochId)}`;
}

export class HandleRegistry {
  /** Singleton account handle. */
  private accountHandle: WasmHandle | null = null;
  /** Singleton identity handle (child of account). */
  private identityHandle: WasmHandle | null = null;
  /**
   * Epoch handles keyed by `${albumId}|${epochId}`. albumId is empty when
   * the registry is used pre-album-binding (Slice 1 contract supports
   * unkeyed lookup via `lookupById`).
   */
  private epochHandles = new Map<string, WasmHandle>();
  private linkHandles = new Map<string, WasmHandle>();
  /** Index from id → handle for fast lookup across all kinds. */
  private byId = new Map<string, WasmHandle>();
  /**
   * Monotonic generation. Incremented after every `clearAll()`. Handles
   * minted under generation N never resolve under generation N+1 even if
   * a numeric collision occurred (b64url collisions are astronomically
   * unlikely; this provides defense in depth).
   */
  private generation = 0;

  constructor(private readonly facade: () => Promise<RustHandleFacade>) {}

  stats(): {
    account: number;
    identity: number;
    epoch: number;
    link: number;
    total: number;
    generation: number;
  } {
    const account = this.accountHandle && !this.accountHandle.closed ? 1 : 0;
    const identity = this.identityHandle && !this.identityHandle.closed ? 1 : 0;
    const epoch = Array.from(this.epochHandles.values()).filter((handle) => !handle.closed).length;
    const link = Array.from(this.linkHandles.values()).filter((handle) => !handle.closed).length;
    return {
      account,
      identity,
      epoch,
      link,
      total: account + identity + epoch + link,
      generation: this.generation,
    };
  }

  // -- account ------------------------------------------------------------

  registerAccount(rustHandle: bigint): WasmHandle {
    if (this.accountHandle && !this.accountHandle.closed) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.InternalStatePoisoned,
        'attempted to register a second open account handle without clearing the first',
      );
    }
    const id = mintHandleId('account');
    const handle: WasmHandle = {
      id,
      rustHandle,
      generation: this.generation,
      kind: 'account',
      closed: false,
      leaseCount: 0,
    };
    this.accountHandle = handle;
    this.byId.set(id, handle);
    return handle;
  }

  getAccount(): WasmHandle | null {
    return this.accountHandle && !this.accountHandle.closed
      ? this.accountHandle
      : null;
  }

  getIdentity(): WasmHandle | null {
    return this.identityHandle && !this.identityHandle.closed
      ? this.identityHandle
      : null;
  }

  // -- identity -----------------------------------------------------------

  registerIdentity(rustHandle: bigint): WasmHandle {
    if (this.identityHandle && !this.identityHandle.closed) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.InternalStatePoisoned,
        'attempted to register a second open identity handle without closing the first',
      );
    }
    const id = mintHandleId('identity');
    const handle: WasmHandle = {
      id,
      rustHandle,
      generation: this.generation,
      kind: 'identity',
      closed: false,
      leaseCount: 0,
    };
    this.identityHandle = handle;
    this.byId.set(id, handle);
    return handle;
  }

  // -- epoch --------------------------------------------------------------

  registerEpoch(albumId: string, epochId: number, rustHandle: bigint): WasmHandle {
    const id = mintHandleId('epoch');
    const handle: WasmHandle = {
      id,
      rustHandle,
      generation: this.generation,
      kind: 'epoch',
      closed: false,
      leaseCount: 0,
    };
    this.epochHandles.set(epochKey(albumId, epochId), handle);
    this.byId.set(id, handle);
    return handle;
  }

  getEpochByAlbumEpoch(albumId: string, epochId: number): WasmHandle | null {
    const handle = this.epochHandles.get(epochKey(albumId, epochId));
    return handle && !handle.closed ? handle : null;
  }


  registerLinkShare(rustHandle: bigint): WasmHandle {
    const id = mintHandleId('linkShare');
    const handle: WasmHandle = {
      id,
      rustHandle,
      generation: this.generation,
      kind: 'linkShare',
      closed: false,
      leaseCount: 0,
    };
    this.linkHandles.set(id, handle);
    this.byId.set(id, handle);
    return handle;
  }

  registerLinkTier(rustHandle: bigint): WasmHandle {
    const id = mintHandleId('linkTier');
    const handle: WasmHandle = {
      id,
      rustHandle,
      generation: this.generation,
      kind: 'linkTier',
      closed: false,
      leaseCount: 0,
    };
    this.linkHandles.set(id, handle);
    this.byId.set(id, handle);
    return handle;
  }

  // -- lookup with lease --------------------------------------------------

  /**
   * Resolve a handle ID and run `callback` while holding a lease. The
   * callback receives the Rust handle. On callback completion the lease
   * decrements; if `closeHandle` was called during the lease, the
   * underlying Rust handle is freed when the last lease drops.
   *
   * Throws `HandleNotFound` / `HandleWrongKind` / `ClosedHandle` /
   * `StaleHandle` per the Slice 1 contract.
   */
  async withLease<T>(
    handleId: string,
    expectedKind: WasmHandleKind,
    callback: (rustHandle: bigint) => Promise<T> | T,
  ): Promise<T> {
    const handle = this.byId.get(handleId);
    if (!handle) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.HandleNotFound,
        `handle ID ${handleId} is not registered`,
      );
    }
    if (handle.kind !== expectedKind) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.HandleWrongKind,
        `handle ID ${handleId} resolves to kind ${handle.kind}, expected ${expectedKind}`,
      );
    }
    if (handle.generation !== this.generation) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.StaleHandle,
        `handle ID ${handleId} was minted in generation ${String(handle.generation)} but registry is at ${String(this.generation)}`,
      );
    }
    if (handle.closed) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.ClosedHandle,
        `handle ID ${handleId} has been closed`,
      );
    }

    handle.leaseCount += 1;
    try {
      return await callback(handle.rustHandle);
    } finally {
      handle.leaseCount -= 1;
      if (handle.closed && handle.leaseCount === 0) {
        await this.freeRustHandle(handle).catch((err: unknown) => {
          // Free errors after a deferred close are non-fatal — log and
          // continue. The handle is already removed from `byId`.
          log.warn('deferred handle free failed', {
            handleId,
            kind: handle.kind,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  }

  /**
   * Mark a handle closed and free it if no leases are held. Idempotent —
   * double-close, close-after-clear, and close on an already-stale handle
   * all succeed silently.
   */
  async closeHandle(handleId: string, expectedKind: WasmHandleKind): Promise<void> {
    const handle = this.byId.get(handleId);
    if (!handle) return; // Idempotent: unknown ID is a no-op.
    if (handle.kind !== expectedKind) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.HandleWrongKind,
        `closeHandle: handle ${handleId} is kind ${handle.kind}, expected ${expectedKind}`,
      );
    }
    if (handle.closed) return; // Already closed.
    handle.closed = true;
    if (handle.leaseCount === 0) {
      await this.freeRustHandle(handle);
    }
    // else: deferred until the last lease drops in withLease's finally.
  }

  /**
   * Cascade-close every handle and bump the generation. Any handle ID
   * minted before this call resolves to `StaleHandle` afterwards.
   *
   * Cascade order: epoch → identity → account. This matches the dependency
   * graph: epoch and identity both reference the account-key handle, so
   * the account must outlive both during teardown. Order within a cohort
   * doesn't matter for correctness.
   */
  async clearAll(): Promise<void> {
    // 1. Close link handles first (independent Rust-owned link state).
    for (const handle of this.linkHandles.values()) {
      if (handle.closed) continue;
      handle.closed = true;
      if (handle.leaseCount === 0) {
        await this.freeRustHandle(handle).catch((err: unknown) => {
          log.warn('clearAll: link free failed', {
            handleId: handle.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    // 2. Close all epoch handles first (children of account).
    for (const handle of this.epochHandles.values()) {
      if (handle.closed) continue;
      handle.closed = true;
      if (handle.leaseCount === 0) {
        await this.freeRustHandle(handle).catch((err: unknown) => {
          log.warn('clearAll: epoch free failed', {
            handleId: handle.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    // 3. Close identity (child of account).
    if (this.identityHandle && !this.identityHandle.closed) {
      this.identityHandle.closed = true;
      if (this.identityHandle.leaseCount === 0) {
        await this.freeRustHandle(this.identityHandle).catch((err: unknown) => {
          log.warn('clearAll: identity free failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    // 4. Close account last.
    if (this.accountHandle && !this.accountHandle.closed) {
      this.accountHandle.closed = true;
      if (this.accountHandle.leaseCount === 0) {
        await this.freeRustHandle(this.accountHandle).catch((err: unknown) => {
          log.warn('clearAll: account free failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    // 5. Drop registry pointers and bump generation.
    this.linkHandles.clear();
    this.epochHandles.clear();
    this.byId.clear();
    this.identityHandle = null;
    this.accountHandle = null;
    this.generation += 1;
  }

  private async freeRustHandle(handle: WasmHandle): Promise<void> {
    // Remove from byId immediately so further lookups fail fast even if
    // the WASM free is still in flight (it isn't — calls are sync).
    this.byId.delete(handle.id);
    if (handle.kind === 'linkShare' || handle.kind === 'linkTier') {
      this.linkHandles.delete(handle.id);
    }
    if (handle.kind === 'epoch') {
      // Drop the album/epoch key entry too. We don't store the key on the
      // handle so we have to scan; the map is small (handful of epochs).
      for (const [k, v] of this.epochHandles) {
        if (v.id === handle.id) {
          this.epochHandles.delete(k);
          break;
        }
      }
    }
    if (handle.kind === 'identity' && this.identityHandle?.id === handle.id) {
      this.identityHandle = null;
    }
    if (handle.kind === 'account' && this.accountHandle?.id === handle.id) {
      this.accountHandle = null;
    }
    const facade = await this.facade();
    switch (handle.kind) {
      case 'account':
        facade.closeAccountHandle(handle.rustHandle);
        break;
      case 'identity':
        facade.closeIdentityHandle(handle.rustHandle);
        break;
      case 'epoch':
        facade.closeEpochKeyHandle(handle.rustHandle);
        break;
      case 'linkShare':
        facade.closeLinkShareHandle(handle.rustHandle);
        break;
      case 'linkTier':
        facade.closeLinkTierHandle(handle.rustHandle);
        break;
    }
  }
}
