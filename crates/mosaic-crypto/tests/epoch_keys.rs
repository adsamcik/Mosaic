use mosaic_crypto::{
    MosaicCryptoError, SecretKey, derive_content_key, derive_epoch_key_material,
    generate_epoch_key_material, get_tier_key,
};
use mosaic_domain::ShardTier;

const ZERO_SEED: [u8; 32] = [0_u8; 32];
const OTHER_SEED: [u8; 32] = [0x42_u8; 32];

fn derive_epoch_from(mut seed: [u8; 32], epoch_id: u32) -> mosaic_crypto::EpochKeyMaterial {
    match derive_epoch_key_material(epoch_id, &mut seed) {
        Ok(value) => value,
        Err(error) => panic!("epoch key material should derive: {error:?}"),
    }
}

fn secret_key_from(mut bytes: [u8; 32]) -> SecretKey {
    match SecretKey::from_bytes(&mut bytes) {
        Ok(value) => value,
        Err(error) => panic!("test key bytes should be accepted: {error:?}"),
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

#[test]
fn epoch_tier_keys_match_hkdf_sha256_vectors() {
    let epoch = derive_epoch_from(ZERO_SEED, 7);

    assert_eq!(epoch.epoch_id(), 7);
    assert!(
        hex(epoch.thumb_key().as_bytes())
            == "f7fcdd6a790a967e861af99f699d405d3028fdce126c16cc070b49d31250678d"
    );
    assert!(
        hex(epoch.preview_key().as_bytes())
            == "a234b3204adf478dd6e3a626d43a8c64143b8a8f0b030d664978f319a313530f"
    );
    assert!(
        hex(epoch.full_key().as_bytes())
            == "464ab509b8e6fcc9b88ecf07ab2205547b22337080eb42f6f6ee9ee5b0f53917"
    );
    assert!(
        hex(epoch.content_key().as_bytes())
            == "bea2ef6ce9247d666b92dacab015dd0ceea07bddd243e089480edd28e5e8e010"
    );
}

#[test]
fn epoch_tier_keys_are_deterministic_and_domain_separated() {
    let first = derive_epoch_from(OTHER_SEED, 1);
    let second = derive_epoch_from(OTHER_SEED, 1);

    assert!(first.thumb_key().as_bytes() == second.thumb_key().as_bytes());
    assert!(first.preview_key().as_bytes() == second.preview_key().as_bytes());
    assert!(first.full_key().as_bytes() == second.full_key().as_bytes());
    assert!(first.content_key().as_bytes() == second.content_key().as_bytes());
    assert!(first.thumb_key().as_bytes() != first.preview_key().as_bytes());
    assert!(first.preview_key().as_bytes() != first.full_key().as_bytes());
    assert!(first.full_key().as_bytes() != first.content_key().as_bytes());
}

#[test]
fn deriving_from_mut_slice_zeroizes_epoch_seed_source() {
    let mut seed = [0x51_u8; 32];
    let epoch = match derive_epoch_key_material(3, &mut seed[..]) {
        Ok(value) => value,
        Err(error) => panic!("epoch key material should derive from mutable slice: {error:?}"),
    };

    assert_eq!(epoch.epoch_seed().as_bytes().len(), 32);
    assert!(seed.iter().all(|byte| *byte == 0));
}

#[test]
fn rejects_bad_epoch_seed_length_and_zeroizes_source() {
    let mut short_seed = [0x7a_u8; 31];
    let error = match derive_epoch_key_material(1, &mut short_seed[..]) {
        Ok(_) => panic!("short epoch seed should fail"),
        Err(error) => error,
    };

    assert_eq!(error, MosaicCryptoError::InvalidKeyLength { actual: 31 });
    assert!(short_seed.iter().all(|byte| *byte == 0));
}

#[test]
fn generated_epoch_material_uses_fresh_seed() {
    let first = match generate_epoch_key_material(5) {
        Ok(value) => value,
        Err(error) => panic!("first generated epoch key material should succeed: {error:?}"),
    };
    let second = match generate_epoch_key_material(5) {
        Ok(value) => value,
        Err(error) => panic!("second generated epoch key material should succeed: {error:?}"),
    };

    assert_eq!(first.epoch_id(), 5);
    assert_eq!(first.epoch_seed().as_bytes().len(), 32);
    assert!(first.epoch_seed().as_bytes() != second.epoch_seed().as_bytes());
    assert!(first.full_key().as_bytes() != second.full_key().as_bytes());
}

#[test]
fn tier_lookup_returns_the_selected_key() {
    let epoch = derive_epoch_from(OTHER_SEED, 9);

    assert!(get_tier_key(&epoch, ShardTier::Thumbnail).as_bytes() == epoch.thumb_key().as_bytes());
    assert!(get_tier_key(&epoch, ShardTier::Preview).as_bytes() == epoch.preview_key().as_bytes());
    assert!(get_tier_key(&epoch, ShardTier::Original).as_bytes() == epoch.full_key().as_bytes());
}

#[test]
fn standalone_content_key_derivation_matches_epoch_material() {
    let epoch_seed = secret_key_from(OTHER_SEED);
    let content_key = match derive_content_key(&epoch_seed) {
        Ok(value) => value,
        Err(error) => panic!("content key should derive: {error:?}"),
    };
    let epoch = derive_epoch_from(OTHER_SEED, 12);

    assert!(content_key.as_bytes() == epoch.content_key().as_bytes());
}

#[test]
fn boundary_epoch_ids_derive_without_overflow_and_zeroize_sources() {
    let mut zero_epoch_seed = [0x13_u8; 32];
    let zero_epoch = match derive_epoch_key_material(0, &mut zero_epoch_seed) {
        Ok(value) => value,
        Err(error) => panic!("zero epoch id should derive: {error:?}"),
    };

    assert_eq!(zero_epoch.epoch_id(), 0);
    assert!(zero_epoch_seed.iter().all(|byte| *byte == 0));

    let mut max_epoch_seed = [0x37_u8; 32];
    let max_epoch = match derive_epoch_key_material(u32::MAX, &mut max_epoch_seed) {
        Ok(value) => value,
        Err(error) => panic!("maximum epoch id should derive: {error:?}"),
    };

    assert_eq!(max_epoch.epoch_id(), u32::MAX);
    assert!(max_epoch_seed.iter().all(|byte| *byte == 0));
    assert!(zero_epoch.content_key().as_bytes() != max_epoch.content_key().as_bytes());
}
