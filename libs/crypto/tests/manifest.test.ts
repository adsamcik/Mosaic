/**
 * Tests for the canonical Mosaic manifest transcript builder.
 *
 * The vector under `tests/vectors/manifest_transcript.json` is the cross-impl
 * source of truth: the TS bytes produced here MUST match Rust
 * `mosaic_domain::canonical_manifest_transcript_bytes` for the same inputs.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sodium from 'libsodium-wrappers-sumo';

import {
  buildManifestTranscript,
  type ManifestShardRef,
} from '../src/manifest';
import {
  signManifestCanonical,
  verifyManifestCanonical,
} from '../src/signer';
import { CryptoError, CryptoErrorCode } from '../src/types';

const VECTOR_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'tests',
  'vectors',
  'manifest_transcript.json',
);

interface ManifestVectorShard {
  chunkIndex: number;
  tier: 1 | 2 | 3;
  shardIdHex: string;
  sha256Hex: string;
}

interface ManifestVector {
  inputs: {
    albumIdHex: string;
    epochId: number;
    encryptedMetaHex: string;
    shards: ManifestVectorShard[];
  };
  expected: { transcriptHex: string };
}

function fromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0) {
    throw new Error(`invalid hex length ${value.length}`);
  }
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, '0');
  }
  return result;
}

function loadVector(): ManifestVector {
  return JSON.parse(readFileSync(VECTOR_PATH, 'utf8')) as ManifestVector;
}

function vectorInputs(): {
  albumId: Uint8Array;
  epochId: number;
  encryptedMeta: Uint8Array;
  shards: ManifestShardRef[];
} {
  const v = loadVector();
  return {
    albumId: fromHex(v.inputs.albumIdHex),
    epochId: v.inputs.epochId,
    encryptedMeta: fromHex(v.inputs.encryptedMetaHex),
    shards: v.inputs.shards.map((s) => ({
      chunkIndex: s.chunkIndex,
      tier: s.tier,
      shardId: fromHex(s.shardIdHex),
      sha256: fromHex(s.sha256Hex),
    })),
  };
}

beforeAll(async () => {
  await sodium.ready;
});

describe('buildManifestTranscript', () => {
  it('produces byte-exact output for tests/vectors/manifest_transcript.json', () => {
    const v = loadVector();
    const built = buildManifestTranscript(vectorInputs());
    expect(toHex(built)).toBe(v.expected.transcriptHex);
  });

  it('rejects empty encryptedMeta with EMPTY_ENCRYPTED_META', () => {
    const inputs = vectorInputs();
    inputs.encryptedMeta = new Uint8Array(0);
    expect(() => buildManifestTranscript(inputs)).toThrow(CryptoError);
    try {
      buildManifestTranscript(inputs);
    } catch (err) {
      expect(err).toBeInstanceOf(CryptoError);
      expect((err as CryptoError).code).toBe(
        CryptoErrorCode.EMPTY_ENCRYPTED_META,
      );
    }
  });

  it('rejects empty shard list with EMPTY_SHARD_LIST', () => {
    const inputs = vectorInputs();
    inputs.shards = [];
    try {
      buildManifestTranscript(inputs);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CryptoError);
      expect((err as CryptoError).code).toBe(CryptoErrorCode.EMPTY_SHARD_LIST);
    }
  });

  it('rejects non-sequential chunk indices with NON_SEQUENTIAL_SHARD_INDEX', () => {
    const inputs = vectorInputs();
    // Mutate the second shard's chunkIndex to introduce a gap (0, 5, 2 sorted = 0, 2, 5).
    inputs.shards[1] = { ...inputs.shards[1], chunkIndex: 5 };
    try {
      buildManifestTranscript(inputs);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CryptoError);
      expect((err as CryptoError).code).toBe(
        CryptoErrorCode.NON_SEQUENTIAL_SHARD_INDEX,
      );
    }
  });

  it('sorts shards by chunkIndex regardless of input order', () => {
    const sorted = vectorInputs();
    const reversed = vectorInputs();
    reversed.shards = [...reversed.shards].reverse();
    const sortedBytes = buildManifestTranscript(sorted);
    const reversedBytes = buildManifestTranscript(reversed);
    expect(toHex(reversedBytes)).toBe(toHex(sortedBytes));
  });

  it('rejects albumId of wrong length with INVALID_INPUT', () => {
    const inputs = vectorInputs();
    inputs.albumId = new Uint8Array(15);
    try {
      buildManifestTranscript(inputs);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CryptoError);
      expect((err as CryptoError).code).toBe(CryptoErrorCode.INVALID_INPUT);
    }
  });

  it('rejects shardId of wrong length with INVALID_INPUT', () => {
    const inputs = vectorInputs();
    inputs.shards[0] = {
      ...inputs.shards[0],
      shardId: new Uint8Array(8),
    };
    try {
      buildManifestTranscript(inputs);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CryptoError);
      expect((err as CryptoError).code).toBe(CryptoErrorCode.INVALID_INPUT);
    }
  });

  it('rejects sha256 of wrong length with INVALID_INPUT', () => {
    const inputs = vectorInputs();
    inputs.shards[0] = {
      ...inputs.shards[0],
      sha256: new Uint8Array(31),
    };
    try {
      buildManifestTranscript(inputs);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CryptoError);
      expect((err as CryptoError).code).toBe(CryptoErrorCode.INVALID_INPUT);
    }
  });
});

describe('signManifestCanonical / verifyManifestCanonical', () => {
  it('round-trips: sign then verify returns true', () => {
    const bytes = buildManifestTranscript(vectorInputs());
    const kp = sodium.crypto_sign_keypair();
    const sig = signManifestCanonical(bytes, kp.privateKey);
    expect(sig.length).toBe(64);
    expect(verifyManifestCanonical(bytes, sig, kp.publicKey)).toBe(true);
  });

  it('rejects tampered bytes', () => {
    const bytes = buildManifestTranscript(vectorInputs());
    const kp = sodium.crypto_sign_keypair();
    const sig = signManifestCanonical(bytes, kp.privateKey);
    const tampered = new Uint8Array(bytes);
    tampered[tampered.length - 1] ^= 0xff;
    expect(verifyManifestCanonical(tampered, sig, kp.publicKey)).toBe(false);
  });

  it('rejects wrong public key', () => {
    const bytes = buildManifestTranscript(vectorInputs());
    const kp1 = sodium.crypto_sign_keypair();
    const kp2 = sodium.crypto_sign_keypair();
    const sig = signManifestCanonical(bytes, kp1.privateKey);
    expect(verifyManifestCanonical(bytes, sig, kp2.publicKey)).toBe(false);
  });

  it('rejects signature of wrong length without throwing', () => {
    const bytes = buildManifestTranscript(vectorInputs());
    const kp = sodium.crypto_sign_keypair();
    expect(verifyManifestCanonical(bytes, new Uint8Array(63), kp.publicKey)).toBe(
      false,
    );
  });

  it('rejects pubkey of wrong length without throwing', () => {
    const bytes = buildManifestTranscript(vectorInputs());
    const kp = sodium.crypto_sign_keypair();
    const sig = signManifestCanonical(bytes, kp.privateKey);
    expect(verifyManifestCanonical(bytes, sig, new Uint8Array(31))).toBe(false);
  });

  it('throws on signing key of wrong length', () => {
    const bytes = buildManifestTranscript(vectorInputs());
    expect(() => signManifestCanonical(bytes, new Uint8Array(63))).toThrow(
      CryptoError,
    );
  });

  /**
   * Cross-impl friendliness: signing the canonical transcript with a fixed
   * Ed25519 seed yields a deterministic signature. The same seed + same
   * canonical bytes fed into Rust `sign_manifest_transcript` MUST emit the
   * exact same signature hex below — that is the parity contract.
   *
   * Seed: 32 bytes of 0xA5.
   * Canonical bytes: tests/vectors/manifest_transcript.json expected.transcriptHex.
   */
  it('produces a deterministic signature from a fixed seed (cross-impl reference)', () => {
    const seed = new Uint8Array(32).fill(0xa5);
    const kp = sodium.crypto_sign_seed_keypair(seed);
    const bytes = buildManifestTranscript(vectorInputs());
    const sig = signManifestCanonical(bytes, kp.privateKey);
    const EXPECTED_SIG_HEX =
      'fcd834fe7e13d3252c0ed320a62dba4b3972a52c1ed467a29693e6dc95b3acae' +
      '80c177f1c6e6462cb846371c8c398e49eb51f4852d540dd8825e185269f38f00';
    // Self-check: signature is deterministic.
    expect(toHex(sig)).toBe(toHex(signManifestCanonical(bytes, kp.privateKey)));
    // Cross-impl check: this hex is what Rust must emit for the same inputs.
    // Note: the hex constant above is captured from the live TS implementation
    // and is the cross-impl reference. If Rust disagrees, that's a deviation.
    expect(toHex(sig)).toBe(EXPECTED_SIG_HEX);
    expect(verifyManifestCanonical(bytes, sig, kp.publicKey)).toBe(true);
  });
});
