//! Integration tests for the `link_sharing` module.
//!
//! Mirrors `libs/crypto/src/link-sharing.test.ts` for the four primitives
//! covered by Slice 0A.1 and additionally locks down byte-for-byte protocol
//! compatibility with the TypeScript implementation through golden vectors.

use std::collections::HashSet;

use mosaic_crypto::{
    LINK_ID_BYTES, LINK_SECRET_BYTES, LinkKeys, MosaicCryptoError, SecretKey, WrappedTierKey,
    derive_link_keys, generate_link_secret, unwrap_tier_key_from_link, wrap_tier_key_for_link,
};
use mosaic_domain::ShardTier;

const TIER_KEY_BYTES: usize = 32;

fn make_secret_key(mut bytes: [u8; 32]) -> SecretKey {
    match SecretKey::from_bytes(&mut bytes) {
        Ok(value) => value,
        Err(error) => panic!("32-byte test key should be accepted: {error:?}"),
    }
}

fn fresh_wrapping_key(seed: u8) -> SecretKey {
    make_secret_key([seed; 32])
}

fn random_tier_key() -> [u8; TIER_KEY_BYTES] {
    let mut buf = [0_u8; TIER_KEY_BYTES];
    if let Err(error) = getrandom::fill(&mut buf) {
        panic!("OS RNG should be available in tests: {error:?}");
    }
    buf
}

fn unwrap_keys(result: Result<LinkKeys, MosaicCryptoError>) -> LinkKeys {
    match result {
        Ok(keys) => keys,
        Err(error) => panic!("derive_link_keys should succeed: {error:?}"),
    }
}

fn unwrap_wrapped(result: Result<WrappedTierKey, MosaicCryptoError>) -> WrappedTierKey {
    match result {
        Ok(value) => value,
        Err(error) => panic!("wrap_tier_key_for_link should succeed: {error:?}"),
    }
}

#[test]
fn generate_link_secret_returns_32_random_bytes() {
    let mut seen: HashSet<[u8; LINK_SECRET_BYTES]> = HashSet::new();
    for _ in 0..32 {
        let secret = match generate_link_secret() {
            Ok(value) => value,
            Err(error) => panic!("generate_link_secret should succeed: {error:?}"),
        };
        let bytes: [u8; LINK_SECRET_BYTES] = *secret;
        assert_eq!(bytes.len(), 32);
        assert!(
            seen.insert(bytes),
            "generate_link_secret produced a duplicate value (expected 32-byte uniqueness)"
        );
    }
    assert_eq!(seen.len(), 32);
}

#[test]
fn derive_link_keys_is_deterministic() {
    let secret = [0x37_u8; LINK_SECRET_BYTES];

    let first = unwrap_keys(derive_link_keys(&secret));
    let second = unwrap_keys(derive_link_keys(&secret));

    assert_eq!(first.link_id, second.link_id);
    assert_eq!(
        first.wrapping_key.as_bytes(),
        second.wrapping_key.as_bytes()
    );
    assert_eq!(first.link_id.len(), LINK_ID_BYTES);
    assert_eq!(first.wrapping_key.as_bytes().len(), TIER_KEY_BYTES);
}

/// Locks the BLAKE2b protocol bytes against the TypeScript reference.
///
/// The expected hex values were captured from the live TS module by replaying
/// libsodium's `crypto_generichash(out_len, context, link_secret)` — the
/// exact call `deriveLinkKeys` makes inside `libs/crypto/src/link-sharing.ts`.
///
/// To regenerate, run from `libs/crypto` (do NOT commit the script):
/// ```text
/// node -e "
///   const sodium = require('libsodium-wrappers-sumo');
///   (async () => {
///     await sodium.ready;
///     const enc = new TextEncoder();
///     const ID  = enc.encode('mosaic:link:id:v1');
///     const WR  = enc.encode('mosaic:link:wrap:v1');
///     const sec = new Uint8Array(32).fill(0x42);
///     console.log('linkId      :', Buffer.from(sodium.crypto_generichash(16, ID, sec)).toString('hex'));
///     console.log('wrappingKey :', Buffer.from(sodium.crypto_generichash(32, WR, sec)).toString('hex'));
///   })();
/// "
/// ```
#[test]
fn derive_link_keys_matches_ts_golden_vector() {
    // Golden vector 1: link_secret = [0x42; 32]
    let secret = [0x42_u8; LINK_SECRET_BYTES];

    let expected_link_id = hex_to_bytes::<16>("f0df6d0ec07e80e7bf3d28ca40dbb0bd");
    let expected_wrapping_key =
        hex_to_bytes::<32>("e0c2403dc88db91c1f013862fd5f3385f25988c4d50c1c923a5f801eb687da34");

    let keys = unwrap_keys(derive_link_keys(&secret));

    assert_eq!(
        keys.link_id, expected_link_id,
        "link_id must match the TS reference vector for [0x42; 32]"
    );
    assert_eq!(
        keys.wrapping_key.as_bytes(),
        expected_wrapping_key.as_slice(),
        "wrapping_key must match the TS reference vector for [0x42; 32]"
    );

    // Golden vector 2: link_secret = 0x00..0x1f (verifies the derivation is
    // sensitive to every input byte and not just constant inputs).
    let mut secret2 = [0_u8; LINK_SECRET_BYTES];
    for (i, byte) in secret2.iter_mut().enumerate() {
        *byte = match u8::try_from(i) {
            Ok(value) => value,
            Err(_) => unreachable!("0..32 always fits in u8"),
        };
    }
    let expected_link_id_2 = hex_to_bytes::<16>("0bf33461e2803351e36ef8f8b3e57ac0");
    let expected_wrapping_key_2 =
        hex_to_bytes::<32>("ea4c5769be4d28e39e81de1403afedeaa32d6b85916709b45f598c6d48c38e45");

    let keys2 = unwrap_keys(derive_link_keys(&secret2));
    assert_eq!(keys2.link_id, expected_link_id_2);
    assert_eq!(
        keys2.wrapping_key.as_bytes(),
        expected_wrapping_key_2.as_slice()
    );
}

#[test]
fn derive_link_keys_rejects_wrong_length() {
    for invalid_len in [0_usize, 31, 33, 64] {
        let bad = vec![0x11_u8; invalid_len];
        let outcome = derive_link_keys(&bad);
        match outcome {
            Err(MosaicCryptoError::InvalidKeyLength { actual }) => {
                assert_eq!(actual, invalid_len);
            }
            Err(other) => panic!("expected InvalidKeyLength for len={invalid_len}, got {other:?}"),
            Ok(_) => panic!(
                "expected derive_link_keys to reject len={invalid_len} but it returned Ok"
            ),
        }
    }
}

#[test]
fn wrap_unwrap_round_trip() {
    for tier in [
        ShardTier::Thumbnail,
        ShardTier::Preview,
        ShardTier::Original,
    ] {
        let tier_key = random_tier_key();
        let wrapping_key = fresh_wrapping_key(0x5a);

        let wrapped = unwrap_wrapped(wrap_tier_key_for_link(&tier_key, tier, &wrapping_key));
        assert_eq!(wrapped.tier, tier);
        assert_eq!(wrapped.nonce.len(), 24);
        // ciphertext-with-tag = 32-byte payload + 16-byte Poly1305 tag.
        assert_eq!(wrapped.encrypted_key.len(), TIER_KEY_BYTES + 16);

        let plaintext = match unwrap_tier_key_from_link(&wrapped, tier, &wrapping_key) {
            Ok(value) => value,
            Err(error) => panic!("unwrap should succeed: {error:?}"),
        };
        assert_eq!(plaintext.as_slice(), tier_key.as_slice());
    }
}

#[test]
fn wrap_produces_unique_ciphertext_per_call() {
    let tier_key = [0xab_u8; TIER_KEY_BYTES];
    let wrapping_key = fresh_wrapping_key(0x5b);

    let first = unwrap_wrapped(wrap_tier_key_for_link(
        &tier_key,
        ShardTier::Original,
        &wrapping_key,
    ));
    let second = unwrap_wrapped(wrap_tier_key_for_link(
        &tier_key,
        ShardTier::Original,
        &wrapping_key,
    ));

    assert_ne!(
        first.nonce, second.nonce,
        "wrap_tier_key_for_link must use a fresh random nonce per call"
    );
    assert_ne!(
        first.encrypted_key, second.encrypted_key,
        "ciphertext must differ when the nonce differs"
    );
}

#[test]
fn unwrap_rejects_tier_mismatch() {
    let tier_key = [0xcc_u8; TIER_KEY_BYTES];
    let wrapping_key = fresh_wrapping_key(0x5c);

    let wrapped = unwrap_wrapped(wrap_tier_key_for_link(
        &tier_key,
        ShardTier::Thumbnail,
        &wrapping_key,
    ));

    match unwrap_tier_key_from_link(&wrapped, ShardTier::Preview, &wrapping_key) {
        Err(MosaicCryptoError::LinkTierMismatch { expected, actual }) => {
            assert_eq!(expected, ShardTier::Preview.to_byte());
            assert_eq!(actual, ShardTier::Thumbnail.to_byte());
        }
        other => panic!("expected LinkTierMismatch, got {other:?}"),
    }
}

#[test]
fn unwrap_rejects_tampered_ciphertext() {
    let tier_key = [0xdd_u8; TIER_KEY_BYTES];
    let wrapping_key = fresh_wrapping_key(0x5d);

    let mut wrapped = unwrap_wrapped(wrap_tier_key_for_link(
        &tier_key,
        ShardTier::Preview,
        &wrapping_key,
    ));
    // Flip a bit in the middle of the ciphertext.
    let target = wrapped.encrypted_key.len() / 2;
    wrapped.encrypted_key[target] ^= 0x01;

    match unwrap_tier_key_from_link(&wrapped, ShardTier::Preview, &wrapping_key) {
        Err(MosaicCryptoError::AuthenticationFailed) => {}
        other => panic!("expected AuthenticationFailed for tampered ciphertext, got {other:?}"),
    }
}

#[test]
fn unwrap_rejects_tampered_nonce() {
    let tier_key = [0xee_u8; TIER_KEY_BYTES];
    let wrapping_key = fresh_wrapping_key(0x5e);

    let mut wrapped = unwrap_wrapped(wrap_tier_key_for_link(
        &tier_key,
        ShardTier::Preview,
        &wrapping_key,
    ));
    wrapped.nonce[0] ^= 0x80;

    match unwrap_tier_key_from_link(&wrapped, ShardTier::Preview, &wrapping_key) {
        Err(MosaicCryptoError::AuthenticationFailed) => {}
        other => panic!("expected AuthenticationFailed for tampered nonce, got {other:?}"),
    }
}

#[test]
fn unwrap_rejects_wrong_wrapping_key() {
    let tier_key = [0xff_u8; TIER_KEY_BYTES];
    let correct = fresh_wrapping_key(0x5f);
    let wrong = fresh_wrapping_key(0x60);

    let wrapped = unwrap_wrapped(wrap_tier_key_for_link(
        &tier_key,
        ShardTier::Original,
        &correct,
    ));

    match unwrap_tier_key_from_link(&wrapped, ShardTier::Original, &wrong) {
        Err(MosaicCryptoError::AuthenticationFailed) => {}
        other => panic!("expected AuthenticationFailed for wrong wrapping key, got {other:?}"),
    }
}

#[test]
fn wrap_rejects_wrong_tier_key_length() {
    let wrapping_key = fresh_wrapping_key(0x61);
    for invalid_len in [0_usize, 16, 31, 33, 48] {
        let bad = vec![0x55_u8; invalid_len];
        match wrap_tier_key_for_link(&bad, ShardTier::Original, &wrapping_key) {
            Err(MosaicCryptoError::InvalidKeyLength { actual }) => {
                assert_eq!(actual, invalid_len);
            }
            other => panic!("expected InvalidKeyLength for len={invalid_len}, got {other:?}"),
        }
    }
}

/// Decodes a fixed-length lowercase hex string into a byte array.
///
/// Panics on invalid input — fine for static test fixtures.
fn hex_to_bytes<const N: usize>(hex: &str) -> [u8; N] {
    assert_eq!(hex.len(), N * 2, "hex literal length must be 2*N");
    let bytes = hex.as_bytes();
    let mut out = [0_u8; N];
    for (i, slot) in out.iter_mut().enumerate() {
        let high = decode_nibble(bytes[i * 2]);
        let low = decode_nibble(bytes[i * 2 + 1]);
        *slot = (high << 4) | low;
    }
    out
}

fn decode_nibble(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => panic!("invalid hex nibble: {c}"),
    }
}
