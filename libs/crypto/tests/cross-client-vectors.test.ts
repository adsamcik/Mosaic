/**
 * Cross-client golden vector regression — TypeScript reference layer.
 *
 * Loads the shared corpus under `tests/vectors/*.json` and asserts that the
 * shipped TS reference (`libs/crypto`) reproduces the captured bytes exactly.
 * This is the test that locks the corpus to the live TS implementation —
 * any change in libs/crypto that breaks one of these vectors is a protocol
 * drift that the Rust core, WASM facade, and Android shell all need to react to.
 *
 * `manifest_transcript.json` is locked Rust-canonical: the TS-side helper
 * `buildManifestTranscript` (libs/crypto/src/manifest.ts) mirrors Rust's
 * `mosaic_domain::canonical_manifest_transcript_bytes` byte-for-byte, and the
 * test below asserts that equivalence directly against the captured corpus.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import sodium from 'libsodium-wrappers-sumo';

import {
  deriveLinkKeys,
  wrapTierKeyForLink,
  unwrapTierKeyFromLink,
  deriveIdentityKeypair,
  decryptShard,
  decryptContent,
  deriveTierKeys,
  deriveContentKey,
  signAuthChallenge,
  verifyAuthChallenge,
  verifyAndOpenBundle,
  AccessTier,
  ShardTier,
  fromBase64,
  generateLinkSecret,
  buildManifestTranscript,
} from '../src/index';

const CORPUS_DIR = resolve(__dirname, '..', '..', '..', 'tests', 'vectors');

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

beforeAll(async () => {
  await sodium.ready;
});

describe('cross-client golden vector corpus (TS reference)', () => {
  it('every corpus file declares a stable schema envelope', () => {
    const files = readdirSync(CORPUS_DIR).filter(
      (n) => n.endsWith('.json') && !n.startsWith('_') && !n.startsWith('.'),
    );
    // Drop the schema document itself from the corpus iteration.
    const corpus = files.filter((n) => n !== 'golden-vector.schema.json');
    expect(corpus.length).toBeGreaterThanOrEqual(12);
    for (const file of corpus) {
      const document = loadVector(file);
      expect(document.schemaVersion).toBe(1);
      expect(document.protocolVersion).toBe('mosaic-v1');
      expect(typeof document.operation).toBe('string');
      expect(typeof document.description).toBe('string');
      expect(Array.isArray(document.domainLabels)).toBe(true);
    }
  });

  it('link_keys.json reproduces TS BLAKE2b-keyed derivation', () => {
    const v = loadVector('link_keys.json');
    const inputs = v.inputs as { linkSecretHex: string };
    const expected = v.expected as { linkIdHex: string; wrappingKeyHex: string };
    const result = deriveLinkKeys(fromHex(inputs.linkSecretHex));
    expect(bytesEqual(result.linkId, fromHex(expected.linkIdHex))).toBe(true);
    expect(bytesEqual(result.wrappingKey, fromHex(expected.wrappingKeyHex))).toBe(true);
  });

  it('link_secret.json smoke check (length only)', () => {
    const v = loadVector('link_secret.json');
    const expected = v.expected as { lengthBytes: number };
    expect(generateLinkSecret().length).toBe(expected.lengthBytes);
  });

  it('tier_key_wrap.json unwraps to the captured tier key', () => {
    const v = loadVector('tier_key_wrap.json');
    const inputs = v.inputs as {
      linkSecretHex: string;
      tierKeyHex: string;
      tierByte: number;
    };
    const expected = v.expected as {
      tier: number;
      nonceHex: string;
      encryptedKeyHex: string;
      unwrappedKeyHex: string;
    };
    const linkKeys = deriveLinkKeys(fromHex(inputs.linkSecretHex));
    const wrapped = {
      tier: expected.tier as AccessTier,
      nonce: fromHex(expected.nonceHex),
      encryptedKey: fromHex(expected.encryptedKeyHex),
    };
    const unwrapped = unwrapTierKeyFromLink(
      wrapped,
      expected.tier as AccessTier,
      linkKeys.wrappingKey,
    );
    expect(bytesEqual(unwrapped, fromHex(expected.unwrappedKeyHex))).toBe(true);
    expect(bytesEqual(unwrapped, fromHex(inputs.tierKeyHex))).toBe(true);
  });

  it('identity.json reproduces Ed25519 + X25519 derivation and signature', () => {
    const v = loadVector('identity.json');
    const inputs = v.inputs as {
      identitySeedHex: string;
      identityMessageHex: string;
    };
    const expected = v.expected as {
      signingPubkeyHex: string;
      encryptionPubkeyHex: string;
      signatureHex: string;
    };
    const ident = deriveIdentityKeypair(fromHex(inputs.identitySeedHex));
    expect(
      bytesEqual(ident.ed25519.publicKey, fromHex(expected.signingPubkeyHex)),
    ).toBe(true);
    expect(
      bytesEqual(ident.x25519.publicKey, fromHex(expected.encryptionPubkeyHex)),
    ).toBe(true);
    const message = fromHex(inputs.identityMessageHex);
    const signature = sodium.crypto_sign_detached(message, ident.ed25519.secretKey);
    expect(bytesEqual(signature, fromHex(expected.signatureHex))).toBe(true);
  });

  it('content_encrypt.json decrypts to the captured plaintext', () => {
    const v = loadVector('content_encrypt.json');
    const inputs = v.inputs as {
      contentKeyHex: string;
      epochId: number;
      nonceHex: string;
      plaintextHex: string;
    };
    const expected = v.expected as { ciphertextHex: string; decryptedHex: string };
    const decrypted = decryptContent(
      fromHex(expected.ciphertextHex),
      fromHex(inputs.nonceHex),
      fromHex(inputs.contentKeyHex),
      inputs.epochId,
    );
    expect(bytesEqual(decrypted, fromHex(expected.decryptedHex))).toBe(true);
    expect(bytesEqual(decrypted, fromHex(inputs.plaintextHex))).toBe(true);
  });

  it('shard_envelope.json decrypts each tier byte-exactly', async () => {
    const v = loadVector('shard_envelope.json');
    const inputs = v.inputs as {
      epochId: number;
      tiers: Array<{
        tier: number;
        shardIndex: number;
        tierKeyHex: string;
        nonceHex: string;
        plaintextHex: string;
      }>;
    };
    const expected = v.expected as {
      tiers: Array<{ tier: number; envelopeHex: string; sha256: string }>;
    };
    expect(inputs.tiers.length).toBe(expected.tiers.length);
    for (let i = 0; i < inputs.tiers.length; i++) {
      const inp = inputs.tiers[i]!;
      const exp = expected.tiers[i]!;
      expect(inp.tier).toBe(exp.tier);
      const envelope = fromHex(exp.envelopeHex);
      // Header sanity:
      expect(envelope[0]).toBe(0x53); // S
      expect(envelope[1]).toBe(0x47); // G
      expect(envelope[2]).toBe(0x7a); // z
      expect(envelope[3]).toBe(0x6b); // k
      expect(envelope[4]).toBe(0x03); // version
      expect(envelope[37]).toBe(inp.tier);
      // Reserved bytes (offsets 38..64) are zero.
      for (let r = 38; r < 64; r++) {
        expect(envelope[r]).toBe(0);
      }
      const plaintext = await decryptShard(envelope, fromHex(inp.tierKeyHex));
      expect(bytesEqual(plaintext, fromHex(inp.plaintextHex))).toBe(true);

      // ShardTier enum sanity vs corpus tier byte.
      if (inp.tier === ShardTier.THUMB) {
        expect(inp.tier).toBe(1);
      } else if (inp.tier === ShardTier.PREVIEW) {
        expect(inp.tier).toBe(2);
      } else if (inp.tier === ShardTier.ORIGINAL) {
        expect(inp.tier).toBe(3);
      }
    }
  });

  it('auth_challenge.json signs and verifies byte-exactly', () => {
    const v = loadVector('auth_challenge.json');
    const inputs = v.inputs as {
      authSigningSeedHex: string;
      authPublicKeyHex: string;
      username: string;
      challengeHex: string;
      timestampMs: number;
    };
    const expected = v.expected as {
      transcriptNoTimestampHex: string;
      transcriptWithTimestampHex: string;
      signatureNoTimestampHex: string;
      signatureWithTimestampHex: string;
    };
    const seed = fromHex(inputs.authSigningSeedHex);
    const kp = sodium.crypto_sign_seed_keypair(seed);
    expect(bytesEqual(kp.publicKey, fromHex(inputs.authPublicKeyHex))).toBe(true);

    const challenge = fromHex(inputs.challengeHex);
    const sigNoTsB64 = signAuthChallenge(challenge, inputs.username, kp.privateKey);
    const sigTsB64 = signAuthChallenge(
      challenge,
      inputs.username,
      kp.privateKey,
      inputs.timestampMs,
    );
    expect(
      bytesEqual(fromBase64(sigNoTsB64), fromHex(expected.signatureNoTimestampHex)),
    ).toBe(true);
    expect(
      bytesEqual(fromBase64(sigTsB64), fromHex(expected.signatureWithTimestampHex)),
    ).toBe(true);
    expect(
      verifyAuthChallenge(challenge, inputs.username, sigNoTsB64, kp.publicKey),
    ).toBe(true);
    expect(
      verifyAuthChallenge(
        challenge,
        inputs.username,
        sigTsB64,
        kp.publicKey,
        inputs.timestampMs,
      ),
    ).toBe(true);
  });

  it('auth_keypair.json reproduces TS BLAKE2b auth-seed derivation', () => {
    const v = loadVector('auth_keypair.json');
    const inputs = v.inputs as { l0MasterKeyHex: string };
    const expected = v.expected as {
      authSigningSeedHex: string;
      authPublicKeyHex: string;
    };
    const ctx = new TextEncoder().encode('Mosaic_AuthKey_v1');
    const l0 = fromHex(inputs.l0MasterKeyHex);
    const concat = new Uint8Array(ctx.length + l0.length);
    concat.set(ctx, 0);
    concat.set(l0, ctx.length);
    const authSeed = sodium.crypto_generichash(32, concat);
    expect(bytesEqual(authSeed, fromHex(expected.authSigningSeedHex))).toBe(true);
    const kp = sodium.crypto_sign_seed_keypair(authSeed);
    expect(bytesEqual(kp.publicKey, fromHex(expected.authPublicKeyHex))).toBe(true);
  });

  it('account_unlock.json L1 derivation + secretbox unwrap reproduce TS bytes', () => {
    const v = loadVector('account_unlock.json');
    const inputs = v.inputs as {
      userSaltHex: string;
      accountSaltHex: string;
      l0MasterKeyHex: string;
      wrappedAccountKeyHex: string;
    };
    const expected = v.expected as { l1RootKeyHex: string; accountKeyHex: string };
    const rootCtx = new TextEncoder().encode('Mosaic_RootKey_v1');
    const acctCtx = new TextEncoder().encode('Mosaic_AccountKey_v1');
    const intermediate = sodium.crypto_generichash(
      32,
      fromHex(inputs.l0MasterKeyHex),
      rootCtx,
    );
    const acctMix = sodium.crypto_generichash(32, fromHex(inputs.accountSaltHex), acctCtx);
    const l1 = sodium.crypto_generichash(32, intermediate, acctMix);
    expect(bytesEqual(l1, fromHex(expected.l1RootKeyHex))).toBe(true);
    const wrapped = fromHex(inputs.wrappedAccountKeyHex);
    const nonce = wrapped.slice(0, 24);
    const ciphertext = wrapped.slice(24);
    const recovered = sodium.crypto_secretbox_open_easy(ciphertext, nonce, l1);
    expect(bytesEqual(recovered, fromHex(expected.accountKeyHex))).toBe(true);
  });

  it('epoch_derive.json tier-key SHA-256 discriminators match TS BLAKE2b derivation', () => {
    const v = loadVector('epoch_derive.json');
    const inputs = v.inputs as { epochSeedHex: string };
    const expected = v.expected as {
      thumbKeySha256: string;
      previewKeySha256: string;
      fullKeySha256: string;
      contentKeySha256: string;
    };
    const seed = fromHex(inputs.epochSeedHex);
    const tierKeys = deriveTierKeys(seed);
    const contentKey = deriveContentKey(seed);
    function sha256Hex(bytes: Uint8Array): string {
      return Buffer.from(sodium.crypto_hash_sha256(bytes)).toString('hex');
    }
    expect(sha256Hex(tierKeys.thumbKey)).toBe(expected.thumbKeySha256);
    expect(sha256Hex(tierKeys.previewKey)).toBe(expected.previewKeySha256);
    expect(sha256Hex(tierKeys.fullKey)).toBe(expected.fullKeySha256);
    expect(sha256Hex(contentKey)).toBe(expected.contentKeySha256);
  });

  it('sealed_bundle.json verifies and opens to the captured plaintext', () => {
    const v = loadVector('sealed_bundle.json');
    const inputs = v.inputs as {
      sealedHex: string;
      signatureHex: string;
      sharerPubkeyHex: string;
      recipientIdentitySeedHex: string;
      expectedOwnerEd25519PubHex: string;
      validation: {
        albumId: string;
        minEpochId: number;
        allowLegacyEmptyAlbumId: boolean;
      };
    };
    const expected = v.expected as {
      bundleVersion: number;
      bundleAlbumId: string;
      bundleEpochId: number;
      bundleRecipientPubkeyHex: string;
      bundleEpochSeedHex: string;
      bundleSignPublicKeyHex: string;
    };
    const recipient = deriveIdentityKeypair(
      fromHex(inputs.recipientIdentitySeedHex),
    );
    const opened = verifyAndOpenBundle(
      fromHex(inputs.sealedHex),
      fromHex(inputs.signatureHex),
      fromHex(inputs.expectedOwnerEd25519PubHex),
      recipient,
      {
        albumId: inputs.validation.albumId,
        minEpochId: inputs.validation.minEpochId,
        allowLegacyEmptyAlbumId: inputs.validation.allowLegacyEmptyAlbumId,
      },
    );
    expect(opened.version).toBe(expected.bundleVersion);
    expect(opened.albumId).toBe(expected.bundleAlbumId);
    expect(opened.epochId).toBe(expected.bundleEpochId);
    expect(
      bytesEqual(opened.recipientPubkey, fromHex(expected.bundleRecipientPubkeyHex)),
    ).toBe(true);
    expect(
      bytesEqual(opened.epochSeed, fromHex(expected.bundleEpochSeedHex)),
    ).toBe(true);
    expect(
      bytesEqual(
        opened.signKeypair.publicKey,
        fromHex(expected.bundleSignPublicKeyHex),
      ),
    ).toBe(true);
  });

  it('manifest_transcript.json — TS canonical builder matches Rust bytes', () => {
    const v = loadVector('manifest_transcript.json') as unknown as {
      expected: { transcriptHex: string };
      inputs: {
        albumIdHex: string;
        epochId: number;
        encryptedMetaHex: string;
        shards: Array<{
          chunkIndex: number;
          tier: 1 | 2 | 3;
          shardIdHex: string;
          sha256Hex: string;
        }>;
      };
    };
    const built = buildManifestTranscript({
      albumId: fromHex(v.inputs.albumIdHex),
      epochId: v.inputs.epochId,
      encryptedMeta: fromHex(v.inputs.encryptedMetaHex),
      shards: v.inputs.shards.map((s) => ({
        chunkIndex: s.chunkIndex,
        tier: s.tier,
        shardId: fromHex(s.shardIdHex),
        sha256: fromHex(s.sha256Hex),
      })),
    });
    expect(toHex(built)).toBe(v.expected.transcriptHex);
  });
});
