//! WASM facade tests for the LocalAuth keypair exports.
//!
//! Exercises `deriveAuthKeypairFromAccount`, `signAuthChallengeWithAccount`,
//! and `getAuthPublicKeyFromAccount` for round-trip verification, public-key
//! stability, and bad-handle rejection.

use mosaic_client::ClientErrorCode;
use mosaic_crypto::{
    AuthSigningPublicKey, KdfProfile, MIN_KDF_ITERATIONS, MIN_KDF_MEMORY_KIB,
    build_auth_challenge_transcript, derive_account_key,
};
use mosaic_wasm::{
    AccountUnlockRequest, close_account_key_handle, derive_auth_keypair_from_account,
    get_auth_public_key_from_account, sign_auth_challenge_with_account, unlock_account_key,
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
fn auth_keypair_derives_thirty_two_byte_public_key() {
    let unlock = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    assert_eq!(unlock.code, 0);

    let result = derive_auth_keypair_from_account(unlock.handle);
    assert_eq!(result.code, 0);
    assert_eq!(result.auth_public_key.len(), 32);

    let again = get_auth_public_key_from_account(unlock.handle);
    assert_eq!(again.code, 0);
    assert_eq!(again.bytes, result.auth_public_key);

    assert_eq!(close_account_key_handle(unlock.handle), 0);
}

#[test]
fn auth_signature_verifies_against_derived_public_key() {
    use mosaic_crypto::{AuthSignature, verify_auth_challenge};

    let unlock = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    let public = get_auth_public_key_from_account(unlock.handle);
    assert_eq!(public.code, 0);

    let challenge = [0x42_u8; 32];
    let transcript = match build_auth_challenge_transcript("alice", Some(1_700_000_000), &challenge)
    {
        Ok(value) => value,
        Err(error) => panic!("transcript should build: {error:?}"),
    };

    let sig_result = sign_auth_challenge_with_account(unlock.handle, transcript.clone());
    assert_eq!(sig_result.code, 0);
    assert_eq!(sig_result.bytes.len(), 64);

    let signature = match AuthSignature::from_bytes(&sig_result.bytes) {
        Ok(value) => value,
        Err(error) => panic!("signature should reconstruct: {error:?}"),
    };
    let public_key = match AuthSigningPublicKey::from_bytes(&public.bytes) {
        Ok(value) => value,
        Err(error) => panic!("public key should reconstruct: {error:?}"),
    };

    assert!(verify_auth_challenge(&transcript, &signature, &public_key));

    let mut tampered = transcript;
    tampered[0] ^= 0x01;
    assert!(!verify_auth_challenge(&tampered, &signature, &public_key));

    assert_eq!(close_account_key_handle(unlock.handle), 0);
}

#[test]
fn auth_keypair_is_deterministic_for_same_account() {
    // Reuse the SAME wrapped account key so both unlocks recover the same
    // L2 secret; derive_account_key generates a fresh L2 on every call so
    // calling it twice would otherwise yield different keypairs by design.
    let wrapped = wrapped_account_key();

    let unlock_a = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped.clone()));
    let result_a = derive_auth_keypair_from_account(unlock_a.handle);
    assert_eq!(result_a.code, 0);
    assert_eq!(close_account_key_handle(unlock_a.handle), 0);

    let unlock_b = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped));
    let result_b = derive_auth_keypair_from_account(unlock_b.handle);
    assert_eq!(result_b.code, 0);
    assert_eq!(close_account_key_handle(unlock_b.handle), 0);

    assert_eq!(
        result_a.auth_public_key, result_b.auth_public_key,
        "auth keypair must be deterministic for the same account key"
    );
}

#[test]
fn invalid_account_handle_returns_secret_handle_not_found() {
    let derived = derive_auth_keypair_from_account(0);
    assert_eq!(derived.code, ClientErrorCode::SecretHandleNotFound.as_u16());
    assert!(derived.auth_public_key.is_empty());

    let public = get_auth_public_key_from_account(0);
    assert_eq!(public.code, ClientErrorCode::SecretHandleNotFound.as_u16());
    assert!(public.bytes.is_empty());

    let signed = sign_auth_challenge_with_account(0, vec![0_u8; 64]);
    assert_eq!(signed.code, ClientErrorCode::SecretHandleNotFound.as_u16());
    assert!(signed.bytes.is_empty());
}
