// SPDX-License-Identifier: MIT
// Auto-organized from cross_platform_parity.rs as part of v1.0.2 monolith-test-files
// split. Each split file exercises one domain of cross-facade parity tests.
// See `tests/common/mod.rs` for shared imports, constants, and helpers.
#![allow(clippy::expect_used)]

mod common;
use common::*;

#[test]
fn protocol_sha256_helpers_match_known_vector_across_wasm_uniffi_and_sha2() {
    let input = b"abc".to_vec();
    let expected = vec![
        0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22,
        0x23, 0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00,
        0x15, 0xad,
    ];
    let expected_hex = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    let direct = Sha256::digest(&input).to_vec();
    let wasm = mosaic_wasm::sha256_of_bytes(input.clone());
    let uniffi = mosaic_uniffi::sha256_of_bytes(input.clone());

    assert_eq!(direct, expected);
    assert_eq!(wasm, expected);
    assert_eq!(uniffi, expected);
    assert_eq!(
        mosaic_wasm::sha256_hex_of_bytes(input.clone()),
        expected_hex
    );
    assert_eq!(mosaic_uniffi::sha256_hex_of_bytes(input), expected_hex);
}

#[test]
fn protocol_blake2b_scope_key_16_matches_known_vector_across_wasm_and_uniffi() {
    let input = b"account-idmosaic-tray-scope-v1".to_vec();
    let expected = vec![
        0x60, 0xe4, 0x4b, 0x7a, 0x59, 0xf5, 0xef, 0x45, 0xb8, 0x1b, 0x22, 0x74, 0x25, 0x1d, 0x7e,
        0x58,
    ];

    let wasm = mosaic_wasm::blake2b_scope_key_16(input.clone());
    let uniffi = mosaic_uniffi::blake2b_scope_key_16(input);

    assert_eq!(wasm, expected);
    assert_eq!(uniffi, expected);
}

#[test]
fn protocol_blake2b_snapshot_checksum_32_matches_known_vector_across_wasm_and_uniffi() {
    let input = b"mosaic snapshot body".to_vec();
    let expected = vec![
        0x08, 0x1c, 0x64, 0x76, 0x86, 0x59, 0xb8, 0x18, 0xd9, 0x95, 0xc2, 0x96, 0x7d, 0x91, 0xd5,
        0x3b, 0xf9, 0x4b, 0x6b, 0x7b, 0xf9, 0xf7, 0x19, 0x65, 0x6a, 0xe6, 0x70, 0xc5, 0x91, 0x92,
        0x72, 0x70,
    ];

    let wasm = mosaic_wasm::blake2b_snapshot_checksum_32(input.clone());
    let uniffi = mosaic_uniffi::blake2b_snapshot_checksum_32(input);

    assert_eq!(wasm, expected);
    assert_eq!(uniffi, expected);
}

#[test]
fn compute_plaintext_content_hash_matches_sha256_across_wasm_and_uniffi() {
    let input = b"mosaic plaintext content".to_vec();
    let expected = "caab5e9856837cefa6f597cd56ff0bba59c1bdcc659fe038fd324fe7fbc2dcee";

    let direct = hex_lower(&Sha256::digest(&input));
    let wasm = mosaic_wasm::compute_plaintext_content_hash(input.clone());
    let uniffi = mosaic_uniffi::compute_plaintext_content_hash(input);

    assert_eq!(direct, expected);
    assert_eq!(wasm, expected);
    assert_eq!(uniffi, expected);
}

#[test]
fn content_hash_dedup_fixture_hashes_source_file_bytes_across_wasm_and_uniffi() {
    // CONTRACT: see docs/specs/SPEC-UploadContentHash.md. This fixture models
    // the byte vector both web File.arrayBuffer() and Android source staging
    // must feed to the Rust core before any EXIF strip, transcode, re-encode,
    // or thumbnail transform.
    let vector = content_hash_dedup_vector();
    let direct = hex_lower(&Sha256::digest(&vector.source_file_bytes));
    let wasm = mosaic_wasm::compute_plaintext_content_hash(vector.source_file_bytes.clone());
    let uniffi = mosaic_uniffi::compute_plaintext_content_hash(vector.source_file_bytes.clone());

    assert_eq!(
        vector.source_file_bytes.len(),
        64,
        "fixture must remain a stable 64-byte source-photo byte vector"
    );
    assert_eq!(direct, vector.expected_plaintext_sha256_hex);
    assert_eq!(wasm, vector.expected_plaintext_sha256_hex);
    assert_eq!(uniffi, vector.expected_plaintext_sha256_hex);
    assert_eq!(
        mosaic_wasm::sha256_hex_of_bytes(vector.source_file_bytes.clone()),
        vector.expected_plaintext_sha256_hex
    );
    assert_eq!(
        mosaic_uniffi::sha256_hex_of_bytes(vector.source_file_bytes),
        vector.expected_plaintext_sha256_hex
    );
}

#[test]
fn proptest_plaintext_content_hash_matches_across_facades() {
    let mut runner = TestRunner::new(proptest_config());
    let strategy = prop::collection::vec(any::<u8>(), 0..=64 * 1024);

    if let Err(error) = runner.run(&strategy, |plaintext| {
        let direct = hex_lower(&Sha256::digest(&plaintext));
        let wasm = mosaic_wasm::compute_plaintext_content_hash(plaintext.clone());
        let uniffi = mosaic_uniffi::compute_plaintext_content_hash(plaintext);

        prop_assert_eq!(wasm, direct.clone());
        prop_assert_eq!(uniffi, direct);
        Ok(())
    }) {
        panic!("plaintext content hash proptest failed: {error}");
    }
}

#[cfg(feature = "cross-client-vectors")]
#[test]
fn proptest_validate_auth_username_and_session_salt_parity() {
    let mut runner = TestRunner::new(proptest_config());
    let strategy = username_strategy();

    if let Err(error) = runner.run(&strategy, |username| {
        let core_code = core_auth_challenge_code(&username);
        let wasm_code = mosaic_wasm::build_auth_challenge_transcript(
            username.clone(),
            0,
            false,
            auth_challenge_bytes(),
        )
        .code;
        let uniffi_code = mosaic_uniffi::build_auth_challenge_transcript_bytes(
            username.clone(),
            -1,
            auth_challenge_bytes(),
        )
        .code;

        prop_assert_eq!(wasm_code, core_code);
        prop_assert_eq!(uniffi_code, core_code);

        if core_code == ClientErrorCode::Ok.as_u16() {
            let wasm_salt = match mosaic_wasm::derive_session_salt_from_username(
                "v2:".to_owned(),
                username.clone(),
            ) {
                Ok(value) => value,
                Err(error) => {
                    return prop_failure(format!(
                        "wasm should derive salt for validated username: {error:?}"
                    ));
                }
            };
            let uniffi_salt = match mosaic_uniffi::derive_session_salt_from_username(
                "v2:".to_owned(),
                username.clone(),
            ) {
                Ok(value) => value,
                Err(error) => {
                    return prop_failure(format!(
                        "uniffi should derive salt for validated username: {error:?}"
                    ));
                }
            };
            let crypto_salt = match mosaic_crypto::derive_session_salt("v2:", &username) {
                Ok(value) => value,
                Err(error) => {
                    return prop_failure(format!(
                        "crypto should derive salt for validated username: {error:?}"
                    ));
                }
            };

            prop_assert_eq!(wasm_salt, crypto_salt);
            prop_assert_eq!(uniffi_salt, crypto_salt);
        } else {
            prop_assert_eq!(core_code, ClientErrorCode::InvalidUsername.as_u16());
        }

        Ok(())
    }) {
        panic!("auth username/session salt proptest failed: {error}");
    }
}

#[test]
fn proptest_identity_keypair_derivation_matches_across_facades() {
    let account_material = fixed_account_material();
    let wasm_account = unlock_wasm_account(account_material.wrapped_account_key.clone());
    let uniffi_account = unlock_uniffi_account(account_material.wrapped_account_key.clone());
    let mut runner = TestRunner::new(proptest_config());

    let result = runner.run(&any::<[u8; 32]>(), |seed| {
        let wrapped_identity_seed = match mosaic_crypto::wrap_secret_with_aad(
            &seed,
            &account_material.account_key,
            mosaic_crypto::IDENTITY_SEED_AAD,
        ) {
            Ok(value) => value,
            Err(error) => {
                return prop_failure(format!("identity seed should wrap: {error:?}"));
            }
        };

        let wasm_identity =
            mosaic_wasm::open_identity_handle(wrapped_identity_seed.clone(), wasm_account);
        if wasm_identity.code != ClientErrorCode::Ok.as_u16() {
            return prop_failure(format!(
                "wasm identity open returned code {}",
                wasm_identity.code
            ));
        }
        let uniffi_identity =
            mosaic_uniffi::open_identity_handle(wrapped_identity_seed, uniffi_account);
        if uniffi_identity.code != ClientErrorCode::Ok.as_u16() {
            close_identity_handles(&[wasm_identity.handle]);
            return prop_failure(format!(
                "uniffi identity open returned code {}",
                uniffi_identity.code
            ));
        }

        let mut core_seed = seed;
        let core_identity = match mosaic_crypto::derive_identity_keypair(core_seed.as_mut_slice()) {
            Ok(value) => value,
            Err(error) => {
                close_identity_handles(&[wasm_identity.handle, uniffi_identity.handle]);
                return prop_failure(format!("core identity should derive: {error:?}"));
            }
        };
        let message = b"proptest identity parity message".to_vec();
        let wasm_signature =
            mosaic_wasm::sign_manifest_with_identity(wasm_identity.handle, message.clone());
        let uniffi_signature =
            mosaic_uniffi::sign_manifest_with_identity(uniffi_identity.handle, message.clone());
        let core_signature =
            mosaic_crypto::sign_manifest_with_identity(&message, core_identity.secret_key());

        let wasm_signing_pubkey = wasm_identity.signing_pubkey.clone();
        let wasm_encryption_pubkey = wasm_identity.encryption_pubkey.clone();
        let uniffi_signing_pubkey = uniffi_identity.signing_pubkey.clone();
        let uniffi_encryption_pubkey = uniffi_identity.encryption_pubkey.clone();
        close_identity_handles(&[wasm_identity.handle, uniffi_identity.handle]);

        prop_assert_eq!(wasm_signature.code, ClientErrorCode::Ok.as_u16());
        prop_assert_eq!(uniffi_signature.code, ClientErrorCode::Ok.as_u16());
        prop_assert_eq!(
            wasm_signing_pubkey.clone(),
            core_identity.signing_public_key().as_bytes().to_vec()
        );
        prop_assert_eq!(
            wasm_encryption_pubkey.clone(),
            core_identity.encryption_public_key().as_bytes().to_vec()
        );
        prop_assert_eq!(uniffi_signing_pubkey, wasm_signing_pubkey);
        prop_assert_eq!(uniffi_encryption_pubkey, wasm_encryption_pubkey);
        prop_assert_eq!(
            wasm_signature.bytes.clone(),
            core_signature.as_bytes().to_vec()
        );
        prop_assert_eq!(uniffi_signature.bytes, wasm_signature.bytes);
        Ok(())
    });

    close_account_handles(&[wasm_account, uniffi_account]);
    if let Err(error) = result {
        panic!("identity keypair proptest failed: {error}");
    }
}
