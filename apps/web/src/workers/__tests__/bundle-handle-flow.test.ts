import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as wasm from '../../generated/mosaic-wasm/mosaic_wasm.js';

const textEncoder = new TextEncoder();

function initWasm(): void {
  const wasmBytes = readFileSync(
    resolve(__dirname, '..', '..', 'generated', 'mosaic-wasm', 'mosaic_wasm_bg.wasm'),
  );
  wasm.initSync({ module: wasmBytes });
}

function fixedBytes(start: number, length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);
}

describe('P-W7.1 bundle handle flow', () => {
  it('routes bundle opening through fused verify/import without JS seed exposure', () => {
    const workerSource = readFileSync(
      resolve(__dirname, '..', 'crypto.worker.ts'),
      'utf8',
    );
    const facadeSource = readFileSync(
      resolve(__dirname, '..', 'rust-crypto-core.ts'),
      'utf8',
    );
    const legacyOpen = new RegExp('verifyAnd' + 'OpenBundle');
    const legacyImport = new RegExp('importEpoch' + 'KeyHandleFromBundle');

    expect(workerSource).toContain('verifyAndImportEpochBundle');
    expect(facadeSource).toContain('verifyAndImportEpochBundle');
    expect(workerSource).not.toMatch(legacyOpen);
    expect(facadeSource).not.toMatch(legacyOpen);
    expect(workerSource).not.toMatch(legacyImport);
    expect(facadeSource).not.toMatch(legacyImport);
  });
});

describe('P-W7.4 handle-based bundle sealing', () => {
  it('does not export the legacy raw-seed bundle APIs from generated WASM', () => {
    const wasmExports = wasm as unknown as Record<string, unknown>;

    expect(wasmExports.sealAndSignBundle).toBeUndefined();
    expect(wasmExports.importEpochKeyHandleFromBundle).toBeUndefined();
  });

  it('round-trips bundle sharing through sealBundleWithEpochHandle and verifyAndImportEpochBundle', () => {
    initWasm();

    const password = textEncoder.encode('correct horse battery staple');
    const ownerUserSalt = fixedBytes(0x00, 16);
    const ownerAccountSalt = fixedBytes(0x20, 16);
    const recipientUserSalt = fixedBytes(0x40, 16);
    const recipientAccountSalt = fixedBytes(0x60, 16);
    const albumId = 'ts-handle-bundle-round-trip';
    const epochId = 17;

    const ownerAccount = wasm.createAccount(
      password,
      ownerUserSalt,
      ownerAccountSalt,
      64 * 1024,
      3,
      1,
    );
    const recipientAccount = wasm.createAccount(
      password,
      recipientUserSalt,
      recipientAccountSalt,
      64 * 1024,
      3,
      1,
    );
    const ownerIdentity = wasm.createIdentityHandle(ownerAccount.handle);
    const recipientIdentity = wasm.createIdentityHandle(recipientAccount.handle);
    const ownerEpoch = wasm.createEpochKeyHandle(ownerAccount.handle, epochId);
    const sealed = wasm.sealBundleWithEpochHandle(
      ownerIdentity.handle,
      ownerEpoch.handle,
      recipientIdentity.signingPubkey,
      albumId,
    );
    const imported = wasm.verifyAndImportEpochBundle(
      recipientIdentity.handle,
      sealed.sealed,
      sealed.signature,
      sealed.sharerPubkey,
      albumId,
      0,
      false,
    );

    try {
      expect(ownerAccount.code).toBe(0);
      expect(recipientAccount.code).toBe(0);
      expect(ownerIdentity.code).toBe(0);
      expect(recipientIdentity.code).toBe(0);
      expect(ownerEpoch.code).toBe(0);
      expect(sealed.code).toBe(0);
      expect(imported.code).toBe(0);
      expect(imported.epochId).toBe(epochId);
      expect(imported.handle).not.toBe(0n);
      expect(imported.signPublicKey).toEqual(ownerEpoch.signPublicKey);

      const importedRecord = imported as unknown as Record<string, unknown>;
      expect(importedRecord.epochSeed).toBeUndefined();
      expect(importedRecord.signSecret).toBeUndefined();
      expect(importedRecord.signSecretSeed).toBeUndefined();
    } finally {
      if (imported.handle !== 0n) wasm.closeEpochKeyHandle(imported.handle);
      if (ownerEpoch.handle !== 0n) wasm.closeEpochKeyHandle(ownerEpoch.handle);
      if (ownerIdentity.handle !== 0n) wasm.closeIdentityHandle(ownerIdentity.handle);
      if (recipientIdentity.handle !== 0n) wasm.closeIdentityHandle(recipientIdentity.handle);
      if (ownerAccount.handle !== 0n) wasm.closeAccountKeyHandle(ownerAccount.handle);
      if (recipientAccount.handle !== 0n) wasm.closeAccountKeyHandle(recipientAccount.handle);

      imported.free();
      sealed.free();
      ownerEpoch.free();
      ownerIdentity.free();
      recipientIdentity.free();
      ownerAccount.free();
      recipientAccount.free();
    }
  });

  it('pins the TS wire bundle layout to signature followed by sealed payload', () => {
    const workerSource = readFileSync(
      resolve(__dirname, '..', 'crypto.worker.ts'),
      'utf8',
    );

    expect(workerSource).toContain('signature || sealed');
    expect(workerSource).toContain(
      'new Uint8Array(sealed.signature.length + sealed.sealed.length)',
    );
    expect(workerSource).toContain('wireBytes.set(sealed.signature, 0)');
    expect(workerSource).toContain(
      'wireBytes.set(sealed.sealed, sealed.signature.length)',
    );
  });
});

/**
 * v1.0.x `rotate-password-identity-invariant` regression coverage.
 *
 * The validation-1 full Playwright run flagged
 * `verifyAndImportEpochBundle failed (rust code 222)` 17+ times across
 * album/collaboration/identity-persistence specs. The hypothesis is that
 * a session boundary (login on a fresh tab, BFCache restore, worker
 * restart) breaks the bundle round-trip even when the same password +
 * salts + persisted wrapped material are used to re-derive identity.
 *
 * This test simulates that boundary: it persists every long-lived
 * artifact (wrapped account key, wrapped identity seed, the sealed
 * bundle), closes every handle, then re-derives the recipient identity
 * from the password and persisted wrapped material and asserts the
 * bundle still opens. If commit ec042877 (auth-03 password rotation) or
 * any future identity-derivation change regresses this contract, the
 * `imported.code` will be non-zero (222 in the production failure).
 */
describe('rotate-password-identity-invariant — bundle round-trip across session re-derivation', () => {
  it('opens a bundle when the recipient identity is re-derived in a fresh handle registry', () => {
    initWasm();

    const password = textEncoder.encode('correct horse battery staple');
    const ownerUserSalt = fixedBytes(0x10, 16);
    const ownerAccountSalt = fixedBytes(0x30, 16);
    const recipientUserSalt = fixedBytes(0x50, 16);
    const recipientAccountSalt = fixedBytes(0x70, 16);
    const albumId = 'ts-bundle-cross-session-round-trip';
    const epochId = 23;

    // --- Session A: create owner + recipient, seal a bundle to recipient ---
    // Each createAccount call zeroizes the password buffer it receives, so
    // pass a fresh copy each time.
    const ownerAccount = wasm.createAccount(
      new Uint8Array(password),
      ownerUserSalt,
      ownerAccountSalt,
      64 * 1024,
      3,
      1,
    );
    expect(ownerAccount.code).toBe(0);

    const recipientAccountA = wasm.createAccount(
      new Uint8Array(password),
      recipientUserSalt,
      recipientAccountSalt,
      64 * 1024,
      3,
      1,
    );
    expect(recipientAccountA.code).toBe(0);

    // Persist the wrapped material the recipient would store server-side.
    const persistedWrappedAccountKey = new Uint8Array(recipientAccountA.wrappedAccountKey);

    const ownerIdentity = wasm.createIdentityHandle(ownerAccount.handle);
    expect(ownerIdentity.code).toBe(0);

    const recipientIdentityA = wasm.createIdentityHandle(recipientAccountA.handle);
    expect(recipientIdentityA.code).toBe(0);
    // Persist the wrapped identity seed (the only way to re-derive the
    // same Ed25519/X25519 keypair on a future session — the seed itself
    // is random, but is bound to the L2 via AAD-authenticated wrap).
    const persistedWrappedIdentitySeed = new Uint8Array(recipientIdentityA.wrappedSeed);
    const persistedRecipientSigningPubkey = new Uint8Array(recipientIdentityA.signingPubkey);

    const ownerEpoch = wasm.createEpochKeyHandle(ownerAccount.handle, epochId);
    expect(ownerEpoch.code).toBe(0);

    const sealed = wasm.sealBundleWithEpochHandle(
      ownerIdentity.handle,
      ownerEpoch.handle,
      recipientIdentityA.signingPubkey,
      albumId,
    );
    expect(sealed.code).toBe(0);

    // Persist what the recipient receives over the wire.
    const persistedSealed = new Uint8Array(sealed.sealed);
    const persistedSignature = new Uint8Array(sealed.signature);
    const persistedSharerPubkey = new Uint8Array(sealed.sharerPubkey);

    // Sanity: same-session round-trip works (matches the existing P-W7.4 test).
    const importedSameSession = wasm.verifyAndImportEpochBundle(
      recipientIdentityA.handle,
      sealed.sealed,
      sealed.signature,
      sealed.sharerPubkey,
      albumId,
      0,
      false,
    );
    expect(importedSameSession.code).toBe(0);
    expect(importedSameSession.epochId).toBe(epochId);

    // --- Tear down session A ---
    if (importedSameSession.handle !== 0n) wasm.closeEpochKeyHandle(importedSameSession.handle);
    importedSameSession.free();
    wasm.closeEpochKeyHandle(ownerEpoch.handle);
    wasm.closeIdentityHandle(ownerIdentity.handle);
    wasm.closeIdentityHandle(recipientIdentityA.handle);
    wasm.closeAccountKeyHandle(ownerAccount.handle);
    wasm.closeAccountKeyHandle(recipientAccountA.handle);
    sealed.free();
    ownerEpoch.free();
    ownerIdentity.free();
    recipientIdentityA.free();
    ownerAccount.free();
    recipientAccountA.free();

    // --- Session B: same password + salts + persisted material ---
    const recipientAccountB = wasm.unlockAccountKey(
      new Uint8Array(password),
      recipientUserSalt,
      recipientAccountSalt,
      persistedWrappedAccountKey,
      64 * 1024,
      3,
      1,
    );
    expect(recipientAccountB.code).toBe(0);
    expect(recipientAccountB.handle).not.toBe(0n);

    const recipientIdentityB = wasm.openIdentityHandle(
      persistedWrappedIdentitySeed,
      recipientAccountB.handle,
    );
    expect(recipientIdentityB.code).toBe(0);
    expect(recipientIdentityB.handle).not.toBe(0n);

    // The re-derived identity MUST produce the same Ed25519 signing
    // pubkey it had in session A — otherwise the wrapped-seed AAD
    // contract is broken.
    expect(Array.from(recipientIdentityB.signingPubkey)).toEqual(
      Array.from(persistedRecipientSigningPubkey),
    );

    // The bundle must open under the re-derived identity. Pre-fix, the
    // validation gate saw `code === 222` (verify_and_open_bundle
    // InvalidSignature / InvalidEnvelope) here.
    const importedB = wasm.verifyAndImportEpochBundle(
      recipientIdentityB.handle,
      persistedSealed,
      persistedSignature,
      persistedSharerPubkey,
      albumId,
      0,
      false,
    );

    try {
      expect(importedB.code).toBe(0);
      expect(importedB.epochId).toBe(epochId);
      expect(importedB.handle).not.toBe(0n);
    } finally {
      if (importedB.handle !== 0n) wasm.closeEpochKeyHandle(importedB.handle);
      wasm.closeIdentityHandle(recipientIdentityB.handle);
      wasm.closeAccountKeyHandle(recipientAccountB.handle);
      importedB.free();
      recipientIdentityB.free();
      recipientAccountB.free();
    }
  });
});
