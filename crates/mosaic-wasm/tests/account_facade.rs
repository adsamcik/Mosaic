//! WASM facade tests for the Slice 2 account/session bootstrap exports
//! (`createAccount`, `wrapWithAccountHandle`, `unwrapWithAccountHandle`,
//! `buildAuthChallengeTranscript`).
//!
//! Exercises round-trip wrap/unwrap, identity derivation chaining,
//! transcript determinism, and rejection of bad handles.

use mosaic_client::ClientErrorCode;
use mosaic_wasm::{
    AccountUnlockRequest, build_auth_challenge_transcript, close_account_key_handle,
    create_identity_handle, create_new_account, derive_auth_keypair_from_password,
    get_auth_public_key_from_account, get_auth_public_key_from_password,
    sign_auth_challenge_with_account, sign_auth_challenge_with_password, unlock_account_key,
    unwrap_with_account_handle, wrap_with_account_handle,
};

const PASSWORD: &[u8] = b"correct horse battery staple";
const USER_SALT: [u8; 16] = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
];
const ACCOUNT_SALT: [u8; 16] = [
    0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
];

const KDF_MEMORY_KIB: u32 = 64 * 1024;
const KDF_ITERATIONS: u32 = 3;
const KDF_PARALLELISM: u32 = 1;

fn unlock_request(wrapped_account_key: Vec<u8>) -> AccountUnlockRequest {
    AccountUnlockRequest {
        user_salt: USER_SALT.to_vec(),
        account_salt: ACCOUNT_SALT.to_vec(),
        wrapped_account_key,
        kdf_memory_kib: KDF_MEMORY_KIB,
        kdf_iterations: KDF_ITERATIONS,
        kdf_parallelism: KDF_PARALLELISM,
    }
}

#[test]
fn create_account_returns_handle_and_wrapped_account_key() {
    let result = create_new_account(
        PASSWORD.to_vec(),
        USER_SALT.to_vec(),
        ACCOUNT_SALT.to_vec(),
        KDF_MEMORY_KIB,
        KDF_ITERATIONS,
        KDF_PARALLELISM,
    );
    assert_eq!(result.code, 0);
    assert!(result.handle != 0);
    // Wrapped account key envelope: nonce(24) + ciphertext(32) + tag(16) = 72.
    assert_eq!(result.wrapped_account_key.len(), 72);
    assert_eq!(close_account_key_handle(result.handle), 0);
}

#[test]
fn wrapped_account_key_unlocks_back_to_an_open_handle() {
    let created = create_new_account(
        PASSWORD.to_vec(),
        USER_SALT.to_vec(),
        ACCOUNT_SALT.to_vec(),
        KDF_MEMORY_KIB,
        KDF_ITERATIONS,
        KDF_PARALLELISM,
    );
    assert_eq!(created.code, 0);
    // Close the original handle so the unlock cannot accidentally
    // resurrect it.
    assert_eq!(close_account_key_handle(created.handle), 0);

    let unlocked = unlock_account_key(
        PASSWORD.to_vec(),
        unlock_request(created.wrapped_account_key),
    );
    assert_eq!(unlocked.code, 0);
    assert!(unlocked.handle != 0);
    assert_eq!(close_account_key_handle(unlocked.handle), 0);
}

#[test]
fn wrap_with_account_handle_round_trips_arbitrary_payload() {
    let created = create_new_account(
        PASSWORD.to_vec(),
        USER_SALT.to_vec(),
        ACCOUNT_SALT.to_vec(),
        KDF_MEMORY_KIB,
        KDF_ITERATIONS,
        KDF_PARALLELISM,
    );
    assert_eq!(created.code, 0);

    let plaintext = b"opaque session blob v1".to_vec();
    let wrapped = wrap_with_account_handle(created.handle, plaintext.clone());
    assert_eq!(wrapped.code, 0);
    assert!(wrapped.bytes.len() >= 24 + plaintext.len() + 16);

    let unwrapped = unwrap_with_account_handle(created.handle, wrapped.bytes);
    assert_eq!(unwrapped.code, 0);
    assert_eq!(unwrapped.bytes, plaintext);

    assert_eq!(close_account_key_handle(created.handle), 0);
}

#[test]
fn wrap_with_account_handle_uses_fresh_nonce_per_call() {
    let created = create_new_account(
        PASSWORD.to_vec(),
        USER_SALT.to_vec(),
        ACCOUNT_SALT.to_vec(),
        KDF_MEMORY_KIB,
        KDF_ITERATIONS,
        KDF_PARALLELISM,
    );
    assert_eq!(created.code, 0);

    let plaintext = vec![0x42_u8; 64];
    let wrap_a = wrap_with_account_handle(created.handle, plaintext.clone());
    let wrap_b = wrap_with_account_handle(created.handle, plaintext);
    assert_eq!(wrap_a.code, 0);
    assert_eq!(wrap_b.code, 0);
    assert_ne!(wrap_a.bytes, wrap_b.bytes);

    assert_eq!(close_account_key_handle(created.handle), 0);
}

#[test]
fn wrap_rejects_invalid_account_handle() {
    let result = wrap_with_account_handle(0, b"data".to_vec());
    assert_eq!(result.code, ClientErrorCode::SecretHandleNotFound.as_u16());
    assert!(result.bytes.is_empty());
}

#[test]
fn unwrap_rejects_tampered_blob() {
    let created = create_new_account(
        PASSWORD.to_vec(),
        USER_SALT.to_vec(),
        ACCOUNT_SALT.to_vec(),
        KDF_MEMORY_KIB,
        KDF_ITERATIONS,
        KDF_PARALLELISM,
    );
    let wrapped = wrap_with_account_handle(created.handle, b"payload".to_vec());
    let mut tampered = wrapped.bytes.clone();
    let last = tampered.len() - 1;
    tampered[last] ^= 0x80;

    let result = unwrap_with_account_handle(created.handle, tampered);
    assert_eq!(result.code, ClientErrorCode::AuthenticationFailed.as_u16());

    assert_eq!(close_account_key_handle(created.handle), 0);
}

#[test]
fn build_auth_challenge_transcript_is_deterministic() {
    let challenge = vec![0xab_u8; 32];
    let transcript_a = build_auth_challenge_transcript(
        "alice".to_string(),
        1_700_000_000_000,
        true,
        challenge.clone(),
    );
    let transcript_b = build_auth_challenge_transcript(
        "alice".to_string(),
        1_700_000_000_000,
        true,
        challenge.clone(),
    );
    assert_eq!(transcript_a.code, 0);
    assert_eq!(transcript_a.bytes, transcript_b.bytes);

    // Differing username changes the transcript.
    let transcript_c = build_auth_challenge_transcript(
        "bob".to_string(),
        1_700_000_000_000,
        true,
        challenge.clone(),
    );
    assert_ne!(transcript_a.bytes, transcript_c.bytes);

    // Omitting the timestamp segment shrinks the transcript by 8 bytes.
    let transcript_d = build_auth_challenge_transcript("alice".to_string(), 0, false, challenge);
    assert_eq!(transcript_d.code, 0);
    assert_eq!(transcript_a.bytes.len(), transcript_d.bytes.len() + 8);
}

#[test]
fn build_auth_challenge_transcript_rejects_invalid_username() {
    let challenge = vec![0_u8; 32];
    let result = build_auth_challenge_transcript(String::new(), 0, false, challenge);
    assert_eq!(result.code, ClientErrorCode::InvalidUsername.as_u16());
}

#[test]
fn build_auth_challenge_transcript_rejects_wrong_challenge_length() {
    let result = build_auth_challenge_transcript("alice".to_string(), 0, false, vec![0_u8; 16]);
    assert_eq!(result.code, ClientErrorCode::InvalidInputLength.as_u16());
}

#[test]
fn signing_a_built_transcript_round_trips_to_the_account_handle_pubkey() {
    use mosaic_crypto::{AuthSigningPublicKey, verify_auth_challenge};

    let created = create_new_account(
        PASSWORD.to_vec(),
        USER_SALT.to_vec(),
        ACCOUNT_SALT.to_vec(),
        KDF_MEMORY_KIB,
        KDF_ITERATIONS,
        KDF_PARALLELISM,
    );
    assert_eq!(created.code, 0);

    let pubkey = get_auth_public_key_from_account(created.handle);
    assert_eq!(pubkey.code, 0);

    let challenge = vec![0x33_u8; 32];
    let transcript = build_auth_challenge_transcript(
        "alice".to_string(),
        1_700_000_000_000,
        true,
        challenge.clone(),
    );
    assert_eq!(transcript.code, 0);

    let signature = sign_auth_challenge_with_account(created.handle, transcript.bytes.clone());
    assert_eq!(signature.code, 0);

    let pub_key = match AuthSigningPublicKey::from_bytes(&pubkey.bytes) {
        Ok(value) => value,
        Err(error) => panic!("auth public key should parse: {error:?}"),
    };
    let sig = match mosaic_crypto::AuthSignature::from_bytes(&signature.bytes) {
        Ok(value) => value,
        Err(error) => panic!("auth signature should parse: {error:?}"),
    };

    assert!(verify_auth_challenge(&transcript.bytes, &sig, &pub_key));

    assert_eq!(close_account_key_handle(created.handle), 0);
}

#[test]
fn create_account_handle_supports_creating_an_identity_chain() {
    let created = create_new_account(
        PASSWORD.to_vec(),
        USER_SALT.to_vec(),
        ACCOUNT_SALT.to_vec(),
        KDF_MEMORY_KIB,
        KDF_ITERATIONS,
        KDF_PARALLELISM,
    );
    assert_eq!(created.code, 0);

    let identity = create_identity_handle(created.handle);
    assert_eq!(identity.code, 0);
    assert_eq!(identity.signing_pubkey.len(), 32);
    assert_eq!(identity.encryption_pubkey.len(), 32);
    assert!(identity.wrapped_seed.len() > 32);

    assert_eq!(close_account_key_handle(created.handle), 0);
}

// ---------------------------------------------------------------------------
// Password-rooted LocalAuth pre-auth keypair (Slice 2 fixup)
//
// LocalAuth login/register signs a challenge BEFORE any account handle is
// open (the wrapped account key is fetched from the server only after a
// successful auth). These tests exercise the password-rooted pre-auth
// derivation that runs Argon2id+HKDF on the (password, user_salt) pair.
// ---------------------------------------------------------------------------

#[test]
fn derive_auth_keypair_from_password_returns_32_byte_pubkey() {
    let result = derive_auth_keypair_from_password(
        PASSWORD.to_vec(),
        USER_SALT.to_vec(),
        KDF_MEMORY_KIB,
        KDF_ITERATIONS,
        KDF_PARALLELISM,
    );
    assert_eq!(result.code, 0);
    assert_eq!(result.auth_public_key.len(), 32);
}

#[test]
fn derive_auth_keypair_from_password_is_deterministic() {
    let a = derive_auth_keypair_from_password(
        PASSWORD.to_vec(),
        USER_SALT.to_vec(),
        KDF_MEMORY_KIB,
        KDF_ITERATIONS,
        KDF_PARALLELISM,
    );
    let b = derive_auth_keypair_from_password(
        PASSWORD.to_vec(),
        USER_SALT.to_vec(),
        KDF_MEMORY_KIB,
        KDF_ITERATIONS,
        KDF_PARALLELISM,
    );
    assert_eq!(a.code, 0);
    assert_eq!(b.code, 0);
    assert_eq!(a.auth_public_key, b.auth_public_key);
}

#[test]
fn derive_auth_keypair_from_password_differs_from_account_handle_path() {
    // The L2-rooted (account-handle) path uses the account key bytes as
    // the Ed25519 seed, while the password-rooted path runs Argon2id+HKDF
    // on the password and user_salt. The two seed sources are different,
    // so the resulting public keys MUST differ for the same logical user.
    let from_password = derive_auth_keypair_from_password(
        PASSWORD.to_vec(),
        USER_SALT.to_vec(),
        KDF_MEMORY_KIB,
        KDF_ITERATIONS,
        KDF_PARALLELISM,
    );
    assert_eq!(from_password.code, 0);

    let created = create_new_account(
        PASSWORD.to_vec(),
        USER_SALT.to_vec(),
        ACCOUNT_SALT.to_vec(),
        KDF_MEMORY_KIB,
        KDF_ITERATIONS,
        KDF_PARALLELISM,
    );
    assert_eq!(created.code, 0);
    let from_account = get_auth_public_key_from_account(created.handle);
    assert_eq!(from_account.code, 0);

    assert_ne!(from_password.auth_public_key, from_account.bytes);

    assert_eq!(close_account_key_handle(created.handle), 0);
}

#[test]
fn get_auth_public_key_from_password_matches_keypair_pubkey() {
    let derived = derive_auth_keypair_from_password(
        PASSWORD.to_vec(),
        USER_SALT.to_vec(),
        KDF_MEMORY_KIB,
        KDF_ITERATIONS,
        KDF_PARALLELISM,
    );
    let pubkey = get_auth_public_key_from_password(
        PASSWORD.to_vec(),
        USER_SALT.to_vec(),
        KDF_MEMORY_KIB,
        KDF_ITERATIONS,
        KDF_PARALLELISM,
    );
    assert_eq!(derived.code, 0);
    assert_eq!(pubkey.code, 0);
    assert_eq!(derived.auth_public_key, pubkey.bytes);
}

#[test]
fn signing_password_rooted_transcript_round_trips_to_password_pubkey() {
    use mosaic_crypto::{AuthSigningPublicKey, verify_auth_challenge};

    let pubkey = get_auth_public_key_from_password(
        PASSWORD.to_vec(),
        USER_SALT.to_vec(),
        KDF_MEMORY_KIB,
        KDF_ITERATIONS,
        KDF_PARALLELISM,
    );
    assert_eq!(pubkey.code, 0);

    let challenge = vec![0x77_u8; 32];
    let transcript =
        build_auth_challenge_transcript("alice".to_string(), 1_700_000_000_000, true, challenge);
    assert_eq!(transcript.code, 0);

    let signature = sign_auth_challenge_with_password(
        PASSWORD.to_vec(),
        USER_SALT.to_vec(),
        KDF_MEMORY_KIB,
        KDF_ITERATIONS,
        KDF_PARALLELISM,
        transcript.bytes.clone(),
    );
    assert_eq!(signature.code, 0);
    assert_eq!(signature.bytes.len(), 64);

    let pub_key = match AuthSigningPublicKey::from_bytes(&pubkey.bytes) {
        Ok(value) => value,
        Err(error) => panic!("auth public key should parse: {error:?}"),
    };
    let sig = match mosaic_crypto::AuthSignature::from_bytes(&signature.bytes) {
        Ok(value) => value,
        Err(error) => panic!("auth signature should parse: {error:?}"),
    };

    assert!(verify_auth_challenge(&transcript.bytes, &sig, &pub_key));
}

#[test]
fn password_rooted_signing_rejects_invalid_kdf_profile() {
    let result = sign_auth_challenge_with_password(
        PASSWORD.to_vec(),
        USER_SALT.to_vec(),
        16, // way below MIN_KDF_MEMORY_KIB
        1,
        1,
        vec![0_u8; 64],
    );
    assert_eq!(result.code, ClientErrorCode::KdfProfileTooWeak.as_u16());
    assert!(result.bytes.is_empty());
}

#[test]
fn password_rooted_pubkey_rejects_bad_user_salt_length() {
    let result = derive_auth_keypair_from_password(
        PASSWORD.to_vec(),
        vec![0_u8; 8], // not 16 bytes
        KDF_MEMORY_KIB,
        KDF_ITERATIONS,
        KDF_PARALLELISM,
    );
    assert_eq!(result.code, ClientErrorCode::InvalidSaltLength.as_u16());
    assert!(result.auth_public_key.is_empty());
}
