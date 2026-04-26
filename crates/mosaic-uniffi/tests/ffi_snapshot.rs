use mosaic_domain::{ShardEnvelopeHeader, ShardTier};
use mosaic_uniffi::{android_progress_probe, parse_envelope_header, uniffi_api_snapshot};

#[test]
fn uniffi_facade_exposes_stable_ffi_spike_surface() {
    assert_eq!(
        uniffi_api_snapshot(),
        "mosaic-uniffi ffi-spike:v1 parse_envelope_header(bytes)->HeaderResult progress(total,cancel_after)->ProgressResult"
    );
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
