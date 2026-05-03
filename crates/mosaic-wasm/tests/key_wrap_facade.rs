//! WASM facade tests for key-wrap exports (`wrapKey`, `unwrapKey`).
//!
//! Covers round-trip wrap/unwrap with a caller-supplied 32-byte wrapper key,
//! and rejection of malformed inputs.

use mosaic_client::ClientErrorCode;
use mosaic_wasm::{unwrap_key, wrap_key};

#[test]
fn wrap_and_unwrap_round_trips_arbitrary_payload() {
    let key_bytes = b"top secret payload bytes".to_vec();
    let wrapper_key = vec![0xa5_u8; 32];

    let wrapped = wrap_key(key_bytes.clone(), wrapper_key.clone());
    assert_eq!(wrapped.code, 0);
    assert!(wrapped.bytes.len() >= 24 + key_bytes.len() + 16);

    let unwrapped = unwrap_key(wrapped.bytes, wrapper_key);
    assert_eq!(unwrapped.code, 0);
    assert_eq!(unwrapped.bytes, key_bytes);
}

#[test]
fn wrap_rejects_short_wrapper_key() {
    let result = wrap_key(b"payload".to_vec(), vec![0_u8; 31]);
    assert_eq!(result.code, ClientErrorCode::InvalidKeyLength.as_u16());
    assert!(result.bytes.is_empty());
}

#[test]
fn wrap_rejects_empty_payload() {
    let result = wrap_key(Vec::new(), vec![0xa5_u8; 32]);
    assert_eq!(result.code, ClientErrorCode::InvalidInputLength.as_u16());
}

#[test]
fn unwrap_rejects_short_wrapper_key() {
    let result = unwrap_key(vec![0_u8; 64], vec![0_u8; 31]);
    assert_eq!(result.code, ClientErrorCode::InvalidKeyLength.as_u16());
    assert!(result.bytes.is_empty());
}

#[test]
fn unwrap_rejects_short_blob() {
    let result = unwrap_key(vec![0_u8; 24], vec![0xa5_u8; 32]);
    assert_eq!(result.code, ClientErrorCode::WrappedKeyTooShort.as_u16());
}

#[test]
fn unwrap_rejects_tampered_ciphertext() {
    let key_bytes = b"abcdef0123456789abcdef0123456789".to_vec();
    let wrapper_key = vec![0x33_u8; 32];

    let wrapped = wrap_key(key_bytes.clone(), wrapper_key.clone());
    assert_eq!(wrapped.code, 0);

    let mut tampered = wrapped.bytes.clone();
    let tail = tampered.len() - 1;
    tampered[tail] ^= 0x80;

    let result = unwrap_key(tampered, wrapper_key);
    assert_eq!(result.code, ClientErrorCode::AuthenticationFailed.as_u16());
}
