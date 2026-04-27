use mosaic_client::ClientErrorCode;
use mosaic_crypto::{KdfProfile, MAX_KDF_MEMORY_KIB, derive_account_key};
use mosaic_domain::{ShardEnvelopeHeader, ShardTier};
use mosaic_wasm::{
    AccountUnlockRequest, account_key_handle_is_open, close_account_key_handle,
    close_epoch_key_handle, close_identity_handle, create_epoch_key_handle, create_identity_handle,
    crypto_domain_golden_vector_snapshot, decrypt_shard_with_epoch_handle,
    encrypt_shard_with_epoch_handle, epoch_key_handle_is_open, identity_encryption_pubkey,
    identity_signing_pubkey, open_epoch_key_handle, open_identity_handle, parse_envelope_header,
    sign_manifest_with_identity, unlock_account_key, wasm_api_snapshot, wasm_progress_probe,
};

const PASSWORD: &[u8] = b"correct horse battery staple";
const WRONG_PASSWORD: &[u8] = b"wrong horse battery staple";
const USER_SALT: [u8; 16] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
];
const ACCOUNT_SALT: [u8; 16] = [
    0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff,
];
const MAX_PROGRESS_EVENTS: u32 = 10_000;

#[test]
fn wasm_facade_exposes_stable_ffi_spike_surface() {
    assert_eq!(
        wasm_api_snapshot(),
        "mosaic-wasm ffi-spike:v4 parse_envelope_header(bytes)->HeaderResult progress(total,cancel_after)->ProgressResult account(unlock/status/close) identity(create/open/close/pubkeys/sign) epoch(create/open/status/close/encrypt/decrypt) vectors(crypto-domain)->CryptoDomainGoldenVectorSnapshot"
    );
}

#[test]
fn wasm_account_and_epoch_facades_return_stable_codes_and_opaque_handles() {
    let wrong_password_result = unlock_account_key(
        WRONG_PASSWORD.to_vec(),
        unlock_request(wrapped_account_key()),
    );
    assert_eq!(wrong_password_result.code, 205);
    assert_eq!(wrong_password_result.handle, 0);

    let account_result =
        unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    assert_eq!(account_result.code, 0);
    assert_ne!(account_result.handle, 0);

    let account_status = account_key_handle_is_open(account_result.handle);
    assert_eq!(account_status.code, 0);
    assert!(account_status.is_open);

    let epoch_result = create_epoch_key_handle(account_result.handle, 13);
    assert_eq!(epoch_result.code, 0);
    assert_ne!(epoch_result.handle, 0);
    assert_eq!(epoch_result.epoch_id, 13);
    assert_eq!(epoch_result.wrapped_epoch_seed.len(), 24 + 32 + 16);

    let encrypted = encrypt_shard_with_epoch_handle(
        epoch_result.handle,
        b"wasm-local media bytes".to_vec(),
        6,
        3,
    );
    assert_eq!(encrypted.code, 0);
    assert!(!encrypted.envelope_bytes.is_empty());
    assert!(!encrypted.sha256.is_empty());

    let decrypted = decrypt_shard_with_epoch_handle(epoch_result.handle, encrypted.envelope_bytes);
    assert_eq!(decrypted.code, 0);
    assert_eq!(decrypted.plaintext, b"wasm-local media bytes");

    let invalid_tier = encrypt_shard_with_epoch_handle(epoch_result.handle, Vec::new(), 6, 9);
    assert_eq!(invalid_tier.code, 103);
    assert!(invalid_tier.envelope_bytes.is_empty());
    assert!(invalid_tier.sha256.is_empty());

    assert_eq!(close_epoch_key_handle(epoch_result.handle), 0);

    let epoch_status = epoch_key_handle_is_open(epoch_result.handle);
    assert_eq!(epoch_status.code, 0);
    assert!(!epoch_status.is_open);

    let reopened = open_epoch_key_handle(
        epoch_result.wrapped_epoch_seed,
        account_result.handle,
        epoch_result.epoch_id,
    );
    assert_eq!(reopened.code, 0);
    assert_ne!(reopened.handle, 0);
    assert!(reopened.wrapped_epoch_seed.is_empty());

    assert_eq!(close_epoch_key_handle(reopened.handle), 0);
    assert_eq!(close_epoch_key_handle(reopened.handle), 403);
    assert_eq!(close_account_key_handle(account_result.handle), 0);
}

#[test]
fn wasm_identity_facade_returns_stable_error_codes() {
    let create_result = create_identity_handle(u64::MAX);
    assert_eq!(create_result.code, 400);
    assert_eq!(create_result.handle, 0);
    assert!(create_result.signing_pubkey.is_empty());

    let pubkey_result = identity_signing_pubkey(u64::MAX);
    assert_eq!(pubkey_result.code, 401);
    assert!(pubkey_result.bytes.is_empty());

    assert_eq!(close_identity_handle(u64::MAX), 401);
}

#[test]
fn wasm_facade_maps_header_results_without_secret_outputs() {
    let header = ShardEnvelopeHeader::new(11, 12, [7; 24], ShardTier::Preview).to_bytes();

    let result = parse_envelope_header(header.to_vec());

    assert_eq!(result.code, 0);
    assert_eq!(result.epoch_id, 11);
    assert_eq!(result.shard_index, 12);
    assert_eq!(result.tier, 2);
    assert_eq!(result.nonce, vec![7; 24]);
}

#[test]
fn wasm_facade_returns_crypto_domain_golden_vectors_without_secret_outputs() {
    let native = mosaic_client::crypto_domain_golden_vector_snapshot();
    let result = crypto_domain_golden_vector_snapshot();

    assert_eq!(result.code, native.code.as_u16());
    assert_eq!(result.envelope_header, native.envelope_header);
    assert_eq!(result.envelope_epoch_id, native.envelope_epoch_id);
    assert_eq!(result.envelope_shard_index, native.envelope_shard_index);
    assert_eq!(result.envelope_tier, native.envelope_tier);
    assert_eq!(result.envelope_nonce, native.envelope_nonce);
    assert_eq!(result.manifest_transcript, native.manifest_transcript);
    assert_eq!(result.identity_message, native.identity_message);
    assert_eq!(
        result.identity_signing_pubkey,
        native.identity_signing_pubkey
    );
    assert_eq!(
        result.identity_encryption_pubkey,
        native.identity_encryption_pubkey
    );
    assert_eq!(result.identity_signature, native.identity_signature);
    assert!(result.identity_message.is_empty());
    assert_eq!(result.identity_signing_pubkey.len(), 32);
    assert_eq!(result.identity_encryption_pubkey.len(), 32);
    assert_eq!(result.identity_signature.len(), 64);
}

#[test]
fn wasm_facade_returns_progress_events_with_stable_error_code() {
    let result = wasm_progress_probe(3, Some(1));

    assert_eq!(result.code, 300);
    assert_eq!(result.events.len(), 1);
    assert_eq!(result.events[0].completed_steps, 1);
}

#[test]
fn wasm_facade_rejects_unbounded_progress_event_requests() {
    let result = wasm_progress_probe(u32::MAX, None);

    assert_eq!(result.code, 202);
    assert!(result.events.is_empty());
}

#[test]
fn wasm_facade_propagates_progress_boundary_and_zero_steps() {
    let boundary_error = wasm_progress_probe(MAX_PROGRESS_EVENTS + 1, None);
    assert_eq!(boundary_error.code, 202);
    assert!(boundary_error.events.is_empty());

    let zero_steps = wasm_progress_probe(0, None);
    assert_eq!(zero_steps.code, 0);
    assert!(zero_steps.events.is_empty());
}

#[test]
fn wasm_identity_operations_reject_zero_handle_without_outputs() {
    let create_result = create_identity_handle(0);
    assert_eq!(create_result.code, 400);
    assert_eq!(create_result.handle, 0);
    assert!(create_result.signing_pubkey.is_empty());
    assert!(create_result.encryption_pubkey.is_empty());
    assert!(create_result.wrapped_seed.is_empty());

    let pubkey_result = identity_signing_pubkey(0);
    assert_eq!(pubkey_result.code, 401);
    assert!(pubkey_result.bytes.is_empty());

    assert_eq!(close_identity_handle(0), 401);
}


#[test]
fn wasm_error_paths_return_zero_handles_and_empty_sensitive_outputs() {
    let invalid_salt = unlock_account_key(
        PASSWORD.to_vec(),
        unlock_request_with(
            vec![0_u8; 24 + 16 + 1],
            vec![0_u8; 15],
            ACCOUNT_SALT.to_vec(),
            64 * 1024,
        ),
    );
    assert_eq!(
        invalid_salt.code,
        ClientErrorCode::InvalidSaltLength.as_u16()
    );
    assert_eq!(invalid_salt.handle, 0);

    let costly_profile = unlock_account_key(
        PASSWORD.to_vec(),
        unlock_request_with(
            vec![0_u8; 24 + 16 + 1],
            USER_SALT.to_vec(),
            ACCOUNT_SALT.to_vec(),
            MAX_KDF_MEMORY_KIB + 1,
        ),
    );
    assert_eq!(
        costly_profile.code,
        ClientErrorCode::KdfProfileTooCostly.as_u16()
    );
    assert_eq!(costly_profile.handle, 0);

    let short_wrapped_key = unlock_account_key(
        PASSWORD.to_vec(),
        unlock_request_with(
            vec![0_u8; 24 + 16],
            USER_SALT.to_vec(),
            ACCOUNT_SALT.to_vec(),
            64 * 1024,
        ),
    );
    assert_eq!(
        short_wrapped_key.code,
        ClientErrorCode::WrappedKeyTooShort.as_u16()
    );
    assert_eq!(short_wrapped_key.handle, 0);

    let missing_identity = create_identity_handle(0);
    assert_eq!(
        missing_identity.code,
        ClientErrorCode::SecretHandleNotFound.as_u16()
    );
    assert_eq!(missing_identity.handle, 0);
    assert!(missing_identity.signing_pubkey.is_empty());
    assert!(missing_identity.encryption_pubkey.is_empty());
    assert!(missing_identity.wrapped_seed.is_empty());

    let missing_open_identity = open_identity_handle(Vec::new(), 0);
    assert_eq!(
        missing_open_identity.code,
        ClientErrorCode::SecretHandleNotFound.as_u16()
    );
    assert_eq!(missing_open_identity.handle, 0);
    assert!(missing_open_identity.signing_pubkey.is_empty());
    assert!(missing_open_identity.encryption_pubkey.is_empty());
    assert!(missing_open_identity.wrapped_seed.is_empty());

    let missing_signing_pubkey = identity_signing_pubkey(0);
    assert_eq!(
        missing_signing_pubkey.code,
        ClientErrorCode::IdentityHandleNotFound.as_u16()
    );
    assert!(missing_signing_pubkey.bytes.is_empty());

    let missing_encryption_pubkey = identity_encryption_pubkey(0);
    assert_eq!(
        missing_encryption_pubkey.code,
        ClientErrorCode::IdentityHandleNotFound.as_u16()
    );
    assert!(missing_encryption_pubkey.bytes.is_empty());

    let missing_signature = sign_manifest_with_identity(0, b"manifest transcript".to_vec());
    assert_eq!(
        missing_signature.code,
        ClientErrorCode::IdentityHandleNotFound.as_u16()
    );
    assert!(missing_signature.bytes.is_empty());

    let missing_epoch = create_epoch_key_handle(0, 99);
    assert_eq!(
        missing_epoch.code,
        ClientErrorCode::SecretHandleNotFound.as_u16()
    );
    assert_eq!(missing_epoch.handle, 0);
    assert_eq!(missing_epoch.epoch_id, 0);
    assert!(missing_epoch.wrapped_epoch_seed.is_empty());

    let missing_open_epoch = open_epoch_key_handle(Vec::new(), 0, 99);
    assert_eq!(
        missing_open_epoch.code,
        ClientErrorCode::SecretHandleNotFound.as_u16()
    );
    assert_eq!(missing_open_epoch.handle, 0);
    assert_eq!(missing_open_epoch.epoch_id, 0);
    assert!(missing_open_epoch.wrapped_epoch_seed.is_empty());

    let missing_encrypt = encrypt_shard_with_epoch_handle(0, b"plaintext".to_vec(), 1, 1);
    assert_eq!(
        missing_encrypt.code,
        ClientErrorCode::EpochHandleNotFound.as_u16()
    );
    assert!(missing_encrypt.envelope_bytes.is_empty());
    assert!(missing_encrypt.sha256.is_empty());

    let missing_decrypt = decrypt_shard_with_epoch_handle(0, b"not parsed first".to_vec());
    assert_eq!(
        missing_decrypt.code,
        ClientErrorCode::EpochHandleNotFound.as_u16()
    );
    assert!(missing_decrypt.plaintext.is_empty());
}

fn unlock_request(wrapped_account_key: Vec<u8>) -> AccountUnlockRequest {
    AccountUnlockRequest {
        user_salt: USER_SALT.to_vec(),
        account_salt: ACCOUNT_SALT.to_vec(),
        wrapped_account_key,
        kdf_memory_kib: 64 * 1024,
        kdf_iterations: 3,
        kdf_parallelism: 1,
    }
}


fn unlock_request_with(
    wrapped_account_key: Vec<u8>,
    user_salt: Vec<u8>,
    account_salt: Vec<u8>,
    kdf_memory_kib: u32,
) -> AccountUnlockRequest {
    AccountUnlockRequest {
        user_salt,
        account_salt,
        wrapped_account_key,
        kdf_memory_kib,
        kdf_iterations: 3,
        kdf_parallelism: 1,
    }
}

fn wrapped_account_key() -> Vec<u8> {
    let profile = match KdfProfile::new(64 * 1024, 3, 1) {
        Ok(value) => value,
        Err(error) => panic!("minimum Mosaic profile should be valid: {error:?}"),
    };
    let material =
        match derive_account_key(PASSWORD.to_vec().into(), &USER_SALT, &ACCOUNT_SALT, profile) {
            Ok(value) => value,
            Err(error) => panic!("account key should derive: {error:?}"),
        };
    material.wrapped_account_key
}
