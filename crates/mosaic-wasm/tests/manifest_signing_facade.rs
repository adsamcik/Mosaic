//! WASM facade tests for manifest signing through epoch handles
//! (`signManifestWithEpochHandle` / `verifyManifestWithEpoch`).
//!
//! Slice 4 — the per-epoch manifest signing secret never crosses the FFI
//! boundary. The epoch handle holds the sign keypair and signs internally
//! using `mosaic_crypto::sign_manifest_transcript`.

use mosaic_client::ClientErrorCode;
use mosaic_crypto::{KdfProfile, ManifestSigningSecretKey, derive_account_key};
use mosaic_wasm::{
    AccountUnlockRequest, close_account_key_handle, close_epoch_key_handle,
    import_epoch_key_handle_from_bundle, sign_manifest_with_epoch_handle, unlock_account_key,
    verify_manifest_with_epoch,
};

const PASSWORD: &[u8] = b"correct horse battery staple";
const USER_SALT: [u8; 16] = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
];
const ACCOUNT_SALT: [u8; 16] = [
    0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f,
];
const EPOCH_ID: u32 = 11;
const EPOCH_SEED: [u8; 32] = [
    0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f,
    0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f,
];
const SIGN_SECRET_SEED: [u8; 32] = [
    0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f,
    0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x7b, 0x7c, 0x7d, 0x7e, 0x7f,
];
const TRANSCRIPT: &[u8] = b"slice4 manifest transcript bytes";

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

fn sign_public_for_seed() -> [u8; 32] {
    let mut seed = SIGN_SECRET_SEED;
    let secret = match ManifestSigningSecretKey::from_seed(&mut seed) {
        Ok(value) => value,
        Err(error) => panic!("manifest signing seed must accept fixture: {error:?}"),
    };
    *secret.public_key().as_bytes()
}

fn unlock_and_open_epoch_handle() -> (u64, u64, [u8; 32]) {
    let unlock = unlock_account_key(PASSWORD.to_vec(), unlock_request(wrapped_account_key()));
    assert_eq!(unlock.code, 0);
    let sign_public = sign_public_for_seed();
    let epoch = import_epoch_key_handle_from_bundle(
        unlock.handle,
        EPOCH_ID,
        EPOCH_SEED.to_vec(),
        SIGN_SECRET_SEED.to_vec(),
        sign_public.to_vec(),
    );
    assert_eq!(epoch.code, 0);
    (unlock.handle, epoch.handle, sign_public)
}

#[test]
fn sign_and_verify_round_trip_through_epoch_handle() {
    let (account_handle, epoch_handle, sign_public) = unlock_and_open_epoch_handle();

    let signed = sign_manifest_with_epoch_handle(epoch_handle, TRANSCRIPT.to_vec());
    assert_eq!(signed.code, 0);
    assert_eq!(signed.bytes.len(), 64);

    let verify_code = verify_manifest_with_epoch(
        TRANSCRIPT.to_vec(),
        signed.bytes.clone(),
        sign_public.to_vec(),
    );
    assert_eq!(verify_code, ClientErrorCode::Ok.as_u16());

    assert_eq!(close_epoch_key_handle(epoch_handle), 0);
    assert_eq!(close_account_key_handle(account_handle), 0);
}

#[test]
fn signature_is_deterministic_for_fixed_seed_and_transcript() {
    let (account_handle, epoch_handle, _sign_public) = unlock_and_open_epoch_handle();

    let first = sign_manifest_with_epoch_handle(epoch_handle, TRANSCRIPT.to_vec());
    let second = sign_manifest_with_epoch_handle(epoch_handle, TRANSCRIPT.to_vec());
    assert_eq!(first.code, 0);
    assert_eq!(second.code, 0);
    assert_eq!(first.bytes, second.bytes);

    assert_eq!(close_epoch_key_handle(epoch_handle), 0);
    assert_eq!(close_account_key_handle(account_handle), 0);
}

#[test]
fn verify_rejects_tampered_transcript_or_signature() {
    let (account_handle, epoch_handle, sign_public) = unlock_and_open_epoch_handle();

    let signed = sign_manifest_with_epoch_handle(epoch_handle, TRANSCRIPT.to_vec());
    assert_eq!(signed.code, 0);

    let mut tampered_transcript = TRANSCRIPT.to_vec();
    tampered_transcript[0] ^= 0x01;
    assert_eq!(
        verify_manifest_with_epoch(
            tampered_transcript,
            signed.bytes.clone(),
            sign_public.to_vec(),
        ),
        ClientErrorCode::AuthenticationFailed.as_u16()
    );

    let mut tampered_signature = signed.bytes.clone();
    tampered_signature[0] ^= 0x01;
    assert_eq!(
        verify_manifest_with_epoch(
            TRANSCRIPT.to_vec(),
            tampered_signature,
            sign_public.to_vec(),
        ),
        ClientErrorCode::AuthenticationFailed.as_u16()
    );

    let mut wrong_pubkey = sign_public;
    wrong_pubkey[0] ^= 0x01;
    let wrong_code = verify_manifest_with_epoch(
        TRANSCRIPT.to_vec(),
        signed.bytes.clone(),
        wrong_pubkey.to_vec(),
    );
    // Tampering a public key may either be flagged as invalid public key or as
    // a verification mismatch — both acceptable outcomes here.
    assert!(
        wrong_code == ClientErrorCode::AuthenticationFailed.as_u16()
            || wrong_code == ClientErrorCode::InvalidPublicKey.as_u16()
    );

    assert_eq!(close_epoch_key_handle(epoch_handle), 0);
    assert_eq!(close_account_key_handle(account_handle), 0);
}

#[test]
fn sign_rejects_invalid_epoch_handle() {
    let signed = sign_manifest_with_epoch_handle(0, TRANSCRIPT.to_vec());
    assert_eq!(signed.code, ClientErrorCode::EpochHandleNotFound.as_u16());
    assert!(signed.bytes.is_empty());
}

#[test]
fn verify_rejects_short_signature_and_short_pubkey() {
    let signed_short = ClientErrorCode::InvalidSignatureLength.as_u16();
    let pubkey_short = ClientErrorCode::InvalidKeyLength.as_u16();

    assert_eq!(
        verify_manifest_with_epoch(
            TRANSCRIPT.to_vec(),
            vec![0_u8; 63],
            sign_public_for_seed().to_vec(),
        ),
        signed_short
    );
    assert_eq!(
        verify_manifest_with_epoch(TRANSCRIPT.to_vec(), vec![0_u8; 64], vec![0_u8; 31]),
        pubkey_short
    );
}
