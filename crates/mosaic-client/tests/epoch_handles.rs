use std::collections::HashSet;

use mosaic_client::{
    ClientErrorCode, close_account_key_handle, close_epoch_key_handle, create_epoch_key_handle,
    decrypt_shard_with_epoch_handle, encrypt_shard_with_epoch_handle, epoch_key_handle_is_open,
    open_epoch_key_handle, open_secret_handle,
};
use mosaic_domain::{ShardEnvelopeHeader, ShardTier};

const ACCOUNT_KEY: [u8; 32] = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
    0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f,
];
const PLAINTEXT: &[u8] = b"local client media bytes only";

#[test]
fn epoch_handle_create_open_status_and_close_round_trip_wrapped_seed() {
    let account_handle = open_account_handle();

    let create_result = create_epoch_key_handle(account_handle, 42);
    assert_eq!(create_result.code, ClientErrorCode::Ok);
    assert_ne!(create_result.handle, 0);
    assert_eq!(create_result.epoch_id, 42);
    assert_eq!(create_result.wrapped_epoch_seed.len(), 24 + 32 + 16);

    assert_epoch_is_open(create_result.handle, true);

    close_epoch_once(create_result.handle);
    assert_epoch_is_open(create_result.handle, false);
    assert_eq!(
        close_epoch_error_code(create_result.handle),
        ClientErrorCode::EpochHandleNotFound
    );

    let open_result = open_epoch_key_handle(&create_result.wrapped_epoch_seed, account_handle, 42);
    assert_eq!(open_result.code, ClientErrorCode::Ok);
    assert_ne!(open_result.handle, 0);
    assert_eq!(open_result.epoch_id, 42);
    assert!(open_result.wrapped_epoch_seed.is_empty());
    assert_epoch_is_open(open_result.handle, true);

    close_epoch_once(open_result.handle);
    close_account_once(account_handle);
}

#[test]
fn closing_account_handle_cascades_to_epoch_handles() {
    let account_handle = open_account_handle();
    let epoch_result = create_epoch_key_handle(account_handle, 7);
    assert_eq!(epoch_result.code, ClientErrorCode::Ok);

    close_account_once(account_handle);

    assert_epoch_is_open(epoch_result.handle, false);

    let encrypt_result = encrypt_shard_with_epoch_handle(epoch_result.handle, PLAINTEXT, 1, 1);
    assert_eq!(encrypt_result.code, ClientErrorCode::EpochHandleNotFound);
    assert!(encrypt_result.envelope_bytes.is_empty());
    assert!(encrypt_result.sha256.is_empty());

    let open_result = open_epoch_key_handle(&epoch_result.wrapped_epoch_seed, account_handle, 7);
    assert_eq!(open_result.code, ClientErrorCode::SecretHandleNotFound);
    assert_eq!(open_result.handle, 0);
    assert!(open_result.wrapped_epoch_seed.is_empty());
}

#[test]
fn epoch_handle_encrypt_decrypt_round_trip_uses_random_nonce_and_public_header_fields() {
    let account_handle = open_account_handle();
    let epoch_result = create_epoch_key_handle(account_handle, 15);
    assert_eq!(epoch_result.code, ClientErrorCode::Ok);

    let encrypted = encrypt_shard_with_epoch_handle(epoch_result.handle, PLAINTEXT, 9, 2);
    assert_eq!(encrypted.code, ClientErrorCode::Ok);
    assert!(!encrypted.envelope_bytes.is_empty());
    assert!(!encrypted.sha256.is_empty());

    let second_encrypted = encrypt_shard_with_epoch_handle(epoch_result.handle, PLAINTEXT, 9, 2);
    assert_eq!(second_encrypted.code, ClientErrorCode::Ok);
    assert_ne!(encrypted.envelope_bytes, second_encrypted.envelope_bytes);

    let header = parse_header(&encrypted.envelope_bytes[..64]);
    assert_eq!(header.epoch_id(), 15);
    assert_eq!(header.shard_index(), 9);
    assert_eq!(header.tier(), ShardTier::Preview);

    let decrypted = decrypt_shard_with_epoch_handle(epoch_result.handle, &encrypted.envelope_bytes);
    assert_eq!(decrypted.code, ClientErrorCode::Ok);
    assert_eq!(decrypted.plaintext, PLAINTEXT);

    close_epoch_once(epoch_result.handle);
    close_account_once(account_handle);
}

#[test]
fn epoch_handle_decrypt_rejects_wrong_epoch_key_and_tampered_envelope_without_plaintext() {
    let account_handle = open_account_handle();
    let first_epoch = create_epoch_key_handle(account_handle, 3);
    let second_epoch = create_epoch_key_handle(account_handle, 3);
    assert_eq!(first_epoch.code, ClientErrorCode::Ok);
    assert_eq!(second_epoch.code, ClientErrorCode::Ok);

    let encrypted = encrypt_shard_with_epoch_handle(first_epoch.handle, PLAINTEXT, 5, 3);
    assert_eq!(encrypted.code, ClientErrorCode::Ok);

    let wrong_key_result =
        decrypt_shard_with_epoch_handle(second_epoch.handle, &encrypted.envelope_bytes);
    assert_eq!(wrong_key_result.code, ClientErrorCode::AuthenticationFailed);
    assert!(wrong_key_result.plaintext.is_empty());

    let mut tampered = encrypted.envelope_bytes.clone();
    flip_last_byte(&mut tampered);
    let tampered_result = decrypt_shard_with_epoch_handle(first_epoch.handle, &tampered);
    assert_eq!(tampered_result.code, ClientErrorCode::AuthenticationFailed);
    assert!(tampered_result.plaintext.is_empty());

    close_epoch_once(first_epoch.handle);
    close_epoch_once(second_epoch.handle);
    close_account_once(account_handle);
}

#[test]
fn epoch_handle_rejects_invalid_tier_and_malformed_envelope_with_empty_outputs() {
    let account_handle = open_account_handle();
    let epoch_result = create_epoch_key_handle(account_handle, 21);
    assert_eq!(epoch_result.code, ClientErrorCode::Ok);

    let invalid_tier = encrypt_shard_with_epoch_handle(epoch_result.handle, PLAINTEXT, 1, 9);
    assert_eq!(invalid_tier.code, ClientErrorCode::InvalidTier);
    assert!(invalid_tier.envelope_bytes.is_empty());
    assert!(invalid_tier.sha256.is_empty());

    let malformed = decrypt_shard_with_epoch_handle(epoch_result.handle, b"short envelope");
    assert_eq!(malformed.code, ClientErrorCode::InvalidHeaderLength);
    assert!(malformed.plaintext.is_empty());

    let header_only = ShardEnvelopeHeader::new(21, 1, [4; 24], ShardTier::Thumbnail).to_bytes();
    let missing_ciphertext = decrypt_shard_with_epoch_handle(epoch_result.handle, &header_only);
    assert_eq!(missing_ciphertext.code, ClientErrorCode::MissingCiphertext);
    assert!(missing_ciphertext.plaintext.is_empty());

    close_epoch_once(epoch_result.handle);
    close_account_once(account_handle);
}

#[test]
fn epoch_handle_rejects_closed_missing_and_tampered_wrapped_seed_without_outputs() {
    assert_epoch_is_open(0, false);
    assert_eq!(
        close_epoch_error_code(0),
        ClientErrorCode::EpochHandleNotFound
    );

    let encrypt_missing = encrypt_shard_with_epoch_handle(0, PLAINTEXT, 1, 1);
    assert_eq!(encrypt_missing.code, ClientErrorCode::EpochHandleNotFound);
    assert!(encrypt_missing.envelope_bytes.is_empty());
    assert!(encrypt_missing.sha256.is_empty());

    let decrypt_missing = decrypt_shard_with_epoch_handle(0, b"not parsed before handle lookup");
    assert_eq!(decrypt_missing.code, ClientErrorCode::EpochHandleNotFound);
    assert!(decrypt_missing.plaintext.is_empty());

    let account_handle = open_account_handle();
    let create_result = create_epoch_key_handle(account_handle, 33);
    assert_eq!(create_result.code, ClientErrorCode::Ok);

    let mut tampered_seed = create_result.wrapped_epoch_seed.clone();
    tampered_seed[30] ^= 1;
    let tampered_open = open_epoch_key_handle(&tampered_seed, account_handle, 33);
    assert_eq!(tampered_open.code, ClientErrorCode::AuthenticationFailed);
    assert_eq!(tampered_open.handle, 0);
    assert_eq!(tampered_open.epoch_id, 0);
    assert!(tampered_open.wrapped_epoch_seed.is_empty());

    close_epoch_once(create_result.handle);
    let encrypt_closed = encrypt_shard_with_epoch_handle(create_result.handle, PLAINTEXT, 1, 1);
    assert_eq!(encrypt_closed.code, ClientErrorCode::EpochHandleNotFound);
    assert!(encrypt_closed.envelope_bytes.is_empty());
    assert!(encrypt_closed.sha256.is_empty());

    close_account_once(account_handle);
}

#[test]
fn epoch_handle_allocation_returns_unique_opaque_handles() {
    let account_handle = open_account_handle();
    let mut handles = HashSet::new();

    for epoch_id in 0..64 {
        let result = create_epoch_key_handle(account_handle, epoch_id);
        assert_eq!(result.code, ClientErrorCode::Ok);
        assert_ne!(result.handle, 0);
        assert_eq!(result.epoch_id, epoch_id);
        assert!(handles.insert(result.handle));
    }

    for handle in handles {
        close_epoch_once(handle);
    }
    close_account_once(account_handle);
}

fn open_account_handle() -> u64 {
    match open_secret_handle(&ACCOUNT_KEY) {
        Ok(handle) => handle,
        Err(error) => panic!("account key handle should open: {error:?}"),
    }
}

fn assert_epoch_is_open(handle: u64, expected: bool) {
    let is_open = match epoch_key_handle_is_open(handle) {
        Ok(value) => value,
        Err(error) => panic!("epoch handle status should be readable: {error:?}"),
    };
    assert_eq!(is_open, expected);
}

fn close_epoch_once(handle: u64) {
    if let Err(error) = close_epoch_key_handle(handle) {
        panic!("epoch handle should close: {error:?}");
    }
}

fn close_epoch_error_code(handle: u64) -> ClientErrorCode {
    match close_epoch_key_handle(handle) {
        Ok(()) => panic!("epoch handle close should fail"),
        Err(error) => error.code,
    }
}

fn close_account_once(handle: u64) {
    if let Err(error) = close_account_key_handle(handle) {
        panic!("account handle should close: {error:?}");
    }
}

fn parse_header(bytes: &[u8]) -> ShardEnvelopeHeader {
    match ShardEnvelopeHeader::parse(bytes) {
        Ok(header) => header,
        Err(error) => panic!("encrypted envelope should contain a valid public header: {error:?}"),
    }
}

fn flip_last_byte(bytes: &mut [u8]) {
    match bytes.last_mut() {
        Some(byte) => *byte ^= 1,
        None => panic!("envelope should contain ciphertext"),
    }
}
