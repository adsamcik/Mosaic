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
import type { DownloadSchedule } from '../lib/download-schedule';
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

export interface DownloadApplyResult {
  readonly newStateBytes: Uint8Array;
}

export interface DownloadBuildPlanShardInput {
  readonly shardId: Uint8Array;
  readonly epochId: number;
  readonly tier: number;
  readonly expectedHash: Uint8Array;
  readonly declaredSize: number | bigint;
}

export interface DownloadBuildPlanPhotoInput {
  readonly photoId: string;
  readonly filename: string;
  readonly shards: readonly DownloadBuildPlanShardInput[];
}

export interface DownloadBuildPlanInput {
  readonly photos: readonly DownloadBuildPlanPhotoInput[];
}
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

  // ---- Download orchestration (pure-functional v1) ----

  applyDownloadEvent(
    stateBytes: Uint8Array,
    eventBytes: Uint8Array,
  ): DownloadApplyResult {
    const result = rustWasm.downloadApplyEventV1(stateBytes, eventBytes);
    return consumeResult(result, 'downloadApplyEventV1', (r) => ({
      newStateBytes: copyBytes(r.newStateCbor),
    }));
  }

  buildDownloadPlan(
    input: DownloadBuildPlanInput | Uint8Array,
  ): { planBytes: Uint8Array } {
    const inputBytes =
      input instanceof Uint8Array ? input : encodeDownloadBuildPlanInput(input);
    const result = rustWasm.downloadBuildPlanV1(inputBytes);
    return consumeResult(result, 'downloadBuildPlanV1', (r) => ({
      planBytes: copyBytes(r.planCbor),
    }));
  }

  initDownloadSnapshot(input: {
    readonly jobId: Uint8Array;
    readonly albumId: string;
    readonly planBytes: Uint8Array;
    readonly nowMs: number;
    readonly scopeKey: string;
    readonly schedule?: DownloadSchedule | null;
  }): { bodyBytes: Uint8Array; checksum: Uint8Array } {
    const result = rustWasm.downloadInitSnapshotV1(
      encodeDownloadInitSnapshotInput(input),
    );
    return consumeResult(result, 'downloadInitSnapshotV1', (r) => ({
      bodyBytes: copyBytes(r.body),
      checksum: copyBytes(r.checksum),
    }));
  }

  loadDownloadSnapshot(
    snapshotBytes: Uint8Array,
    checksum: Uint8Array,
  ): { snapshotBytes: Uint8Array; schemaVersionLoaded: number } {
    const result = rustWasm.downloadLoadSnapshotV1(snapshotBytes, checksum);
    return consumeResult(result, 'downloadLoadSnapshotV1', (r) => ({
      snapshotBytes: copyBytes(r.snapshotCbor),
      schemaVersionLoaded: r.schemaVersionLoaded,
    }));
  }

  commitDownloadSnapshot(snapshotBytes: Uint8Array): { checksum: Uint8Array } {
    const result = rustWasm.downloadCommitSnapshotV1(snapshotBytes);
    return consumeResult(result, 'downloadCommitSnapshotV1', (r) => ({
      checksum: copyBytes(r.checksum),
    }));
  }

  verifyDownloadSnapshot(
    snapshotBytes: Uint8Array,
    checksum: Uint8Array,
  ): { valid: boolean } {
    const result = rustWasm.downloadVerifySnapshotV1(snapshotBytes, checksum);
    return consumeResult(result, 'downloadVerifySnapshotV1', (r) => ({
      valid: r.valid,
    }));
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

  createLinkShareHandle(
    albumId: string,
    epochHandle: bigint,
    tierByte: number,
  ): {
    handle: bigint;
    linkId: Uint8Array;
    linkSecretForUrl: Uint8Array;
    tier: number;
    nonce: Uint8Array;
    encryptedKey: Uint8Array;
  } {
    const result = rustWasm.createLinkShareHandle(albumId, epochHandle, tierByte);
    return consumeResult(result, 'createLinkShareHandle', (r) => ({
      handle: r.handle,
      linkId: copyBytes(r.linkId),
      linkSecretForUrl: copyBytes(r.linkSecretForUrl),
      tier: r.tier,
      nonce: copyBytes(r.nonce),
      encryptedKey: copyBytes(r.encryptedKey),
    }));
  }

  importLinkShareHandle(linkSecretForUrl: Uint8Array): {
    handle: bigint;
    linkId: Uint8Array;
    tier: number;
  } {
    const result = rustWasm.importLinkShareHandle(linkSecretForUrl);
    return consumeResult(result, 'importLinkShareHandle', (r) => ({
      handle: r.handle,
      linkId: copyBytes(r.linkId),
      tier: r.tier,
    }));
  }

  wrapLinkTierHandle(
    linkShareHandle: bigint,
    epochHandle: bigint,
    tierByte: number,
  ): { tier: number; nonce: Uint8Array; encryptedKey: Uint8Array } {
    const result = rustWasm.wrapLinkTierHandle(
      linkShareHandle,
      epochHandle,
      tierByte,
    );
    return consumeResult(result, 'wrapLinkTierHandle', (r) => ({
      tier: r.tier,
      nonce: copyBytes(r.nonce),
      encryptedKey: copyBytes(r.encryptedKey),
    }));
  }

  importLinkTierHandle(
    linkSecretForUrl: Uint8Array,
    nonce: Uint8Array,
    encryptedKey: Uint8Array,
    albumId: string,
    tierByte: number,
  ): { handle: bigint; linkId: Uint8Array; tier: number } {
    const result = rustWasm.importLinkTierHandle(
      linkSecretForUrl,
      nonce,
      encryptedKey,
      albumId,
      tierByte,
    );
    return consumeResult(result, 'importLinkTierHandle', (r) => ({
      handle: r.handle,
      linkId: copyBytes(r.linkId),
      tier: r.tier,
    }));
  }

  decryptShardWithLinkTierHandle(
    linkTierHandle: bigint,
    envelopeBytes: Uint8Array,
  ): Uint8Array {
    const result = rustWasm.decryptShardWithLinkTierHandle(
      linkTierHandle,
      envelopeBytes,
    );
    return consumeResult(result, 'decryptShardWithLinkTierHandle', (r) =>
      copyBytes(r.plaintext),
    );
  }

  closeLinkShareHandle(handle: bigint): void {
    const code = rustWasm.closeLinkShareHandle(handle);
    throwIfErrorCode(code, 'closeLinkShareHandle');
  }

  closeLinkTierHandle(handle: bigint): void {
    const code = rustWasm.closeLinkTierHandle(handle);
    throwIfErrorCode(code, 'closeLinkTierHandle');
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

export async function rustApplyDownloadEvent(
  stateBytes: Uint8Array,
  eventBytes: Uint8Array,
): Promise<DownloadApplyResult> {
  return (await getRustFacade()).applyDownloadEvent(stateBytes, eventBytes);
}

export async function rustBuildDownloadPlan(
  input: DownloadBuildPlanInput | Uint8Array,
): Promise<{ planBytes: Uint8Array }> {
  return (await getRustFacade()).buildDownloadPlan(input);
}

export async function rustInitDownloadSnapshot(input: {
  readonly jobId: Uint8Array;
  readonly albumId: string;
  readonly planBytes: Uint8Array;
  readonly nowMs: number;
  readonly scopeKey: string;
  readonly schedule?: DownloadSchedule | null;
}): Promise<{ bodyBytes: Uint8Array; checksum: Uint8Array }> {
  return (await getRustFacade()).initDownloadSnapshot(input);
}

export async function rustLoadDownloadSnapshot(
  snapshotBytes: Uint8Array,
  checksum: Uint8Array,
): Promise<{ snapshotBytes: Uint8Array; schemaVersionLoaded: number }> {
  return (await getRustFacade()).loadDownloadSnapshot(snapshotBytes, checksum);
}

export async function rustCommitDownloadSnapshot(
  snapshotBytes: Uint8Array,
): Promise<{ checksum: Uint8Array }> {
  return (await getRustFacade()).commitDownloadSnapshot(snapshotBytes);
}

export async function rustVerifyDownloadSnapshot(
  snapshotBytes: Uint8Array,
  checksum: Uint8Array,
): Promise<{ valid: boolean }> {
  return (await getRustFacade()).verifyDownloadSnapshot(snapshotBytes, checksum);
}

/**
 * Stateless seed-based shard decrypt for the crypto worker pool.
 * Returns the decrypted plaintext on success.
 * Throws WorkerCryptoError on Decrypt/Integrity/InvalidEnvelope errors.
 *
 * Caller is responsible for zeroizing the returned Uint8Array after use.
 */
export async function rustDecryptShardWithSeed(
  envelope: Uint8Array,
  seed: Uint8Array,
): Promise<Uint8Array> {
  await ensureRustReady();
  const result = rustWasm.decryptShardWithSeedV1(envelope, seed);
  return consumeResult(result, 'decryptShardWithSeedV1', (r) =>
    copyBytes(r.plaintext),
  );
}

/** Verify a shard envelope SHA-256 against the manifest-bound expected hash. */
export async function rustVerifyShardIntegrity(
  envelope: Uint8Array,
  expectedHash: Uint8Array,
): Promise<void> {
  await ensureRustReady();
  const result = rustWasm.verifyShardIntegrityV1(envelope, expectedHash);
  consumeResult(result, 'verifyShardIntegrityV1', () => undefined);
}
const STREAMING_CHUNK_TAG_BYTES = 16;

export interface StreamingShardDecryptor {
  /** Process a wire-format chunk; returns plaintext bytes. Pass isFinal=true for the last chunk. */
  processChunk(chunk: Uint8Array, isFinal: boolean): Promise<Uint8Array>;
  /** Release WASM resources. Idempotent. */
  close(): Promise<void>;
  /** Plaintext chunk size declared in the envelope header (bytes). */
  readonly chunkSizeBytes: number;
}

class StreamingShardDecryptorImpl implements StreamingShardDecryptor {
  private handleId: number | null;
  public readonly chunkSizeBytes: number;

  constructor(handleId: number, chunkSizeBytes: number) {
    this.handleId = handleId;
    this.chunkSizeBytes = chunkSizeBytes;
  }

  async processChunk(chunk: Uint8Array, isFinal: boolean): Promise<Uint8Array> {
    if (this.handleId === null) {
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.StaleHandle,
        'streamingShardProcessChunkV1 called after close',
      );
    }
    await ensureRustReady();
    const result = rustWasm.streamingShardProcessChunkV1(
      this.handleId,
      chunk,
      isFinal,
    );
    try {
      const plaintext = consumeResult(result, 'streamingShardProcessChunkV1', (r) =>
        copyBytes(r.plaintext),
      );
      if (isFinal) {
        // The Rust side already finalized the streaming state; drop the handle
        // reference so close() is a no-op (idempotent).
        this.handleId = null;
      }
      return plaintext;
    } catch (error) {
      // On any chunk failure the Rust handle is now in an unrecoverable state;
      // clear our reference so close() is idempotent and won't double-free.
      this.handleId = null;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.handleId === null) {
      return;
    }
    const handleId = this.handleId;
    this.handleId = null;
    await ensureRustReady();
    const code = rustWasm.streamingShardCloseV1(handleId);
    // Close is best-effort: it MUST be safe to call from a finally block even
    // if the Rust side already finalized. We tolerate non-OK codes silently
    // so the original error (if any) bubbles up.
    // Best-effort: a non-zero close code (e.g. handle already finalized
    // by a prior isFinal=true chunk) is swallowed so close() in a finally
    // block never masks the original error.
    void code;
  }
}

/**
 * Open a streaming-AEAD decryptor over a shard envelope (Reserved[0] == 1).
 *
 * Caller MUST call close() (e.g., in a finally block) regardless of whether
 * processChunk succeeded — close() is idempotent.
 */
export async function rustOpenStreamingShard(
  envelopeHeader: Uint8Array,
  key: Uint8Array,
): Promise<StreamingShardDecryptor> {
  await ensureRustReady();
  const result = rustWasm.openStreamingShardV1(envelopeHeader, key);
  return consumeResult(result, 'openStreamingShardV1', (r) => {
    return new StreamingShardDecryptorImpl(r.handleId, r.chunkSizeBytes);
  });
}

export const STREAMING_CHUNK_TAG_BYTES_V1 = STREAMING_CHUNK_TAG_BYTES;
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

function encodeDownloadBuildPlanInput(input: DownloadBuildPlanInput): Uint8Array {
  return cborMap([
    [0, cborArray(input.photos.map((photo) => encodeDownloadPlanPhoto(photo)))],
  ]);
}

function encodeDownloadPlanPhoto(photo: DownloadBuildPlanPhotoInput): Uint8Array {
  return cborMap([
    [0, cborText(photo.photoId)],
    [1, cborText(photo.filename)],
    [2, cborArray(photo.shards.map((shard) => encodeDownloadPlanShard(shard)))],
  ]);
}

function encodeDownloadPlanShard(shard: DownloadBuildPlanShardInput): Uint8Array {
  return cborMap([
    [0, cborBytes(shard.shardId)],
    [1, cborUint(shard.epochId)],
    [2, cborUint(shard.tier)],
    [3, cborBytes(shard.expectedHash)],
    [4, cborUint(shard.declaredSize)],
  ]);
}

function encodeDownloadInitSnapshotInput(input: {
  readonly jobId: Uint8Array;
  readonly albumId: string;
  readonly planBytes: Uint8Array;
  readonly nowMs: number;
  readonly scopeKey: string;
  readonly schedule?: DownloadSchedule | null;
}): Uint8Array {
  if (input.jobId.length !== 16) {
    throw new WorkerCryptoError(
      WorkerCryptoErrorCode.InvalidInputLength,
      'downloadInitSnapshotV1 requires a 16-byte jobId',
    );
  }
  if (input.scopeKey.length === 0) {
    throw new WorkerCryptoError(
      WorkerCryptoErrorCode.InvalidInputLength,
      'downloadInitSnapshotV1 requires a non-empty scopeKey',
    );
  }
  const entries: Array<readonly [number, Uint8Array]> = [
    [0, cborBytes(input.jobId)],
    [1, cborText(input.albumId)],
    [2, cborBytes(input.planBytes)],
    [3, cborUint(input.nowMs)],
    [4, cborText(input.scopeKey)],
  ];
  // Plan-input key 5 (v3): optional download schedule. Absent and `null`
  // both decode to Immediate on the Rust side, so we only encode the
  // entry when the caller passed a non-trivial schedule.
  const schedule = input.schedule;
  if (schedule && schedule.kind !== 'immediate') {
    entries.push([5, encodeDownloadScheduleValue(schedule)]);
  }
  return cborMap(entries);
}

/**
 * Encode a {@link DownloadSchedule} as canonical CBOR matching the
 * Rust-side `download_schedule_kind_codes` + `download_schedule_keys`.
 *
 * Wire format (all kinds):
 *   { 0: kind_code, 3: max_delay_ms ?? null }
 * Window adds keys 1 (start_hour) + 2 (end_hour).
 *
 * The Rust validator strictly requires the per-kind key set; encode
 * exactly what is needed.
 */
function encodeDownloadScheduleValue(schedule: DownloadSchedule): Uint8Array {
  const maxDelay = schedule.maxDelayMs;
  const maxDelayValue = maxDelay === undefined ? cborNull() : cborUint(maxDelay);
  switch (schedule.kind) {
    case 'wifi':
      return cborMap([
        [0, cborUint(1)],
        [3, maxDelayValue],
      ]);
    case 'wifi-charging':
      return cborMap([
        [0, cborUint(2)],
        [3, maxDelayValue],
      ]);
    case 'idle':
      return cborMap([
        [0, cborUint(3)],
        [3, maxDelayValue],
      ]);
    case 'window': {
      const start = schedule.windowStartHour ?? 0;
      const end = schedule.windowEndHour ?? 0;
      return cborMap([
        [0, cborUint(4)],
        [1, cborUint(start)],
        [2, cborUint(end)],
        [3, maxDelayValue],
      ]);
    }
    case 'immediate':
      // The caller filters this out before reaching here, but keep the
      // exhaustiveness guard so the type-checker catches future kinds.
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.InvalidInputLength,
        'encodeDownloadScheduleValue called with kind=immediate',
      );
    default: {
      const _exhaustive: never = schedule.kind;
      void _exhaustive;
      throw new WorkerCryptoError(
        WorkerCryptoErrorCode.InvalidInputLength,
        'encodeDownloadScheduleValue: unknown kind',
      );
    }
  }
}

function cborNull(): Uint8Array {
  return new Uint8Array([0xf6]);
}

function cborMap(entries: readonly (readonly [number, Uint8Array])[]): Uint8Array {
  const encodedEntries: Uint8Array[] = [cborTypeAndLength(5, BigInt(entries.length))];
  for (const [key, value] of entries) {
    encodedEntries.push(cborUint(key), value);
  }
  return concatBytes(encodedEntries);
}

function cborArray(items: readonly Uint8Array[]): Uint8Array {
  return concatBytes([cborTypeAndLength(4, BigInt(items.length)), ...items]);
}

function cborBytes(bytes: Uint8Array): Uint8Array {
  return concatBytes([cborTypeAndLength(2, BigInt(bytes.length)), bytes]);
}

function cborText(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  return concatBytes([cborTypeAndLength(3, BigInt(encoded.length)), encoded]);
}

function cborUint(value: number | bigint): Uint8Array {
  const bigintValue = typeof value === 'bigint' ? value : numberToUnsignedBigInt(value);
  if (bigintValue > 0xffff_ffff_ffff_ffffn) {
    throw new WorkerCryptoError(
      WorkerCryptoErrorCode.InvalidInputLength,
      'CBOR unsigned integer exceeds u64',
    );
  }
  return cborTypeAndLength(0, bigintValue);
}

function numberToUnsignedBigInt(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkerCryptoError(
      WorkerCryptoErrorCode.InvalidInputLength,
      'CBOR unsigned integer must be a non-negative safe integer',
    );
  }
  return BigInt(value);
}

function cborTypeAndLength(major: number, value: bigint): Uint8Array {
  if (value < 0n) {
    throw new WorkerCryptoError(
      WorkerCryptoErrorCode.InvalidInputLength,
      'CBOR length must be non-negative',
    );
  }
  const majorBits = major << 5;
  if (value < 24n) return new Uint8Array([majorBits | Number(value)]);
  if (value <= 0xffn) return new Uint8Array([majorBits | 24, Number(value)]);
  if (value <= 0xffffn) {
    return new Uint8Array([majorBits | 25, Number(value >> 8n), Number(value & 0xffn)]);
  }
  if (value <= 0xffff_ffffn) {
    return new Uint8Array([
      majorBits | 26,
      Number((value >> 24n) & 0xffn),
      Number((value >> 16n) & 0xffn),
      Number((value >> 8n) & 0xffn),
      Number(value & 0xffn),
    ]);
  }
  return new Uint8Array([
    majorBits | 27,
    Number((value >> 56n) & 0xffn),
    Number((value >> 48n) & 0xffn),
    Number((value >> 40n) & 0xffn),
    Number((value >> 32n) & 0xffn),
    Number((value >> 24n) & 0xffn),
    Number((value >> 16n) & 0xffn),
    Number((value >> 8n) & 0xffn),
    Number(value & 0xffn),
  ]);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
/**
 * Copy bytes off the wasm-bindgen result object so the underlying buffer can
 * safely be `free()`-ed by `consumeResult`. Without this copy the returned
 * `Uint8Array` would point at memory owned by the freed wasm-bindgen object.
 */
function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}
