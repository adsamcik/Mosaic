use mosaic_domain::{ShardEnvelopeHeader, ShardTier};
use mosaic_wasm::{parse_envelope_header, wasm_api_snapshot, wasm_progress_probe};

#[test]
fn wasm_facade_exposes_stable_ffi_spike_surface() {
    assert_eq!(
        wasm_api_snapshot(),
        "mosaic-wasm ffi-spike:v1 parse_envelope_header(bytes)->HeaderResult progress(total,cancel_after)->ProgressResult"
    );
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
