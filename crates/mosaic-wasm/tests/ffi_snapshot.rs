use mosaic_domain::{ShardEnvelopeHeader, ShardTier};
use mosaic_wasm::{
    close_identity_handle, create_identity_handle, identity_signing_pubkey, parse_envelope_header,
    wasm_api_snapshot, wasm_progress_probe,
};

#[test]
fn wasm_facade_exposes_stable_ffi_spike_surface() {
    assert_eq!(
        wasm_api_snapshot(),
        "mosaic-wasm ffi-spike:v2 parse_envelope_header(bytes)->HeaderResult progress(total,cancel_after)->ProgressResult identity(create/open/close/pubkeys/sign)"
    );
}

#[test]
fn wasm_identity_facade_returns_stable_error_codes() {
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
fn wasm_facade_maps_header_results_without_secret_outputs() {
    let header = ShardEnvelopeHeader::new(11, 12, [7; 24], ShardTier::Preview).to_bytes();

    let result = parse_envelope_header(header.to_vec());

    assert_eq!(result.code, 0);
    assert_eq!(result.epoch_id, 11);
    assert_eq!(result.shard_index, 12);
    assert_eq!(result.tier, 2);
    assert_eq!(result.nonce, vec![7; 24]);
}

#[test]
fn wasm_facade_returns_progress_events_with_stable_error_code() {
    let result = wasm_progress_probe(3, Some(1));

    assert_eq!(result.code, 300);
    assert_eq!(result.events.len(), 1);
    assert_eq!(result.events[0].completed_steps, 1);
}
