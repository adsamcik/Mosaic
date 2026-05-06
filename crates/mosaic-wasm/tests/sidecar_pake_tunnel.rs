//! Sidecar PAKE + tunnel handle-facade tests (native build).
//!
//! Mirrors the Rust-level vector tests but exercises the public WASM
//! handle entry points (`sidecar_*_v1`) so any divergence between the
//! crypto crate API and the WASM marshaling layer is caught here, before
//! we regen the wasm-bindgen output.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use mosaic_wasm::{
    sidecar_pake_initiator_close_v1, sidecar_pake_initiator_finish_v1,
    sidecar_pake_initiator_start_v1, sidecar_pake_responder_close_v1,
    sidecar_pake_responder_finish_v1, sidecar_pake_responder_v1, sidecar_tunnel_close_v1,
    sidecar_tunnel_open_message_v1, sidecar_tunnel_open_v1, sidecar_tunnel_seal_v1,
};

const OK: u32 = 0;
const PAIRING_CODE: &[u8] = b"402938";

fn run_handshake_through_wasm() -> (u32, u32) {
    let init_start = sidecar_pake_initiator_start_v1(PAIRING_CODE);
    assert_eq!(init_start.code, OK);
    let resp = sidecar_pake_responder_v1(PAIRING_CODE, &init_start.msg1);
    assert_eq!(resp.code, OK);
    let init_finish = sidecar_pake_initiator_finish_v1(
        init_start.handle_id,
        &resp.msg2,
        &resp.responder_confirm,
    );
    assert_eq!(init_finish.code, OK);
    let resp_finish =
        sidecar_pake_responder_finish_v1(resp.responder_handle_id, &init_finish.initiator_confirm);
    assert_eq!(resp_finish.code, OK);
    (init_finish.material_handle_id, resp_finish.material_handle_id)
}

#[test]
fn pake_happy_path_through_wasm_handles() {
    let (mat_i, mat_r) = run_handshake_through_wasm();
    assert_ne!(mat_i, 0);
    assert_ne!(mat_r, 0);
    // Tunnel open consumes both material handles.
    let open_i = sidecar_tunnel_open_v1(mat_i);
    let open_r = sidecar_tunnel_open_v1(mat_r);
    assert_eq!(open_i.code, OK);
    assert_eq!(open_r.code, OK);
    _ = sidecar_tunnel_close_v1(open_i.send_handle_id, open_i.recv_handle_id);
    _ = sidecar_tunnel_close_v1(open_r.send_handle_id, open_r.recv_handle_id);
}

#[test]
fn pake_responder_rejects_wrong_code() {
    let init_start = sidecar_pake_initiator_start_v1(b"111111");
    assert_eq!(init_start.code, OK);
    let resp = sidecar_pake_responder_v1(b"222222", &init_start.msg1);
    assert_eq!(resp.code, OK);
    let init_finish = sidecar_pake_initiator_finish_v1(
        init_start.handle_id,
        &resp.msg2,
        &resp.responder_confirm,
    );
    assert_ne!(
        init_finish.code, OK,
        "mismatched code must produce non-zero error code"
    );
    // The responder still has live state; close it explicitly to free.
    _ = sidecar_pake_responder_close_v1(resp.responder_handle_id);
}

#[test]
fn invalid_pairing_code_length_short_circuits_initiator() {
    let r = sidecar_pake_initiator_start_v1(b"12345");
    assert_ne!(r.code, OK);
    assert_eq!(r.handle_id, 0);
    assert!(r.msg1.is_empty());
}

#[test]
fn tunnel_seal_open_roundtrip_through_handles() {
    let (mat_i, mat_r) = run_handshake_through_wasm();
    let open_i = sidecar_tunnel_open_v1(mat_i);
    let open_r = sidecar_tunnel_open_v1(mat_r);
    assert_eq!(open_i.code, OK);
    assert_eq!(open_r.code, OK);

    let seal = sidecar_tunnel_seal_v1(open_i.send_handle_id, b"hello via wasm");
    assert_eq!(seal.code, OK);
    let opened = sidecar_tunnel_open_message_v1(open_r.recv_handle_id, &seal.sealed);
    assert_eq!(opened.code, OK);
    assert_eq!(opened.plaintext, b"hello via wasm");

    _ = sidecar_tunnel_close_v1(open_i.send_handle_id, open_i.recv_handle_id);
    _ = sidecar_tunnel_close_v1(open_r.send_handle_id, open_r.recv_handle_id);
}

#[test]
fn seal_after_close_returns_handle_not_found() {
    let (mat_i, _mat_r) = run_handshake_through_wasm();
    let open_i = sidecar_tunnel_open_v1(mat_i);
    assert_eq!(open_i.code, OK);
    _ = sidecar_tunnel_close_v1(open_i.send_handle_id, open_i.recv_handle_id);

    let after = sidecar_tunnel_seal_v1(open_i.send_handle_id, b"too late");
    assert_ne!(after.code, OK);
    assert!(after.sealed.is_empty());
}

#[test]
fn open_with_unknown_material_handle_fails() {
    let r = sidecar_tunnel_open_v1(0);
    assert_ne!(r.code, OK);
    assert_eq!(r.send_handle_id, 0);
    assert_eq!(r.recv_handle_id, 0);
}

#[test]
fn double_close_pake_initiator_is_idempotent() {
    let init_start = sidecar_pake_initiator_start_v1(PAIRING_CODE);
    assert_eq!(init_start.code, OK);
    assert_eq!(sidecar_pake_initiator_close_v1(init_start.handle_id), OK);
    assert_eq!(sidecar_pake_initiator_close_v1(init_start.handle_id), OK);
}
