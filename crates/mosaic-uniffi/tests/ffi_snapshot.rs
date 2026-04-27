use mosaic_crypto::{KdfProfile, derive_account_key};
use mosaic_domain::{ShardEnvelopeHeader, ShardTier};
use mosaic_uniffi::{
    AccountUnlockRequest, account_key_handle_is_open, android_progress_probe,
    close_account_key_handle, close_identity_handle, create_identity_handle,
    identity_signing_pubkey, parse_envelope_header, uniffi_api_snapshot, unlock_account_key,
};
use zeroize::Zeroizing;

const PASSWORD: &[u8] = b"correct horse battery staple";
const WRONG_PASSWORD: &[u8] = b"wrong horse battery staple";
const USER_SALT: [u8; 16] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
];
const ACCOUNT_SALT: [u8; 16] = [
    0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff,
];

#[test]
fn uniffi_facade_exposes_stable_ffi_spike_surface() {
    assert_eq!(
        uniffi_api_snapshot(),
        "mosaic-uniffi ffi-spike:v3 parse_envelope_header(bytes)->HeaderResult progress(total,cancel_after)->ProgressResult account(unlock/status/close) identity(create/open/close/pubkeys/sign)"
    );
}

#[test]
fn uniffi_identity_facade_returns_stable_error_codes() {
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
fn uniffi_account_unlock_facade_returns_stable_codes_and_opaque_handles() {
    let wrapped_account_key = wrapped_account_key();

    let wrong_password_result = unlock_account_key(
        WRONG_PASSWORD.to_vec(),
        unlock_request(wrapped_account_key.clone()),
    );
    assert_eq!(wrong_password_result.code, 205);
    assert_eq!(wrong_password_result.handle, 0);

    let result = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key));
    assert_eq!(result.code, 0);
    assert_ne!(result.handle, 0);

    let status = account_key_handle_is_open(result.handle);
    assert_eq!(status.code, 0);
    assert!(status.is_open);

    assert_eq!(close_account_key_handle(result.handle), 0);

    let status = account_key_handle_is_open(result.handle);
    assert_eq!(status.code, 0);
    assert!(!status.is_open);

    assert_eq!(close_account_key_handle(result.handle), 400);
}

#[test]
fn uniffi_facade_maps_header_results_without_secret_outputs() {
    let header = ShardEnvelopeHeader::new(21, 22, [9; 24], ShardTier::Original).to_bytes();

    let result = parse_envelope_header(header.to_vec());

    assert_eq!(result.code, 0);
    assert_eq!(result.epoch_id, 21);
    assert_eq!(result.shard_index, 22);
    assert_eq!(result.tier, 3);
    assert_eq!(result.nonce, vec![9; 24]);
}

#[test]
fn uniffi_facade_returns_progress_events_with_stable_error_code() {
    let result = android_progress_probe(3, Some(1));

    assert_eq!(result.code, 300);
    assert_eq!(result.events.len(), 1);
    assert_eq!(result.events[0].completed_steps, 1);
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

fn wrapped_account_key() -> Vec<u8> {
    let profile = match KdfProfile::new(64 * 1024, 3, 1) {
        Ok(value) => value,
        Err(error) => panic!("minimum Mosaic profile should be valid: {error:?}"),
    };
    let material = match derive_account_key(
        Zeroizing::new(PASSWORD.to_vec()),
        &USER_SALT,
        &ACCOUNT_SALT,
        profile,
    ) {
        Ok(value) => value,
        Err(error) => panic!("account key should derive: {error:?}"),
    };
    material.wrapped_account_key
}
