/**
 * Cross-client golden vector regression — Web WASM facade layer.
 *
 * Drives the Rust core through the WASM facade (`apps/web/src/workers/rust-crypto-core.ts`)
 * so any drift between the Rust crate and the bytes captured from the TS reference
 * surfaces here too. Many vectors (account unlock, identity sign, content/shard
 * encrypt/decrypt with raw keys, sealed bundle open) require WASM facade
 * functions that have not landed yet — those are skipped with a TODO referencing
 * Slice 0C so the moment the facade grows the corresponding entry point, the
 * skip flips into a byte-exact assertion.
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
  // The following vectors require WASM facade entry points that have not
  // shipped yet. They are locked in the corpus and the Rust differential test
  // already exercises them; switching these from `it.skip` to active
  // assertions is part of Slice 0C.
  // -------------------------------------------------------------------------

  it.skip(
    'link_keys.json — TODO Slice 0C: needs WASM deriveLinkKeys binding to lock byte-exact',
    () => {
      const v = loadVector('link_keys.json');
      expect((v.expected as { linkIdHex: string }).linkIdHex.length).toBeGreaterThan(0);
    },
  );

  it.skip(
    'link_secret.json — smoke vector, no byte-exact output',
    () => {},
  );

  it.skip(
    'tier_key_wrap.json — TODO Slice 0C: needs WASM unwrapTierKeyFromLink + deviation:tier-key-wrap closure',
    () => {},
  );

  it.skip(
    'content_encrypt.json — TODO Slice 0C: needs WASM raw-key decryptContent binding',
    () => {},
  );

  it.skip(
    'shard_envelope.json full decrypt — TODO Slice 0C: needs WASM raw-key decryptShard binding (current API requires an open epoch handle)',
    () => {},
  );

  it.skip(
    'auth_challenge.json — TODO Slice 0C: needs WASM signAuthChallenge / verifyAuthChallenge bindings',
    () => {},
  );

  it.skip(
    'auth_keypair.json — TODO Slice 0C: requires WASM auth-keypair derivation + deviation:auth-keypair closure',
    () => {},
  );

  it.skip(
    'account_unlock.json — TODO Slice 0C: needs WASM unlockAccountKey driven from L0 + deviation:account-unlock closure',
    () => {},
  );

  it.skip(
    'epoch_derive.json — TODO Slice 0C: needs WASM tier-key SHA-256 discriminator binding + deviation:epoch-tier-keys closure',
    () => {},
  );

  it.skip(
    'sealed_bundle.json — TODO Slice 0C: needs WASM verifyAndOpenBundle binding',
    () => {},
  );
});
