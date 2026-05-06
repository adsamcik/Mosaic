mod common;

use mosaic_client::ClientErrorCode;
use mosaic_wasm::download_apply_event_v1;

#[test]
fn plan_ready_from_idle_is_illegal() -> Result<(), String> {
    let result =
        download_apply_event_v1(&common::state_cbor(0)?, &common::plan_ready_event_cbor()?);

    assert_eq!(
        result.code,
        u32::from(ClientErrorCode::DownloadIllegalTransition.as_u16())
    );
    assert!(result.new_state_cbor.is_empty());
    Ok(())
}
