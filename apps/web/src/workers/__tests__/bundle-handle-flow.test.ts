import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
