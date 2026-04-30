/**
 * Cross-client golden vector regression — Web WASM facade layer.
 *
 * Drives the Rust core through the WASM facade (`apps/web/src/workers/rust-crypto-core.ts`)
 * so any drift between the Rust crate and the bytes captured from the TS reference
 * surfaces here too. Slice 0C wired up the WASM surface (`deriveLinkKeys`,
 * `generateLinkSecret`, `verifyManifestWithIdentity`, etc.), so every vector
 * whose canonical bytes are reachable through the facade is now locked
 * byte-exact below. The remaining `it.skip` blocks are split into two narrow
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

  it('manifest_transcript.json declares Rust-canonical (sanity)', () => {
    const v = loadVector('manifest_transcript.json');
    expect(v.rust_canonical).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Slice 0C closures: byte-exact assertions against the corpus go through
  // the WASM facade entry points listed below. Each `it.skip` either
  //   - flipped to an active byte-exact `it()` (binding present, no deviation),
  //   - stays skipped with a `deviation:<id>` reason (open deviation —
  //     `tests/vectors/deviations.md`), or
  //   - stays skipped with a `facade-gap:no-raw-key-binding` reason (corpus
  //     locks bytes that require raw-key/raw-seed injection the facade does
  //     not currently expose).
  // -------------------------------------------------------------------------

  it('link_keys.json — deriveLinkKeys produces byte-exact (linkId, wrappingKey)', () => {
    const v = loadVector('link_keys.json');
    const inputs = v.inputs as { linkSecretHex: string };
    const expected = v.expected as { linkIdHex: string; wrappingKeyHex: string };

    const linkSecret = fromHex(inputs.linkSecretHex);
    const result = rustWasm.deriveLinkKeys(linkSecret);
    try {
      expect(result.code).toBe(0);
      expect(bytesEqual(result.linkId, fromHex(expected.linkIdHex))).toBe(true);
      expect(bytesEqual(result.wrappingKey, fromHex(expected.wrappingKeyHex))).toBe(true);
    } finally {
      result.free();
    }

    // Negative: the corpus declares INVALID_KEY_LENGTH for a 31-byte secret.
    const truncated = linkSecret.slice(0, 31);
    const failure = rustWasm.deriveLinkKeys(truncated);
    try {
      expect(failure.code).not.toBe(0);
    } finally {
      failure.free();
    }
  });

  it('link_secret.json — generateLinkSecret returns 32 fresh CSPRNG bytes', () => {
    const v = loadVector('link_secret.json');
    const expected = v.expected as { lengthBytes: number };
    expect(expected.lengthBytes).toBe(32);

    const a = rustWasm.generateLinkSecret();
    const b = rustWasm.generateLinkSecret();
    try {
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
      expect(a.bytes.length).toBe(expected.lengthBytes);
      expect(b.bytes.length).toBe(expected.lengthBytes);
      // Two consecutive draws must differ; corpus only locks length, but the
      // CSPRNG contract is meaningless if successive calls return the same
      // bytes, so assert it here as a smoke guard.
      expect(bytesEqual(a.bytes, b.bytes)).toBe(false);
    } finally {
      a.free();
      b.free();
    }
  });

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

    // The auth-challenge transcript framing + Ed25519 signature is fully
    // determined by the corpus inputs; verifying the captured signature with
    // the captured public key over the captured transcript is a complete
    // byte-exact check. Sign-side reproduction would require a deviation
    // closure on auth-keypair, which is out of scope (see auth_keypair.json).
    expect(rustWasm.verifyManifestWithIdentity(transcriptNoTs, sigNoTs, pub)).toBe(0);
    expect(rustWasm.verifyManifestWithIdentity(transcriptWithTs, sigWithTs, pub)).toBe(0);

    // Negative case: tampered signature must fail verification.
    const tamperedSig = new Uint8Array(sigNoTs);
    tamperedSig[0] ^= 0xff;
    expect(
      rustWasm.verifyManifestWithIdentity(transcriptNoTs, tamperedSig, pub),
    ).not.toBe(0);

    // Negative case: wrong public key must fail verification.
    const tamperedPub = new Uint8Array(pub);
    tamperedPub[0] ^= 0xff;
    expect(
      rustWasm.verifyManifestWithIdentity(transcriptNoTs, sigNoTs, tamperedPub),
    ).not.toBe(0);

    // Negative case: cross-feeding a no-timestamp signature against the
    // with-timestamp transcript (the corpus's `timestamp-mismatch` mutation)
    // must fail. Locks the transcript framing — flipping the framing changes
    // the signed bytes, so a stale signature no longer verifies.
    expect(
      rustWasm.verifyManifestWithIdentity(transcriptWithTs, sigNoTs, pub),
    ).not.toBe(0);
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
    'epoch_derive.json — facade-gap:no-raw-key-binding (corpus locks SHA-256 of tier/content keys derived from a caller-provided 32-byte epochSeed; the facade only exposes getTierKeyFromEpoch / deriveContentKeyFromEpoch behind an opaque handle whose seed cannot be injected without a raw-seed binding)',
    () => {},
  );

  it('sealed_bundle.json — verifyManifestWithIdentity locks corpus bundle signature byte-exactly', () => {
    const v = loadVector('sealed_bundle.json');
    const inputs = v.inputs as {
      sealedHex: string;
      signatureHex: string;
      sharerPubkeyHex: string;
      expectedOwnerEd25519PubHex: string;
    };

    const sealed = fromHex(inputs.sealedHex);
    const signature = fromHex(inputs.signatureHex);
    const sharerPub = fromHex(inputs.sharerPubkeyHex);
    const expectedOwnerPub = fromHex(inputs.expectedOwnerEd25519PubHex);

    // The corpus pins the bundle envelope as `sharerPubkey === expectedOwner`;
    // a regression that decoupled them would slip past verification, so lock
    // it explicitly.
    expect(bytesEqual(sharerPub, expectedOwnerPub)).toBe(true);

    // The sealed-bundle signature transcript is `BUNDLE_SIGN_CONTEXT ||
    // sealed`, where `BUNDLE_SIGN_CONTEXT` is the ASCII literal
    // `"Mosaic_EpochBundle_v1"` (mirrored in `crates/mosaic-crypto/src/lib.rs`
    // and `libs/crypto/src/sharing.ts`). Constructing the transcript directly
    // and verifying through `verifyManifestWithIdentity` (a thin wrapper over
    // Ed25519 strict verify) locks the corpus signature byte-for-byte.
    const bundleSignContext = new TextEncoder().encode('Mosaic_EpochBundle_v1');
    const transcript = new Uint8Array(bundleSignContext.length + sealed.length);
    transcript.set(bundleSignContext, 0);
    transcript.set(sealed, bundleSignContext.length);

    expect(rustWasm.verifyManifestWithIdentity(transcript, signature, sharerPub)).toBe(0);

    // Negative case: tampered-signature (corpus mutation: flip first byte).
    const tamperedSig = new Uint8Array(signature);
    tamperedSig[0] ^= 0xff;
    expect(
      rustWasm.verifyManifestWithIdentity(transcript, tamperedSig, sharerPub),
    ).not.toBe(0);

    // Negative case: tampered-sealed (corpus mutation: flip first byte of
    // sealed). The transcript prefix stays valid, but the signed bytes shift
    // out from under the captured signature.
    const tamperedSealed = new Uint8Array(sealed);
    tamperedSealed[0] ^= 0xff;
    const tamperedTranscript = new Uint8Array(
      bundleSignContext.length + tamperedSealed.length,
    );
    tamperedTranscript.set(bundleSignContext, 0);
    tamperedTranscript.set(tamperedSealed, bundleSignContext.length);
    expect(
      rustWasm.verifyManifestWithIdentity(tamperedTranscript, signature, sharerPub),
    ).not.toBe(0);

    // Negative case: wrong-owner-pubkey (corpus mutation: flip first byte of
    // expectedOwnerEd25519PubHex). Verification must reject the signature.
    const tamperedPub = new Uint8Array(sharerPub);
    tamperedPub[0] ^= 0xff;
    expect(
      rustWasm.verifyManifestWithIdentity(transcript, signature, tamperedPub),
    ).not.toBe(0);
  });
});
