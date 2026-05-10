use ciborium::value::Value;
use mosaic_client::ClientErrorCode;
use mosaic_crypto::{KdfProfile, MIN_KDF_ITERATIONS, MIN_KDF_MEMORY_KIB, derive_account_key};
use mosaic_domain::{
    SHARD_ENVELOPE_VERSION_V04, STREAMING_SHARD_FRAME_SIZE, ShardTier, metadata_field_tags,
};
use mosaic_uniffi::{
    AccountUnlockRequest as UniAccountUnlockRequest, ClientCoreManifestShardRef,
    ClientCoreManifestTranscriptInputs, ClientCoreUploadJobSnapshot as UniUploadJobSnapshot,
    ClientCoreUploadShardRef as UniUploadShardRef, DownloadInitInput, DownloadPlanEntryInput,
    DownloadPlanInput, DownloadPlanShardInput, MediaFormat as UniMediaFormat,
};
use mosaic_wasm::{
    AccountUnlockRequest as WasmAccountUnlockRequest,
    ClientCoreUploadJobSnapshot as WasmUploadJobSnapshot,
    ClientCoreUploadShardRef as WasmUploadShardRef,
};
use sha2::{Digest, Sha256};

const PASSWORD: &[u8] = b"correct horse battery staple";
const USER_SALT: [u8; 16] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
];
const ACCOUNT_SALT: [u8; 16] = [
    0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff,
];
const ALBUM_ID_BYTES: [u8; 16] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
];
const PHOTO_ID_BYTES: [u8; 16] = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
];
const JOB_ID: &str = "018f0000-0000-7000-8000-000000000001";
const ALBUM_ID: &str = "018f0000-0000-7000-8000-000000000002";
const IDEMPOTENCY_KEY: &str = "018f0000-0000-7000-8000-000000000004";
const EFFECT_ID: &str = "018f0000-0000-7000-8000-000000000005";
const SHARD_ID: &str = "018f0000-0000-7000-8000-000000000006";

fn must<T, E: core::fmt::Debug>(result: Result<T, E>, context: &str) -> T {
    match result {
        Ok(value) => value,
        Err(error) => panic!("{context}: {error:?}"),
    }
}

#[test]
fn finalize_idempotency_key_parity() {
    let job_id = mosaic_client::Uuid::from_bytes([
        0x01, 0x95, 0x00, 0x00, 0x00, 0x00, 0x70, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00,
    ]);
    let job_id_string = "01950000-0000-7000-8000-000000000000".to_owned();

    let from_wasm = must(
        mosaic_wasm::finalize_idempotency_key(job_id_string.clone()),
        "wasm finalize idempotency key",
    );
    let from_uniffi = must(
        mosaic_uniffi::finalize_idempotency_key(job_id_string),
        "uniffi finalize idempotency key",
    );
    let from_client = mosaic_client::finalize_idempotency_key(&job_id);

    assert_eq!(from_wasm, from_uniffi);
    assert_eq!(from_wasm, from_client);
    assert_eq!(
        from_wasm,
        "mosaic-finalize-01950000-0000-7000-8000-000000000000"
    );
}

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
fn password_nfkc_normalization_matches_known_utf8_vector() {
    let nfd = mosaic_crypto::normalize_password_for_kdf("cafe\u{0301}");
    let nfc = mosaic_crypto::normalize_password_for_kdf("caf\u{00e9}");
    let expected = b"caf\xC3\xA9".to_vec();

    assert_eq!(nfd, expected);
    assert_eq!(nfc, expected);
}

#[test]
fn session_key_derivation_matches_crypto_wasm_and_uniffi() {
    const DOMAIN: &str = "v2:";
    const USERNAME: &str = "alice";
    const PASSWORD: &[u8] = b"hunter2";
    const GOLDEN_SALT: [u8; 16] = [
        0xb5, 0xea, 0x3b, 0xe8, 0xd2, 0x62, 0xca, 0xab, 0x42, 0x64, 0x6f, 0x5b, 0x8e, 0xa3, 0xe0,
        0xcc,
    ];
    const GOLDEN_MASTER_KEY: [u8; 32] = [
        0xd6, 0xa6, 0xd3, 0x48, 0x7d, 0xcb, 0x94, 0xc4, 0xa1, 0x14, 0xca, 0x6d, 0xcb, 0xce, 0xe7,
        0x25, 0xf1, 0x80, 0x50, 0x54, 0x71, 0xc4, 0x17, 0xe8, 0xe5, 0x77, 0x60, 0x7b, 0x41, 0x2c,
        0xe1, 0x6b,
    ];

    let crypto_salt = must(
        mosaic_crypto::derive_session_salt(DOMAIN, USERNAME),
        "crypto salt",
    );
    let wasm_salt = must(
        mosaic_wasm::derive_session_salt_from_username(DOMAIN.to_owned(), USERNAME.to_owned()),
        "wasm salt",
    );
    let uniffi_salt = must(
        mosaic_uniffi::derive_session_salt_from_username(DOMAIN.to_owned(), USERNAME.to_owned()),
        "uniffi salt",
    );
    assert_eq!(crypto_salt, GOLDEN_SALT);
    assert_eq!(wasm_salt, GOLDEN_SALT);
    assert_eq!(uniffi_salt, GOLDEN_SALT);

    let crypto_key = must(
        mosaic_crypto::derive_session_master_key(
            PASSWORD.to_vec().into(),
            &crypto_salt,
            2,
            64 * 1024,
        ),
        "crypto master key",
    );
    let wasm_handle = must(
        mosaic_wasm::derive_master_key_from_password(
            PASSWORD.to_vec(),
            wasm_salt.clone(),
            2,
            64 * 1024,
        ),
        "wasm master key handle",
    );
    let uniffi_handle = must(
        mosaic_uniffi::derive_master_key_from_password(
            PASSWORD.to_vec(),
            uniffi_salt.clone(),
            2,
            64 * 1024,
        ),
        "uniffi master key handle",
    );
    let wasm_key = must(
        mosaic_wasm::consume_master_key_handle_for_aes_gcm(wasm_handle),
        "wasm consume",
    );
    let uniffi_key = must(
        mosaic_uniffi::consume_master_key_handle_for_aes_gcm(uniffi_handle),
        "uniffi consume",
    );

    assert_eq!(crypto_key.as_bytes(), &GOLDEN_MASTER_KEY);
    assert_eq!(wasm_key, GOLDEN_MASTER_KEY);
    assert_eq!(uniffi_key, GOLDEN_MASTER_KEY);
}

#[test]
fn local_auth_account_salt_matches_known_vector_across_crypto_wasm_and_uniffi() {
    let expected = vec![
        0xf3, 0x5d, 0x00, 0xa0, 0xc4, 0x31, 0x2e, 0x17, 0xe8, 0x7d, 0x65, 0x3f, 0x64, 0xf3, 0x6a,
        0x4e,
    ];

    assert_eq!(
        mosaic_crypto::ACCOUNT_SALT_HMAC_INFO,
        b"mosaic_account_salt"
    );

    let crypto = mosaic_crypto::derive_account_salt(&USER_SALT).to_vec();
    let wasm = mosaic_wasm::derive_account_salt(USER_SALT.to_vec());
    let uniffi = mosaic_uniffi::derive_account_salt(USER_SALT.to_vec());

    assert_eq!(crypto, expected);
    assert_eq!(wasm, expected);
    assert_eq!(uniffi, expected);
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
fn protocol_sha256_helpers_match_known_vector_across_wasm_uniffi_and_sha2() {
    let input = b"abc".to_vec();
    let expected = vec![
        0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22,
        0x23, 0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00,
        0x15, 0xad,
    ];
    let expected_hex = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    let direct = Sha256::digest(&input).to_vec();
    let wasm = mosaic_wasm::sha256_of_bytes(input.clone());
    let uniffi = mosaic_uniffi::sha256_of_bytes(input.clone());

    assert_eq!(direct, expected);
    assert_eq!(wasm, expected);
    assert_eq!(uniffi, expected);
    assert_eq!(
        mosaic_wasm::sha256_hex_of_bytes(input.clone()),
        expected_hex
    );
    assert_eq!(mosaic_uniffi::sha256_hex_of_bytes(input), expected_hex);
}

#[test]
fn protocol_blake2b_scope_key_16_matches_known_vector_across_wasm_and_uniffi() {
    let input = b"account-idmosaic-tray-scope-v1".to_vec();
    let expected = vec![
        0x60, 0xe4, 0x4b, 0x7a, 0x59, 0xf5, 0xef, 0x45, 0xb8, 0x1b, 0x22, 0x74, 0x25, 0x1d, 0x7e,
        0x58,
    ];

    let wasm = mosaic_wasm::blake2b_scope_key_16(input.clone());
    let uniffi = mosaic_uniffi::blake2b_scope_key_16(input);

    assert_eq!(wasm, expected);
    assert_eq!(uniffi, expected);
}

#[test]
fn protocol_blake2b_snapshot_checksum_32_matches_known_vector_across_wasm_and_uniffi() {
    let input = b"mosaic snapshot body".to_vec();
    let expected = vec![
        0x08, 0x1c, 0x64, 0x76, 0x86, 0x59, 0xb8, 0x18, 0xd9, 0x95, 0xc2, 0x96, 0x7d, 0x91, 0xd5,
        0x3b, 0xf9, 0x4b, 0x6b, 0x7b, 0xf9, 0xf7, 0x19, 0x65, 0x6a, 0xe6, 0x70, 0xc5, 0x91, 0x92,
        0x72, 0x70,
    ];

    let wasm = mosaic_wasm::blake2b_snapshot_checksum_32(input.clone());
    let uniffi = mosaic_uniffi::blake2b_snapshot_checksum_32(input);

    assert_eq!(wasm, expected);
    assert_eq!(uniffi, expected);
}

#[test]
fn plaintext_content_hash_matches_sha256_across_wasm_and_uniffi() {
    let input = b"mosaic plaintext content".to_vec();
    let expected = "caab5e9856837cefa6f597cd56ff0bba59c1bdcc659fe038fd324fe7fbc2dcee";

    let direct = hex_lower(&Sha256::digest(&input));
    let wasm = mosaic_wasm::compute_plaintext_content_hash(input.clone());
    let uniffi = mosaic_uniffi::compute_plaintext_content_hash(input);

    assert_eq!(direct, expected);
    assert_eq!(wasm, expected);
    assert_eq!(uniffi, expected);
}

#[test]
fn canonical_upload_snapshot_cbor_matches_wasm_and_uniffi_facades() {
    let wasm = wasm_upload_snapshot();
    let uniffi = uniffi_upload_snapshot();

    let wasm_bytes = canonical_wasm_snapshot_bytes(&wasm);
    let uniffi_bytes = canonical_uniffi_snapshot_bytes(&uniffi);

    assert_eq!(wasm_bytes, uniffi_bytes);
}

#[test]
fn canonical_download_snapshot_cbor_matches_wasm_and_uniffi() {
    let wasm_plan = mosaic_wasm::download_build_plan_v1(&download_plan_builder_input_cbor());
    assert_ok_u32(wasm_plan.code, "wasm download build plan");
    let uniffi_plan = mosaic_uniffi::build_download_plan(download_plan_input());
    assert_ok(uniffi_plan.code, "uniffi download build plan");
    assert_eq!(wasm_plan.plan_cbor, uniffi_plan.plan_cbor);

    let init_input = download_init_input_cbor(&wasm_plan.plan_cbor);
    let wasm_snapshot = mosaic_wasm::download_init_snapshot_v1(&init_input);
    assert_ok_u32(wasm_snapshot.code, "wasm download init snapshot");
    let uniffi_snapshot = mosaic_uniffi::init_download_job(DownloadInitInput {
        job_id: uuid_to_bytes(JOB_ID),
        album_id: uuid_to_bytes(ALBUM_ID),
        plan_cbor: uniffi_plan.plan_cbor.clone(),
        now_ms: 1_700_000_020_000,
    });
    assert_ok(uniffi_snapshot.code, "uniffi download init snapshot");
    assert_eq!(wasm_snapshot.body, uniffi_snapshot.body);
    assert_eq!(wasm_snapshot.checksum, uniffi_snapshot.checksum);

    let wasm_load =
        mosaic_wasm::download_load_snapshot_v1(&wasm_snapshot.body, &wasm_snapshot.checksum);
    assert_ok_u32(wasm_load.code, "wasm download load snapshot");
    let uniffi_load = mosaic_uniffi::load_download_snapshot(
        uniffi_snapshot.body.clone(),
        uniffi_snapshot.checksum.clone(),
    );
    assert_ok(uniffi_load.code, "uniffi download load snapshot");
    assert_eq!(wasm_load.snapshot_cbor, uniffi_load.snapshot_cbor);
    assert_eq!(
        wasm_load.schema_version_loaded,
        uniffi_load.schema_version_loaded
    );

    let wasm_commit = mosaic_wasm::download_commit_snapshot_v1(&wasm_load.snapshot_cbor);
    assert_ok_u32(wasm_commit.code, "wasm download commit snapshot");
    let uniffi_commit = mosaic_uniffi::commit_download_snapshot(uniffi_load.snapshot_cbor.clone());
    assert_ok(uniffi_commit.code, "uniffi download commit snapshot");
    assert_eq!(wasm_commit.checksum, uniffi_commit.checksum);
    assert_eq!(uniffi_commit.body, uniffi_load.snapshot_cbor);

    let wasm_verify =
        mosaic_wasm::download_verify_snapshot_v1(&wasm_load.snapshot_cbor, &wasm_commit.checksum);
    let uniffi_verify = mosaic_uniffi::verify_download_snapshot(
        uniffi_load.snapshot_cbor.clone(),
        uniffi_commit.checksum.clone(),
    );
    assert_ok_u32(wasm_verify.code, "wasm download verify snapshot");
    assert_ok(uniffi_verify.code, "uniffi download verify snapshot");
    assert!(wasm_verify.valid);
    assert_eq!(wasm_verify.valid, uniffi_verify.valid);
    assert_eq!(
        wasm_commit.checksum,
        mosaic_wasm::blake2b_snapshot_checksum_32(wasm_load.snapshot_cbor.clone())
    );
    assert_eq!(
        uniffi_commit.checksum,
        mosaic_uniffi::blake2b_snapshot_checksum_32(uniffi_load.snapshot_cbor)
    );

    let mut wasm_state = download_state_cbor(0);
    let mut uniffi_state = wasm_state.clone();
    for event in [
        download_start_event_cbor(),
        download_plan_ready_event_cbor(),
    ] {
        let wasm_next = mosaic_wasm::download_apply_event_v1(&wasm_state, &event);
        let uniffi_next = mosaic_uniffi::apply_download_event(uniffi_state, event);
        assert_ok_u32(wasm_next.code, "wasm download apply event");
        assert_ok(uniffi_next.code, "uniffi download apply event");
        assert_eq!(wasm_next.new_state_cbor, uniffi_next.new_state_cbor);
        wasm_state = wasm_next.new_state_cbor;
        uniffi_state = uniffi_next.new_state_cbor;
    }
    assert_eq!(wasm_state, download_state_cbor(2));
}

#[test]
fn metadata_strip_outputs_match_wasm_and_uniffi() {
    for case in strip_cases() {
        let wasm = match case.format {
            StripFormat::Jpeg => {
                wasm_strip_result(mosaic_wasm::strip_jpeg_metadata_js(case.input.clone()))
            }
            StripFormat::Png => {
                wasm_strip_result(mosaic_wasm::strip_png_metadata_js(case.input.clone()))
            }
            StripFormat::WebP => {
                wasm_strip_result(mosaic_wasm::strip_webp_metadata_js(case.input.clone()))
            }
            StripFormat::Avif => {
                strip_result_from_media(mosaic_media::strip_avif_metadata(&case.input))
            }
            StripFormat::Heic => {
                strip_result_from_media(mosaic_media::strip_heic_metadata(&case.input))
            }
            StripFormat::Mp4 => {
                strip_result_from_media(mosaic_media::strip_video_metadata(&case.input))
            }
        };
        assert_ok(wasm.code, case.name);

        let uniffi = match case.format {
            StripFormat::Jpeg => {
                mosaic_uniffi::strip_known_metadata(UniMediaFormat::Jpeg, case.input.clone())
            }
            StripFormat::Png => {
                mosaic_uniffi::strip_known_metadata(UniMediaFormat::Png, case.input.clone())
            }
            StripFormat::WebP => {
                mosaic_uniffi::strip_known_metadata(UniMediaFormat::WebP, case.input.clone())
            }
            StripFormat::Avif => mosaic_uniffi::strip_avif_metadata(case.input.clone()),
            StripFormat::Heic => mosaic_uniffi::strip_heic_metadata(case.input.clone()),
            StripFormat::Mp4 => mosaic_uniffi::strip_video_metadata(case.input.clone()),
        };
        assert_ok(uniffi.code, case.name);

        assert_eq!(
            wasm.removed_metadata_count, uniffi.removed_metadata_count,
            "{}",
            case.name
        );
        assert_eq!(wasm.stripped_bytes, uniffi.stripped_bytes, "{}", case.name);
        if let Some(expected) = case.expected {
            assert_eq!(wasm.stripped_bytes, expected, "{}", case.name);
        }
    }
}

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
    let last = tampered
        .last_mut()
        .expect("encrypted streaming frame carries a tag byte");
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
    let last = tampered
        .last_mut()
        .expect("encrypted streaming frame carries a tag byte");
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

fn encoded_manifest_shards() -> Vec<u8> {
    let mut encoded = Vec::new();
    push_manifest_shard(&mut encoded, 1, ShardTier::Original, [0x20; 16], [0x22; 32]);
    push_manifest_shard(
        &mut encoded,
        0,
        ShardTier::Thumbnail,
        [0x10; 16],
        [0x11; 32],
    );
    encoded
}

fn push_manifest_shard(
    encoded: &mut Vec<u8>,
    chunk_index: u32,
    tier: ShardTier,
    shard_id: [u8; 16],
    sha256: [u8; 32],
) {
    encoded.extend_from_slice(&chunk_index.to_le_bytes());
    encoded.push(tier.to_byte());
    encoded.extend_from_slice(&shard_id);
    encoded.extend_from_slice(&sha256);
}

fn wrapped_account_key() -> Vec<u8> {
    let profile = match KdfProfile::new(MIN_KDF_MEMORY_KIB, MIN_KDF_ITERATIONS, 1) {
        Ok(value) => value,
        Err(error) => panic!("minimum Mosaic KDF profile should be valid: {error:?}"),
    };
    let material =
        match derive_account_key(PASSWORD.to_vec().into(), &USER_SALT, &ACCOUNT_SALT, profile) {
            Ok(value) => value,
            Err(error) => panic!("account key should derive: {error:?}"),
        };
    material.wrapped_account_key
}

fn unlock_wasm_account(wrapped_account_key: Vec<u8>) -> u64 {
    let result = mosaic_wasm::unlock_account_key(
        PASSWORD.to_vec(),
        WasmAccountUnlockRequest {
            user_salt: USER_SALT.to_vec(),
            account_salt: ACCOUNT_SALT.to_vec(),
            wrapped_account_key,
            kdf_memory_kib: MIN_KDF_MEMORY_KIB,
            kdf_iterations: MIN_KDF_ITERATIONS,
            kdf_parallelism: 1,
        },
    );
    assert_ok(result.code, "wasm unlock account");
    result.handle
}

fn unlock_uniffi_account(wrapped_account_key: Vec<u8>) -> u64 {
    let result = mosaic_uniffi::unlock_account_key(
        PASSWORD.to_vec(),
        UniAccountUnlockRequest {
            user_salt: USER_SALT.to_vec(),
            account_salt: ACCOUNT_SALT.to_vec(),
            wrapped_account_key,
            kdf_memory_kib: MIN_KDF_MEMORY_KIB,
            kdf_iterations: MIN_KDF_ITERATIONS,
            kdf_parallelism: 1,
        },
    );
    assert_ok(result.code, "uniffi unlock account");
    result.handle
}

fn close_epoch_handles(handles: &[u64]) {
    for handle in handles {
        let wasm_code = mosaic_wasm::close_epoch_key_handle(*handle);
        if wasm_code != ClientErrorCode::Ok.as_u16()
            && wasm_code != ClientErrorCode::EpochHandleNotFound.as_u16()
        {
            panic!("unexpected wasm close epoch code: {wasm_code}");
        }
        let uniffi_code = mosaic_uniffi::close_epoch_key_handle(*handle);
        if uniffi_code != ClientErrorCode::Ok.as_u16()
            && uniffi_code != ClientErrorCode::EpochHandleNotFound.as_u16()
        {
            panic!("unexpected uniffi close epoch code: {uniffi_code}");
        }
    }
}

fn close_account_handles(handles: &[u64]) {
    for handle in handles {
        let wasm_code = mosaic_wasm::close_account_key_handle(*handle);
        if wasm_code != ClientErrorCode::Ok.as_u16()
            && wasm_code != ClientErrorCode::SecretHandleNotFound.as_u16()
        {
            panic!("unexpected wasm close account code: {wasm_code}");
        }
        let uniffi_code = mosaic_uniffi::close_account_key_handle(*handle);
        if uniffi_code != ClientErrorCode::Ok.as_u16()
            && uniffi_code != ClientErrorCode::SecretHandleNotFound.as_u16()
        {
            panic!("unexpected uniffi close account code: {uniffi_code}");
        }
    }
}

fn wasm_upload_snapshot() -> WasmUploadJobSnapshot {
    WasmUploadJobSnapshot {
        schema_version: 1,
        job_id: JOB_ID.to_owned(),
        album_id: ALBUM_ID.to_owned(),
        phase: "AwaitingSyncConfirmation".to_owned(),
        retry_count: 1,
        max_retry_count: 5,
        next_retry_not_before_ms: 1_700_000_020_000,
        has_next_retry_not_before_ms: true,
        idempotency_key: IDEMPOTENCY_KEY.to_owned(),
        tiered_shards: vec![WasmUploadShardRef {
            tier: ShardTier::Original.to_byte(),
            shard_index: 0,
            shard_id: SHARD_ID.to_owned(),
            sha256: vec![0x11; 32],
            content_length: 1024,
            envelope_version: 3,
            uploaded: true,
        }],
        shard_set_hash: vec![0x22; 32],
        snapshot_revision: 2,
        last_effect_id: EFFECT_ID.to_owned(),
        last_acknowledged_effect_id: EFFECT_ID.to_owned(),
        last_applied_event_id: EFFECT_ID.to_owned(),
        failure_code: 0,
    }
}

fn uniffi_upload_snapshot() -> UniUploadJobSnapshot {
    UniUploadJobSnapshot {
        schema_version: 1,
        job_id: JOB_ID.to_owned(),
        album_id: ALBUM_ID.to_owned(),
        phase: "AwaitingSyncConfirmation".to_owned(),
        retry_count: 1,
        max_retry_count: 5,
        next_retry_not_before_ms: 1_700_000_020_000,
        has_next_retry_not_before_ms: true,
        idempotency_key: IDEMPOTENCY_KEY.to_owned(),
        tiered_shards: vec![UniUploadShardRef {
            tier: ShardTier::Original.to_byte(),
            shard_index: 0,
            shard_id: SHARD_ID.to_owned(),
            sha256: vec![0x11; 32],
            content_length: 1024,
            envelope_version: 3,
            uploaded: true,
        }],
        shard_set_hash: vec![0x22; 32],
        snapshot_revision: 2,
        last_effect_id: EFFECT_ID.to_owned(),
        last_acknowledged_effect_id: EFFECT_ID.to_owned(),
        last_applied_event_id: EFFECT_ID.to_owned(),
        failure_code: 0,
    }
}

fn canonical_wasm_snapshot_bytes(snapshot: &WasmUploadJobSnapshot) -> Vec<u8> {
    canonical_snapshot_bytes(
        snapshot.schema_version,
        &snapshot.job_id,
        &snapshot.album_id,
        &snapshot.phase,
        snapshot.retry_count,
        snapshot.max_retry_count,
        snapshot.next_retry_not_before_ms,
        snapshot.has_next_retry_not_before_ms,
        &snapshot.idempotency_key,
        snapshot
            .tiered_shards
            .iter()
            .map(|shard| CanonicalShard {
                tier: shard.tier,
                shard_index: shard.shard_index,
                shard_id: &shard.shard_id,
                sha256: &shard.sha256,
                content_length: shard.content_length,
                envelope_version: shard.envelope_version,
                uploaded: shard.uploaded,
            })
            .collect(),
        &snapshot.shard_set_hash,
        snapshot.snapshot_revision,
        &snapshot.last_acknowledged_effect_id,
        &snapshot.last_applied_event_id,
        snapshot.failure_code,
    )
}

fn canonical_uniffi_snapshot_bytes(snapshot: &UniUploadJobSnapshot) -> Vec<u8> {
    canonical_snapshot_bytes(
        snapshot.schema_version,
        &snapshot.job_id,
        &snapshot.album_id,
        &snapshot.phase,
        snapshot.retry_count,
        snapshot.max_retry_count,
        snapshot.next_retry_not_before_ms,
        snapshot.has_next_retry_not_before_ms,
        &snapshot.idempotency_key,
        snapshot
            .tiered_shards
            .iter()
            .map(|shard| CanonicalShard {
                tier: shard.tier,
                shard_index: shard.shard_index,
                shard_id: &shard.shard_id,
                sha256: &shard.sha256,
                content_length: shard.content_length,
                envelope_version: shard.envelope_version,
                uploaded: shard.uploaded,
            })
            .collect(),
        &snapshot.shard_set_hash,
        snapshot.snapshot_revision,
        &snapshot.last_acknowledged_effect_id,
        &snapshot.last_applied_event_id,
        snapshot.failure_code,
    )
}

struct CanonicalShard<'a> {
    tier: u8,
    shard_index: u32,
    shard_id: &'a str,
    sha256: &'a [u8],
    content_length: u64,
    envelope_version: u8,
    uploaded: bool,
}

#[allow(clippy::too_many_arguments)]
fn canonical_snapshot_bytes(
    schema_version: u32,
    job_id: &str,
    album_id: &str,
    phase: &str,
    retry_count: u32,
    max_retry_count: u8,
    next_retry_not_before_ms: i64,
    has_next_retry_not_before_ms: bool,
    idempotency_key: &str,
    tiered_shards: Vec<CanonicalShard<'_>>,
    shard_set_hash: &[u8],
    snapshot_revision: u64,
    last_acknowledged_effect_id: &str,
    last_applied_event_id: &str,
    failure_code: u16,
) -> Vec<u8> {
    let value = Value::Map(vec![
        cbor_pair(0, Value::Integer(schema_version.into())),
        cbor_pair(1, Value::Bytes(uuid_to_bytes(job_id))),
        cbor_pair(2, Value::Bytes(uuid_to_bytes(album_id))),
        cbor_pair(3, Value::Text(phase.to_owned())),
        cbor_pair(4, Value::Integer(retry_count.into())),
        cbor_pair(5, Value::Integer(max_retry_count.into())),
        cbor_pair(
            6,
            if has_next_retry_not_before_ms {
                Value::Integer(next_retry_not_before_ms.into())
            } else {
                Value::Null
            },
        ),
        cbor_pair(7, Value::Bytes(uuid_to_bytes(idempotency_key))),
        cbor_pair(
            8,
            Value::Array(
                tiered_shards
                    .into_iter()
                    .map(canonical_shard_value)
                    .collect(),
            ),
        ),
        cbor_pair(9, Value::Bytes(shard_set_hash.to_vec())),
        cbor_pair(10, Value::Integer(snapshot_revision.into())),
        cbor_pair(11, optional_uuid_value(last_acknowledged_effect_id)),
        cbor_pair(12, optional_uuid_value(last_applied_event_id)),
        cbor_pair(
            13,
            if failure_code == 0 {
                Value::Null
            } else {
                Value::Integer(failure_code.into())
            },
        ),
    ]);
    let mut bytes = Vec::new();
    if let Err(error) = ciborium::ser::into_writer(&value, &mut bytes) {
        panic!("snapshot CBOR should encode: {error:?}");
    }
    bytes
}

fn cbor_pair(key: u32, value: Value) -> (Value, Value) {
    (Value::Integer(key.into()), value)
}

fn canonical_shard_value(shard: CanonicalShard<'_>) -> Value {
    Value::Map(vec![
        cbor_pair(0, Value::Integer(shard.tier.into())),
        cbor_pair(1, Value::Integer(shard.shard_index.into())),
        cbor_pair(2, Value::Bytes(uuid_to_bytes(shard.shard_id))),
        cbor_pair(3, Value::Bytes(shard.sha256.to_vec())),
        cbor_pair(4, Value::Integer(shard.content_length.into())),
        cbor_pair(5, Value::Integer(shard.envelope_version.into())),
        cbor_pair(6, Value::Bool(shard.uploaded)),
    ])
}

fn optional_uuid_value(uuid: &str) -> Value {
    if uuid.is_empty() {
        Value::Null
    } else {
        Value::Bytes(uuid_to_bytes(uuid))
    }
}

#[derive(Clone, Copy)]
enum StripFormat {
    Jpeg,
    Png,
    WebP,
    Avif,
    Heic,
    Mp4,
}

struct StripCase {
    name: &'static str,
    format: StripFormat,
    input: Vec<u8>,
    expected: Option<Vec<u8>>,
}

fn strip_cases() -> Vec<StripCase> {
    vec![
        StripCase {
            name: "jpeg web strip corpus",
            format: StripFormat::Jpeg,
            input: include_bytes!(
                "../../../apps/web/tests/fixtures/strip-corpus/jpeg-with-appn.jpg"
            )
            .to_vec(),
            expected: Some(
                include_bytes!(
                    "../../../apps/web/tests/fixtures/strip-corpus/jpeg-with-appn.stripped.jpg"
                )
                .to_vec(),
            ),
        },
        StripCase {
            name: "png web strip corpus",
            format: StripFormat::Png,
            input: include_bytes!(
                "../../../apps/web/tests/fixtures/strip-corpus/png-with-text.png"
            )
            .to_vec(),
            expected: Some(
                include_bytes!(
                    "../../../apps/web/tests/fixtures/strip-corpus/png-with-text.stripped.png"
                )
                .to_vec(),
            ),
        },
        StripCase {
            name: "webp web strip corpus",
            format: StripFormat::WebP,
            input: include_bytes!(
                "../../../apps/web/tests/fixtures/strip-corpus/webp-with-metadata.webp"
            )
            .to_vec(),
            expected: Some(
                include_bytes!(
                    "../../../apps/web/tests/fixtures/strip-corpus/webp-with-metadata.stripped.webp"
                )
                .to_vec(),
            ),
        },
        StripCase {
            name: "avif media strip corpus",
            format: StripFormat::Avif,
            input: include_bytes!(
                "../../mosaic-media/tests/avif_corpus/synthetic-with-metadata.avif"
            )
            .to_vec(),
            expected: Some(
                include_bytes!(
                    "../../mosaic-media/tests/avif_corpus/synthetic-with-metadata.stripped.avif"
                )
                .to_vec(),
            ),
        },
        StripCase {
            name: "heic media strip corpus",
            format: StripFormat::Heic,
            input: include_bytes!(
                "../../mosaic-media/tests/heic_corpus/synthetic-with-metadata.heic"
            )
            .to_vec(),
            expected: Some(
                include_bytes!(
                    "../../mosaic-media/tests/heic_corpus/synthetic-with-metadata.stripped.heic"
                )
                .to_vec(),
            ),
        },
        StripCase {
            name: "synthetic mp4 strip corpus",
            format: StripFormat::Mp4,
            input: synthetic_mp4(),
            expected: None,
        },
    ]
}

fn strip_result_from_media(
    result: Result<mosaic_media::StrippedMedia, mosaic_media::MosaicMediaError>,
) -> SimpleStripResult {
    match result {
        Ok(stripped) => SimpleStripResult {
            code: ClientErrorCode::Ok.as_u16(),
            removed_metadata_count: match u32::try_from(stripped.removed.len()) {
                Ok(value) => value,
                Err(error) => panic!("metadata count should fit u32: {error:?}"),
            },
            stripped_bytes: stripped.bytes,
        },
        Err(error) => SimpleStripResult {
            code: media_error_code(error),
            removed_metadata_count: 0,
            stripped_bytes: Vec::new(),
        },
    }
}

struct SimpleStripResult {
    code: u16,
    stripped_bytes: Vec<u8>,
    removed_metadata_count: u32,
}

fn wasm_strip_result(result: mosaic_wasm::JsStripResult) -> SimpleStripResult {
    SimpleStripResult {
        code: result.code(),
        stripped_bytes: result.stripped_bytes(),
        removed_metadata_count: result.removed_metadata_count(),
    }
}

fn media_error_code(error: mosaic_media::MosaicMediaError) -> u16 {
    match error {
        mosaic_media::MosaicMediaError::UnsupportedFormat => {
            ClientErrorCode::UnsupportedMediaFormat.as_u16()
        }
        mosaic_media::MosaicMediaError::InvalidJpeg
        | mosaic_media::MosaicMediaError::InvalidPng
        | mosaic_media::MosaicMediaError::InvalidWebP => {
            ClientErrorCode::InvalidMediaContainer.as_u16()
        }
        mosaic_media::MosaicMediaError::InvalidDimensions => {
            ClientErrorCode::InvalidMediaDimensions.as_u16()
        }
        mosaic_media::MosaicMediaError::OutputTooLarge => {
            ClientErrorCode::MediaOutputTooLarge.as_u16()
        }
        mosaic_media::MosaicMediaError::ImageMetadataMismatch => {
            ClientErrorCode::MediaMetadataMismatch.as_u16()
        }
        mosaic_media::MosaicMediaError::MetadataSidecar(_) => {
            ClientErrorCode::InvalidMediaSidecar.as_u16()
        }
        mosaic_media::MosaicMediaError::EncodedTierMismatch { .. } => {
            ClientErrorCode::MediaAdapterOutputMismatch.as_u16()
        }
    }
}

fn encoded_metadata_fields(fields: &[(u16, &[u8])]) -> Vec<u8> {
    let mut encoded = Vec::new();
    for (tag, value) in fields {
        encoded.extend_from_slice(&tag.to_le_bytes());
        let len = match u32::try_from(value.len()) {
            Ok(value) => value,
            Err(error) => panic!("metadata value length should fit u32: {error:?}"),
        };
        encoded.extend_from_slice(&len.to_le_bytes());
        encoded.extend_from_slice(value);
    }
    encoded
}

fn patterned_plaintext(len: usize) -> Vec<u8> {
    (0..len)
        .map(|index| {
            let value = index % 251;
            match u8::try_from(value) {
                Ok(byte) => byte,
                Err(error) => panic!("pattern byte should fit u8: {error:?}"),
            }
        })
        .collect()
}

fn synthetic_mp4() -> Vec<u8> {
    let mut bytes = ftyp_box(*b"isom");
    let trak = trak_box(*b"avc1", 640, 480, 1_000, 1_000, 25);
    let mut moov_payload = Vec::new();
    moov_payload.extend_from_slice(&trak);
    moov_payload.extend_from_slice(&bmff_box(*b"udta", &bmff_box(*b"name", b"metadata")));
    moov_payload.extend_from_slice(&bmff_box(*b"meta", &[0, 0, 0, 0]));
    bytes.extend_from_slice(&bmff_box(*b"moov", &moov_payload));
    bytes.extend_from_slice(&bmff_box(*b"mdat", b"video-frames"));
    bytes
}

fn trak_box(
    codec: [u8; 4],
    width: u32,
    height: u32,
    timescale: u32,
    duration: u32,
    fps: u32,
) -> Vec<u8> {
    let mut mdia = Vec::new();
    mdia.extend_from_slice(&mdhd_box(timescale, duration));
    mdia.extend_from_slice(&hdlr_box());
    mdia.extend_from_slice(&bmff_box(
        *b"minf",
        &bmff_box(*b"stbl", &stbl_box(codec, timescale / fps)),
    ));
    let mut trak = tkhd_box(width, height);
    trak.extend_from_slice(&bmff_box(*b"mdia", &mdia));
    bmff_box(*b"trak", &trak)
}

fn ftyp_box(brand: [u8; 4]) -> Vec<u8> {
    let mut payload = brand.to_vec();
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&brand);
    payload.extend_from_slice(b"mp42");
    bmff_box(*b"ftyp", &payload)
}

fn tkhd_box(width: u32, height: u32) -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&1_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&[0; 8]);
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&[
        0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x01, 0x00, 0x00, 0, 0,
        0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0,
    ]);
    payload.extend_from_slice(&(width << 16).to_be_bytes());
    payload.extend_from_slice(&(height << 16).to_be_bytes());
    bmff_box(*b"tkhd", &payload)
}

fn mdhd_box(timescale: u32, duration: u32) -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&timescale.to_be_bytes());
    payload.extend_from_slice(&duration.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    bmff_box(*b"mdhd", &payload)
}

fn hdlr_box() -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(b"vide");
    payload.extend_from_slice(&[0_u8; 12]);
    payload.push(0);
    bmff_box(*b"hdlr", &payload)
}

fn stbl_box(codec: [u8; 4], sample_delta: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&stsd_box(codec));
    payload.extend_from_slice(&stts_box(60, sample_delta));
    payload
}

fn stsd_box(codec: [u8; 4]) -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    payload.extend_from_slice(&1_u32.to_be_bytes());
    payload.extend_from_slice(&86_u32.to_be_bytes());
    payload.extend_from_slice(&codec);
    payload.extend_from_slice(&[0; 78]);
    bmff_box(*b"stsd", &payload)
}

fn stts_box(sample_count: u32, sample_delta: u32) -> Vec<u8> {
    let mut payload = vec![0, 0, 0, 0];
    payload.extend_from_slice(&1_u32.to_be_bytes());
    payload.extend_from_slice(&sample_count.to_be_bytes());
    payload.extend_from_slice(&sample_delta.to_be_bytes());
    bmff_box(*b"stts", &payload)
}

fn bmff_box(kind: [u8; 4], payload: &[u8]) -> Vec<u8> {
    let size = match u32::try_from(payload.len() + 8) {
        Ok(value) => value,
        Err(error) => panic!("box size should fit u32: {error:?}"),
    };
    let mut bytes = Vec::with_capacity(payload.len() + 8);
    bytes.extend_from_slice(&size.to_be_bytes());
    bytes.extend_from_slice(&kind);
    bytes.extend_from_slice(payload);
    bytes
}

fn bytes_to_uuid(bytes: &[u8; 16]) -> String {
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn uuid_to_bytes(uuid: &str) -> Vec<u8> {
    let compact = uuid.replace('-', "");
    if compact.len() != 32 {
        panic!("uuid should have 32 hex digits after removing hyphens: {uuid}");
    }
    let mut bytes = Vec::with_capacity(16);
    for index in (0..compact.len()).step_by(2) {
        let byte = match u8::from_str_radix(&compact[index..index + 2], 16) {
            Ok(value) => value,
            Err(error) => panic!("uuid should be hex: {error:?}"),
        };
        bytes.push(byte);
    }
    bytes
}

fn fixed_identity_seed() -> [u8; 32] {
    [
        0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f, 0x50,
        0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f,
        0x60, 0x61,
    ]
}

#[cfg(feature = "cross-client-vectors")]
fn fixed_recipient_identity_seed() -> [u8; 32] {
    [
        0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
        0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xbb, 0xbc, 0xbd, 0xbe,
        0xbf, 0xc0,
    ]
}

#[cfg(feature = "cross-client-vectors")]
fn fixed_sidecar_seed() -> [u8; 32] {
    [
        0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e,
        0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d,
        0x4e, 0x4f,
    ]
}

fn fixed_manifest_transcript() -> Vec<u8> {
    let result = mosaic_wasm::manifest_transcript_bytes(
        ALBUM_ID_BYTES.to_vec(),
        19,
        vec![0x90, 0x91, 0x92, 0x93],
        encoded_manifest_shards(),
    );
    assert_ok(result.code, "fixed manifest transcript");
    result.bytes
}

fn fixed_account_and_wrapped_identity_seed() -> (Vec<u8>, Vec<u8>) {
    let profile = match KdfProfile::new(MIN_KDF_MEMORY_KIB, MIN_KDF_ITERATIONS, 1) {
        Ok(value) => value,
        Err(error) => panic!("minimum Mosaic KDF profile should be valid: {error:?}"),
    };
    let material =
        match derive_account_key(PASSWORD.to_vec().into(), &USER_SALT, &ACCOUNT_SALT, profile) {
            Ok(value) => value,
            Err(error) => panic!("account key should derive: {error:?}"),
        };
    let wrapped_identity_seed = match mosaic_crypto::wrap_secret_with_aad(
        &fixed_identity_seed(),
        &material.account_key,
        mosaic_crypto::IDENTITY_SEED_AAD,
    ) {
        Ok(bytes) => bytes,
        Err(error) => panic!("fixed identity seed should wrap: {error:?}"),
    };
    (material.wrapped_account_key, wrapped_identity_seed)
}

fn cbor_bytes(value: Value) -> Vec<u8> {
    let mut bytes = Vec::new();
    if let Err(error) = ciborium::ser::into_writer(&value, &mut bytes) {
        panic!("CBOR fixture should encode: {error:?}");
    }
    bytes
}

fn download_plan_builder_input_cbor() -> Vec<u8> {
    let shard = Value::Map(vec![
        cbor_pair(0, Value::Bytes(uuid_to_bytes(SHARD_ID))),
        cbor_pair(1, Value::Integer(7.into())),
        cbor_pair(2, Value::Integer(ShardTier::Original.to_byte().into())),
        cbor_pair(3, Value::Bytes(vec![0x55; 32])),
        cbor_pair(4, Value::Integer(1234.into())),
    ]);
    let photo = Value::Map(vec![
        cbor_pair(
            0,
            Value::Text(PHOTO_ID_BYTES.iter().map(|b| format!("{b:02x}")).collect()),
        ),
        cbor_pair(1, Value::Text("IMG_0001.JPG".to_owned())),
        cbor_pair(2, Value::Array(vec![shard])),
    ]);
    cbor_bytes(Value::Map(vec![cbor_pair(0, Value::Array(vec![photo]))]))
}

fn download_plan_input() -> DownloadPlanInput {
    DownloadPlanInput {
        album_id: uuid_to_bytes(ALBUM_ID),
        entries: vec![DownloadPlanEntryInput {
            photo_id: PHOTO_ID_BYTES.iter().map(|b| format!("{b:02x}")).collect(),
            filename: "IMG_0001.JPG".to_owned(),
            shards: vec![DownloadPlanShardInput {
                shard_id: uuid_to_bytes(SHARD_ID),
                epoch_id: 7,
                tier: ShardTier::Original.to_byte(),
                expected_hash: vec![0x55; 32],
                declared_size: 1234,
            }],
        }],
    }
}

fn download_init_input_cbor(plan_cbor: &[u8]) -> Vec<u8> {
    cbor_bytes(Value::Map(vec![
        cbor_pair(0, Value::Bytes(uuid_to_bytes(JOB_ID))),
        cbor_pair(1, Value::Bytes(uuid_to_bytes(ALBUM_ID))),
        cbor_pair(2, Value::Bytes(plan_cbor.to_vec())),
        cbor_pair(3, Value::Integer(1_700_000_020_000_i64.into())),
        cbor_pair(4, Value::Text(legacy_scope_for_job())),
    ]))
}

fn legacy_scope_for_job() -> String {
    format!("legacy:{}", JOB_ID.replace('-', ""))
}

fn download_state_cbor(state: u8) -> Vec<u8> {
    cbor_bytes(Value::Map(vec![cbor_pair(0, Value::Integer(state.into()))]))
}

fn download_start_event_cbor() -> Vec<u8> {
    cbor_bytes(Value::Map(vec![
        cbor_pair(0, Value::Integer(0.into())),
        cbor_pair(1, Value::Bytes(uuid_to_bytes(JOB_ID))),
        cbor_pair(2, Value::Bytes(uuid_to_bytes(ALBUM_ID))),
    ]))
}

fn download_plan_ready_event_cbor() -> Vec<u8> {
    cbor_bytes(Value::Map(vec![cbor_pair(0, Value::Integer(1.into()))]))
}

#[cfg(feature = "cross-client-vectors")]
struct SealedBundleFixture {
    wasm_account_handle: u64,
    wasm_identity_handle: u64,
    wasm_epoch_handle: u64,
    uniffi_opened_epoch_handle: u64,
    opened_epoch_id: u32,
    opened_album_id: String,
    recipient_pubkey: Vec<u8>,
    opened_recipient_pubkey: Vec<u8>,
    sign_public_key: Vec<u8>,
    wasm_sign_public_key: Vec<u8>,
}

#[cfg(feature = "cross-client-vectors")]
impl SealedBundleFixture {
    fn close(self) {
        close_epoch_handles(&[self.wasm_epoch_handle, self.uniffi_opened_epoch_handle]);
        close_identity_handles(&[self.wasm_identity_handle]);
        close_account_handles(&[self.wasm_account_handle]);
    }
}

#[cfg(feature = "cross-client-vectors")]
fn wasm_sealed_bundle_opened_by_uniffi_fixture(epoch_id: u32) -> SealedBundleFixture {
    let wrapped_account_key = wrapped_account_key();
    let wasm_account = unlock_wasm_account(wrapped_account_key);
    let wasm_identity = mosaic_wasm::create_identity_handle(wasm_account);
    assert_ok(wasm_identity.code, "wasm create bundle sharer identity");
    let wasm_epoch = mosaic_wasm::create_epoch_key_handle(wasm_account, epoch_id);
    assert_ok(wasm_epoch.code, "wasm create bundle epoch");

    let recipient_seed = fixed_recipient_identity_seed();
    let recipient = mosaic_uniffi::derive_identity_from_raw_seed(
        recipient_seed.to_vec(),
        b"recipient-public-key-probe".to_vec(),
    );
    assert_ok(recipient.code, "uniffi derive recipient identity");

    let sealed = mosaic_wasm::seal_bundle_with_epoch_handle(
        wasm_identity.handle,
        wasm_epoch.handle,
        recipient.signing_pubkey.clone(),
        ALBUM_ID.to_owned(),
    );
    assert_ok(sealed.code, "wasm seal epoch bundle");
    assert_eq!(sealed.sharer_pubkey, wasm_identity.signing_pubkey);

    let opened = mosaic_uniffi::verify_and_open_bundle_with_recipient_seed(
        recipient_seed.to_vec(),
        sealed.sealed,
        sealed.signature,
        sealed.sharer_pubkey,
        wasm_identity.signing_pubkey.clone(),
        ALBUM_ID.to_owned(),
        epoch_id,
        false,
    );
    assert_ok(opened.code, "uniffi open wasm sealed bundle");

    SealedBundleFixture {
        wasm_account_handle: wasm_account,
        wasm_identity_handle: wasm_identity.handle,
        wasm_epoch_handle: wasm_epoch.handle,
        uniffi_opened_epoch_handle: opened.epoch_handle_id,
        opened_epoch_id: opened.epoch_id,
        opened_album_id: opened.album_id,
        recipient_pubkey: recipient.signing_pubkey,
        opened_recipient_pubkey: opened.recipient_pubkey,
        sign_public_key: opened.sign_public_key,
        wasm_sign_public_key: wasm_epoch.sign_public_key,
    }
}

#[cfg(feature = "cross-client-vectors")]
fn streaming_round_trip_case(name: &str, plaintext: Vec<u8>, chunk_sizes: &[usize]) {
    let wrapped_account_key = wrapped_account_key();
    let wasm_account = unlock_wasm_account(wrapped_account_key.clone());
    let uniffi_account = unlock_uniffi_account(wrapped_account_key);
    let wasm_epoch = mosaic_wasm::create_epoch_key_handle(wasm_account, 121);
    assert_ok(wasm_epoch.code, "wasm create streaming parity epoch");
    let uniffi_epoch = mosaic_uniffi::open_epoch_key_handle(
        wasm_epoch.wrapped_epoch_seed.clone(),
        uniffi_account,
        121,
    );
    assert_ok(uniffi_epoch.code, "uniffi open streaming parity epoch");

    let mut wasm_encryptor = mosaic_wasm::StreamingShardEncryptor::new(
        wasm_epoch.handle,
        ShardTier::Original.to_byte(),
        Some(u32::try_from(chunk_sizes.len()).expect("chunk count fits u32")),
    );
    let mut offset = 0;
    let mut wasm_frames = Vec::new();
    for (index, size) in chunk_sizes.iter().copied().enumerate() {
        let frame =
            wasm_encryptor.encrypt_frame_for_tests(plaintext[offset..offset + size].to_vec());
        assert_ok(frame.code, name);
        assert_eq!(
            frame.frame_index,
            u32::try_from(index).expect("frame index fits u32")
        );
        wasm_frames.push(frame.bytes);
        offset += size;
    }
    assert_eq!(offset, plaintext.len(), "{name}");
    let wasm_envelope = wasm_encryptor.finalize_for_tests();
    assert_ok(wasm_envelope.code, name);

    let uniffi_decryptor =
        match mosaic_uniffi::StreamingDecryptor::new(uniffi_epoch.handle, wasm_envelope.bytes) {
            Ok(value) => value,
            Err(error) => panic!("{name}: uniffi decryptor should open wasm envelope: {error:?}"),
        };
    let mut decrypted = Vec::new();
    for frame in wasm_frames {
        let bytes = match uniffi_decryptor.decrypt_frame(frame) {
            Ok(bytes) => bytes,
            Err(error) => panic!("{name}: uniffi should decrypt wasm frame: {error:?}"),
        };
        decrypted.extend_from_slice(&bytes);
    }
    if let Err(error) = uniffi_decryptor.finalize() {
        panic!("{name}: uniffi decryptor should finalize: {error:?}");
    }
    assert_eq!(decrypted, plaintext, "{name}");

    let uniffi_encryptor = match mosaic_uniffi::StreamingEncryptor::new(
        uniffi_epoch.handle,
        ShardTier::Original.to_byte(),
        Some(u32::try_from(chunk_sizes.len()).expect("chunk count fits u32")),
    ) {
        Ok(value) => value,
        Err(error) => panic!("{name}: uniffi encryptor should initialize: {error:?}"),
    };
    let mut offset = 0;
    let mut uniffi_frames = Vec::new();
    for (index, size) in chunk_sizes.iter().copied().enumerate() {
        let frame = match uniffi_encryptor.encrypt_frame(plaintext[offset..offset + size].to_vec())
        {
            Ok(frame) => frame,
            Err(error) => panic!("{name}: uniffi should encrypt frame: {error:?}"),
        };
        assert_eq!(
            frame.frame_index,
            u32::try_from(index).expect("frame index fits u32")
        );
        uniffi_frames.push(frame.bytes);
        offset += size;
    }
    let uniffi_envelope = match uniffi_encryptor.finalize() {
        Ok(bytes) => bytes,
        Err(error) => panic!("{name}: uniffi should finalize envelope: {error:?}"),
    };
    let mut wasm_decryptor =
        mosaic_wasm::StreamingShardDecryptor::new(wasm_epoch.handle, uniffi_envelope);
    let mut wasm_decrypted = Vec::new();
    for frame in uniffi_frames {
        let result = wasm_decryptor.decrypt_frame_for_tests(frame);
        assert_ok(result.code, name);
        wasm_decrypted.extend_from_slice(&result.plaintext);
    }
    let finalized = wasm_decryptor.finalize_for_tests();
    assert_ok(finalized.code, name);
    assert_eq!(finalized.bytes, Vec::<u8>::new(), "{name}");
    assert_eq!(wasm_decrypted, plaintext, "{name}");

    close_epoch_handles(&[wasm_epoch.handle, uniffi_epoch.handle]);
    close_account_handles(&[wasm_account, uniffi_account]);
}

fn close_identity_handles(handles: &[u64]) {
    for handle in handles {
        let wasm_code = mosaic_wasm::close_identity_handle(*handle);
        if wasm_code != ClientErrorCode::Ok.as_u16()
            && wasm_code != ClientErrorCode::IdentityHandleNotFound.as_u16()
        {
            panic!("unexpected wasm close identity code: {wasm_code}");
        }
        let uniffi_code = mosaic_uniffi::close_identity_handle(*handle);
        if uniffi_code != ClientErrorCode::Ok.as_u16()
            && uniffi_code != ClientErrorCode::IdentityHandleNotFound.as_u16()
        {
            panic!("unexpected uniffi close identity code: {uniffi_code}");
        }
    }
}

fn assert_ok(code: u16, context: &str) {
    assert_eq!(code, ClientErrorCode::Ok.as_u16(), "{context}");
}

fn assert_ok_u32(code: u32, context: &str) {
    assert_eq!(code, u32::from(ClientErrorCode::Ok.as_u16()), "{context}");
}
