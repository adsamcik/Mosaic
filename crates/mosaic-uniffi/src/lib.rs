//! UniFFI/JNI facade boundary crate for the Mosaic Android integration.

#![forbid(unsafe_code)]

use mosaic_domain::{MetadataSidecar, MetadataSidecarError, MetadataSidecarField, ShardTier};
use zeroize::{Zeroize, Zeroizing};

/// UniFFI record for header parse results.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct HeaderResult {
    pub code: u16,
    pub epoch_id: u32,
    pub shard_index: u32,
    pub tier: u8,
    pub nonce: Vec<u8>,
}

/// UniFFI record for progress events.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ProgressEvent {
    pub completed_steps: u32,
    pub total_steps: u32,
}

/// UniFFI record for progress results.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ProgressResult {
    pub code: u16,
    pub events: Vec<ProgressEvent>,
}

/// UniFFI record for byte-array results.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct BytesResult {
    pub code: u16,
    pub bytes: Vec<u8>,
}

/// UniFFI record for non-secret account unlock parameters.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AccountUnlockRequest {
    pub user_salt: Vec<u8>,
    pub account_salt: Vec<u8>,
    pub wrapped_account_key: Vec<u8>,
    pub kdf_memory_kib: u32,
    pub kdf_iterations: u32,
    pub kdf_parallelism: u32,
}

/// UniFFI record for account unlock results.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AccountUnlockResult {
    pub code: u16,
    pub handle: u64,
}

/// UniFFI record for account-key handle status checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct AccountKeyHandleStatusResult {
    pub code: u16,
    pub is_open: bool,
}

/// UniFFI record for identity handle results.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct IdentityHandleResult {
    pub code: u16,
    pub handle: u64,
    pub signing_pubkey: Vec<u8>,
    pub encryption_pubkey: Vec<u8>,
    pub wrapped_seed: Vec<u8>,
}

/// UniFFI record for epoch-key handle results.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct EpochKeyHandleResult {
    pub code: u16,
    pub handle: u64,
    pub epoch_id: u32,
    pub wrapped_epoch_seed: Vec<u8>,
}

/// UniFFI record for epoch-key handle status checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct EpochKeyHandleStatusResult {
    pub code: u16,
    pub is_open: bool,
}

/// UniFFI record for encrypted shard results.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct EncryptedShardResult {
    pub code: u16,
    pub envelope_bytes: Vec<u8>,
    pub sha256: String,
}

/// UniFFI record for decrypted shard results.
///
/// This record carries client-local plaintext media bytes on success and
/// intentionally does not implement `Debug`.
#[derive(Clone, PartialEq, Eq, uniffi::Record)]
pub struct DecryptedShardResult {
    pub code: u16,
    pub plaintext: Vec<u8>,
}

/// UniFFI record for public crypto/domain golden-vector snapshots.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CryptoDomainGoldenVectorSnapshot {
    pub code: u16,
    pub envelope_header: Vec<u8>,
    pub envelope_epoch_id: u32,
    pub envelope_shard_index: u32,
    pub envelope_tier: u8,
    pub envelope_nonce: Vec<u8>,
    pub manifest_transcript: Vec<u8>,
    pub identity_message: Vec<u8>,
    pub identity_signing_pubkey: Vec<u8>,
    pub identity_encryption_pubkey: Vec<u8>,
    pub identity_signature: Vec<u8>,
}

/// UniFFI record for a privacy-safe uploaded shard reference in an upload snapshot.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ClientCoreUploadShardRef {
    pub tier: u8,
    pub shard_index: u32,
    pub shard_id: String,
    pub sha256: String,
    pub uploaded: bool,
}

/// UniFFI record for a manifest receipt known after server commit.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ClientCoreManifestReceipt {
    pub manifest_id: String,
    pub manifest_version: u64,
}

/// UniFFI record for initializing a client-core upload job state machine.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ClientCoreUploadJobRequest {
    pub job_id: String,
    pub album_id: String,
    pub asset_id: String,
    pub epoch_id: u32,
    pub now_unix_ms: u64,
    pub max_retry_count: u32,
}

/// UniFFI record for a persistence-safe upload job snapshot.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ClientCoreUploadJobSnapshot {
    pub schema_version: u32,
    pub job_id: String,
    pub album_id: String,
    pub asset_id: String,
    pub epoch_id: u32,
    pub phase: String,
    pub active_tier: u8,
    pub active_shard_index: u32,
    pub completed_shards: Vec<ClientCoreUploadShardRef>,
    pub has_manifest_receipt: bool,
    pub manifest_receipt: ClientCoreManifestReceipt,
    pub retry_count: u32,
    pub next_retry_unix_ms: u64,
    pub last_error_code: u16,
    pub last_error_stage: String,
    pub sync_confirmed: bool,
    pub updated_at_unix_ms: u64,
}

/// UniFFI compact upload event record supplied by platform adapters.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ClientCoreUploadJobEvent {
    pub kind: String,
    pub tier: u8,
    pub shard_index: u32,
    pub shard_id: String,
    pub sha256: String,
    pub manifest_id: String,
    pub manifest_version: u64,
    pub observed_asset_id: String,
    pub retry_after_unix_ms: u64,
    pub error_code: u16,
}

/// UniFFI compact upload effect record emitted to platform adapters.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ClientCoreUploadJobEffect {
    pub kind: String,
    pub tier: u8,
    pub shard_index: u32,
}

/// UniFFI upload transition record.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ClientCoreUploadJobTransition {
    pub snapshot: ClientCoreUploadJobSnapshot,
    pub effects: Vec<ClientCoreUploadJobEffect>,
}

/// UniFFI upload initialization result.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ClientCoreUploadJobResult {
    pub code: u16,
    pub snapshot: ClientCoreUploadJobSnapshot,
}

/// UniFFI upload advance result.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ClientCoreUploadJobTransitionResult {
    pub code: u16,
    pub transition: ClientCoreUploadJobTransition,
}

/// UniFFI record for initializing an album sync coordinator.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ClientCoreAlbumSyncRequest {
    pub album_id: String,
    pub request_id: String,
    pub start_cursor: String,
    pub now_unix_ms: u64,
    pub max_retry_count: u32,
}

/// UniFFI record for a persistence-safe album sync snapshot.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ClientCoreAlbumSyncSnapshot {
    pub schema_version: u32,
    pub album_id: String,
    pub phase: String,
    pub active_cursor: String,
    pub pending_cursor: String,
    pub rerun_requested: bool,
    pub retry_count: u32,
    pub next_retry_unix_ms: u64,
    pub last_error_code: u16,
    pub last_error_stage: String,
    pub updated_at_unix_ms: u64,
}

/// UniFFI compact album sync event record supplied by platform adapters.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ClientCoreAlbumSyncEvent {
    pub kind: String,
    pub fetched_cursor: String,
    pub next_cursor: String,
    pub applied_count: u32,
    pub observed_asset_ids: Vec<String>,
    pub retry_after_unix_ms: u64,
    pub error_code: u16,
}

/// UniFFI compact album sync effect record emitted to platform adapters.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ClientCoreAlbumSyncEffect {
    pub kind: String,
    pub cursor: String,
}

/// UniFFI album sync transition record.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ClientCoreAlbumSyncTransition {
    pub snapshot: ClientCoreAlbumSyncSnapshot,
    pub effects: Vec<ClientCoreAlbumSyncEffect>,
}

/// UniFFI album sync initialization result.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ClientCoreAlbumSyncResult {
    pub code: u16,
    pub snapshot: ClientCoreAlbumSyncSnapshot,
}

/// UniFFI album sync advance result.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ClientCoreAlbumSyncTransitionResult {
    pub code: u16,
    pub transition: ClientCoreAlbumSyncTransition,
}

/// UniFFI record for dependency-free media inspection results.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MediaMetadataResult {
    pub code: u16,
    pub format: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub orientation: u8,
}

/// UniFFI record for one planned media tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct MediaTierDimensions {
    pub tier: u8,
    pub width: u32,
    pub height: u32,
}

/// UniFFI record for canonical media tier layout planning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct MediaTierLayoutResult {
    pub code: u16,
    pub thumbnail: MediaTierDimensions,
    pub preview: MediaTierDimensions,
    pub original: MediaTierDimensions,
}

/// Returns the crate name for smoke tests and generated wrapper diagnostics.
#[must_use]
pub const fn crate_name() -> &'static str {
    "mosaic-uniffi"
}

/// Returns the domain protocol version this UniFFI facade is compiled against.
#[uniffi::export]
#[must_use]
pub fn protocol_version() -> String {
    mosaic_client::protocol_version().to_owned()
}

/// Returns the stable UniFFI API snapshot for this FFI spike.
#[must_use]
pub const fn uniffi_api_snapshot() -> &'static str {
    "mosaic-uniffi ffi-spike:v8 protocol_version()->String parse_envelope_header(bytes)->HeaderResult progress(total,cancel_after)->ProgressResult account(unlock/status/close) identity(create/open/close/pubkeys/sign) epoch(create/open/status/close/encrypt/decrypt) metadata(canonical/encrypt,media-canonical/media-encrypt) media(inspect/plan) vectors(crypto-domain)->CryptoDomainGoldenVectorSnapshot client-core(state-machine-snapshot,upload-init/upload-advance,sync-init/sync-advance)"
}

const CLIENT_CORE_STATE_MACHINE_SURFACE: &str = "client-core-state-machines:v1 \
upload(init_upload_job(ClientCoreUploadJobRequest)->ClientCoreUploadJobResult,\
advance_upload_job(ClientCoreUploadJobSnapshot,ClientCoreUploadJobEvent)->ClientCoreUploadJobTransitionResult,\
ClientCoreUploadJobSnapshot,ClientCoreUploadJobTransition,ClientCoreUploadJobEffect) \
sync(init_album_sync(ClientCoreAlbumSyncRequest)->ClientCoreAlbumSyncResult,\
advance_album_sync(ClientCoreAlbumSyncSnapshot,ClientCoreAlbumSyncEvent)->ClientCoreAlbumSyncTransitionResult,\
ClientCoreAlbumSyncSnapshot,ClientCoreAlbumSyncTransition,ClientCoreAlbumSyncEffect)";

/// Parses a shard envelope header through the UniFFI export surface.
#[uniffi::export]
#[must_use]
pub fn parse_envelope_header(bytes: Vec<u8>) -> HeaderResult {
    let result = mosaic_client::parse_shard_header_for_ffi(&bytes);
    HeaderResult {
        code: result.code.as_u16(),
        epoch_id: result.epoch_id,
        shard_index: result.shard_index,
        tier: result.tier,
        nonce: result.nonce,
    }
}

/// Runs the progress probe through the UniFFI export surface.
#[uniffi::export]
#[must_use]
pub fn android_progress_probe(total_steps: u32, cancel_after: Option<u32>) -> ProgressResult {
    let result = mosaic_client::run_progress_probe(total_steps, cancel_after);
    ProgressResult {
        code: result.code.as_u16(),
        events: result
            .events
            .into_iter()
            .map(|event| ProgressEvent {
                completed_steps: event.completed_steps,
                total_steps: event.total_steps,
            })
            .collect(),
    }
}

/// Unwraps an account key into a Rust-owned opaque account-key handle.
#[uniffi::export]
#[must_use]
pub fn unlock_account_key(
    mut password: Vec<u8>,
    request: AccountUnlockRequest,
) -> AccountUnlockResult {
    let result = mosaic_client::unlock_account_key(mosaic_client::AccountUnlockRequest {
        password: password.as_mut_slice(),
        user_salt: &request.user_salt,
        account_salt: &request.account_salt,
        wrapped_account_key: &request.wrapped_account_key,
        kdf_memory_kib: request.kdf_memory_kib,
        kdf_iterations: request.kdf_iterations,
        kdf_parallelism: request.kdf_parallelism,
    });
    password.zeroize();

    AccountUnlockResult {
        code: result.code.as_u16(),
        handle: result.handle,
    }
}

/// Returns whether an account-key handle is currently open.
#[uniffi::export]
#[must_use]
pub fn account_key_handle_is_open(handle: u64) -> AccountKeyHandleStatusResult {
    match mosaic_client::account_key_handle_is_open(handle) {
        Ok(is_open) => AccountKeyHandleStatusResult {
            code: mosaic_client::ClientErrorCode::Ok.as_u16(),
            is_open,
        },
        Err(error) => AccountKeyHandleStatusResult {
            code: error.code.as_u16(),
            is_open: false,
        },
    }
}

/// Closes an account-key handle and returns the stable error code.
#[uniffi::export]
#[must_use]
pub fn close_account_key_handle(handle: u64) -> u16 {
    match mosaic_client::close_account_key_handle(handle) {
        Ok(()) => mosaic_client::ClientErrorCode::Ok.as_u16(),
        Err(error) => error.code.as_u16(),
    }
}

/// Creates a new identity handle for an existing account-key handle.
#[uniffi::export]
#[must_use]
pub fn create_identity_handle(account_key_handle: u64) -> IdentityHandleResult {
    identity_result_from_client(mosaic_client::create_identity_handle(account_key_handle))
}

/// Opens an identity handle from wrapped identity seed bytes.
#[uniffi::export]
#[must_use]
pub fn open_identity_handle(
    wrapped_identity_seed: Vec<u8>,
    account_key_handle: u64,
) -> IdentityHandleResult {
    identity_result_from_client(mosaic_client::open_identity_handle(
        &wrapped_identity_seed,
        account_key_handle,
    ))
}

/// Returns an identity handle's Ed25519 public key.
#[uniffi::export]
#[must_use]
pub fn identity_signing_pubkey(handle: u64) -> BytesResult {
    bytes_result_from_client(mosaic_client::identity_signing_pubkey(handle))
}

/// Returns an identity handle's X25519 recipient public key.
#[uniffi::export]
#[must_use]
pub fn identity_encryption_pubkey(handle: u64) -> BytesResult {
    bytes_result_from_client(mosaic_client::identity_encryption_pubkey(handle))
}

/// Signs manifest transcript bytes with an identity handle.
#[uniffi::export]
#[must_use]
pub fn sign_manifest_with_identity(handle: u64, transcript_bytes: Vec<u8>) -> BytesResult {
    bytes_result_from_client(mosaic_client::sign_manifest_with_identity(
        handle,
        &transcript_bytes,
    ))
}

/// Builds canonical plaintext metadata sidecar bytes from a compact encoded field list.
///
/// `encoded_fields` is a repeated sequence of `tag:u16le | value_len:u32le | value`.
/// The returned bytes are client-local plaintext metadata and must be encrypted before
/// manifest binding, persistence, upload, or logging.
#[uniffi::export]
#[must_use]
pub fn canonical_metadata_sidecar_bytes(
    album_id: Vec<u8>,
    photo_id: Vec<u8>,
    epoch_id: u32,
    encoded_fields: Vec<u8>,
) -> BytesResult {
    match canonical_metadata_sidecar_bytes_result(&album_id, &photo_id, epoch_id, &encoded_fields) {
        Ok(bytes) => BytesResult {
            code: mosaic_client::ClientErrorCode::Ok.as_u16(),
            bytes,
        },
        Err(code) => BytesResult {
            code,
            bytes: Vec::new(),
        },
    }
}

/// Encrypts canonical metadata sidecar bytes with a Rust-owned epoch-key handle.
#[uniffi::export]
#[must_use]
pub fn encrypt_metadata_sidecar_with_epoch_handle(
    handle: u64,
    album_id: Vec<u8>,
    photo_id: Vec<u8>,
    epoch_id: u32,
    encoded_fields: Vec<u8>,
    shard_index: u32,
) -> EncryptedShardResult {
    let mut plaintext = match canonical_metadata_sidecar_bytes_result(
        &album_id,
        &photo_id,
        epoch_id,
        &encoded_fields,
    ) {
        Ok(bytes) => bytes,
        Err(code) => {
            return EncryptedShardResult {
                code,
                envelope_bytes: Vec::new(),
                sha256: String::new(),
            };
        }
    };

    let result =
        encrypted_shard_result_from_client(mosaic_client::encrypt_shard_with_epoch_handle(
            handle,
            &plaintext,
            shard_index,
            ShardTier::Thumbnail.to_byte(),
        ));
    plaintext.zeroize();
    result
}

/// Inspects media bytes for Android adapter planning without decoding pixels.
#[uniffi::export]
#[must_use]
pub fn inspect_media_image(bytes: Vec<u8>) -> MediaMetadataResult {
    let bytes = Zeroizing::new(bytes);
    match mosaic_media::inspect_image(&bytes) {
        Ok(metadata) => media_metadata_result_ok(metadata),
        Err(error) => MediaMetadataResult {
            code: map_media_error(error),
            format: String::new(),
            mime_type: String::new(),
            width: 0,
            height: 0,
            orientation: 0,
        },
    }
}

/// Plans canonical thumbnail, preview, and original tier dimensions.
#[uniffi::export]
#[must_use]
pub fn plan_media_tier_layout(width: u32, height: u32) -> MediaTierLayoutResult {
    match mosaic_media::plan_tier_layout(width, height) {
        Ok(layout) => MediaTierLayoutResult {
            code: mosaic_client::ClientErrorCode::Ok.as_u16(),
            thumbnail: media_tier_dimensions(layout.thumbnail),
            preview: media_tier_dimensions(layout.preview),
            original: media_tier_dimensions(layout.original),
        },
        Err(error) => MediaTierLayoutResult {
            code: map_media_error(error),
            thumbnail: empty_media_tier_dimensions(),
            preview: empty_media_tier_dimensions(),
            original: empty_media_tier_dimensions(),
        },
    }
}

/// Builds plaintext canonical metadata sidecar bytes from inspected media bytes.
///
/// The returned bytes are client-local plaintext metadata and must be encrypted before
/// manifest binding, persistence, upload, or logging.
#[uniffi::export]
#[must_use]
pub fn canonical_media_metadata_sidecar_bytes(
    album_id: Vec<u8>,
    photo_id: Vec<u8>,
    epoch_id: u32,
    media_bytes: Vec<u8>,
) -> BytesResult {
    match media_metadata_sidecar_bytes_result(&album_id, &photo_id, epoch_id, media_bytes) {
        Ok(bytes) => BytesResult {
            code: mosaic_client::ClientErrorCode::Ok.as_u16(),
            bytes,
        },
        Err(code) => BytesResult {
            code,
            bytes: Vec::new(),
        },
    }
}

/// Encrypts inspected media metadata sidecar bytes with a Rust-owned epoch-key handle.
#[uniffi::export]
#[must_use]
pub fn encrypt_media_metadata_sidecar_with_epoch_handle(
    handle: u64,
    album_id: Vec<u8>,
    photo_id: Vec<u8>,
    epoch_id: u32,
    media_bytes: Vec<u8>,
    shard_index: u32,
) -> EncryptedShardResult {
    let mut plaintext =
        match media_metadata_sidecar_bytes_result(&album_id, &photo_id, epoch_id, media_bytes) {
            Ok(bytes) => bytes,
            Err(code) => {
                return EncryptedShardResult {
                    code,
                    envelope_bytes: Vec::new(),
                    sha256: String::new(),
                };
            }
        };

    let result =
        encrypted_shard_result_from_client(mosaic_client::encrypt_shard_with_epoch_handle(
            handle,
            &plaintext,
            shard_index,
            ShardTier::Thumbnail.to_byte(),
        ));
    plaintext.zeroize();
    result
}

/// Closes an identity handle and returns the stable error code.
#[uniffi::export]
#[must_use]
pub fn close_identity_handle(handle: u64) -> u16 {
    match mosaic_client::close_identity_handle(handle) {
        Ok(()) => mosaic_client::ClientErrorCode::Ok.as_u16(),
        Err(error) => error.code.as_u16(),
    }
}

/// Creates a new epoch-key handle for an existing account-key handle.
#[uniffi::export]
#[must_use]
pub fn create_epoch_key_handle(account_key_handle: u64, epoch_id: u32) -> EpochKeyHandleResult {
    epoch_result_from_client(mosaic_client::create_epoch_key_handle(
        account_key_handle,
        epoch_id,
    ))
}

/// Opens an epoch-key handle from wrapped epoch seed bytes.
#[uniffi::export]
#[must_use]
pub fn open_epoch_key_handle(
    wrapped_epoch_seed: Vec<u8>,
    account_key_handle: u64,
    epoch_id: u32,
) -> EpochKeyHandleResult {
    epoch_result_from_client(mosaic_client::open_epoch_key_handle(
        &wrapped_epoch_seed,
        account_key_handle,
        epoch_id,
    ))
}

/// Returns whether an epoch-key handle is currently open.
#[uniffi::export]
#[must_use]
pub fn epoch_key_handle_is_open(handle: u64) -> EpochKeyHandleStatusResult {
    match mosaic_client::epoch_key_handle_is_open(handle) {
        Ok(is_open) => EpochKeyHandleStatusResult {
            code: mosaic_client::ClientErrorCode::Ok.as_u16(),
            is_open,
        },
        Err(error) => EpochKeyHandleStatusResult {
            code: error.code.as_u16(),
            is_open: false,
        },
    }
}

/// Closes an epoch-key handle and returns the stable error code.
#[uniffi::export]
#[must_use]
pub fn close_epoch_key_handle(handle: u64) -> u16 {
    match mosaic_client::close_epoch_key_handle(handle) {
        Ok(()) => mosaic_client::ClientErrorCode::Ok.as_u16(),
        Err(error) => error.code.as_u16(),
    }
}

/// Encrypts shard bytes with a Rust-owned epoch-key handle.
#[uniffi::export]
#[must_use]
pub fn encrypt_shard_with_epoch_handle(
    handle: u64,
    plaintext: Vec<u8>,
    shard_index: u32,
    tier_byte: u8,
) -> EncryptedShardResult {
    encrypted_shard_result_from_client(mosaic_client::encrypt_shard_with_epoch_handle(
        handle,
        &plaintext,
        shard_index,
        tier_byte,
    ))
}

/// Decrypts shard envelope bytes with a Rust-owned epoch-key handle.
#[uniffi::export]
#[must_use]
pub fn decrypt_shard_with_epoch_handle(
    handle: u64,
    envelope_bytes: Vec<u8>,
) -> DecryptedShardResult {
    decrypted_shard_result_from_client(mosaic_client::decrypt_shard_with_epoch_handle(
        handle,
        &envelope_bytes,
    ))
}

/// Returns deterministic public crypto/domain golden vectors through UniFFI.
#[uniffi::export]
#[must_use]
pub fn crypto_domain_golden_vector_snapshot() -> CryptoDomainGoldenVectorSnapshot {
    crypto_domain_vector_from_client(mosaic_client::crypto_domain_golden_vector_snapshot())
}

/// Returns the stable client-core state machine FFI proof surface.
#[uniffi::export]
#[must_use]
pub fn client_core_state_machine_snapshot() -> String {
    CLIENT_CORE_STATE_MACHINE_SURFACE.to_owned()
}

/// Initializes a client-core upload job through the UniFFI DTO surface.
#[uniffi::export]
#[must_use]
pub fn init_upload_job(request: ClientCoreUploadJobRequest) -> ClientCoreUploadJobResult {
    match mosaic_client::new_upload_job(upload_request_to_client(request)) {
        Ok(snapshot) => ClientCoreUploadJobResult {
            code: mosaic_client::ClientErrorCode::Ok.as_u16(),
            snapshot: upload_snapshot_from_client(snapshot),
        },
        Err(error) => ClientCoreUploadJobResult {
            code: error.code.as_u16(),
            snapshot: empty_upload_snapshot(),
        },
    }
}

/// Advances a client-core upload job through the UniFFI DTO surface.
#[uniffi::export]
#[must_use]
pub fn advance_upload_job(
    snapshot: ClientCoreUploadJobSnapshot,
    event: ClientCoreUploadJobEvent,
) -> ClientCoreUploadJobTransitionResult {
    let snapshot = upload_snapshot_to_client(snapshot);
    match mosaic_client::advance_upload_job(&snapshot, upload_event_to_client(event)) {
        Ok(transition) => ClientCoreUploadJobTransitionResult {
            code: mosaic_client::ClientErrorCode::Ok.as_u16(),
            transition: upload_transition_from_client(transition),
        },
        Err(error) => ClientCoreUploadJobTransitionResult {
            code: error.code.as_u16(),
            transition: empty_upload_transition(),
        },
    }
}

/// Initializes an album sync coordinator through the UniFFI DTO surface.
#[uniffi::export]
#[must_use]
pub fn init_album_sync(request: ClientCoreAlbumSyncRequest) -> ClientCoreAlbumSyncResult {
    match mosaic_client::new_album_sync(album_sync_request_to_client(request)) {
        Ok(snapshot) => ClientCoreAlbumSyncResult {
            code: mosaic_client::ClientErrorCode::Ok.as_u16(),
            snapshot: album_sync_snapshot_from_client(snapshot),
        },
        Err(error) => ClientCoreAlbumSyncResult {
            code: error.code.as_u16(),
            snapshot: empty_album_sync_snapshot(),
        },
    }
}

/// Advances an album sync coordinator through the UniFFI DTO surface.
#[uniffi::export]
#[must_use]
pub fn advance_album_sync(
    snapshot: ClientCoreAlbumSyncSnapshot,
    event: ClientCoreAlbumSyncEvent,
) -> ClientCoreAlbumSyncTransitionResult {
    let snapshot = album_sync_snapshot_to_client(snapshot);
    match mosaic_client::advance_album_sync(&snapshot, album_sync_event_to_client(event)) {
        Ok(transition) => ClientCoreAlbumSyncTransitionResult {
            code: mosaic_client::ClientErrorCode::Ok.as_u16(),
            transition: album_sync_transition_from_client(transition),
        },
        Err(error) => ClientCoreAlbumSyncTransitionResult {
            code: error.code.as_u16(),
            transition: empty_album_sync_transition(),
        },
    }
}

fn identity_result_from_client(
    result: mosaic_client::IdentityHandleResult,
) -> IdentityHandleResult {
    IdentityHandleResult {
        code: result.code.as_u16(),
        handle: result.handle,
        signing_pubkey: result.signing_pubkey,
        encryption_pubkey: result.encryption_pubkey,
        wrapped_seed: result.wrapped_seed,
    }
}

fn bytes_result_from_client(result: mosaic_client::BytesResult) -> BytesResult {
    BytesResult {
        code: result.code.as_u16(),
        bytes: result.bytes,
    }
}

fn epoch_result_from_client(result: mosaic_client::EpochKeyHandleResult) -> EpochKeyHandleResult {
    EpochKeyHandleResult {
        code: result.code.as_u16(),
        handle: result.handle,
        epoch_id: result.epoch_id,
        wrapped_epoch_seed: result.wrapped_epoch_seed,
    }
}

fn encrypted_shard_result_from_client(
    result: mosaic_client::EncryptedShardResult,
) -> EncryptedShardResult {
    EncryptedShardResult {
        code: result.code.as_u16(),
        envelope_bytes: result.envelope_bytes,
        sha256: result.sha256,
    }
}

fn decrypted_shard_result_from_client(
    result: mosaic_client::DecryptedShardResult,
) -> DecryptedShardResult {
    DecryptedShardResult {
        code: result.code.as_u16(),
        plaintext: result.plaintext,
    }
}

fn crypto_domain_vector_from_client(
    result: mosaic_client::CryptoDomainGoldenVectorSnapshot,
) -> CryptoDomainGoldenVectorSnapshot {
    CryptoDomainGoldenVectorSnapshot {
        code: result.code.as_u16(),
        envelope_header: result.envelope_header,
        envelope_epoch_id: result.envelope_epoch_id,
        envelope_shard_index: result.envelope_shard_index,
        envelope_tier: result.envelope_tier,
        envelope_nonce: result.envelope_nonce,
        manifest_transcript: result.manifest_transcript,
        identity_message: result.identity_message,
        identity_signing_pubkey: result.identity_signing_pubkey,
        identity_encryption_pubkey: result.identity_encryption_pubkey,
        identity_signature: result.identity_signature,
    }
}

fn upload_request_to_client(
    request: ClientCoreUploadJobRequest,
) -> mosaic_client::UploadJobRequest {
    mosaic_client::UploadJobRequest {
        job_id: request.job_id,
        album_id: request.album_id,
        asset_id: request.asset_id,
        epoch_id: request.epoch_id,
        now_unix_ms: request.now_unix_ms,
        max_retry_count: request.max_retry_count,
    }
}

fn upload_snapshot_to_client(
    snapshot: ClientCoreUploadJobSnapshot,
) -> mosaic_client::UploadJobSnapshot {
    mosaic_client::UploadJobSnapshot {
        schema_version: snapshot.schema_version,
        job_id: snapshot.job_id,
        album_id: snapshot.album_id,
        asset_id: snapshot.asset_id,
        epoch_id: snapshot.epoch_id,
        phase: snapshot.phase,
        active_tier: snapshot.active_tier,
        active_shard_index: snapshot.active_shard_index,
        completed_shards: snapshot
            .completed_shards
            .into_iter()
            .map(|shard| mosaic_client::UploadShardRef {
                tier: shard.tier,
                shard_index: shard.shard_index,
                shard_id: shard.shard_id,
                sha256: shard.sha256,
                uploaded: shard.uploaded,
            })
            .collect(),
        manifest_receipt: if snapshot.has_manifest_receipt {
            Some(mosaic_client::ManifestReceipt {
                manifest_id: snapshot.manifest_receipt.manifest_id,
                manifest_version: snapshot.manifest_receipt.manifest_version,
            })
        } else {
            None
        },
        retry_count: snapshot.retry_count,
        next_retry_unix_ms: snapshot.next_retry_unix_ms,
        last_error_code: snapshot.last_error_code,
        last_error_stage: snapshot.last_error_stage,
        sync_confirmed: snapshot.sync_confirmed,
        updated_at_unix_ms: snapshot.updated_at_unix_ms,
    }
}

fn upload_event_to_client(event: ClientCoreUploadJobEvent) -> mosaic_client::UploadJobEvent {
    mosaic_client::UploadJobEvent {
        kind: event.kind,
        tier: event.tier,
        shard_index: event.shard_index,
        shard_id: event.shard_id,
        sha256: event.sha256,
        manifest_id: event.manifest_id,
        manifest_version: event.manifest_version,
        observed_asset_id: event.observed_asset_id,
        retry_after_unix_ms: event.retry_after_unix_ms,
        error_code: event.error_code,
    }
}

fn upload_snapshot_from_client(
    snapshot: mosaic_client::UploadJobSnapshot,
) -> ClientCoreUploadJobSnapshot {
    let (has_manifest_receipt, manifest_receipt) = match snapshot.manifest_receipt {
        Some(receipt) => (
            true,
            ClientCoreManifestReceipt {
                manifest_id: receipt.manifest_id,
                manifest_version: receipt.manifest_version,
            },
        ),
        None => (false, empty_manifest_receipt()),
    };

    ClientCoreUploadJobSnapshot {
        schema_version: snapshot.schema_version,
        job_id: snapshot.job_id,
        album_id: snapshot.album_id,
        asset_id: snapshot.asset_id,
        epoch_id: snapshot.epoch_id,
        phase: snapshot.phase,
        active_tier: snapshot.active_tier,
        active_shard_index: snapshot.active_shard_index,
        completed_shards: snapshot
            .completed_shards
            .into_iter()
            .map(|shard| ClientCoreUploadShardRef {
                tier: shard.tier,
                shard_index: shard.shard_index,
                shard_id: shard.shard_id,
                sha256: shard.sha256,
                uploaded: shard.uploaded,
            })
            .collect(),
        has_manifest_receipt,
        manifest_receipt,
        retry_count: snapshot.retry_count,
        next_retry_unix_ms: snapshot.next_retry_unix_ms,
        last_error_code: snapshot.last_error_code,
        last_error_stage: snapshot.last_error_stage,
        sync_confirmed: snapshot.sync_confirmed,
        updated_at_unix_ms: snapshot.updated_at_unix_ms,
    }
}

fn upload_transition_from_client(
    transition: mosaic_client::UploadJobTransition,
) -> ClientCoreUploadJobTransition {
    ClientCoreUploadJobTransition {
        snapshot: upload_snapshot_from_client(transition.snapshot),
        effects: transition
            .effects
            .into_iter()
            .map(|effect| ClientCoreUploadJobEffect {
                kind: effect.kind,
                tier: effect.tier,
                shard_index: effect.shard_index,
            })
            .collect(),
    }
}

fn album_sync_request_to_client(
    request: ClientCoreAlbumSyncRequest,
) -> mosaic_client::AlbumSyncRequest {
    mosaic_client::AlbumSyncRequest {
        album_id: request.album_id,
        request_id: request.request_id,
        start_cursor: request.start_cursor,
        now_unix_ms: request.now_unix_ms,
        max_retry_count: request.max_retry_count,
    }
}

fn album_sync_snapshot_to_client(
    snapshot: ClientCoreAlbumSyncSnapshot,
) -> mosaic_client::AlbumSyncSnapshot {
    mosaic_client::AlbumSyncSnapshot {
        schema_version: snapshot.schema_version,
        album_id: snapshot.album_id,
        phase: snapshot.phase,
        active_cursor: snapshot.active_cursor,
        pending_cursor: snapshot.pending_cursor,
        rerun_requested: snapshot.rerun_requested,
        retry_count: snapshot.retry_count,
        next_retry_unix_ms: snapshot.next_retry_unix_ms,
        last_error_code: snapshot.last_error_code,
        last_error_stage: snapshot.last_error_stage,
        updated_at_unix_ms: snapshot.updated_at_unix_ms,
    }
}

fn album_sync_event_to_client(event: ClientCoreAlbumSyncEvent) -> mosaic_client::AlbumSyncEvent {
    mosaic_client::AlbumSyncEvent {
        kind: event.kind,
        fetched_cursor: event.fetched_cursor,
        next_cursor: event.next_cursor,
        applied_count: event.applied_count,
        observed_asset_ids: event.observed_asset_ids,
        retry_after_unix_ms: event.retry_after_unix_ms,
        error_code: event.error_code,
    }
}

fn album_sync_snapshot_from_client(
    snapshot: mosaic_client::AlbumSyncSnapshot,
) -> ClientCoreAlbumSyncSnapshot {
    ClientCoreAlbumSyncSnapshot {
        schema_version: snapshot.schema_version,
        album_id: snapshot.album_id,
        phase: snapshot.phase,
        active_cursor: snapshot.active_cursor,
        pending_cursor: snapshot.pending_cursor,
        rerun_requested: snapshot.rerun_requested,
        retry_count: snapshot.retry_count,
        next_retry_unix_ms: snapshot.next_retry_unix_ms,
        last_error_code: snapshot.last_error_code,
        last_error_stage: snapshot.last_error_stage,
        updated_at_unix_ms: snapshot.updated_at_unix_ms,
    }
}

fn album_sync_transition_from_client(
    transition: mosaic_client::AlbumSyncTransition,
) -> ClientCoreAlbumSyncTransition {
    ClientCoreAlbumSyncTransition {
        snapshot: album_sync_snapshot_from_client(transition.snapshot),
        effects: transition
            .effects
            .into_iter()
            .map(|effect| ClientCoreAlbumSyncEffect {
                kind: effect.kind,
                cursor: effect.cursor,
            })
            .collect(),
    }
}

fn empty_manifest_receipt() -> ClientCoreManifestReceipt {
    ClientCoreManifestReceipt {
        manifest_id: String::new(),
        manifest_version: 0,
    }
}

fn empty_upload_snapshot() -> ClientCoreUploadJobSnapshot {
    ClientCoreUploadJobSnapshot {
        schema_version: 0,
        job_id: String::new(),
        album_id: String::new(),
        asset_id: String::new(),
        epoch_id: 0,
        phase: String::new(),
        active_tier: 0,
        active_shard_index: 0,
        completed_shards: Vec::new(),
        has_manifest_receipt: false,
        manifest_receipt: empty_manifest_receipt(),
        retry_count: 0,
        next_retry_unix_ms: 0,
        last_error_code: 0,
        last_error_stage: String::new(),
        sync_confirmed: false,
        updated_at_unix_ms: 0,
    }
}

fn empty_upload_transition() -> ClientCoreUploadJobTransition {
    ClientCoreUploadJobTransition {
        snapshot: empty_upload_snapshot(),
        effects: Vec::new(),
    }
}

fn empty_album_sync_snapshot() -> ClientCoreAlbumSyncSnapshot {
    ClientCoreAlbumSyncSnapshot {
        schema_version: 0,
        album_id: String::new(),
        phase: String::new(),
        active_cursor: String::new(),
        pending_cursor: String::new(),
        rerun_requested: false,
        retry_count: 0,
        next_retry_unix_ms: 0,
        last_error_code: 0,
        last_error_stage: String::new(),
        updated_at_unix_ms: 0,
    }
}

fn empty_album_sync_transition() -> ClientCoreAlbumSyncTransition {
    ClientCoreAlbumSyncTransition {
        snapshot: empty_album_sync_snapshot(),
        effects: Vec::new(),
    }
}

fn canonical_metadata_sidecar_bytes_result(
    album_id: &[u8],
    photo_id: &[u8],
    epoch_id: u32,
    encoded_fields: &[u8],
) -> Result<Vec<u8>, u16> {
    let album_id = uuid_bytes(album_id)?;
    let photo_id = uuid_bytes(photo_id)?;
    let fields = metadata_fields_from_encoded(encoded_fields)?;
    let sidecar = MetadataSidecar::new(album_id, photo_id, epoch_id, &fields);
    mosaic_domain::canonical_metadata_sidecar_bytes(&sidecar).map_err(map_metadata_sidecar_error)
}

fn media_metadata_sidecar_bytes_result(
    album_id: &[u8],
    photo_id: &[u8],
    epoch_id: u32,
    media_bytes: Vec<u8>,
) -> Result<Vec<u8>, u16> {
    let album_id = uuid_bytes(album_id)?;
    let photo_id = uuid_bytes(photo_id)?;
    let media_bytes = Zeroizing::new(media_bytes);
    let metadata = mosaic_media::inspect_image(&media_bytes).map_err(map_media_error)?;
    let sidecar_ids = mosaic_media::MediaSidecarIds {
        album_id,
        photo_id,
        epoch_id,
    };
    mosaic_media::canonical_media_metadata_sidecar_bytes(sidecar_ids, metadata)
        .map_err(map_media_error)
}

fn uuid_bytes(bytes: &[u8]) -> Result<[u8; 16], u16> {
    if bytes.len() != 16 {
        return Err(mosaic_client::ClientErrorCode::InvalidInputLength.as_u16());
    }
    let mut value = [0_u8; 16];
    value.copy_from_slice(bytes);
    Ok(value)
}

fn metadata_fields_from_encoded(
    encoded_fields: &[u8],
) -> Result<Vec<MetadataSidecarField<'_>>, u16> {
    let mut fields = Vec::new();
    let mut offset = 0_usize;
    while offset < encoded_fields.len() {
        let remaining = &encoded_fields[offset..];
        if remaining.len() < 6 {
            return Err(mosaic_client::ClientErrorCode::InvalidInputLength.as_u16());
        }

        let tag = u16::from_le_bytes([remaining[0], remaining[1]]);
        let value_len =
            u32::from_le_bytes([remaining[2], remaining[3], remaining[4], remaining[5]]) as usize;
        offset += 6;

        let end = match offset.checked_add(value_len) {
            Some(value) => value,
            None => return Err(mosaic_client::ClientErrorCode::InvalidInputLength.as_u16()),
        };
        if end > encoded_fields.len() {
            return Err(mosaic_client::ClientErrorCode::InvalidInputLength.as_u16());
        }

        fields.push(MetadataSidecarField::new(tag, &encoded_fields[offset..end]));
        offset = end;
    }
    Ok(fields)
}

fn map_metadata_sidecar_error(_error: MetadataSidecarError) -> u16 {
    mosaic_client::ClientErrorCode::InvalidInputLength.as_u16()
}

fn map_media_error(error: mosaic_media::MosaicMediaError) -> u16 {
    match error {
        mosaic_media::MosaicMediaError::UnsupportedFormat => {
            mosaic_client::ClientErrorCode::UnsupportedMediaFormat.as_u16()
        }
        mosaic_media::MosaicMediaError::InvalidJpeg
        | mosaic_media::MosaicMediaError::InvalidPng
        | mosaic_media::MosaicMediaError::InvalidWebP => {
            mosaic_client::ClientErrorCode::InvalidMediaContainer.as_u16()
        }
        mosaic_media::MosaicMediaError::InvalidDimensions => {
            mosaic_client::ClientErrorCode::InvalidMediaDimensions.as_u16()
        }
        mosaic_media::MosaicMediaError::OutputTooLarge => {
            mosaic_client::ClientErrorCode::MediaOutputTooLarge.as_u16()
        }
        mosaic_media::MosaicMediaError::ImageMetadataMismatch => {
            mosaic_client::ClientErrorCode::MediaMetadataMismatch.as_u16()
        }
        mosaic_media::MosaicMediaError::MetadataSidecar(_) => {
            mosaic_client::ClientErrorCode::InvalidMediaSidecar.as_u16()
        }
        mosaic_media::MosaicMediaError::EncodedTierMismatch { .. } => {
            mosaic_client::ClientErrorCode::MediaAdapterOutputMismatch.as_u16()
        }
    }
}

fn media_metadata_result_ok(metadata: mosaic_media::ImageMetadata) -> MediaMetadataResult {
    MediaMetadataResult {
        code: mosaic_client::ClientErrorCode::Ok.as_u16(),
        format: media_format_name(metadata.format).to_owned(),
        mime_type: metadata.mime_type.to_owned(),
        width: metadata.width,
        height: metadata.height,
        orientation: metadata.orientation,
    }
}

const fn media_format_name(format: mosaic_media::MediaFormat) -> &'static str {
    match format {
        mosaic_media::MediaFormat::Jpeg => "jpeg",
        mosaic_media::MediaFormat::Png => "png",
        mosaic_media::MediaFormat::WebP => "webp",
    }
}

const fn media_tier_dimensions(dimensions: mosaic_media::TierDimensions) -> MediaTierDimensions {
    MediaTierDimensions {
        tier: dimensions.tier.to_byte(),
        width: dimensions.width,
        height: dimensions.height,
    }
}

const fn empty_media_tier_dimensions() -> MediaTierDimensions {
    MediaTierDimensions {
        tier: 0,
        width: 0,
        height: 0,
    }
}

uniffi::setup_scaffolding!();

#[cfg(test)]
mod tests {
    #[test]
    fn uses_client_protocol_version() {
        assert_eq!(super::protocol_version(), "mosaic-v1");
    }
}
