//! WASM facade tests for key-wrap exports (`wrapKey`, `unwrapKey`,
//! `getTierKeyFromEpoch`, `deriveContentKeyFromEpoch`).
//!
//! Covers round-trip wrap/unwrap with a caller-supplied 32-byte wrapper key,
//! tier-key extraction from an open epoch handle, and rejection of invalid
//! handles or malformed inputs.

use mosaic_client::ClientErrorCode;
use mosaic_crypto::{KdfProfile, derive_account_key};
use mosaic_wasm::{
    AccountUnlockRequest, close_account_key_handle, close_epoch_key_handle,
    create_epoch_key_handle, derive_content_key_from_epoch, get_tier_key_from_epoch,
    unlock_account_key, unwrap_key, wrap_key,
};

const PASSWORD: &[u8] = b"correct horse battery staple";
const USER_SALT: [u8; 16] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
];
const ACCOUNT_SALT: [u8; 16] = [
    0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff,
];

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
    let material =
        match derive_account_key(PASSWORD.to_vec().into(), &USER_SALT, &ACCOUNT_SALT, profile) {
            Ok(value) => value,
            Err(error) => panic!("account key should derive: {error:?}"),
        };
    material.wrapped_account_key
}

#[test]
fn wrap_and_unwrap_round_trips_arbitrary_payload() {
    let key_bytes = b"top secret payload bytes".to_vec();
    let wrapper_key = vec![0xa5_u8; 32];

    let wrapped = wrap_key(key_bytes.clone(), wrapper_key.clone());
    assert_eq!(wrapped.code, 0);
    assert!(wrapped.bytes.len() >= 24 + key_bytes.len() + 16);

    let unwrapped = unwrap_key(wrapped.bytes, wrapper_key);
    assert_eq!(unwrapped.code, 0);
    assert_eq!(unwrapped.bytes, key_bytes);
}

#[test]
fn wrap_rejects_short_wrapper_key() {
    let result = wrap_key(b"payload".to_vec(), vec![0_u8; 31]);
    assert_eq!(result.code, ClientErrorCode::InvalidKeyLength.as_u16());
    assert!(result.bytes.is_empty());
}

#[test]
fn wrap_rejects_empty_payload() {
    let result = wrap_key(Vec::new(), vec![0xa5_u8; 32]);
    assert_eq!(result.code, ClientErrorCode::InvalidInputLength.as_u16());
}

#[test]
fn unwrap_rejects_short_wrapper_key() {
    let result = unwrap_key(vec![0_u8; 64], vec![0_u8; 31]);
    assert_eq!(result.code, ClientErrorCode::InvalidKeyLength.as_u16());
    assert!(result.bytes.is_empty());
}

#[test]
fn unwrap_rejects_short_blob() {
    let result = unwrap_key(vec![0_u8; 24], vec![0xa5_u8; 32]);
    assert_eq!(result.code, ClientErrorCode::WrappedKeyTooShort.as_u16());
}

#[test]
fn unwrap_rejects_tampered_ciphertext() {
    let key_bytes = b"abcdef0123456789abcdef0123456789".to_vec();
    let wrapper_key = vec![0x33_u8; 32];

    let wrapped = wrap_key(key_bytes.clone(), wrapper_key.clone());
    assert_eq!(wrapped.code, 0);

    let mut tampered = wrapped.bytes.clone();
    let tail = tampered.len() - 1;
    tampered[tail] ^= 0x80;

    let result = unwrap_key(tampered, wrapper_key);
    assert_eq!(result.code, ClientErrorCode::AuthenticationFailed.as_u16());
}

#[test]
fn get_tier_key_returns_thirty_two_bytes_for_each_tier() {
    let unlock = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    assert_eq!(unlock.code, 0);
    let epoch = create_epoch_key_handle(unlock.handle, 23);
    assert_eq!(epoch.code, 0);

    let mut keys = Vec::new();
    for tier in [1_u8, 2, 3] {
        let result = get_tier_key_from_epoch(epoch.handle, tier);
        assert_eq!(result.code, 0);
        assert_eq!(result.bytes.len(), 32);
        keys.push(result.bytes);
    }
    // All three tier keys must be distinct (HKDF with different labels).
    assert_ne!(keys[0], keys[1]);
    assert_ne!(keys[1], keys[2]);
    assert_ne!(keys[0], keys[2]);

    // Content key must also be distinct from any tier key.
    let content = derive_content_key_from_epoch(epoch.handle);
    assert_eq!(content.code, 0);
    assert_eq!(content.bytes.len(), 32);
    for key in &keys {
        assert_ne!(content.bytes, *key);
    }

    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_account_key_handle(unlock.handle), 0);
}

#[test]
fn get_tier_key_rejects_invalid_tier_byte() {
    let unlock = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    let epoch = create_epoch_key_handle(unlock.handle, 24);

    let result = get_tier_key_from_epoch(epoch.handle, 0);
    assert_eq!(result.code, ClientErrorCode::InvalidTier.as_u16());

    let result = get_tier_key_from_epoch(epoch.handle, 99);
    assert_eq!(result.code, ClientErrorCode::InvalidTier.as_u16());

    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_account_key_handle(unlock.handle), 0);
}

#[test]
fn get_tier_key_rejects_invalid_handle() {
    let result = get_tier_key_from_epoch(0, 1);
    assert_eq!(result.code, ClientErrorCode::EpochHandleNotFound.as_u16());
    assert!(result.bytes.is_empty());
}

#[test]
fn derive_content_key_rejects_invalid_handle() {
    let result = derive_content_key_from_epoch(0);
    assert_eq!(result.code, ClientErrorCode::EpochHandleNotFound.as_u16());
    assert!(result.bytes.is_empty());
}
