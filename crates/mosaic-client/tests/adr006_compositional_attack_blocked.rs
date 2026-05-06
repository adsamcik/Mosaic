#![allow(clippy::expect_used)]

use mosaic_client::{
    ClientErrorCode, close_account_key_handle, close_epoch_key_handle, close_identity_handle,
    create_epoch_key_handle, create_identity_handle, derive_link_keys, open_secret_handle,
    unwrap_with_account_handle, wrap_tier_key_for_link_handle, wrap_with_account_handle,
};

const ACCOUNT_KEY: [u8; 32] = [
    0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f,
    0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f,
];

fn open_account_handle() -> u64 {
    open_secret_handle(&ACCOUNT_KEY).expect("account key handle should open")
}

#[test]
fn adr006_unwrap_with_account_cannot_recover_epoch_seed() {
    let account_handle = open_account_handle();
    let epoch = create_epoch_key_handle(account_handle, 7);
    assert_eq!(epoch.code, ClientErrorCode::Ok);

    let attempt = unwrap_with_account_handle(account_handle, &epoch.wrapped_epoch_seed);
    assert_eq!(
        attempt.code,
        ClientErrorCode::AuthenticationFailed,
        "ADR-006 violation: unwrap_with_account_handle must NOT decrypt epoch seeds"
    );
    assert!(
        attempt.bytes.is_empty(),
        "no key material may leak in error path"
    );

    close_epoch_key_handle(epoch.handle).expect("epoch handle should close");
    close_account_key_handle(account_handle).expect("account handle should close");
}

#[test]
fn adr006_unwrap_with_account_cannot_recover_identity_seed() {
    let account_handle = open_account_handle();
    let identity = create_identity_handle(account_handle);
    assert_eq!(identity.code, ClientErrorCode::Ok);

    let attempt = unwrap_with_account_handle(account_handle, &identity.wrapped_seed);
    assert_eq!(
        attempt.code,
        ClientErrorCode::AuthenticationFailed,
        "ADR-006 violation: unwrap_with_account_handle must NOT decrypt identity seeds"
    );
    assert!(
        attempt.bytes.is_empty(),
        "no key material may leak in error path"
    );

    close_identity_handle(identity.handle).expect("identity handle should close");
    close_account_key_handle(account_handle).expect("account handle should close");
}

#[test]
fn account_data_wrap_unwrap_round_trip() {
    let account_handle = open_account_handle();
    let plaintext = b"legitimate OPFS account-scoped envelope";

    let wrapped = wrap_with_account_handle(account_handle, plaintext);
    assert_eq!(wrapped.code, ClientErrorCode::Ok);
    assert!(!wrapped.bytes.is_empty());

    let unwrapped = unwrap_with_account_handle(account_handle, &wrapped.bytes);
    assert_eq!(unwrapped.code, ClientErrorCode::Ok);
    assert_eq!(unwrapped.bytes, plaintext);

    close_account_key_handle(account_handle).expect("account handle should close");
}

#[test]
fn adr006_link_handle_cannot_be_used_as_account_handle() {
    let account_handle = open_account_handle();
    let wrapped_account_data = wrap_with_account_handle(account_handle, b"account scoped data");
    assert_eq!(wrapped_account_data.code, ClientErrorCode::Ok);

    let link = derive_link_keys(&[0x42; 32]);
    assert_eq!(link.code, ClientErrorCode::Ok);
    assert_ne!(link.link_handle_id, 0);

    let attempt = unwrap_with_account_handle(link.link_handle_id, &wrapped_account_data.bytes);
    assert_eq!(
        attempt.code,
        ClientErrorCode::AuthenticationFailed,
        "ADR-006 violation: link wrapping handles must not decrypt account-data blobs"
    );
    assert!(
        attempt.bytes.is_empty(),
        "no key material may leak in error path"
    );

    mosaic_client::close_secret_handle(link.link_handle_id).expect("link handle should close");
    close_account_key_handle(account_handle).expect("account handle should close");
}

#[test]
fn adr006_link_wrapped_tier_key_cannot_be_unwrapped_as_account_data() {
    let account_handle = open_account_handle();
    let tier_key_handle =
        open_secret_handle(&[0x24; 32]).expect("tier key handle should open for attack test");
    let link = derive_link_keys(&[0x43; 32]);
    assert_eq!(link.code, ClientErrorCode::Ok);

    let wrapped = wrap_tier_key_for_link_handle(link.link_handle_id, tier_key_handle, 1);
    assert_eq!(wrapped.code, ClientErrorCode::Ok);
    let mut link_wrapped_blob = wrapped.nonce;
    link_wrapped_blob.extend_from_slice(&wrapped.encrypted_key);

    let attempt = unwrap_with_account_handle(account_handle, &link_wrapped_blob);
    assert_eq!(
        attempt.code,
        ClientErrorCode::AuthenticationFailed,
        "ADR-006 violation: ACCOUNT_DATA_AAD unwrap must reject link-tier ciphertext"
    );
    assert!(
        attempt.bytes.is_empty(),
        "no key material may leak in error path"
    );

    mosaic_client::close_secret_handle(tier_key_handle).expect("tier key handle should close");
    mosaic_client::close_secret_handle(link.link_handle_id).expect("link handle should close");
    close_account_key_handle(account_handle).expect("account handle should close");
}
