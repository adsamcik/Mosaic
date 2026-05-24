// SPDX-License-Identifier: MIT
// Auto-organized from cross_platform_parity.rs as part of v1.0.2 monolith-test-files
// split. Each split file exercises one domain of cross-facade parity tests.
// See `tests/common/mod.rs` for shared imports, constants, and helpers.
#![allow(clippy::expect_used)]

mod common;
use common::*;

#[test]
fn share_link_url_builder_matches_wasm_and_uniffi() {
    let base_url = "https://photos.example.test/";
    let album_id = ALBUM_ID;
    let link_id = "AbCdEf0123456789_-link";
    let link_url_token = "token-fragment_123";

    let album_uuid = mosaic_client::Uuid::from_bytes(ALBUM_ID_BYTES);
    let client =
        mosaic_client::build_share_link_url(base_url, &album_uuid, link_id, link_url_token);
    let wasm = mosaic_wasm::build_share_link_url(
        base_url.to_owned(),
        album_id.to_owned(),
        link_id.to_owned(),
        link_url_token.to_owned(),
    );
    let uniffi = mosaic_uniffi::build_share_link_url(
        base_url.to_owned(),
        album_id.to_owned(),
        link_id.to_owned(),
        link_url_token.to_owned(),
    );

    assert_eq!(client, wasm);
    assert_eq!(client, uniffi);
    assert_eq!(
        client,
        "https://photos.example.test/s/AbCdEf0123456789_-link#k=token-fragment_123"
    );
}


#[test]
fn sidecar_room_id_matches_known_vector_across_crypto_wasm_and_uniffi() {
    let msg1: Vec<u8> = (0_u8..32).collect();
    let expected = vec![
        0xd7, 0x2d, 0x27, 0x3f, 0x50, 0x64, 0x0b, 0x66, 0x21, 0x77, 0xa9, 0xe5, 0x32, 0x67, 0xe1,
        0x28,
    ];

    assert_eq!(
        mosaic_crypto::SIDECAR_ROOM_HKDF_INFO,
        b"mosaic.sidecar.v1.room"
    );

    let crypto = mosaic_crypto::derive_sidecar_room_id(&msg1).to_vec();
    let wasm = mosaic_wasm::derive_sidecar_room_id(msg1.clone());
    let uniffi = mosaic_uniffi::derive_sidecar_room_id(msg1);

    assert_eq!(crypto, expected);
    assert_eq!(wasm, expected);
    assert_eq!(uniffi, expected);
}

#[cfg(feature = "cross-client-vectors")]
#[test]
fn sidecar_pake_initiator_responder_round_trip_across_wasm_and_uniffi() {
    let code = b"123456".to_vec();

    let wasm_start = mosaic_wasm::sidecar_pake_initiator_start_v1(&code);
    assert_ok_u32(wasm_start.code, "wasm PAKE initiator start");
    let uniffi_response =
        mosaic_uniffi::sidecar_pake_responder_v1(code.clone(), wasm_start.msg1.clone());
    assert_ok_u32(uniffi_response.code, "uniffi PAKE responder");
    let wasm_finish = mosaic_wasm::sidecar_pake_initiator_finish_v1(
        wasm_start.handle_id,
        &uniffi_response.msg2,
        &uniffi_response.responder_confirm,
    );
    assert_ok_u32(wasm_finish.code, "wasm PAKE initiator finish");
    let uniffi_finish = mosaic_uniffi::sidecar_pake_responder_finish_v1(
        uniffi_response.responder_handle_id,
        wasm_finish.initiator_confirm.clone(),
    );
    assert_ok_u32(uniffi_finish.code, "uniffi PAKE responder finish");

    let wasm_seed =
        mosaic_wasm::sidecar_tunnel_material_seed_for_tests(wasm_finish.material_handle_id);
    let uniffi_seed =
        mosaic_uniffi::sidecar_tunnel_material_seed_for_tests(uniffi_finish.material_handle_id);
    assert_ok(wasm_seed.code, "wasm PAKE seed");
    assert_ok(uniffi_seed.code, "uniffi PAKE seed");
    assert_eq!(wasm_seed.bytes, uniffi_seed.bytes);

    let uniffi_start = mosaic_uniffi::sidecar_pake_initiator_start_v1(code.clone());
    assert_ok_u32(uniffi_start.code, "uniffi PAKE initiator start");
    let wasm_response = mosaic_wasm::sidecar_pake_responder_v1(&code, &uniffi_start.msg1);
    assert_ok_u32(wasm_response.code, "wasm PAKE responder");
    let uniffi_finish = mosaic_uniffi::sidecar_pake_initiator_finish_v1(
        uniffi_start.handle_id,
        wasm_response.msg2.clone(),
        wasm_response.responder_confirm.clone(),
    );
    assert_ok_u32(uniffi_finish.code, "uniffi PAKE initiator finish");
    let wasm_finish = mosaic_wasm::sidecar_pake_responder_finish_v1(
        wasm_response.responder_handle_id,
        &uniffi_finish.initiator_confirm,
    );
    assert_ok_u32(wasm_finish.code, "wasm PAKE responder finish");

    let uniffi_seed =
        mosaic_uniffi::sidecar_tunnel_material_seed_for_tests(uniffi_finish.material_handle_id);
    let wasm_seed =
        mosaic_wasm::sidecar_tunnel_material_seed_for_tests(wasm_finish.material_handle_id);
    assert_ok(uniffi_seed.code, "uniffi reverse PAKE seed");
    assert_ok(wasm_seed.code, "wasm reverse PAKE seed");
    assert_eq!(uniffi_seed.bytes, wasm_seed.bytes);
}

#[cfg(feature = "cross-client-vectors")]
#[test]
fn sidecar_tunnel_seal_open_round_trip_across_wasm_and_uniffi() {
    let seed = fixed_sidecar_seed();
    let wasm_material = mosaic_wasm::sidecar_tunnel_material_from_seed_for_tests(seed.to_vec(), 0);
    assert_ok_u32(wasm_material.code, "wasm fixed initiator material");
    let uniffi_material =
        mosaic_uniffi::sidecar_tunnel_material_from_seed_for_tests(seed.to_vec(), 1);
    assert_ok_u32(uniffi_material.code, "uniffi fixed responder material");

    let wasm_tunnel = mosaic_wasm::sidecar_tunnel_open_v1(wasm_material.material_handle_id);
    assert_ok_u32(wasm_tunnel.code, "wasm tunnel open");
    let uniffi_tunnel = mosaic_uniffi::sidecar_tunnel_open_v1(uniffi_material.material_handle_id);
    assert_ok_u32(uniffi_tunnel.code, "uniffi tunnel open");

    let plaintext = b"wasm-to-uniffi fixed sidecar tunnel frame".to_vec();
    let wasm_sealed = mosaic_wasm::sidecar_tunnel_seal_v1(wasm_tunnel.send_handle_id, &plaintext);
    assert_ok_u32(wasm_sealed.code, "wasm tunnel seal");
    let uniffi_open = mosaic_uniffi::sidecar_tunnel_open_message_v1(
        uniffi_tunnel.recv_handle_id,
        wasm_sealed.sealed.clone(),
    );
    assert_ok_u32(uniffi_open.code, "uniffi tunnel open wasm frame");
    assert_eq!(uniffi_open.plaintext, plaintext);

    let reverse_plaintext = b"uniffi-to-wasm fixed sidecar tunnel frame".to_vec();
    let uniffi_sealed = mosaic_uniffi::sidecar_tunnel_seal_v1(
        uniffi_tunnel.send_handle_id,
        reverse_plaintext.clone(),
    );
    assert_ok_u32(uniffi_sealed.code, "uniffi tunnel seal");
    let wasm_open = mosaic_wasm::sidecar_tunnel_open_message_v1(
        wasm_tunnel.recv_handle_id,
        &uniffi_sealed.sealed,
    );
    assert_ok_u32(wasm_open.code, "wasm tunnel open uniffi frame");
    assert_eq!(wasm_open.plaintext, reverse_plaintext);

    assert_eq!(
        hex_lower(&wasm_sealed.sealed),
        "00000000000000001c176dc7c1b62c0d74bdf421334a604915909beba1247646b8d409558692546a43be584524698e6d689c1c05e2a4775fad14d70b8531733ad9"
    );
    assert_ne!(wasm_sealed.sealed, uniffi_sealed.sealed);

    assert_ok_u32(
        mosaic_wasm::sidecar_tunnel_close_v1(
            wasm_tunnel.send_handle_id,
            wasm_tunnel.recv_handle_id,
        ),
        "close wasm tunnel",
    );
    assert_ok_u32(
        mosaic_uniffi::sidecar_tunnel_close_v1(
            uniffi_tunnel.send_handle_id,
            uniffi_tunnel.recv_handle_id,
        ),
        "close uniffi tunnel",
    );
}
