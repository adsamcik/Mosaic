use mosaic_crypto::{
    KdfProfile, MAX_KDF_ITERATIONS, MAX_KDF_MEMORY_KIB, MAX_KDF_PARALLELISM, MosaicCryptoError,
    derive_account_key, derive_root_key, unwrap_account_key, wrap_key,
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
const OTHER_ACCOUNT_SALT: [u8; 16] = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
];

#[test]
fn kdf_profile_enforces_mosaic_minimums() {
    let profile = match KdfProfile::new(64 * 1024, 3, 1) {
        Ok(value) => value,
        Err(error) => panic!("minimum Mosaic profile should be valid: {error:?}"),
    };

    assert_eq!(profile.memory_kib(), 64 * 1024);
    assert_eq!(profile.iterations(), 3);
    assert_eq!(profile.parallelism(), 1);
    assert_eq!(profile.output_len(), 32);

    assert_eq!(
        KdfProfile::new(64 * 1024 - 1, 3, 1),
        Err(MosaicCryptoError::KdfProfileTooWeak)
    );
    assert_eq!(
        KdfProfile::new(64 * 1024, 2, 1),
        Err(MosaicCryptoError::KdfProfileTooWeak)
    );
    assert_eq!(
        KdfProfile::new(64 * 1024, 3, 0),
        Err(MosaicCryptoError::KdfProfileTooWeak)
    );
}

#[test]
fn kdf_profile_rejects_resource_exhaustion_parameters() {
    let max_profile =
        match KdfProfile::new(MAX_KDF_MEMORY_KIB, MAX_KDF_ITERATIONS, MAX_KDF_PARALLELISM) {
            Ok(value) => value,
            Err(error) => panic!("maximum Mosaic profile should be valid: {error:?}"),
        };

    assert_eq!(max_profile.memory_kib(), MAX_KDF_MEMORY_KIB);
    assert_eq!(max_profile.iterations(), MAX_KDF_ITERATIONS);
    assert_eq!(max_profile.parallelism(), MAX_KDF_PARALLELISM);

    assert_eq!(
        KdfProfile::new(MAX_KDF_MEMORY_KIB + 1, 3, 1),
        Err(MosaicCryptoError::KdfProfileTooCostly)
    );
    assert_eq!(
        KdfProfile::new(64 * 1024, MAX_KDF_ITERATIONS + 1, 1),
        Err(MosaicCryptoError::KdfProfileTooCostly)
    );
    assert_eq!(
        KdfProfile::new(64 * 1024, 3, MAX_KDF_PARALLELISM + 1),
        Err(MosaicCryptoError::KdfProfileTooCostly)
    );
}

#[test]
fn kdf_profile_reports_weak_profiles_before_costly_profiles() {
    assert_eq!(
        KdfProfile::new(1, MAX_KDF_ITERATIONS + 1, MAX_KDF_PARALLELISM + 1),
        Err(MosaicCryptoError::KdfProfileTooWeak)
    );
    assert_eq!(
        KdfProfile::new(MAX_KDF_MEMORY_KIB + 1, 1, MAX_KDF_PARALLELISM + 1),
        Err(MosaicCryptoError::KdfProfileTooWeak)
    );
    assert_eq!(
        KdfProfile::new(MAX_KDF_MEMORY_KIB + 1, MAX_KDF_ITERATIONS + 1, 0),
        Err(MosaicCryptoError::KdfProfileTooWeak)
    );
}

#[test]
fn root_key_derivation_is_deterministic_and_account_salt_bound() {
    let profile = minimum_profile();

    let first = match derive_root_key(
        Zeroizing::new(PASSWORD.to_vec()),
        &USER_SALT,
        &ACCOUNT_SALT,
        profile,
    ) {
        Ok(value) => value,
        Err(error) => panic!("root key should derive: {error:?}"),
    };
    let second = match derive_root_key(
        Zeroizing::new(PASSWORD.to_vec()),
        &USER_SALT,
        &ACCOUNT_SALT,
        profile,
    ) {
        Ok(value) => value,
        Err(error) => panic!("root key should derive deterministically: {error:?}"),
    };
    let different_account = match derive_root_key(
        Zeroizing::new(PASSWORD.to_vec()),
        &USER_SALT,
        &OTHER_ACCOUNT_SALT,
        profile,
    ) {
        Ok(value) => value,
        Err(error) => panic!("root key should derive with alternate account salt: {error:?}"),
    };

    assert!(first.as_bytes() == second.as_bytes());
    assert!(first.as_bytes() != different_account.as_bytes());
}

#[test]
fn account_key_derivation_wraps_l2_and_unwraps_with_same_password() {
    let profile = minimum_profile();

    let created = match derive_account_key(
        Zeroizing::new(PASSWORD.to_vec()),
        &USER_SALT,
        &ACCOUNT_SALT,
        profile,
    ) {
        Ok(value) => value,
        Err(error) => panic!("account key should derive: {error:?}"),
    };

    assert_eq!(created.account_key.as_bytes().len(), 32);
    assert!(created.wrapped_account_key.len() >= 24 + 16 + 32);

    let unwrapped = match unwrap_account_key(
        Zeroizing::new(PASSWORD.to_vec()),
        &USER_SALT,
        &ACCOUNT_SALT,
        &created.wrapped_account_key,
        profile,
    ) {
        Ok(value) => value,
        Err(error) => panic!("account key should unwrap: {error:?}"),
    };

    assert!(created.account_key.as_bytes() == unwrapped.as_bytes());
}

#[test]
fn account_key_unwrap_rejects_wrong_password_and_bad_salts() {
    let profile = minimum_profile();

    let created = match derive_account_key(
        Zeroizing::new(PASSWORD.to_vec()),
        &USER_SALT,
        &ACCOUNT_SALT,
        profile,
    ) {
        Ok(value) => value,
        Err(error) => panic!("account key should derive: {error:?}"),
    };

    let wrong_password = match unwrap_account_key(
        Zeroizing::new(WRONG_PASSWORD.to_vec()),
        &USER_SALT,
        &ACCOUNT_SALT,
        &created.wrapped_account_key,
        profile,
    ) {
        Ok(_) => panic!("wrong password should not unwrap account key"),
        Err(error) => error,
    };
    assert_eq!(wrong_password, MosaicCryptoError::AuthenticationFailed);

    let bad_salt = match derive_root_key(
        Zeroizing::new(PASSWORD.to_vec()),
        &[0_u8; 15],
        &ACCOUNT_SALT,
        profile,
    ) {
        Ok(_) => panic!("short user salt should fail"),
        Err(error) => error,
    };
    assert_eq!(
        bad_salt,
        MosaicCryptoError::InvalidSaltLength { actual: 15 }
    );
}

#[test]
fn account_key_unwrap_rejects_authenticated_payloads_with_wrong_account_key_length() {
    let profile = minimum_profile();
    let root_key = match derive_root_key(
        Zeroizing::new(PASSWORD.to_vec()),
        &USER_SALT,
        &ACCOUNT_SALT,
        profile,
    ) {
        Ok(value) => value,
        Err(error) => panic!("root key should derive: {error:?}"),
    };

    for payload_len in [31_usize, 33] {
        let payload = vec![0x5a_u8; payload_len];
        let wrapped = match wrap_key(&payload, &root_key) {
            Ok(value) => value,
            Err(error) => panic!("payload should wrap: {error:?}"),
        };
        let error = match unwrap_account_key(
            Zeroizing::new(PASSWORD.to_vec()),
            &USER_SALT,
            &ACCOUNT_SALT,
            &wrapped,
            profile,
        ) {
            Ok(_) => panic!("non-32-byte account key should fail"),
            Err(error) => error,
        };

        assert_eq!(
            error,
            MosaicCryptoError::InvalidKeyLength {
                actual: payload_len
            }
        );
    }
}

fn minimum_profile() -> KdfProfile {
    match KdfProfile::new(64 * 1024, 3, 1) {
        Ok(value) => value,
        Err(error) => panic!("minimum Mosaic profile should be valid: {error:?}"),
    }
}
