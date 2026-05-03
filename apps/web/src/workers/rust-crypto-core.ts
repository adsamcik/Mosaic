/**
 * Rust crypto facade — Slice 1 of the web → Rust cutover.
 *
 * Centralizes EVERY call into the generated `mosaic_wasm` binding. Each
 * exported wrapper:
 *   1. accepts plain JS types (Uint8Array / string / number / bigint),
 *   2. invokes the WASM function,
 *   3. reads result fields off the wasm-bindgen result object,
 *   4. disposes the result via `result.free()` in a `try/finally`,
 *   5. translates any non-zero `code` into a typed `WorkerCryptoError`.
 *
 * The boundary guard (`tests/rust-cutover-boundary.test.ts`) enforces that
 * **only** this file imports from `../generated/mosaic-wasm/...`. Slices 2-8
 * remove direct `@mosaic/crypto` / libsodium calls from the worker; this
 * facade is the resulting single Rust entry-point.
 */

import initRustWasm, * as rustWasm from '../generated/mosaic-wasm/mosaic_wasm.js';
import { WorkerCryptoError, WorkerCryptoErrorCode } from './types';

const RUST_OK = 0;
const ENVELOPE_HEADER_BYTES = 64;
const MANIFEST_SIGNATURE_BYTES = 64;
const IDENTITY_PUBLIC_KEY_BYTES = 32;
const MANIFEST_CONTEXT_BYTES = new TextEncoder().encode('Mosaic_Manifest_v1');
const WORKER_ONLY_ERROR_CODE_START = 1000;
const KNOWN_RUST_CLIENT_ERROR_CODES = new Set<number>(
  Object.values(WorkerCryptoErrorCode).filter(
    (code): code is number =>
      typeof code === 'number' && code < WORKER_ONLY_ERROR_CODE_START,
  ),
);

// ---------------------------------------------------------------------------
// Lazy WASM init — single shared promise across the worker.
// ---------------------------------------------------------------------------

let rustReadyPromise: Promise<void> | null = null;

/** Resolve once the wasm-bindgen module has been instantiated. */
export function ensureRustReady(): Promise<void> {
  rustReadyPromise ??= initRustWasm().then(() => undefined);
  return rustReadyPromise;
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

export function rustCodeToWorkerCode(code: number): WorkerCryptoErrorCode {
  // Numeric codes in `WorkerCryptoErrorCode` are aligned with
  // `mosaic_client::ClientErrorCode`. Worker-only codes remain reserved for
  // TypeScript-originated failures and must not be accepted from Rust.
  if (KNOWN_RUST_CLIENT_ERROR_CODES.has(code)) {
    return code as WorkerCryptoErrorCode;
  }
  return WorkerCryptoErrorCode.InternalStatePoisoned;
}

function throwIfErrorCode(code: number, contextLabel: string): void {
  if (code === RUST_OK) return;
  throw new WorkerCryptoError(
    rustCodeToWorkerCode(code),
    `${contextLabel} failed (rust code ${String(code)})`,
  );
}

/**
 * Wrap a wasm-bindgen result object so its `.free()` runs in a finally block
 * and any non-zero `.code` becomes a `WorkerCryptoError`.
 */
function consumeResult<R extends { code: number; free(): void }, T>(
  result: R,
  contextLabel: string,
  pluck: (r: R) => T,
): T {
  try {
    throwIfErrorCode(result.code, contextLabel);
    return pluck(result);
  } finally {
    try {
      result.free();
    } catch {
      // wasm-bindgen frees can throw if the object was double-freed by a
      // previous error path — swallow so the outer error wins.
    }
  }
}

// ---------------------------------------------------------------------------
// Typed facade
// ---------------------------------------------------------------------------

/**
 * Singleton facade exposing typed wrappers for every WASM export the worker
 * uses. The worker module instantiates exactly one of these (lazily, on first
 * call) and routes all Rust traffic through it.
 */
export class RustHandleFacade {
  private initialized = false;

  /** Lazily initialize the WASM module on first use. Idempotent. */
  async init(): Promise<void> {
    if (!this.initialized) {
      await ensureRustReady();
      this.initialized = true;
    }
  }

  // ---- Account handle lifecycle ----

  /**
   * Unlock an account from a wrapped account key. Throws on KDF/AEAD failure.
   * @returns The Rust handle as a bigint (worker maps it to a string ID).
   */
  unlockAccount(opts: {
    password: Uint8Array;
    userSalt: Uint8Array;
    accountSalt: Uint8Array;
    wrappedAccountKey: Uint8Array;
    kdfMemoryKib: number;
    kdfIterations: number;
    kdfParallelism: number;
  }): bigint {
    const result = rustWasm.unlockAccountKey(
      opts.password,
      opts.userSalt,
      opts.accountSalt,
      opts.wrappedAccountKey,
      opts.kdfMemoryKib,
      opts.kdfIterations,
      opts.kdfParallelism,
    );
    return consumeResult(result, 'unlockAccountKey', (r) => r.handle);
  }

  /**
   * Mint a brand-new account-key handle in a single Argon2id pass.
   *
   * Returns the opaque Rust handle plus the wrapped account key bytes
   * the caller must persist on the server. The L2 account key never
   * crosses the WASM boundary.
   */
  createNewAccount(opts: {
    password: Uint8Array;
    userSalt: Uint8Array;
    accountSalt: Uint8Array;
    kdfMemoryKib: number;
    kdfIterations: number;
    kdfParallelism: number;
  }): { handle: bigint; wrappedAccountKey: Uint8Array } {
    const result = rustWasm.createAccount(
      opts.password,
      opts.userSalt,
      opts.accountSalt,
      opts.kdfMemoryKib,
      opts.kdfIterations,
      opts.kdfParallelism,
    );
    return consumeResult(result, 'createAccount', (r) => ({
      handle: r.handle,
      wrappedAccountKey: copyBytes(r.wrappedAccountKey),
    }));
  }

  closeAccountHandle(handle: bigint): void {
    const code = rustWasm.closeAccountKeyHandle(handle);
    throwIfErrorCode(code, 'closeAccountKeyHandle');
  }

  accountKeyHandleIsOpen(handle: bigint): boolean {
    const result = rustWasm.accountKeyHandleIsOpen(handle);
    return consumeResult(result, 'accountKeyHandleIsOpen', (r) => r.isOpen);
  }

  // ---- Identity handle lifecycle ----

  createIdentityHandle(accountHandle: bigint): {
    handle: bigint;
    signingPubkey: Uint8Array;
    encryptionPubkey: Uint8Array;
    wrappedSeed: Uint8Array;
  } {
    const result = rustWasm.createIdentityHandle(accountHandle);
    return consumeResult(result, 'createIdentityHandle', (r) => ({
      handle: r.handle,
      signingPubkey: copyBytes(r.signingPubkey),
      encryptionPubkey: copyBytes(r.encryptionPubkey),
      wrappedSeed: copyBytes(r.wrappedSeed),
    }));
  }

  openIdentityHandle(
    wrappedSeed: Uint8Array,
    accountHandle: bigint,
  ): {
    handle: bigint;
    signingPubkey: Uint8Array;
    encryptionPubkey: Uint8Array;
  } {
    const result = rustWasm.openIdentityHandle(wrappedSeed, accountHandle);
    return consumeResult(result, 'openIdentityHandle', (r) => ({
      handle: r.handle,
      signingPubkey: copyBytes(r.signingPubkey),
      encryptionPubkey: copyBytes(r.encryptionPubkey),
    }));
  }

  closeIdentityHandle(handle: bigint): void {
    const code = rustWasm.closeIdentityHandle(handle);
    throwIfErrorCode(code, 'closeIdentityHandle');
  }

  identitySigningPubkey(handle: bigint): Uint8Array {
    const result = rustWasm.identitySigningPubkey(handle);
    return consumeResult(result, 'identitySigningPubkey', (r) =>
      copyBytes(r.bytes),
    );
  }

  identityEncryptionPubkey(handle: bigint): Uint8Array {
    const result = rustWasm.identityEncryptionPubkey(handle);
    return consumeResult(result, 'identityEncryptionPubkey', (r) =>
      copyBytes(r.bytes),
    );
  }

  signManifestWithIdentity(
    handle: bigint,
    transcriptBytes: Uint8Array,
  ): Uint8Array {
    const result = rustWasm.signManifestWithIdentity(handle, transcriptBytes);
    return consumeResult(result, 'signManifestWithIdentity', (r) =>
      copyBytes(r.bytes),
    );
  }

  /**
   * Verify a detached Ed25519 manifest signature. Returns true when the
   * Rust verifier accepts the signature; returns false on
   * `AuthenticationFailed`. Other error codes throw.
   */
  verifyManifestWithIdentity(
    transcriptBytes: Uint8Array,
    signature: Uint8Array,
    publicKey: Uint8Array,
  ): boolean {
    const code = rustWasm.verifyManifestWithIdentity(
      transcriptBytes,
      signature,
      publicKey,
    );
    if (code === RUST_OK) return true;
    if (code === WorkerCryptoErrorCode.AuthenticationFailed) return false;
    throwIfErrorCode(code, 'verifyManifestWithIdentity');
    return false;
  }

  // ---- Epoch handle lifecycle ----

  createEpochKeyHandle(
    accountHandle: bigint,
    epochId: number,
  ): {
    handle: bigint;
    epochId: number;
    wrappedEpochSeed: Uint8Array;
    signPublicKey: Uint8Array;
  } {
    const result = rustWasm.createEpochKeyHandle(accountHandle, epochId);
    return consumeResult(result, 'createEpochKeyHandle', (r) => ({
      handle: r.handle,
      epochId: r.epochId,
      wrappedEpochSeed: copyBytes(r.wrappedEpochSeed),
      signPublicKey: copyBytes(r.signPublicKey),
    }));
  }

  openEpochKeyHandle(
    wrappedEpochSeed: Uint8Array,
    accountHandle: bigint,
    epochId: number,
  ): { handle: bigint; epochId: number } {
    const result = rustWasm.openEpochKeyHandle(
      wrappedEpochSeed,
      accountHandle,
      epochId,
    );
    return consumeResult(result, 'openEpochKeyHandle', (r) => ({
      handle: r.handle,
      epochId: r.epochId,
    }));
  }

  /**
   * Atomically seals an epoch key bundle using both the sender identity
   * handle and the sender's epoch handle. Bundle payload bytes never cross
   * the FFI boundary — the caller only supplies the recipient's signing
   * public key (Ed25519) and the album id.
   */
  sealBundleWithEpochHandle(
    identityHandle: bigint,
    epochHandle: bigint,
    recipientPubkey: Uint8Array,
    albumId: string,
  ): { sealed: Uint8Array; signature: Uint8Array; sharerPubkey: Uint8Array } {
    const result = rustWasm.sealBundleWithEpochHandle(
      identityHandle,
      epochHandle,
      recipientPubkey,
      albumId,
    );
    return consumeResult(result, 'sealBundleWithEpochHandle', (r) => ({
      sealed: copyBytes(r.sealed),
      signature: copyBytes(r.signature),
      sharerPubkey: copyBytes(r.sharerPubkey),
    }));
  }

  closeEpochKeyHandle(handle: bigint): void {
    const code = rustWasm.closeEpochKeyHandle(handle);
    throwIfErrorCode(code, 'closeEpochKeyHandle');
  }

  epochKeyHandleIsOpen(handle: bigint): boolean {
    const result = rustWasm.epochKeyHandleIsOpen(handle);
    return consumeResult(result, 'epochKeyHandleIsOpen', (r) => r.isOpen);
  }

  encryptShardWithEpochHandle(
    handle: bigint,
    plaintext: Uint8Array,
    shardIndex: number,
    tierByte: number,
  ): { envelopeBytes: Uint8Array; sha256: string } {
    const result = rustWasm.encryptShardWithEpochHandle(
      handle,
      plaintext,
      shardIndex,
      tierByte,
    );
    return consumeResult(result, 'encryptShardWithEpochHandle', (r) => ({
      envelopeBytes: copyBytes(r.envelopeBytes),
      sha256: r.sha256,
    }));
  }

  decryptShardWithEpochHandle(
    handle: bigint,
    envelopeBytes: Uint8Array,
  ): Uint8Array {
    const result = rustWasm.decryptShardWithEpochHandle(handle, envelopeBytes);
    return consumeResult(result, 'decryptShardWithEpochHandle', (r) =>
      copyBytes(r.plaintext),
    );
  }

  /**
   * Sign manifest transcript bytes with the per-epoch Ed25519 sign secret
   * attached to a Rust-owned epoch handle. The sign secret never crosses
   * the FFI boundary.
   *
   * Slice 4 — replaces the legacy TS `signManifest(transcript, secretKey)`.
   */
  signManifestWithEpochHandle(
    handle: bigint,
    transcriptBytes: Uint8Array,
  ): Uint8Array {
    const result = rustWasm.signManifestWithEpochHandle(handle, transcriptBytes);
    return consumeResult(result, 'signManifestWithEpochHandle', (r) =>
      copyBytes(r.bytes),
    );
  }

  /**
   * Verify a detached Ed25519 manifest signature against a per-epoch
   * manifest signing public key. Returns true on `Ok`, false on
   * `AuthenticationFailed`. Other error codes throw.
   *
   * Slice 4 — replaces the legacy TS `verifyManifest`.
   */
  verifyManifestWithEpoch(
    transcriptBytes: Uint8Array,
    signature: Uint8Array,
    publicKey: Uint8Array,
  ): boolean {
    const code = rustWasm.verifyManifestWithEpoch(
      transcriptBytes,
      signature,
      publicKey,
    );
    if (code === RUST_OK) return true;
    if (code === WorkerCryptoErrorCode.AuthenticationFailed) return false;
    throwIfErrorCode(code, 'verifyManifestWithEpoch');
    return false;
  }

  encryptMetadataSidecarWithEpochHandle(
    handle: bigint,
    albumId: Uint8Array,
    photoId: Uint8Array,
    epochId: number,
    encodedFields: Uint8Array,
    shardIndex: number,
  ): { envelopeBytes: Uint8Array; sha256: string } {
    const result = rustWasm.encryptMetadataSidecarWithEpochHandle(
      handle,
      albumId,
      photoId,
      epochId,
      encodedFields,
      shardIndex,
    );
    return consumeResult(
      result,
      'encryptMetadataSidecarWithEpochHandle',
      (r) => ({
        envelopeBytes: copyBytes(r.envelopeBytes),
        sha256: r.sha256,
      }),
    );
  }

  // ---- Auth challenge ----

  deriveAuthKeypairFromAccount(accountHandle: bigint): Uint8Array {
    const result = rustWasm.deriveAuthKeypairFromAccount(accountHandle);
    return consumeResult(result, 'deriveAuthKeypairFromAccount', (r) =>
      copyBytes(r.authPublicKey),
    );
  }

  getAuthPublicKeyFromAccount(accountHandle: bigint): Uint8Array {
    const result = rustWasm.getAuthPublicKeyFromAccount(accountHandle);
    return consumeResult(result, 'getAuthPublicKeyFromAccount', (r) =>
      copyBytes(r.bytes),
    );
  }

  signAuthChallengeWithAccount(
    accountHandle: bigint,
    challengeBytes: Uint8Array,
  ): Uint8Array {
    const result = rustWasm.signAuthChallengeWithAccount(
      accountHandle,
      challengeBytes,
    );
    return consumeResult(result, 'signAuthChallengeWithAccount', (r) =>
      copyBytes(r.bytes),
    );
  }

  // ---- Password-rooted auth (pre-auth slot, used before account handle is open) ----

  /**
   * Derive the password-rooted LocalAuth Ed25519 keypair (Argon2id+HKDF
   * over `password`+`userSalt`) and return the 32-byte public key.
   * Used by the worker's `deriveAuthKey()` pre-auth slot.
   */
  deriveAuthKeypairFromPassword(
    password: Uint8Array,
    userSalt: Uint8Array,
    kdfMemoryKib: number,
    kdfIterations: number,
    kdfParallelism: number,
  ): Uint8Array {
    const result = rustWasm.deriveAuthKeypairFromPassword(
      password,
      userSalt,
      kdfMemoryKib,
      kdfIterations,
      kdfParallelism,
    );
    return consumeResult(result, 'deriveAuthKeypairFromPassword', (r) =>
      copyBytes(r.authPublicKey),
    );
  }

  /**
   * Sign an auth challenge transcript with the password-rooted auth
   * keypair. Re-runs Argon2id+HKDF on every call.
   */
  signAuthChallengeWithPassword(
    password: Uint8Array,
    userSalt: Uint8Array,
    kdfMemoryKib: number,
    kdfIterations: number,
    kdfParallelism: number,
    transcriptBytes: Uint8Array,
  ): Uint8Array {
    const result = rustWasm.signAuthChallengeWithPassword(
      password,
      userSalt,
      kdfMemoryKib,
      kdfIterations,
      kdfParallelism,
      transcriptBytes,
    );
    return consumeResult(result, 'signAuthChallengeWithPassword', (r) =>
      copyBytes(r.bytes),
    );
  }

  /**
   * Return only the password-rooted LocalAuth Ed25519 public key.
   * Re-runs Argon2id+HKDF on every call; prefer
   * `signAuthChallengeWithPassword` when both signing and the public
   * key are needed.
   */
  getAuthPublicKeyFromPassword(
    password: Uint8Array,
    userSalt: Uint8Array,
    kdfMemoryKib: number,
    kdfIterations: number,
    kdfParallelism: number,
  ): Uint8Array {
    const result = rustWasm.getAuthPublicKeyFromPassword(
      password,
      userSalt,
      kdfMemoryKib,
      kdfIterations,
      kdfParallelism,
    );
    return consumeResult(result, 'getAuthPublicKeyFromPassword', (r) =>
      copyBytes(r.bytes),
    );
  }

  // ---- Link sharing ----

  generateLinkSecret(): Uint8Array {
    const result = rustWasm.generateLinkSecret();
    return consumeResult(result, 'generateLinkSecret', (r) =>
      copyBytes(r.bytes),
    );
  }

  deriveLinkKeys(linkSecret: Uint8Array): {
    linkId: Uint8Array;
    wrappingKey: Uint8Array;
  } {
    const result = rustWasm.deriveLinkKeys(linkSecret);
    return consumeResult(result, 'deriveLinkKeys', (r) => ({
      linkId: copyBytes(r.linkId),
      wrappingKey: copyBytes(r.wrappingKey),
    }));
  }

  wrapTierKeyForLink(
    epochHandle: bigint,
    tierByte: number,
    wrappingKey: Uint8Array,
  ): { tier: number; nonce: Uint8Array; encryptedKey: Uint8Array } {
    const result = rustWasm.wrapTierKeyForLink(
      epochHandle,
      tierByte,
      wrappingKey,
    );
    return consumeResult(result, 'wrapTierKeyForLink', (r) => ({
      tier: r.tier,
      nonce: copyBytes(r.nonce),
      encryptedKey: copyBytes(r.encryptedKey),
    }));
  }

  unwrapTierKeyFromLink(
    nonce: Uint8Array,
    encryptedKey: Uint8Array,
    tierByte: number,
    wrappingKey: Uint8Array,
  ): Uint8Array {
    const result = rustWasm.unwrapTierKeyFromLink(
      nonce,
      encryptedKey,
      tierByte,
      wrappingKey,
    );
    return consumeResult(result, 'unwrapTierKeyFromLink', (r) =>
      copyBytes(r.bytes),
    );
  }

  // ---- Album content ----

  encryptAlbumContent(
    epochHandle: bigint,
    plaintext: Uint8Array,
  ): { nonce: Uint8Array; ciphertext: Uint8Array } {
    const result = rustWasm.encryptAlbumContent(epochHandle, plaintext);
    return consumeResult(result, 'encryptAlbumContent', (r) => ({
      nonce: copyBytes(r.nonce),
      ciphertext: copyBytes(r.ciphertext),
    }));
  }

  decryptAlbumContent(
    epochHandle: bigint,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
  ): Uint8Array {
    const result = rustWasm.decryptAlbumContent(epochHandle, nonce, ciphertext);
    return consumeResult(result, 'decryptAlbumContent', (r) =>
      copyBytes(r.plaintext),
    );
  }

  verifyAndImportEpochBundle(
    identityHandle: bigint,
    sealed: Uint8Array,
    signature: Uint8Array,
    sharerPubkey: Uint8Array,
    expectedAlbumId: string,
    expectedMinEpoch: number,
    allowLegacyEmpty: boolean,
  ): {
    handle: bigint;
    epochId: number;
    wrappedEpochSeed: Uint8Array;
    signPublicKey: Uint8Array;
  } {
    const result = rustWasm.verifyAndImportEpochBundle(
      identityHandle,
      sealed,
      signature,
      sharerPubkey,
      expectedAlbumId,
      expectedMinEpoch,
      allowLegacyEmpty,
    );
    return consumeResult(result, 'verifyAndImportEpochBundle', (r) => ({
      handle: r.handle,
      epochId: r.epochId,
      wrappedEpochSeed: copyBytes(r.wrappedEpochSeed),
      signPublicKey: copyBytes(r.signPublicKey),
    }));
  }

  // ---- Account-handle-keyed wrap/unwrap (Slice 2 + Slice 6 + Slice 8) ----

  /**
   * Wrap `plaintext` with the L2 account key referenced by `accountHandle`.
   *
   * The L2 bytes never cross the JS boundary; this resolves the handle
   * inside Rust and uses the secret directly. Output layout is
   * `nonce(24) || ciphertext_with_tag`.
   */
  wrapWithAccountHandle(accountHandle: bigint, plaintext: Uint8Array): Uint8Array {
    const result = rustWasm.wrapWithAccountHandle(accountHandle, plaintext);
    return consumeResult(result, 'wrapWithAccountHandle', (r) => copyBytes(r.bytes));
  }

  unwrapWithAccountHandle(accountHandle: bigint, wrapped: Uint8Array): Uint8Array {
    const result = rustWasm.unwrapWithAccountHandle(accountHandle, wrapped);
    return consumeResult(result, 'unwrapWithAccountHandle', (r) => copyBytes(r.bytes));
  }

  // ---- LocalAuth challenge transcript ----

  /**
   * Build the canonical LocalAuth challenge transcript bytes the backend
   * verifies. Routes through the Rust canonical encoder so the worker
   * does not need to maintain a JS-side reimplementation.
   *
   * `timestampMs === undefined` omits the timestamp segment to match the
   * optional shape the backend accepts.
   */
  buildAuthChallengeTranscript(
    username: string,
    timestampMs: number | undefined,
    challenge: Uint8Array,
  ): Uint8Array {
    const present = timestampMs !== undefined;
    const tsAsBigInt = present ? BigInt(timestampMs) : 0n;
    const result = rustWasm.buildAuthChallengeTranscript(
      username,
      tsAsBigInt,
      present,
      challenge,
    );
    return consumeResult(result, 'buildAuthChallengeTranscript', (r) =>
      copyBytes(r.bytes),
    );
  }

  // ---- Header parsing (legacy peek path uses this) ----

  parseEnvelopeHeader(headerBytes: Uint8Array): {
    epochId: number;
    shardIndex: number;
    tier: number;
  } {
    const result = rustWasm.parseEnvelopeHeader(
      headerBytes.subarray(0, ENVELOPE_HEADER_BYTES),
    );
    return consumeResult(result, 'parseEnvelopeHeader', (r) => ({
      epochId: r.epochId,
      shardIndex: r.shardIndex,
      tier: r.tier,
    }));
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton + lazy getter (used by the worker, exported for tests)
// ---------------------------------------------------------------------------

let facadeInstance: RustHandleFacade | null = null;
let facadeReadyPromise: Promise<RustHandleFacade> | null = null;

export function getRustFacade(): Promise<RustHandleFacade> {
  if (facadeReadyPromise) return facadeReadyPromise;
  facadeReadyPromise = (async () => {
    facadeInstance = new RustHandleFacade();
    await facadeInstance.init();
    return facadeInstance;
  })();
  return facadeReadyPromise;
}

// ---------------------------------------------------------------------------
// Legacy compatibility surface — used by Slice 0 wiring and the existing
// rust-crypto-core unit tests. Slices 2-9 will replace each caller; for now
// these adapters keep the prior behaviour pointing at the new facade so
// peekHeader / verifyManifest continue to work without regression.
// ---------------------------------------------------------------------------

const RUST_OK_LEGACY = 0;

export interface RustHeaderResult {
  readonly code: number;
  readonly epochId: number;
  readonly shardIndex: number;
  readonly tier: number;
  free(): void;
}

export interface RustCryptoCore {
  parseEnvelopeHeader(bytes: Uint8Array): RustHeaderResult;
  verifyManifestWithIdentity(
    transcriptBytes: Uint8Array,
    signature: Uint8Array,
    publicKey: Uint8Array,
  ): number;
}

let legacyCorePromise: Promise<RustCryptoCore> | null = null;

/** Legacy accessor retained for backwards-compatibility tests. */
export function getRustCryptoCore(): Promise<RustCryptoCore> {
  legacyCorePromise ??= ensureRustReady().then(() => rustWasm);
  return legacyCorePromise;
}

export function buildLegacyManifestTranscript(
  manifest: Uint8Array,
): Uint8Array {
  const transcript = new Uint8Array(
    MANIFEST_CONTEXT_BYTES.length + manifest.length,
  );
  transcript.set(MANIFEST_CONTEXT_BYTES, 0);
  transcript.set(manifest, MANIFEST_CONTEXT_BYTES.length);
  return transcript;
}

export function verifyLegacyManifestWithRust(
  rust: RustCryptoCore,
  manifest: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (
    signature.length !== MANIFEST_SIGNATURE_BYTES ||
    publicKey.length !== IDENTITY_PUBLIC_KEY_BYTES
  ) {
    return false;
  }

  const transcript = buildLegacyManifestTranscript(manifest);
  return (
    rust.verifyManifestWithIdentity(transcript, signature, publicKey) ===
    RUST_OK_LEGACY
  );
}

export function parseEnvelopeHeaderFromRust(
  rust: RustCryptoCore,
  envelope: Uint8Array,
): { epochId: number; shardId: number; tier: number } {
  const result = rust.parseEnvelopeHeader(envelope.slice(0, ENVELOPE_HEADER_BYTES));
  try {
    if (result.code !== RUST_OK_LEGACY) {
      throw new Error(`Rust envelope header parse failed with code ${String(result.code)}`);
    }

    return {
      epochId: result.epochId,
      shardId: result.shardIndex,
      tier: result.tier,
    };
  } finally {
    result.free();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Copy bytes off the wasm-bindgen result object so the underlying buffer can
 * safely be `free()`-ed by `consumeResult`. Without this copy the returned
 * `Uint8Array` would point at memory owned by the freed wasm-bindgen object.
 */
function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}
