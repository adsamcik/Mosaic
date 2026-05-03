use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use mosaic_crypto::{
    MosaicCryptoError, SecretKey, decrypt_shard_with_legacy_raw_key, derive_epoch_key_material,
    encrypt_shard, get_tier_key,
};
use mosaic_domain::{SHARD_ENVELOPE_HEADER_LEN, ShardEnvelopeHeader, ShardTier};

const LEGACY_SEED_BYTES: [u8; 32] = [
    0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f,
    0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f,
];
const FIXED_NONCE: [u8; 24] = [
    0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
    0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7,
];
const LEGACY_PLAINTEXT: &[u8] = b"legacy raw-key shard fallback fixture";
const FIXTURE_ENVELOPE: &[u8] = include_bytes!(
    "fixtures/legacy_shard/404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f-legacy-plaintext.bin"
);
const FIXTURE_PLAINTEXT: &[u8] = include_bytes!(
    "fixtures/legacy_shard/404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f-legacy-plaintext.plaintext"
);

fn secret_key_from(mut bytes: [u8; 32]) -> SecretKey {
    match SecretKey::from_bytes(&mut bytes) {
        Ok(value) => value,
        Err(error) => panic!("test key bytes should be accepted: {error:?}"),
    }
}

fn legacy_ciphertext(seed_bytes: [u8; 32], plaintext: &[u8], nonce: [u8; 24]) -> Vec<u8> {
    let header = ShardEnvelopeHeader::new(77, 9, nonce, ShardTier::Preview);
    let header_bytes = header.to_bytes();
    let cipher = XChaCha20Poly1305::new_from_slice(&seed_bytes)
        .unwrap_or_else(|error| panic!("legacy seed should initialize cipher: {error:?}"));
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &header_bytes,
            },
        )
        .unwrap_or_else(|error| panic!("legacy test ciphertext should encrypt: {error:?}"));
    let mut envelope = Vec::with_capacity(SHARD_ENVELOPE_HEADER_LEN + ciphertext.len());
    envelope.extend_from_slice(&header_bytes);
    envelope.extend_from_slice(&ciphertext);
    envelope
}

#[test]
fn legacy_raw_key_decrypt_succeeds_for_legacy_ciphertext() {
    let seed = secret_key_from(LEGACY_SEED_BYTES);
    let envelope = legacy_ciphertext(LEGACY_SEED_BYTES, LEGACY_PLAINTEXT, FIXED_NONCE);
    let plaintext = decrypt_shard_with_legacy_raw_key(&seed, &envelope)
        .unwrap_or_else(|error| panic!("legacy raw-key fallback should decrypt: {error:?}"));
    assert_eq!(plaintext, LEGACY_PLAINTEXT);
}

#[test]
fn legacy_raw_key_decrypt_fails_for_modern_tier_key_ciphertext() {
    let seed = secret_key_from(LEGACY_SEED_BYTES);
    let mut tier_seed = LEGACY_SEED_BYTES;
    let key_material = derive_epoch_key_material(77, &mut tier_seed)
        .unwrap_or_else(|error| panic!("tier material should derive: {error:?}"));
    let modern = encrypt_shard(
        LEGACY_PLAINTEXT,
        get_tier_key(&key_material, ShardTier::Preview),
        77,
        9,
        ShardTier::Preview,
    )
    .unwrap_or_else(|error| panic!("modern tier-key ciphertext should encrypt: {error:?}"));
    let error = match decrypt_shard_with_legacy_raw_key(&seed, &modern.bytes) {
        Ok(_) => panic!("legacy raw-key fallback must not decrypt modern tier-key ciphertext"),
        Err(error) => error,
    };
    assert_eq!(error, MosaicCryptoError::AuthenticationFailed);
}

#[test]
fn legacy_raw_key_decrypt_fails_for_invalid_seed_length() {
    let mut short_seed = [0x11_u8; 31];
    let short_error = match SecretKey::from_bytes(&mut short_seed) {
        Ok(_) => panic!("31-byte seed should be rejected before fallback decrypt"),
        Err(error) => error,
    };
    assert_eq!(
        short_error,
        MosaicCryptoError::InvalidKeyLength { actual: 31 }
    );
    assert!(short_seed.iter().all(|byte| *byte == 0));

    let mut long_seed = [0x22_u8; 33];
    let long_error = match SecretKey::from_bytes(&mut long_seed) {
        Ok(_) => panic!("33-byte seed should be rejected before fallback decrypt"),
        Err(error) => error,
    };
    assert_eq!(
        long_error,
        MosaicCryptoError::InvalidKeyLength { actual: 33 }
    );
    assert!(long_seed.iter().all(|byte| *byte == 0));
}

#[test]
fn prop_legacy_decrypt_round_trip() {
    for case_index in 0_u16..256 {
        let mut seed_bytes = [0_u8; 32];
        for (offset, byte) in seed_bytes.iter_mut().enumerate() {
            *byte = (case_index as u8)
                .wrapping_mul(31)
                .wrapping_add(offset as u8)
                .wrapping_add(1);
        }
        let mut nonce = [0_u8; 24];
        for (offset, byte) in nonce.iter_mut().enumerate() {
            *byte = (case_index as u8)
                .wrapping_mul(13)
                .wrapping_add(offset as u8)
                .wrapping_add(7);
        }
        let plaintext: Vec<u8> = (0..usize::from(case_index % 193))
            .map(|offset| {
                (case_index as u8)
                    .wrapping_mul(17)
                    .wrapping_add(offset as u8)
                    .wrapping_add(3)
            })
            .collect();
        let seed = secret_key_from(seed_bytes);
        let envelope = legacy_ciphertext(seed_bytes, &plaintext, nonce);
        let decrypted = decrypt_shard_with_legacy_raw_key(&seed, &envelope)
            .unwrap_or_else(|error| panic!("case {case_index} should round-trip: {error:?}"));
        assert_eq!(decrypted, plaintext, "case {case_index} mismatch");
    }
}

#[test]
fn legacy_raw_key_golden_vector_decrypts_fixed_fixture() {
    let seed = secret_key_from(LEGACY_SEED_BYTES);
    let plaintext = decrypt_shard_with_legacy_raw_key(&seed, FIXTURE_ENVELOPE)
        .unwrap_or_else(|error| panic!("legacy golden vector should decrypt: {error:?}"));
    assert_eq!(plaintext, FIXTURE_PLAINTEXT);
}
