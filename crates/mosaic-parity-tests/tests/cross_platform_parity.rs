use ciborium::value::Value;
use mosaic_client::ClientErrorCode;
use mosaic_crypto::{KdfProfile, MIN_KDF_ITERATIONS, MIN_KDF_MEMORY_KIB, derive_account_key};
use mosaic_domain::{
    SHARD_ENVELOPE_VERSION_V04, STREAMING_SHARD_FRAME_SIZE, ShardTier, metadata_field_tags,
};
use mosaic_uniffi::{
    AccountUnlockRequest as UniAccountUnlockRequest, ClientCoreManifestShardRef,
    ClientCoreManifestTranscriptInputs, ClientCoreUploadJobSnapshot as UniUploadJobSnapshot,
    ClientCoreUploadShardRef as UniUploadShardRef, MediaFormat as UniMediaFormat,
};
use mosaic_wasm::{
    AccountUnlockRequest as WasmAccountUnlockRequest,
    ClientCoreUploadJobSnapshot as WasmUploadJobSnapshot,
    ClientCoreUploadShardRef as WasmUploadShardRef,
};

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

#[test]
fn finalize_idempotency_key_parity() {
    let job_id = mosaic_client::Uuid::from_bytes([
        0x01, 0x95, 0x00, 0x00, 0x00, 0x00, 0x70, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00,
    ]);
    let job_id_string = "01950000-0000-7000-8000-000000000000".to_owned();

    let from_wasm = mosaic_wasm::finalize_idempotency_key(job_id_string.clone()).unwrap();
    let from_uniffi = mosaic_uniffi::finalize_idempotency_key(job_id_string).unwrap();
    let from_client = mosaic_client::finalize_idempotency_key(&job_id);

    assert_eq!(from_wasm, from_uniffi);
    assert_eq!(from_wasm, from_client);
    assert_eq!(
        from_wasm,
        "mosaic-finalize-01950000-0000-7000-8000-000000000000"
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
        wasm_encrypted.envelope_bytes,
    );
    assert_ok(uniffi_decrypted.code, "uniffi decrypt wasm envelope");
    assert_eq!(uniffi_decrypted.plaintext, plaintext);

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
fn canonical_upload_snapshot_cbor_matches_wasm_and_uniffi_facades() {
    let wasm = wasm_upload_snapshot();
    let uniffi = uniffi_upload_snapshot();

    let wasm_bytes = canonical_wasm_snapshot_bytes(&wasm);
    let uniffi_bytes = canonical_uniffi_snapshot_bytes(&uniffi);

    assert_eq!(wasm_bytes, uniffi_bytes);
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

fn assert_ok(code: u16, context: &str) {
    assert_eq!(code, ClientErrorCode::Ok.as_u16(), "{context}");
}
