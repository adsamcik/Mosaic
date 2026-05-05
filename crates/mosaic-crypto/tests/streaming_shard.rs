//! Streaming-AEAD round-trip and error-path tests for tier-3 originals.

use mosaic_crypto::{
    MAX_STREAMING_CHUNK_BYTES, MIN_STREAMING_CHUNK_BYTES, MosaicCryptoError, SecretKey,
    STREAMING_CHUNK_TAG_BYTES, STREAMING_ENVELOPE_VARIANT, encrypt_streaming_shard,
    open_streaming_shard,
};
use mosaic_domain::{SHARD_ENVELOPE_HEADER_LEN, ShardTier};

const KEY_A: [u8; 32] = [
    0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00,
    0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 0x90, 0xa0, 0xb0, 0xc0, 0xd0, 0xe0, 0xf0, 0x01,
];
const KEY_B: [u8; 32] = [0xab; 32];
const NONCE: [u8; 24] = [
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
    0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
];

fn key(bytes: [u8; 32]) -> SecretKey {
    let mut buf = bytes;
    match SecretKey::from_bytes(&mut buf) {
        Ok(value) => value,
        Err(error) => panic!("32-byte key must be accepted: {error:?}"),
    }
}

fn header_array(envelope: &[u8]) -> [u8; SHARD_ENVELOPE_HEADER_LEN] {
    let mut header = [0_u8; SHARD_ENVELOPE_HEADER_LEN];
    header.copy_from_slice(&envelope[..SHARD_ENVELOPE_HEADER_LEN]);
    header
}

fn build_envelope(
    plaintext: &[u8],
    chunk_size: u32,
) -> (Vec<u8>, [u8; SHARD_ENVELOPE_HEADER_LEN]) {
    let envelope = match encrypt_streaming_shard(
        plaintext,
        &key(KEY_A),
        7,
        2,
        ShardTier::Original,
        NONCE,
        chunk_size,
    ) {
        Ok(value) => value,
        Err(error) => panic!("encrypt_streaming_shard must succeed: {error:?}"),
    };
    let header = header_array(&envelope);
    (envelope, header)
}

fn split_chunks(envelope: &[u8], chunk_size: u32) -> Vec<&[u8]> {
    let mut chunks = Vec::new();
    let mut offset = SHARD_ENVELOPE_HEADER_LEN;
    let on_wire_chunk = chunk_size as usize + STREAMING_CHUNK_TAG_BYTES;
    while offset + on_wire_chunk < envelope.len() {
        chunks.push(&envelope[offset..offset + on_wire_chunk]);
        offset += on_wire_chunk;
    }
    chunks.push(&envelope[offset..]);
    chunks
}

#[test]
fn round_trip_three_full_chunks_plus_partial_final() {
    let chunk_size = MIN_STREAMING_CHUNK_BYTES;
    let mut plaintext = vec![0_u8; (chunk_size as usize) * 3 + 1024];
    for (index, byte) in plaintext.iter_mut().enumerate() {
        *byte = (index % 251) as u8;
    }
    let (envelope, header) = build_envelope(&plaintext, chunk_size);
    let chunks = split_chunks(&envelope, chunk_size);
    assert_eq!(chunks.len(), 4, "expected 3 full + 1 final chunk");

    let mut decryptor = match open_streaming_shard(&header, &key(KEY_A)) {
        Ok(value) => value,
        Err(error) => panic!("open_streaming_shard must succeed: {error:?}"),
    };
    assert_eq!(decryptor.chunk_size_bytes(), chunk_size);
    assert!(!decryptor.is_finished());

    let mut recovered = Vec::with_capacity(plaintext.len());
    for chunk in &chunks[..chunks.len() - 1] {
        match decryptor.process_chunk(chunk) {
            Ok(plain) => recovered.extend_from_slice(&plain),
            Err(error) => panic!("process_chunk must succeed: {error:?}"),
        }
    }
    match decryptor.finish_chunk(chunks[chunks.len() - 1]) {
        Ok(plain) => recovered.extend_from_slice(&plain),
        Err(error) => panic!("finish_chunk must succeed: {error:?}"),
    }
    assert!(decryptor.is_finished());
    assert_eq!(recovered, plaintext);
}

#[test]
fn round_trip_single_chunk_envelope() {
    let chunk_size = MIN_STREAMING_CHUNK_BYTES;
    let plaintext = vec![0xa5_u8; (chunk_size as usize) - 7];
    let (envelope, header) = build_envelope(&plaintext, chunk_size);
    let chunks = split_chunks(&envelope, chunk_size);
    assert_eq!(chunks.len(), 1);

    let mut decryptor = match open_streaming_shard(&header, &key(KEY_A)) {
        Ok(value) => value,
        Err(error) => panic!("open_streaming_shard must succeed: {error:?}"),
    };
    let pt = match decryptor.finish_chunk(chunks[0]) {
        Ok(plain) => plain,
        Err(error) => panic!("finish_chunk must succeed: {error:?}"),
    };
    assert_eq!(pt.as_slice(), plaintext.as_slice());
}

#[test]
fn wrong_key_fails_authentication() {
    let chunk_size = MIN_STREAMING_CHUNK_BYTES;
    let plaintext = vec![0x42_u8; (chunk_size as usize) + 100];
    let (envelope, header) = build_envelope(&plaintext, chunk_size);
    let chunks = split_chunks(&envelope, chunk_size);

    let mut decryptor = match open_streaming_shard(&header, &key(KEY_B)) {
        Ok(value) => value,
        Err(error) => panic!("open with wrong key parses header: {error:?}"),
    };
    let error = match decryptor.process_chunk(chunks[0]) {
        Ok(_) => panic!("wrong key must fail authentication"),
        Err(error) => error,
    };
    assert_eq!(error, MosaicCryptoError::AuthenticationFailed);
}

#[test]
fn tampered_chunk_fails_authentication() {
    let chunk_size = MIN_STREAMING_CHUNK_BYTES;
    let plaintext = vec![0x33_u8; (chunk_size as usize) * 2 + 1];
    let (mut envelope, header) = build_envelope(&plaintext, chunk_size);
    envelope[SHARD_ENVELOPE_HEADER_LEN + 8] ^= 0x80;
    let chunks = split_chunks(&envelope, chunk_size);

    let mut decryptor = match open_streaming_shard(&header, &key(KEY_A)) {
        Ok(value) => value,
        Err(error) => panic!("open must succeed: {error:?}"),
    };
    let error = match decryptor.process_chunk(chunks[0]) {
        Ok(_) => panic!("tampered chunk must fail authentication"),
        Err(error) => error,
    };
    assert_eq!(error, MosaicCryptoError::AuthenticationFailed);
}

#[test]
fn out_of_order_chunks_fail_authentication() {
    let chunk_size = MIN_STREAMING_CHUNK_BYTES;
    let plaintext = vec![0x77_u8; (chunk_size as usize) * 2 + 32];
    let (envelope, header) = build_envelope(&plaintext, chunk_size);
    let chunks = split_chunks(&envelope, chunk_size);
    assert!(chunks.len() >= 3);

    let mut decryptor = match open_streaming_shard(&header, &key(KEY_A)) {
        Ok(value) => value,
        Err(error) => panic!("open must succeed: {error:?}"),
    };
    let error = match decryptor.process_chunk(chunks[1]) {
        Ok(_) => panic!("out-of-order chunk must fail authentication"),
        Err(error) => error,
    };
    assert_eq!(error, MosaicCryptoError::AuthenticationFailed);
}

#[test]
fn variant_zero_envelope_is_rejected_as_streaming() {
    let mut header = [0_u8; SHARD_ENVELOPE_HEADER_LEN];
    header[0..4].copy_from_slice(b"SGzk");
    header[4] = 0x03;
    header[5..9].copy_from_slice(&7_u32.to_le_bytes());
    header[9..13].copy_from_slice(&2_u32.to_le_bytes());
    header[13..37].copy_from_slice(&NONCE);
    header[37] = ShardTier::Original.to_byte();

    let error = match open_streaming_shard(&header, &key(KEY_A)) {
        Ok(_) => panic!("variant 0 must be rejected by streaming open"),
        Err(error) => error,
    };
    assert_eq!(error, MosaicCryptoError::InvalidEnvelope);
}

#[test]
fn invalid_chunk_size_in_header_is_rejected() {
    let chunk_size = MIN_STREAMING_CHUNK_BYTES;
    let plaintext = vec![0_u8; (chunk_size as usize) + 1];
    let (envelope, mut header) = build_envelope(&plaintext, chunk_size);
    let _ = envelope;
    header[39..43].copy_from_slice(&0_u32.to_le_bytes());
    let error = match open_streaming_shard(&header, &key(KEY_A)) {
        Ok(_) => panic!("zero chunk size must be rejected"),
        Err(error) => error,
    };
    assert_eq!(error, MosaicCryptoError::InvalidEnvelope);

    header[39..43].copy_from_slice(&(MAX_STREAMING_CHUNK_BYTES + 1).to_le_bytes());
    let error = match open_streaming_shard(&header, &key(KEY_A)) {
        Ok(_) => panic!("oversize chunk size must be rejected"),
        Err(error) => error,
    };
    assert_eq!(error, MosaicCryptoError::InvalidEnvelope);
}

#[test]
fn process_after_finish_returns_invalid_envelope() {
    let chunk_size = MIN_STREAMING_CHUNK_BYTES;
    let plaintext = vec![0x11_u8; 256];
    let (envelope, header) = build_envelope(&plaintext, chunk_size);
    let chunks = split_chunks(&envelope, chunk_size);

    let mut decryptor = match open_streaming_shard(&header, &key(KEY_A)) {
        Ok(value) => value,
        Err(error) => panic!("open must succeed: {error:?}"),
    };
    if let Err(error) = decryptor.finish_chunk(chunks[0]) {
        panic!("finish_chunk must succeed: {error:?}");
    }
    assert!(decryptor.is_finished());
    let error = match decryptor.process_chunk(b"") {
        Ok(_) => panic!("post-finish process must fail"),
        Err(error) => error,
    };
    assert_eq!(error, MosaicCryptoError::InvalidEnvelope);
}

#[test]
fn variant_byte_constant_is_one() {
    assert_eq!(STREAMING_ENVELOPE_VARIANT, 1);
}