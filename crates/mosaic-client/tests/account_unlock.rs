use mosaic_client::{
    AccountUnlockRequest, ClientErrorCode, account_key_handle_is_open, close_account_key_handle,
    create_identity_handle, identity_encryption_pubkey, identity_handle_is_open,
    identity_signing_pubkey, sign_manifest_with_identity, unlock_account_key,
};
use mosaic_crypto::{
    IdentitySignature, IdentitySigningPublicKey, KdfProfile, MAX_KDF_ITERATIONS,
    MAX_KDF_MEMORY_KIB, MAX_KDF_PARALLELISM, MIN_KDF_ITERATIONS, MIN_KDF_MEMORY_KIB,
    derive_account_key, verify_manifest_identity_signature,
};
use zeroize::Zeroizing;

const PASSWORD: &[u8] = b"correct horse battery staple";
const WRONG_PASSWORD: &[u8] = b"wrong horse battery staple";
const USER_SALT: [u8; 16] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
];
const ACCOUNT_SALT: [u8; 16] = [
    0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff,
];

#[test]
fn account_unlock_returns_opaque_handle_that_can_be_closed() {
    let wrapped_account_key = wrapped_account_key();
    let mut password = PASSWORD.to_vec();

    let result = unlock_account_key(unlock_request(&mut password, &wrapped_account_key));

    assert_eq!(result.code, ClientErrorCode::Ok);
    assert_ne!(result.handle, 0);
    assert!(password.iter().all(|byte| *byte == 0));
    assert!(!format!("{result:?}").contains("bytes"));

    let is_open = match account_key_handle_is_open(result.handle) {
        Ok(value) => value,
        Err(error) => panic!("account handle status should be readable: {error:?}"),
    };
    assert!(is_open);

    if let Err(error) = close_account_key_handle(result.handle) {
        panic!("account handle should close: {error:?}");
    }

    let is_open = match account_key_handle_is_open(result.handle) {
        Ok(value) => value,
        Err(error) => panic!("closed account handle status should be readable: {error:?}"),
    };
    assert!(!is_open);
}

#[test]
fn unlocked_account_handle_can_create_identity_and_sign_manifest_transcript() {
    let wrapped_account_key = wrapped_account_key();
    let mut password = PASSWORD.to_vec();
    let account_result = unlock_account_key(unlock_request(&mut password, &wrapped_account_key));
    assert_eq!(account_result.code, ClientErrorCode::Ok);

    let identity_result = create_identity_handle(account_result.handle);
    assert_eq!(identity_result.code, ClientErrorCode::Ok);
    assert_ne!(identity_result.handle, 0);
    assert_eq!(identity_result.signing_pubkey.len(), 32);
    assert_eq!(identity_result.encryption_pubkey.len(), 32);
    assert_eq!(identity_result.wrapped_seed.len(), 24 + 32 + 16);

    let transcript = b"manifest transcript bytes";
    let signature_result = sign_manifest_with_identity(identity_result.handle, transcript);
    assert_eq!(signature_result.code, ClientErrorCode::Ok);
    assert_eq!(signature_result.bytes.len(), 64);

    let public_key = match IdentitySigningPublicKey::from_bytes(&identity_result.signing_pubkey) {
        Ok(value) => value,
        Err(error) => panic!("identity public key should decode: {error:?}"),
    };
    let signature = match IdentitySignature::from_bytes(&signature_result.bytes) {
        Ok(value) => value,
        Err(error) => panic!("identity signature should decode: {error:?}"),
    };
    assert!(verify_manifest_identity_signature(
        transcript,
        &signature,
        &public_key
    ));

    if let Err(error) = close_account_key_handle(account_result.handle) {
        panic!("account handle should close and cascade identities: {error:?}");
    }
}

#[test]
fn closing_unlocked_account_handle_cascades_to_identity_handles() {
    let wrapped_account_key = wrapped_account_key();
    let mut password = PASSWORD.to_vec();
    let account_result = unlock_account_key(unlock_request(&mut password, &wrapped_account_key));
    assert_eq!(account_result.code, ClientErrorCode::Ok);

    let identity_result = create_identity_handle(account_result.handle);
    assert_eq!(identity_result.code, ClientErrorCode::Ok);

    let is_open = match identity_handle_is_open(identity_result.handle) {
        Ok(value) => value,
        Err(error) => panic!("identity handle status should be readable: {error:?}"),
    };
    assert!(is_open);

    if let Err(error) = close_account_key_handle(account_result.handle) {
        panic!("account handle should close: {error:?}");
    }

    let is_open = match identity_handle_is_open(identity_result.handle) {
        Ok(value) => value,
        Err(error) => panic!("closed identity handle status should be readable: {error:?}"),
    };
    assert!(!is_open);

    let signing_result = identity_signing_pubkey(identity_result.handle);
    assert_eq!(signing_result.code, ClientErrorCode::IdentityHandleNotFound);

    let encryption_result = identity_encryption_pubkey(identity_result.handle);
    assert_eq!(
        encryption_result.code,
        ClientErrorCode::IdentityHandleNotFound
    );
    assert!(encryption_result.bytes.is_empty());

    let signature_result =
        sign_manifest_with_identity(identity_result.handle, b"manifest transcript");
    assert_eq!(
        signature_result.code,
        ClientErrorCode::IdentityHandleNotFound
    );
    assert!(signature_result.bytes.is_empty());

    let close_again = match close_account_key_handle(account_result.handle) {
        Ok(()) => panic!("double-closing an account handle should fail"),
        Err(error) => error,
    };
    assert_eq!(close_again.code, ClientErrorCode::SecretHandleNotFound);
}

#[test]
fn account_unlock_rejects_wrong_password_and_tampered_wrapped_key() {
    let wrapped_account_key = wrapped_account_key();
    let mut wrong_password = WRONG_PASSWORD.to_vec();
    let wrong_password_result =
        unlock_account_key(unlock_request(&mut wrong_password, &wrapped_account_key));

    assert_eq!(
        wrong_password_result.code,
        ClientErrorCode::AuthenticationFailed
    );
    assert_eq!(wrong_password_result.handle, 0);
    assert!(wrong_password.iter().all(|byte| *byte == 0));

    let mut tampered_wrapped_account_key = wrapped_account_key;
    match tampered_wrapped_account_key.get_mut(30) {
        Some(byte) => *byte ^= 1,
        None => panic!("wrapped account key should be long enough to tamper"),
    }
    let mut password = PASSWORD.to_vec();
    let tampered_result =
        unlock_account_key(unlock_request(&mut password, &tampered_wrapped_account_key));

    assert_eq!(tampered_result.code, ClientErrorCode::AuthenticationFailed);
    assert_eq!(tampered_result.handle, 0);
    assert!(password.iter().all(|byte| *byte == 0));
}

#[test]
fn account_unlock_rejects_weak_kdf_profile_without_opening_handle() {
    let wrapped_account_key = wrapped_account_key();
    let mut password = PASSWORD.to_vec();

    let result = unlock_account_key(AccountUnlockRequest {
        password: password.as_mut_slice(),
        user_salt: &USER_SALT,
        account_salt: &ACCOUNT_SALT,
        wrapped_account_key: &wrapped_account_key,
        kdf_memory_kib: MIN_KDF_MEMORY_KIB - 1,
        kdf_iterations: MIN_KDF_ITERATIONS,
        kdf_parallelism: 1,
    });

    assert_eq!(result.code, ClientErrorCode::KdfProfileTooWeak);
    assert_eq!(result.handle, 0);
    assert!(password.iter().all(|byte| *byte == 0));
}

#[test]
fn account_unlock_rejects_resource_exhaustion_kdf_profile_without_opening_handle() {
    let wrapped_account_key = wrapped_account_key();
    let mut password = PASSWORD.to_vec();

    let result = unlock_account_key(AccountUnlockRequest {
        password: password.as_mut_slice(),
        user_salt: &USER_SALT,
        account_salt: &ACCOUNT_SALT,
        wrapped_account_key: &wrapped_account_key,
        kdf_memory_kib: u32::MAX,
        kdf_iterations: MIN_KDF_ITERATIONS,
        kdf_parallelism: 1,
    });

    assert_eq!(result.code, ClientErrorCode::KdfProfileTooCostly);
    assert_eq!(result.handle, 0);
    assert!(password.iter().all(|byte| *byte == 0));
}

#[test]
fn account_unlock_rejects_each_costly_kdf_limit_and_zeroizes_password() {
    let wrapped_account_key = wrapped_account_key();
    let cases = [
        (MAX_KDF_MEMORY_KIB + 1, MIN_KDF_ITERATIONS, 1),
        (MIN_KDF_MEMORY_KIB, MAX_KDF_ITERATIONS + 1, 1),
        (MIN_KDF_MEMORY_KIB, MIN_KDF_ITERATIONS, MAX_KDF_PARALLELISM + 1),
    ];

    for (memory_kib, iterations, parallelism) in cases {
        let mut password = PASSWORD.to_vec();

        let result = unlock_account_key(AccountUnlockRequest {
            password: password.as_mut_slice(),
            user_salt: &USER_SALT,
            account_salt: &ACCOUNT_SALT,
            wrapped_account_key: &wrapped_account_key,
            kdf_memory_kib: memory_kib,
            kdf_iterations: iterations,
            kdf_parallelism: parallelism,
        });

        assert_eq!(result.code, ClientErrorCode::KdfProfileTooCostly);
        assert_eq!(result.handle, 0);
        assert!(password.iter().all(|byte| *byte == 0));
    }
}

#[test]
fn account_unlock_rejects_multiple_kdf_violations_and_zeroizes_password() {
    let wrapped_account_key = wrapped_account_key();
    let mut password = PASSWORD.to_vec();

    let result = unlock_account_key(AccountUnlockRequest {
        password: password.as_mut_slice(),
        user_salt: &USER_SALT,
        account_salt: &ACCOUNT_SALT,
        wrapped_account_key: &wrapped_account_key,
        kdf_memory_kib: 1,
        kdf_iterations: MAX_KDF_ITERATIONS + 1,
        kdf_parallelism: MAX_KDF_PARALLELISM + 1,
    });

    assert_eq!(result.code, ClientErrorCode::KdfProfileTooWeak);
    assert_eq!(result.handle, 0);
    assert!(password.iter().all(|byte| *byte == 0));
}

#[test]
fn account_unlock_rejects_wrapped_key_shorter_than_minimum() {
    let short_wrapped_key = vec![0x5a_u8; 24 + 16];
    let mut password = PASSWORD.to_vec();

    let result = unlock_account_key(AccountUnlockRequest {
        password: password.as_mut_slice(),
        user_salt: &USER_SALT,
        account_salt: &ACCOUNT_SALT,
        wrapped_account_key: &short_wrapped_key,
        kdf_memory_kib: MIN_KDF_MEMORY_KIB,
        kdf_iterations: MIN_KDF_ITERATIONS,
        kdf_parallelism: 1,
    });

    assert_eq!(result.code, ClientErrorCode::WrappedKeyTooShort);
    assert_eq!(result.handle, 0);
    assert!(password.iter().all(|byte| *byte == 0));
}

#[test]
fn account_unlock_rejects_invalid_user_or_account_salt_lengths() {
    let wrapped_account_key = wrapped_account_key();
    let mut password = PASSWORD.to_vec();

    let invalid_user_salt_result = unlock_account_key(AccountUnlockRequest {
        password: password.as_mut_slice(),
        user_salt: &[0_u8; 15],
        account_salt: &ACCOUNT_SALT,
        wrapped_account_key: &wrapped_account_key,
        kdf_memory_kib: MIN_KDF_MEMORY_KIB,
        kdf_iterations: MIN_KDF_ITERATIONS,
        kdf_parallelism: 1,
    });

    assert_eq!(
        invalid_user_salt_result.code,
        ClientErrorCode::InvalidSaltLength
    );
    assert_eq!(invalid_user_salt_result.handle, 0);
    assert!(password.iter().all(|byte| *byte == 0));

    let mut password = PASSWORD.to_vec();
    let invalid_account_salt_result = unlock_account_key(AccountUnlockRequest {
        password: password.as_mut_slice(),
        user_salt: &USER_SALT,
        account_salt: &[0_u8; 15],
        wrapped_account_key: &wrapped_account_key,
        kdf_memory_kib: MIN_KDF_MEMORY_KIB,
        kdf_iterations: MIN_KDF_ITERATIONS,
        kdf_parallelism: 1,
    });

    assert_eq!(
        invalid_account_salt_result.code,
        ClientErrorCode::InvalidSaltLength
    );
    assert_eq!(invalid_account_salt_result.handle, 0);
    assert!(password.iter().all(|byte| *byte == 0));
}

#[test]
fn account_unlock_zeroizes_password_buffer_on_success_and_failure() {
    let wrapped_account_key = wrapped_account_key();
    let mut success_password = PASSWORD.to_vec();
    let success_result =
        unlock_account_key(unlock_request(&mut success_password, &wrapped_account_key));
    assert_eq!(success_result.code, ClientErrorCode::Ok);
    assert!(success_password.iter().all(|byte| *byte == 0));

    if let Err(error) = close_account_key_handle(success_result.handle) {
        panic!("account handle should close: {error:?}");
    }

    let mut failure_password = WRONG_PASSWORD.to_vec();
    let failure_result =
        unlock_account_key(unlock_request(&mut failure_password, &wrapped_account_key));
    assert_eq!(failure_result.code, ClientErrorCode::AuthenticationFailed);
    assert_eq!(failure_result.handle, 0);
    assert!(failure_password.iter().all(|byte| *byte == 0));
}

fn unlock_request<'a>(
    password: &'a mut [u8],
    wrapped_account_key: &'a [u8],
) -> AccountUnlockRequest<'a> {
    AccountUnlockRequest {
        password,
        user_salt: &USER_SALT,
        account_salt: &ACCOUNT_SALT,
        wrapped_account_key,
        kdf_memory_kib: MIN_KDF_MEMORY_KIB,
        kdf_iterations: MIN_KDF_ITERATIONS,
        kdf_parallelism: 1,
    }
}

fn wrapped_account_key() -> Vec<u8> {
    let profile = minimum_profile();
    let material = match derive_account_key(
        Zeroizing::new(PASSWORD.to_vec()),
        &USER_SALT,
        &ACCOUNT_SALT,
        profile,
    ) {
        Ok(value) => value,
        Err(error) => panic!("account key should derive: {error:?}"),
    };
    material.wrapped_account_key
}

fn minimum_profile() -> KdfProfile {
    match KdfProfile::new(MIN_KDF_MEMORY_KIB, MIN_KDF_ITERATIONS, 1) {
        Ok(value) => value,
        Err(error) => panic!("minimum Mosaic profile should be valid: {error:?}"),
    }
}
