/**
 * Cross-client golden vector regression — Web WASM facade layer.
 *
 * Drives the Rust core through the WASM facade (`apps/web/src/workers/rust-crypto-core.ts`)
 * so any drift between the Rust crate and the bytes captured from the TS reference
 * surfaces here too. Handle-based link-share APIs replaced the old raw
 * link-key/link-secret facade exports, so only canonical bytes still reachable
 * through supported facade entry points are locked byte-exact below. The
 * remaining `it.skip` blocks are split into two narrow
 * categories with explicit rationale:
 *
 *   1. `deviation:<id>` — `tests/vectors/deviations.md` still flags these as
 *      open (TS-canonical vs Rust production-path bytes diverge); the Slice 0B
 *      Rust differential runner mirrors the same `#[ignore = "deviation:…"]`.
 *   2. `facade-gap:no-raw-key-binding` — the facade currently exposes only
 *      handle-based encrypt/decrypt/derivation entry points, so the corpus's
 *      caller-provided raw keys (content key, tier key, epoch seed) cannot be
 *      injected without a new top-level binding. Round-trip behavior of the
 *      handle-based path is already locked by the Rust-side
 *      `crates/mosaic-wasm/tests/*.rs` differential tests.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import initRustWasm, * as rustWasm from '../src/generated/mosaic-wasm/mosaic_wasm.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const CORPUS_DIR = resolve(REPO_ROOT, 'tests', 'vectors');
const WASM_BYTES_PATH = resolve(
  REPO_ROOT,
  'apps',
  'web',
  'src',
  'generated',
  'mosaic-wasm',
  'mosaic_wasm_bg.wasm',
);

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
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function loadVector(name: string): Record<string, unknown> {
  const path = resolve(CORPUS_DIR, name);
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

let wasmReady = false;

beforeAll(async () => {
  // Read the compiled WASM blob and pass the raw bytes to the wasm-bindgen
  // initializer. The default fetch-by-URL path needs a streaming Response,
  // which happy-dom does not provide for file:// URLs.
  const bytes = new Uint8Array(readFileSync(WASM_BYTES_PATH));
  await initRustWasm({ module_or_path: bytes });
  wasmReady = true;
});

describe('cross-client golden vector corpus (Web WASM facade)', () => {
  it('the WASM facade module is loadable', () => {
    expect(wasmReady).toBe(true);
    expect(typeof rustWasm.parseEnvelopeHeader).toBe('function');
    expect(typeof rustWasm.verifyManifestWithIdentity).toBe('function');
  });

  it('the corpus contains the expected operations', () => {
    const expected = new Set([
      'link_keys.json',
      'link_secret.json',
      'tier_key_wrap.json',
      'identity.json',
      'content_encrypt.json',
      'shard_envelope.json',
      'auth_challenge.json',
      'auth_keypair.json',
      'account_unlock.json',
      'epoch_derive.json',
      'sealed_bundle.json',
      'manifest_transcript.json',
    ]);
    const actual = new Set(
      readdirSync(CORPUS_DIR).filter(
        (name) =>
          name.endsWith('.json') &&
          name !== 'golden-vector.schema.json' &&
          !name.startsWith('_') &&
          !name.startsWith('.'),
      ),
    );
    for (const file of expected) {
      expect(actual.has(file)).toBe(true);
    }
  });

  it('shard_envelope.json header parses byte-exactly through WASM', () => {
    const v = loadVector('shard_envelope.json');
    const inputs = v.inputs as {
      epochId: number;
      tiers: Array<{
        tier: number;
        shardIndex: number;
        nonceHex: string;
      }>;
    };
    const expected = v.expected as {
      tiers: Array<{ tier: number; envelopeHex: string }>;
    };
    for (let i = 0; i < expected.tiers.length; i++) {
      const exp = expected.tiers[i]!;
      const inp = inputs.tiers[i]!;
      const envelope = fromHex(exp.envelopeHex);
      const header = envelope.slice(0, 64);
      const parsed = rustWasm.parseEnvelopeHeader(header);
      try {
        expect(parsed.code).toBe(0);
        expect(parsed.epochId).toBe(inputs.epochId);
        expect(parsed.shardIndex).toBe(inp.shardIndex);
        expect(parsed.tier).toBe(inp.tier);
      } finally {
        parsed.free();
      }
    }
  });

  it('identity.json signature verifies through WASM verifyManifestWithIdentity', () => {
    const v = loadVector('identity.json');
    const inputs = v.inputs as {
      identityMessageHex: string;
    };
    const expected = v.expected as {
      signingPubkeyHex: string;
      signatureHex: string;
    };
    const transcript = fromHex(inputs.identityMessageHex);
    const signature = fromHex(expected.signatureHex);
    const pub = fromHex(expected.signingPubkeyHex);
    const code = rustWasm.verifyManifestWithIdentity(transcript, signature, pub);
    expect(code).toBe(0);

    // Tampered signature must fail with non-zero code.
    const tampered = new Uint8Array(signature);
    tampered[0] ^= 0xff;
    const failCode = rustWasm.verifyManifestWithIdentity(transcript, tampered, pub);
    expect(failCode).not.toBe(0);
  });

  it('manifest_transcript.json builds byte-exactly through WASM manifestTranscriptBytes', () => {
    const v = loadVector('manifest_transcript.json');
    const inputs = v.inputs as {
      albumIdHex: string;
      epochId: number;
      encryptedMetaHex: string;
      shards: Array<{
        chunkIndex: number;
        tier: number;
        shardIdHex: string;
        sha256Hex: string;
      }>;
    };
    const expected = v.expected as { transcriptHex: string };
    const encodedShards = new Uint8Array(inputs.shards.length * 53);
    const view = new DataView(encodedShards.buffer);
    inputs.shards.forEach((shard, index) => {
      const offset = index * 53;
      view.setUint32(offset, shard.chunkIndex, true);
      encodedShards[offset + 4] = shard.tier;
      encodedShards.set(fromHex(shard.shardIdHex), offset + 5);
      encodedShards.set(fromHex(shard.sha256Hex), offset + 21);
    });

    const built = rustWasm.manifestTranscriptBytes(
      fromHex(inputs.albumIdHex),
      inputs.epochId,
      fromHex(inputs.encryptedMetaHex),
      encodedShards,
    );
    try {
      expect(built.code).toBe(0);
      expect(toHex(built.bytes)).toBe(expected.transcriptHex);
    } finally {
      built.free();
    }
  });

  // -------------------------------------------------------------------------
  // Byte-exact assertions against the corpus go through currently supported
  // WASM facade entry points. Skipped tests are limited to `deviation:<id>`
  // cases tracked in `tests/vectors/deviations.md` and
  // `facade-gap:no-raw-key-binding` cases where the corpus locks bytes that
  // require raw-key/raw-seed injection the handle-based facade does not expose.
  // -------------------------------------------------------------------------

  it.skip(
    'tier_key_wrap.json — deviation:tier-key-wrap (Rust core uses XChaCha20-Poly1305; corpus locks libsodium crypto_secretbox / XSalsa20-Poly1305 bytes — see tests/vectors/deviations.md)',
    () => {},
  );

  it.skip(
    'content_encrypt.json — facade-gap:no-raw-key-binding (corpus locks ciphertext under a caller-provided contentKey + nonce; encryptAlbumContent / decryptAlbumContent only accept an opaque epoch handle, so raw-key injection cannot be byte-asserted through the facade)',
    () => {},
  );

  it.skip(
    'shard_envelope.json full decrypt — facade-gap:no-raw-key-binding (corpus locks per-tier ciphertext under caller-provided tierKey bytes; encryptShardWithEpochHandle / decryptShardWithEpochHandle only accept an opaque epoch handle, so the tier-key path cannot be byte-asserted through the facade)',
    () => {},
  );

  it('auth_challenge.json — verifyManifestWithIdentity locks corpus signatures byte-exactly', () => {
    const v = loadVector('auth_challenge.json');
    const inputs = v.inputs as { authPublicKeyHex: string };
    const expected = v.expected as {
      transcriptNoTimestampHex: string;
      transcriptWithTimestampHex: string;
      signatureNoTimestampHex: string;
      signatureWithTimestampHex: string;
    };

    const pub = fromHex(inputs.authPublicKeyHex);
    const transcriptNoTs = fromHex(expected.transcriptNoTimestampHex);
    const sigNoTs = fromHex(expected.signatureNoTimestampHex);
    const transcriptWithTs = fromHex(expected.transcriptWithTimestampHex);
    const sigWithTs = fromHex(expected.signatureWithTimestampHex);

    // Verify the captured signatures with the captured public key over the
    // captured transcripts. The auth-challenge path uses
    // `verifyAuthChallengeSignature` — a domain-distinct Ed25519 verifier that
    // signs/verifies the transcript bytes verbatim (no prefix). As of v1.0.1
    // f14-1, `verifyManifestWithIdentity` is no longer a thin Ed25519 wrapper —
    // it now prepends `MANIFEST_SIGN_CONTEXT = "Mosaic_Manifest_v1"` to close
    // an FFI signing oracle, so it cannot be reused as a raw verifier here.
    expect(rustWasm.verifyAuthChallengeSignature(transcriptNoTs, sigNoTs, pub)).toBe(0);
    expect(rustWasm.verifyAuthChallengeSignature(transcriptWithTs, sigWithTs, pub)).toBe(0);

    // Negative case: tampered signature must fail verification.
    const tamperedSig = new Uint8Array(sigNoTs);
    tamperedSig[0] ^= 0xff;
    expect(
      rustWasm.verifyAuthChallengeSignature(transcriptNoTs, tamperedSig, pub),
    ).not.toBe(0);

    // Negative case: wrong public key must fail verification.
    const tamperedPub = new Uint8Array(pub);
    tamperedPub[0] ^= 0xff;
    expect(
      rustWasm.verifyAuthChallengeSignature(transcriptNoTs, sigNoTs, tamperedPub),
    ).not.toBe(0);

    // Timestamp is intentionally dropped from the manifest transcript; the
    // timestamp-present and timestamp-absent corpus entries verify identically.
    expect(
      rustWasm.verifyAuthChallengeSignature(transcriptWithTs, sigNoTs, pub),
    ).toBe(0);
  });

  it.skip(
    'auth_keypair.json — deviation:auth-keypair (Rust core uses HKDF-SHA256 over L0; corpus locks BLAKE2b("Mosaic_AuthKey_v1" || L0) bytes — see tests/vectors/deviations.md)',
    () => {},
  );

  it.skip(
    'account_unlock.json — deviation:account-unlock (Rust core uses HKDF-SHA256 + XChaCha20-Poly1305; corpus locks the BLAKE2b L1 chain + crypto_secretbox wrap bytes — see tests/vectors/deviations.md)',
    () => {},
  );

  it.skip(
    'epoch_derive.json — facade-gap:no-raw-key-binding (corpus locks SHA-256 of tier/content keys derived from a caller-provided 32-byte epochSeed; the handle facade intentionally exposes only encrypt/decrypt operations, and its seed cannot be injected without a raw-seed binding)',
    () => {},
  );

  it.skip(
    'sealed_bundle.json — verifyManifestWithIdentity locks corpus bundle signature byte-exactly — facade-gap:no-raw-ed25519-verify (v1.0.1 f14-1 closed the FFI signing-oracle by making `verifyManifestWithIdentity` prepend `MANIFEST_SIGN_CONTEXT = "Mosaic_Manifest_v1"`; the bundle path now signs/verifies Ed25519 directly over `BUNDLE_SIGN_CONTEXT || sealed` and the WASM facade intentionally exposes only the high-level `verifyAndImportEpochBundle` for bundles — which requires recipient seal keys not in the corpus. The corpus bundle signature is still byte-locked by the Rust differential test `sealed_bundle_vector_open_matches_rust_libsodium` in `crates/mosaic-vectors/tests/differential.rs`.)',
    () => {},
  );
});
