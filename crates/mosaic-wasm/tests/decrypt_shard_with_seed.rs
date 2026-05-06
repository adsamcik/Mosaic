use mosaic_client::ClientErrorCode;
use mosaic_vectors::{load_vector, vectors::ShardEnvelopeVector};
use mosaic_wasm::{decrypt_shard_with_seed_v1, verify_shard_integrity_v1};
use std::path::PathBuf;

fn corpus_path(name: &str) -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let mut path = PathBuf::from(manifest_dir);
    path.pop();
    path.pop();
    path.push("tests");
    path.push("vectors");
    path.push(name);
    path
}

fn vector() -> (Vec<u8>, Vec<u8>, Vec<u8>, [u8; 32]) {
    let parsed = match load_vector(&corpus_path("shard_envelope.json")) {
        Ok(value) => value,
        Err(error) => panic!("shard_envelope.json must load: {error}"),
    };
    let vector = match ShardEnvelopeVector::from(&parsed) {
        Ok(value) => value,
        Err(error) => panic!("shard_envelope.json must parse: {error}"),
    };
    let tier = match vector.tiers.into_iter().find(|tier| tier.tier == 3) {
        Some(value) => value,
        None => panic!("shard_envelope.json must include full tier vector"),
    };
    let digest = decode_base64url_sha256(&tier.expected_sha256);
    (
        tier.tier_key,
        tier.plaintext,
        tier.expected_envelope,
        digest,
    )
}

fn seed(byte: u8) -> Vec<u8> {
    vec![byte; 32]
}

fn decode_base64url_sha256(input: &str) -> [u8; 32] {
    let mut bits: u32 = 0;
    let mut bit_count = 0_u8;
    let mut output = Vec::with_capacity(32);
    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => panic!("invalid base64url byte"),
        };
        bits = (bits << 6) | u32::from(value);
        bit_count += 6;
        while bit_count >= 8 {
            bit_count -= 8;
            output.push(((bits >> bit_count) & 0xff) as u8);
        }
    }
    if output.len() != 32 {
        panic!("sha256 digest must decode to 32 bytes");
    }
    let mut digest = [0_u8; 32];
    digest.copy_from_slice(&output);
    digest
}

fn tamper_last_byte(bytes: &mut [u8]) {
    match bytes.last_mut() {
        Some(byte) => *byte ^= 0x01,
        None => panic!("test vector must not be empty"),
    }
}

#[test]
fn decrypt_shard_with_seed_round_trips_plaintext() {
    let (key, plaintext, envelope, _) = vector();

    let result = decrypt_shard_with_seed_v1(&envelope, &key);

    assert_eq!(result.code, ClientErrorCode::Ok.as_u16() as u32);
    assert_eq!(result.plaintext, plaintext);
}

#[test]
fn decrypt_shard_with_seed_maps_wrong_key_to_download_decrypt() {
    let (_, _, envelope, _) = vector();
    let wrong_key = seed(0x99);

    let result = decrypt_shard_with_seed_v1(&envelope, &wrong_key);

    assert_eq!(
        result.code,
        ClientErrorCode::DownloadDecrypt.as_u16() as u32
    );
    assert!(result.plaintext.is_empty());
}

#[test]
fn decrypt_shard_with_seed_maps_tampered_ciphertext_to_download_decrypt() {
    let (key, _, mut envelope, _) = vector();
    tamper_last_byte(&mut envelope);

    let result = decrypt_shard_with_seed_v1(&envelope, &key);

    assert_eq!(
        result.code,
        ClientErrorCode::DownloadDecrypt.as_u16() as u32
    );
    assert!(result.plaintext.is_empty());
}

#[test]
fn decrypt_shard_with_seed_maps_short_envelope_to_invalid_envelope() {
    let key = seed(0x42);

    let result = decrypt_shard_with_seed_v1(&[0_u8; 12], &key);

    assert_eq!(
        result.code,
        ClientErrorCode::InvalidEnvelope.as_u16() as u32
    );
    assert!(result.plaintext.is_empty());
}

#[test]
fn verify_shard_integrity_accepts_matching_digest() {
    let (_, _, envelope, digest) = vector();

    let result = verify_shard_integrity_v1(&envelope, &digest);

    assert_eq!(result.code, ClientErrorCode::Ok.as_u16() as u32);
}

#[test]
fn verify_shard_integrity_maps_digest_mismatch_to_download_integrity() {
    let (_, _, mut envelope, digest) = vector();
    tamper_last_byte(&mut envelope);

    let result = verify_shard_integrity_v1(&envelope, &digest);

    assert_eq!(
        result.code,
        ClientErrorCode::DownloadIntegrity.as_u16() as u32
    );
}

#[test]
fn verify_shard_integrity_maps_short_envelope_to_invalid_envelope() {
    let (_, _, _, digest) = vector();

    let result = verify_shard_integrity_v1(&[0_u8; 12], &digest);

    assert_eq!(
        result.code,
        ClientErrorCode::InvalidEnvelope.as_u16() as u32
    );
}
