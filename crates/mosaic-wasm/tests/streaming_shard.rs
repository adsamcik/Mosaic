//! WASM facade tests for the streaming-AEAD shard primitives (envelope variant 1).

use mosaic_client::ClientErrorCode;
use mosaic_crypto::{
    MIN_STREAMING_CHUNK_BYTES, STREAMING_CHUNK_TAG_BYTES, SecretKey, encrypt_streaming_shard,
};
use mosaic_domain::{SHARD_ENVELOPE_HEADER_LEN, ShardTier};
use mosaic_wasm::{
    open_streaming_shard_v1, streaming_shard_close_v1, streaming_shard_process_chunk_v1,
};

const KEY_A: [u8; 32] = [0xa1; 32];
const KEY_B: [u8; 32] = [0xb2; 32];
const NONCE: [u8; 24] = [
    0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x30,
    0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38,
];

fn make_key(bytes: [u8; 32]) -> SecretKey {
    let mut buf = bytes;
    match SecretKey::from_bytes(&mut buf) {
        Ok(value) => value,
        Err(error) => panic!("32-byte key must be accepted: {error:?}"),
    }
}

fn build(plaintext: &[u8]) -> (Vec<u8>, [u8; SHARD_ENVELOPE_HEADER_LEN], u32) {
    let chunk_size = MIN_STREAMING_CHUNK_BYTES;
    let envelope = match encrypt_streaming_shard(
        plaintext,
        &make_key(KEY_A),
        9,
        4,
        ShardTier::Original,
        NONCE,
        chunk_size,
    ) {
        Ok(value) => value,
        Err(error) => panic!("encrypt_streaming_shard failed: {error:?}"),
    };
    let mut header = [0_u8; SHARD_ENVELOPE_HEADER_LEN];
    header.copy_from_slice(&envelope[..SHARD_ENVELOPE_HEADER_LEN]);
    (envelope, header, chunk_size)
}

fn split(envelope: &[u8], chunk_size: u32) -> Vec<&[u8]> {
    let mut chunks = Vec::new();
    let mut offset = SHARD_ENVELOPE_HEADER_LEN;
    let on_wire = chunk_size as usize + STREAMING_CHUNK_TAG_BYTES;
    while offset + on_wire < envelope.len() {
        chunks.push(&envelope[offset..offset + on_wire]);
        offset += on_wire;
    }
    chunks.push(&envelope[offset..]);
    chunks
}

#[test]
fn open_process_finish_round_trip() {
    let plaintext = vec![0x5e_u8; (MIN_STREAMING_CHUNK_BYTES as usize) * 2 + 99];
    let (envelope, header, chunk_size) = build(&plaintext);
    let chunks = split(&envelope, chunk_size);

    let open = open_streaming_shard_v1(&header, &KEY_A);
    assert_eq!(open.code, u32::from(ClientErrorCode::Ok.as_u16()));
    assert_eq!(open.chunk_size_bytes, chunk_size);
    assert_ne!(open.handle_id, 0);

    let mut recovered = Vec::with_capacity(plaintext.len());
    for (index, chunk) in chunks.iter().enumerate() {
        let is_final = index + 1 == chunks.len();
        let result = streaming_shard_process_chunk_v1(open.handle_id, chunk, is_final);
        assert_eq!(
            result.code,
            u32::from(ClientErrorCode::Ok.as_u16()),
            "chunk {index} must succeed"
        );
        recovered.extend_from_slice(&result.plaintext);
    }
    assert_eq!(recovered, plaintext);

    // Final chunk auto-removes the registry entry, so a subsequent close is a no-op.
    let close_code = streaming_shard_close_v1(open.handle_id);
    assert_eq!(close_code, u32::from(ClientErrorCode::Ok.as_u16()));
}

#[test]
fn wrong_key_returns_decrypt_error() {
    let plaintext = vec![0xaa_u8; (MIN_STREAMING_CHUNK_BYTES as usize) + 1];
    let (envelope, header, chunk_size) = build(&plaintext);
    let chunks = split(&envelope, chunk_size);

    let open = open_streaming_shard_v1(&header, &KEY_B);
    assert_eq!(open.code, u32::from(ClientErrorCode::Ok.as_u16()));
    let result = streaming_shard_process_chunk_v1(open.handle_id, chunks[0], false);
    assert_eq!(
        result.code,
        u32::from(ClientErrorCode::DownloadDecrypt.as_u16())
    );
    // Failed mid-stream chunks remove the entry; a subsequent process must
    // report SecretHandleNotFound.
    let again = streaming_shard_process_chunk_v1(open.handle_id, chunks[0], false);
    assert_eq!(
        again.code,
        u32::from(ClientErrorCode::SecretHandleNotFound.as_u16())
    );
}

#[test]
fn variant_zero_envelope_is_rejected_with_invalid_envelope() {
    let mut header = [0_u8; SHARD_ENVELOPE_HEADER_LEN];
    header[0..4].copy_from_slice(b"SGzk");
    header[4] = 0x03;
    header[13..37].copy_from_slice(&NONCE);
    header[37] = ShardTier::Original.to_byte();
    let open = open_streaming_shard_v1(&header, &KEY_A);
    assert_eq!(open.handle_id, 0);
    assert_eq!(
        open.code,
        u32::from(ClientErrorCode::InvalidEnvelope.as_u16())
    );
}

#[test]
fn invalid_header_length_is_rejected() {
    let open = open_streaming_shard_v1(&[0_u8; 32], &KEY_A);
    assert_eq!(open.handle_id, 0);
    assert_eq!(
        open.code,
        u32::from(ClientErrorCode::InvalidHeaderLength.as_u16())
    );
}

#[test]
fn close_handle_is_idempotent() {
    let plaintext = vec![0x9c_u8; 256];
    let (_, header, _) = build(&plaintext);
    let open = open_streaming_shard_v1(&header, &KEY_A);
    assert_eq!(open.code, u32::from(ClientErrorCode::Ok.as_u16()));
    assert_eq!(
        streaming_shard_close_v1(open.handle_id),
        u32::from(ClientErrorCode::Ok.as_u16())
    );
    // Second close on the same id is a no-op (still Ok).
    assert_eq!(
        streaming_shard_close_v1(open.handle_id),
        u32::from(ClientErrorCode::Ok.as_u16())
    );
    // Process after close returns SecretHandleNotFound.
    let result = streaming_shard_process_chunk_v1(open.handle_id, b"", true);
    assert_eq!(
        result.code,
        u32::from(ClientErrorCode::SecretHandleNotFound.as_u16())
    );
}

#[test]
fn handle_ids_are_distinct_across_opens() {
    let plaintext = vec![0x12_u8; 256];
    let (_, header, _) = build(&plaintext);
    let a = open_streaming_shard_v1(&header, &KEY_A);
    let b = open_streaming_shard_v1(&header, &KEY_A);
    assert_ne!(a.handle_id, b.handle_id);
    assert_eq!(
        streaming_shard_close_v1(a.handle_id),
        u32::from(ClientErrorCode::Ok.as_u16())
    );
    assert_eq!(
        streaming_shard_close_v1(b.handle_id),
        u32::from(ClientErrorCode::Ok.as_u16())
    );
}
