#![allow(clippy::expect_used)]

use mosaic_client::{
    ClientErrorCode, close_account_key_handle, close_epoch_key_handle, close_identity_handle,
    create_epoch_key_handle, create_identity_handle, open_secret_handle,
    unwrap_with_account_handle, wrap_with_account_handle,
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
