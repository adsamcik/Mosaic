use mosaic_client::{
    ClientErrorCode, close_account_key_handle, close_epoch_key_handle, create_epoch_key_handle,
    decrypt_shard_with_legacy_raw_key_handle, open_secret_handle,
};
use mosaic_crypto::{
    EPOCH_SEED_AAD, SecretKey, derive_epoch_key_material, encrypt_shard, get_tier_key,
    unwrap_secret_with_aad,
};
use mosaic_domain::ShardTier;

const ACCOUNT_KEY: [u8; 32] = [
    0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f,
    0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f,
];
const PLAINTEXT: &[u8] = b"legacy raw key handle plaintext";

fn open_account_handle() -> u64 {
    open_secret_handle(&ACCOUNT_KEY)
        .unwrap_or_else(|error| panic!("account key handle should open: {error:?}"))
}

fn secret_key_from(mut bytes: [u8; 32]) -> SecretKey {
    SecretKey::from_bytes(&mut bytes)
        .unwrap_or_else(|error| panic!("test key bytes should be accepted: {error:?}"))
}

fn epoch_seed_from_wrapped(wrapped_epoch_seed: &[u8]) -> [u8; 32] {
    let account_key = secret_key_from(ACCOUNT_KEY);
    let unwrapped = unwrap_secret_with_aad(wrapped_epoch_seed, &account_key, EPOCH_SEED_AAD)
        .unwrap_or_else(|error| panic!("wrapped epoch seed should unwrap: {error:?}"));
    let mut seed = [0_u8; 32];
    seed.copy_from_slice(unwrapped.as_slice());
    seed
}

fn legacy_ciphertext(seed_bytes: [u8; 32], epoch_id: u32) -> Vec<u8> {
    let legacy_seed = secret_key_from(seed_bytes);
    encrypt_shard(PLAINTEXT, &legacy_seed, epoch_id, 4, ShardTier::Original)
        .unwrap_or_else(|error| panic!("legacy test ciphertext should encrypt: {error:?}"))
        .bytes
}

#[test]
fn legacy_raw_key_handle_decrypts_via_registry() {
    let account_handle = open_account_handle();
    let epoch = create_epoch_key_handle(account_handle, 91);
    assert_eq!(epoch.code, ClientErrorCode::Ok);
    let legacy = legacy_ciphertext(epoch_seed_from_wrapped(&epoch.wrapped_epoch_seed), 91);
    let decrypted = decrypt_shard_with_legacy_raw_key_handle(epoch.handle, &legacy)
        .unwrap_or_else(|error| panic!("legacy raw-key handle fallback should decrypt: {error:?}"));
    assert_eq!(decrypted, PLAINTEXT);
    assert_eq!(close_epoch_key_handle(epoch.handle), Ok(()));
    assert_eq!(close_account_key_handle(account_handle), Ok(()));
}

#[test]
fn legacy_raw_key_handle_unknown_handle_returns_epoch_handle_not_found() {
    let error = match decrypt_shard_with_legacy_raw_key_handle(u64::MAX, b"not an envelope") {
        Ok(_) => panic!("unknown handle should fail before envelope parsing"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::EpochHandleNotFound);
}

#[test]
fn legacy_raw_key_handle_modern_ciphertext_returns_authentication_failed() {
    let account_handle = open_account_handle();
    let epoch = create_epoch_key_handle(account_handle, 92);
    assert_eq!(epoch.code, ClientErrorCode::Ok);
    let raw_seed = epoch_seed_from_wrapped(&epoch.wrapped_epoch_seed);
    let mut tier_seed = raw_seed;
    let key_material = derive_epoch_key_material(92, &mut tier_seed)
        .unwrap_or_else(|error| panic!("tier material should derive: {error:?}"));
    let modern = encrypt_shard(
        PLAINTEXT,
        get_tier_key(&key_material, ShardTier::Original),
        92,
        4,
        ShardTier::Original,
    )
    .unwrap_or_else(|error| panic!("modern tier-key ciphertext should encrypt: {error:?}"));
    let error = match decrypt_shard_with_legacy_raw_key_handle(epoch.handle, &modern.bytes) {
        Ok(_) => panic!("legacy raw-key handle fallback must not decrypt modern ciphertext"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::AuthenticationFailed);
    assert_eq!(close_epoch_key_handle(epoch.handle), Ok(()));
    assert_eq!(close_account_key_handle(account_handle), Ok(()));
}
