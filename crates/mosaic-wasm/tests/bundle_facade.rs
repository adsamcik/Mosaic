//! WASM facade tests for sealed bundle exports (`sealAndSignBundle` /
//! `verifyAndOpenBundle`).
//!
//! Exercises round-trip sealing + opening, signature tampering, recipient
//! mismatch, and album/epoch validation through the facade entry points.

use mosaic_client::ClientErrorCode;
use mosaic_crypto::{KdfProfile, derive_account_key};
use mosaic_wasm::{
    AccountUnlockRequest, close_account_key_handle, close_identity_handle, create_identity_handle,
    seal_and_sign_bundle, unlock_account_key, verify_and_open_bundle,
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
const EPOCH_SEED: [u8; 32] = [
    0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf, 0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9,
    0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
];
const SIGN_SECRET_SEED: [u8; 32] = [
    0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
    0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x30,
];

fn unlock_request(account_salt: [u8; 16], wrapped_account_key: Vec<u8>) -> AccountUnlockRequest {
    AccountUnlockRequest {
        user_salt: USER_SALT.to_vec(),
        account_salt: account_salt.to_vec(),
        wrapped_account_key,
        kdf_memory_kib: 64 * 1024,
        kdf_iterations: 3,
        kdf_parallelism: 1,
    }
}

fn wrapped_account_key(account_salt: [u8; 16]) -> Vec<u8> {
    let profile = match KdfProfile::new(64 * 1024, 3, 1) {
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

fn sign_public_for_seed() -> [u8; 32] {
    use mosaic_crypto::ManifestSigningSecretKey;
    let mut seed = SIGN_SECRET_SEED;
    let secret = match ManifestSigningSecretKey::from_seed(&mut seed) {
        Ok(value) => value,
        Err(error) => panic!("manifest signing seed must accept fixture: {error:?}"),
    };
    *secret.public_key().as_bytes()
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

    let sign_public = sign_public_for_seed().to_vec();
    let sealed = seal_and_sign_bundle(
        owner_identity,
        recipient_pubkey.clone(),
        ALBUM_ID.to_owned(),
        EPOCH_ID,
        EPOCH_SEED.to_vec(),
        SIGN_SECRET_SEED.to_vec(),
        sign_public.clone(),
    );
    assert_eq!(sealed.code, 0);
    assert!(!sealed.sealed.is_empty());
    assert_eq!(sealed.signature.len(), 64);
    assert_eq!(sealed.sharer_pubkey, owner_pubkey);

    let opened = verify_and_open_bundle(
        recipient_identity,
        sealed.sealed.clone(),
        sealed.signature.clone(),
        sealed.sharer_pubkey.clone(),
        ALBUM_ID.to_owned(),
        MIN_EPOCH_ID,
        false,
    );
    assert_eq!(opened.code, 0);
    assert_eq!(opened.album_id, ALBUM_ID);
    assert_eq!(opened.epoch_id, EPOCH_ID);
    assert_eq!(opened.recipient_pubkey, recipient_pubkey);
    assert_eq!(opened.epoch_seed, EPOCH_SEED.to_vec());
    assert_eq!(opened.sign_secret_seed, SIGN_SECRET_SEED.to_vec());
    assert_eq!(opened.sign_public_key, sign_public);
    assert_eq!(opened.version, 1);

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

    let sealed = seal_and_sign_bundle(
        owner_identity,
        recipient_pubkey,
        ALBUM_ID.to_owned(),
        EPOCH_ID,
        EPOCH_SEED.to_vec(),
        SIGN_SECRET_SEED.to_vec(),
        sign_public_for_seed().to_vec(),
    );
    assert_eq!(sealed.code, 0);

    let mut tampered_signature = sealed.signature.clone();
    tampered_signature[0] ^= 0x01;

    let opened = verify_and_open_bundle(
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
    assert!(opened.epoch_seed.is_empty());
    assert!(opened.sign_secret_seed.is_empty());

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

    let sealed = seal_and_sign_bundle(
        owner_identity,
        recipient_pubkey,
        ALBUM_ID.to_owned(),
        EPOCH_ID,
        EPOCH_SEED.to_vec(),
        SIGN_SECRET_SEED.to_vec(),
        sign_public_for_seed().to_vec(),
    );
    assert_eq!(sealed.code, 0);

    let opened = verify_and_open_bundle(
        recipient_identity,
        sealed.sealed,
        sealed.signature,
        sealed.sharer_pubkey,
        "different-album".to_owned(),
        MIN_EPOCH_ID,
        false,
    );
    assert_eq!(opened.code, ClientErrorCode::BundleAlbumIdMismatch.as_u16());

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

    let sealed = seal_and_sign_bundle(
        owner_identity,
        recipient_pubkey,
        ALBUM_ID.to_owned(),
        EPOCH_ID,
        EPOCH_SEED.to_vec(),
        SIGN_SECRET_SEED.to_vec(),
        sign_public_for_seed().to_vec(),
    );
    assert_eq!(sealed.code, 0);

    let opened = verify_and_open_bundle(
        recipient_identity,
        sealed.sealed,
        sealed.signature,
        sealed.sharer_pubkey,
        ALBUM_ID.to_owned(),
        EPOCH_ID + 1,
        false,
    );
    assert_eq!(opened.code, ClientErrorCode::BundleEpochTooOld.as_u16());

    assert_eq!(close_identity_handle(owner_identity), 0);
    assert_eq!(close_identity_handle(recipient_identity), 0);
    assert_eq!(close_account_key_handle(owner_account), 0);
    assert_eq!(close_account_key_handle(recipient_account), 0);
}

#[test]
fn seal_and_sign_rejects_invalid_handles_and_lengths() {
    let result = seal_and_sign_bundle(
        0,
        vec![0_u8; 32],
        ALBUM_ID.to_owned(),
        EPOCH_ID,
        EPOCH_SEED.to_vec(),
        SIGN_SECRET_SEED.to_vec(),
        sign_public_for_seed().to_vec(),
    );
    assert_eq!(
        result.code,
        ClientErrorCode::IdentityHandleNotFound.as_u16()
    );

    let (owner_account, owner_identity, _owner_pubkey) = unlock_owner_and_create_identity();
    let (recipient_account, recipient_identity, recipient_pubkey) =
        unlock_recipient_and_create_identity();

    let bad_recipient = seal_and_sign_bundle(
        owner_identity,
        vec![0_u8; 31],
        ALBUM_ID.to_owned(),
        EPOCH_ID,
        EPOCH_SEED.to_vec(),
        SIGN_SECRET_SEED.to_vec(),
        sign_public_for_seed().to_vec(),
    );
    assert_eq!(
        bad_recipient.code,
        ClientErrorCode::InvalidKeyLength.as_u16()
    );

    let bad_seed = seal_and_sign_bundle(
        owner_identity,
        recipient_pubkey,
        ALBUM_ID.to_owned(),
        EPOCH_ID,
        vec![0_u8; 31],
        SIGN_SECRET_SEED.to_vec(),
        sign_public_for_seed().to_vec(),
    );
    assert_eq!(bad_seed.code, ClientErrorCode::InvalidKeyLength.as_u16());

    assert_eq!(close_identity_handle(owner_identity), 0);
    assert_eq!(close_identity_handle(recipient_identity), 0);
    assert_eq!(close_account_key_handle(owner_account), 0);
    assert_eq!(close_account_key_handle(recipient_account), 0);
}

#[test]
fn verify_and_open_rejects_invalid_signature_length() {
    let (owner_account, owner_identity, _owner_pubkey) = unlock_owner_and_create_identity();

    let opened = verify_and_open_bundle(
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

    let opened_bad_pubkey = verify_and_open_bundle(
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
