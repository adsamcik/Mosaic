/**
 * TS-canonical parity tests against the cross-client vector corpus.
 *
 * Locks byte-equality between libs/crypto's TypeScript-side BLAKE2b +
 * crypto_secretbox primitives and the corresponding Rust
 * `mosaic-crypto::ts_canonical` module that ships under
 * `crates/mosaic-crypto/src/ts_canonical.rs`. The corpus JSON files at
 * `tests/vectors/{auth_keypair,account_unlock,link_keys}.json` were captured
 * from libsodium-wrappers-sumo via `tests/vectors/_capture/capture-ts.mjs`,
 * and the Rust `ts_canonical` inline tests assert byte-equality against the
 * same fixtures. Adding the matching TS-side parity test closes the audit
 * gap from commit 0e2957a: any future drift between libs/crypto's BLAKE2b /
 * secretbox primitive bytes and the captured corpus will fail here, before
 * it can leak into the WASM cross-client path or into a production code
 * path that silently desyncs from the Rust canonical implementation.
 *
 * Vectors covered (all three are flagged `rust_canonical: false` in the
 * corpus — i.e. the TS side IS the canonical source of truth, and the Rust
 * `ts_canonical` module exists specifically to reproduce these bytes
 * byte-for-byte under FFI):
 *
 *   1. `auth_keypair.json`   — BLAKE2b auth signing seed + Ed25519 pubkey
 *   2. `account_unlock.json` — BLAKE2b L1 root key chain + crypto_secretbox unwrap
 *   3. `link_keys.json`      — BLAKE2b-keyed link id + wrapping key (16 + 32)
 *
 * Deviations notice (`tests/vectors/deviations.md`):
 *   `auth-keypair` and `account-unlock` are listed as open deviations there,
 *   but the deviation is between the **Rust production code path**
 *   (HKDF-SHA256 / XChaCha20-Poly1305) and the TS reference. The corpus
 *   bytes ARE the TS reference, so the TS-side parity test is **not**
 *   blocked by either deviation — it simply asserts what the corpus
 *   already locks. (The web WASM cross-client test in
 *   `apps/web/tests/cross-client-vectors.test.ts` skips both vectors with
 *   `deviation:<id>` reasons because the WASM facade exercises the Rust
 *   production path; this test does not.)
 *
 * The corpus inputs supply L0 directly so this test exercises only the
 * post-Argon2 BLAKE2b / secretbox primitives that the Rust `ts_canonical`
 * module re-implements. Argon2id parameter handling is covered separately
 * by the existing keychain.test.ts suite.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { deriveLinkKeys, LINK_ID_SIZE, LINK_SECRET_SIZE } from '../src/link-sharing';
import { unwrapKey } from '../src/keybox';
import { concat, toBytes } from '../src/utils';
import { CryptoError, CryptoErrorCode, KEY_SIZE } from '../src/types';

/** Repo-root-relative path to the captured cross-client vector corpus. */
const CORPUS_DIR = resolve(__dirname, '..', '..', '..', 'tests', 'vectors');

/** Deserialize a corpus JSON file. */
function loadVector<T>(name: string): T {
  const path = resolve(CORPUS_DIR, name);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Decode a lowercase hex literal into a fresh Uint8Array. */
function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`invalid hex literal length: ${hex.length}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Lowercase hex string for byte-exact equality assertions. */
function toHexLower(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    s += b.toString(16).padStart(2, '0');
  }
  return s;
}

interface AuthKeypairVector {
  rust_canonical: boolean;
  inputs: { l0MasterKeyHex: string };
  expected: { authSigningSeedHex: string; authPublicKeyHex: string };
}

interface AccountUnlockVector {
  rust_canonical: boolean;
  inputs: {
    accountSaltHex: string;
    l0MasterKeyHex: string;
    wrappedAccountKeyHex: string;
  };
  expected: {
    l1RootKeyHex: string;
    accountKeyHex: string;
    unwrapSucceeds: boolean;
  };
}

interface LinkKeysVector {
  rust_canonical: boolean;
  inputs: { linkSecretHex: string };
  expected: { linkIdHex: string; wrappingKeyHex: string };
}

beforeAll(async () => {
  await sodium.ready;
});

describe('ts-canonical parity (cross-client vector corpus)', () => {
  // ---------------------------------------------------------------------------
  // auth_keypair.json — BLAKE2b auth signing seed
  //
  // TS primitive: BLAKE2b-256(msg = "Mosaic_AuthKey_v1" || L0)  (unkeyed)
  // Rust mirror : `derive_auth_signing_seed_blake2b(l0_master_key)`
  //                in crates/mosaic-crypto/src/ts_canonical.rs
  //
  // The TS production path lives inline in
  // `libs/crypto/src/auth.ts:deriveAuthKeypair` (line ~257):
  //     sodium.crypto_generichash(KEY_SIZE, concat(authContext, l0))
  // Calling the libsodium primitive directly (instead of `deriveAuthKeypair`)
  // lets the corpus inject L0 directly and skip Argon2id, exactly as the
  // `auth_keypair.json` capture and the Rust `ts_canonical` inline test do.
  // ---------------------------------------------------------------------------
  describe('auth_keypair.json — BLAKE2b auth signing seed', () => {
    let v: AuthKeypairVector;
    let l0: Uint8Array;
    let expectedSeed: Uint8Array;
    let expectedPub: Uint8Array;
    let authContext: Uint8Array;

    beforeAll(() => {
      v = loadVector<AuthKeypairVector>('auth_keypair.json');
      l0 = fromHex(v.inputs.l0MasterKeyHex);
      expectedSeed = fromHex(v.expected.authSigningSeedHex);
      expectedPub = fromHex(v.expected.authPublicKeyHex);
      authContext = toBytes('Mosaic_AuthKey_v1');
    });

    it('declares the corpus is TS-canonical (rust_canonical: false)', () => {
      expect(v.rust_canonical).toBe(false);
    });

    it('produces byte-exact authSigningSeed via BLAKE2b("Mosaic_AuthKey_v1" || L0)', () => {
      const seed = sodium.crypto_generichash(KEY_SIZE, concat(authContext, l0));
      expect(seed.length).toBe(32);
      expect(toHexLower(seed)).toBe(toHexLower(expectedSeed));
    });

    it('produces byte-exact authPublicKey via crypto_sign_seed_keypair(seed)', () => {
      const seed = sodium.crypto_generichash(KEY_SIZE, concat(authContext, l0));
      const kp = sodium.crypto_sign_seed_keypair(seed);
      expect(kp.publicKey.length).toBe(32);
      expect(toHexLower(kp.publicKey)).toBe(toHexLower(expectedPub));
    });

    it('mutating L0 produces a different seed (corpus negative case: short-l0)', () => {
      // The corpus negativeCase truncates L0 to 31 bytes and expects
      // INVALID_KEY_LENGTH. The Rust `derive_auth_signing_seed_blake2b`
      // enforces the length explicitly. The TS primitive layer (libsodium
      // crypto_generichash) does not, so we lock the weaker but still
      // meaningful guarantee that mutating the input produces a divergent
      // seed and divergent pubkey — the Argon2id length guard in
      // `auth.ts:deriveAuthKeypair` catches the input-length deviation in
      // production.
      const truncated = l0.slice(0, 31);
      const mutatedSeed = sodium.crypto_generichash(
        KEY_SIZE,
        concat(authContext, truncated),
      );
      expect(toHexLower(mutatedSeed)).not.toBe(toHexLower(expectedSeed));
    });
  });

  // ---------------------------------------------------------------------------
  // account_unlock.json — BLAKE2b L1 root key + crypto_secretbox unwrap
  //
  // TS primitive (per corpus + capture-ts.mjs + Rust ts_canonical):
  //   intermediate = BLAKE2b(out=32, key="Mosaic_RootKey_v1",     msg=L0)
  //   inner        = BLAKE2b(out=32, key="Mosaic_AccountKey_v1",  msg=accountSalt)
  //   l1RootKey    = BLAKE2b(out=32, key=inner,                   msg=intermediate)
  //   accountKey   = crypto_secretbox_open_easy(ct, nonce, l1RootKey)
  //
  // libsodium-wrappers-sumo's crypto_generichash takes its arguments in
  // (out_len, message, key) order, so the TS calls below pass `(32, keyMat,
  // contextString)` to express `BLAKE2b(key=contextString, msg=keyMat)`.
  // This matches `crates/mosaic-crypto/src/ts_canonical.rs::blake2b_keyed_32`
  // (which takes `(key, msg)`) and the capture script at
  // `tests/vectors/_capture/capture-ts.mjs:768-772`.
  //
  // The unwrap step uses `unwrapKey` from `libs/crypto/src/keybox.ts`, which
  // is the TS-shipped `crypto_secretbox_open_easy(nonce || ciphertext)`
  // primitive (the same one capture-ts.mjs invoked when minting the corpus).
  // ---------------------------------------------------------------------------
  describe('account_unlock.json — BLAKE2b L1 root + crypto_secretbox unwrap', () => {
    let v: AccountUnlockVector;
    let l0: Uint8Array;
    let accountSalt: Uint8Array;
    let wrapped: Uint8Array;
    let expectedL1: Uint8Array;
    let expectedAccountKey: Uint8Array;
    const rootCtx = toBytes('Mosaic_RootKey_v1');
    const acctCtx = toBytes('Mosaic_AccountKey_v1');

    function deriveL1(l0Bytes: Uint8Array, salt: Uint8Array): Uint8Array {
      // BLAKE2b(key=rootCtx, msg=L0) — libsodium wrapper signature is
      // (out_len, message, key), so message=L0 / key=rootCtx.
      const intermediate = sodium.crypto_generichash(KEY_SIZE, l0Bytes, rootCtx);
      const inner = sodium.crypto_generichash(KEY_SIZE, salt, acctCtx);
      return sodium.crypto_generichash(KEY_SIZE, intermediate, inner);
    }

    beforeAll(() => {
      v = loadVector<AccountUnlockVector>('account_unlock.json');
      l0 = fromHex(v.inputs.l0MasterKeyHex);
      accountSalt = fromHex(v.inputs.accountSaltHex);
      wrapped = fromHex(v.inputs.wrappedAccountKeyHex);
      expectedL1 = fromHex(v.expected.l1RootKeyHex);
      expectedAccountKey = fromHex(v.expected.accountKeyHex);
    });

    it('declares the corpus is TS-canonical (rust_canonical: false)', () => {
      expect(v.rust_canonical).toBe(false);
      expect(v.expected.unwrapSucceeds).toBe(true);
    });

    it('derives byte-exact l1RootKey via the TS-canonical BLAKE2b chain', () => {
      const l1 = deriveL1(l0, accountSalt);
      expect(l1.length).toBe(32);
      expect(toHexLower(l1)).toBe(toHexLower(expectedL1));
    });

    it('unwraps the wrapped account key byte-exactly via crypto_secretbox', () => {
      const l1 = deriveL1(l0, accountSalt);
      const accountKey = unwrapKey(wrapped, l1);
      expect(accountKey.length).toBe(32);
      expect(toHexLower(accountKey)).toBe(toHexLower(expectedAccountKey));
    });

    it('rejects a tampered ciphertext byte (corpus negative: tampered-wrapped-key)', () => {
      const l1 = deriveL1(l0, accountSalt);
      const tampered = new Uint8Array(wrapped);
      tampered[24] ^= 0x01; // flip first ciphertext byte (offset 24, after the 24-byte nonce)
      expect(() => unwrapKey(tampered, l1)).toThrow(CryptoError);
      try {
        unwrapKey(tampered, l1);
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoError);
        expect((err as CryptoError).code).toBe(CryptoErrorCode.DECRYPTION_FAILED);
      }
    });

    it('rejects a wrong account salt (corpus negative: wrong-account-salt)', () => {
      const tamperedSalt = new Uint8Array(accountSalt);
      tamperedSalt[0] ^= 0x01;
      const wrongL1 = deriveL1(l0, tamperedSalt);
      // A flipped salt bit produces a different L1; the captured wrapped key
      // was MAC'd under the original L1, so secretbox MUST reject the unwrap.
      expect(toHexLower(wrongL1)).not.toBe(toHexLower(expectedL1));
      expect(() => unwrapKey(wrapped, wrongL1)).toThrow(CryptoError);
    });
  });

  // ---------------------------------------------------------------------------
  // link_keys.json — BLAKE2b-keyed link id + wrapping key
  //
  // TS primitive: `deriveLinkKeys(linkSecret)` in libs/crypto/src/link-sharing.ts
  // Rust mirror : `blake2b_keyed_16` + a 32-byte equivalent invoked by the
  //               wasm/uniffi bindings — the same BLAKE2b-keyed primitive.
  //
  // This vector has no open deviation; both sides have always agreed
  // byte-for-byte and the parity table in `tests/vectors/deviations.md`
  // marks it ✅. We still lock the byte-exact assertion here so a future
  // regression in either side is caught immediately at the unit-test layer.
  // ---------------------------------------------------------------------------
  describe('link_keys.json — BLAKE2b-keyed link id + wrapping key', () => {
    let v: LinkKeysVector;
    let linkSecret: Uint8Array;
    let expectedLinkId: Uint8Array;
    let expectedWrappingKey: Uint8Array;

    beforeAll(() => {
      v = loadVector<LinkKeysVector>('link_keys.json');
      linkSecret = fromHex(v.inputs.linkSecretHex);
      expectedLinkId = fromHex(v.expected.linkIdHex);
      expectedWrappingKey = fromHex(v.expected.wrappingKeyHex);
    });

    it('declares the corpus is TS-canonical (rust_canonical: false)', () => {
      expect(v.rust_canonical).toBe(false);
    });

    it('produces byte-exact linkId + wrappingKey via deriveLinkKeys', () => {
      expect(linkSecret.length).toBe(LINK_SECRET_SIZE);
      const keys = deriveLinkKeys(linkSecret);
      expect(keys.linkId.length).toBe(LINK_ID_SIZE);
      expect(keys.wrappingKey.length).toBe(KEY_SIZE);
      expect(toHexLower(keys.linkId)).toBe(toHexLower(expectedLinkId));
      expect(toHexLower(keys.wrappingKey)).toBe(toHexLower(expectedWrappingKey));
    });

    it('rejects a 31-byte link secret with INVALID_KEY_LENGTH (corpus negative: short-link-secret)', () => {
      const truncated = linkSecret.slice(0, 31);
      expect(() => deriveLinkKeys(truncated)).toThrow(CryptoError);
      try {
        deriveLinkKeys(truncated);
      } catch (err) {
        expect(err).toBeInstanceOf(CryptoError);
        expect((err as CryptoError).code).toBe(CryptoErrorCode.INVALID_KEY_LENGTH);
      }
    });
  });
});
