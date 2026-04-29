//! Cross-client differential runner — Rust layer.
//!
//! Loads the shared golden-vector corpus under `tests/vectors/*.json` and asserts
//! that the workspace `mosaic-crypto` and `mosaic-domain` crates reproduce the
//! exact bytes captured from the TS reference. Vectors flagged
//! `rust_canonical: true` lock Rust as the protocol reference; vectors where
//! Rust deliberately diverges from TS (different KDF / cipher) are documented
//! in `tests/vectors/deviations.md` and skipped here with the deviation
//! reason printed for visibility.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::path::PathBuf;

use mosaic_crypto::{
    AuthSignature, AuthSigningPublicKey, AuthSigningSecretKey, IdentitySignature,
    IdentitySigningPublicKey, ManifestSigningPublicKey, SecretKey, build_auth_challenge_transcript,
    decrypt_content, decrypt_shard, derive_identity_keypair, derive_link_keys, sign_auth_challenge,
    sign_manifest_with_identity, unwrap_tier_key_from_link, verify_auth_challenge,
    verify_manifest_identity_signature,
};
use mosaic_crypto::{
    BundleValidationContext, SealedBundle, WrappedTierKey, generate_link_secret,
    verify_and_open_bundle,
};
use mosaic_domain::{
    EncryptedMetadataEnvelope, ManifestShardRef, ManifestTranscript, ShardTier,
    canonical_manifest_transcript_bytes,
};
use mosaic_vectors::{
    ParsedVector, default_corpus_dir, load_all, load_vector,
    vectors::{
        AccountUnlockVector, AuthChallengeVector, AuthKeypairVector, ContentEncryptVector,
        EpochDeriveVector, IdentityVector, LinkKeysVector, ManifestTranscriptVector,
        SealedBundleVector, ShardEnvelopeVector, TierKeyWrapVector,
    },
};

fn corpus_path(name: &str) -> PathBuf {
    let mut path = default_corpus_dir();
    path.push(name);
    path
}

fn load(name: &str) -> ParsedVector {
    let path = corpus_path(name);
    match load_vector(&path) {
        Ok(parsed) => parsed,
        Err(error) => panic!("failed to load {}: {error}", path.display()),
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Asserts strongly-typed `serde` decoding succeeds for every corpus file.
///
/// This is the schema gate: any vector with an unknown field or invalid hex
/// fails this test before any cryptographic comparison happens.
#[test]
fn every_corpus_file_parses_against_schema() {
    let dir = default_corpus_dir();
    let parsed = match load_all(&dir) {
        Ok(values) => values,
        Err(error) => panic!("failed to load corpus: {error}"),
    };
    assert!(
        parsed.len() >= 12,
        "expected at least 12 vectors in {}, found {}",
        dir.display(),
        parsed.len()
    );
    for vector in &parsed {
        assert_eq!(
            vector.protocol_version,
            "mosaic-v1",
            "vector {} has unexpected protocolVersion",
            vector.path.display()
        );
        assert!(
            !vector.description.is_empty(),
            "vector {} has empty description",
            vector.path.display()
        );
    }
}

#[test]
fn link_keys_vector_matches_rust_blake2_derivation() {
    let parsed = load("link_keys.json");
    let vector = LinkKeysVector::from(&parsed).expect("link_keys vector");
    let derived = derive_link_keys(&vector.link_secret).expect("derive_link_keys");
    assert_eq!(
        derived.link_id.as_slice(),
        vector.expected_link_id.as_slice(),
        "link_id mismatch"
    );
    assert_eq!(
        derived.wrapping_key.as_bytes(),
        vector.expected_wrapping_key.as_slice(),
        "wrapping_key mismatch"
    );
}

#[test]
fn link_secret_smoke_returns_thirty_two_bytes() {
    // Pure smoke check: exercise the Rust API and assert length only.
    let secret = generate_link_secret().expect("generate_link_secret");
    assert_eq!(
        secret.len(),
        32,
        "generate_link_secret must return 32 bytes"
    );
}

#[test]
#[ignore = "deviation:tier-key-wrap — Rust uses XChaCha20-Poly1305, TS uses XSalsa20-Poly1305 (crypto_secretbox); see tests/vectors/deviations.md"]
fn tier_key_wrap_vector_unwrap_currently_diverges() {
    // Locked here so the test surfaces the moment the deviation is closed.
    let parsed = load("tier_key_wrap.json");
    let vector = TierKeyWrapVector::from(&parsed).expect("tier_key_wrap vector");
    let link_keys = derive_link_keys(&vector.link_secret).expect("derive_link_keys");
    let mut nonce_arr = [0_u8; 24];
    nonce_arr.copy_from_slice(&vector.expected_wrap_nonce);
    let wrapped = WrappedTierKey {
        tier: ShardTier::try_from(vector.tier_byte).expect("tier byte in 1..=3"),
        nonce: nonce_arr,
        encrypted_key: vector.expected_encrypted_key.clone(),
    };
    let unwrapped =
        unwrap_tier_key_from_link(&wrapped, wrapped.tier, &link_keys.wrapping_key).expect("unwrap");
    assert_eq!(
        unwrapped.as_slice(),
        vector.expected_unwrapped_key.as_slice(),
        "tier-key wrap is now cross-client byte-exact: clear the #[ignore] and update deviations.md"
    );
}

#[test]
fn identity_vector_matches_rust_ed25519_derivation() {
    let parsed = load("identity.json");
    let vector = IdentityVector::from(&parsed).expect("identity vector");
    assert_eq!(vector.identity_seed.len(), 32, "identity seed length");
    let mut seed = vector.identity_seed.clone();
    let mut keypair = derive_identity_keypair(&mut seed).expect("derive_identity_keypair");

    assert_eq!(
        keypair.signing_public_key().as_bytes().as_slice(),
        vector.expected_signing_pubkey.as_slice(),
        "signing pubkey mismatch"
    );
    assert_eq!(
        keypair.encryption_public_key().as_bytes().as_slice(),
        vector.expected_encryption_pubkey.as_slice(),
        "encryption pubkey mismatch"
    );

    let signature = sign_manifest_with_identity(&vector.identity_message, keypair.secret_key());
    assert_eq!(
        signature.as_bytes().as_slice(),
        vector.expected_signature.as_slice(),
        "identity signature mismatch"
    );

    // Round-trip verify.
    let pub_decoded = IdentitySigningPublicKey::from_bytes(&vector.expected_signing_pubkey)
        .expect("decode identity pubkey");
    let sig_decoded =
        IdentitySignature::from_bytes(&vector.expected_signature).expect("decode signature");
    assert!(verify_manifest_identity_signature(
        &vector.identity_message,
        &sig_decoded,
        &pub_decoded,
    ));

    // Also derive encryption pubkey via the public re-derivation helper and confirm parity.
    let derived_enc = mosaic_crypto::identity_encryption_public_key_from_signing_public_key(
        &vector.expected_signing_pubkey,
    )
    .expect("derive encryption pubkey from signing pubkey");
    assert_eq!(
        derived_enc.as_bytes().as_slice(),
        vector.expected_encryption_pubkey.as_slice()
    );

    keypair.zeroize_secret();
}

#[test]
fn content_encrypt_vector_decrypt_matches_rust_xchacha20() {
    let parsed = load("content_encrypt.json");
    let vector = ContentEncryptVector::from(&parsed).expect("content_encrypt vector");
    let mut key_bytes = vector.content_key.clone();
    let key = SecretKey::from_bytes(&mut key_bytes).expect("content key");
    let mut nonce = [0_u8; 24];
    nonce.copy_from_slice(&vector.nonce);
    let plaintext = decrypt_content(&vector.expected_ciphertext, &nonce, &key, vector.epoch_id)
        .expect("decrypt_content");
    assert_eq!(
        plaintext.as_slice(),
        vector.expected_decrypted.as_slice(),
        "content plaintext mismatch"
    );
    // Independently verify against the supplied plaintext bytes.
    assert_eq!(
        plaintext.as_slice(),
        vector.plaintext.as_slice(),
        "content plaintext disagrees with inputs.plaintextHex"
    );
}

#[test]
fn shard_envelope_vector_decrypt_matches_rust_xchacha20() {
    let parsed = load("shard_envelope.json");
    let vector = ShardEnvelopeVector::from(&parsed).expect("shard_envelope vector");
    assert_eq!(vector.tiers.len(), 3, "expected three tiers");
    for entry in &vector.tiers {
        let mut key_bytes = entry.tier_key.clone();
        let key = SecretKey::from_bytes(&mut key_bytes).expect("tier key");
        let plaintext = decrypt_shard(&entry.expected_envelope, &key).expect("decrypt_shard");
        assert_eq!(
            plaintext.as_slice(),
            entry.plaintext.as_slice(),
            "tier {} envelope decrypted to wrong plaintext",
            entry.tier
        );

        // Header prefix sanity.
        assert!(
            entry.expected_envelope.len() >= 64,
            "tier {} envelope too short",
            entry.tier
        );
        assert_eq!(
            &entry.expected_envelope[0..4],
            b"SGzk",
            "tier {} envelope magic mismatch",
            entry.tier
        );
        assert_eq!(
            entry.expected_envelope[4], 0x03,
            "tier {} envelope version mismatch",
            entry.tier
        );
        assert_eq!(
            entry.expected_envelope[37], entry.tier,
            "tier {} envelope tier byte mismatch",
            entry.tier
        );
        // Reserved bytes (offset 38..64) must be zero.
        for (offset, byte) in entry.expected_envelope[38..64].iter().enumerate() {
            assert_eq!(
                *byte,
                0,
                "tier {} envelope reserved byte at +{} is non-zero",
                entry.tier,
                38 + offset
            );
        }

        // Verify the captured sha256 matches what mosaic-crypto would compute.
        assert_eq!(
            mosaic_crypto::sha256_bytes(&entry.expected_envelope),
            entry.expected_sha256,
            "tier {} envelope sha256 mismatch",
            entry.tier
        );
    }
}

#[test]
fn auth_challenge_vector_signs_and_verifies_byte_exact() {
    let parsed = load("auth_challenge.json");
    let vector = AuthChallengeVector::from(&parsed).expect("auth_challenge vector");

    // Build transcripts and assert byte-exact reproduction.
    let transcript_no_ts =
        build_auth_challenge_transcript(&vector.username, None, &vector.challenge)
            .expect("build_auth_challenge_transcript no-ts");
    let transcript_ts = build_auth_challenge_transcript(
        &vector.username,
        Some(vector.timestamp_ms),
        &vector.challenge,
    )
    .expect("build_auth_challenge_transcript with-ts");
    assert_eq!(
        transcript_no_ts, vector.expected_transcript_no_ts,
        "transcript (no timestamp) mismatch"
    );
    assert_eq!(
        transcript_ts, vector.expected_transcript_with_ts,
        "transcript (with timestamp) mismatch"
    );

    // Build keypair from the captured signing seed and assert public key.
    let mut seed_bytes = vector.auth_signing_seed.clone();
    let secret = AuthSigningSecretKey::from_seed(&mut seed_bytes).expect("auth signing secret");
    let pubkey = secret.public_key();
    assert_eq!(
        pubkey.as_bytes().as_slice(),
        vector.auth_public_key.as_slice(),
        "auth public key mismatch"
    );

    // Ed25519 is RFC 8032 deterministic so signatures reproduce byte-exactly.
    let sig_no_ts = sign_auth_challenge(&transcript_no_ts, &secret);
    let sig_ts = sign_auth_challenge(&transcript_ts, &secret);
    assert_eq!(
        sig_no_ts.as_bytes().as_slice(),
        vector.expected_signature_no_ts.as_slice(),
        "signature (no timestamp) mismatch"
    );
    assert_eq!(
        sig_ts.as_bytes().as_slice(),
        vector.expected_signature_with_ts.as_slice(),
        "signature (with timestamp) mismatch"
    );

    // Verify path round-trips.
    let pub_decoded =
        AuthSigningPublicKey::from_bytes(&vector.auth_public_key).expect("decode auth pubkey");
    let sig_no_ts_decoded =
        AuthSignature::from_bytes(&vector.expected_signature_no_ts).expect("decode sig no-ts");
    let sig_ts_decoded =
        AuthSignature::from_bytes(&vector.expected_signature_with_ts).expect("decode sig with-ts");
    assert!(verify_auth_challenge(
        &transcript_no_ts,
        &sig_no_ts_decoded,
        &pub_decoded
    ));
    assert!(verify_auth_challenge(
        &transcript_ts,
        &sig_ts_decoded,
        &pub_decoded
    ));
}

#[test]
#[ignore = "deviation:auth-keypair — TS uses BLAKE2b(\"Mosaic_AuthKey_v1\" || L0); Rust uses HKDF-SHA256(salt=user_salt, info=\"mosaic:auth-signing:v1\"). See tests/vectors/deviations.md"]
fn auth_keypair_vector_currently_diverges() {
    let parsed = load("auth_keypair.json");
    let vector = AuthKeypairVector::from(&parsed).expect("auth_keypair vector");
    // Rust's `derive_auth_signing_keypair` consumes (password, user_salt, profile)
    // and runs Argon2id internally — incompatible with this isolated KDF vector.
    // We deliberately do not call it here; the test body simply asserts the
    // captured seed is well-formed so the corpus survives parsing.
    assert_eq!(vector.l0_master_key.len(), 32, "L0 master key length");
    assert_eq!(
        vector.expected_auth_seed.len(),
        32,
        "auth signing seed length"
    );
    assert_eq!(
        vector.expected_auth_public_key.len(),
        32,
        "auth pubkey length"
    );
}

#[test]
#[ignore = "deviation:account-unlock — TS chains BLAKE2b for L1 + crypto_secretbox (XSalsa20) for wrap; Rust uses HKDF-SHA256 + XChaCha20-Poly1305. See tests/vectors/deviations.md"]
fn account_unlock_vector_currently_diverges() {
    let parsed = load("account_unlock.json");
    let vector = AccountUnlockVector::from(&parsed).expect("account_unlock vector");
    // Cannot exercise Rust's `unwrap_account_key` because it expects HKDF/XChaCha
    // wrapping. Surface the corpus shape only.
    assert_eq!(vector.user_salt.len(), 16);
    assert_eq!(vector.account_salt.len(), 16);
    assert_eq!(vector.expected_l1_root_key.len(), 32);
    assert_eq!(vector.expected_account_key.len(), 32);
    assert_eq!(
        vector.wrapped_account_key.len(),
        24 + 32 + 16,
        "wrapped account key has nonce(24) + ciphertext(32) + tag(16)"
    );
}

#[test]
#[ignore = "deviation:epoch-tier-keys — TS derives via BLAKE2b(key=epoch_seed, msg=label); Rust uses HKDF-SHA256(ikm=seed, info=label). See tests/vectors/deviations.md"]
fn epoch_derive_vector_currently_diverges() {
    let parsed = load("epoch_derive.json");
    let vector = EpochDeriveVector::from(&parsed).expect("epoch_derive vector");
    assert_eq!(vector.epoch_seed.len(), 32);
    for (name, sha) in [
        ("thumb", &vector.expected_thumb_key_sha256),
        ("preview", &vector.expected_preview_key_sha256),
        ("full", &vector.expected_full_key_sha256),
        ("content", &vector.expected_content_key_sha256),
    ] {
        assert_eq!(sha.len(), 32, "{name} discriminator length");
    }
}

#[test]
fn sealed_bundle_vector_open_matches_rust_libsodium() {
    let parsed = load("sealed_bundle.json");
    let vector = SealedBundleVector::from(&parsed).expect("sealed_bundle vector");

    // Recipient identity from the recorded seed.
    let mut seed = vector.recipient_identity_seed.clone();
    let mut recipient = derive_identity_keypair(&mut seed).expect("recipient identity");
    let mut signature_arr = [0_u8; 64];
    signature_arr.copy_from_slice(&vector.signature);
    let mut sharer_arr = [0_u8; 32];
    sharer_arr.copy_from_slice(&vector.sharer_pubkey);
    let sealed = SealedBundle {
        sealed: vector.sealed.clone(),
        signature: signature_arr,
        sharer_pubkey: sharer_arr,
    };
    let mut owner_arr = [0_u8; 32];
    owner_arr.copy_from_slice(&vector.expected_owner_ed25519_pub);
    let context = BundleValidationContext {
        album_id: vector.validation_album_id.clone(),
        min_epoch_id: vector.validation_min_epoch_id,
        allow_legacy_empty_album_id: vector.validation_allow_legacy_empty_album_id,
        expected_owner_ed25519_pub: owner_arr,
    };

    let opened = verify_and_open_bundle(&sealed, &recipient, &context).expect("open bundle");
    assert_eq!(opened.version, vector.expected_bundle_version);
    assert_eq!(opened.album_id, vector.expected_bundle_album_id);
    assert_eq!(opened.epoch_id, vector.expected_bundle_epoch_id);
    assert_eq!(
        opened.recipient_pubkey.as_slice(),
        vector.expected_recipient_pubkey.as_slice()
    );
    assert_eq!(
        opened.epoch_seed.as_bytes(),
        vector.expected_epoch_seed.as_slice()
    );
    let expected_sign_pub = ManifestSigningPublicKey::from_bytes(&vector.expected_sign_public_key)
        .expect("decode sign pubkey");
    assert_eq!(
        opened.sign_public_key.as_bytes().as_slice(),
        expected_sign_pub.as_bytes().as_slice()
    );

    recipient.zeroize_secret();
}

#[test]
fn manifest_transcript_vector_matches_rust_canonical_bytes() {
    let parsed = load("manifest_transcript.json");
    assert!(
        parsed.rust_canonical,
        "manifest_transcript.json must declare rust_canonical: true"
    );
    let vector = ManifestTranscriptVector::from(&parsed).expect("manifest_transcript vector");

    assert_eq!(vector.album_id.len(), 16, "album_id length");
    let mut album_id = [0_u8; 16];
    album_id.copy_from_slice(&vector.album_id);

    let envelope = EncryptedMetadataEnvelope::new(&vector.encrypted_meta);
    let shard_refs: Vec<ManifestShardRef> = vector
        .shards
        .iter()
        .map(|shard| {
            let mut shard_id = [0_u8; 16];
            shard_id.copy_from_slice(&shard.shard_id);
            let mut sha256 = [0_u8; 32];
            sha256.copy_from_slice(&shard.sha256);
            ManifestShardRef::new(
                shard.chunk_index,
                shard_id,
                ShardTier::try_from(shard.tier).expect("valid tier byte"),
                sha256,
            )
        })
        .collect();
    let transcript = ManifestTranscript::new(album_id, vector.epoch_id, envelope, &shard_refs);
    let bytes = canonical_manifest_transcript_bytes(&transcript)
        .expect("canonical_manifest_transcript_bytes");
    assert_eq!(
        hex(&bytes),
        hex(&vector.expected_transcript),
        "manifest transcript bytes mismatch"
    );
}
