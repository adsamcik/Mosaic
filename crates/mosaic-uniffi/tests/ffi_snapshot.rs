use mosaic_domain::{ShardEnvelopeHeader, ShardTier};
use mosaic_uniffi::{
    android_progress_probe, close_identity_handle, create_identity_handle, identity_signing_pubkey,
    parse_envelope_header, uniffi_api_snapshot,
};

#[test]
fn uniffi_facade_exposes_stable_ffi_spike_surface() {
    assert_eq!(
        uniffi_api_snapshot(),
        "mosaic-uniffi ffi-spike:v2 parse_envelope_header(bytes)->HeaderResult progress(total,cancel_after)->ProgressResult identity(create/open/close/pubkeys/sign)"
    );
}

#[test]
fn uniffi_identity_facade_returns_stable_error_codes() {
    let create_result = create_identity_handle(u64::MAX);
    assert_eq!(create_result.code, 400);
    assert_eq!(create_result.handle, 0);
    assert!(create_result.signing_pubkey.is_empty());

    let pubkey_result = identity_signing_pubkey(u64::MAX);
    assert_eq!(pubkey_result.code, 401);
    assert!(pubkey_result.bytes.is_empty());

    assert_eq!(close_identity_handle(u64::MAX), 401);
}

#[test]
fn uniffi_facade_maps_header_results_without_secret_outputs() {
    let header = ShardEnvelopeHeader::new(21, 22, [9; 24], ShardTier::Original).to_bytes();

    let result = parse_envelope_header(header.to_vec());

    assert_eq!(result.code, 0);
    assert_eq!(result.epoch_id, 21);
    assert_eq!(result.shard_index, 22);
    assert_eq!(result.tier, 3);
    assert_eq!(result.nonce, vec![9; 24]);
}

#[test]
fn uniffi_facade_returns_progress_events_with_stable_error_code() {
    let result = android_progress_probe(3, Some(1));

    assert_eq!(result.code, 300);
    assert_eq!(result.events.len(), 1);
    assert_eq!(result.events[0].completed_steps, 1);
}
