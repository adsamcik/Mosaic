//! WASM facade tests for album content encryption (`encryptAlbumContent` /
//! `decryptAlbumContent`).
//!
//! Covers handle-based round-trip, AAD enforcement (via the corpus
//! cross-check), and tampering rejection.

use mosaic_client::ClientErrorCode;
use mosaic_crypto::{KdfProfile, derive_account_key};
use mosaic_vectors::{load_vector, vectors::ContentEncryptVector};
use mosaic_wasm::{
    AccountUnlockRequest, close_account_key_handle, close_epoch_key_handle,
    create_epoch_key_handle, decrypt_album_content, derive_content_key_from_epoch,
    encrypt_album_content, unlock_account_key,
};
use std::path::PathBuf;

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

fn corpus_path(name: &str) -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let mut path = PathBuf::from(manifest_dir);
    path.pop();
    path.pop();
    path.push("tests");
    path.push("vectors");
    path.push(name);
    path
}

#[test]
fn round_trip_through_epoch_handle() {
    let unlock = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    assert_eq!(unlock.code, 0);
    let epoch = create_epoch_key_handle(unlock.handle, 17);
    assert_eq!(epoch.code, 0);

    let plaintext = b"album manifest content payload v1".to_vec();
    let encrypted = encrypt_album_content(epoch.handle, plaintext.clone());
    assert_eq!(encrypted.code, 0);
    assert_eq!(encrypted.nonce.len(), 24);
    assert!(encrypted.ciphertext.len() >= plaintext.len() + 16);

    let decrypted = decrypt_album_content(epoch.handle, encrypted.nonce, encrypted.ciphertext);
    assert_eq!(decrypted.code, 0);
    assert_eq!(decrypted.plaintext, plaintext);

    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_account_key_handle(unlock.handle), 0);
}

#[test]
fn corpus_decrypt_matches_expected_plaintext() {
    use mosaic_crypto::{SecretKey, decrypt_content};
    let parsed = match load_vector(&corpus_path("content_encrypt.json")) {
        Ok(value) => value,
        Err(error) => panic!("content_encrypt.json must load: {error}"),
    };
    let vector = match ContentEncryptVector::from(&parsed) {
        Ok(value) => value,
        Err(error) => panic!("content_encrypt.json must parse: {error}"),
    };

    let mut content_key_buf = vector.content_key.clone();
    let content_key = match SecretKey::from_bytes(content_key_buf.as_mut_slice()) {
        Ok(value) => value,
        Err(error) => panic!("content key should construct: {error:?}"),
    };
    let mut nonce_array = [0_u8; 24];
    nonce_array.copy_from_slice(&vector.nonce);

    let plaintext = match decrypt_content(
        &vector.expected_ciphertext,
        &nonce_array,
        &content_key,
        vector.epoch_id,
    ) {
        Ok(value) => value,
        Err(error) => panic!("corpus ciphertext must decrypt: {error:?}"),
    };
    assert_eq!(plaintext.as_slice(), vector.expected_decrypted.as_slice());
}

#[test]
fn decrypt_rejects_tampered_ciphertext() {
    let unlock = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    let epoch = create_epoch_key_handle(unlock.handle, 18);

    let plaintext = b"album content payload".to_vec();
    let encrypted = encrypt_album_content(epoch.handle, plaintext);
    assert_eq!(encrypted.code, 0);

    let mut tampered = encrypted.ciphertext.clone();
    tampered[0] ^= 0x01;

    let decrypted = decrypt_album_content(epoch.handle, encrypted.nonce, tampered);
    assert_eq!(
        decrypted.code,
        ClientErrorCode::AuthenticationFailed.as_u16()
    );
    assert!(decrypted.plaintext.is_empty());

    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_account_key_handle(unlock.handle), 0);
}

#[test]
fn decrypt_rejects_short_nonce() {
    let unlock = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    let epoch = create_epoch_key_handle(unlock.handle, 19);

    let result = decrypt_album_content(epoch.handle, vec![0_u8; 23], vec![0_u8; 16]);
    assert_eq!(result.code, ClientErrorCode::InvalidInputLength.as_u16());

    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_account_key_handle(unlock.handle), 0);
}

#[test]
fn encrypt_rejects_invalid_handle() {
    let result = encrypt_album_content(0, b"payload".to_vec());
    assert_eq!(result.code, ClientErrorCode::EpochHandleNotFound.as_u16());

    let result = decrypt_album_content(0, vec![0_u8; 24], vec![0_u8; 16]);
    assert_eq!(result.code, ClientErrorCode::EpochHandleNotFound.as_u16());
}

#[test]
fn cross_epoch_decryption_fails() {
    let unlock = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    let epoch_a = create_epoch_key_handle(unlock.handle, 100);
    let epoch_b = create_epoch_key_handle(unlock.handle, 200);

    let encrypted = encrypt_album_content(epoch_a.handle, b"payload".to_vec());
    assert_eq!(encrypted.code, 0);

    // Different epoch handle => different content key + AAD; must fail.
    let decrypted = decrypt_album_content(epoch_b.handle, encrypted.nonce, encrypted.ciphertext);
    assert_eq!(
        decrypted.code,
        ClientErrorCode::AuthenticationFailed.as_u16()
    );

    assert_eq!(close_epoch_key_handle(epoch_a.handle), 0);
    assert_eq!(close_epoch_key_handle(epoch_b.handle), 0);
    assert_eq!(close_account_key_handle(unlock.handle), 0);
}

#[test]
fn derive_content_key_returns_thirty_two_bytes() {
    let unlock = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    let epoch = create_epoch_key_handle(unlock.handle, 21);

    let result = derive_content_key_from_epoch(epoch.handle);
    assert_eq!(result.code, 0);
    assert_eq!(result.bytes.len(), 32);

    // Same epoch handle must produce identical bytes deterministically.
    let again = derive_content_key_from_epoch(epoch.handle);
    assert_eq!(again.code, 0);
    assert_eq!(again.bytes, result.bytes);

    assert_eq!(close_epoch_key_handle(epoch.handle), 0);
    assert_eq!(close_account_key_handle(unlock.handle), 0);
}

#[test]
fn derive_content_key_rejects_invalid_handle() {
    let result = derive_content_key_from_epoch(0);
    assert_eq!(result.code, ClientErrorCode::EpochHandleNotFound.as_u16());
    assert!(result.bytes.is_empty());
}
