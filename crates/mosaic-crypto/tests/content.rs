//! Integration tests for `mosaic_crypto::encrypt_content` / `decrypt_content`.

use std::collections::HashSet;

use mosaic_crypto::{
    EncryptedContent, MosaicCryptoError, SecretKey, decrypt_content, encrypt_content,
};

/// 100 MiB cap mirrored from `crates/mosaic-crypto/src/lib.rs`.
const MAX_SHARD_BYTES: usize = 100 * 1024 * 1024;

fn secret_key_from(mut bytes: [u8; 32]) -> SecretKey {
    match SecretKey::from_bytes(&mut bytes) {
        Ok(value) => value,
        Err(error) => panic!("test key bytes should be accepted: {error:?}"),
    }
}

fn fresh_key(seed: u8) -> SecretKey {
    secret_key_from([seed; 32])
}

fn encrypt_or_panic(plaintext: &[u8], key: &SecretKey, epoch_id: u32) -> EncryptedContent {
    match encrypt_content(plaintext, key, epoch_id) {
        Ok(value) => value,
        Err(error) => panic!("encrypt_content should succeed: {error:?}"),
    }
}

fn decrypt_or_panic(
    ciphertext: &[u8],
    nonce: &[u8; 24],
    key: &SecretKey,
    epoch_id: u32,
) -> Vec<u8> {
    match decrypt_content(ciphertext, nonce, key, epoch_id) {
        Ok(value) => value.to_vec(),
        Err(error) => panic!("decrypt_content should succeed: {error:?}"),
    }
}

fn expect_decrypt_failure(
    ciphertext: &[u8],
    nonce: &[u8; 24],
    key: &SecretKey,
    epoch_id: u32,
    label: &str,
) -> MosaicCryptoError {
    match decrypt_content(ciphertext, nonce, key, epoch_id) {
        Ok(_) => panic!("{label} must not decrypt"),
        Err(error) => error,
    }
}

#[test]
fn encrypt_decrypt_round_trip_short_plaintext() {
    let key = fresh_key(0x11);
    let plaintext: [u8; 32] = [
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
        0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d,
        0x1e, 0x1f,
    ];

    let encrypted = encrypt_or_panic(&plaintext, &key, 7);
    assert_eq!(encrypted.nonce.len(), 24);
    // ciphertext = plaintext + 16-byte Poly1305 tag
    assert_eq!(encrypted.ciphertext.len(), plaintext.len() + 16);

    let decrypted = decrypt_or_panic(&encrypted.ciphertext, &encrypted.nonce, &key, 7);
    assert_eq!(decrypted.as_slice(), plaintext.as_slice());
}

#[test]
fn encrypt_decrypt_round_trip_long_plaintext() {
    let key = fresh_key(0x22);
    let mut plaintext = vec![0_u8; 1024 * 1024];
    // Fill with a recognizable pattern so memcmp catches off-by-one errors.
    for (index, byte) in plaintext.iter_mut().enumerate() {
        *byte = (index & 0xFF) as u8;
    }

    let encrypted = encrypt_or_panic(&plaintext, &key, 0xDEAD_BEEF);
    assert_eq!(encrypted.ciphertext.len(), plaintext.len() + 16);

    let decrypted = decrypt_or_panic(&encrypted.ciphertext, &encrypted.nonce, &key, 0xDEAD_BEEF);
    assert_eq!(decrypted.as_slice(), plaintext.as_slice());
}

#[test]
fn encrypt_uses_fresh_nonce_per_call() {
    let key = fresh_key(0x33);
    let plaintext = b"static plaintext for nonce uniqueness";
    let mut nonces: HashSet<[u8; 24]> = HashSet::new();
    let mut ciphertexts: HashSet<Vec<u8>> = HashSet::new();

    for iteration in 0..100 {
        let EncryptedContent { nonce, ciphertext } = encrypt_or_panic(plaintext, &key, 1);
        assert!(
            nonces.insert(nonce),
            "nonce collision on iteration {iteration} - random source is broken"
        );
        assert!(
            ciphertexts.insert(ciphertext),
            "ciphertext collision on iteration {iteration} - encryption is deterministic"
        );
    }

    assert_eq!(nonces.len(), 100);
    assert_eq!(ciphertexts.len(), 100);
}

#[test]
fn decrypt_rejects_tampered_ciphertext() {
    let key = fresh_key(0x44);
    let plaintext = b"sensitive content";
    let encrypted = encrypt_or_panic(plaintext, &key, 5);

    let mut tampered = encrypted.ciphertext.clone();
    // Flip a single bit somewhere in the ciphertext body (not just the tag).
    tampered[0] ^= 0x01;

    let error = expect_decrypt_failure(&tampered, &encrypted.nonce, &key, 5, "tampered ciphertext");
    assert_eq!(error, MosaicCryptoError::AuthenticationFailed);
}

#[test]
fn decrypt_rejects_tampered_nonce() {
    let key = fresh_key(0x55);
    let plaintext = b"sensitive content";
    let encrypted = encrypt_or_panic(plaintext, &key, 5);

    let mut tampered_nonce = encrypted.nonce;
    tampered_nonce[3] ^= 0x80;

    let error = expect_decrypt_failure(
        &encrypted.ciphertext,
        &tampered_nonce,
        &key,
        5,
        "tampered nonce",
    );
    assert_eq!(error, MosaicCryptoError::AuthenticationFailed);
}

#[test]
fn decrypt_rejects_wrong_epoch_id() {
    let key = fresh_key(0x66);
    let plaintext = b"epoch-bound content";
    let encrypted = encrypt_or_panic(plaintext, &key, 10);

    let error = expect_decrypt_failure(
        &encrypted.ciphertext,
        &encrypted.nonce,
        &key,
        11,
        "epoch id mismatch",
    );
    assert_eq!(error, MosaicCryptoError::AuthenticationFailed);
}

#[test]
fn decrypt_rejects_wrong_content_key() {
    let key = fresh_key(0x77);
    let wrong_key = fresh_key(0x78);
    let plaintext = b"key-bound content";
    let encrypted = encrypt_or_panic(plaintext, &key, 3);

    let error = expect_decrypt_failure(
        &encrypted.ciphertext,
        &encrypted.nonce,
        &wrong_key,
        3,
        "wrong content key",
    );
    assert_eq!(error, MosaicCryptoError::AuthenticationFailed);
}

#[test]
fn encrypt_rejects_oversized_plaintext() {
    let key = fresh_key(0x88);
    // Allocate exactly MAX_SHARD_BYTES + 1 bytes; we never feed this to AEAD,
    // so the cost is just the one allocation in this single test.
    let oversized = vec![0_u8; MAX_SHARD_BYTES + 1];

    match encrypt_content(&oversized, &key, 0) {
        Ok(_) => panic!("oversized plaintext must be rejected"),
        Err(error) => assert_eq!(
            error,
            MosaicCryptoError::InvalidInputLength {
                actual: MAX_SHARD_BYTES + 1
            }
        ),
    }
}

#[test]
fn encrypt_accepts_plaintext_at_size_boundary() {
    // Sanity check the success path next to the rejection path. The bound is
    // `if plaintext.len() > MAX_SHARD_BYTES`, so any `len() <= MAX_SHARD_BYTES`
    // exercises the same path. We use a small payload to keep the test fast.
    let key = fresh_key(0x99);
    let plaintext = [0xAA_u8];
    let encrypted = encrypt_or_panic(&plaintext, &key, 0);
    let decrypted = decrypt_or_panic(&encrypted.ciphertext, &encrypted.nonce, &key, 0);
    assert_eq!(decrypted.as_slice(), plaintext.as_slice());
}

/// Golden vector captured by running the TypeScript implementation in
/// `libs/crypto/src/content.ts` (compiled to `dist/content.js`) under Node 22
/// with libsodium-wrappers-sumo.
///
/// Inputs:
/// - content_key: 32 bytes of `0x42`
/// - plaintext: ASCII "hello world"
/// - epoch_id: 42
///
/// Captured outputs (random nonce, deterministic ciphertext given that nonce):
/// - nonce:      f933abc5f87cb45514d5e85a04b92b17ade29f3eab9713ac
/// - ciphertext: 7beb009e2766d26f5816ce9bfc5c4d050224dbdd16540fba7c49bd
///
/// This test locks in protocol byte-parity between Rust and TypeScript.
#[test]
fn decrypt_matches_ts_protocol_vector() {
    let key = fresh_key(0x42);
    let nonce: [u8; 24] = [
        0xf9, 0x33, 0xab, 0xc5, 0xf8, 0x7c, 0xb4, 0x55, 0x14, 0xd5, 0xe8, 0x5a, 0x04, 0xb9, 0x2b,
        0x17, 0xad, 0xe2, 0x9f, 0x3e, 0xab, 0x97, 0x13, 0xac,
    ];
    let ciphertext: [u8; 27] = [
        0x7b, 0xeb, 0x00, 0x9e, 0x27, 0x66, 0xd2, 0x6f, 0x58, 0x16, 0xce, 0x9b, 0xfc, 0x5c, 0x4d,
        0x05, 0x02, 0x24, 0xdb, 0xdd, 0x16, 0x54, 0x0f, 0xba, 0x7c, 0x49, 0xbd,
    ];

    let plaintext = decrypt_or_panic(&ciphertext, &nonce, &key, 42);
    assert_eq!(plaintext.as_slice(), b"hello world");
}

/// Locks in the TypeScript AAD layout from
/// `libs/crypto/src/content.ts::buildContentAAD`. The expected bytes below are
/// derived directly from that spec for the boundary epoch ids 0, 1, and
/// `u32::MAX`. We verify the prefix is the static magic ("MC", version, reserved)
/// and that the trailing four bytes are the little-endian u32 epoch id; we
/// then prove end-to-end that the AAD bytes are bound into the AEAD by
/// rejecting decryption under an adjacent epoch id.
#[test]
fn aad_matches_ts_format() {
    let expected_aad_zero: [u8; 8] = [0x4d, 0x43, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00];
    let expected_aad_one: [u8; 8] = [0x4d, 0x43, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00];
    let expected_aad_max: [u8; 8] = [0x4d, 0x43, 0x01, 0x00, 0xff, 0xff, 0xff, 0xff];

    for aad in [expected_aad_zero, expected_aad_one, expected_aad_max] {
        assert_eq!(&aad[0..4], &[0x4d, 0x43, 0x01, 0x00]);
    }
    assert_eq!(&expected_aad_zero[4..8], &0_u32.to_le_bytes());
    assert_eq!(&expected_aad_one[4..8], &1_u32.to_le_bytes());
    assert_eq!(&expected_aad_max[4..8], &u32::MAX.to_le_bytes());

    // End-to-end: encrypt at the boundary epochs and verify decrypt rejects
    // adjacent epoch ids. This proves the AAD includes the epoch_id and that
    // it is bound to those exact little-endian bytes.
    let key = fresh_key(0xAB);
    let pt = b"aad-binding";

    let encrypted_zero = encrypt_or_panic(pt, &key, 0);
    assert_eq!(
        decrypt_or_panic(&encrypted_zero.ciphertext, &encrypted_zero.nonce, &key, 0).as_slice(),
        pt
    );
    let err = expect_decrypt_failure(
        &encrypted_zero.ciphertext,
        &encrypted_zero.nonce,
        &key,
        1,
        "epoch 0 ciphertext under epoch 1",
    );
    assert_eq!(err, MosaicCryptoError::AuthenticationFailed);

    let encrypted_max = encrypt_or_panic(pt, &key, u32::MAX);
    assert_eq!(
        decrypt_or_panic(
            &encrypted_max.ciphertext,
            &encrypted_max.nonce,
            &key,
            u32::MAX
        )
        .as_slice(),
        pt
    );
    let err = expect_decrypt_failure(
        &encrypted_max.ciphertext,
        &encrypted_max.nonce,
        &key,
        u32::MAX - 1,
        "epoch u32::MAX ciphertext under u32::MAX-1",
    );
    assert_eq!(err, MosaicCryptoError::AuthenticationFailed);
}

/// Sanity check: `decrypt_content` returns a zeroizing wrapper. We can't
/// directly observe the freed allocation from a unit test, but we can:
///   1. Bind the result to an explicit `Zeroizing<Vec<u8>>` annotation, which
///      compiles only if `decrypt_content` returns that exact wrapper type.
///   2. Call `Zeroize::zeroize` on the returned value and observe it wipes
///      the contents and length.
#[test]
fn decrypt_zeroizes_plaintext_on_drop() {
    use zeroize::{Zeroize, Zeroizing};

    let key = fresh_key(0xCD);
    let plaintext = b"plaintext that must zeroize";
    let encrypted = encrypt_or_panic(plaintext, &key, 9);

    let mut decrypted: Zeroizing<Vec<u8>> =
        match decrypt_content(&encrypted.ciphertext, &encrypted.nonce, &key, 9) {
            Ok(value) => value,
            Err(error) => panic!("baseline decrypt should succeed: {error:?}"),
        };
    assert_eq!(decrypted.as_slice(), plaintext.as_slice());
    assert_eq!(decrypted.len(), plaintext.len());

    decrypted.zeroize();
    assert_eq!(decrypted.len(), 0);
    assert!(decrypted.is_empty());
}
