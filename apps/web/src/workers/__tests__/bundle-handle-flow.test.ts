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
});
