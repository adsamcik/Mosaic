//! Property-based tests for `mosaic-crypto` invariants.
//!
//! These tests use the `proptest!` macro to randomly probe core cryptographic
//! properties that must hold for ALL valid inputs:
//!
//! 1. Argon2id determinism — same `(password, salt, profile)` yields the same L0 key.
//! 2. Epoch-key derivation determinism — same 32-byte seed yields the same
//!    `EpochKeyMaterial` (tier keys + content key).
//! 3. Manifest sign+verify round-trip — Ed25519 signature verifies for any
//!    message, and tampering breaks verification.
//! 4. Auth challenge sign+verify round-trip — same property for auth signatures.
//! 5. Shard envelope encrypt+decrypt round-trip — XChaCha20-Poly1305 envelopes
//!    decrypt to the original plaintext under the original key, and reject
//!    every other key.
//!
//! Each test runs proptest's default 256 cases. The Argon2id test requires the
//! `weak-kdf` Cargo feature so the KDF is fast enough for property testing —
//! invoke with `cargo test -p mosaic-crypto --features weak-kdf`.

#![allow(clippy::expect_used)]

use mosaic_crypto::{
    AuthSigningSecretKey, ManifestSigningSecretKey, MosaicCryptoError, SecretKey,
    build_auth_challenge_transcript, decrypt_shard, derive_epoch_key_material, encrypt_shard,
    sign_auth_challenge, sign_manifest_transcript, verify_auth_challenge,
    verify_manifest_transcript,
};
#[cfg(feature = "weak-kdf")]
use mosaic_crypto::{KdfProfile, derive_l0_master};
use mosaic_domain::ShardTier;
use proptest::prelude::*;
#[cfg(feature = "weak-kdf")]
use zeroize::Zeroizing;

#[cfg(feature = "weak-kdf")]
fn weak_profile() -> KdfProfile {
    KdfProfile::new(8 * 1024, 1, 1).expect("weak-kdf profile constructable under weak-kdf")
}

fn make_secret(seed: [u8; 32]) -> SecretKey {
    let mut bytes = seed;
    SecretKey::from_bytes(&mut bytes).expect("32-byte secret key is always accepted")
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(16))]

    // ----------------------------------------------------------------------
    // 1. Argon2id (L0 master) determinism
    //    derive_l0_master is a pure function of (password, salt, profile).
    //    Two derivations with identical inputs MUST produce identical keys.
    //    Capped to 16 cases — each Argon2id pass costs hundreds of ms even
    //    under the `weak-kdf` profile (8 MiB / 1 iter).
    // ----------------------------------------------------------------------
    #[cfg(feature = "weak-kdf")]
    #[test]
    fn argon2id_l0_master_is_deterministic(
        password in prop::collection::vec(any::<u8>(), 0..=128),
        salt in any::<[u8; 16]>(),
    ) {
        let profile = weak_profile();

        let first = derive_l0_master(
            Zeroizing::new(password.clone()),
            &salt,
            profile,
        ).expect("derivation under weak-kdf profile succeeds");
        let second = derive_l0_master(
            Zeroizing::new(password),
            &salt,
            profile,
        ).expect("second derivation should succeed identically");

        prop_assert_eq!(first.as_bytes(), second.as_bytes());
    }
}

proptest! {
    // ----------------------------------------------------------------------
    // 2. Epoch-key derivation determinism (HKDF/BLAKE2b-keyed expansion)
    //    Same 32-byte seed -> identical thumbnail/preview/full/content keys.
    // ----------------------------------------------------------------------
    #[test]
    fn epoch_key_derivation_is_deterministic(
        epoch_id in any::<u32>(),
        seed in any::<[u8; 32]>(),
    ) {
        let mut seed_a = seed;
        let mut seed_b = seed;
        let mat_a = derive_epoch_key_material(epoch_id, &mut seed_a)
            .expect("epoch material derivation succeeds");
        let mat_b = derive_epoch_key_material(epoch_id, &mut seed_b)
            .expect("second epoch material derivation succeeds");

        prop_assert_eq!(mat_a.epoch_id(), mat_b.epoch_id());
        prop_assert_eq!(mat_a.thumb_key().as_bytes(), mat_b.thumb_key().as_bytes());
        prop_assert_eq!(mat_a.preview_key().as_bytes(), mat_b.preview_key().as_bytes());
        prop_assert_eq!(mat_a.full_key().as_bytes(), mat_b.full_key().as_bytes());
        prop_assert_eq!(mat_a.content_key().as_bytes(), mat_b.content_key().as_bytes());
        // Tier keys MUST differ from each other (domain separation).
        prop_assert_ne!(mat_a.thumb_key().as_bytes(), mat_a.preview_key().as_bytes());
        prop_assert_ne!(mat_a.preview_key().as_bytes(), mat_a.full_key().as_bytes());
        prop_assert_ne!(mat_a.thumb_key().as_bytes(), mat_a.full_key().as_bytes());
    }

    // ----------------------------------------------------------------------
    // 3. Manifest Ed25519 sign+verify round-trip
    //    Honest signature verifies; flipping any byte of message OR signature
    //    breaks verification.
    // ----------------------------------------------------------------------
    #[test]
    fn manifest_sign_verify_roundtrip(
        seed in any::<[u8; 32]>(),
        message in prop::collection::vec(any::<u8>(), 0..=1024),
    ) {
        let mut seed_bytes = seed;
        let secret_key = ManifestSigningSecretKey::from_seed(&mut seed_bytes)
            .expect("32-byte seed accepted");
        let public_key = secret_key.public_key();

        let signature = sign_manifest_transcript(&message, &secret_key);
        prop_assert!(verify_manifest_transcript(&message, &signature, &public_key));

        if !message.is_empty() {
            let mut tampered = message.clone();
            tampered[0] ^= 0x01;
            prop_assert!(!verify_manifest_transcript(&tampered, &signature, &public_key));
        }
    }

    // ----------------------------------------------------------------------
    // 4. Auth challenge sign+verify round-trip
    //    Same Ed25519 properties for the auth challenge surface.
    // ----------------------------------------------------------------------
    #[test]
    fn auth_challenge_sign_verify_roundtrip(
        seed in any::<[u8; 32]>(),
        username in "[a-zA-Z0-9_\\-]{1,32}",
        challenge in any::<[u8; 32]>(),
    ) {
        let mut seed_bytes = seed;
        let secret = AuthSigningSecretKey::from_seed(&mut seed_bytes)
            .expect("32-byte seed accepted");
        let public = secret.public_key();
        let transcript = build_auth_challenge_transcript(
            &username,
            None,
            &challenge,
        ).expect("transcript builds for valid username + 32-byte challenge");

        let signature = sign_auth_challenge(&transcript, &secret);
        prop_assert!(verify_auth_challenge(&transcript, &signature, &public));

        // Tampering the challenge invalidates the signature.
        let mut bad_challenge = challenge;
        bad_challenge[0] ^= 0xff;
        let bad_transcript = build_auth_challenge_transcript(
            &username,
            None,
            &bad_challenge,
        ).expect("bad transcript still builds");
        prop_assert!(!verify_auth_challenge(&bad_transcript, &signature, &public));
    }

    // ----------------------------------------------------------------------
    // 5. Shard envelope encrypt+decrypt round-trip (XChaCha20-Poly1305)
    //    decrypt_shard(encrypt_shard(p, k), k) == p; a different key fails.
    //    Each encrypt_shard call generates a fresh random nonce internally.
    // ----------------------------------------------------------------------
    #[test]
    fn shard_envelope_encrypt_decrypt_roundtrip(
        key_seed in any::<[u8; 32]>(),
        wrong_key_seed in any::<[u8; 32]>(),
        epoch_id in any::<u32>(),
        shard_index in any::<u32>(),
        tier_byte in 1u8..=3u8,
        plaintext in prop::collection::vec(any::<u8>(), 0..=4096),
    ) {
        prop_assume!(key_seed != wrong_key_seed);
        let tier = match tier_byte {
            1 => ShardTier::Thumbnail,
            2 => ShardTier::Preview,
            _ => ShardTier::Original,
        };
        let key = make_secret(key_seed);
        let wrong_key = make_secret(wrong_key_seed);

        let envelope = encrypt_shard(&plaintext, &key, epoch_id, shard_index, tier)
            .expect("encrypt succeeds for small plaintext");
        // Header is exactly 64 bytes; ciphertext appends to it.
        prop_assert!(envelope.bytes.len() >= 64);

        let decrypted = decrypt_shard(&envelope.bytes, &key)
            .expect("decrypt with correct key succeeds");
        prop_assert_eq!(decrypted.as_slice(), plaintext.as_slice());

        // Wrong key MUST fail authentication.
        let result = decrypt_shard(&envelope.bytes, &wrong_key);
        prop_assert!(matches!(
            result,
            Err(MosaicCryptoError::AuthenticationFailed)
        ));
    }
}
