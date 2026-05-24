// SPDX-License-Identifier: MIT
// Auto-organized from cross_platform_parity.rs as part of v1.0.2 monolith-test-files
// split. Each split file exercises one domain of cross-facade parity tests.
// See `tests/common/mod.rs` for shared imports, constants, and helpers.
#![allow(clippy::expect_used)]

mod common;
use common::*;

#[test]
fn manifest_transcript_bytes_match_wasm_and_uniffi() {
    let encrypted_meta = vec![0xaa, 0xbb, 0xcc];
    let encoded_shards = encoded_manifest_shards();

    let wasm = mosaic_wasm::manifest_transcript_bytes(
        ALBUM_ID_BYTES.to_vec(),
        7,
        encrypted_meta.clone(),
        encoded_shards,
    );
    assert_ok(wasm.code, "wasm manifest transcript");

    let uniffi =
        match mosaic_uniffi::manifest_transcript_bytes_uniffi(ClientCoreManifestTranscriptInputs {
            album_id: ALBUM_ID_BYTES.to_vec(),
            epoch_id: 7,
            encrypted_metadata_envelope: encrypted_meta,
            shards: vec![
                ClientCoreManifestShardRef {
                    tier: ShardTier::Thumbnail.to_byte(),
                    shard_index: 0,
                    shard_id: bytes_to_uuid(&[0x10; 16]),
                    sha256: vec![0x11; 32],
                },
                ClientCoreManifestShardRef {
                    tier: ShardTier::Original.to_byte(),
                    shard_index: 1,
                    shard_id: bytes_to_uuid(&[0x20; 16]),
                    sha256: vec![0x22; 32],
                },
            ],
        }) {
            Ok(bytes) => bytes,
            Err(error) => panic!("uniffi manifest transcript should encode: {error:?}"),
        };

    assert_eq!(wasm.bytes, uniffi);
    assert_eq!(wasm.bytes.len(), 156);
}

#[test]
fn manifest_transcript_with_non_ascii_filename_bytes() {
    let encrypted_meta = "filename=IMG_e\u{0301}.jpg".as_bytes().to_vec();
    let encoded_shards = encoded_manifest_shards();

    let wasm = mosaic_wasm::manifest_transcript_bytes(
        ALBUM_ID_BYTES.to_vec(),
        8,
        encrypted_meta.clone(),
        encoded_shards,
    );
    assert_ok(wasm.code, "wasm non-ASCII manifest transcript");

    let uniffi =
        match mosaic_uniffi::manifest_transcript_bytes_uniffi(ClientCoreManifestTranscriptInputs {
            album_id: ALBUM_ID_BYTES.to_vec(),
            epoch_id: 8,
            encrypted_metadata_envelope: encrypted_meta.clone(),
            shards: vec![
                ClientCoreManifestShardRef {
                    tier: ShardTier::Thumbnail.to_byte(),
                    shard_index: 0,
                    shard_id: bytes_to_uuid(&[0x10; 16]),
                    sha256: vec![0x11; 32],
                },
                ClientCoreManifestShardRef {
                    tier: ShardTier::Original.to_byte(),
                    shard_index: 1,
                    shard_id: bytes_to_uuid(&[0x20; 16]),
                    sha256: vec![0x22; 32],
                },
            ],
        }) {
            Ok(bytes) => bytes,
            Err(error) => panic!("uniffi non-ASCII manifest transcript should encode: {error:?}"),
        };

    assert!(contains_subsequence(&wasm.bytes, &encrypted_meta));
    assert!(contains_subsequence(&uniffi, &encrypted_meta));
    assert!(!contains_subsequence(
        &wasm.bytes,
        "filename=IMG_é.jpg".as_bytes()
    ));
    assert_eq!(wasm.bytes, uniffi);
}

#[test]
fn sign_manifest_with_identity_matches_across_wasm_and_uniffi() {
    let (wrapped_account_key, wrapped_identity_seed) = fixed_account_and_wrapped_identity_seed();
    let wasm_account = unlock_wasm_account(wrapped_account_key.clone());
    let uniffi_account = unlock_uniffi_account(wrapped_account_key);
    let wasm_identity =
        mosaic_wasm::open_identity_handle(wrapped_identity_seed.clone(), wasm_account);
    assert_ok(wasm_identity.code, "wasm open fixed identity");
    let uniffi_identity =
        mosaic_uniffi::open_identity_handle(wrapped_identity_seed, uniffi_account);
    assert_ok(uniffi_identity.code, "uniffi open fixed identity");
    assert_eq!(wasm_identity.signing_pubkey, uniffi_identity.signing_pubkey);

    let transcript = fixed_manifest_transcript();
    let wasm_sig =
        mosaic_wasm::sign_manifest_with_identity(wasm_identity.handle, transcript.clone());
    let uniffi_sig =
        mosaic_uniffi::sign_manifest_with_identity(uniffi_identity.handle, transcript.clone());
    assert_ok(wasm_sig.code, "wasm identity manifest sign");
    assert_ok(uniffi_sig.code, "uniffi identity manifest sign");

    assert_eq!(wasm_sig.bytes, uniffi_sig.bytes);
    assert_eq!(wasm_sig.bytes.len(), 64);
    assert_ok(
        mosaic_wasm::verify_manifest_with_identity(
            transcript.clone(),
            uniffi_sig.bytes.clone(),
            wasm_identity.signing_pubkey.clone(),
        ),
        "wasm cross-verify uniffi identity signature",
    );
    assert_ok(
        mosaic_uniffi::verify_manifest_with_identity(
            transcript,
            wasm_sig.bytes,
            uniffi_identity.signing_pubkey,
        ),
        "uniffi cross-verify wasm identity signature",
    );

    close_identity_handles(&[wasm_identity.handle, uniffi_identity.handle]);
    close_account_handles(&[wasm_account, uniffi_account]);
}

#[cfg(feature = "cross-client-vectors")]
#[test]
fn sign_manifest_with_epoch_handle_matches_across_wasm_and_uniffi() {
    let fixture = wasm_sealed_bundle_opened_by_uniffi_fixture(91);
    let transcript = fixed_manifest_transcript();

    let wasm_sig =
        mosaic_wasm::sign_manifest_with_epoch_handle(fixture.wasm_epoch_handle, transcript.clone());
    let uniffi_sig = mosaic_uniffi::sign_manifest_with_epoch_handle(
        fixture.uniffi_opened_epoch_handle,
        transcript.clone(),
    );
    assert_ok(wasm_sig.code, "wasm epoch manifest sign");
    assert_ok(uniffi_sig.code, "uniffi epoch manifest sign");

    assert_eq!(wasm_sig.bytes, uniffi_sig.bytes);
    assert_eq!(wasm_sig.bytes.len(), 64);
    assert_ok(
        mosaic_wasm::verify_manifest_with_epoch(
            transcript.clone(),
            uniffi_sig.bytes.clone(),
            fixture.sign_public_key.clone(),
        ),
        "wasm cross-verify uniffi epoch signature",
    );
    assert_ok(
        mosaic_uniffi::verify_manifest_with_epoch(
            transcript,
            wasm_sig.bytes,
            fixture.sign_public_key.clone(),
        ),
        "uniffi cross-verify wasm epoch signature",
    );

    fixture.close();
}
