//! UniFFI facade tests for the v2 link-tier handle visitor read path
//! (batch 4c — A1, closes audit `share-link-create C1` at the Android FFI
//! boundary).
//!
//! UniFFI only exposes the visitor side of the link-share surface
//! (`import_link_tier_handle*`), so this suite synthesises v1 and v2 wraps
//! through `mosaic_client` and verifies the uniffi v2 import enforces
//! the AAD binding while dual-accepting legacy wraps.

#![allow(clippy::expect_used, clippy::panic)]

use mosaic_client::{
    ClientErrorCode, close_account_key_handle as client_close_account_key_handle,
    close_epoch_key_handle as client_close_epoch_key_handle,
    close_link_share_handle as client_close_link_share_handle, create_epoch_key_handle,
    create_link_share_handle, create_link_share_handle_v2, open_secret_handle,
    wrap_link_tier_handle, wrap_link_tier_handle_v2,
};
use mosaic_uniffi::{close_link_tier_handle, import_link_tier_handle, import_link_tier_handle_v2};

const ACCOUNT_KEY: [u8; 32] = [
    0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf,
    0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xdb, 0xdc, 0xdd, 0xde, 0xdf,
];

#[test]
fn uniffi_import_v2_accepts_v2_wrap_with_matching_epoch() {
    let account = open_secret_handle(&ACCOUNT_KEY).expect("account handle should open");
    let epoch_id = 61_u32;
    let epoch = create_epoch_key_handle(account, epoch_id);
    assert_eq!(epoch.code, ClientErrorCode::Ok);

    let created = create_link_share_handle_v2("album".to_owned(), epoch.handle, 1);
    assert_eq!(created.code, ClientErrorCode::Ok);

    let imported = import_link_tier_handle_v2(
        created.link_url_token.clone(),
        created.nonce.clone(),
        created.encrypted_key.clone(),
        "album".to_owned(),
        1,
        epoch_id,
    );
    assert_eq!(imported.code, ClientErrorCode::Ok.as_u16());
    assert_ne!(imported.link_tier_handle_id, 0);

    assert_eq!(close_link_tier_handle(imported.link_tier_handle_id), 0);
    assert_eq!(client_close_link_share_handle(created.handle), 0);
    let _ = client_close_epoch_key_handle(epoch.handle);
    let _ = client_close_account_key_handle(account);
}

#[test]
fn uniffi_import_v2_rejects_wrong_epoch_id() {
    let account = open_secret_handle(&ACCOUNT_KEY).expect("account handle should open");
    let epoch_id = 62_u32;
    let epoch = create_epoch_key_handle(account, epoch_id);
    assert_eq!(epoch.code, ClientErrorCode::Ok);

    let created = create_link_share_handle_v2("album-bad-epoch".to_owned(), epoch.handle, 2);
    assert_eq!(created.code, ClientErrorCode::Ok);

    let imported = import_link_tier_handle_v2(
        created.link_url_token.clone(),
        created.nonce.clone(),
        created.encrypted_key.clone(),
        "album-bad-epoch".to_owned(),
        2,
        epoch_id.wrapping_add(99),
    );
    assert_eq!(
        imported.code,
        ClientErrorCode::AuthenticationFailed.as_u16(),
        "uniffi v2 unwrap MUST reject mismatched epoch_id"
    );
    assert_eq!(imported.link_tier_handle_id, 0);

    assert_eq!(client_close_link_share_handle(created.handle), 0);
    let _ = client_close_epoch_key_handle(epoch.handle);
    let _ = client_close_account_key_handle(account);
}

#[test]
fn uniffi_import_v2_dual_accepts_v1_wrap_for_back_compat() {
    let account = open_secret_handle(&ACCOUNT_KEY).expect("account handle should open");
    let epoch_id = 63_u32;
    let epoch = create_epoch_key_handle(account, epoch_id);
    assert_eq!(epoch.code, ClientErrorCode::Ok);

    let created = create_link_share_handle("album-legacy".to_owned(), epoch.handle, 1);
    assert_eq!(created.code, ClientErrorCode::Ok);

    let imported = import_link_tier_handle_v2(
        created.link_url_token.clone(),
        created.nonce.clone(),
        created.encrypted_key.clone(),
        "album-legacy".to_owned(),
        1,
        epoch_id,
    );
    assert_eq!(
        imported.code,
        ClientErrorCode::Ok.as_u16(),
        "uniffi v2 unwrap must dual-accept pre-A1 v1 wraps"
    );
    assert_ne!(imported.link_tier_handle_id, 0);

    assert_eq!(close_link_tier_handle(imported.link_tier_handle_id), 0);
    assert_eq!(client_close_link_share_handle(created.handle), 0);
    let _ = client_close_epoch_key_handle(epoch.handle);
    let _ = client_close_account_key_handle(account);
}

#[test]
fn uniffi_import_v1_rejects_v2_wrap_no_silent_downgrade() {
    let account = open_secret_handle(&ACCOUNT_KEY).expect("account handle should open");
    let epoch_id = 64_u32;
    let epoch = create_epoch_key_handle(account, epoch_id);
    assert_eq!(epoch.code, ClientErrorCode::Ok);

    let created = create_link_share_handle_v2("album-no-down".to_owned(), epoch.handle, 2);
    assert_eq!(created.code, ClientErrorCode::Ok);

    let imported_v1 = import_link_tier_handle(
        created.link_url_token.clone(),
        created.nonce.clone(),
        created.encrypted_key.clone(),
        "album-no-down".to_owned(),
        2,
    );
    assert_eq!(
        imported_v1.code,
        ClientErrorCode::AuthenticationFailed.as_u16(),
        "uniffi v1 read path MUST refuse v2 wraps (no silent downgrade)"
    );
    assert_eq!(imported_v1.link_tier_handle_id, 0);

    assert_eq!(client_close_link_share_handle(created.handle), 0);
    let _ = client_close_epoch_key_handle(epoch.handle);
    let _ = client_close_account_key_handle(account);
}

#[test]
fn uniffi_import_v2_rejects_tier_substituted_wrap() {
    // Server gives thumb-only visitor a tier=3 wrap labelled tier=1.
    // v2 AAD binds the wrap to its tier, so the substitution attack fails.
    use mosaic_client::import_link_share_handle;

    let account = open_secret_handle(&ACCOUNT_KEY).expect("account handle should open");
    let epoch_id = 65_u32;
    let epoch = create_epoch_key_handle(account, epoch_id);
    assert_eq!(epoch.code, ClientErrorCode::Ok);

    let thumb_link = create_link_share_handle_v2("album-tier-attack".to_owned(), epoch.handle, 1);
    assert_eq!(thumb_link.code, ClientErrorCode::Ok);

    let imported_share = import_link_share_handle(&thumb_link.link_url_token);
    assert_eq!(imported_share.code, ClientErrorCode::Ok);
    let original_wrap = wrap_link_tier_handle_v2(imported_share.handle, epoch.handle, 3);
    assert_eq!(original_wrap.code, ClientErrorCode::Ok);
    assert_eq!(original_wrap.tier, 3);

    let imported = import_link_tier_handle_v2(
        thumb_link.link_url_token.clone(),
        original_wrap.nonce.clone(),
        original_wrap.encrypted_key.clone(),
        "album-tier-attack".to_owned(),
        1, // visitor's expected tier — does NOT match wrap binding (3)
        epoch_id,
    );
    assert_eq!(
        imported.code,
        ClientErrorCode::AuthenticationFailed.as_u16(),
        "uniffi v2 unwrap MUST reject server-substituted tier=3 wrap labelled tier=1"
    );

    assert_eq!(client_close_link_share_handle(thumb_link.handle), 0);
    assert_eq!(client_close_link_share_handle(imported_share.handle), 0);
    let _ = client_close_epoch_key_handle(epoch.handle);
    let _ = client_close_account_key_handle(account);
}

#[test]
fn uniffi_import_v2_rejects_swapped_link_id() {
    // Visitor A tries to use a v2 wrap minted for link B. The wrap's AAD
    // is bound to B's link_id, so unwrapping with A's URL token fails.

    let account = open_secret_handle(&ACCOUNT_KEY).expect("account handle should open");
    let epoch_id = 66_u32;
    let epoch = create_epoch_key_handle(account, epoch_id);
    assert_eq!(epoch.code, ClientErrorCode::Ok);

    let link_a = create_link_share_handle_v2("album-link-swap".to_owned(), epoch.handle, 2);
    assert_eq!(link_a.code, ClientErrorCode::Ok);
    let link_b = create_link_share_handle_v2("album-link-swap".to_owned(), epoch.handle, 2);
    assert_eq!(link_b.code, ClientErrorCode::Ok);
    assert_ne!(link_a.link_url_token, link_b.link_url_token);

    // Server hands visitor A the wrap from link B but A's URL fragment derives a different link_id.
    let imported = import_link_tier_handle_v2(
        link_a.link_url_token.clone(),
        link_b.nonce.clone(),
        link_b.encrypted_key.clone(),
        "album-link-swap".to_owned(),
        2,
        epoch_id,
    );
    assert_eq!(
        imported.code,
        ClientErrorCode::AuthenticationFailed.as_u16(),
        "uniffi v2 unwrap MUST reject a wrap minted for a different link_id"
    );

    assert_eq!(client_close_link_share_handle(link_a.handle), 0);
    assert_eq!(client_close_link_share_handle(link_b.handle), 0);
    let _ = client_close_epoch_key_handle(epoch.handle);
    let _ = client_close_account_key_handle(account);
}

#[test]
fn uniffi_import_v2_round_trips_added_v1_tier() {
    // Owner adds a new tier-3 v1 wrap to an existing link.
    // Visitor on v2 read path dual-accepts it.

    let account = open_secret_handle(&ACCOUNT_KEY).expect("account handle should open");
    let epoch_id = 67_u32;
    let epoch = create_epoch_key_handle(account, epoch_id);
    assert_eq!(epoch.code, ClientErrorCode::Ok);

    let created = create_link_share_handle("album-mixed".to_owned(), epoch.handle, 1);
    assert_eq!(created.code, ClientErrorCode::Ok);

    let imported_share = mosaic_client::import_link_share_handle(&created.link_url_token);
    assert_eq!(imported_share.code, ClientErrorCode::Ok);
    let wrapped_v1 = wrap_link_tier_handle(imported_share.handle, epoch.handle, 3);
    assert_eq!(wrapped_v1.code, ClientErrorCode::Ok);

    let imported = import_link_tier_handle_v2(
        created.link_url_token.clone(),
        wrapped_v1.nonce.clone(),
        wrapped_v1.encrypted_key.clone(),
        "album-mixed".to_owned(),
        3,
        epoch_id,
    );
    assert_eq!(imported.code, ClientErrorCode::Ok.as_u16());

    assert_eq!(close_link_tier_handle(imported.link_tier_handle_id), 0);
    assert_eq!(client_close_link_share_handle(imported_share.handle), 0);
    assert_eq!(client_close_link_share_handle(created.handle), 0);
    let _ = client_close_epoch_key_handle(epoch.handle);
    let _ = client_close_account_key_handle(account);
}
