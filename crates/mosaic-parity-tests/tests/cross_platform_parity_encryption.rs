// SPDX-License-Identifier: MIT
// Auto-organized from cross_platform_parity.rs as part of v1.0.2 monolith-test-files
// split. Each split file exercises one domain of cross-facade parity tests.
// See `tests/common/mod.rs` for shared imports, constants, and helpers.
#![allow(clippy::expect_used)]

mod common;
use common::*;

#[test]
fn encrypted_envelopes_round_trip_between_wasm_and_uniffi() {
    let wrapped_account_key = wrapped_account_key();
    let wasm_account = unlock_wasm_account(wrapped_account_key.clone());
    let uniffi_account = unlock_uniffi_account(wrapped_account_key);

    let wasm_epoch = mosaic_wasm::create_epoch_key_handle(wasm_account, 42);
    assert_ok(wasm_epoch.code, "wasm create epoch");
    let uniffi_epoch = mosaic_uniffi::open_epoch_key_handle(
        wasm_epoch.wrapped_epoch_seed.clone(),
        uniffi_account,
        42,
    );
    assert_ok(uniffi_epoch.code, "uniffi open wasm epoch");

    let plaintext = b"Q-final-1 envelope parity plaintext".to_vec();
    let wasm_encrypted = mosaic_wasm::encrypt_shard_with_epoch_handle(
        wasm_epoch.handle,
        plaintext.clone(),
        3,
        ShardTier::Original.to_byte(),
    );
    assert_ok(wasm_encrypted.code, "wasm encrypt shard");
    let uniffi_decrypted = mosaic_uniffi::decrypt_shard_with_epoch_handle(
        uniffi_epoch.handle,
        wasm_encrypted.envelope_bytes.clone(),
    );
    assert_ok(uniffi_decrypted.code, "uniffi decrypt wasm envelope");
    assert_eq!(uniffi_decrypted.plaintext, plaintext);
    let envelope_digest =
        Sha256::digest(&wasm_encrypted.envelope_bytes[mosaic_domain::SHARD_ENVELOPE_HEADER_LEN..])
            .to_vec();
    assert!(
        must(
            mosaic_wasm::verify_shard_integrity_sha256(
                wasm_encrypted.envelope_bytes.clone(),
                envelope_digest.clone(),
            ),
            "wasm sha256 verify",
        ),
        "wasm sha256 verify should match envelope digest"
    );
    assert!(
        must(
            mosaic_uniffi::verify_shard_integrity_sha256(
                wasm_encrypted.envelope_bytes.clone(),
                envelope_digest,
            ),
            "uniffi sha256 verify",
        ),
        "uniffi sha256 verify should match envelope digest"
    );

    let uniffi_created_epoch = mosaic_uniffi::create_epoch_key_handle(uniffi_account, 43);
    assert_ok(uniffi_created_epoch.code, "uniffi create epoch");
    let wasm_opened_epoch = mosaic_wasm::open_epoch_key_handle(
        uniffi_created_epoch.wrapped_epoch_seed.clone(),
        wasm_account,
        43,
    );
    assert_ok(wasm_opened_epoch.code, "wasm open uniffi epoch");

    let reverse_plaintext = b"reverse envelope parity plaintext".to_vec();
    let uniffi_encrypted = mosaic_uniffi::encrypt_shard_with_epoch_handle(
        uniffi_created_epoch.handle,
        reverse_plaintext.clone(),
        4,
        ShardTier::Preview.to_byte(),
    );
    assert_ok(uniffi_encrypted.code, "uniffi encrypt shard");
    let wasm_decrypted = mosaic_wasm::decrypt_shard_with_epoch_handle(
        wasm_opened_epoch.handle,
        uniffi_encrypted.envelope_bytes,
    );
    assert_ok(wasm_decrypted.code, "wasm decrypt uniffi envelope");
    assert_eq!(wasm_decrypted.plaintext, reverse_plaintext);

    close_epoch_handles(&[
        wasm_epoch.handle,
        uniffi_epoch.handle,
        uniffi_created_epoch.handle,
        wasm_opened_epoch.handle,
    ]);
    close_account_handles(&[wasm_account, uniffi_account]);
}

#[test]
fn account_data_wrap_round_trips_across_wasm_and_uniffi() {
    let wrapped_account_key = wrapped_account_key();
    let wasm_account = unlock_wasm_account(wrapped_account_key.clone());
    let uniffi_account = unlock_uniffi_account(wrapped_account_key);
    let plaintext = b"account data parity plaintext".to_vec();

    let wasm_wrapped = mosaic_wasm::wrap_with_account_handle(wasm_account, plaintext.clone());
    assert_ok(wasm_wrapped.code, "wasm wrap account data");
    assert_ne!(wasm_wrapped.bytes, plaintext);
    assert!(
        wasm_wrapped.bytes.len() >= 24 + 16,
        "wrapped account data carries nonce plus AEAD tag"
    );
    let uniffi_unwrapped =
        mosaic_uniffi::unwrap_with_account_handle(uniffi_account, wasm_wrapped.bytes.clone());
    assert_ok(uniffi_unwrapped.code, "uniffi unwrap wasm account data");
    assert_eq!(uniffi_unwrapped.bytes, plaintext);

    let wasm_wrapped_again = mosaic_wasm::wrap_with_account_handle(wasm_account, plaintext.clone());
    assert_ok(wasm_wrapped_again.code, "wasm wrap account data again");
    assert_ne!(
        wasm_wrapped.bytes, wasm_wrapped_again.bytes,
        "account data wraps must use a fresh nonce"
    );

    let reverse_plaintext = b"reverse account data parity plaintext".to_vec();
    let uniffi_wrapped =
        mosaic_uniffi::wrap_with_account_handle(uniffi_account, reverse_plaintext.clone());
    assert_ok(uniffi_wrapped.code, "uniffi wrap account data");
    assert_ne!(uniffi_wrapped.bytes, reverse_plaintext);
    let wasm_unwrapped =
        mosaic_wasm::unwrap_with_account_handle(wasm_account, uniffi_wrapped.bytes);
    assert_ok(wasm_unwrapped.code, "wasm unwrap uniffi account data");
    assert_eq!(wasm_unwrapped.bytes, reverse_plaintext);

    close_account_handles(&[wasm_account, uniffi_account]);
}

#[test]
fn encrypt_metadata_sidecar_round_trips_across_wasm_and_uniffi() {
    let wrapped_account_key = wrapped_account_key();
    let wasm_account = unlock_wasm_account(wrapped_account_key.clone());
    let uniffi_account = unlock_uniffi_account(wrapped_account_key);
    let wasm_epoch = mosaic_wasm::create_epoch_key_handle(wasm_account, 52);
    assert_ok(wasm_epoch.code, "wasm create metadata epoch");
    let uniffi_epoch = mosaic_uniffi::open_epoch_key_handle(
        wasm_epoch.wrapped_epoch_seed.clone(),
        uniffi_account,
        52,
    );
    assert_ok(uniffi_epoch.code, "uniffi open metadata epoch");

    let encoded_fields = encoded_metadata_fields(&[
        (metadata_field_tags::MIME_OVERRIDE, b"image/jpeg".as_slice()),
        (metadata_field_tags::CAMERA_MAKE, "MøsaicCam".as_bytes()),
        (metadata_field_tags::CAMERA_MODEL, "Parity-Č".as_bytes()),
    ]);
    let expected_plaintext = {
        let canonical = mosaic_wasm::canonical_metadata_sidecar_bytes(
            ALBUM_ID_BYTES.to_vec(),
            PHOTO_ID_BYTES.to_vec(),
            52,
            encoded_fields.clone(),
        );
        assert_ok(canonical.code, "wasm canonical metadata sidecar");
        canonical.bytes
    };

    let wasm_encrypted = mosaic_wasm::encrypt_metadata_sidecar_with_epoch_handle(
        wasm_epoch.handle,
        ALBUM_ID_BYTES.to_vec(),
        PHOTO_ID_BYTES.to_vec(),
        52,
        encoded_fields.clone(),
        2,
    );
    assert_ok(wasm_encrypted.code, "wasm encrypt metadata sidecar");
    let uniffi_decrypted = mosaic_uniffi::decrypt_shard_with_epoch_handle(
        uniffi_epoch.handle,
        wasm_encrypted.envelope_bytes.clone(),
    );
    assert_ok(
        uniffi_decrypted.code,
        "uniffi decrypt wasm metadata sidecar",
    );
    assert_eq!(uniffi_decrypted.plaintext, expected_plaintext);

    let mut tampered_aad = wasm_encrypted.envelope_bytes;
    tampered_aad[13] ^= 0x01;
    let tampered =
        mosaic_uniffi::decrypt_shard_with_epoch_handle(uniffi_epoch.handle, tampered_aad);
    assert_eq!(
        tampered.code,
        ClientErrorCode::AuthenticationFailed.as_u16(),
        "metadata sidecar decrypt must authenticate envelope header AAD"
    );

    let uniffi_encrypted = mosaic_uniffi::encrypt_metadata_sidecar_with_epoch_handle(
        uniffi_epoch.handle,
        ALBUM_ID_BYTES.to_vec(),
        PHOTO_ID_BYTES.to_vec(),
        52,
        encoded_fields,
        3,
    );
    assert_ok(uniffi_encrypted.code, "uniffi encrypt metadata sidecar");
    let wasm_decrypted = mosaic_wasm::decrypt_shard_with_epoch_handle(
        wasm_epoch.handle,
        uniffi_encrypted.envelope_bytes.clone(),
    );
    assert_ok(wasm_decrypted.code, "wasm decrypt uniffi metadata sidecar");
    assert_eq!(wasm_decrypted.plaintext, expected_plaintext);

    let mut reverse_tampered_aad = uniffi_encrypted.envelope_bytes;
    reverse_tampered_aad[13] ^= 0x02;
    let reverse_tampered =
        mosaic_wasm::decrypt_shard_with_epoch_handle(wasm_epoch.handle, reverse_tampered_aad);
    assert_eq!(
        reverse_tampered.code,
        ClientErrorCode::AuthenticationFailed.as_u16(),
        "wasm metadata sidecar decrypt must authenticate envelope header AAD"
    );

    close_epoch_handles(&[wasm_epoch.handle, uniffi_epoch.handle]);
    close_account_handles(&[wasm_account, uniffi_account]);
}

#[test]
fn link_tier_key_wrap_round_trips_across_wasm_and_uniffi() {
    let wrapped_account_key = wrapped_account_key();
    let wasm_account = unlock_wasm_account(wrapped_account_key.clone());
    let uniffi_account = unlock_uniffi_account(wrapped_account_key);
    let wasm_epoch = mosaic_wasm::create_epoch_key_handle(wasm_account, 61);
    assert_ok(wasm_epoch.code, "wasm create link epoch");
    let uniffi_epoch = mosaic_uniffi::open_epoch_key_handle(
        wasm_epoch.wrapped_epoch_seed.clone(),
        uniffi_account,
        61,
    );
    assert_ok(uniffi_epoch.code, "uniffi open link epoch");

    let wasm_link = mosaic_wasm::create_link_share_handle(
        ALBUM_ID.to_owned(),
        wasm_epoch.handle,
        ShardTier::Original.to_byte(),
    );
    assert_ok(wasm_link.code, "wasm create link share");
    let uniffi_link_tier = mosaic_uniffi::import_link_tier_handle(
        wasm_link.link_url_token.clone(),
        wasm_link.nonce.clone(),
        wasm_link.encrypted_key.clone(),
        ALBUM_ID.to_owned(),
        wasm_link.tier,
    );
    assert_ok(uniffi_link_tier.code, "uniffi import wasm wrapped tier");
    let plaintext = b"wasm link tier wrapped shard".to_vec();
    let wasm_encrypted = mosaic_wasm::encrypt_shard_with_epoch_handle(
        wasm_epoch.handle,
        plaintext.clone(),
        11,
        ShardTier::Original.to_byte(),
    );
    assert_ok(wasm_encrypted.code, "wasm encrypt link shard");
    let uniffi_decrypted = mosaic_uniffi::decrypt_shard_with_link_tier_handle(
        uniffi_link_tier.link_tier_handle_id,
        wasm_encrypted.envelope_bytes,
    );
    assert_ok(uniffi_decrypted.code, "uniffi decrypt wasm link shard");
    assert_eq!(uniffi_decrypted.plaintext, plaintext);

    let link_secret = [0x5a_u8; 32];
    let link_keys = must(
        mosaic_crypto::derive_link_keys(&link_secret),
        "derive link keys",
    );
    let link_handle = must(
        mosaic_client::open_secret_handle(link_keys.wrapping_key.as_bytes()),
        "open link wrapping handle",
    );
    let mut epoch_seed = fixed_epoch_seed().to_vec();
    let material = must(
        mosaic_crypto::derive_epoch_key_material(62, epoch_seed.as_mut_slice()),
        "derive fixed epoch material",
    );
    let tier_key_handle = must(
        mosaic_client::open_secret_handle(material.full_key().as_bytes()),
        "open tier key handle",
    );
    let uniffi_wrapped = mosaic_uniffi::wrap_tier_key_for_link_handle(
        link_handle,
        tier_key_handle,
        ShardTier::Original.to_byte(),
    );
    assert_ok(uniffi_wrapped.code, "uniffi wrap tier key for link");
    let wasm_link_tier = mosaic_wasm::import_link_tier_handle(
        link_secret.to_vec(),
        uniffi_wrapped.nonce,
        uniffi_wrapped.ciphertext,
        ALBUM_ID.to_owned(),
        uniffi_wrapped.tier,
    );
    assert_ok(wasm_link_tier.code, "wasm import uniffi wrapped tier");
    let reverse_plaintext = b"uniffi link tier wrapped shard".to_vec();
    let mut full_key_bytes = material.full_key().as_bytes().to_vec();
    let full_key = must(
        mosaic_crypto::SecretKey::from_bytes(full_key_bytes.as_mut_slice()),
        "fixed full tier key",
    );
    let reverse_envelope = must(
        mosaic_crypto::encrypt_shard(&reverse_plaintext, &full_key, 62, 12, ShardTier::Original),
        "encrypt fixed-key shard",
    );
    let wasm_decrypted = mosaic_wasm::decrypt_shard_with_link_tier_handle(
        wasm_link_tier.handle,
        reverse_envelope.bytes,
    );
    assert_ok(wasm_decrypted.code, "wasm decrypt uniffi link shard");
    assert_eq!(wasm_decrypted.plaintext, reverse_plaintext);

    close_secret_handles(&[link_handle, tier_key_handle]);
    let wasm_link_close = mosaic_wasm::close_link_tier_handle(wasm_link_tier.handle);
    assert_ok(wasm_link_close, "close wasm link tier");
    let uniffi_link_close =
        mosaic_uniffi::close_link_tier_handle(uniffi_link_tier.link_tier_handle_id);
    assert_ok(uniffi_link_close, "close uniffi link tier");
    let wasm_link_share_close = mosaic_wasm::close_link_share_handle(wasm_link.handle);
    assert_ok(wasm_link_share_close, "close wasm link share");
    close_epoch_handles(&[wasm_epoch.handle, uniffi_epoch.handle]);
    close_account_handles(&[wasm_account, uniffi_account]);
}

#[test]
fn decrypt_shard_with_tampered_ciphertext_returns_same_error_code_on_wasm_and_uniffi() {
    let wrapped_account_key = wrapped_account_key();
    let wasm_account = unlock_wasm_account(wrapped_account_key.clone());
    let uniffi_account = unlock_uniffi_account(wrapped_account_key);
    let wasm_epoch = mosaic_wasm::create_epoch_key_handle(wasm_account, 71);
    assert_ok(wasm_epoch.code, "wasm create tampered epoch");
    let uniffi_epoch = mosaic_uniffi::open_epoch_key_handle(
        wasm_epoch.wrapped_epoch_seed.clone(),
        uniffi_account,
        71,
    );
    assert_ok(uniffi_epoch.code, "uniffi open tampered epoch");
    let encrypted = mosaic_wasm::encrypt_shard_with_epoch_handle(
        wasm_epoch.handle,
        b"tampered ciphertext parity".to_vec(),
        1,
        ShardTier::Original.to_byte(),
    );
    assert_ok(encrypted.code, "wasm encrypt tamper fixture");
    let mut tampered = encrypted.envelope_bytes;
    let last = must_some(tampered.last_mut(), "envelope has ciphertext tag");
    *last ^= 0x80;

    let wasm = mosaic_wasm::decrypt_shard_with_epoch_handle(wasm_epoch.handle, tampered.clone());
    let uniffi = mosaic_uniffi::decrypt_shard_with_epoch_handle(uniffi_epoch.handle, tampered);
    assert_eq!(wasm.code, uniffi.code);
    assert_eq!(wasm.code, ClientErrorCode::AuthenticationFailed.as_u16());

    close_epoch_handles(&[wasm_epoch.handle, uniffi_epoch.handle]);
    close_account_handles(&[wasm_account, uniffi_account]);
}

#[test]
fn truncated_envelope_returns_same_error_code_on_wasm_and_uniffi() {
    let wrapped_account_key = wrapped_account_key();
    let wasm_account = unlock_wasm_account(wrapped_account_key.clone());
    let uniffi_account = unlock_uniffi_account(wrapped_account_key);
    let wasm_epoch = mosaic_wasm::create_epoch_key_handle(wasm_account, 72);
    assert_ok(wasm_epoch.code, "wasm create truncated epoch");
    let uniffi_epoch = mosaic_uniffi::open_epoch_key_handle(
        wasm_epoch.wrapped_epoch_seed.clone(),
        uniffi_account,
        72,
    );
    assert_ok(uniffi_epoch.code, "uniffi open truncated epoch");
    let truncated = vec![0_u8; 32];

    let wasm = mosaic_wasm::decrypt_shard_with_epoch_handle(wasm_epoch.handle, truncated.clone());
    let uniffi = mosaic_uniffi::decrypt_shard_with_epoch_handle(uniffi_epoch.handle, truncated);
    assert_eq!(wasm.code, uniffi.code);
    assert_eq!(wasm.code, ClientErrorCode::InvalidHeaderLength.as_u16());

    close_epoch_handles(&[wasm_epoch.handle, uniffi_epoch.handle]);
    close_account_handles(&[wasm_account, uniffi_account]);
}

#[test]
fn wrong_epoch_handle_returns_same_error_code_on_wasm_and_uniffi() {
    let wrapped_account_key = wrapped_account_key();
    let wasm_account = unlock_wasm_account(wrapped_account_key.clone());
    let uniffi_account = unlock_uniffi_account(wrapped_account_key);
    let wasm_epoch = mosaic_wasm::create_epoch_key_handle(wasm_account, 73);
    assert_ok(wasm_epoch.code, "wasm create correct epoch");
    let uniffi_wrong = mosaic_uniffi::create_epoch_key_handle(uniffi_account, 74);
    assert_ok(uniffi_wrong.code, "uniffi create wrong epoch");
    let wasm_wrong = mosaic_wasm::open_epoch_key_handle(
        uniffi_wrong.wrapped_epoch_seed.clone(),
        wasm_account,
        74,
    );
    assert_ok(wasm_wrong.code, "wasm open wrong epoch");
    let encrypted = mosaic_wasm::encrypt_shard_with_epoch_handle(
        wasm_epoch.handle,
        b"wrong epoch parity".to_vec(),
        1,
        ShardTier::Original.to_byte(),
    );
    assert_ok(encrypted.code, "wasm encrypt wrong epoch fixture");

    let wasm = mosaic_wasm::decrypt_shard_with_epoch_handle(
        wasm_wrong.handle,
        encrypted.envelope_bytes.clone(),
    );
    let uniffi = mosaic_uniffi::decrypt_shard_with_epoch_handle(
        uniffi_wrong.handle,
        encrypted.envelope_bytes,
    );
    assert_eq!(wasm.code, uniffi.code);
    assert_eq!(wasm.code, ClientErrorCode::AuthenticationFailed.as_u16());

    close_epoch_handles(&[wasm_epoch.handle, wasm_wrong.handle, uniffi_wrong.handle]);
    close_account_handles(&[wasm_account, uniffi_account]);
}

#[test]
fn malformed_cbor_snapshot_returns_same_error_code_on_wasm_and_uniffi() {
    let wasm_plan = mosaic_wasm::download_build_plan_v1(&download_plan_builder_input_cbor());
    assert_ok_u32(wasm_plan.code, "wasm download build plan");
    let wasm_snapshot =
        mosaic_wasm::download_init_snapshot_v1(&download_init_input_cbor(&wasm_plan.plan_cbor));
    assert_ok_u32(wasm_snapshot.code, "wasm download init snapshot");
    let mut malformed = wasm_snapshot.body;
    malformed[0] = 0xff;
    let checksum = mosaic_wasm::blake2b_snapshot_checksum_32(malformed.clone());

    let wasm = mosaic_wasm::download_load_snapshot_v1(&malformed, &checksum);
    let uniffi = mosaic_uniffi::load_download_snapshot(malformed, checksum);
    assert_eq!(wasm.code, u32::from(uniffi.code));
    assert_eq!(
        uniffi.code,
        ClientErrorCode::DownloadSnapshotCorrupt.as_u16()
    );
}
