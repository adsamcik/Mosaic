/**
 * Smoke tests for the golden-vector runner.
 *
 * Per Slice 0D scope: this file proves the helper can load + parse every
 * vector kind authored by Slice 0B without throwing. Per-vector byte-exact
 * assertions live in slice-specific tests (1-8) that compose this helper
 * with their own implementations.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  VECTOR_KINDS,
  bytesEqual,
  bytesToHex,
  hexToBytes,
  listCorpusFiles,
  loadVector,
  resetVectorCache,
  resolveCorpusDir,
  runDifferential,
  type VectorKind,
} from './golden-vector-runner';

describe('golden-vector-runner: corpus discovery', () => {
  beforeEach(() => {
    resetVectorCache();
  });

  it('resolves a corpus directory', () => {
    const dir = resolveCorpusDir();
    expect(typeof dir).toBe('string');
    expect(dir.length).toBeGreaterThan(0);
  });

  it('lists JSON corpus files (excluding the schema)', () => {
    const files = listCorpusFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files).not.toContain('golden-vector.schema.json');
    for (const f of files) {
      expect(f.endsWith('.json')).toBe(true);
    }
  });

  it('every known vector kind has a corresponding file on disk', () => {
    const files = new Set(listCorpusFiles());
    for (const kind of VECTOR_KINDS) {
      // sanity: kinds map to <kind>.json
      expect(files.has(`${kind}.json`)).toBe(true);
    }
  });
});

describe('golden-vector-runner: loadVector across every kind', () => {
  beforeEach(() => {
    resetVectorCache();
  });

  for (const kind of VECTOR_KINDS) {
    it(`loads "${kind}" without throwing`, () => {
      const vector = loadVector(kind);
      expect(vector.kind).toBe(kind);
      expect(vector.description.length).toBeGreaterThan(0);
      expect(vector.operation.length).toBeGreaterThan(0);
      expect(vector.protocolVersion).toMatch(/^mosaic-v[0-9]+$/);
      expect(typeof vector.rustCanonical).toBe('boolean');
      expect(typeof vector.inputs).toBe('object');
      expect(typeof vector.outputs).toBe('object');
      expect(Array.isArray(vector.negativeCases)).toBe(true);
    });
  }

  it('memoizes repeated loads of the same kind', () => {
    const a = loadVector('link_keys');
    const b = loadVector('link_keys');
    expect(a).toBe(b);
  });

  it('throws a descriptive error when the kind is missing on disk', () => {
    // We can't easily simulate a missing file without touching the corpus,
    // so spot-check the loader path with a clearly bogus override.
    process.env.MOSAIC_VECTOR_CORPUS_DIR = '/nonexistent-corpus-1234567';
    resetVectorCache();
    expect(() => loadVector('link_keys')).toThrowError(
      /failed to read corpus file/,
    );
    delete process.env.MOSAIC_VECTOR_CORPUS_DIR;
    resetVectorCache();
  });
});

describe('golden-vector-runner: hex utilities', () => {
  it('round-trips bytes through hex encoding', () => {
    const original = new Uint8Array([0x00, 0x10, 0x7f, 0xab, 0xff]);
    const encoded = bytesToHex(original);
    expect(encoded).toBe('00107fabff');
    const decoded = hexToBytes(encoded);
    expect(bytesEqual(decoded, original)).toBe(true);
  });

  it('rejects odd-length hex strings', () => {
    expect(() => hexToBytes('abc')).toThrowError(/odd-length/);
  });

  it('rejects invalid hex pairs', () => {
    expect(() => hexToBytes('zz')).toThrowError(/invalid hex pair/);
  });

  it('treats different-length buffers as unequal', () => {
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});

describe('golden-vector-runner: differential runner', () => {
  it('invokes runImpl and asserter with vector data when verifyOnly=false', async () => {
    let runImplCalls = 0;
    let asserterCalls = 0;
    await runDifferential({
      kind: 'link_keys',
      runImpl: (inputs) => {
        runImplCalls += 1;
        expect(inputs.linkSecretHex.length).toBe(64);
        return { produced: { linkIdHex: 'placeholder' } };
      },
      asserter: (produced, expected) => {
        asserterCalls += 1;
        expect(produced).toEqual({ linkIdHex: 'placeholder' });
        expect(expected.linkIdHex.length).toBeGreaterThan(0);
      },
    });
    expect(runImplCalls).toBe(1);
    expect(asserterCalls).toBe(1);
  });

  it('skips runImpl/asserter when verifyOnly=true and only invokes runVerify', async () => {
    let runImplCalls = 0;
    let runVerifyCalls = 0;
    await runDifferential({
      kind: 'sealed_bundle', // non-deterministic seal direction
      verifyOnly: true,
      runImpl: () => {
        runImplCalls += 1;
        return { produced: null };
      },
      runVerify: (inputs, expected) => {
        runVerifyCalls += 1;
        expect(inputs.sealedHex.length).toBeGreaterThan(0);
        expect(expected.bundleVersion).toBe(1);
      },
    });
    expect(runImplCalls).toBe(0);
    expect(runVerifyCalls).toBe(1);
  });

  it('treats rust_canonical vectors as verifyOnly when runImpl is omitted', async () => {
    let runVerifyCalls = 0;
    await runDifferential({
      kind: 'manifest_transcript',
      runVerify: (_inputs, expected) => {
        runVerifyCalls += 1;
        expect(expected.transcriptHex.length).toBeGreaterThan(0);
      },
    });
    expect(runVerifyCalls).toBe(1);
  });

  it('throws if runImpl is missing when forward direction is required', async () => {
    await expect(() =>
      runDifferential({
        kind: 'link_keys',
        verifyOnly: false,
        // intentionally omit runImpl
        asserter: () => undefined,
      }),
    ).rejects.toThrowError(/runImpl is required/);
  });

  it('throws if asserter is missing when forward direction is required', async () => {
    await expect(() =>
      runDifferential({
        kind: 'link_keys',
        verifyOnly: false,
        runImpl: () => ({ produced: null }),
        // intentionally omit asserter
      }),
    ).rejects.toThrowError(/asserter is required/);
  });
});

describe('golden-vector-runner: typed accessors compile-check', () => {
  // Compile-time test: each kind narrows inputs/outputs to its own shape.
  // The body just exercises a representative property per kind so that any
  // schema regression in `golden-vector-runner.ts` is caught at runtime.
  it('exposes per-kind narrow types', () => {
    const checks: Array<{
      kind: VectorKind;
      probe: (vector: ReturnType<typeof loadVector>) => unknown;
    }> = [
      {
        kind: 'account_unlock',
        probe: (v) =>
          (v as ReturnType<typeof loadVector<'account_unlock'>>).inputs.userSaltHex,
      },
      {
        kind: 'auth_challenge',
        probe: (v) =>
          (v as ReturnType<typeof loadVector<'auth_challenge'>>).inputs.username,
      },
      {
        kind: 'auth_keypair',
        probe: (v) =>
          (v as ReturnType<typeof loadVector<'auth_keypair'>>).inputs.l0MasterKeyHex,
      },
      {
        kind: 'content_encrypt',
        probe: (v) =>
          (v as ReturnType<typeof loadVector<'content_encrypt'>>).inputs.epochId,
      },
      {
        kind: 'epoch_derive',
        probe: (v) =>
          (v as ReturnType<typeof loadVector<'epoch_derive'>>).inputs.epochSeedHex,
      },
      {
        kind: 'identity',
        probe: (v) =>
          (v as ReturnType<typeof loadVector<'identity'>>).inputs.identitySeedHex,
      },
      {
        kind: 'link_keys',
        probe: (v) =>
          (v as ReturnType<typeof loadVector<'link_keys'>>).inputs.linkSecretHex,
      },
      {
        kind: 'link_secret',
        probe: (v) =>
          (v as ReturnType<typeof loadVector<'link_secret'>>).outputs.lengthBytes,
      },
      {
        kind: 'manifest_transcript',
        probe: (v) =>
          (v as ReturnType<typeof loadVector<'manifest_transcript'>>).outputs
            .transcriptHex,
      },
      {
        kind: 'sealed_bundle',
        probe: (v) =>
          (v as ReturnType<typeof loadVector<'sealed_bundle'>>).inputs.sealedHex,
      },
      {
        kind: 'shard_envelope',
        probe: (v) =>
          (v as ReturnType<typeof loadVector<'shard_envelope'>>).inputs.tiers,
      },
      {
        kind: 'tier_key_wrap',
        probe: (v) =>
          (v as ReturnType<typeof loadVector<'tier_key_wrap'>>).inputs.tierKeyHex,
      },
    ];

    for (const { kind, probe } of checks) {
      const v = loadVector(kind);
      const value = probe(v);
      expect(value).toBeDefined();
    }
  });
});
