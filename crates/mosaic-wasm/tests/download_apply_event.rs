mod common;

use mosaic_client::ClientErrorCode;
use mosaic_wasm::download_apply_event_v1;

#[test]
fn golden_idle_start_requested_becomes_preparing() -> Result<(), String> {
    let result = download_apply_event_v1(&common::state_cbor(0)?, &common::start_event_cbor()?);

    assert_eq!(result.code, u32::from(ClientErrorCode::Ok.as_u16()));
    assert_eq!(result.new_state_cbor, vec![0xa1, 0x00, 0x01]);
    Ok(())
}
