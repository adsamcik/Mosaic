/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import sodium from 'libsodium-wrappers-sumo';
import { createLogger } from '../lib/logger';
import {
  WorkerCryptoError,
  WorkerCryptoErrorCode,
  type AccountHandleId,
  type CryptoWorkerApi,
  type EnvelopeHeader,
  type EpochHandleId,
  type IdentityHandleId,
  type LinkShareHandleId,
  type LinkTierHandleId,
  type ManifestTranscriptInput,
  type OpenEpochKeyBundleOptions,
  type ShardTier,
  type WorkerKdfParams,
} from './types';

// Import real crypto functions from @mosaic/crypto.
//
// Slice 2 narrows this import set: account unlock, identity derivation,
// auth keypair derivation, and key export/import are now Rust-handled, so
// `deriveKeys`, `deriveAuthKeypair`, `deriveIdentityKeypair`,
// `unwrapAccountKey`, and `IdentityKeypair` are no longer imported here.
// Slice 4 drops `signManifest`: manifest signing now routes through the
// Rust epoch handle (`signManifestWithEpoch`). Slice 6 narrows it again:
// share-link helpers now route through Rust-owned link-share/link-tier
// handles in the Rust facade; the `AccessTier` runtime enum was a libsodium-typed
// shim used only by those legacy share-link methods, so it's gone too.
// The remaining symbols belong to slices 5/7's territory and stay until
// their callers are migrated.
import { getRustFacade } from './rust-crypto-core';
import { normalizePasswordForKdf } from '../lib/local-auth-normalization';

// Create scoped logger for crypto worker
const log = createLogger('CryptoWorker');


import {
  ENVELOPE_VERSION_V03,
  ENVELOPE_VERSION_V04,
  ensureNonNullRawEpochHandle,
  parseStreamingEnvelopeHeader,
} from './crypto/envelope-helpers';
import { HandleRegistry } from './crypto/handle-registry';


/**
 * Crypto Worker Implementation
 *
 * Slice 2 contract: account/identity/auth/key-wrap surfaces are entirely
 * Rust-handled. The worker holds *no* raw key material in JS — the only
 * private state is the `HandleRegistry` (Rust handle IDs), the cached
 * wrapped account key (already ciphertext), and the cached wrapped
 * identity seed (also ciphertext).
 *
 * Slice 3 will retire the remaining `@mosaic/crypto` imports for shard /
 * manifest / album-content / share-link operations.
 */
class CryptoWorker implements CryptoWorkerApi {
  /**
   * Cached wrapped account key — opaque ciphertext that the server stores
   * for returning users. Set by `init` / `initWithWrappedKey` /
   * `restoreSessionState`. Never contains plaintext key material.
   */
  private wrappedAccountKey: Uint8Array | null = null;

  /**
   * Cached wrapped identity seed — opaque ciphertext for the user's
   * Ed25519 + X25519 identity. Set by `init` / `initWithWrappedKey` /
   * `restoreSessionState`.
   */
  private wrappedIdentitySeed: Uint8Array | null = null;

  /**
   * Cached auth public key (Ed25519, 32 bytes) for the active account
   * handle. Public material — safe to expose. Cached so `getAuthPublicKey`
   * does not have to take a lease per call.
   */
  private authPublicKey: Uint8Array | null = null;

  /**
   * Transient password-rooted LocalAuth keypair slot.
   *
   * Populated by `deriveAuthKey(password, userSalt)` during the
   * LocalAuth login/register pre-auth window — the wrapped account key
   * has not yet been fetched from the server, so no account handle is
   * open. While this slot is set, `signAuthChallenge` and
   * `getAuthPublicKey` route through the password-rooted Argon2id+HKDF
   * derivation rather than the L2-rooted account-handle path.
   *
   * The slot survives `init` / `initWithWrappedKey` /
   * `restoreSessionState` so the register flow (which calls
   * `deriveAuthKey` → `init` → `signAuthChallenge`) keeps the same
   * keypair across the boundary. `clear()` zeroizes the password
   * buffer and drops the slot.
   *
   * NOTE (Slice 9 cleanup): every challenge sign re-runs Argon2id; for
   * a perf pass, swap this for a transient pre-auth handle minted in
   * Rust by `deriveAuthKey` and consumed by `signAuthChallenge`.
   */
  private preAuthState: {
    password: Uint8Array;
    userSalt: Uint8Array;
    kdf: WorkerKdfParams;
    authPublicKey: Uint8Array;
  } | null = null;

  /** Whether libsodium has been initialized (used by stay-put methods). */
  private sodiumReady = false;

  /**
   * Slice 1 — Rust handle registry. Mutates only via the methods below
   * and via `clear()` (which calls `handleRegistry.clearAll()`).
   */
  private readonly handleRegistry = new HandleRegistry(() => getRustFacade());

  /**
   * Ensure libsodium is initialized for the remaining platform-glue operations:
   * upload session id generation and legacy pre-auth KDF parameter plumbing.
   * Protocol-defined hashes/checksums/scope keys now route through Rust core.
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
   * Resolve the active account handle ID, throwing
   * `WorkerCryptoErrorCode.WorkerNotInitialized` when none is open.
   *
   * Used by every legacy method (`signAuthChallenge`,
   * `wrapWithAccountKey`, etc.) to convert the new handle-based contract
   * into the legacy "worker is initialized" expectation.
   */
  private requireAccountHandle(): AccountHandleId {
    const handle = this.handleRegistry.getAccount();
    if (!handle) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.WorkerNotInitialized,
        'crypto worker not initialised — call init() / initWithWrappedKey() first',
      );
    }
    return handle.id as AccountHandleId;
  }

  private requireIdentityHandle(): IdentityHandleId {
    const handle = this.handleRegistry.getIdentity();
    if (!handle) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.WorkerNotInitialized,
        'crypto worker identity not bound — call init() / initWithWrappedKey() first',
      );
    }
    return handle.id as IdentityHandleId;
  }

  private kdfFromArgon2Params(params: WorkerKdfParams): WorkerKdfParams {
    return {
      memoryKib: params.memoryKib,
      iterations: params.iterations,
      parallelism: params.parallelism,
    };
  }

  /**
   * Initialize crypto with user credentials.
   *
   * Slice 2 — routes through Rust `createNewAccount` + `createIdentity`.
   * Returns nothing; cached state lives behind handle IDs in the
   * registry. The L0/L1/L2 bytes never cross the Comlink boundary.
   */
  async init(
    password: string,
    userSalt: Uint8Array,
    accountSalt: Uint8Array,
    kdfParams: WorkerKdfParams,
  ): Promise<void> {
    await this.ensureSodiumReady();
    const kdf = this.kdfFromArgon2Params(kdfParams);
    const out = await this.createNewAccount({
      password,
      userSalt,
      accountSalt,
      kdf,
    });
    this.wrappedAccountKey = new Uint8Array(out.wrappedAccountKey);
    const identity = await this.createIdentityForAccount(out.accountHandleId);
    this.wrappedIdentitySeed = new Uint8Array(identity.wrappedSeed);
    this.authPublicKey = await this.getAuthPublicKeyForAccount(out.accountHandleId);
  }

  /**
   * Initialize crypto with an existing wrapped account key.
   *
   * Slice 2 — routes through Rust `unlockAccount` and either
   * `openIdentityForAccount` (when the caller supplies the wrapped seed
   * persisted on the server) or `createIdentityForAccount` (legacy
   * fallback for accounts that have not yet uploaded a wrapped seed).
   */
  async initWithWrappedKey(
    password: string,
    userSalt: Uint8Array,
    accountSalt: Uint8Array,
    wrappedAccountKey: Uint8Array,
    kdfParams: WorkerKdfParams,
    wrappedIdentitySeed?: Uint8Array,
  ): Promise<void> {
    const kdf = this.kdfFromArgon2Params(kdfParams);
    const out = await this.unlockAccount({
      password,
      userSalt,
      accountSalt,
      wrappedAccountKey,
      kdf,
    });
    this.wrappedAccountKey = new Uint8Array(wrappedAccountKey);
    if (wrappedIdentitySeed && wrappedIdentitySeed.length > 0) {
      const identity = await this.openIdentityForAccount(
        out.accountHandleId,
        wrappedIdentitySeed,
      );
      this.wrappedIdentitySeed = new Uint8Array(wrappedIdentitySeed);
      void identity;
    } else {
      const identity = await this.createIdentityForAccount(out.accountHandleId);
      this.wrappedIdentitySeed = new Uint8Array(identity.wrappedSeed);
    }
    this.authPublicKey = await this.getAuthPublicKeyForAccount(out.accountHandleId);
  }

  /**
   * Get the wrapped account key for server storage.
   * Returned bytes are opaque ciphertext — safe to send across Comlink.
   */
  async getWrappedAccountKey(): Promise<Uint8Array | null> {
    if (!this.wrappedAccountKey) return null;
    return new Uint8Array(this.wrappedAccountKey);
  }

  async getWrappedIdentitySeed(): Promise<Uint8Array | null> {
    if (!this.wrappedIdentitySeed) return null;
    return new Uint8Array(this.wrappedIdentitySeed);
  }

  /**
   * Clear all keys from memory.
   *
   * Slice 1 contract: cascades closure of every Rust handle in the
   * registry (epoch → identity → account) and bumps the registry
   * generation counter. Slice 2 also drops the cached opaque blobs
   * (`wrappedAccountKey`, `wrappedIdentitySeed`, `authPublicKey`).
   * Idempotent.
   */
  async clear(): Promise<void> {
    await this.handleRegistry.clearAll();
    if (this.wrappedAccountKey) {
      this.wrappedAccountKey.fill(0);
      this.wrappedAccountKey = null;
    }
    if (this.wrappedIdentitySeed) {
      this.wrappedIdentitySeed.fill(0);
      this.wrappedIdentitySeed = null;
    }
    if (this.authPublicKey) {
      this.authPublicKey.fill(0);
      this.authPublicKey = null;
    }
    this.wipePreAuthState();
  }

  async getMemoryDiagnostics(): Promise<{
    handles: {
      account: number;
      identity: number;
      epoch: number;
      link: number;
      total: number;
      generation: number;
    };
  }> {
    return { handles: this.handleRegistry.stats() };
  }

  /**
   * Zeroize and drop the password-rooted pre-auth keypair slot.
   *
   * Called by `clear()` and by `deriveAuthKey()` (so back-to-back
   * derive calls with different passwords cannot leave stale bytes).
   */
  private wipePreAuthState(): void {
    if (!this.preAuthState) return;
    this.preAuthState.password.fill(0);
    this.preAuthState.authPublicKey.fill(0);
    this.preAuthState = null;
  }

  /**
   * Slice 8 — wrap an OPFS-snapshot plaintext with the active L2 account
   * key referenced by the Rust handle. Raw key bytes never cross the
   * Comlink boundary.
   *
   * P-W7.3 hard cutover: OPFS snapshots use the handle-based account
   * wrap/unwrap export directly. Older DB-session-key snapshots are
   * invalidated by `SNAPSHOT_VERSION`.
   */
  async wrapDbBlob(plaintext: Uint8Array): Promise<Uint8Array> {
    const accountId = this.requireAccountHandle();
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(accountId, 'account', (rustAccount) =>
      facade.wrapWithAccountHandle(rustAccount, plaintext),
    );
  }

  /**
   * Slice 8 — unwrap a blob previously wrapped by {@link wrapDbBlob}.
   * Same lease + wipe pattern as `wrapDbBlob`.
   */
  async unwrapDbBlob(wrapped: Uint8Array): Promise<Uint8Array> {
    const accountId = this.requireAccountHandle();
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(accountId, 'account', (rustAccount) =>
      facade.unwrapWithAccountHandle(rustAccount, wrapped),
    );
  }

  async getDbEncryptionWrap(plaintext: Uint8Array): Promise<Uint8Array> {
    const accountId = this.requireAccountHandle();
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(accountId, 'account', (rustAccount) =>
      facade.wrapWithAccountHandle(rustAccount, plaintext),
    );
  }

  async unwrapDbEncryption(wrapped: Uint8Array): Promise<Uint8Array> {
    const accountId = this.requireAccountHandle();
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(accountId, 'account', (rustAccount) =>
      facade.unwrapWithAccountHandle(rustAccount, wrapped),
    );
  }

  /**
   * Serialize the session bootstrap state into an OPAQUE blob.
   *
   * Layout (binary, version-prefixed):
   *   `0x01 || u16be(authPubLen) || authPub || u16be(wrappedAccountKeyLen)
   *    || wrappedAccountKey || u16be(wrappedIdentitySeedLen)
   *    || wrappedIdentitySeed`
   *
   * Wrapped under the active account handle's L2 key via
   * `wrapWithAccountHandle`, so the blob is unintelligible to anyone who
   * does not also hold the password (to re-derive L1 → unwrap L2).
   * Returns `null` when the worker is not initialised.
   */
  async serializeSessionState(): Promise<Uint8Array | null> {
    if (
      !this.wrappedAccountKey ||
      !this.wrappedIdentitySeed ||
      !this.authPublicKey
    ) {
      return null;
    }
    const accountId = this.handleRegistry.getAccount();
    if (!accountId) return null;

    const authPub = this.authPublicKey;
    const wak = this.wrappedAccountKey;
    const wis = this.wrappedIdentitySeed;
    const totalLen = 1 + 2 + authPub.length + 2 + wak.length + 2 + wis.length;
    const plaintext = new Uint8Array(totalLen);
    const view = new DataView(plaintext.buffer);
    let off = 0;
    plaintext[off] = 0x01;
    off += 1;
    view.setUint16(off, authPub.length, false);
    off += 2;
    plaintext.set(authPub, off);
    off += authPub.length;
    view.setUint16(off, wak.length, false);
    off += 2;
    plaintext.set(wak, off);
    off += wak.length;
    view.setUint16(off, wis.length, false);
    off += 2;
    plaintext.set(wis, off);
    off += wis.length;

    const facade = await getRustFacade();
    return this.handleRegistry.withLease(
      accountId.id as AccountHandleId,
      'account',
      (rustAccount) => facade.wrapWithAccountHandle(rustAccount, plaintext),
    );
  }

  /**
   * Reopen the account + identity handles from a previously serialized
   * blob, supplying the password and salts for the L1 KDF pass.
   *
   * Validates the blob shape, calls `unlockAccount` followed by
   * `openIdentityForAccount`, and caches the auth public key for
   * `getAuthPublicKey`.
   */
  async restoreSessionState(
    blob: Uint8Array,
    password: string,
    userSalt: Uint8Array,
    accountSalt: Uint8Array,
    kdfParams: WorkerKdfParams,
  ): Promise<void> {
    // Decode the OPAQUE outer envelope: it was wrapped under an account
    // handle, but at this point no handle is open yet, so we have to
    // unlock first using the wrappedAccountKey field carried INSIDE the
    // blob. To do that we cannot simply unwrap before unlock — so the
    // outer envelope is, effectively, only encrypted with the L2 (which
    // we rederive via unlockAccount).
    //
    // We need a chicken-and-egg break: store the opaque wrappedAccountKey
    // OUTSIDE the encrypted blob. Slice 2 chooses the simpler path:
    // serializeSessionState returns the plaintext bundle (already
    // composed of opaque ciphertext fields), and lets the calling
    // key-cache wrap it under its in-memory Web Crypto AES-GCM key. This
    // restoreSessionState method therefore parses the (non-encrypted)
    // bundle directly.
    const kdf = this.kdfFromArgon2Params(kdfParams);
    const parsed = this.parseSessionStateBundle(blob);

    const out = await this.unlockAccount({
      password,
      userSalt,
      accountSalt,
      wrappedAccountKey: parsed.wrappedAccountKey,
      kdf,
    });
    this.wrappedAccountKey = new Uint8Array(parsed.wrappedAccountKey);
    if (parsed.wrappedIdentitySeed.length > 0) {
      await this.openIdentityForAccount(
        out.accountHandleId,
        parsed.wrappedIdentitySeed,
      );
      this.wrappedIdentitySeed = new Uint8Array(parsed.wrappedIdentitySeed);
    } else {
      const identity = await this.createIdentityForAccount(out.accountHandleId);
      this.wrappedIdentitySeed = new Uint8Array(identity.wrappedSeed);
    }
    this.authPublicKey = await this.getAuthPublicKeyForAccount(
      out.accountHandleId,
    );
  }

  private parseSessionStateBundle(blob: Uint8Array): {
    authPublicKey: Uint8Array;
    wrappedAccountKey: Uint8Array;
    wrappedIdentitySeed: Uint8Array;
  } {
    if (blob.length < 1 + 2 + 2 + 2) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.InvalidEnvelope,
        'session state blob is too short to be valid',
      );
    }
    if (blob[0] !== 0x01) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.UnsupportedVersion,
        `session state blob has unsupported version byte 0x${blob[0]!.toString(16)}`,
      );
    }
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    let off = 1;
    const authLen = view.getUint16(off, false);
    off += 2;
    if (off + authLen > blob.length) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.InvalidEnvelope,
        'session state blob: authPublicKey field truncated',
      );
    }
    const authPub = blob.subarray(off, off + authLen);
    off += authLen;
    if (off + 2 > blob.length) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.InvalidEnvelope,
        'session state blob: missing wrappedAccountKey length',
      );
    }
    const wakLen = view.getUint16(off, false);
    off += 2;
    if (off + wakLen > blob.length) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.InvalidEnvelope,
        'session state blob: wrappedAccountKey field truncated',
      );
    }
    const wak = blob.subarray(off, off + wakLen);
    off += wakLen;
    if (off + 2 > blob.length) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.InvalidEnvelope,
        'session state blob: missing wrappedIdentitySeed length',
      );
    }
    const wisLen = view.getUint16(off, false);
    off += 2;
    if (off + wisLen > blob.length) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.InvalidEnvelope,
        'session state blob: wrappedIdentitySeed field truncated',
      );
    }
    const wis = blob.subarray(off, off + wisLen);
    return {
      authPublicKey: new Uint8Array(authPub),
      wrappedAccountKey: new Uint8Array(wak),
      wrappedIdentitySeed: new Uint8Array(wis),
    };
  }

  /**
   * Decrypt a photo shard with an opaque link-tier handle (for share link viewing).
   *
   * Use this method when you have a Rust-managed link-tier handle minted from
   * the share-link tier key.
   *
   * @param envelope - Complete envelope (header + ciphertext)
   * @param tierKeyHandle - Opaque Rust-managed link-tier handle
   * @returns Decrypted plaintext
   * @throws Error if decryption fails or envelope is invalid
   */
  async decryptShardWithTierKey(
    envelope: Uint8Array,
    tierKeyHandle: LinkTierHandleId,
  ): Promise<Uint8Array> {
    return this.decryptShardWithLinkTierHandle(tierKeyHandle, envelope);
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
    const facade = await getRustFacade();
    const parsed = facade.parseEnvelopeHeader(envelope);
    return {
      epochId: parsed.epochId,
      shardId: parsed.shardIndex,
      tier: parsed.tier,
    };
  }

  /**
   * Get the user's identity public key (Ed25519).
   *
   * Slice 2 — reads from the active identity handle via Rust. Returns
   * `null` when no identity handle is open.
   */
  async getIdentityPublicKey(): Promise<Uint8Array | null> {
    const identity = this.handleRegistry.getIdentity();
    if (!identity) return null;
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(
      identity.id as IdentityHandleId,
      'identity',
      (rustIdentity) => facade.identitySigningPubkey(rustIdentity),
    );
  }

  /**
   * Slice 2 contract — `deriveIdentity` is now a no-op stub.
   *
   * Identity is derived implicitly during `init` /
   * `initWithWrappedKey` / `restoreSessionState`. This stub remains for
   * the Slice 3+ callers (`epoch-key-service.ts`,
   * `epoch-rotation-service.ts`) that still defensively call it; it
   * simply asserts the worker is initialised and returns.
   *
   * @deprecated Slice 3 will retire the call sites and delete this stub.
   */
  async deriveIdentity(): Promise<void> {
    if (!this.handleRegistry.getIdentity()) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.WorkerNotInitialized,
        'crypto worker identity not bound — call init() / initWithWrappedKey() first',
      );
    }
  }

  /**
   * Open (decrypt) an epoch key bundle.
   *
   * Slice 3 - verifies and imports the bundle inside Rust in one step.
   * The seed and per-epoch sign secret never cross the WASM/JS boundary.
   * The caller only ever sees the
   * opaque epoch handle id, the epoch id, and the (public) sign verifying
   * key.
   */
  async openEpochKeyBundle(
    bundle: Uint8Array,
    senderPubkey: Uint8Array,
    albumId: string,
    minEpochId: number,
    options?: OpenEpochKeyBundleOptions,
  ): Promise<{
    epochHandleId: EpochHandleId;
    epochId: number;
    signPublicKey: Uint8Array;
  }> {
    const identityId = this.requireIdentityHandle();
    if (bundle.length < 64) {
      throw new Error('Bundle too short');
    }
    const signature = bundle.slice(0, 64);
    const sealedBox = bundle.slice(64);

    const facade = await getRustFacade();
    const verifyTimer = log.startTimer('verifyAndImportEpochBundle');
    const imported = await this.handleRegistry.withLease(
      identityId,
      'identity',
      (rustIdentity) =>
        facade.verifyAndImportEpochBundle(
          rustIdentity,
          sealedBox,
          signature,
          senderPubkey,
          albumId,
          minEpochId,
          options?.allowLegacyEmptyAlbumId ?? false,
        ),
    );
    verifyTimer.end();

    // Bind the freshly minted handle to the verified album so future
    // `getEpochHandleId(albumId, epochId)` lookups can recover it.
    const handle = this.handleRegistry.registerEpoch(
      albumId,
      imported.epochId,
      imported.handle,
    );

    return {
      epochHandleId: handle.id as EpochHandleId,
      epochId: imported.epochId,
      signPublicKey: imported.signPublicKey,
    };
  }

  /**
   * Create an epoch key bundle for sharing with another user.
   *
   * Slice 3 — bundle payload bytes never cross Comlink. The caller passes
   * the sender's epoch handle id; the Rust facade clones the seed + sign
   * keypair from the registry, builds and seals the bundle, and zeroizes
   * the cloned payload before returning.
   */
  async createEpochKeyBundle(
    epochHandleId: EpochHandleId,
    albumId: string,
    recipientPubkey: Uint8Array,
  ): Promise<{ encryptedBundle: Uint8Array; signature: Uint8Array; wireBytes: Uint8Array }> {
    const identityId = this.requireIdentityHandle();
    const facade = await getRustFacade();

    const sealed = await this.handleRegistry.withLease(
      identityId,
      'identity',
      (rustIdentity) =>
        this.handleRegistry.withLease(
          epochHandleId,
          'epoch',
          (rustEpoch) =>
            facade.sealBundleWithEpochHandle(
              rustIdentity,
              rustEpoch,
              recipientPubkey,
              albumId,
            ),
        ),
    );

    // Wire framing is non-cryptographic: Rust returns the signature and sealed
    // payload; the server contract stores `signature || sealed` as bundle bytes.
    const wireBytes = new Uint8Array(sealed.signature.length + sealed.sealed.length);
    wireBytes.set(sealed.signature, 0);
    wireBytes.set(sealed.sealed, sealed.signature.length);

    return {
      encryptedBundle: sealed.sealed,
      signature: sealed.signature,
      wireBytes,
    };
  }

  /**
   * Generate a new epoch key for album creation or rotation.
   *
   * Slice 3 — no raw seed/sign-secret bytes cross Comlink. Routes through
   * `createEpochHandle` which mints a Rust-owned handle whose registry
   * record carries both the derived epoch material and a freshly generated
   * per-epoch manifest signing keypair.
   */
  async generateEpochKey(epochId: number): Promise<{
    epochHandleId: EpochHandleId;
    wrappedSeed: Uint8Array;
    signPublicKey: Uint8Array;
  }> {
    const accountId = this.requireAccountHandle();
    return this.createEpochHandle(accountId, epochId);
  }

  /**
   * Encrypt manifest metadata for upload using the epoch handle's
   * thumb-tier key (Slice 4 — Rust handle contract).
   *
   * Routes through `encryptShardWithEpoch` with `shardIndex=0` and
   * `tier=THUMB` (byte value `1`) — the manifest envelope convention. The
   * thumb-tier key is derived inside Rust from the epoch handle and never
   * crosses Comlink. The caller is expected to JSON-encode the
   * {@link PhotoMeta} before invoking this method.
   */
  async encryptManifestWithEpoch(
    epochHandleId: EpochHandleId,
    plaintext: Uint8Array,
  ): Promise<{ envelopeBytes: Uint8Array; sha256: string }> {
    return this.encryptShardWithEpoch(epochHandleId, plaintext, 0, 1);
  }

  /**
   * Sign manifest transcript bytes with the per-epoch manifest signing
   * key attached to the epoch handle (Slice 4 — Rust handle contract).
   *
   * Routes through Rust `signManifestWithEpochHandle`; the per-epoch sign
   * secret never crosses Comlink.
   */
  async signManifestWithEpoch(
    epochHandleId: EpochHandleId,
    manifestBytes: Uint8Array,
  ): Promise<Uint8Array> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(
      epochHandleId,
      'epoch',
      (rustEpoch) => facade.signManifestWithEpochHandle(rustEpoch, manifestBytes),
    );
  }

  async manifestTranscriptBytes(
    input: ManifestTranscriptInput,
  ): Promise<Uint8Array> {
    const facade = await getRustFacade();
    return facade.manifestTranscriptBytes(input);
  }

  async verifyManifestWithEpoch(
    input: ManifestTranscriptInput,
    signature: Uint8Array,
    pubKey: Uint8Array,
  ): Promise<boolean> {
    const facade = await getRustFacade();
    const transcript = facade.manifestTranscriptBytes(input);
    return facade.verifyManifestWithEpoch(transcript, signature, pubKey);
  }

  async verifySignatureWithEpoch(
    transcriptBytes: Uint8Array,
    signature: Uint8Array,
    pubKey: Uint8Array,
  ): Promise<boolean> {
    const facade = await getRustFacade();
    return facade.verifyManifestWithEpoch(transcriptBytes, signature, pubKey);
  }

  async finalizeIdempotencyKey(jobId: string): Promise<string> {
    const facade = await getRustFacade();
    return facade.finalizeIdempotencyKey(jobId);
  }

  /**
   * Decrypt a manifest envelope using the epoch handle's thumb-tier key
   * (Slice 4 — Rust handle contract).
   *
   * Returns the raw plaintext bytes (typically UTF-8 JSON for the
   * encoded {@link PhotoMeta}); callers decode/parse outside the worker.
   */
  async decryptManifestWithEpoch(
    epochHandleId: EpochHandleId,
    envelopeBytes: Uint8Array,
  ): Promise<Uint8Array> {
    return this.decryptShardWithEpochHandle(epochHandleId, envelopeBytes);
  }

  /**
   * Wrap data with the account key (L2) for secure storage.
   *
   * Slice 2 — routes through Rust `wrapWithAccountHandle` so the L2
   * bytes never cross the Comlink boundary. Output layout is unchanged:
   * `nonce(24) || ciphertext_with_tag`.
   */
  async wrapWithAccountKey(data: Uint8Array): Promise<Uint8Array> {
    const accountId = this.requireAccountHandle();
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(accountId, 'account', (rustAccount) =>
      facade.wrapWithAccountHandle(rustAccount, data),
    );
  }

  /**
   * Unwrap data that was encrypted with the account key (L2).
   *
   * Slice 2 — mirror of `wrapWithAccountKey`, routes through Rust
   * `unwrapWithAccountHandle`.
   */
  async unwrapWithAccountKey(wrapped: Uint8Array): Promise<Uint8Array> {
    const accountId = this.requireAccountHandle();
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(accountId, 'account', (rustAccount) =>
      facade.unwrapWithAccountHandle(rustAccount, wrapped),
    );
  }

  async encryptUserSaltEnvelopeV2(
    salt: Uint8Array,
  ): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
    const accountId = this.requireAccountHandle();
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(accountId, 'account', (rustAccount) =>
      facade.encryptUserSaltEnvelopeV2(rustAccount, salt),
    );
  }

  async decryptUserSaltEnvelopeV2(
    ciphertext: Uint8Array,
    nonce: Uint8Array,
  ): Promise<Uint8Array> {
    const accountId = this.requireAccountHandle();
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(accountId, 'account', (rustAccount) =>
      facade.decryptUserSaltEnvelopeV2(rustAccount, ciphertext, nonce),
    );
  }

  // =========================================================================
  // LocalAuth Authentication Methods
  // =========================================================================

  /**
   * Derive the password-rooted LocalAuth Ed25519 keypair from
   * `password` + `userSalt` and stash it in the worker's transient
   * pre-auth slot.
   *
   * Slice 2 fixup: LocalAuth login/register signs a challenge BEFORE
   * any account handle is open. The Rust crypto crate's
   * `derive_auth_signing_keypair(password, user_salt, profile)` runs
   * Argon2id+HKDF and returns a deterministic Ed25519 keypair that
   * neither requires nor consumes an account handle. We cache the
   * derived public key plus the (password, userSalt, kdf) tuple in the
   * pre-auth slot so subsequent `signAuthChallenge` /
   * `getAuthPublicKey` calls during the same login attempt can reuse
   * them without re-prompting.
   *
   * The slot survives `init` / `initWithWrappedKey` /
   * `restoreSessionState`. It is wiped by `clear()` and replaced when
   * `deriveAuthKey` is called again.
   *
   * @returns The 32-byte Ed25519 auth public key (also stored in
   *          preAuthState).
   */
  async deriveAuthKey(
    password: string,
    userSalt: Uint8Array,
    kdfParams: WorkerKdfParams,
  ): Promise<Uint8Array> {
    const kdf = this.kdfFromArgon2Params(kdfParams);
    const passwordBytes = normalizePasswordForKdf(password);
    const passwordCopy = new Uint8Array(passwordBytes);
    const userSaltCopy = new Uint8Array(userSalt);
    const facade = await getRustFacade();
    let authPub: Uint8Array;
    try {
      authPub = facade.deriveAuthKeypairFromPassword(
        passwordBytes,
        userSaltCopy,
        kdf.memoryKib,
        kdf.iterations,
        kdf.parallelism,
      );
    } catch (error) {
      passwordBytes.fill(0);
      passwordCopy.fill(0);
      userSaltCopy.fill(0);
      throw error;
    }
    passwordBytes.fill(0);
    this.wipePreAuthState();
    this.preAuthState = {
      password: passwordCopy,
      userSalt: userSaltCopy,
      kdf,
      authPublicKey: new Uint8Array(authPub),
    };
    return authPub;
  }

  /**
   * Sign an authentication challenge for LocalAuth login.
   *
   * Slice 2 contract: prefers the pre-auth slot (password-rooted)
   * populated by `deriveAuthKey()`. Falls back to the active account
   * handle's L2-rooted auth keypair when no pre-auth slot is set.
   * Builds the canonical transcript inside Rust via
   * `buildAuthChallengeTranscript` so JS stays canonical-encoding
   * agnostic. Returns a 64-byte detached Ed25519 signature.
   */
  async signAuthChallenge(
    challenge: Uint8Array,
    username: string,
    timestamp?: number,
  ): Promise<Uint8Array> {
    const facade = await getRustFacade();
    const transcript = facade.buildAuthChallengeTranscript(
      username,
      timestamp,
      challenge,
    );

    if (this.preAuthState) {
      const { password, userSalt, kdf } = this.preAuthState;
      return facade.signAuthChallengeWithPassword(
        password,
        userSalt,
        kdf.memoryKib,
        kdf.iterations,
        kdf.parallelism,
        transcript,
      );
    }

    const accountId = this.requireAccountHandle();
    return this.handleRegistry.withLease(accountId, 'account', (rustAccount) =>
      facade.signAuthChallengeWithAccount(rustAccount, transcript),
    );
  }

  /**
   * Get the Ed25519 LocalAuth public key.
   *
   * Returns the pre-auth slot's public key when `deriveAuthKey()` has
   * populated it; otherwise returns the cached account-handle-rooted
   * public key (set by `init` / `initWithWrappedKey` /
   * `restoreSessionState`); otherwise `null`.
   */
  async getAuthPublicKey(): Promise<Uint8Array | null> {
    if (this.preAuthState) {
      return new Uint8Array(this.preAuthState.authPublicKey);
    }
    if (!this.authPublicKey) return null;
    return new Uint8Array(this.authPublicKey);
  }

  // =========================================================================
  // Album Content Encryption (Story Blocks) — Slice 7 handle-based
  // =========================================================================

  /**
   * Encrypt album content (story blocks document) using the album's
   * epoch handle.
   *
   * Slice 7 — replaces the legacy seed-bearing method body. The Rust
   * facade derives a content-specific sub-key from the epoch handle and
   * binds the epoch id as AAD; the seed never crosses Comlink.
   */
  async encryptAlbumContent(
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

  /**
   * Decrypt album content. Slice 7 — handle-based.
   */
  async decryptAlbumContent(
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

  /**
   * Encrypt an album name using the epoch handle's thumb-tier key.
   *
   * Slice 7 — thin wrapper over {@link encryptShardWithEpoch} that pins
   * `shardIndex=0` and `tier=ShardTier::Thumbnail` (byte value `1`,
   * matching `mosaic_domain::ShardTier::Thumbnail.to_byte()`). The
   * worker is the single source of truth for the (shardIndex, tier)
   * convention so callers do not duplicate magic numbers.
   */
  async encryptAlbumName(
    epochHandleId: EpochHandleId,
    nameBytes: Uint8Array,
  ): Promise<Uint8Array> {
    // tier=1 == ShardTier::Thumbnail.to_byte() in mosaic-domain.
    const { envelopeBytes } = await this.encryptShardWithEpoch(
      epochHandleId,
      nameBytes,
      0,
      1,
    );
    return envelopeBytes;
  }

  /**
   * Decrypt an album-name envelope. Slice 7 — thin wrapper over
   * {@link decryptShardWithEpoch}; the envelope header carries the tier
   * byte so callers do not specify it.
   */
  async decryptAlbumName(
    epochHandleId: EpochHandleId,
    envelopeBytes: Uint8Array,
  ): Promise<Uint8Array> {
    return this.decryptShardWithEpochHandle(epochHandleId, envelopeBytes);
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
    const passwordBytes = normalizePasswordForKdf(opts.password);
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
    // Slice 2: single Rust `createAccount` call collapses the previous
    // two-Argon2id-pass implementation. Generates a random L2, wraps it
    // under the L1 derived from the password+salts, and opens an opaque
    // secret handle in one Rust round-trip.
    await this.handleRegistry.clearAll();
    const facade = await getRustFacade();
    const passwordBytes = normalizePasswordForKdf(opts.password);
    try {
      const out = facade.createNewAccount({
        password: passwordBytes,
        userSalt: opts.userSalt,
        accountSalt: opts.accountSalt,
        kdfMemoryKib: opts.kdf.memoryKib,
        kdfIterations: opts.kdf.iterations,
        kdfParallelism: opts.kdf.parallelism,
      });
      const handle = this.handleRegistry.registerAccount(out.handle);
      return {
        accountHandleId: handle.id as AccountHandleId,
        wrappedAccountKey: out.wrappedAccountKey,
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

  async rewrapAccountKey(opts: {
    accountHandleId: AccountHandleId;
    newPassword: string;
    newUserSalt: Uint8Array;
    newAccountSalt: Uint8Array;
    kdf: WorkerKdfParams;
  }): Promise<{ wrappedAccountKey: Uint8Array }> {
    const facade = await getRustFacade();
    const passwordBytes = normalizePasswordForKdf(opts.newPassword);
    try {
      const wrappedAccountKey = await this.handleRegistry.withLease(
        opts.accountHandleId,
        'account',
        (rustAccount) =>
          facade.rewrapAccountKeyWithHandle({
            accountHandle: rustAccount,
            newPassword: passwordBytes,
            newUserSalt: opts.newUserSalt,
            newAccountSalt: opts.newAccountSalt,
            kdfMemoryKib: opts.kdf.memoryKib,
            kdfIterations: opts.kdf.iterations,
            kdfParallelism: opts.kdf.parallelism,
          }),
      );
      // Refresh the cached wrapped account key so subsequent
      // `getWrappedAccountKey` calls reflect the new envelope.
      this.wrappedAccountKey = new Uint8Array(wrappedAccountKey);
      return { wrappedAccountKey: new Uint8Array(wrappedAccountKey) };
    } finally {
      passwordBytes.fill(0);
    }
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
  ): Promise<{
    epochHandleId: EpochHandleId;
    wrappedSeed: Uint8Array;
    signPublicKey: Uint8Array;
  }> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(
      accountHandleId,
      'account',
      (rustAccount) => {
        const out = facade.createEpochKeyHandle(rustAccount, epochId);
        // Slice 1 contract: epoch handles are keyed by (albumId, epochId)
        // for the `getEpochHandleId` lookup. `createEpochHandle` doesn't
        // know the albumId yet — Slice 3 callers that need album binding
        // call `bindEpochHandleToAlbum` once the album is committed; the
        // legacy lookup remains forward-compatible.
        const handle = this.handleRegistry.registerEpoch('', epochId, out.handle);
        return {
          epochHandleId: handle.id as EpochHandleId,
          wrappedSeed: out.wrappedEpochSeed,
          signPublicKey: out.signPublicKey,
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
    tier: 1 | 2 | 3 | ShardTier,
  ): Promise<{ envelopeBytes: Uint8Array; sha256: string }> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(
      epochHandleId,
      'epoch',
      (rustEpoch) =>
        facade.encryptShardWithEpochHandle(rustEpoch, plaintext, shardIndex, tier),
    );
  }

  async encryptShardWithEpochHandle(
    epochHandleId: EpochHandleId | bigint,
    plaintext: Uint8Array,
    tier: number,
    shardIndex: number,
  ): Promise<Uint8Array> {
    const facade = await getRustFacade();
    const encrypt = (rustEpoch: bigint): Uint8Array =>
      facade.encryptShardWithEpochHandle(
        rustEpoch,
        plaintext,
        shardIndex,
        tier,
      ).envelopeBytes;

    if (typeof epochHandleId === 'bigint') {
      ensureNonNullRawEpochHandle(epochHandleId);
      return encrypt(epochHandleId);
    }

    return this.handleRegistry.withLease(epochHandleId, 'epoch', encrypt);
  }

  async decryptShardWithEpochHandle(
    epochHandleId: EpochHandleId | bigint,
    envelope: Uint8Array,
  ): Promise<Uint8Array> {
    const facade = await getRustFacade();
    const decrypt = (rustEpoch: bigint): Uint8Array =>
      facade.decryptShardWithEpochHandle(rustEpoch, envelope);

    if (typeof epochHandleId === 'bigint') {
      ensureNonNullRawEpochHandle(epochHandleId);
      return decrypt(epochHandleId);
    }

    return this.handleRegistry.withLease(epochHandleId, 'epoch', decrypt);
  }

  async verifyShardIntegrity(
    envelope: Uint8Array,
    expectedSha256: Uint8Array,
  ): Promise<boolean> {
    const facade = await getRustFacade();
    return facade.verifyShardIntegritySha256(envelope, expectedSha256);
  }

  async peekEnvelopeHeader(envelope: Uint8Array): Promise<EnvelopeHeader> {
    if (envelope[4] === ENVELOPE_VERSION_V04) {
      return parseStreamingEnvelopeHeader(envelope);
    }

    const facade = await getRustFacade();
    const parsed = facade.parseEnvelopeHeader(envelope);
    return {
      magic: 'SGzk',
      version: ENVELOPE_VERSION_V03,
      epoch: parsed.epochId,
      shard: parsed.shardIndex,
      nonce: parsed.nonce,
      tier: parsed.tier,
    };
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

  // =========================================================================
  // Link Sharing Operations (P-W7.6 � Rust handle contract)
  // =========================================================================

  async buildShareLinkUrl(opts: {
    baseUrl: string;
    albumId: string;
    linkId: string;
    linkUrlToken: string;
  }): Promise<string> {
    const facade = await getRustFacade();
    return facade.buildShareLinkUrl(opts);
  }

  async createLinkShareHandle(
    albumId: string,
    epochHandleId: EpochHandleId,
    tier: 1 | 2 | 3 | ShardTier,
  ): Promise<{
    linkShareHandleId: LinkShareHandleId;
    linkId: Uint8Array;
    linkUrlToken: Uint8Array;
    tier: number;
    nonce: Uint8Array;
    encryptedKey: Uint8Array;
  }> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(epochHandleId, 'epoch', (rustEpoch) => {
      const created = facade.createLinkShareHandle(albumId, rustEpoch, tier);
      const handle = this.handleRegistry.registerLinkShare(created.handle);
      return {
        linkShareHandleId: handle.id as LinkShareHandleId,
        linkId: created.linkId,
        linkUrlToken: created.linkUrlToken,
        tier: created.tier,
        nonce: created.nonce,
        encryptedKey: created.encryptedKey,
      };
    });
  }

  // v2 binding variant of createLinkShareHandle (batch 4d - A1).
  // Emits the first-tier wrap with AAD bound to (link_id, tier, epoch_id).
  // Use this for new share links so server-side wrap-row substitution is
  // detected on the visitor's import (closes audit share-link-create C1).
  async createLinkShareHandleV2(
    albumId: string,
    epochHandleId: EpochHandleId,
    tier: 1 | 2 | 3 | ShardTier,
  ): Promise<{
    linkShareHandleId: LinkShareHandleId;
    linkId: Uint8Array;
    linkUrlToken: Uint8Array;
    tier: number;
    nonce: Uint8Array;
    encryptedKey: Uint8Array;
  }> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(epochHandleId, 'epoch', (rustEpoch) => {
      const created = facade.createLinkShareHandleV2(albumId, rustEpoch, tier);
      const handle = this.handleRegistry.registerLinkShare(created.handle);
      return {
        linkShareHandleId: handle.id as LinkShareHandleId,
        linkId: created.linkId,
        linkUrlToken: created.linkUrlToken,
        tier: created.tier,
        nonce: created.nonce,
        encryptedKey: created.encryptedKey,
      };
    });
  }

  async importLinkShareHandle(
    linkUrlToken: Uint8Array,
  ): Promise<{ linkShareHandleId: LinkShareHandleId; linkId: Uint8Array }> {
    const facade = await getRustFacade();
    const imported = facade.importLinkShareHandle(linkUrlToken);
    const handle = this.handleRegistry.registerLinkShare(imported.handle);
    return {
      linkShareHandleId: handle.id as LinkShareHandleId,
      linkId: imported.linkId,
    };
  }

  async wrapLinkTierHandle(
    linkShareHandleId: LinkShareHandleId,
    epochHandleId: EpochHandleId,
    tier: 1 | 2 | 3 | ShardTier,
  ): Promise<{ tier: number; nonce: Uint8Array; encryptedKey: Uint8Array }> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(linkShareHandleId, 'linkShare', (rustLink) =>
      this.handleRegistry.withLease(epochHandleId, 'epoch', (rustEpoch) =>
        facade.wrapLinkTierHandle(rustLink, rustEpoch, tier),
      ),
    );
  }

  // v2 binding variant of wrapLinkTierHandle (batch 4d - A1).
  async wrapLinkTierHandleV2(
    linkShareHandleId: LinkShareHandleId,
    epochHandleId: EpochHandleId,
    tier: 1 | 2 | 3 | ShardTier,
  ): Promise<{ tier: number; nonce: Uint8Array; encryptedKey: Uint8Array }> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(linkShareHandleId, 'linkShare', (rustLink) =>
      this.handleRegistry.withLease(epochHandleId, 'epoch', (rustEpoch) =>
        facade.wrapLinkTierHandleV2(rustLink, rustEpoch, tier),
      ),
    );
  }

  async importLinkTierHandle(
    linkUrlToken: Uint8Array,
    nonce: Uint8Array,
    encryptedKey: Uint8Array,
    albumId: string,
    tier: 1 | 2 | 3 | ShardTier,
  ): Promise<{ linkTierHandleId: LinkTierHandleId; linkId: Uint8Array; tier: number }> {
    const facade = await getRustFacade();
    const imported = facade.importLinkTierHandle(
      linkUrlToken,
      nonce,
      encryptedKey,
      albumId,
      tier,
    );
    const handle = this.handleRegistry.registerLinkTier(imported.handle);
    return {
      linkTierHandleId: handle.id as LinkTierHandleId,
      linkId: imported.linkId,
      tier: imported.tier,
    };
  }

  // v2 binding variant of importLinkTierHandle (batch 4d - A1).
  // The visitor passes the epochId parsed from the signed album manifest.
  // The unwrap dual-accepts pre-A1 v1 wraps so legacy share links keep
  // working; v2 wraps enforce (link_id, tier, epoch_id) so a malicious
  // server cannot substitute wrap rows across tiers / links / epochs.
  async importLinkTierHandleV2(
    linkUrlToken: Uint8Array,
    nonce: Uint8Array,
    encryptedKey: Uint8Array,
    albumId: string,
    tier: 1 | 2 | 3 | ShardTier,
    epochId: number,
  ): Promise<{ linkTierHandleId: LinkTierHandleId; linkId: Uint8Array; tier: number }> {
    const facade = await getRustFacade();
    const imported = facade.importLinkTierHandleV2(
      linkUrlToken,
      nonce,
      encryptedKey,
      albumId,
      tier,
      epochId,
    );
    const handle = this.handleRegistry.registerLinkTier(imported.handle);
    return {
      linkTierHandleId: handle.id as LinkTierHandleId,
      linkId: imported.linkId,
      tier: imported.tier,
    };
  }

  async mintLinkTierHandleFromRawKey(
    rawKey: Uint8Array,
  ): Promise<LinkTierHandleId> {
    const facade = await getRustFacade();
    const imported = facade.mintLinkTierHandleFromRawKey(rawKey);
    const handle = this.handleRegistry.registerLinkTier(imported.handle);
    return handle.id as LinkTierHandleId;
  }

  async decryptShardWithLinkTierHandle(
    linkTierHandleId: LinkTierHandleId,
    envelopeBytes: Uint8Array,
  ): Promise<Uint8Array> {
    const facade = await getRustFacade();
    return this.handleRegistry.withLease(linkTierHandleId, 'linkTier', (rustLinkTier) =>
      facade.decryptShardWithLinkTierHandle(rustLinkTier, envelopeBytes),
    );
  }

  async closeLinkShareHandle(linkShareHandleId: LinkShareHandleId): Promise<void> {
    await this.handleRegistry.closeHandle(linkShareHandleId, 'linkShare');
  }

  async closeLinkTierHandle(linkTierHandleId: LinkTierHandleId): Promise<void> {
    await this.handleRegistry.closeHandle(linkTierHandleId, 'linkTier');
  }

  // Slice 7 — `encryptAlbumContent` / `decryptAlbumContent` (handle-based)
  // are declared in the Album Content Encryption block above. The Slice 1
  // `*WithEpoch` aliases were retired now that the legacy seed-bearing
  // methods have been deleted.

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

}

// Create worker instance and expose via Comlink
export const cryptoWorker = new CryptoWorker();
Comlink.expose(cryptoWorker);
