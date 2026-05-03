//! Tests for the bundle-aware epoch handle APIs introduced by Slice 3 of the
//! Rust crypto cutover: `create_epoch_key_handle` populates a per-epoch sign
//! keypair and `seal_bundle_with_epoch_handle` seals a bundle without ever
//! exposing payload bytes to the caller.

use mosaic_client::{
    ClientErrorCode, close_account_key_handle, close_epoch_key_handle, close_identity_handle,
    create_epoch_key_handle, create_identity_handle, open_epoch_key_handle, open_secret_handle,
    seal_bundle_with_epoch_handle, verify_and_import_epoch_bundle_with_identity_handle,
};

const ACCOUNT_KEY: [u8; 32] = [
    0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f,
    0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f,
];

#[test]
fn create_epoch_key_handle_returns_per_epoch_sign_public_key_and_wrapped_seed() {
    let account_handle = open_account();

    let result = create_epoch_key_handle(account_handle, 11);
    assert_eq!(result.code, ClientErrorCode::Ok);
    assert_eq!(result.epoch_id, 11);
    assert_eq!(result.wrapped_epoch_seed.len(), 24 + 32 + 16);
    // 32-byte Ed25519 verifying key, populated for fresh handles so callers
    // can publish it as `signPubkey` without touching secret material.
    assert_eq!(result.sign_public_key.len(), 32);
    assert!(
        result.sign_public_key.iter().any(|byte| *byte != 0),
        "sign_public_key must be a real key, not all zeros"
    );

    close_epoch(result.handle);
    close_account(account_handle);
}

#[test]
fn create_epoch_key_handle_mints_distinct_sign_public_keys_per_handle() {
    // Even with the same epoch id, two freshly minted handles get
    // independent sign keypairs from the OS RNG.
    let account_handle = open_account();
    let first = create_epoch_key_handle(account_handle, 5);
    let second = create_epoch_key_handle(account_handle, 5);

    assert_eq!(first.code, ClientErrorCode::Ok);
    assert_eq!(second.code, ClientErrorCode::Ok);
    assert_ne!(first.sign_public_key, second.sign_public_key);

    close_epoch(first.handle);
    close_epoch(second.handle);
    close_account(account_handle);
}

#[test]
fn seal_bundle_with_epoch_handle_round_trips_through_verify_and_import() {
    // End-to-end: create handle for the sender, seal to a recipient identity,
    // verify+import from the recipient side. The roundtrip never exposes raw
    // bundle bytes anywhere a caller would have to handle them (in fact the
    // seal path takes only the epoch handle).
    let sender_account = open_account();
    let recipient_account = open_account_with(&[0x99; 32]);

    let sender_identity = create_identity_handle(sender_account);
    assert_eq!(sender_identity.code, ClientErrorCode::Ok);
    let recipient_identity = create_identity_handle(recipient_account);
    assert_eq!(recipient_identity.code, ClientErrorCode::Ok);

    let epoch = create_epoch_key_handle(sender_account, 3);
    assert_eq!(epoch.code, ClientErrorCode::Ok);

    let sealed = seal_bundle_with_epoch_handle(
        sender_identity.handle,
        epoch.handle,
        &recipient_identity.signing_pubkey,
        "album-roundtrip".to_string(),
    );
    assert_eq!(sealed.code, ClientErrorCode::Ok);
    assert!(!sealed.sealed.is_empty());
    assert_eq!(sealed.signature.len(), 64);
    assert_eq!(sealed.sharer_pubkey.len(), 32);

    let imported = verify_and_import_epoch_bundle_with_identity_handle(
        recipient_identity.handle,
        &sealed.sealed,
        &sealed.signature,
        &sealed.sharer_pubkey,
        "album-roundtrip".to_string(),
        0,
        false,
    );
    assert_eq!(imported.code, ClientErrorCode::Ok);
    assert_eq!(imported.epoch_id, 3);
    assert_eq!(imported.sign_public_key, epoch.sign_public_key);
    assert_eq!(imported.wrapped_epoch_seed.len(), 24 + 32 + 16);

    // Sealing through the imported handle on the recipient side reproduces a
    // signature that the recipient (acting as the next sharer) can themselves
    // verify-and-import, proving the per-epoch sign keypair survived the
    // import without re-randomisation.
    let third_account = open_account_with(&[0xaa; 32]);
    let third_identity = create_identity_handle(third_account);
    let resealed = seal_bundle_with_epoch_handle(
        recipient_identity.handle,
        imported.handle,
        &third_identity.signing_pubkey,
        "album-roundtrip".to_string(),
    );
    assert_eq!(resealed.code, ClientErrorCode::Ok);
    let reopened = verify_and_import_epoch_bundle_with_identity_handle(
        third_identity.handle,
        &resealed.sealed,
        &resealed.signature,
        &resealed.sharer_pubkey,
        "album-roundtrip".to_string(),
        0,
        false,
    );
    assert_eq!(reopened.code, ClientErrorCode::Ok);
    assert_eq!(reopened.sign_public_key, epoch.sign_public_key);

    close_identity(sender_identity.handle);
    close_identity(recipient_identity.handle);
    close_identity(third_identity.handle);
    close_epoch(epoch.handle);
    close_epoch(imported.handle);
    close_epoch(reopened.handle);
    close_account(sender_account);
    close_account(recipient_account);
    close_account(third_account);
}

#[test]
fn seal_bundle_with_epoch_handle_rejects_legacy_open_handle_without_sign_keypair() {
    // open_epoch_key_handle does not attach a sign keypair; sealing through
    // such a handle must return EpochHandleNotFound to force callers onto the
    // bundle-import path.

    let account_handle = open_account();
    let identity = create_identity_handle(account_handle);
    assert_eq!(identity.code, ClientErrorCode::Ok);

    let create_result = create_epoch_key_handle(account_handle, 17);
    assert_eq!(create_result.code, ClientErrorCode::Ok);
    let wrapped_seed = create_result.wrapped_epoch_seed.clone();

    let reopened = open_epoch_key_handle(&wrapped_seed, account_handle, 17);
    assert_eq!(reopened.code, ClientErrorCode::Ok);
    // Legacy reopen MUST report an empty sign_public_key — bundle ops will
    // refuse to operate on this handle.
    assert!(reopened.sign_public_key.is_empty());

    let sealed = seal_bundle_with_epoch_handle(
        identity.handle,
        reopened.handle,
        &identity.signing_pubkey,
        "album-legacy-reopen".to_string(),
    );
    assert_eq!(sealed.code, ClientErrorCode::EpochHandleNotFound);
    assert!(sealed.sealed.is_empty());
    assert!(sealed.signature.is_empty());

    close_epoch(create_result.handle);
    close_epoch(reopened.handle);
    close_identity(identity.handle);
    close_account(account_handle);
}

fn open_account() -> u64 {
    open_account_with(&ACCOUNT_KEY)
}

fn open_account_with(key: &[u8; 32]) -> u64 {
    match open_secret_handle(key) {
        Ok(handle) => handle,
        Err(error) => panic!("account key handle should open: {error:?}"),
    }
}

fn close_account(handle: u64) {
    if let Err(error) = close_account_key_handle(handle) {
        panic!("account handle should close: {error:?}");
    }
}

fn close_identity(handle: u64) {
    if let Err(error) = close_identity_handle(handle) {
        panic!("identity handle should close: {error:?}");
    }
}

fn close_epoch(handle: u64) {
    if let Err(error) = close_epoch_key_handle(handle) {
        panic!("epoch handle should close: {error:?}");
    }
}
