use mosaic_client::{
    ClientErrorCode, ProgressEvent, close_secret_handle, ffi_spike_probe_key, open_secret_handle,
    parse_shard_header_for_ffi, run_progress_probe, secret_handle_is_open,
};
use mosaic_domain::{ShardEnvelopeHeader, ShardTier};

const NONCE: [u8; 24] = [
    0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf, 0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9,
    0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xc0, 0xc1,
];

#[test]
fn parse_shard_header_maps_domain_errors_to_stable_codes() {
    let mut bytes = ShardEnvelopeHeader::new(1, 2, NONCE, ShardTier::Thumbnail).to_bytes();
    bytes[38] = 9;

    let result = parse_shard_header_for_ffi(&bytes);

    assert_eq!(result.code, ClientErrorCode::NonZeroReservedByte);
    assert_eq!(result.epoch_id, 0);
    assert_eq!(result.nonce, Vec::<u8>::new());
}

#[test]
fn parse_shard_header_returns_public_header_fields_only() {
    let bytes = ShardEnvelopeHeader::new(5, 9, NONCE, ShardTier::Original).to_bytes();

    let result = parse_shard_header_for_ffi(&bytes);

    assert_eq!(result.code, ClientErrorCode::Ok);
    assert_eq!(result.epoch_id, 5);
    assert_eq!(result.shard_index, 9);
    assert_eq!(result.tier, 3);
    assert_eq!(result.nonce, NONCE.to_vec());
}

#[test]
fn opaque_secret_handles_can_be_closed_without_revealing_secret_bytes() {
    let secret = b"not returned over ffi";
    let handle = match open_secret_handle(secret) {
        Ok(value) => value,
        Err(error) => panic!("secret handle should open: {error:?}"),
    };

    let is_open = match secret_handle_is_open(handle) {
        Ok(value) => value,
        Err(error) => panic!("handle lookup should succeed: {error:?}"),
    };
    assert!(is_open);

    if let Err(error) = close_secret_handle(handle) {
        panic!("handle should close once: {error:?}");
    }

    let is_open = match secret_handle_is_open(handle) {
        Ok(value) => value,
        Err(error) => panic!("closed handle lookup should succeed: {error:?}"),
    };
    assert!(!is_open);

    let error = match close_secret_handle(handle) {
        Ok(()) => panic!("closing twice should fail"),
        Err(error) => error,
    };
    assert_eq!(error.code, ClientErrorCode::SecretHandleNotFound);
}

#[test]
fn progress_probe_reports_steps_and_cancellation() {
    let result = run_progress_probe(4, Some(2));

    assert_eq!(result.code, ClientErrorCode::OperationCancelled);
    assert_eq!(
        result.events,
        vec![
            ProgressEvent {
                completed_steps: 1,
                total_steps: 4,
            },
            ProgressEvent {
                completed_steps: 2,
                total_steps: 4,
            },
        ]
    );
}

#[test]
fn ffi_probe_key_is_available_only_as_an_explicit_spike_operation() {
    let result = ffi_spike_probe_key(b"input", b"context");

    assert_eq!(result.code, ClientErrorCode::Ok);
    assert_eq!(result.bytes.len(), 32);
}
