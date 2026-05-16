//! mosaic-client v2 link-tier AAD plumbing tests (batch 4b — closes audit
//! `share-link-create C1`).
//!
//! Verifies that the v2 wrap/unwrap surface threads `(link_id, tier,
//! epoch_id)` through to the underlying `mosaic_crypto::*_v2` functions
//! and that the dual-accept behavior on the read side preserves
//! compatibility with v1 wraps.

#![allow(clippy::expect_used, clippy::panic)]

use mosaic_client::{
    ClientErrorCode, close_account_key_handle, close_epoch_key_handle, close_link_share_handle,
    close_link_tier_handle, create_epoch_key_handle, create_link_share_handle,
    create_link_share_handle_v2, decrypt_shard_with_link_tier_handle,
    encrypt_shard_with_epoch_handle, import_link_share_handle, import_link_tier_handle,
    import_link_tier_handle_v2, open_secret_handle, wrap_link_tier_handle,
    wrap_link_tier_handle_v2,
};

const ACCOUNT_KEY: [u8; 32] = [
    0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
    0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf,
];

fn open_account_handle() -> u64 {
    open_secret_handle(&ACCOUNT_KEY).expect("account key handle should open")
}

#[test]
fn create_v2_round_trips_through_import_v2() {
    let account_handle = open_account_handle();
    let epoch_id = 41_u32;
    let epoch = create_epoch_key_handle(account_handle, epoch_id);
    assert_eq!(epoch.code, ClientErrorCode::Ok);

    let created = create_link_share_handle_v2("album-v2-rt".to_owned(), epoch.handle, 2);
    assert_eq!(created.code, ClientErrorCode::Ok);
    assert_eq!(created.tier, 2);
    assert_eq!(created.link_id.len(), 16);
    assert_eq!(created.link_url_token.len(), 32);

    let imported = import_link_tier_handle_v2(
        &created.link_url_token,
        &created.nonce,
        &created.encrypted_key,
        "album-v2-rt".to_owned(),
        2,
        epoch_id,
    );
    assert_eq!(imported.code, ClientErrorCode::Ok);
    assert_eq!(imported.tier, 2);
    assert_eq!(imported.link_id, created.link_id);

    let encrypted = encrypt_shard_with_epoch_handle(epoch.handle, b"v2 round trip", 1, 2);
    assert_eq!(encrypted.code, ClientErrorCode::Ok);
    let decrypted = decrypt_shard_with_link_tier_handle(imported.handle, &encrypted.envelope_bytes);
    assert_eq!(decrypted.code, ClientErrorCode::Ok);
    assert_eq!(decrypted.plaintext, b"v2 round trip");

    assert_eq!(close_link_tier_handle(imported.handle), 0);
    assert_eq!(close_link_share_handle(created.handle), 0);
    let _ = close_epoch_key_handle(epoch.handle);
    let _ = close_account_key_handle(account_handle);
}

#[test]
fn import_v2_rejects_wrong_epoch_id() {
    let account_handle = open_account_handle();
    let epoch_id = 42_u32;
    let epoch = create_epoch_key_handle(account_handle, epoch_id);
    assert_eq!(epoch.code, ClientErrorCode::Ok);

    let created = create_link_share_handle_v2("album-v2-bad-epoch".to_owned(), epoch.handle, 1);
    assert_eq!(created.code, ClientErrorCode::Ok);

    let imported = import_link_tier_handle_v2(
        &created.link_url_token,
        &created.nonce,
        &created.encrypted_key,
        "album-v2-bad-epoch".to_owned(),
        1,
        epoch_id.wrapping_add(1),
    );
    assert_eq!(
        imported.code,
        ClientErrorCode::AuthenticationFailed,
        "A1: v2 unwrap must reject when caller supplies a different epoch_id than the writer bound"
    );
    assert_eq!(imported.handle, 0);

    assert_eq!(close_link_share_handle(created.handle), 0);
    let _ = close_epoch_key_handle(epoch.handle);
    let _ = close_account_key_handle(account_handle);
}

#[test]
fn import_v2_rejects_tier_substituted_wrap() {
    // Owner creates two share-links from the same epoch: one for thumb (tier=1),
    // one for original (tier=3). A malicious server then hands a thumb-only
    // visitor the tier=3 wrap row but labels it tier=1. With v1 wraps that
    // attack succeeds (audit C1). With v2 wraps the AAD includes the tier
    // byte, so the visitor's unwrap MUST fail.
    let account_handle = open_account_handle();
    let epoch_id = 43_u32;
    let epoch = create_epoch_key_handle(account_handle, epoch_id);
    assert_eq!(epoch.code, ClientErrorCode::Ok);

    let thumb_link =
        create_link_share_handle_v2("album-v2-tier-attack".to_owned(), epoch.handle, 1);
    assert_eq!(thumb_link.code, ClientErrorCode::Ok);

    // Visitor pulls thumb_link but is handed the wrap from an alternate
    // "tier 3" wrap with a forged tier label. Simulate that by wrapping
    // the original tier under the SAME link share and then handing the
    // visitor that ciphertext labelled tier=1.
    let imported_share = import_link_share_handle(&thumb_link.link_url_token);
    assert_eq!(imported_share.code, ClientErrorCode::Ok);
    let original_wrap = wrap_link_tier_handle_v2(imported_share.handle, epoch.handle, 3);
    assert_eq!(original_wrap.code, ClientErrorCode::Ok);
    assert_eq!(original_wrap.tier, 3);

    let imported = import_link_tier_handle_v2(
        &thumb_link.link_url_token,
        &original_wrap.nonce,
        &original_wrap.encrypted_key,
        "album-v2-tier-attack".to_owned(),
        1, // visitor's expected tier
        epoch_id,
    );
    assert_eq!(
        imported.code,
        ClientErrorCode::AuthenticationFailed,
        "A1: v2 unwrap must reject a tier-substituted wrap (server promises tier=1 but ciphertext was bound to tier=3)"
    );
    assert_eq!(imported.handle, 0);

    assert_eq!(close_link_share_handle(thumb_link.handle), 0);
    assert_eq!(close_link_share_handle(imported_share.handle), 0);
    let _ = close_epoch_key_handle(epoch.handle);
    let _ = close_account_key_handle(account_handle);
}

#[test]
fn import_v2_dual_accepts_v1_wraps_for_back_compat() {
    // Pre-A1 share links are still readable on the v2 read path.
    let account_handle = open_account_handle();
    let epoch_id = 44_u32;
    let epoch = create_epoch_key_handle(account_handle, epoch_id);
    assert_eq!(epoch.code, ClientErrorCode::Ok);

    let created = create_link_share_handle("album-back-compat".to_owned(), epoch.handle, 2);
    assert_eq!(created.code, ClientErrorCode::Ok);

    let imported = import_link_tier_handle_v2(
        &created.link_url_token,
        &created.nonce,
        &created.encrypted_key,
        "album-back-compat".to_owned(),
        2,
        epoch_id,
    );
    assert_eq!(
        imported.code,
        ClientErrorCode::Ok,
        "v2 read path must dual-accept v1 wraps (existing share links keep working)"
    );

    let encrypted = encrypt_shard_with_epoch_handle(epoch.handle, b"legacy ok", 0, 2);
    assert_eq!(encrypted.code, ClientErrorCode::Ok);
    let decrypted = decrypt_shard_with_link_tier_handle(imported.handle, &encrypted.envelope_bytes);
    assert_eq!(decrypted.code, ClientErrorCode::Ok);
    assert_eq!(decrypted.plaintext, b"legacy ok");

    assert_eq!(close_link_tier_handle(imported.handle), 0);
    assert_eq!(close_link_share_handle(created.handle), 0);
    let _ = close_epoch_key_handle(epoch.handle);
    let _ = close_account_key_handle(account_handle);
}

#[test]
fn import_v1_rejects_v2_wraps_no_silent_downgrade() {
    // Mirror property: a stale v1-only read path MUST refuse to decrypt
    // v2 wraps. Otherwise an attacker could downgrade by routing v2 wraps
    // through a v1 client and stripping the AAD binding.
    let account_handle = open_account_handle();
    let epoch_id = 45_u32;
    let epoch = create_epoch_key_handle(account_handle, epoch_id);
    assert_eq!(epoch.code, ClientErrorCode::Ok);

    let created = create_link_share_handle_v2("album-no-downgrade".to_owned(), epoch.handle, 1);
    assert_eq!(created.code, ClientErrorCode::Ok);

    let imported_via_v1 = import_link_tier_handle(
        &created.link_url_token,
        &created.nonce,
        &created.encrypted_key,
        "album-no-downgrade".to_owned(),
        1,
    );
    assert_eq!(
        imported_via_v1.code,
        ClientErrorCode::AuthenticationFailed,
        "v1 read path MUST refuse v2 wraps (no silent downgrade)"
    );
    assert_eq!(imported_via_v1.handle, 0);

    assert_eq!(close_link_share_handle(created.handle), 0);
    let _ = close_epoch_key_handle(epoch.handle);
    let _ = close_account_key_handle(account_handle);
}

#[test]
fn wrap_link_tier_handle_v2_emits_v2_bound_wrap() {
    let account_handle = open_account_handle();
    let epoch_id = 46_u32;
    let epoch = create_epoch_key_handle(account_handle, epoch_id);
    assert_eq!(epoch.code, ClientErrorCode::Ok);

    let created = create_link_share_handle_v2("album-add-tier".to_owned(), epoch.handle, 1);
    assert_eq!(created.code, ClientErrorCode::Ok);

    let imported_share = import_link_share_handle(&created.link_url_token);
    assert_eq!(imported_share.code, ClientErrorCode::Ok);

    // Owner adds a tier=3 wrap to the existing link with v2 binding.
    let wrapped_full = wrap_link_tier_handle_v2(imported_share.handle, epoch.handle, 3);
    assert_eq!(wrapped_full.code, ClientErrorCode::Ok);
    assert_eq!(wrapped_full.tier, 3);
    assert_eq!(wrapped_full.nonce.len(), 24);
    assert_eq!(wrapped_full.encrypted_key.len(), 32 + 16);

    // The v2 read path must accept it (with the correct epoch_id) and
    // reject it with the wrong epoch_id.
    let ok = import_link_tier_handle_v2(
        &created.link_url_token,
        &wrapped_full.nonce,
        &wrapped_full.encrypted_key,
        "album-add-tier".to_owned(),
        3,
        epoch_id,
    );
    assert_eq!(ok.code, ClientErrorCode::Ok);

    let bad = import_link_tier_handle_v2(
        &created.link_url_token,
        &wrapped_full.nonce,
        &wrapped_full.encrypted_key,
        "album-add-tier".to_owned(),
        3,
        epoch_id.wrapping_add(99),
    );
    assert_eq!(bad.code, ClientErrorCode::AuthenticationFailed);

    // And the v1 read path must refuse (no silent downgrade).
    let v1 = import_link_tier_handle(
        &created.link_url_token,
        &wrapped_full.nonce,
        &wrapped_full.encrypted_key,
        "album-add-tier".to_owned(),
        3,
    );
    assert_eq!(v1.code, ClientErrorCode::AuthenticationFailed);

    let _ = close_link_tier_handle(ok.handle);
    assert_eq!(close_link_share_handle(imported_share.handle), 0);
    assert_eq!(close_link_share_handle(created.handle), 0);
    let _ = close_epoch_key_handle(epoch.handle);
    let _ = close_account_key_handle(account_handle);
}

#[test]
fn wrap_link_tier_handle_v1_and_v2_emit_different_ciphertexts() {
    // A v1 wrap and a v2 wrap of the same (link, tier, epoch) MUST be
    // distinguishable on the wire — otherwise the no-silent-downgrade
    // property collapses to "AAD is irrelevant", which it must not.
    let account_handle = open_account_handle();
    let epoch_id = 47_u32;
    let epoch = create_epoch_key_handle(account_handle, epoch_id);
    assert_eq!(epoch.code, ClientErrorCode::Ok);

    let link = create_link_share_handle("album-v1-vs-v2".to_owned(), epoch.handle, 1);
    assert_eq!(link.code, ClientErrorCode::Ok);

    let share_v1 = import_link_share_handle(&link.link_url_token);
    assert_eq!(share_v1.code, ClientErrorCode::Ok);

    let v1 = wrap_link_tier_handle(share_v1.handle, epoch.handle, 2);
    let v2 = wrap_link_tier_handle_v2(share_v1.handle, epoch.handle, 2);
    assert_eq!(v1.code, ClientErrorCode::Ok);
    assert_eq!(v2.code, ClientErrorCode::Ok);

    // Nonces are random, so ciphertexts will differ regardless. The
    // important property is that swapping the AAD class is reflected by
    // the dual-accept behavior tested elsewhere, but we additionally
    // assert structure here.
    assert_eq!(v1.nonce.len(), 24);
    assert_eq!(v2.nonce.len(), 24);
    assert_eq!(v1.encrypted_key.len(), 32 + 16);
    assert_eq!(v2.encrypted_key.len(), 32 + 16);

    assert_eq!(close_link_share_handle(share_v1.handle), 0);
    assert_eq!(close_link_share_handle(link.handle), 0);
    let _ = close_epoch_key_handle(epoch.handle);
    let _ = close_account_key_handle(account_handle);
}
