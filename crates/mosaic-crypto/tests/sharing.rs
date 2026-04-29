//! Behavior tests for `mosaic_crypto::sharing` — sealed epoch key bundles.

use mosaic_crypto::{
    BUNDLE_SIGN_CONTEXT, BundleValidationContext, EpochKeyBundle, IdentityKeypair,
    IdentitySigningPublicKey, ManifestSigningPublicKey, ManifestSigningSecretKey,
    MosaicCryptoError, SealedBundle, SecretKey, derive_identity_keypair, seal_and_sign_bundle,
    sign_manifest_with_identity, verify_and_open_bundle,
};

const ALBUM_ID: &str = "album-0001";
const EPOCH_ID: u32 = 7;
const MIN_EPOCH_ID: u32 = 5;

fn fixed_seed(seed_byte: u8) -> [u8; 32] {
    let mut seed = [0_u8; 32];
    for (offset, byte) in seed.iter_mut().enumerate() {
        *byte = seed_byte.wrapping_add(offset as u8);
    }
    seed
}

fn make_identity(seed_byte: u8) -> IdentityKeypair {
    let mut seed = fixed_seed(seed_byte);
    match derive_identity_keypair(&mut seed) {
        Ok(value) => value,
        Err(error) => panic!("identity derivation failed: {error:?}"),
    }
}

fn make_secret_key(seed_byte: u8) -> SecretKey {
    let mut bytes = fixed_seed(seed_byte);
    match SecretKey::from_bytes(&mut bytes) {
        Ok(value) => value,
        Err(error) => panic!("secret key construction failed: {error:?}"),
    }
}

fn make_signing_pair(seed_byte: u8) -> (ManifestSigningSecretKey, ManifestSigningPublicKey) {
    let mut seed = fixed_seed(seed_byte ^ 0x5A);
    let secret = match ManifestSigningSecretKey::from_seed(&mut seed) {
        Ok(value) => value,
        Err(error) => panic!("manifest signing seed rejected: {error:?}"),
    };
    let public = secret.public_key();
    (secret, public)
}

fn make_bundle(
    recipient: &IdentityKeypair,
    album_id: &str,
    epoch_id: u32,
    epoch_seed_byte: u8,
    sign_seed_byte: u8,
) -> EpochKeyBundle {
    let (sign_secret_key, sign_public_key) = make_signing_pair(sign_seed_byte);
    EpochKeyBundle {
        version: 1,
        album_id: album_id.into(),
        epoch_id,
        recipient_pubkey: *recipient.signing_public_key().as_bytes(),
        epoch_seed: make_secret_key(epoch_seed_byte),
        sign_secret_key,
        sign_public_key,
    }
}

fn validation_context(owner: &IdentityKeypair, album_id: &str) -> BundleValidationContext {
    BundleValidationContext {
        album_id: album_id.into(),
        min_epoch_id: MIN_EPOCH_ID,
        allow_legacy_empty_album_id: false,
        expected_owner_ed25519_pub: *owner.signing_public_key().as_bytes(),
    }
}

fn seal_or_panic(
    bundle: &EpochKeyBundle,
    recipient_pub: &[u8; 32],
    owner: &IdentityKeypair,
) -> SealedBundle {
    match seal_and_sign_bundle(bundle, recipient_pub, owner) {
        Ok(value) => value,
        Err(error) => panic!("seal_and_sign_bundle failed: {error:?}"),
    }
}

struct RoundTripFixture {
    owner: IdentityKeypair,
    recipient: IdentityKeypair,
    sealed: SealedBundle,
    original_epoch_seed: [u8; 32],
    original_sign_public_key: [u8; 32],
}

fn round_trip_fixture() -> RoundTripFixture {
    let owner = make_identity(0x10);
    let recipient = make_identity(0x20);
    let bundle = make_bundle(&recipient, ALBUM_ID, EPOCH_ID, 0xA5, 0x33);
    let original_epoch_seed: [u8; 32] = match bundle.epoch_seed.as_bytes().try_into() {
        Ok(value) => value,
        Err(_) => panic!("epoch seed must be 32 bytes"),
    };
    let original_sign_public_key = *bundle.sign_public_key.as_bytes();
    let recipient_pub = *recipient.signing_public_key().as_bytes();
    let sealed = seal_or_panic(&bundle, &recipient_pub, &owner);

    RoundTripFixture {
        owner,
        recipient,
        sealed,
        original_epoch_seed,
        original_sign_public_key,
    }
}

#[test]
fn seal_and_open_round_trip() {
    let fixture = round_trip_fixture();
    let context = validation_context(&fixture.owner, ALBUM_ID);

    let opened = match verify_and_open_bundle(&fixture.sealed, &fixture.recipient, &context) {
        Ok(value) => value,
        Err(error) => panic!("open failed: {error:?}"),
    };

    assert_eq!(opened.version, 1);
    assert_eq!(opened.album_id, ALBUM_ID);
    assert_eq!(opened.epoch_id, EPOCH_ID);
    assert_eq!(
        &opened.recipient_pubkey,
        fixture.recipient.signing_public_key().as_bytes()
    );
    assert_eq!(opened.epoch_seed.as_bytes(), &fixture.original_epoch_seed);
    assert_eq!(
        opened.sign_public_key.as_bytes(),
        &fixture.original_sign_public_key
    );
    assert_eq!(
        opened.sign_secret_key.public_key().as_bytes(),
        opened.sign_public_key.as_bytes(),
    );
}

#[test]
fn verify_rejects_tampered_signature() {
    let mut fixture = round_trip_fixture();
    let context = validation_context(&fixture.owner, ALBUM_ID);
    fixture.sealed.signature[0] ^= 0x01;

    let result = verify_and_open_bundle(&fixture.sealed, &fixture.recipient, &context);
    assert_eq!(
        result.err(),
        Some(MosaicCryptoError::BundleSignatureInvalid)
    );
}

#[test]
fn verify_rejects_tampered_sealed() {
    let mut fixture = round_trip_fixture();
    let context = validation_context(&fixture.owner, ALBUM_ID);
    let last = fixture.sealed.sealed.len() - 1;
    fixture.sealed.sealed[last] ^= 0x80;

    let result = verify_and_open_bundle(&fixture.sealed, &fixture.recipient, &context);
    assert_eq!(
        result.err(),
        Some(MosaicCryptoError::BundleSignatureInvalid)
    );
}

#[test]
fn verify_rejects_wrong_owner_pubkey() {
    let fixture = round_trip_fixture();
    let other_owner = make_identity(0x40);
    let context = validation_context(&other_owner, ALBUM_ID);

    let result = verify_and_open_bundle(&fixture.sealed, &fixture.recipient, &context);
    assert_eq!(
        result.err(),
        Some(MosaicCryptoError::BundleSignatureInvalid)
    );
}

#[test]
fn open_rejects_wrong_recipient() {
    let owner = make_identity(0x10);
    let recipient_a = make_identity(0x20);
    let recipient_b = make_identity(0x21);
    let bundle = make_bundle(&recipient_a, ALBUM_ID, EPOCH_ID, 0xA5, 0x33);
    let recipient_pub = *recipient_a.signing_public_key().as_bytes();
    let sealed = seal_or_panic(&bundle, &recipient_pub, &owner);
    let context = validation_context(&owner, ALBUM_ID);

    let result = verify_and_open_bundle(&sealed, &recipient_b, &context);
    assert_eq!(result.err(), Some(MosaicCryptoError::BundleSealOpenFailed));
}

#[test]
fn open_rejects_album_id_mismatch() {
    let fixture = round_trip_fixture();
    let mut context = validation_context(&fixture.owner, ALBUM_ID);
    context.album_id = "different-album".into();

    let result = verify_and_open_bundle(&fixture.sealed, &fixture.recipient, &context);
    assert_eq!(result.err(), Some(MosaicCryptoError::BundleAlbumIdMismatch));
}

#[test]
fn open_allows_empty_album_id_when_legacy_flag_set() {
    let owner = make_identity(0x10);
    let recipient = make_identity(0x20);
    let bundle = make_bundle(&recipient, "", EPOCH_ID, 0xA5, 0x33);
    let recipient_pub = *recipient.signing_public_key().as_bytes();
    let sealed = seal_or_panic(&bundle, &recipient_pub, &owner);
    let mut context = validation_context(&owner, ALBUM_ID);
    context.allow_legacy_empty_album_id = true;

    let opened = match verify_and_open_bundle(&sealed, &recipient, &context) {
        Ok(value) => value,
        Err(error) => panic!("open with legacy flag failed: {error:?}"),
    };
    assert!(opened.album_id.is_empty());
    assert_eq!(opened.epoch_id, EPOCH_ID);
}

#[test]
fn open_rejects_empty_album_id_when_legacy_flag_unset() {
    let owner = make_identity(0x10);
    let recipient = make_identity(0x20);
    let bundle = make_bundle(&recipient, "", EPOCH_ID, 0xA5, 0x33);
    let recipient_pub = *recipient.signing_public_key().as_bytes();
    let sealed = seal_or_panic(&bundle, &recipient_pub, &owner);
    let context = validation_context(&owner, ALBUM_ID);

    let result = verify_and_open_bundle(&sealed, &recipient, &context);
    assert_eq!(result.err(), Some(MosaicCryptoError::BundleAlbumIdEmpty));
}

#[test]
fn open_rejects_old_epoch() {
    let owner = make_identity(0x10);
    let recipient = make_identity(0x20);
    let bundle = make_bundle(&recipient, ALBUM_ID, MIN_EPOCH_ID - 1, 0xA5, 0x33);
    let recipient_pub = *recipient.signing_public_key().as_bytes();
    let sealed = seal_or_panic(&bundle, &recipient_pub, &owner);
    let context = validation_context(&owner, ALBUM_ID);

    let result = verify_and_open_bundle(&sealed, &recipient, &context);
    assert_eq!(result.err(), Some(MosaicCryptoError::BundleEpochTooOld));
}

#[test]
fn open_rejects_recipient_pubkey_mismatch_in_payload() {
    let owner = make_identity(0x10);
    let recipient = make_identity(0x20);
    let other = make_identity(0x21);
    // Build a bundle whose `recipient_pubkey` payload field disagrees with
    // the actual X25519 recipient that the sealed box is addressed to. The
    // sealed box is opened by `recipient`, but the payload claims `other`.
    let mut bundle = make_bundle(&recipient, ALBUM_ID, EPOCH_ID, 0xA5, 0x33);
    bundle.recipient_pubkey = *other.signing_public_key().as_bytes();
    let recipient_pub = *recipient.signing_public_key().as_bytes();
    let sealed = seal_or_panic(&bundle, &recipient_pub, &owner);
    let context = validation_context(&owner, ALBUM_ID);

    let result = verify_and_open_bundle(&sealed, &recipient, &context);
    assert_eq!(
        result.err(),
        Some(MosaicCryptoError::BundleRecipientMismatch)
    );
}

#[test]
fn open_rejects_malformed_json() {
    // Build a sealed bundle whose plaintext is *not* valid JSON. We seal
    // arbitrary bytes for the recipient via `crypto_box`, then sign the
    // resulting ciphertext with the owner identity using the production
    // bundle context. This bypasses `seal_and_sign_bundle` so the sealed
    // payload skips the JSON encoder.
    let owner = make_identity(0x10);
    let recipient = make_identity(0x20);
    let recipient_pub = *recipient.signing_public_key().as_bytes();

    let signing_pub_id = match IdentitySigningPublicKey::from_bytes(&recipient_pub) {
        Ok(value) => value,
        Err(error) => panic!("recipient pubkey rejected: {error:?}"),
    };
    let recipient_x_pub = match signing_pub_id.encryption_public_key() {
        Ok(value) => value,
        Err(error) => panic!("ed25519->x25519 conversion failed: {error:?}"),
    };
    let box_pub = crypto_box::PublicKey::from(*recipient_x_pub.as_bytes());
    let mut rng = TestRng;
    let sealed_bytes = match box_pub.seal(&mut rng, b"this is definitely not json") {
        Ok(value) => value,
        Err(_) => panic!("seal helper failed"),
    };

    let mut to_sign = Vec::with_capacity(BUNDLE_SIGN_CONTEXT.len() + sealed_bytes.len());
    to_sign.extend_from_slice(BUNDLE_SIGN_CONTEXT);
    to_sign.extend_from_slice(&sealed_bytes);
    let signature = sign_manifest_with_identity(&to_sign, owner.secret_key());

    let sealed = SealedBundle {
        sealed: sealed_bytes,
        signature: *signature.as_bytes(),
        sharer_pubkey: *owner.signing_public_key().as_bytes(),
    };
    let context = validation_context(&owner, ALBUM_ID);

    let result = verify_and_open_bundle(&sealed, &recipient, &context);
    assert_eq!(result.err(), Some(MosaicCryptoError::BundleJsonParse));
}

#[test]
fn seal_does_not_leak_epoch_seed_into_ciphertext() {
    // Behavioural witness for the zeroize hygiene contract: the seed bytes
    // never appear verbatim inside the sealed ciphertext (they are
    // encrypted), and the owner's private signing key is never exposed
    // (only the public key is published in `sharer_pubkey`).
    let fixture = round_trip_fixture();
    let needle: &[u8] = &fixture.original_epoch_seed;

    let leaks = fixture
        .sealed
        .sealed
        .windows(needle.len())
        .any(|window| window == needle);
    assert!(
        !leaks,
        "epoch seed bytes leaked into sealed ciphertext (expected ZK encryption)"
    );
    assert_eq!(
        fixture.sealed.sharer_pubkey,
        *fixture.owner.signing_public_key().as_bytes()
    );
}

#[test]
fn seal_matches_ts_protocol_vector() {
    let mut recipient_seed = TS_VECTOR_RECIPIENT_SEED;
    let recipient = match derive_identity_keypair(&mut recipient_seed) {
        Ok(value) => value,
        Err(error) => panic!("golden vector recipient: {error:?}"),
    };
    let sealed = SealedBundle {
        sealed: TS_VECTOR_SEALED.to_vec(),
        signature: TS_VECTOR_SIGNATURE,
        sharer_pubkey: TS_VECTOR_SHARER_PUBKEY,
    };
    let context = BundleValidationContext {
        album_id: TS_VECTOR_ALBUM_ID.into(),
        min_epoch_id: TS_VECTOR_EPOCH_ID,
        allow_legacy_empty_album_id: false,
        expected_owner_ed25519_pub: TS_VECTOR_SHARER_PUBKEY,
    };

    let opened = match verify_and_open_bundle(&sealed, &recipient, &context) {
        Ok(value) => value,
        Err(error) => panic!("TS protocol vector failed to open: {error:?}"),
    };

    assert_eq!(opened.version, TS_VECTOR_VERSION);
    assert_eq!(opened.album_id, TS_VECTOR_ALBUM_ID);
    assert_eq!(opened.epoch_id, TS_VECTOR_EPOCH_ID);
    assert_eq!(opened.epoch_seed.as_bytes(), &TS_VECTOR_EPOCH_SEED);
    assert_eq!(
        opened.sign_public_key.as_bytes(),
        &TS_VECTOR_SIGN_PUBLIC_KEY
    );
    assert_eq!(
        &opened.recipient_pubkey,
        recipient.signing_public_key().as_bytes()
    );
}

// --------------------------------------------------------------------------
// Test-only RNG wrapper for the malformed-JSON helper.
// --------------------------------------------------------------------------

struct TestRng;

impl rand_core::RngCore for TestRng {
    fn next_u32(&mut self) -> u32 {
        rand_core::impls::next_u32_via_fill(self)
    }
    fn next_u64(&mut self) -> u64 {
        rand_core::impls::next_u64_via_fill(self)
    }
    fn fill_bytes(&mut self, dest: &mut [u8]) {
        if let Err(error) = self.try_fill_bytes(dest) {
            panic!("test rng failed: {error:?}");
        }
    }
    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rand_core::Error> {
        getrandom::fill(dest).map_err(|_| {
            let code = core::num::NonZeroU32::new(rand_core::Error::CUSTOM_START)
                .unwrap_or(core::num::NonZeroU32::MIN);
            rand_core::Error::from(code)
        })
    }
}

impl rand_core::CryptoRng for TestRng {}

// --------------------------------------------------------------------------
// TS golden vector — produced by `scripts/dump-bundle-vector.mjs` against
// the TypeScript bundle protocol. The Rust seal direction is non-deterministic
// (ephemeral X25519 key + fresh nonce), so this vector locks the *open*
// direction only.
// --------------------------------------------------------------------------

const TS_VECTOR_ALBUM_ID: &str = "ts-golden-album";
const TS_VECTOR_EPOCH_ID: u32 = 11;
const TS_VECTOR_VERSION: u32 = 1;

const TS_VECTOR_RECIPIENT_SEED: [u8; 32] = [
    0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00,
    0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 0x90, 0xa0, 0xb0, 0xc0, 0xd0, 0xe0, 0xf0, 0x00,
];

include!("sharing_vector.rs.inc");
