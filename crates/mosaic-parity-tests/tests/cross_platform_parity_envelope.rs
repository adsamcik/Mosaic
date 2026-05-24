// SPDX-License-Identifier: MIT
// Auto-organized from cross_platform_parity.rs as part of v1.0.2 monolith-test-files
// split. Each split file exercises one domain of cross-facade parity tests.
// See `tests/common/mod.rs` for shared imports, constants, and helpers.
#![allow(clippy::expect_used)]

mod common;
use common::*;

#[test]
fn streaming_aead_envelope_decrypts_across_uniffi_and_shared_core() {
    let wrapped_account_key = wrapped_account_key();
    let wasm_account = unlock_wasm_account(wrapped_account_key.clone());
    let uniffi_account = unlock_uniffi_account(wrapped_account_key);

    let uniffi_epoch = mosaic_uniffi::create_epoch_key_handle(uniffi_account, 77);
    assert_ok(uniffi_epoch.code, "uniffi create streaming epoch");
    let wasm_epoch = mosaic_wasm::open_epoch_key_handle(
        uniffi_epoch.wrapped_epoch_seed.clone(),
        wasm_account,
        77,
    );
    assert_ok(wasm_epoch.code, "wasm open streaming epoch");

    let plaintext = patterned_plaintext(STREAMING_SHARD_FRAME_SIZE + 333);
    let encryptor = match mosaic_uniffi::StreamingEncryptor::new(
        uniffi_epoch.handle,
        ShardTier::Original.to_byte(),
        Some(2),
    ) {
        Ok(value) => value,
        Err(error) => panic!("uniffi streaming encryptor should initialize: {error:?}"),
    };
    let first = match encryptor.encrypt_frame(plaintext[..STREAMING_SHARD_FRAME_SIZE].to_vec()) {
        Ok(frame) => frame,
        Err(error) => panic!("first frame should encrypt: {error:?}"),
    };
    assert_eq!(first.frame_index, 0);
    let second = match encryptor.encrypt_frame(plaintext[STREAMING_SHARD_FRAME_SIZE..].to_vec()) {
        Ok(frame) => frame,
        Err(error) => panic!("second frame should encrypt: {error:?}"),
    };
    assert_eq!(second.frame_index, 1);
    let envelope = match encryptor.finalize() {
        Ok(bytes) => bytes,
        Err(error) => panic!("stream should finalize: {error:?}"),
    };
    assert_eq!(envelope[4], SHARD_ENVELOPE_VERSION_V04);

    let wasm_key_material = match mosaic_client::epoch_key_material_for_handle(wasm_epoch.handle) {
        Ok(material) => material,
        Err(error) => panic!("wasm-opened epoch material should be available: {error:?}"),
    };
    let decrypted = match mosaic_crypto::decrypt_envelope(&wasm_key_material, &envelope) {
        Ok(bytes) => bytes,
        Err(error) => {
            panic!("shared core used by wasm should decrypt streaming envelope: {error:?}")
        }
    };
    let uniffi_decrypted = match mosaic_uniffi::decrypt_envelope(uniffi_epoch.handle, envelope) {
        Ok(bytes) => bytes,
        Err(error) => panic!("uniffi dispatcher should decrypt streaming envelope: {error:?}"),
    };
    assert_eq!(decrypted, plaintext);
    assert_eq!(uniffi_decrypted, plaintext);

    close_epoch_handles(&[uniffi_epoch.handle, wasm_epoch.handle]);
    close_account_handles(&[wasm_account, uniffi_account]);
}

#[cfg(feature = "cross-client-vectors")]
#[test]
fn wasm_sealed_bundle_opens_via_uniffi_recipient_seed_path() {
    let fixture = wasm_sealed_bundle_opened_by_uniffi_fixture(92);

    assert_eq!(fixture.opened_epoch_id, 92);
    assert_eq!(fixture.opened_album_id, ALBUM_ID);
    assert_eq!(fixture.opened_recipient_pubkey, fixture.recipient_pubkey);
    assert_eq!(fixture.sign_public_key, fixture.wasm_sign_public_key);

    let plaintext = b"sealed bundle recovered epoch seed decrypts this shard".to_vec();
    let wasm_encrypted = mosaic_wasm::encrypt_shard_with_epoch_handle(
        fixture.wasm_epoch_handle,
        plaintext.clone(),
        8,
        ShardTier::Preview.to_byte(),
    );
    assert_ok(wasm_encrypted.code, "wasm encrypt with sealed epoch");
    let uniffi_decrypted = mosaic_uniffi::decrypt_shard_with_epoch_handle(
        fixture.uniffi_opened_epoch_handle,
        wasm_encrypted.envelope_bytes,
    );
    assert_ok(
        uniffi_decrypted.code,
        "uniffi decrypt with opened bundle epoch",
    );
    assert_eq!(uniffi_decrypted.plaintext, plaintext);

    fixture.close();
}

#[cfg(feature = "cross-client-vectors")]
#[test]
fn uniffi_sealed_bundle_opens_via_wasm() {
    let wrapped_account_key = wrapped_account_key();
    let wasm_account = unlock_wasm_account(wrapped_account_key.clone());
    let uniffi_account = unlock_uniffi_account(wrapped_account_key);

    let uniffi_identity = mosaic_uniffi::create_identity_handle(uniffi_account);
    assert_ok(uniffi_identity.code, "uniffi create bundle sharer identity");
    let wasm_recipient = mosaic_wasm::create_identity_handle(wasm_account);
    assert_ok(wasm_recipient.code, "wasm create bundle recipient identity");
    let uniffi_epoch = mosaic_uniffi::create_epoch_key_handle(uniffi_account, 93);
    assert_ok(uniffi_epoch.code, "uniffi create bundle epoch");

    let sealed = mosaic_uniffi::seal_bundle_with_epoch_handle(
        uniffi_identity.handle,
        uniffi_epoch.handle,
        wasm_recipient.signing_pubkey.clone(),
        ALBUM_ID.to_owned(),
    );
    assert_ok(sealed.code, "uniffi seal epoch bundle");
    assert_eq!(sealed.sharer_pubkey, uniffi_identity.signing_pubkey);

    let wasm_opened = mosaic_wasm::verify_and_import_epoch_bundle(
        wasm_recipient.handle,
        sealed.sealed,
        sealed.signature,
        sealed.sharer_pubkey,
        ALBUM_ID.to_owned(),
        93,
        false,
    );
    assert_ok(wasm_opened.code, "wasm open uniffi sealed bundle");
    assert_eq!(wasm_opened.epoch_id, 93);
    assert_eq!(wasm_opened.sign_public_key, uniffi_epoch.sign_public_key);

    let plaintext = b"uniffi sealed bundle recovered by wasm decrypts this shard".to_vec();
    let uniffi_encrypted = mosaic_uniffi::encrypt_shard_with_epoch_handle(
        uniffi_epoch.handle,
        plaintext.clone(),
        9,
        ShardTier::Original.to_byte(),
    );
    assert_ok(uniffi_encrypted.code, "uniffi encrypt with sealed epoch");
    let wasm_decrypted = mosaic_wasm::decrypt_shard_with_epoch_handle(
        wasm_opened.handle,
        uniffi_encrypted.envelope_bytes,
    );
    assert_ok(wasm_decrypted.code, "wasm decrypt with opened bundle epoch");
    assert_eq!(wasm_decrypted.plaintext, plaintext);

    close_epoch_handles(&[uniffi_epoch.handle, wasm_opened.handle]);
    close_identity_handles(&[uniffi_identity.handle, wasm_recipient.handle]);
    close_account_handles(&[wasm_account, uniffi_account]);
}

#[cfg(feature = "cross-client-vectors")]
#[test]
fn wasm_streaming_encrypt_uniffi_streaming_decrypt_round_trip() {
    streaming_round_trip_case("one final frame", patterned_plaintext(777), &[777]);
    streaming_round_trip_case(
        "three frames",
        patterned_plaintext(STREAMING_SHARD_FRAME_SIZE * 2 + 333),
        &[STREAMING_SHARD_FRAME_SIZE, STREAMING_SHARD_FRAME_SIZE, 333],
    );
}

#[cfg(feature = "cross-client-vectors")]
#[test]
fn streaming_aead_tampered_chunk_fails_on_opposite_facade() {
    let wrapped_account_key = wrapped_account_key();
    let wasm_account = unlock_wasm_account(wrapped_account_key.clone());
    let uniffi_account = unlock_uniffi_account(wrapped_account_key);
    let wasm_epoch = mosaic_wasm::create_epoch_key_handle(wasm_account, 123);
    assert_ok(wasm_epoch.code, "wasm create tamper epoch");
    let uniffi_epoch = mosaic_uniffi::open_epoch_key_handle(
        wasm_epoch.wrapped_epoch_seed.clone(),
        uniffi_account,
        123,
    );
    assert_ok(uniffi_epoch.code, "uniffi open tamper epoch");

    let plaintext = patterned_plaintext(STREAMING_SHARD_FRAME_SIZE + 19);
    let mut wasm_encryptor = mosaic_wasm::StreamingShardEncryptor::new(
        wasm_epoch.handle,
        ShardTier::Original.to_byte(),
        Some(2),
    );
    let first =
        wasm_encryptor.encrypt_frame_for_tests(plaintext[..STREAMING_SHARD_FRAME_SIZE].to_vec());
    assert_ok(first.code, "wasm tamper first frame");
    let second =
        wasm_encryptor.encrypt_frame_for_tests(plaintext[STREAMING_SHARD_FRAME_SIZE..].to_vec());
    assert_ok(second.code, "wasm tamper second frame");
    let envelope = wasm_encryptor.finalize_for_tests();
    assert_ok(envelope.code, "wasm tamper finalize");

    let uniffi_decryptor =
        match mosaic_uniffi::StreamingDecryptor::new(uniffi_epoch.handle, envelope.bytes.clone()) {
            Ok(value) => value,
            Err(error) => panic!("uniffi decryptor should open wasm envelope: {error:?}"),
        };
    let first_plaintext = match uniffi_decryptor.decrypt_frame(first.bytes) {
        Ok(bytes) => bytes,
        Err(error) => panic!("uniffi first frame should decrypt before tamper: {error:?}"),
    };
    assert_eq!(first_plaintext, plaintext[..STREAMING_SHARD_FRAME_SIZE]);
    let mut tampered = second.bytes;
    let last = must_some(
        tampered.last_mut(),
        "encrypted streaming frame carries a tag byte",
    );
    *last ^= 0x80;
    assert!(
        uniffi_decryptor.decrypt_frame(tampered).is_err(),
        "uniffi decryptor must reject a WASM-encrypted tampered frame"
    );

    let uniffi_encryptor = match mosaic_uniffi::StreamingEncryptor::new(
        uniffi_epoch.handle,
        ShardTier::Original.to_byte(),
        Some(1),
    ) {
        Ok(value) => value,
        Err(error) => panic!("uniffi encryptor should initialize: {error:?}"),
    };
    let frame = match uniffi_encryptor.encrypt_frame(b"tamper reverse".to_vec()) {
        Ok(frame) => frame,
        Err(error) => panic!("uniffi reverse frame should encrypt: {error:?}"),
    };
    let envelope = match uniffi_encryptor.finalize() {
        Ok(bytes) => bytes,
        Err(error) => panic!("uniffi reverse envelope should finalize: {error:?}"),
    };
    let mut tampered = frame.bytes;
    let last = must_some(
        tampered.last_mut(),
        "encrypted streaming frame carries a tag byte",
    );
    *last ^= 0x40;
    let mut wasm_decryptor = mosaic_wasm::StreamingShardDecryptor::new(wasm_epoch.handle, envelope);
    let tampered_result = wasm_decryptor.decrypt_frame_for_tests(tampered);
    assert_ne!(
        tampered_result.code,
        ClientErrorCode::Ok.as_u16(),
        "wasm decryptor must reject a UniFFI-encrypted tampered frame"
    );
    assert_ne!(
        wasm_decryptor.finalize_for_tests().code,
        ClientErrorCode::Ok.as_u16(),
        "wasm decryptor must not finalize after a tampered frame"
    );

    close_epoch_handles(&[wasm_epoch.handle, uniffi_epoch.handle]);
    close_account_handles(&[wasm_account, uniffi_account]);
}

#[test]
fn sidecar_canonical_bytes_match_wasm_and_uniffi() {
    let encoded_fields = encoded_metadata_fields(&[
        (metadata_field_tags::MIME_OVERRIDE, b"image/png".as_slice()),
        (metadata_field_tags::CAMERA_MAKE, b"MosaicCam".as_slice()),
        (metadata_field_tags::CAMERA_MODEL, b"Parity-1".as_slice()),
    ]);

    let wasm = mosaic_wasm::canonical_metadata_sidecar_bytes(
        ALBUM_ID_BYTES.to_vec(),
        PHOTO_ID_BYTES.to_vec(),
        9,
        encoded_fields.clone(),
    );
    let uniffi = mosaic_uniffi::canonical_metadata_sidecar_bytes(
        ALBUM_ID_BYTES.to_vec(),
        PHOTO_ID_BYTES.to_vec(),
        9,
        encoded_fields,
    );
    assert_ok(wasm.code, "wasm canonical sidecar");
    assert_ok(uniffi.code, "uniffi canonical sidecar");
    assert_eq!(wasm.bytes, uniffi.bytes);

    let video = synthetic_mp4();
    let wasm_video = mosaic_wasm::video_metadata_sidecar_bytes(
        ALBUM_ID_BYTES.to_vec(),
        PHOTO_ID_BYTES.to_vec(),
        9,
        video.clone(),
    );
    let uniffi_video = mosaic_uniffi::canonical_video_sidecar_bytes(
        ALBUM_ID_BYTES.to_vec(),
        PHOTO_ID_BYTES.to_vec(),
        9,
        video,
    );
    assert_ok(wasm_video.code, "wasm canonical video sidecar");
    assert_ok(uniffi_video.code, "uniffi canonical video sidecar");
    assert_eq!(wasm_video.bytes, uniffi_video.bytes);
}

#[test]
fn mime_override_preserves_non_nfc_bytes_exactly_across_wasm_and_uniffi() {
    let decomposed_mime = "image/x-mosaic-e\u{301}".as_bytes();
    let encoded_fields =
        encoded_metadata_fields(&[(metadata_field_tags::MIME_OVERRIDE, decomposed_mime)]);

    let wasm = mosaic_wasm::canonical_metadata_sidecar_bytes(
        ALBUM_ID_BYTES.to_vec(),
        PHOTO_ID_BYTES.to_vec(),
        10,
        encoded_fields.clone(),
    );
    let uniffi = mosaic_uniffi::canonical_metadata_sidecar_bytes(
        ALBUM_ID_BYTES.to_vec(),
        PHOTO_ID_BYTES.to_vec(),
        10,
        encoded_fields,
    );
    assert_ok(wasm.code, "wasm non-NFC MIME sidecar");
    assert_ok(uniffi.code, "uniffi non-NFC MIME sidecar");
    assert_eq!(wasm.bytes, uniffi.bytes);

    let value_start = 59 + 2 + 4;
    assert_eq!(
        &wasm.bytes[value_start..value_start + decomposed_mime.len()],
        decomposed_mime
    );
    assert!(!contains_subsequence(
        &wasm.bytes,
        "image/x-mosaic-é".as_bytes()
    ));
}
