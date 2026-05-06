//! WASM facade tests for handle-based share-link operations.

use mosaic_client::ClientErrorCode;
use mosaic_crypto::{KdfProfile, MIN_KDF_ITERATIONS, MIN_KDF_MEMORY_KIB, derive_account_key};
use mosaic_wasm::{
    AccountUnlockRequest, close_account_key_handle, close_epoch_key_handle,
    close_link_share_handle, close_link_tier_handle, create_epoch_key_handle,
    create_link_share_handle, decrypt_shard_with_link_tier_handle, encrypt_shard_with_epoch_handle,
    import_link_share_handle, import_link_tier_handle, unlock_account_key, wrap_link_tier_handle,
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
        kdf_memory_kib: MIN_KDF_MEMORY_KIB,
        kdf_iterations: MIN_KDF_ITERATIONS,
        kdf_parallelism: 1,
    }
}

fn wrapped_account_key() -> Vec<u8> {
    let profile = match KdfProfile::new(MIN_KDF_MEMORY_KIB, MIN_KDF_ITERATIONS, 1) {
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
fn create_link_share_handle_returns_url_seed_and_wrapped_tier() {
    let unlock = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    assert_eq!(unlock.code, 0);
    let epoch = create_epoch_key_handle(unlock.handle, 11);
    assert_eq!(epoch.code, 0);

    let created = create_link_share_handle("album".to_owned(), epoch.handle, 1);
    assert_eq!(created.code, 0);
    assert_ne!(created.handle, 0);
    assert_eq!(created.link_id.len(), 16);
    assert_eq!(created.link_url_token.len(), 32);
    assert_eq!(created.tier, 1);
    assert_eq!(created.nonce.len(), 24);
    assert_eq!(created.encrypted_key.len(), 32 + 16);

    assert_eq!(close_link_share_handle(created.handle), 0);
    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_account_key_handle(unlock.handle), 0);
}

#[test]
fn link_tier_handle_decrypts_handle_encrypted_shard() {
    let unlock = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    assert_eq!(unlock.code, 0);
    let epoch = create_epoch_key_handle(unlock.handle, 12);
    assert_eq!(epoch.code, 0);

    let created = create_link_share_handle("album".to_owned(), epoch.handle, 2);
    assert_eq!(created.code, 0);
    let imported = import_link_tier_handle(
        created.link_url_token.clone(),
        created.nonce.clone(),
        created.encrypted_key.clone(),
        "album".to_owned(),
        2,
    );
    assert_eq!(imported.code, 0);
    assert_eq!(imported.link_id, created.link_id);
    assert_eq!(imported.tier, 2);

    let encrypted = encrypt_shard_with_epoch_handle(epoch.handle, b"linked preview".to_vec(), 7, 2);
    assert_eq!(encrypted.code, 0);
    let decrypted = decrypt_shard_with_link_tier_handle(imported.handle, encrypted.envelope_bytes);
    assert_eq!(decrypted.code, 0);
    assert_eq!(decrypted.plaintext, b"linked preview");

    assert_eq!(close_link_tier_handle(imported.handle), 0);
    assert_eq!(close_link_share_handle(created.handle), 0);
    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_account_key_handle(unlock.handle), 0);
}

#[test]
fn imported_link_share_handle_wraps_additional_tiers() {
    let unlock = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    assert_eq!(unlock.code, 0);
    let epoch = create_epoch_key_handle(unlock.handle, 13);
    assert_eq!(epoch.code, 0);

    let created = create_link_share_handle("album".to_owned(), epoch.handle, 1);
    assert_eq!(created.code, 0);
    let imported_share = import_link_share_handle(created.link_url_token.clone());
    assert_eq!(imported_share.code, 0);
    assert_eq!(imported_share.link_id, created.link_id);

    let wrapped_full = wrap_link_tier_handle(imported_share.handle, epoch.handle, 3);
    assert_eq!(wrapped_full.code, 0);
    assert_eq!(wrapped_full.tier, 3);

    let imported_tier = import_link_tier_handle(
        created.link_url_token,
        wrapped_full.nonce,
        wrapped_full.encrypted_key,
        "album".to_owned(),
        3,
    );
    assert_eq!(imported_tier.code, 0);

    let encrypted =
        encrypt_shard_with_epoch_handle(epoch.handle, b"linked original".to_vec(), 9, 3);
    assert_eq!(encrypted.code, 0);
    let decrypted =
        decrypt_shard_with_link_tier_handle(imported_tier.handle, encrypted.envelope_bytes);
    assert_eq!(decrypted.code, 0);
    assert_eq!(decrypted.plaintext, b"linked original");

    assert_eq!(close_link_tier_handle(imported_tier.handle), 0);
    assert_eq!(close_link_share_handle(imported_share.handle), 0);
    assert_eq!(close_link_share_handle(created.handle), 0);
    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_account_key_handle(unlock.handle), 0);
}

#[test]
fn link_handles_reject_invalid_inputs() {
    let bad_import =
        import_link_tier_handle(vec![0; 31], vec![0; 24], vec![0; 48], "album".to_owned(), 1);
    assert_eq!(bad_import.code, ClientErrorCode::InvalidKeyLength.as_u16());

    let bad_wrap = wrap_link_tier_handle(0, 0, 1);
    assert_eq!(
        bad_wrap.code,
        ClientErrorCode::SecretHandleNotFound.as_u16()
    );
}
