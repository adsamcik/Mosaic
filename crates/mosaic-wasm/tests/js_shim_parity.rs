#![cfg(target_arch = "wasm32")]

use mosaic_wasm::{finalize_idempotency_key_js, manifest_transcript_bytes_js};
use wasm_bindgen_test::wasm_bindgen_test;

const ALBUM_ID_BYTES: [u8; 16] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
];

#[wasm_bindgen_test]
fn js_shim_finalize_idempotency_key_matches_parity_vector() {
    let key = finalize_idempotency_key_js("01950000-0000-7000-8000-000000000000".to_owned())
        .expect("valid UUIDv7 should produce a finalize idempotency key");

    assert_eq!(key, "mosaic-finalize-01950000-0000-7000-8000-000000000000");
}

#[wasm_bindgen_test]
fn js_shim_manifest_transcript_bytes_matches_parity_vector() {
    let encrypted_meta = vec![0xaa, 0xbb, 0xcc];
    let result = manifest_transcript_bytes_js(
        ALBUM_ID_BYTES.to_vec(),
        7,
        encrypted_meta,
        encoded_manifest_shards(),
    );

    assert_eq!(result.code(), 0);
    assert_eq!(result.bytes().len(), 156);
}

fn encoded_manifest_shards() -> Vec<u8> {
    let mut bytes = Vec::new();
    append_manifest_shard(&mut bytes, 0, 1, [0x10; 16], [0x11; 32]);
    append_manifest_shard(&mut bytes, 1, 3, [0x20; 16], [0x22; 32]);
    bytes
}

fn append_manifest_shard(
    bytes: &mut Vec<u8>,
    shard_index: u32,
    tier: u8,
    shard_id: [u8; 16],
    sha256: [u8; 32],
) {
    bytes.extend_from_slice(&shard_index.to_le_bytes());
    bytes.push(tier);
    bytes.extend_from_slice(&shard_id);
    bytes.extend_from_slice(&sha256);
}
