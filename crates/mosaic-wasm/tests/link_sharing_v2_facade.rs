//! WASM facade tests for v2 link-tier handle operations (batch 4c - A1).
//!
//! Verifies that the v2 wrap/unwrap surface exposed through mosaic-wasm
//! enforces the `(link_id, tier, epoch_id)` AAD binding and dual-accepts
//! v1 wraps for back-compat. Closes audit `share-link-create C1` at the
//! WASM boundary.

#![allow(clippy::expect_used)]

use mosaic_client::ClientErrorCode;
use mosaic_crypto::{KdfProfile, MIN_KDF_ITERATIONS, MIN_KDF_MEMORY_KIB, derive_account_key};
use mosaic_wasm::{
    AccountUnlockRequest, close_account_key_handle, close_epoch_key_handle,
    close_link_share_handle, close_link_tier_handle, create_epoch_key_handle,
    create_link_share_handle, create_link_share_handle_v2, decrypt_shard_with_link_tier_handle,
    encrypt_shard_with_epoch_handle, import_link_share_handle, import_link_tier_handle,
    import_link_tier_handle_v2, unlock_account_key, wrap_link_tier_handle, wrap_link_tier_handle_v2,
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
fn create_v2_round_trips_through_import_v2_via_wasm() {
    let unlock = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    assert_eq!(unlock.code, 0);
    let epoch_id = 51_u32;
    let epoch = create_epoch_key_handle(unlock.handle, epoch_id);
    assert_eq!(epoch.code, 0);

    let created = create_link_share_handle_v2("album-v2".to_owned(), epoch.handle, 2);
    assert_eq!(created.code, 0);
    assert_eq!(created.tier, 2);
    assert_eq!(created.link_id.len(), 16);
    assert_eq!(created.link_url_token.len(), 32);
    assert_eq!(created.nonce.len(), 24);
    assert_eq!(created.encrypted_key.len(), 32 + 16);

    let imported = import_link_tier_handle_v2(
        created.link_url_token.clone(),
        created.nonce.clone(),
        created.encrypted_key.clone(),
        "album-v2".to_owned(),
        2,
        epoch_id,
    );
    assert_eq!(imported.code, 0);
    assert_eq!(imported.tier, 2);
    assert_eq!(imported.link_id, created.link_id);

    let encrypted = encrypt_shard_with_epoch_handle(epoch.handle, b"wasm v2 preview".to_vec(), 5, 2);
    assert_eq!(encrypted.code, 0);
    let decrypted = decrypt_shard_with_link_tier_handle(imported.handle, encrypted.envelope_bytes);
    assert_eq!(decrypted.code, 0);
    assert_eq!(decrypted.plaintext, b"wasm v2 preview");

    assert_eq!(close_link_tier_handle(imported.handle), 0);
    assert_eq!(close_link_share_handle(created.handle), 0);
    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_account_key_handle(unlock.handle), 0);
}

#[test]
fn import_v2_via_wasm_rejects_wrong_epoch_id() {
    let unlock = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    assert_eq!(unlock.code, 0);
    let epoch_id = 52_u32;
    let epoch = create_epoch_key_handle(unlock.handle, epoch_id);
    assert_eq!(epoch.code, 0);

    let created = create_link_share_handle_v2("album-v2-bad".to_owned(), epoch.handle, 1);
    assert_eq!(created.code, 0);

    let imported = import_link_tier_handle_v2(
        created.link_url_token.clone(),
        created.nonce.clone(),
        created.encrypted_key.clone(),
        "album-v2-bad".to_owned(),
        1,
        epoch_id.wrapping_add(1),
    );
    assert_eq!(
        imported.code,
        ClientErrorCode::AuthenticationFailed.as_u16(),
        "v2 unwrap must reject wrong epoch_id"
    );
    assert_eq!(imported.handle, 0);

    assert_eq!(close_link_share_handle(created.handle), 0);
    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_account_key_handle(unlock.handle), 0);
}

#[test]
fn import_v2_via_wasm_rejects_tier_substituted_wrap() {
    // The canonical C1 attack: server gives visitor a tier=3 wrap labelled
    // as tier=1. v2 AAD binding ensures the visitor's unwrap fails.
    let unlock = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    assert_eq!(unlock.code, 0);
    let epoch_id = 53_u32;
    let epoch = create_epoch_key_handle(unlock.handle, epoch_id);
    assert_eq!(epoch.code, 0);

    let thumb_link = create_link_share_handle_v2("album-attack".to_owned(), epoch.handle, 1);
    assert_eq!(thumb_link.code, 0);

    let imported_share = import_link_share_handle(thumb_link.link_url_token.clone());
    assert_eq!(imported_share.code, 0);
    let original_wrap = wrap_link_tier_handle_v2(imported_share.handle, epoch.handle, 3);
    assert_eq!(original_wrap.code, 0);
    assert_eq!(original_wrap.tier, 3);

    let imported = import_link_tier_handle_v2(
        thumb_link.link_url_token.clone(),
        original_wrap.nonce.clone(),
        original_wrap.encrypted_key.clone(),
        "album-attack".to_owned(),
        1,
        epoch_id,
    );
    assert_eq!(
        imported.code,
        ClientErrorCode::AuthenticationFailed.as_u16(),
        "v2 unwrap must reject server-substituted tier=3 wrap presented as tier=1"
    );

    assert_eq!(close_link_share_handle(thumb_link.handle), 0);
    assert_eq!(close_link_share_handle(imported_share.handle), 0);
    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_account_key_handle(unlock.handle), 0);
}

#[test]
fn import_v2_via_wasm_dual_accepts_v1_wraps_for_back_compat() {
    let unlock = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    assert_eq!(unlock.code, 0);
    let epoch_id = 54_u32;
    let epoch = create_epoch_key_handle(unlock.handle, epoch_id);
    assert_eq!(epoch.code, 0);

    let created = create_link_share_handle("album-legacy".to_owned(), epoch.handle, 2);
    assert_eq!(created.code, 0);

    let imported = import_link_tier_handle_v2(
        created.link_url_token.clone(),
        created.nonce.clone(),
        created.encrypted_key.clone(),
        "album-legacy".to_owned(),
        2,
        epoch_id,
    );
    assert_eq!(
        imported.code, 0,
        "v2 unwrap must dual-accept pre-A1 v1 wraps so existing share links keep working"
    );

    let encrypted = encrypt_shard_with_epoch_handle(epoch.handle, b"legacy".to_vec(), 0, 2);
    assert_eq!(encrypted.code, 0);
    let decrypted = decrypt_shard_with_link_tier_handle(imported.handle, encrypted.envelope_bytes);
    assert_eq!(decrypted.code, 0);
    assert_eq!(decrypted.plaintext, b"legacy");

    assert_eq!(close_link_tier_handle(imported.handle), 0);
    assert_eq!(close_link_share_handle(created.handle), 0);
    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_account_key_handle(unlock.handle), 0);
}

#[test]
fn import_v1_via_wasm_rejects_v2_wraps_no_silent_downgrade() {
    // Mirror property: stale v1-only callers must NOT silently downgrade.
    let unlock = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    assert_eq!(unlock.code, 0);
    let epoch_id = 55_u32;
    let epoch = create_epoch_key_handle(unlock.handle, epoch_id);
    assert_eq!(epoch.code, 0);

    let created = create_link_share_handle_v2("album-no-down".to_owned(), epoch.handle, 1);
    assert_eq!(created.code, 0);

    let imported_v1 = import_link_tier_handle(
        created.link_url_token.clone(),
        created.nonce.clone(),
        created.encrypted_key.clone(),
        "album-no-down".to_owned(),
        1,
    );
    assert_eq!(
        imported_v1.code,
        ClientErrorCode::AuthenticationFailed.as_u16(),
        "v1 read path must refuse v2 wraps (no silent downgrade)"
    );

    assert_eq!(close_link_share_handle(created.handle), 0);
    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_account_key_handle(unlock.handle), 0);
}

#[test]
fn wrap_link_tier_handle_v1_and_v2_via_wasm_both_round_trip() {
    let unlock = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    assert_eq!(unlock.code, 0);
    let epoch_id = 56_u32;
    let epoch = create_epoch_key_handle(unlock.handle, epoch_id);
    assert_eq!(epoch.code, 0);

    let created = create_link_share_handle_v2("album-add-tier".to_owned(), epoch.handle, 1);
    assert_eq!(created.code, 0);

    let imported_share = import_link_share_handle(created.link_url_token.clone());
    assert_eq!(imported_share.code, 0);

    let wrapped_v2 = wrap_link_tier_handle_v2(imported_share.handle, epoch.handle, 3);
    assert_eq!(wrapped_v2.code, 0);
    assert_eq!(wrapped_v2.tier, 3);
    assert_eq!(wrapped_v2.nonce.len(), 24);
    assert_eq!(wrapped_v2.encrypted_key.len(), 32 + 16);

    let wrapped_v1 = wrap_link_tier_handle(imported_share.handle, epoch.handle, 3);
    assert_eq!(wrapped_v1.code, 0);

    // v2 read path accepts both
    let ok_v2 = import_link_tier_handle_v2(
        created.link_url_token.clone(),
        wrapped_v2.nonce.clone(),
        wrapped_v2.encrypted_key.clone(),
        "album-add-tier".to_owned(),
        3,
        epoch_id,
    );
    assert_eq!(ok_v2.code, 0);
    assert_eq!(close_link_tier_handle(ok_v2.handle), 0);

    let ok_v1 = import_link_tier_handle_v2(
        created.link_url_token.clone(),
        wrapped_v1.nonce.clone(),
        wrapped_v1.encrypted_key.clone(),
        "album-add-tier".to_owned(),
        3,
        epoch_id,
    );
    assert_eq!(ok_v1.code, 0);
    assert_eq!(close_link_tier_handle(ok_v1.handle), 0);

    assert_eq!(close_link_share_handle(imported_share.handle), 0);
    assert_eq!(close_link_share_handle(created.handle), 0);
    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_account_key_handle(unlock.handle), 0);
}
