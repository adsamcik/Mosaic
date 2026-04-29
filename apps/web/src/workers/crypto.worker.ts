/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import sodium from 'libsodium-wrappers-sumo';
import { createLogger } from '../lib/logger';
import {
  WorkerCryptoError,
  WorkerCryptoErrorCode,
  type AccountHandleId,
  type CryptoWorkerApi,
  type EncryptedShard,
  type EpochHandleId,
  type ExportedKeys,
  type IdentityHandleId,
  type OpenEpochKeyBundleOptions,
  type PhotoMeta,
  type WorkerKdfParams,
} from './types';

// Import real crypto functions from @mosaic/crypto
import {
  AccessTier,
  decryptShard as cryptoDecryptShard,
  deriveLinkKeys as cryptoDeriveLinkKeys,
  encryptShard as cryptoEncryptShard,
  generateEpochKey as cryptoGenerateEpochKey,
  generateLinkSecret as cryptoGenerateLinkSecret,
  signManifest as cryptoSignManifest,
  unwrapTierKeyFromLink as cryptoUnwrapTierKeyFromLink,
  verifyShard as cryptoVerifyShard,
  wrapTierKeyForLink as cryptoWrapTierKeyForLink,
  deriveAuthKeypair,
  deriveIdentityKeypair,
  deriveKeys,
  deriveTierKeys,
  deriveContentKey,
  encryptContent as cryptoEncryptContent,
  decryptContent as cryptoDecryptContent,
  getArgon2Params,
  memzero,
  sealAndSignBundle,
  unwrapAccountKey,
  verifyAndOpenBundle,
  type IdentityKeypair,
} from '@mosaic/crypto';
import {
  getRustCryptoCore,
  getRustFacade,
  parseEnvelopeHeaderFromRust,
  verifyLegacyManifestWithRust,
  type RustHandleFacade,
} from './rust-crypto-core';

// Create scoped logger for crypto worker
const log = createLogger('CryptoWorker');

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

type WasmHandleKind = 'account' | 'identity' | 'epoch';

interface WasmHandle {
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
};

function mintHandleId(kind: WasmHandleKind): string {
  // 12 random bytes → 16-char base64url. Plenty of collision resistance for
  // a single-worker registry.
  const bytes = sodium.randombytes_buf(12);
  const id = sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
  return `${HANDLE_PREFIX_BY_KIND[kind]}_${id}`;
}

class HandleRegistry {
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
    // 1. Close all epoch handles first (children of account).
    for (const handle of this.epochHandles.values()) {
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

    // 2. Close identity (child of account).
    if (this.identityHandle) {
      this.identityHandle.closed = true;
      if (this.identityHandle.leaseCount === 0) {
        await this.freeRustHandle(this.identityHandle).catch((err: unknown) => {
          log.warn('clearAll: identity free failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    // 3. Close account last.
    if (this.accountHandle) {
      this.accountHandle.closed = true;
      if (this.accountHandle.leaseCount === 0) {
        await this.freeRustHandle(this.accountHandle).catch((err: unknown) => {
          log.warn('clearAll: account free failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    // 4. Drop registry pointers and bump generation.
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
    }
  }
}

function epochKey(albumId: string, epochId: number): string {
  return `${albumId}|${String(epochId)}`;
}

/**
 * Crypto Worker Implementation
 *
 * Rust/WASM-backed implementation for supported Mosaic protocol surfaces with
 * temporary TypeScript reference compatibility for raw-key legacy callers.
 */
class CryptoWorker implements CryptoWorkerApi {
  /** Session key derived from password for database encryption */
  private sessionKey: Uint8Array | null = null;

  /** Account key (L2) for key hierarchy operations */
  private accountKey: Uint8Array | null = null;

  /** Wrapped account key (encrypted L2) for server storage */
  private accountKeyWrapped: Uint8Array | null = null;

  /** User identity keypair (Ed25519 + X25519) */
  private identityKeypair: IdentityKeypair | null = null;

  /** Auth keypair for LocalAuth challenge-response (derived deterministically from password+salt) */
  private authKeypair: { publicKey: Uint8Array; secretKey: Uint8Array } | null =
    null;

  /** Whether libsodium has been initialized */
  private sodiumReady = false;

  /**
   * Slice 1 — Rust handle registry. Mutates only via the methods below
   * and via `clear()` (which calls `handleRegistry.clearAll()`).
   */
  private readonly handleRegistry = new HandleRegistry(() => getRustFacade());

  /**
   * Ensure libsodium is initialized before crypto operations.
   * Verifies that critical WASM functions are actually bound.
   */
  private async ensureSodiumReady(): Promise<void> {
    if (!this.sodiumReady) {
      const timer = log.startTimer('libsodium initialization');
      await sodium.ready;
      
      // Verify critical functions are actually bound (race condition guard)
      // In some cases, sodium.ready can resolve before all WASM bindings complete
      const maxRetries = 10;
      for (let i = 0; i < maxRetries; i++) {
        if (typeof sodium.crypto_pwhash === 'function' &&
            typeof sodium.crypto_sign_detached === 'function' &&
            typeof sodium.crypto_secretbox_easy === 'function') {
          this.sodiumReady = true;
          timer.end();
          return;
        }
        // Small delay to allow Emscripten to complete binding
        log.warn(`libsodium functions not ready, retry ${i + 1}/${maxRetries}`);
        await new Promise(resolve => setTimeout(resolve, 50 * (i + 1)));
      }
      
      // If we get here, something is seriously wrong
      throw new Error('libsodium WASM failed to initialize - critical functions not bound');
    }
  }

  /**
   * Initialize crypto with user credentials.
   * Derives L0 → L1 → L2 key hierarchy using Argon2id + HKDF.
   * Generates a NEW random account key - use initWithWrappedKey for existing users.
   *
   * @param password - User password
   * @param userSalt - 16-byte salt stored on server (per-user)
   * @param accountSalt - 16-byte salt stored on server (unique per account)
   */
  async init(
    password: string,
    userSalt: Uint8Array,
    accountSalt: Uint8Array,
  ): Promise<void> {
    await this.ensureSodiumReady();

    // Get device-appropriate Argon2 parameters
    const params = getArgon2Params();

    // Derive key hierarchy (L0 and L1 are zeroed internally by deriveKeys)
    const keys = await deriveKeys(password, userSalt, accountSalt, params);

    // Store account key for future operations
    this.accountKey = new Uint8Array(keys.accountKey);

    // Store wrapped account key for server storage
    this.accountKeyWrapped = new Uint8Array(keys.accountKeyWrapped);

    // Derive session key from account key using BLAKE2b
    // This provides a separate key for database encryption
    this.sessionKey = sodium.crypto_generichash(32, keys.accountKey);

    // Wipe the DerivedKeys copy of accountKey (we have our own copy above)
    memzero(keys.accountKey);
  }

  /**
   * Initialize crypto with an existing wrapped account key.
   * Used for returning users who already have a stored wrapped key.
   *
   * @param password - User password
   * @param userSalt - 16-byte salt stored on server (per-user)
   * @param accountSalt - 16-byte salt stored on server (unique per account)
   * @param wrappedAccountKey - Previously stored wrapped account key
   */
  async initWithWrappedKey(
    password: string,
    userSalt: Uint8Array,
    accountSalt: Uint8Array,
    wrappedAccountKey: Uint8Array,
  ): Promise<void> {
    await this.ensureSodiumReady();

    // Get device-appropriate Argon2 parameters
    const params = getArgon2Params();

    // Unwrap the existing account key
    const accountKey = await unwrapAccountKey(
      password,
      userSalt,
      accountSalt,
      wrappedAccountKey,
      params,
    );

    // Store account key for future operations
    this.accountKey = new Uint8Array(accountKey);

    // Store the wrapped key (already have it)
    this.accountKeyWrapped = new Uint8Array(wrappedAccountKey);

    // Derive session key from account key using BLAKE2b
    this.sessionKey = sodium.crypto_generichash(32, accountKey);

    // Wipe the returned account key (we have a copy)
    memzero(accountKey);
  }

  /**
   * Get the wrapped account key for server storage.
   * Only available after init() for new users.
   *
   * @returns Wrapped account key or null if not available
   */
  async getWrappedAccountKey(): Promise<Uint8Array | null> {
    if (!this.accountKeyWrapped) {
      return null;
    }
    return new Uint8Array(this.accountKeyWrapped);
  }

  /**
   * Clear all keys from memory.
   *
   * Slice 1 contract: also cascades closure of every Rust handle in the
   * registry (epoch → identity → account) and bumps the registry's
   * generation counter so any handle ID minted before the call resolves
   * to `WorkerCryptoErrorCode.StaleHandle`. Idempotent.
   */
  async clear(): Promise<void> {
    // Cascade-close Rust handles first; the legacy TS state below is a
    // duplicate that Slices 2-4 will retire.
    await this.handleRegistry.clearAll();

    if (this.sessionKey) {
      memzero(this.sessionKey);
      this.sessionKey = null;
    }
    if (this.accountKey) {
      memzero(this.accountKey);
      this.accountKey = null;
    }
    if (this.accountKeyWrapped) {
      memzero(this.accountKeyWrapped);
      this.accountKeyWrapped = null;
    }
    if (this.identityKeypair) {
      memzero(this.identityKeypair.ed25519.secretKey);
      memzero(this.identityKeypair.x25519.secretKey);
      this.identityKeypair = null;
    }
    if (this.authKeypair) {
      memzero(this.authKeypair.secretKey);
      this.authKeypair = null;
    }
  }

  /**
   * Get session key for database encryption.
   *
   * @returns Copy of the 32-byte session key
   * @throws Error if worker not initialized
   */
  async getSessionKey(): Promise<Uint8Array> {
    if (!this.sessionKey) {
      throw new Error('Crypto worker not initialized');
    }
    // Return a copy to prevent external modification
    return new Uint8Array(this.sessionKey);
  }

  /**
   * Encrypt a photo shard using XChaCha20-Poly1305.
   *
   * Creates a 64-byte envelope header with fresh random nonce,
   * then encrypts data with header as AAD for tamper detection.
   *
   * The epochSeed is used to derive the fullKey (tier 3) for encryption.
   * This ensures compatibility with share links which only have derived tier keys.
   *
   * @param data - Plaintext data to encrypt (max 6MB)
   * @param epochSeed - Epoch seed for deriving tier keys (32 bytes)
   * @param epochId - Current epoch ID
   * @param shardIndex - Shard index within photo
   * @returns Encrypted shard with SHA256 hash
   */
  async encryptShard(
    data: Uint8Array,
    epochSeed: Uint8Array,
    epochId: number,
    shardIndex: number,
  ): Promise<EncryptedShard> {
    await this.ensureSodiumReady();
    // Derive the fullKey (tier 3) from epochSeed for encryption
    // This ensures share link recipients with tier keys can decrypt
    const { fullKey } = deriveTierKeys(epochSeed);
    try {
      return await cryptoEncryptShard(data, fullKey, epochId, shardIndex);
    } finally {
      // Zero out derived key after use
      memzero(fullKey);
    }
  }

  /**
   * Decrypt a photo shard (for owner/member viewing).
   *
   * Validates envelope header, checks reserved bytes are zero,
   * then decrypts using XChaCha20-Poly1305 with header as AAD.
   *
   * The epochSeed is used to derive tier-specific keys for decryption.
   * The correct tier key is selected by peeking at the tier byte in the
   * envelope header (tier 1=thumb, 2=preview, 3=original).
   *
   * For backwards compatibility with photos encrypted before tier key derivation
   * was implemented, falls back to trying epochSeed directly if tier key fails.
   *
   * For share link decryption where you have the tier key directly,
   * use decryptShardWithTierKey instead.
   *
   * @param envelope - Complete envelope (header + ciphertext)
   * @param epochSeed - Epoch seed for deriving tier keys (32 bytes)
   * @returns Decrypted plaintext
   * @throws Error if decryption fails or envelope is invalid
   */
  async decryptShard(
    envelope: Uint8Array,
    epochSeed: Uint8Array,
  ): Promise<Uint8Array> {
    await this.ensureSodiumReady();

    // Peek at the envelope header to determine which tier key to use
    const header = await this.peekHeader(envelope);
    const { thumbKey, previewKey, fullKey } = deriveTierKeys(epochSeed);

    // Select the appropriate tier key based on the envelope's tier byte
    let tierKey: Uint8Array;
    switch (header.tier) {
      case 1: // THUMB
        tierKey = thumbKey;
        break;
      case 2: // PREVIEW
        tierKey = previewKey;
        break;
      case 3: // ORIGINAL
      default:
        tierKey = fullKey;
        break;
    }

    try {
      return await cryptoDecryptShard(envelope, tierKey);
    } catch (err) {
      // Fall back to epochSeed directly for backwards compatibility
      // (photos encrypted before tier key derivation was implemented)
      const errorType = err instanceof Error ? err.constructor.name : 'Unknown';
      log.debug('Tier key decrypt failed, falling back to epochSeed', { errorType });
      return await cryptoDecryptShard(envelope, epochSeed);
    } finally {
      // Zero out all derived keys after use
      memzero(thumbKey);
      memzero(previewKey);
      memzero(fullKey);
    }
  }

  /**
   * Decrypt a photo shard with a tier key directly (for share link viewing).
   *
   * Use this method when you have the unwrapped tier key from a share link,
   * rather than the epochSeed.
   *
   * @param envelope - Complete envelope (header + ciphertext)
   * @param tierKey - Tier-specific decryption key (32 bytes, already derived)
   * @returns Decrypted plaintext
   * @throws Error if decryption fails or envelope is invalid
   */
  async decryptShardWithTierKey(
    envelope: Uint8Array,
    tierKey: Uint8Array,
  ): Promise<Uint8Array> {
    await this.ensureSodiumReady();
    return cryptoDecryptShard(envelope, tierKey);
  }

  /**
   * Verify shard integrity against expected hash.
   * Should be called before decryption to ensure shard wasn't tampered with.
   */
  async verifyShard(
    envelope: Uint8Array,
    expectedSha256: string,
  ): Promise<boolean> {
    await this.ensureSodiumReady();
    return cryptoVerifyShard(envelope, expectedSha256);
  }

  /**
   * Peek at shard envelope header without decrypting.
   * Useful for determining which tier key to use for decryption.
   *
   * @param envelope - Complete envelope (header + ciphertext)
   * @returns Header info including epochId, shardId, and tier
   */
  async peekHeader(
    envelope: Uint8Array,
  ): Promise<{ epochId: number; shardId: number; tier: number }> {
    const rust = await getRustCryptoCore();
    return parseEnvelopeHeaderFromRust(rust, envelope);
  }

  /**
   * Decrypt manifest metadata.
   *
   * Manifest metadata is encrypted as a shard (with thumbKey tier),
   * containing JSON-encoded PhotoMeta.
   *
   * The readKey (epochSeed) is used to derive the thumbKey for decryption,
   * since manifests are encrypted with thumbKey to allow share link recipients
   * with thumbnail access to read photo metadata.
   *
   * For backwards compatibility with manifests encrypted before tier key
   * derivation was implemented, falls back to trying readKey directly.
   *
   * @param encryptedMeta - Encrypted manifest bytes (envelope format)
   * @param readKey - Epoch seed (32 bytes) for deriving thumbKey
   * @returns Decrypted and parsed PhotoMeta
   */
  async decryptManifest(
    encryptedMeta: Uint8Array,
    readKey: Uint8Array,
  ): Promise<PhotoMeta> {
    await this.ensureSodiumReady();

    // Manifest metadata uses the envelope format and is encrypted with thumbKey
    // Derive thumbKey from epochSeed for decryption
    const { thumbKey } = deriveTierKeys(readKey);

    let plaintext: Uint8Array;
    try {
      plaintext = await cryptoDecryptShard(encryptedMeta, thumbKey);
    } catch (err) {
      // Fall back to readKey directly for backwards compatibility
      // (manifests encrypted before tier key derivation was implemented)
      const errorType = err instanceof Error ? err.constructor.name : 'Unknown';
      log.debug('ThumbKey decrypt failed, falling back to readKey', { errorType });
      plaintext = await cryptoDecryptShard(encryptedMeta, readKey);
    } finally {
      // Zero out derived key after use
      memzero(thumbKey);
    }

    // Parse JSON from decrypted bytes
    const decoder = new TextDecoder();
    const json = decoder.decode(plaintext);

    try {
      return JSON.parse(json) as PhotoMeta;
    } catch {
      throw new Error('Failed to parse manifest metadata: invalid JSON');
    }
  }

  /**
   * Verify manifest signature using Ed25519.
   *
   * Uses domain separation (Mosaic_Manifest_v1 context prefix)
   * to prevent signature reuse attacks.
   *
   * @param manifest - Manifest bytes that were signed
   * @param signature - Ed25519 signature (64 bytes)
   * @param pubKey - Ed25519 signing public key (32 bytes)
   * @returns true if signature is valid
   */
  async verifyManifest(
    manifest: Uint8Array,
    signature: Uint8Array,
    pubKey: Uint8Array,
  ): Promise<boolean> {
    const rust = await getRustCryptoCore();
    return verifyLegacyManifestWithRust(rust, manifest, signature, pubKey);
  }

  /**
   * Get the user's identity public key (Ed25519).
   * Returns null if identity keypair not yet derived.
   */
  async getIdentityPublicKey(): Promise<Uint8Array | null> {
    if (!this.identityKeypair) {
      return null;
    }
    return new Uint8Array(this.identityKeypair.ed25519.publicKey);
  }

  /**
   * Derive identity keypair from account key.
   * Must be called after init() and before identity-dependent operations.
   */
  async deriveIdentity(): Promise<void> {
    if (!this.accountKey) {
      throw new Error('Crypto worker not initialized');
    }
    await this.ensureSodiumReady();

    // Derive identity keypair from account key
    this.identityKeypair = deriveIdentityKeypair(this.accountKey);
  }

  /**
   * Open (decrypt) an epoch key bundle.
   */
  async openEpochKeyBundle(
    bundle: Uint8Array,
    senderPubkey: Uint8Array,
    albumId: string,
    minEpochId: number,
    options?: OpenEpochKeyBundleOptions,
  ): Promise<{
    epochSeed: Uint8Array;
    signPublicKey: Uint8Array;
    signSecretKey: Uint8Array;
  }> {
    if (!this.identityKeypair) {
      throw new Error('Identity not derived - call deriveIdentity() first');
    }
    await this.ensureSodiumReady();

    // Parse the bundle format: signature (64) || sealed box
    if (bundle.length < 64) {
      throw new Error('Bundle too short');
    }
    const signature = bundle.slice(0, 64);
    const sealedBox = bundle.slice(64);

    // Build validation context
    const context = {
      albumId,
      minEpochId,
      allowLegacyEmptyAlbumId: options?.allowLegacyEmptyAlbumId ?? false,
    };

    // Verify and open the bundle
    const timer = log.startTimer('verifyAndOpenBundle');
    const opened = verifyAndOpenBundle(
      sealedBox,
      signature,
      senderPubkey,
      this.identityKeypair,
      context,
    );
    timer.end();

    return {
      epochSeed: opened.epochSeed,
      signPublicKey: opened.signKeypair.publicKey,
      signSecretKey: opened.signKeypair.secretKey,
    };
  }

  /**
   * Create an epoch key bundle for sharing with another user.
   */
  async createEpochKeyBundle(
    albumId: string,
    epochId: number,
    epochSeed: Uint8Array,
    signPublicKey: Uint8Array,
    signSecretKey: Uint8Array,
    recipientPubkey: Uint8Array,
  ): Promise<{ encryptedBundle: Uint8Array; signature: Uint8Array }> {
    if (!this.identityKeypair) {
      throw new Error('Identity not derived - call deriveIdentity() first');
    }
    await this.ensureSodiumReady();

    // Create the epoch key bundle
    const bundle = {
      version: 1,
      albumId,
      epochId,
      recipientPubkey,
      epochSeed,
      signKeypair: {
        publicKey: signPublicKey,
        secretKey: signSecretKey,
      },
    };

    // Seal and sign the bundle
    const sealed = sealAndSignBundle(
      bundle,
      recipientPubkey,
      this.identityKeypair,
    );

    return {
      encryptedBundle: sealed.sealed,
      signature: sealed.signature,
    };
  }

  /**
   * Generate a new epoch key for album creation or rotation.
   */
  async generateEpochKey(epochId: number): Promise<{
    epochSeed: Uint8Array;
    signPublicKey: Uint8Array;
    signSecretKey: Uint8Array;
  }> {
    await this.ensureSodiumReady();

    const epochKey = cryptoGenerateEpochKey(epochId);

    return {
      epochSeed: epochKey.epochSeed,
      signPublicKey: epochKey.signKeypair.publicKey,
      signSecretKey: epochKey.signKeypair.secretKey,
    };
  }

  /**
   * Encrypt manifest metadata for upload.
   * Uses the same envelope format as shards with epoch and shard index 0.
   *
   * IMPORTANT: The readKey parameter is the epochSeed. We derive the thumbKey
   * from it so that share link recipients (who only have tier keys, not the
   * epochSeed) can decrypt the manifest with their thumbKey (tier 1).
   */
  async encryptManifest(
    meta: PhotoMeta,
    readKey: Uint8Array,
    epochId: number,
  ): Promise<{ ciphertext: Uint8Array; sha256: string }> {
    await this.ensureSodiumReady();

    // Derive the thumbKey from epochSeed for manifest encryption.
    // This ensures share link recipients with tier keys can decrypt manifests.
    const { thumbKey } = deriveTierKeys(readKey);

    // Serialize metadata to JSON bytes
    const encoder = new TextEncoder();
    const plaintext = encoder.encode(JSON.stringify(meta));

    // Encrypt using shard envelope format (epoch 0 and shard 0 are manifest convention)
    // Note: We use the actual epochId but shardIndex 0 for manifest metadata
    const encrypted = await cryptoEncryptShard(plaintext, thumbKey, epochId, 0);

    // Zero out the derived key after use
    memzero(thumbKey);

    return {
      ciphertext: encrypted.ciphertext,
      sha256: encrypted.sha256,
    };
  }

  /**
   * Sign manifest data for upload.
   */
  async signManifest(
    manifestData: Uint8Array,
    signSecretKey: Uint8Array,
  ): Promise<Uint8Array> {
    await this.ensureSodiumReady();
    return cryptoSignManifest(manifestData, signSecretKey);
  }

  /**
   * Wrap data with the account key (L2) for secure storage.
   * Used for encrypting share link secrets.
   */
  async wrapWithAccountKey(data: Uint8Array): Promise<Uint8Array> {
    await this.ensureSodiumReady();

    if (!this.accountKey) {
      throw new Error('Account key not initialized - call init() first');
    }

    // Generate random nonce (24 bytes for XChaCha20-Poly1305)
    const nonce = sodium.randombytes_buf(24);

    // Encrypt with XChaCha20-Poly1305
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      data,
      null, // no additional data
      null, // secret nonce (not used)
      nonce,
      this.accountKey,
    );

    // Return nonce || ciphertext
    const result = new Uint8Array(nonce.length + ciphertext.length);
    result.set(nonce, 0);
    result.set(ciphertext, nonce.length);
    return result;
  }

  /**
   * Unwrap data that was encrypted with the account key (L2).
   * Used for decrypting owner-encrypted share link secrets during epoch rotation.
   */
  async unwrapWithAccountKey(wrapped: Uint8Array): Promise<Uint8Array> {
    await this.ensureSodiumReady();

    if (!this.accountKey) {
      throw new Error('Account key not initialized - call init() first');
    }

    if (wrapped.length < 24 + 16) {
      throw new Error(
        'Wrapped data too short (minimum 40 bytes for nonce + tag)',
      );
    }

    // Extract nonce (first 24 bytes) and ciphertext (rest)
    const nonce = wrapped.subarray(0, 24);
    const ciphertext = wrapped.subarray(24);

    // Decrypt with XChaCha20-Poly1305
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, // secret nonce (not used)
      ciphertext,
      null, // no additional data
      nonce,
      this.accountKey,
    );

    return plaintext;
  }

  // =========================================================================
  // Link Sharing Operations
  // =========================================================================

  /**
   * Derive link ID and wrapping key from a link secret.
   */
  async deriveLinkKeys(
    linkSecret: Uint8Array,
  ): Promise<{ linkId: Uint8Array; wrappingKey: Uint8Array }> {
    await this.ensureSodiumReady();
    return cryptoDeriveLinkKeys(linkSecret);
  }

  /**
   * Wrap a tier key for share link storage.
   */
  async wrapTierKeyForLink(
    tierKey: Uint8Array,
    tier: number,
    wrappingKey: Uint8Array,
  ): Promise<{ tier: number; nonce: Uint8Array; encryptedKey: Uint8Array }> {
    await this.ensureSodiumReady();
    const wrapped = cryptoWrapTierKeyForLink(
      tierKey,
      tier as AccessTier,
      wrappingKey,
    );
    return {
      tier: wrapped.tier,
      nonce: wrapped.nonce,
      encryptedKey: wrapped.encryptedKey,
    };
  }

  /**
   * Unwrap a tier key from share link storage.
   */
  async unwrapTierKeyFromLink(
    nonce: Uint8Array,
    encryptedKey: Uint8Array,
    tier: number,
    wrappingKey: Uint8Array,
  ): Promise<Uint8Array> {
    await this.ensureSodiumReady();
    const wrapped = {
      tier: tier as AccessTier,
      nonce,
      encryptedKey,
    };
    return cryptoUnwrapTierKeyFromLink(
      wrapped,
      tier as AccessTier,
      wrappingKey,
    );
  }

  /**
   * Generate a new random link secret (32 bytes).
   */
  async generateLinkSecret(): Promise<Uint8Array> {
    await this.ensureSodiumReady();
    return cryptoGenerateLinkSecret();
  }

  // =========================================================================
  // Key Export/Import for Session Caching
  // =========================================================================

  /**
   * Export all keys for caching.
   * Returns base64-encoded keys for secure storage.
   */
  async exportKeys(): Promise<ExportedKeys | null> {
    if (!this.sessionKey || !this.accountKey || !this.identityKeypair) {
      return null;
    }

    return {
      accountKey: sodium.to_base64(
        this.accountKey,
        sodium.base64_variants.ORIGINAL,
      ),
      sessionKey: sodium.to_base64(
        this.sessionKey,
        sodium.base64_variants.ORIGINAL,
      ),
      identitySecretKey: sodium.to_base64(
        this.identityKeypair.ed25519.secretKey,
        sodium.base64_variants.ORIGINAL,
      ),
      identityPublicKey: sodium.to_base64(
        this.identityKeypair.ed25519.publicKey,
        sodium.base64_variants.ORIGINAL,
      ),
      identityX25519SecretKey: sodium.to_base64(
        this.identityKeypair.x25519.secretKey,
        sodium.base64_variants.ORIGINAL,
      ),
      identityX25519PublicKey: sodium.to_base64(
        this.identityKeypair.x25519.publicKey,
        sodium.base64_variants.ORIGINAL,
      ),
    };
  }

  /**
   * Import previously exported keys to restore session.
   */
  async importKeys(keys: ExportedKeys): Promise<void> {
    await this.ensureSodiumReady();

    // Clear any existing keys first
    await this.clear();

    // Restore keys from base64
    this.accountKey = sodium.from_base64(
      keys.accountKey,
      sodium.base64_variants.ORIGINAL,
    );
    this.sessionKey = sodium.from_base64(
      keys.sessionKey,
      sodium.base64_variants.ORIGINAL,
    );

    // Restore identity keypair
    this.identityKeypair = {
      ed25519: {
        publicKey: sodium.from_base64(
          keys.identityPublicKey,
          sodium.base64_variants.ORIGINAL,
        ),
        secretKey: sodium.from_base64(
          keys.identitySecretKey,
          sodium.base64_variants.ORIGINAL,
        ),
      },
      x25519: {
        publicKey: sodium.from_base64(
          keys.identityX25519PublicKey,
          sodium.base64_variants.ORIGINAL,
        ),
        secretKey: sodium.from_base64(
          keys.identityX25519SecretKey,
          sodium.base64_variants.ORIGINAL,
        ),
      },
    };
  }

  // =========================================================================
  // LocalAuth Authentication Methods
  // =========================================================================

  /** Auth context for domain separation (must match backend) */
  private static readonly AUTH_CHALLENGE_CONTEXT = 'Mosaic_Auth_Challenge_v1';

  /**
   * Derive auth keypair directly from password + userSalt.
   * This is a deterministic derivation path separate from the random account key.
   * The auth keypair is used for challenge-response authentication.
   *
   * Must be called before signAuthChallenge() or getAuthPublicKey().
   *
   * @param password - User password
   * @param userSalt - 16-byte user salt from server
   */
  async deriveAuthKey(password: string, userSalt: Uint8Array): Promise<void> {
    await this.ensureSodiumReady();

    const params = getArgon2Params();

    // Derive the auth keypair deterministically from password + userSalt
    // This is separate from the random account key derivation
    this.authKeypair = await deriveAuthKeypair(password, userSalt, {
      memoryKiB: params.memory,
      iterations: params.iterations,
      parallelism: params.parallelism,
    });

    log.debug('Auth keypair derived successfully');
  }

  /**
   * Sign an authentication challenge for LocalAuth login.
   * Uses the auth Ed25519 key derived from password+salt.
   *
   * Message format: context || username_len(4 BE) || username || [timestamp(8 BE)] || challenge
   */
  async signAuthChallenge(
    challenge: Uint8Array,
    username: string,
    timestamp?: number,
  ): Promise<Uint8Array> {
    if (!this.authKeypair) {
      throw new Error('Auth key not derived - call deriveAuthKey() first');
    }
    await this.ensureSodiumReady();

    // Build message exactly as backend expects
    const contextBytes = new TextEncoder().encode(
      CryptoWorker.AUTH_CHALLENGE_CONTEXT,
    );
    const usernameBytes = new TextEncoder().encode(username);

    // Username length as 4 bytes big-endian
    const usernameLenBytes = new Uint8Array(4);
    new DataView(usernameLenBytes.buffer).setUint32(
      0,
      usernameBytes.length,
      false,
    ); // false = big-endian

    // Build message parts
    const parts: Uint8Array[] = [contextBytes, usernameLenBytes, usernameBytes];

    // Add timestamp if provided (8 bytes big-endian)
    if (timestamp !== undefined) {
      const timestampBytes = new Uint8Array(8);
      const view = new DataView(timestampBytes.buffer);
      // JavaScript numbers are 64-bit floats, but we need uint64
      // For timestamps in the valid range, this works correctly
      view.setBigUint64(0, BigInt(timestamp), false); // false = big-endian
      parts.push(timestampBytes);
    }

    // Add challenge
    parts.push(challenge);

    // Concatenate all parts
    const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
    const message = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of parts) {
      message.set(part, offset);
      offset += part.length;
    }

    // Sign with Ed25519 auth key
    return sodium.crypto_sign_detached(message, this.authKeypair.secretKey);
  }

  /**
   * Get the Ed25519 public key for authentication.
   * This is the "auth pubkey" stored on server for challenge verification.
   * Returns the deterministically derived auth key (from password+salt), not the identity key.
   */
  async getAuthPublicKey(): Promise<Uint8Array | null> {
    if (!this.authKeypair) {
      return null;
    }
    // Return a copy to prevent external modification
    return new Uint8Array(this.authKeypair.publicKey);
  }

  // =========================================================================
  // Album Content Encryption (Story Blocks)
  // =========================================================================

  /**
   * Encrypt album content (story blocks document).
   * Uses epoch key to derive a content-specific key via HKDF.
   * Binds epochId as AAD to prevent cross-epoch replay.
   */
  async encryptAlbumContent(
    content: Uint8Array,
    epochSeed: Uint8Array,
    epochId: number,
  ): Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }> {
    await this.ensureSodiumReady();

    // Derive content key from epoch seed
    const contentKey = deriveContentKey(epochSeed);

    try {
      // Encrypt content with the derived key
      const result = cryptoEncryptContent(content, contentKey, epochId);
      return {
        nonce: result.nonce,
        ciphertext: result.ciphertext,
      };
    } finally {
      // Always zero the derived key
      memzero(contentKey);
    }
  }

  /**
   * Decrypt album content.
   */
  async decryptAlbumContent(
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    epochSeed: Uint8Array,
    epochId: number,
  ): Promise<Uint8Array> {
    await this.ensureSodiumReady();

    // Derive content key from epoch seed
    const contentKey = deriveContentKey(epochSeed);

    try {
      // Decrypt content
      return cryptoDecryptContent(
        ciphertext,
        nonce,
        contentKey,
        epochId,
      );
    } finally {
      // Always zero the derived key
      memzero(contentKey);
    }
  }

  // ===========================================================================
  // Slice 1 — handle-based contract implementations
  //
  // These methods route directly through the Rust facade, never touching
  // legacy `@mosaic/crypto` state. Slices 2-8 will atomically swap each
  // legacy method body to delegate to one of these.
  // ===========================================================================

  async unlockAccount(opts: {
    password: string;
    userSalt: Uint8Array;
    accountSalt: Uint8Array;
    wrappedAccountKey: Uint8Array;
    kdf: WorkerKdfParams;
  }): Promise<{ accountHandleId: AccountHandleId }> {
    // Strict Mode double-mount: a second `unlockAccount` cascade-closes the
    // prior handle so the new handle ID is the only authoritative one.
    await this.handleRegistry.clearAll();
    const facade = await getRustFacade();
    const passwordBytes = new TextEncoder().encode(opts.password);
    try {
      const rustHandle = facade.unlockAccount({
        password: passwordBytes,
        userSalt: opts.userSalt,
        accountSalt: opts.accountSalt,
        wrappedAccountKey: opts.wrappedAccountKey,
        kdfMemoryKib: opts.kdf.memoryKib,
        kdfIterations: opts.kdf.iterations,
        kdfParallelism: opts.kdf.parallelism,
      });
      const handle = this.handleRegistry.registerAccount(rustHandle);
      return { accountHandleId: handle.id as AccountHandleId };
    } finally {
      // Wipe the password copy. Rust also zeroizes its incoming `Vec<u8>`.
      passwordBytes.fill(0);
    }
  }

  async createNewAccount(opts: {
    password: string;
    userSalt: Uint8Array;
    accountSalt: Uint8Array;
    kdf: WorkerKdfParams;
  }): Promise<{ accountHandleId: AccountHandleId; wrappedAccountKey: Uint8Array }> {
    // TODO(Slice 2): replace with a single Rust-side `wrap_account_key`
    // call once `crates/mosaic-client` exposes that surface. For now we
    // run the legacy TS `deriveKeys` path (which generates a random L2,
    // wraps it under L1, and zeroes intermediates), then immediately open
    // the resulting wrapped key as a Rust handle. Argon2id runs twice
    // here — that's acceptable for the contract slice; Slice 2 will
    // collapse it. See plan.md "Slice 2 — Account unlock" notes.
    await this.handleRegistry.clearAll();
    await this.ensureSodiumReady();

    const params: WorkerKdfParams = {
      memoryKib: opts.kdf.memoryKib,
      iterations: opts.kdf.iterations,
      parallelism: opts.kdf.parallelism,
    };
    const sodiumParams = {
      memory: params.memoryKib,
      iterations: params.iterations,
      parallelism: params.parallelism,
    };

    const keys = await deriveKeys(
      opts.password,
      opts.userSalt,
      opts.accountSalt,
      sodiumParams,
    );
    const wrappedAccountKey = new Uint8Array(keys.accountKeyWrapped);
    memzero(keys.accountKey);

    const facade = await getRustFacade();
    const passwordBytes = new TextEncoder().encode(opts.password);
    try {
      const rustHandle = facade.unlockAccount({
        password: passwordBytes,
        userSalt: opts.userSalt,
        accountSalt: opts.accountSalt,
        wrappedAccountKey,
        kdfMemoryKib: params.memoryKib,
        kdfIterations: params.iterations,
        kdfParallelism: params.parallelism,
      });
      const handle = this.handleRegistry.registerAccount(rustHandle);
      return {
        accountHandleId: handle.id as AccountHandleId,
        wrappedAccountKey,
      };
    } finally {
      passwordBytes.fill(0);
    }
  }

  async closeAccountHandle(handleId: AccountHandleId): Promise<void> {
    await this.handleRegistry.closeHandle(handleId, 'account');
  }

  async getAccountHandleId(): Promise<AccountHandleId | null> {
    const handle = this.handleRegistry.getAccount();
    return handle ? (handle.id as AccountHandleId) : null;
  }

  async createIdentityForAccount(
    accountHandleId: AccountHandleId,
  ): Promise<{
    identityHandleId: IdentityHandleId;
    signingPublicKey: Uint8Array;
    encryptionPublicKey: Uint8Array;
    wrappedSeed: Uint8Array;
  }> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(
      accountHandleId,
      'account',
      (rustAccount) => {
        const out = facade.createIdentityHandle(rustAccount);
        const handle = this.handleRegistry.registerIdentity(out.handle);
        return {
          identityHandleId: handle.id as IdentityHandleId,
          signingPublicKey: out.signingPubkey,
          encryptionPublicKey: out.encryptionPubkey,
          wrappedSeed: out.wrappedSeed,
        };
      },
    );
  }

  async openIdentityForAccount(
    accountHandleId: AccountHandleId,
    wrappedSeed: Uint8Array,
  ): Promise<{
    identityHandleId: IdentityHandleId;
    signingPublicKey: Uint8Array;
    encryptionPublicKey: Uint8Array;
  }> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(
      accountHandleId,
      'account',
      (rustAccount) => {
        const out = facade.openIdentityHandle(wrappedSeed, rustAccount);
        const handle = this.handleRegistry.registerIdentity(out.handle);
        return {
          identityHandleId: handle.id as IdentityHandleId,
          signingPublicKey: out.signingPubkey,
          encryptionPublicKey: out.encryptionPubkey,
        };
      },
    );
  }

  async closeIdentityHandle(handleId: IdentityHandleId): Promise<void> {
    await this.handleRegistry.closeHandle(handleId, 'identity');
  }

  async signManifestWithIdentity(
    identityHandleId: IdentityHandleId,
    transcriptBytes: Uint8Array,
  ): Promise<Uint8Array> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(
      identityHandleId,
      'identity',
      (rustIdentity) =>
        facade.signManifestWithIdentity(rustIdentity, transcriptBytes),
    );
  }

  async verifyManifestWithIdentity(
    transcriptBytes: Uint8Array,
    signature: Uint8Array,
    signingPublicKey: Uint8Array,
  ): Promise<boolean> {
    const facade = await getRustFacade();
    return facade.verifyManifestWithIdentity(
      transcriptBytes,
      signature,
      signingPublicKey,
    );
  }

  async createEpochHandle(
    accountHandleId: AccountHandleId,
    epochId: number,
  ): Promise<{ epochHandleId: EpochHandleId; wrappedSeed: Uint8Array }> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(
      accountHandleId,
      'account',
      (rustAccount) => {
        const out = facade.createEpochKeyHandle(rustAccount, epochId);
        // Slice 1 contract: epoch handles are keyed by (albumId, epochId)
        // for the `getEpochHandleId` lookup. `createEpochHandle` doesn't
        // know the albumId yet (Slice 3 wires it via openEpochKeyBundle's
        // albumId argument). Use empty albumId here; callers needing the
        // lookup should call `openEpochHandle` with an explicit albumId.
        const handle = this.handleRegistry.registerEpoch('', epochId, out.handle);
        return {
          epochHandleId: handle.id as EpochHandleId,
          wrappedSeed: out.wrappedEpochSeed,
        };
      },
    );
  }

  async openEpochHandle(
    accountHandleId: AccountHandleId,
    wrappedSeed: Uint8Array,
    epochId: number,
  ): Promise<{ epochHandleId: EpochHandleId }> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(
      accountHandleId,
      'account',
      (rustAccount) => {
        const out = facade.openEpochKeyHandle(wrappedSeed, rustAccount, epochId);
        const handle = this.handleRegistry.registerEpoch('', epochId, out.handle);
        return { epochHandleId: handle.id as EpochHandleId };
      },
    );
  }

  async closeEpochHandle(handleId: EpochHandleId): Promise<void> {
    await this.handleRegistry.closeHandle(handleId, 'epoch');
  }

  async getEpochHandleId(
    albumId: string,
    epochId: number,
  ): Promise<EpochHandleId | null> {
    const handle = this.handleRegistry.getEpochByAlbumEpoch(albumId, epochId);
    return handle ? (handle.id as EpochHandleId) : null;
  }

  async encryptShardWithEpoch(
    epochHandleId: EpochHandleId,
    plaintext: Uint8Array,
    shardIndex: number,
    tier: 0 | 1 | 2,
  ): Promise<{ envelopeBytes: Uint8Array; sha256: string }> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(
      epochHandleId,
      'epoch',
      (rustEpoch) =>
        facade.encryptShardWithEpochHandle(rustEpoch, plaintext, shardIndex, tier),
    );
  }

  async decryptShardWithEpoch(
    epochHandleId: EpochHandleId,
    envelopeBytes: Uint8Array,
  ): Promise<Uint8Array> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(
      epochHandleId,
      'epoch',
      (rustEpoch) => facade.decryptShardWithEpochHandle(rustEpoch, envelopeBytes),
    );
  }

  async encryptMetadataSidecarWithEpoch(
    epochHandleId: EpochHandleId,
    albumId: Uint8Array,
    photoId: Uint8Array,
    epochId: number,
    encodedFields: Uint8Array,
    shardIndex: number,
  ): Promise<{ envelopeBytes: Uint8Array; sha256: string }> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(
      epochHandleId,
      'epoch',
      (rustEpoch) =>
        facade.encryptMetadataSidecarWithEpochHandle(
          rustEpoch,
          albumId,
          photoId,
          epochId,
          encodedFields,
          shardIndex,
        ),
    );
  }

  async generateLinkSecretRust(): Promise<Uint8Array> {
    const facade = await getRustFacade();
    return facade.generateLinkSecret();
  }

  async deriveLinkKeysRust(
    linkSecret: Uint8Array,
  ): Promise<{ linkId: Uint8Array; wrappingKey: Uint8Array }> {
    const facade = await getRustFacade();
    return facade.deriveLinkKeys(linkSecret);
  }

  async wrapTierKeyForLinkRust(
    epochHandleId: EpochHandleId,
    tier: 0 | 1 | 2,
    wrappingKey: Uint8Array,
  ): Promise<{ tier: number; nonce: Uint8Array; encryptedKey: Uint8Array }> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(
      epochHandleId,
      'epoch',
      (rustEpoch) => facade.wrapTierKeyForLink(rustEpoch, tier, wrappingKey),
    );
  }

  async unwrapTierKeyFromLinkRust(
    nonce: Uint8Array,
    encryptedKey: Uint8Array,
    tier: 0 | 1 | 2,
    wrappingKey: Uint8Array,
  ): Promise<Uint8Array> {
    const facade = await getRustFacade();
    return facade.unwrapTierKeyFromLink(nonce, encryptedKey, tier, wrappingKey);
  }

  async encryptAlbumContentWithEpoch(
    epochHandleId: EpochHandleId,
    plaintext: Uint8Array,
  ): Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(
      epochHandleId,
      'epoch',
      (rustEpoch) => facade.encryptAlbumContent(rustEpoch, plaintext),
    );
  }

  async decryptAlbumContentWithEpoch(
    epochHandleId: EpochHandleId,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(
      epochHandleId,
      'epoch',
      (rustEpoch) => facade.decryptAlbumContent(rustEpoch, nonce, ciphertext),
    );
  }

  async sealAndSignBundle(
    identityHandleId: IdentityHandleId,
    recipientPubkey: Uint8Array,
    albumId: string,
    epochId: number,
    epochSeed: Uint8Array,
    signSecret: Uint8Array,
    signPublic: Uint8Array,
  ): Promise<{ sealed: Uint8Array; signature: Uint8Array; sharerPubkey: Uint8Array }> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(
      identityHandleId,
      'identity',
      (rustIdentity) =>
        facade.sealAndSignBundle(
          rustIdentity,
          recipientPubkey,
          albumId,
          epochId,
          epochSeed,
          signSecret,
          signPublic,
        ),
    );
  }

  async verifyAndOpenBundle(
    identityHandleId: IdentityHandleId,
    sealed: Uint8Array,
    signature: Uint8Array,
    sharerPubkey: Uint8Array,
    expectedAlbumId: string,
    expectedMinEpoch: number,
    allowLegacyEmpty: boolean,
  ): Promise<{
    albumId: string;
    epochId: number;
    epochSeed: Uint8Array;
    signSecret: Uint8Array;
    signPublic: Uint8Array;
  }> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(
      identityHandleId,
      'identity',
      (rustIdentity) =>
        facade.verifyAndOpenBundle(
          rustIdentity,
          sealed,
          signature,
          sharerPubkey,
          expectedAlbumId,
          expectedMinEpoch,
          allowLegacyEmpty,
        ),
    );
  }

  async deriveAuthKeypairForAccount(
    accountHandleId: AccountHandleId,
  ): Promise<{ authPublicKey: Uint8Array }> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(
      accountHandleId,
      'account',
      (rustAccount) => ({
        authPublicKey: facade.deriveAuthKeypairFromAccount(rustAccount),
      }),
    );
  }

  async signAuthChallengeWithAccount(
    accountHandleId: AccountHandleId,
    challengeBytes: Uint8Array,
  ): Promise<Uint8Array> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(
      accountHandleId,
      'account',
      (rustAccount) =>
        facade.signAuthChallengeWithAccount(rustAccount, challengeBytes),
    );
  }

  async getAuthPublicKeyForAccount(
    accountHandleId: AccountHandleId,
  ): Promise<Uint8Array> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(
      accountHandleId,
      'account',
      (rustAccount) => facade.getAuthPublicKeyFromAccount(rustAccount),
    );
  }

  async wrapKey(keyBytes: Uint8Array, wrapperKey: Uint8Array): Promise<Uint8Array> {
    const facade = await getRustFacade();
    return facade.wrapKey(keyBytes, wrapperKey);
  }

  async unwrapKey(wrapped: Uint8Array, wrapperKey: Uint8Array): Promise<Uint8Array> {
    const facade = await getRustFacade();
    return facade.unwrapKey(wrapped, wrapperKey);
  }
}

// Create worker instance and expose via Comlink
const worker = new CryptoWorker();
Comlink.expose(worker);
