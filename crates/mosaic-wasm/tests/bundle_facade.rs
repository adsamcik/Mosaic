//! WASM facade tests for sealed bundle exports (`sealBundleWithEpochHandle` /
//! `verifyAndImportEpochBundle`).
//!
//! Exercises round-trip sealing + opening, signature tampering, recipient
//! mismatch, and album/epoch validation through the facade entry points.

use mosaic_client::ClientErrorCode;
use mosaic_crypto::{KdfProfile, MIN_KDF_ITERATIONS, MIN_KDF_MEMORY_KIB, derive_account_key};
use mosaic_wasm::{
    AccountUnlockRequest, close_account_key_handle, close_epoch_key_handle, close_identity_handle,
    create_epoch_key_handle, create_identity_handle, decrypt_shard_with_epoch_handle,
    encrypt_shard_with_epoch_handle, seal_bundle_with_epoch_handle, unlock_account_key,
    verify_and_import_epoch_bundle,
};

const PASSWORD: &[u8] = b"correct horse battery staple";
const USER_SALT: [u8; 16] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
];
const ACCOUNT_SALT_OWNER: [u8; 16] = [
    0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff,
];
const ACCOUNT_SALT_RECIPIENT: [u8; 16] = [
    0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
];

const ALBUM_ID: &str = "album-bundle-facade";
const EPOCH_ID: u32 = 9;
const MIN_EPOCH_ID: u32 = 5;
fn unlock_request(account_salt: [u8; 16], wrapped_account_key: Vec<u8>) -> AccountUnlockRequest {
    AccountUnlockRequest {
        user_salt: USER_SALT.to_vec(),
        account_salt: account_salt.to_vec(),
        wrapped_account_key,
        kdf_memory_kib: MIN_KDF_MEMORY_KIB,
        kdf_iterations: MIN_KDF_ITERATIONS,
        kdf_parallelism: 1,
    }
}

fn wrapped_account_key(account_salt: [u8; 16]) -> Vec<u8> {
    let profile = match KdfProfile::new(MIN_KDF_MEMORY_KIB, MIN_KDF_ITERATIONS, 1) {
        Ok(value) => value,
        Err(error) => panic!("minimum Mosaic profile should be valid: {error:?}"),
    };
    let material =
        match derive_account_key(PASSWORD.to_vec().into(), &USER_SALT, &account_salt, profile) {
            Ok(value) => value,
            Err(error) => panic!("account key should derive: {error:?}"),
        };
    material.wrapped_account_key
}

fn unlock_owner_and_create_identity() -> (u64, u64, Vec<u8>) {
    let unlock = unlock_account_key(
        PASSWORD.to_vec(),
        unlock_request(ACCOUNT_SALT_OWNER, wrapped_account_key(ACCOUNT_SALT_OWNER)),
    );
    assert_eq!(unlock.code, 0);
    let identity = create_identity_handle(unlock.handle);
    assert_eq!(identity.code, 0);
    (unlock.handle, identity.handle, identity.signing_pubkey)
}

fn unlock_recipient_and_create_identity() -> (u64, u64, Vec<u8>) {
    let unlock = unlock_account_key(
        PASSWORD.to_vec(),
        unlock_request(
            ACCOUNT_SALT_RECIPIENT,
            wrapped_account_key(ACCOUNT_SALT_RECIPIENT),
        ),
    );
    assert_eq!(unlock.code, 0);
    let identity = create_identity_handle(unlock.handle);
    assert_eq!(identity.code, 0);
    (unlock.handle, identity.handle, identity.signing_pubkey)
}

#[test]
fn seal_and_open_round_trips_through_facade() {
    let (owner_account, owner_identity, owner_pubkey) = unlock_owner_and_create_identity();
    let (recipient_account, recipient_identity, recipient_pubkey) =
        unlock_recipient_and_create_identity();

    let epoch = create_epoch_key_handle(owner_account, EPOCH_ID);
    assert_eq!(epoch.code, 0);
    let sealed = seal_bundle_with_epoch_handle(
        owner_identity,
        epoch.handle,
        recipient_pubkey.clone(),
        ALBUM_ID.to_owned(),
    );
    assert_eq!(sealed.code, 0);
    assert!(!sealed.sealed.is_empty());
    assert_eq!(sealed.signature.len(), 64);
    assert_eq!(sealed.sharer_pubkey, owner_pubkey);

    let imported = verify_and_import_epoch_bundle(
        recipient_identity,
        sealed.sealed.clone(),
        sealed.signature.clone(),
        sealed.sharer_pubkey.clone(),
        ALBUM_ID.to_owned(),
        MIN_EPOCH_ID,
        false,
    );
    assert_eq!(imported.code, 0);
    assert_eq!(imported.epoch_id, EPOCH_ID);
    assert_eq!(imported.sign_public_key, epoch.sign_public_key);
    assert!(!imported.wrapped_epoch_seed.is_empty());

    let encrypted = encrypt_shard_with_epoch_handle(
        imported.handle,
        b"verify/import handle round trip".to_vec(),
        1,
        3,
    );
    assert_eq!(encrypted.code, 0);
    let decrypted = decrypt_shard_with_epoch_handle(imported.handle, encrypted.envelope_bytes);
    assert_eq!(decrypted.code, 0);
    assert_eq!(decrypted.plaintext, b"verify/import handle round trip");

    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_epoch_key_handle(imported.handle), 0);
    assert_eq!(close_identity_handle(owner_identity), 0);
    assert_eq!(close_identity_handle(recipient_identity), 0);
    assert_eq!(close_account_key_handle(owner_account), 0);
    assert_eq!(close_account_key_handle(recipient_account), 0);
}

#[test]
fn verify_and_open_rejects_tampered_signature() {
    let (owner_account, owner_identity, _owner_pubkey) = unlock_owner_and_create_identity();
    let (recipient_account, recipient_identity, recipient_pubkey) =
        unlock_recipient_and_create_identity();

    let epoch = create_epoch_key_handle(owner_account, EPOCH_ID);
    assert_eq!(epoch.code, 0);
    let sealed = seal_bundle_with_epoch_handle(
        owner_identity,
        epoch.handle,
        recipient_pubkey,
        ALBUM_ID.to_owned(),
    );
    assert_eq!(sealed.code, 0);

    let mut tampered_signature = sealed.signature.clone();
    tampered_signature[0] ^= 0x01;

    let opened = verify_and_import_epoch_bundle(
        recipient_identity,
        sealed.sealed.clone(),
        tampered_signature,
        sealed.sharer_pubkey.clone(),
        ALBUM_ID.to_owned(),
        MIN_EPOCH_ID,
        false,
    );
    assert_eq!(
        opened.code,
        ClientErrorCode::BundleSignatureInvalid.as_u16()
    );
    assert_eq!(opened.handle, 0);
    assert!(opened.wrapped_epoch_seed.is_empty());
    assert!(opened.sign_public_key.is_empty());

    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_identity_handle(owner_identity), 0);
    assert_eq!(close_identity_handle(recipient_identity), 0);
    assert_eq!(close_account_key_handle(owner_account), 0);
    assert_eq!(close_account_key_handle(recipient_account), 0);
}

#[test]
fn verify_and_open_rejects_album_id_mismatch() {
    let (owner_account, owner_identity, _owner_pubkey) = unlock_owner_and_create_identity();
    let (recipient_account, recipient_identity, recipient_pubkey) =
        unlock_recipient_and_create_identity();

    let epoch = create_epoch_key_handle(owner_account, EPOCH_ID);
    assert_eq!(epoch.code, 0);
    let sealed = seal_bundle_with_epoch_handle(
        owner_identity,
        epoch.handle,
        recipient_pubkey,
        ALBUM_ID.to_owned(),
    );
    assert_eq!(sealed.code, 0);

    let opened = verify_and_import_epoch_bundle(
        recipient_identity,
        sealed.sealed,
        sealed.signature,
        sealed.sharer_pubkey,
        "different-album".to_owned(),
        MIN_EPOCH_ID,
        false,
    );
    assert_eq!(opened.code, ClientErrorCode::BundleAlbumIdMismatch.as_u16());

    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_identity_handle(owner_identity), 0);
    assert_eq!(close_identity_handle(recipient_identity), 0);
    assert_eq!(close_account_key_handle(owner_account), 0);
    assert_eq!(close_account_key_handle(recipient_account), 0);
}

#[test]
fn verify_and_open_rejects_old_epoch() {
    let (owner_account, owner_identity, _owner_pubkey) = unlock_owner_and_create_identity();
    let (recipient_account, recipient_identity, recipient_pubkey) =
        unlock_recipient_and_create_identity();

    let epoch = create_epoch_key_handle(owner_account, EPOCH_ID);
    assert_eq!(epoch.code, 0);
    let sealed = seal_bundle_with_epoch_handle(
        owner_identity,
        epoch.handle,
        recipient_pubkey,
        ALBUM_ID.to_owned(),
    );
    assert_eq!(sealed.code, 0);

    let opened = verify_and_import_epoch_bundle(
        recipient_identity,
        sealed.sealed,
        sealed.signature,
        sealed.sharer_pubkey,
        ALBUM_ID.to_owned(),
        EPOCH_ID + 1,
        false,
    );
    assert_eq!(opened.code, ClientErrorCode::BundleEpochTooOld.as_u16());

    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_identity_handle(owner_identity), 0);
    assert_eq!(close_identity_handle(recipient_identity), 0);
    assert_eq!(close_account_key_handle(owner_account), 0);
    assert_eq!(close_account_key_handle(recipient_account), 0);
}

#[test]
fn seal_bundle_with_epoch_handle_rejects_invalid_handles_and_lengths() {
    let result = seal_bundle_with_epoch_handle(0, 0, vec![0_u8; 32], ALBUM_ID.to_owned());
    assert_eq!(result.code, ClientErrorCode::EpochHandleNotFound.as_u16());

    let (owner_account, owner_identity, _owner_pubkey) = unlock_owner_and_create_identity();
    let (recipient_account, recipient_identity, recipient_pubkey) =
        unlock_recipient_and_create_identity();
    let epoch = create_epoch_key_handle(owner_account, EPOCH_ID);
    assert_eq!(epoch.code, 0);

    let bad_recipient = seal_bundle_with_epoch_handle(
        owner_identity,
        epoch.handle,
        vec![0_u8; 31],
        ALBUM_ID.to_owned(),
    );
    assert_eq!(
        bad_recipient.code,
        ClientErrorCode::InvalidKeyLength.as_u16()
    );

    let bad_epoch =
        seal_bundle_with_epoch_handle(owner_identity, 0, recipient_pubkey, ALBUM_ID.to_owned());
    assert_eq!(
        bad_epoch.code,
        ClientErrorCode::EpochHandleNotFound.as_u16()
    );

    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_identity_handle(owner_identity), 0);
    assert_eq!(close_identity_handle(recipient_identity), 0);
    assert_eq!(close_account_key_handle(owner_account), 0);
    assert_eq!(close_account_key_handle(recipient_account), 0);
}

#[test]
fn verify_and_import_rejects_invalid_signature_length() {
    let (owner_account, owner_identity, _owner_pubkey) = unlock_owner_and_create_identity();

    let opened = verify_and_import_epoch_bundle(
        owner_identity,
        vec![0_u8; 16],
        vec![0_u8; 63],
        vec![0_u8; 32],
        ALBUM_ID.to_owned(),
        MIN_EPOCH_ID,
        false,
    );
    assert_eq!(
        opened.code,
        ClientErrorCode::InvalidSignatureLength.as_u16()
    );

    let opened_bad_pubkey = verify_and_import_epoch_bundle(
        owner_identity,
        vec![0_u8; 16],
        vec![0_u8; 64],
        vec![0_u8; 31],
        ALBUM_ID.to_owned(),
        MIN_EPOCH_ID,
        false,
    );
    assert_eq!(
        opened_bad_pubkey.code,
        ClientErrorCode::InvalidKeyLength.as_u16()
    );

    assert_eq!(close_identity_handle(owner_identity), 0);
    assert_eq!(close_account_key_handle(owner_account), 0);
}

// ---------------------------------------------------------------------------
// Slice 3/4 — `sealBundleWithEpochHandle` facade export. This surfaces the
// bundle round-trip without exposing payload bytes to the caller.
// ---------------------------------------------------------------------------

#[test]
fn create_epoch_key_handle_facade_returns_sign_public_key() {
    let (owner_account, owner_identity, _owner_pubkey) = unlock_owner_and_create_identity();

    let result = create_epoch_key_handle(owner_account, EPOCH_ID);
    assert_eq!(result.code, 0);
    assert_eq!(result.epoch_id, EPOCH_ID);
    // Fresh handles always populate the per-epoch sign public key.
    assert_eq!(result.sign_public_key.len(), 32);
    assert!(result.sign_public_key.iter().any(|byte| *byte != 0));

    assert_eq!(close_epoch_key_handle(result.handle), 0);
    assert_eq!(close_identity_handle(owner_identity), 0);
    assert_eq!(close_account_key_handle(owner_account), 0);
}

#[test]
fn seal_bundle_with_epoch_handle_facade_round_trips_through_import() {
    let (owner_account, owner_identity, _owner_pubkey) = unlock_owner_and_create_identity();
    let (recipient_account, recipient_identity, recipient_pubkey) =
        unlock_recipient_and_create_identity();

    let epoch = create_epoch_key_handle(owner_account, EPOCH_ID);
    assert_eq!(epoch.code, 0);

    let sealed = seal_bundle_with_epoch_handle(
        owner_identity,
        epoch.handle,
        recipient_pubkey.clone(),
        ALBUM_ID.to_owned(),
    );
    assert_eq!(sealed.code, 0);
    assert!(!sealed.sealed.is_empty());
    assert_eq!(sealed.signature.len(), 64);

    let imported = verify_and_import_epoch_bundle(
        recipient_identity,
        sealed.sealed,
        sealed.signature,
        sealed.sharer_pubkey,
        ALBUM_ID.to_owned(),
        0,
        false,
    );
    assert_eq!(imported.code, 0);
    assert_eq!(imported.epoch_id, EPOCH_ID);
    // The imported handle on the recipient side carries the same per-epoch
    // sign public key as the originator's handle.
    assert_eq!(imported.sign_public_key, epoch.sign_public_key);
    assert!(!imported.wrapped_epoch_seed.is_empty());

    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_epoch_key_handle(imported.handle), 0);
    assert_eq!(close_identity_handle(owner_identity), 0);
    assert_eq!(close_identity_handle(recipient_identity), 0);
    assert_eq!(close_account_key_handle(owner_account), 0);
    assert_eq!(close_account_key_handle(recipient_account), 0);
}
