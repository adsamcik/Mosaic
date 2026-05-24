// SPDX-License-Identifier: MIT
// Auto-organized from cross_platform_parity.rs as part of v1.0.2 monolith-test-files
// split. Each split file exercises one domain of cross-facade parity tests.
// See `tests/common/mod.rs` for shared imports, constants, and helpers.
#![allow(clippy::expect_used)]

mod common;
use common::*;

#[test]
fn finalize_idempotency_key_parity() {
    let job_id = mosaic_client::Uuid::from_bytes([
        0x01, 0x95, 0x00, 0x00, 0x00, 0x00, 0x70, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00,
    ]);
    let job_id_string = "01950000-0000-7000-8000-000000000000".to_owned();

    let from_wasm = must(
        mosaic_wasm::finalize_idempotency_key(job_id_string.clone()),
        "wasm finalize idempotency key",
    );
    let from_uniffi = must(
        mosaic_uniffi::finalize_idempotency_key(job_id_string),
        "uniffi finalize idempotency key",
    );
    let from_client = mosaic_client::finalize_idempotency_key(&job_id);

    assert_eq!(from_wasm, from_uniffi);
    assert_eq!(from_wasm, from_client);
    assert_eq!(
        from_wasm,
        "mosaic-finalize-01950000-0000-7000-8000-000000000000"
    );
}

#[test]
fn tus_patch_idempotency_key_vector_matches_crypto_wasm_and_uniffi() {
    let parsed = load_named_vector("tus_patch_idempotency_key.json");
    let job_id = json_str(&parsed, "inputs", "jobId");
    let shard_id = json_str(&parsed, "inputs", "shardId");
    let expected = json_str(&parsed, "expected", "idempotencyKey");

    let crypto = mosaic_crypto::tus_patch_idempotency_key(job_id, shard_id);
    let wasm = mosaic_wasm::tus_patch_idempotency_key_js(job_id.to_owned(), shard_id.to_owned());
    let uniffi = mosaic_uniffi::tus_patch_idempotency_key(job_id.to_owned(), shard_id.to_owned());

    assert_eq!(crypto, expected);
    assert_eq!(wasm, expected);
    assert_eq!(uniffi, expected);
}

#[test]
fn enumeration_defense_salt_vector_matches_crypto_wasm_and_uniffi() {
    let parsed = load_named_vector("enumeration_defense_salt.json");
    let server_secret = hex_to_bytes(json_str(&parsed, "inputs", "serverSecretHex"));
    let username = json_str(&parsed, "inputs", "username");
    let expected = hex_to_bytes(json_str(&parsed, "expected", "saltHex"));

    let crypto = mosaic_crypto::derive_enumeration_defense_salt(&server_secret, username).to_vec();
    let wasm =
        mosaic_wasm::derive_enumeration_defense_salt(server_secret.clone(), username.to_owned());
    let uniffi = mosaic_uniffi::derive_enumeration_defense_salt(server_secret, username.to_owned());

    assert_eq!(crypto, expected);
    assert_eq!(wasm, expected);
    assert_eq!(uniffi, expected);
}

#[test]
fn user_salt_v1_legacy_vector_matches_crypto_wasm_and_uniffi() {
    let parsed = load_named_vector("user_salt_v1_legacy.json");
    let password = json_str(&parsed, "inputs", "password");
    let username = json_str(&parsed, "inputs", "username");
    let ciphertext = hex_to_bytes(json_str(&parsed, "inputs", "ciphertextHex"));
    let nonce = hex_to_bytes(json_str(&parsed, "inputs", "nonceHex"));
    let expected = hex_to_bytes(json_str(&parsed, "expected", "saltHex"));

    let crypto =
        mosaic_crypto::decrypt_user_salt_v1_legacy(password, username, &ciphertext, &nonce)
            .expect("crypto decrypt")
            .to_vec();
    let wasm = mosaic_wasm::decrypt_user_salt_v1_legacy(
        password.to_owned(),
        username.to_owned(),
        ciphertext.clone(),
        nonce.clone(),
    );
    let uniffi = mosaic_uniffi::decrypt_user_salt_v1_legacy(
        password.to_owned(),
        username.to_owned(),
        ciphertext,
        nonce,
    );

    assert_eq!(crypto, expected);
    assert_eq!(wasm.code, ClientErrorCode::Ok.as_u16());
    assert_eq!(wasm.bytes, expected);
    assert_eq!(uniffi.code, ClientErrorCode::Ok.as_u16());
    assert_eq!(uniffi.bytes, expected);
}

#[test]
fn user_salt_envelope_v2_vector_matches_crypto_wasm_and_uniffi() {
    let parsed = load_named_vector("user_salt_envelope_v2.json");
    let mut account_key_bytes = hex_to_bytes(json_str(&parsed, "inputs", "accountKeyHex"));
    let salt = hex_to_bytes(json_str(&parsed, "inputs", "saltHex"));
    let nonce = hex_to_bytes(json_str(&parsed, "inputs", "nonceHex"));
    let expected_ciphertext = hex_to_bytes(json_str(&parsed, "expected", "ciphertextHex"));
    let expected_salt = hex_to_bytes(json_str(&parsed, "expected", "decryptedSaltHex"));

    let account_key = SecretKey::from_bytes(&mut account_key_bytes).expect("account key");
    let crypto_ciphertext =
        mosaic_crypto::encrypt_user_salt_envelope_v2_with_nonce(&account_key, &salt, &nonce)
            .expect("crypto encrypt");
    assert_eq!(crypto_ciphertext, expected_ciphertext);
    assert_eq!(
        mosaic_crypto::decrypt_user_salt_envelope_v2(&account_key, &expected_ciphertext, &nonce)
            .expect("crypto decrypt")
            .to_vec(),
        expected_salt
    );

    let handle = mosaic_client::open_secret_handle(account_key.as_bytes()).expect("open handle");
    let wasm = mosaic_wasm::decrypt_user_salt_envelope_v2(
        handle,
        expected_ciphertext.clone(),
        nonce.clone(),
    );
    let uniffi = mosaic_uniffi::decrypt_user_salt_envelope_v2(handle, expected_ciphertext, nonce);
    mosaic_client::close_secret_handle(handle).expect("close handle");

    assert_eq!(wasm.code, ClientErrorCode::Ok.as_u16());
    assert_eq!(wasm.bytes, expected_salt);
    assert_eq!(uniffi.code, ClientErrorCode::Ok.as_u16());
    assert_eq!(uniffi.bytes, expected_salt);
}


#[test]
fn password_nfkc_normalization_matches_known_utf8_vector() {
    let nfd = mosaic_crypto::normalize_password_for_kdf("cafe\u{0301}");
    let nfc = mosaic_crypto::normalize_password_for_kdf("caf\u{00e9}");
    let expected = b"caf\xC3\xA9".to_vec();

    assert_eq!(nfd, expected);
    assert_eq!(nfc, expected);
}

#[cfg(feature = "cross-client-vectors")]
#[test]
fn validate_auth_username_rejection_parity_for_non_ascii() {
    for username in ["İstanbul", "café", "Ω"] {
        let core = core_auth_challenge_code(username);
        let wasm = mosaic_wasm::build_auth_challenge_transcript(
            username.to_owned(),
            0,
            false,
            auth_challenge_bytes(),
        )
        .code;
        let uniffi = mosaic_uniffi::build_auth_challenge_transcript_bytes(
            username.to_owned(),
            -1,
            auth_challenge_bytes(),
        )
        .code;

        assert_eq!(core, ClientErrorCode::InvalidUsername.as_u16());
        assert_eq!(wasm, core, "{username}");
        assert_eq!(uniffi, core, "{username}");
    }
}

#[test]
fn derive_session_salt_non_ascii_golden_vector() {
    const DOMAIN: &str = "v2:";
    const USERNAME: &str = "Ωmega";
    const EXPECTED: [u8; 16] = [
        0xc6, 0xc0, 0xac, 0xf9, 0xcb, 0xf6, 0x8f, 0xab, 0x2d, 0x74, 0xa9, 0x91, 0xb7, 0xff, 0x79,
        0xc2,
    ];

    let crypto = must(
        mosaic_crypto::derive_session_salt(DOMAIN, USERNAME),
        "crypto non-ASCII session salt",
    );
    let wasm = must(
        mosaic_wasm::derive_session_salt_from_username(DOMAIN.to_owned(), USERNAME.to_owned()),
        "wasm non-ASCII session salt",
    );
    let uniffi = must(
        mosaic_uniffi::derive_session_salt_from_username(DOMAIN.to_owned(), USERNAME.to_owned()),
        "uniffi non-ASCII session salt",
    );

    assert_eq!(crypto, EXPECTED);
    assert_eq!(wasm, EXPECTED);
    assert_eq!(uniffi, EXPECTED);
}

#[test]
fn surrogate_pair_lone_surrogate_handling_parity() {
    const DOMAIN: &str = "v2:";
    const EXPECTED_REPLACEMENT_SALT: [u8; 16] = [
        0x85, 0xad, 0x5d, 0x65, 0x7f, 0x7b, 0xb0, 0xf7, 0xe7, 0xc3, 0x62, 0xfb, 0xf8, 0x6f, 0x64,
        0xb8,
    ];
    let replacement = "\u{fffd}";

    // Rust `String` cannot contain a lone surrogate. The browser TextEncoder
    // path that feeds WASM replaces U+D800 with U+FFFD, so this locks the exact
    // replacement bytes observed after crossing into Rust-owned facades.
    assert_eq!(replacement.as_bytes(), &[0xef, 0xbf, 0xbd]);

    let crypto = must(
        mosaic_crypto::derive_session_salt(DOMAIN, replacement),
        "crypto replacement-character session salt",
    );
    let wasm = must(
        mosaic_wasm::derive_session_salt_from_username(DOMAIN.to_owned(), replacement.to_owned()),
        "wasm replacement-character session salt",
    );
    let uniffi = must(
        mosaic_uniffi::derive_session_salt_from_username(DOMAIN.to_owned(), replacement.to_owned()),
        "uniffi replacement-character session salt",
    );

    assert_eq!(crypto, EXPECTED_REPLACEMENT_SALT);
    assert_eq!(wasm, EXPECTED_REPLACEMENT_SALT);
    assert_eq!(uniffi, EXPECTED_REPLACEMENT_SALT);
}

#[cfg(feature = "cross-client-vectors")]
#[test]
fn username_length_cap_parity_for_emoji_utf8_overflow() {
    let username = "😀".repeat(128);
    assert_eq!(username.encode_utf16().count(), 256);
    assert!(username.len() > 256);

    let core = core_auth_challenge_code(&username);
    let wasm = mosaic_wasm::build_auth_challenge_transcript(
        username.clone(),
        0,
        false,
        auth_challenge_bytes(),
    )
    .code;
    let uniffi =
        mosaic_uniffi::build_auth_challenge_transcript_bytes(username, -1, auth_challenge_bytes())
            .code;

    assert_eq!(core, ClientErrorCode::InvalidUsername.as_u16());
    assert_eq!(wasm, core);
    assert_eq!(uniffi, core);
}

#[test]
fn session_key_derivation_matches_crypto_wasm_and_uniffi() {
    const DOMAIN: &str = "v2:";
    const USERNAME: &str = "alice";
    const PASSWORD: &[u8] = b"hunter2";
    const GOLDEN_SALT: [u8; 16] = [
        0xb5, 0xea, 0x3b, 0xe8, 0xd2, 0x62, 0xca, 0xab, 0x42, 0x64, 0x6f, 0x5b, 0x8e, 0xa3, 0xe0,
        0xcc,
    ];
    const GOLDEN_MASTER_KEY: [u8; 32] = [
        0xd6, 0xa6, 0xd3, 0x48, 0x7d, 0xcb, 0x94, 0xc4, 0xa1, 0x14, 0xca, 0x6d, 0xcb, 0xce, 0xe7,
        0x25, 0xf1, 0x80, 0x50, 0x54, 0x71, 0xc4, 0x17, 0xe8, 0xe5, 0x77, 0x60, 0x7b, 0x41, 0x2c,
        0xe1, 0x6b,
    ];

    let crypto_salt = must(
        mosaic_crypto::derive_session_salt(DOMAIN, USERNAME),
        "crypto salt",
    );
    let wasm_salt = must(
        mosaic_wasm::derive_session_salt_from_username(DOMAIN.to_owned(), USERNAME.to_owned()),
        "wasm salt",
    );
    let uniffi_salt = must(
        mosaic_uniffi::derive_session_salt_from_username(DOMAIN.to_owned(), USERNAME.to_owned()),
        "uniffi salt",
    );
    assert_eq!(crypto_salt, GOLDEN_SALT);
    assert_eq!(wasm_salt, GOLDEN_SALT);
    assert_eq!(uniffi_salt, GOLDEN_SALT);

    let crypto_key = must(
        mosaic_crypto::derive_session_master_key(
            PASSWORD.to_vec().into(),
            &crypto_salt,
            2,
            64 * 1024,
        ),
        "crypto master key",
    );
    let wasm_handle = must(
        mosaic_wasm::derive_master_key_from_password(
            PASSWORD.to_vec(),
            wasm_salt.clone(),
            2,
            64 * 1024,
        ),
        "wasm master key handle",
    );
    let uniffi_handle = must(
        mosaic_uniffi::derive_master_key_from_password(
            PASSWORD.to_vec(),
            uniffi_salt.clone(),
            2,
            64 * 1024,
        ),
        "uniffi master key handle",
    );
    let wasm_key = must(
        mosaic_wasm::consume_master_key_handle_for_aes_gcm(wasm_handle),
        "wasm consume",
    );
    let uniffi_key = must(
        mosaic_uniffi::consume_master_key_handle_for_aes_gcm(uniffi_handle),
        "uniffi consume",
    );

    assert_eq!(crypto_key.as_bytes(), &GOLDEN_MASTER_KEY);
    assert_eq!(wasm_key, GOLDEN_MASTER_KEY);
    assert_eq!(uniffi_key, GOLDEN_MASTER_KEY);
}

#[test]
fn local_auth_account_salt_matches_known_vector_across_crypto_wasm_and_uniffi() {
    let expected = vec![
        0xf3, 0x5d, 0x00, 0xa0, 0xc4, 0x31, 0x2e, 0x17, 0xe8, 0x7d, 0x65, 0x3f, 0x64, 0xf3, 0x6a,
        0x4e,
    ];

    assert_eq!(
        mosaic_crypto::ACCOUNT_SALT_HMAC_INFO,
        b"mosaic_account_salt"
    );

    let crypto = mosaic_crypto::derive_account_salt(&USER_SALT).to_vec();
    let wasm = mosaic_wasm::derive_account_salt(USER_SALT.to_vec());
    let uniffi = mosaic_uniffi::derive_account_salt(USER_SALT.to_vec());

    assert_eq!(crypto, expected);
    assert_eq!(wasm, expected);
    assert_eq!(uniffi, expected);
}
