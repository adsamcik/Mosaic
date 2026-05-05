// TODO(R-C6.3): migrate legacy empty-AAD wrap/unwrap_key test coverage.
#![allow(deprecated)]
#![allow(clippy::expect_used)]

use mosaic_crypto::{
    ACCOUNT_DATA_AAD, AuthSigningSecretKey, EPOCH_SEED_AAD, IdentitySigningSecretKey,
    ManifestSigningSecretKey, MosaicCryptoError, SecretKey, decrypt_envelope, decrypt_shard,
    derive_epoch_key_material, encrypt_shard, get_tier_key, sha256_bytes, streaming_decrypt_init,
    streaming_encrypt_init, unwrap_key, unwrap_secret_with_aad, wrap_key, wrap_secret_with_aad,
};
use mosaic_domain::{
    SHARD_ENVELOPE_HEADER_LEN, SHARD_ENVELOPE_VERSION_V04, STREAMING_SHARD_FRAME_SIZE,
    ShardEnvelopeHeader, ShardTier,
};

const KEY_BYTES: [u8; 32] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
];

const WRONG_KEY_BYTES: [u8; 32] = [
    0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff,
    0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xee, 0xef,
];

fn secret_key_from(mut bytes: [u8; 32]) -> SecretKey {
    match SecretKey::from_bytes(&mut bytes) {
        Ok(value) => value,
        Err(error) => panic!("test key bytes should be accepted: {error:?}"),
    }
}

fn epoch_material() -> mosaic_crypto::EpochKeyMaterial {
    let mut seed = KEY_BYTES;
    derive_epoch_key_material(7, &mut seed).expect("epoch material")
}

#[test]
fn secret_key_constructor_zeroizes_source_and_rejects_bad_length() {
    let mut bytes = [0x42_u8; 32];
    let key = match SecretKey::from_bytes(&mut bytes) {
        Ok(value) => value,
        Err(error) => panic!("test key bytes should be accepted: {error:?}"),
    };

    assert!(key.as_bytes().iter().all(|byte| *byte == 0x42));
    assert!(bytes.iter().all(|byte| *byte == 0));

    let mut short_key = [0_u8; 31];
    let error = match SecretKey::from_bytes(&mut short_key) {
        Ok(_) => panic!("short key should fail"),
        Err(error) => error,
    };
    assert_eq!(error, MosaicCryptoError::InvalidKeyLength { actual: 31 });
    assert!(short_key.iter().all(|byte| *byte == 0));

    let mut empty_key = Vec::new();
    let error = match SecretKey::from_bytes(empty_key.as_mut_slice()) {
        Ok(_) => panic!("empty key should fail"),
        Err(error) => error,
    };
    assert_eq!(error, MosaicCryptoError::InvalidKeyLength { actual: 0 });

    let mut long_key = [0x55_u8; 33];
    let error = match SecretKey::from_bytes(&mut long_key) {
        Ok(_) => panic!("long key should fail"),
        Err(error) => error,
    };
    assert_eq!(error, MosaicCryptoError::InvalidKeyLength { actual: 33 });
    assert!(long_key.iter().all(|byte| *byte == 0));
}

#[test]
fn signing_seed_constructors_zeroize_sources_on_success_and_error() {
    let mut manifest_seed = [0x11_u8; 32];
    let _manifest_key = match ManifestSigningSecretKey::from_seed(&mut manifest_seed) {
        Ok(value) => value,
        Err(error) => panic!("manifest signing seed should be accepted: {error:?}"),
    };
    assert!(manifest_seed.iter().all(|byte| *byte == 0));

    let mut auth_seed = [0x22_u8; 32];
    let _auth_key = match AuthSigningSecretKey::from_seed(&mut auth_seed) {
        Ok(value) => value,
        Err(error) => panic!("auth signing seed should be accepted: {error:?}"),
    };
    assert!(auth_seed.iter().all(|byte| *byte == 0));

    let mut identity_seed = [0x33_u8; 32];
    let _identity_key = match IdentitySigningSecretKey::from_seed(&mut identity_seed) {
        Ok(value) => value,
        Err(error) => panic!("identity signing seed should be accepted: {error:?}"),
    };
    assert!(identity_seed.iter().all(|byte| *byte == 0));

    let mut short_seed = [0x44_u8; 31];
    let error = match ManifestSigningSecretKey::from_seed(&mut short_seed) {
        Ok(_) => panic!("short signing seed should fail"),
        Err(error) => error,
    };
    assert_eq!(error, MosaicCryptoError::InvalidKeyLength { actual: 31 });
    assert!(short_seed.iter().all(|byte| *byte == 0));
}

#[test]
fn shard_encryption_round_trips_with_header_aad_and_hash() {
    let key = secret_key_from(KEY_BYTES);
    let plaintext = b"mosaic encrypted shard bytes";

    let encrypted = match encrypt_shard(plaintext, &key, 7, 3, ShardTier::Original) {
        Ok(value) => value,
        Err(error) => panic!("shard should encrypt: {error:?}"),
    };

    assert_eq!(
        encrypted.bytes.len(),
        SHARD_ENVELOPE_HEADER_LEN + plaintext.len() + 16
    );
    assert_eq!(encrypted.sha256, sha256_bytes(&encrypted.bytes));

    let header = match ShardEnvelopeHeader::parse(&encrypted.bytes[..SHARD_ENVELOPE_HEADER_LEN]) {
        Ok(value) => value,
        Err(error) => panic!("encrypted header should parse: {error:?}"),
    };
    assert_eq!(header.epoch_id(), 7);
    assert_eq!(header.shard_index(), 3);
    assert_eq!(header.tier(), ShardTier::Original);

    let decrypted = match decrypt_shard(&encrypted.bytes, &key) {
        Ok(value) => value,
        Err(error) => panic!("shard should decrypt: {error:?}"),
    };

    assert_eq!(decrypted.as_slice(), plaintext);
}

#[test]
fn shard_encryption_generates_fresh_nonce_inside_crypto() {
    let key = secret_key_from(KEY_BYTES);
    let plaintext = b"same plaintext";

    let first = match encrypt_shard(plaintext, &key, 1, 0, ShardTier::Preview) {
        Ok(value) => value,
        Err(error) => panic!("first shard should encrypt: {error:?}"),
    };
    let second = match encrypt_shard(plaintext, &key, 1, 0, ShardTier::Preview) {
        Ok(value) => value,
        Err(error) => panic!("second shard should encrypt: {error:?}"),
    };

    assert_ne!(&first.bytes[13..37], &second.bytes[13..37]);
    assert_ne!(first.bytes, second.bytes);
}

#[test]
fn shard_encryption_and_key_wrap_accept_multi_megabyte_payloads_below_policy_cap() {
    let key = secret_key_from(KEY_BYTES);
    let payload = vec![0x5a_u8; 2 * 1024 * 1024];

    let encrypted = match encrypt_shard(&payload, &key, 9, 1, ShardTier::Original) {
        Ok(value) => value,
        Err(error) => panic!("2 MiB shard should be below policy cap: {error:?}"),
    };
    let decrypted = match decrypt_shard(&encrypted.bytes, &key) {
        Ok(value) => value,
        Err(error) => panic!("2 MiB shard should decrypt: {error:?}"),
    };
    assert_eq!(decrypted.len(), payload.len());
    assert_eq!(decrypted.first(), Some(&0x5a));
    assert_eq!(decrypted.last(), Some(&0x5a));

    let wrapped = match wrap_key(&payload, &key) {
        Ok(value) => value,
        Err(error) => panic!("2 MiB wrapped payload should be below policy cap: {error:?}"),
    };
    let unwrapped = match unwrap_key(&wrapped, &key) {
        Ok(value) => value,
        Err(error) => panic!("2 MiB wrapped payload should unwrap: {error:?}"),
    };
    assert_eq!(unwrapped.len(), payload.len());
    assert_eq!(unwrapped.first(), Some(&0x5a));
    assert_eq!(unwrapped.last(), Some(&0x5a));
}

#[test]
fn shard_decryption_rejects_wrong_key_tampered_header_and_header_only_envelope() {
    let key = secret_key_from(KEY_BYTES);
    let wrong_key = secret_key_from(WRONG_KEY_BYTES);

    let encrypted = match encrypt_shard(b"authenticated", &key, 2, 9, ShardTier::Thumbnail) {
        Ok(value) => value,
        Err(error) => panic!("shard should encrypt: {error:?}"),
    };

    let wrong_key_error = match decrypt_shard(&encrypted.bytes, &wrong_key) {
        Ok(_) => panic!("wrong key should fail"),
        Err(error) => error,
    };
    assert_eq!(wrong_key_error, MosaicCryptoError::AuthenticationFailed);

    let mut tampered_header = encrypted.bytes.clone();
    tampered_header[5] ^= 0x01;
    let tampered_error = match decrypt_shard(&tampered_header, &key) {
        Ok(_) => panic!("tampered AAD should fail"),
        Err(error) => error,
    };
    assert_eq!(tampered_error, MosaicCryptoError::AuthenticationFailed);

    let header_only_error = match decrypt_shard(&encrypted.bytes[..SHARD_ENVELOPE_HEADER_LEN], &key)
    {
        Ok(_) => panic!("header-only envelope should fail"),
        Err(error) => error,
    };
    assert_eq!(header_only_error, MosaicCryptoError::MissingCiphertext);
}

#[test]
fn shard_decryption_rejects_short_envelopes_and_public_aad_tampering() {
    let key = secret_key_from(KEY_BYTES);
    let encrypted = match encrypt_shard(
        b"authenticated",
        &key,
        0x1122_3344,
        0x5566_7788,
        ShardTier::Original,
    ) {
        Ok(value) => value,
        Err(error) => panic!("shard should encrypt: {error:?}"),
    };

    for len in [0_usize, 1, SHARD_ENVELOPE_HEADER_LEN - 1] {
        assert_eq!(
            decrypt_shard(&encrypted.bytes[..len], &key),
            Err(MosaicCryptoError::InvalidEnvelope)
        );
    }

    for index in [5_usize, 9, 13] {
        let mut tampered = encrypted.bytes.clone();
        tampered[index] ^= 0x01;
        assert_eq!(
            decrypt_shard(&tampered, &key),
            Err(MosaicCryptoError::AuthenticationFailed)
        );
    }
}

#[test]
fn shard_decryption_classifies_structural_and_authenticated_tampering() {
    let key = secret_key_from(KEY_BYTES);
    let encrypted = match encrypt_shard(b"authenticated", &key, 2, 9, ShardTier::Thumbnail) {
        Ok(value) => value,
        Err(error) => panic!("shard should encrypt: {error:?}"),
    };

    let mut bad_magic = encrypted.bytes.clone();
    bad_magic[0] ^= 0x01;
    assert_eq!(
        decrypt_shard(&bad_magic, &key),
        Err(MosaicCryptoError::InvalidEnvelope)
    );

    let mut bad_reserved = encrypted.bytes.clone();
    bad_reserved[38] = 1;
    assert_eq!(
        decrypt_shard(&bad_reserved, &key),
        Err(MosaicCryptoError::InvalidEnvelope)
    );

    let mut tampered_tier = encrypted.bytes.clone();
    tampered_tier[37] = ShardTier::Preview.to_byte();
    assert_eq!(
        decrypt_shard(&tampered_tier, &key),
        Err(MosaicCryptoError::AuthenticationFailed)
    );

    let mut tampered_ciphertext = encrypted.bytes;
    let last_index = tampered_ciphertext.len() - 1;
    tampered_ciphertext[last_index] ^= 0x01;
    assert_eq!(
        decrypt_shard(&tampered_ciphertext, &key),
        Err(MosaicCryptoError::AuthenticationFailed)
    );
}

#[test]
fn sha256_bytes_matches_base64url_no_padding_vectors() {
    assert_eq!(
        sha256_bytes(b""),
        "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"
    );
    assert_eq!(
        sha256_bytes(b"abc"),
        "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0"
    );
    assert_eq!(
        sha256_bytes(b"mosaic"),
        "GYGMAOJ6U4GaTOE0HuB5Q1NQERDr7NHJiE2xiIQ5iNA"
    );
}

#[test]
fn key_wrap_round_trips_and_rejects_tampering() {
    let key = secret_key_from(KEY_BYTES);
    let wrapper = secret_key_from(WRONG_KEY_BYTES);

    let wrapped = match wrap_key(key.as_bytes(), &wrapper) {
        Ok(value) => value,
        Err(error) => panic!("key should wrap: {error:?}"),
    };

    assert_eq!(wrapped.len(), 24 + KEY_BYTES.len() + 16);
    assert_ne!(&wrapped[0..24], &[0_u8; 24]);

    let unwrapped = match unwrap_key(&wrapped, &wrapper) {
        Ok(value) => value,
        Err(error) => panic!("key should unwrap: {error:?}"),
    };
    assert_eq!(unwrapped.as_slice(), KEY_BYTES);

    let mut tampered = wrapped;
    tampered[30] ^= 0x80;
    let error = match unwrap_key(&tampered, &wrapper) {
        Ok(_) => panic!("tampered key should fail"),
        Err(error) => error,
    };
    assert_eq!(error, MosaicCryptoError::AuthenticationFailed);
}

#[test]
fn aad_secret_wrap_round_trips_only_with_matching_domain() {
    let payload = [0x42_u8; 32];
    let wrapper = secret_key_from(WRONG_KEY_BYTES);

    let wrapped = match wrap_secret_with_aad(&payload, &wrapper, EPOCH_SEED_AAD) {
        Ok(value) => value,
        Err(error) => panic!("AAD-bound secret should wrap: {error:?}"),
    };

    let unwrapped = match unwrap_secret_with_aad(&wrapped, &wrapper, EPOCH_SEED_AAD) {
        Ok(value) => value,
        Err(error) => panic!("matching AAD should unwrap: {error:?}"),
    };
    assert_eq!(unwrapped.as_slice(), payload.as_slice());

    assert_eq!(
        unwrap_secret_with_aad(&wrapped, &wrapper, ACCOUNT_DATA_AAD),
        Err(MosaicCryptoError::AuthenticationFailed)
    );
    assert_eq!(
        unwrap_key(&wrapped, &wrapper),
        Err(MosaicCryptoError::AuthenticationFailed)
    );
}

#[test]
fn key_wrap_rejects_short_wrapped_input() {
    let wrapper = secret_key_from(WRONG_KEY_BYTES);

    let error = match unwrap_key(&[0_u8; 40], &wrapper) {
        Ok(_) => panic!("short wrapped input should fail"),
        Err(error) => error,
    };

    assert_eq!(error, MosaicCryptoError::WrappedKeyTooShort { actual: 40 });
}

#[test]
fn key_wrap_rejects_empty_payload_and_detects_nonce_or_tag_tampering() {
    let wrapper = secret_key_from(WRONG_KEY_BYTES);

    assert_eq!(
        wrap_key(&[], &wrapper),
        Err(MosaicCryptoError::InvalidInputLength { actual: 0 })
    );

    let minimum_plaintext = [0x7a_u8];
    let minimum_wrapped = match wrap_key(&minimum_plaintext, &wrapper) {
        Ok(value) => value,
        Err(error) => panic!("minimum one-byte payload should wrap: {error:?}"),
    };
    assert_eq!(minimum_wrapped.len(), 24 + minimum_plaintext.len() + 16);

    let minimum_unwrapped = match unwrap_key(&minimum_wrapped, &wrapper) {
        Ok(value) => value,
        Err(error) => panic!("minimum one-byte payload should unwrap: {error:?}"),
    };
    assert_eq!(minimum_unwrapped.as_slice(), minimum_plaintext.as_slice());

    let mut tampered_nonce = minimum_wrapped.clone();
    tampered_nonce[0] ^= 0x01;
    assert_eq!(
        unwrap_key(&tampered_nonce, &wrapper),
        Err(MosaicCryptoError::AuthenticationFailed)
    );

    let mut tampered_tag = minimum_wrapped;
    let tag_index = tampered_tag.len() - 1;
    tampered_tag[tag_index] ^= 0x01;
    assert_eq!(
        unwrap_key(&tampered_tag, &wrapper),
        Err(MosaicCryptoError::AuthenticationFailed)
    );
}

#[test]
fn streaming_sequential_frames_decrypt_correctly() {
    let epoch = epoch_material();
    let mut encryptor =
        streaming_encrypt_init(&epoch, ShardTier::Original, Some(3)).expect("stream init");
    let first_plain = vec![0x11_u8; STREAMING_SHARD_FRAME_SIZE];
    let second_plain = vec![0x22_u8; STREAMING_SHARD_FRAME_SIZE];
    let final_plain = b"tail".to_vec();
    let first = encryptor.encrypt_frame(&first_plain).expect("frame 0");
    let second = encryptor.encrypt_frame(&second_plain).expect("frame 1");
    let final_frame = encryptor.encrypt_frame(&final_plain).expect("frame 2");
    let envelope = encryptor.finalize().expect("finalize");

    let mut decryptor = streaming_decrypt_init(&epoch, &envelope.header).expect("decrypt init");
    assert_eq!(
        decryptor.decrypt_frame(&first.bytes).expect("decrypt 0"),
        first_plain
    );
    assert_eq!(
        decryptor.decrypt_frame(&second.bytes).expect("decrypt 1"),
        second_plain
    );
    assert_eq!(
        decryptor
            .decrypt_frame(&final_frame.bytes)
            .expect("decrypt 2"),
        final_plain
    );
    decryptor.finalize().expect("complete stream");
}

#[test]
fn streaming_permuted_frames_fail_authentication() {
    let epoch = epoch_material();
    let mut encryptor =
        streaming_encrypt_init(&epoch, ShardTier::Preview, Some(2)).expect("stream init");
    let first_plain = vec![0x11_u8; STREAMING_SHARD_FRAME_SIZE];
    let second_plain = b"tail".to_vec();
    let first = encryptor.encrypt_frame(&first_plain).expect("frame 0");
    let second = encryptor.encrypt_frame(&second_plain).expect("frame 1");
    let envelope = encryptor.finalize().expect("finalize");

    let mut decryptor = streaming_decrypt_init(&epoch, &envelope.header).expect("decrypt init");
    assert_eq!(
        decryptor.decrypt_frame(&second.bytes),
        Err(MosaicCryptoError::AuthenticationFailed)
    );
    assert_eq!(first.frame_index, 0);
}

#[test]
fn streaming_truncated_tail_fails_finalize() {
    let epoch = epoch_material();
    let mut encryptor =
        streaming_encrypt_init(&epoch, ShardTier::Original, Some(2)).expect("stream init");
    let first_plain = vec![0x33_u8; STREAMING_SHARD_FRAME_SIZE];
    let first = encryptor.encrypt_frame(&first_plain).expect("frame 0");
    let _second = encryptor.encrypt_frame(b"tail").expect("frame 1");
    let envelope = encryptor.finalize().expect("finalize");

    let mut decryptor = streaming_decrypt_init(&epoch, &envelope.header).expect("decrypt init");
    assert_eq!(
        decryptor.decrypt_frame(&first.bytes).expect("decrypt 0"),
        first_plain
    );
    assert_eq!(
        decryptor.finalize(),
        Err(MosaicCryptoError::InvalidInputLength { actual: 1 })
    );
}

#[test]
fn streaming_header_count_mutation_plus_truncation_fails_authentication() {
    let epoch = epoch_material();
    let mut encryptor =
        streaming_encrypt_init(&epoch, ShardTier::Original, Some(3)).expect("stream init");
    let first = encryptor
        .encrypt_frame(&vec![0x44_u8; STREAMING_SHARD_FRAME_SIZE])
        .expect("frame 0");
    let second = encryptor
        .encrypt_frame(&vec![0x55_u8; STREAMING_SHARD_FRAME_SIZE])
        .expect("frame 1");
    let _third = encryptor.encrypt_frame(b"tail").expect("frame 2");
    let envelope = encryptor.finalize().expect("finalize");

    let mut truncated = envelope.bytes.clone();
    truncated[22..26].copy_from_slice(&2_u32.to_le_bytes());
    truncated[26..30].copy_from_slice(&(STREAMING_SHARD_FRAME_SIZE as u32).to_le_bytes());
    truncated.truncate(SHARD_ENVELOPE_HEADER_LEN + first.bytes.len() + second.bytes.len());

    assert_eq!(
        decrypt_envelope(&epoch, &truncated),
        Err(MosaicCryptoError::AuthenticationFailed)
    );
}

#[test]
fn streaming_encrypt_requires_declared_count_and_fixed_non_final_frames() {
    let epoch = epoch_material();
    assert_eq!(
        streaming_encrypt_init(&epoch, ShardTier::Original, None).map(|_| ()),
        Err(MosaicCryptoError::InvalidInputLength { actual: 0 })
    );

    let mut non_final_short =
        streaming_encrypt_init(&epoch, ShardTier::Original, Some(2)).expect("stream init");
    let non_final_error = match non_final_short.encrypt_frame(b"short") {
        Ok(_) => panic!("short non-final frame should fail"),
        Err(error) => error,
    };
    assert_eq!(
        non_final_error,
        MosaicCryptoError::InvalidInputLength { actual: 5 }
    );

    let mut empty_final =
        streaming_encrypt_init(&epoch, ShardTier::Original, Some(1)).expect("stream init");
    let empty_final_error = match empty_final.encrypt_frame(b"") {
        Ok(_) => panic!("empty final frame should fail"),
        Err(error) => error,
    };
    assert_eq!(
        empty_final_error,
        MosaicCryptoError::InvalidInputLength { actual: 0 }
    );
}

#[test]
fn streaming_cross_stream_replay_fails() {
    let epoch = epoch_material();
    let mut first_stream =
        streaming_encrypt_init(&epoch, ShardTier::Thumbnail, Some(1)).expect("stream 1");
    let replayed = first_stream.encrypt_frame(b"same").expect("frame").bytes;
    let _first_envelope = first_stream.finalize().expect("finalize 1");

    let mut second_stream =
        streaming_encrypt_init(&epoch, ShardTier::Thumbnail, Some(1)).expect("stream 2");
    let _second_frame = second_stream.encrypt_frame(b"same").expect("frame 2");
    let second_envelope = second_stream.finalize().expect("finalize 2");

    let mut decryptor =
        streaming_decrypt_init(&epoch, &second_envelope.header).expect("decrypt init");
    assert_eq!(
        decryptor.decrypt_frame(&replayed),
        Err(MosaicCryptoError::AuthenticationFailed)
    );
}

#[test]
fn streaming_salt_uniqueness_same_plaintext_different_ciphertext_both_decrypt() {
    let epoch = epoch_material();
    let mut first = streaming_encrypt_init(&epoch, ShardTier::Preview, Some(1)).expect("init 1");
    let first_frame = first.encrypt_frame(b"same plaintext").expect("frame 1");
    let first_envelope = first.finalize().expect("final 1");
    let mut second = streaming_encrypt_init(&epoch, ShardTier::Preview, Some(1)).expect("init 2");
    let second_frame = second.encrypt_frame(b"same plaintext").expect("frame 2");
    let second_envelope = second.finalize().expect("final 2");

    assert_ne!(first_envelope.header[6..22], second_envelope.header[6..22]);
    assert_ne!(first_frame.bytes, second_frame.bytes);
    assert_eq!(
        decrypt_envelope(&epoch, &first_envelope.bytes).expect("decrypt first"),
        b"same plaintext"
    );
    assert_eq!(
        decrypt_envelope(&epoch, &second_envelope.bytes).expect("decrypt second"),
        b"same plaintext"
    );
}

#[test]
fn streaming_frame_count_enforcement_rejects_extra_frame() {
    let epoch = epoch_material();
    let mut encryptor =
        streaming_encrypt_init(&epoch, ShardTier::Original, Some(3)).expect("stream init");
    encryptor
        .encrypt_frame(&vec![0_u8; STREAMING_SHARD_FRAME_SIZE])
        .expect("frame 0");
    encryptor
        .encrypt_frame(&vec![1_u8; STREAMING_SHARD_FRAME_SIZE])
        .expect("frame 1");
    encryptor.encrypt_frame(b"tail").expect("frame 2");
    let error = match encryptor.encrypt_frame(b"extra") {
        Ok(_) => panic!("extra frame should fail"),
        Err(error) => error,
    };
    assert_eq!(error, MosaicCryptoError::InvalidInputLength { actual: 3 });
}

#[test]
fn streaming_dispatcher_interops_v03_and_v04_and_rejects_bad_versions() {
    let epoch = epoch_material();
    let v03 = encrypt_shard(
        b"legacy v03",
        get_tier_key(&epoch, ShardTier::Preview),
        epoch.epoch_id(),
        1,
        ShardTier::Preview,
    )
    .expect("v03 encrypt");
    assert_eq!(
        decrypt_envelope(&epoch, &v03.bytes).expect("v03 dispatcher"),
        b"legacy v03"
    );

    let mut encryptor =
        streaming_encrypt_init(&epoch, ShardTier::Original, Some(1)).expect("stream init");
    encryptor.encrypt_frame(b"stream v04").expect("frame");
    let v04 = encryptor.finalize().expect("finalize");
    assert_eq!(v04.header[4], SHARD_ENVELOPE_VERSION_V04);
    assert_eq!(
        decrypt_envelope(&epoch, &v04.bytes).expect("v04 dispatcher"),
        b"stream v04"
    );

    let mut bad_magic = v04.bytes.clone();
    bad_magic[0] ^= 0x01;
    assert_eq!(
        decrypt_envelope(&epoch, &bad_magic),
        Err(MosaicCryptoError::InvalidEnvelope)
    );
    let mut bad_version = v04.bytes.clone();
    bad_version[4] = 0x05;
    assert_eq!(
        decrypt_envelope(&epoch, &bad_version),
        Err(MosaicCryptoError::InvalidEnvelope)
    );
    assert_eq!(
        decrypt_envelope(&epoch, &v04.bytes[..SHARD_ENVELOPE_HEADER_LEN - 1]),
        Err(MosaicCryptoError::InvalidEnvelope)
    );
}
