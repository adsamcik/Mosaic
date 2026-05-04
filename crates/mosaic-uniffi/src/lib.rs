//! UniFFI/JNI facade boundary crate for the Mosaic Android integration.

#![forbid(unsafe_code)]

use std::fmt;
use std::io::Cursor;

use blake2::{
    Blake2bVar,
    digest::{Update, VariableOutput},
};
use ciborium::value::{Integer, Value};
use mosaic_domain::{MetadataSidecar, MetadataSidecarError, MetadataSidecarField, ShardTier};
use zeroize::Zeroizing;

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
#[derive(Clone, PartialEq, Eq, uniffi::Record)]
pub struct BytesResult {
    pub code: u16,
    pub bytes: Vec<u8>,
}

impl fmt::Debug for BytesResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BytesResult")
            .field("code", &self.code)
            .field("bytes_len", &self.bytes.len())
            .finish()
    }
}

/// UniFFI record for account unlock parameters.
#[derive(Clone, PartialEq, Eq, uniffi::Record)]
pub struct AccountUnlockRequest {
    pub user_salt: Vec<u8>,
    pub account_salt: Vec<u8>,
    pub wrapped_account_key: Vec<u8>,
    pub kdf_memory_kib: u32,
    pub kdf_iterations: u32,
    pub kdf_parallelism: u32,
}

impl fmt::Debug for AccountUnlockRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AccountUnlockRequest")
            .field("user_salt_len", &self.user_salt.len())
            .field("account_salt_len", &self.account_salt.len())
            .field("wrapped_account_key_len", &self.wrapped_account_key.len())
            .field("kdf_memory_kib", &self.kdf_memory_kib)
            .field("kdf_iterations", &self.kdf_iterations)
            .field("kdf_parallelism", &self.kdf_parallelism)
            .finish()
    }
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
#[derive(Clone, PartialEq, Eq, uniffi::Record)]
pub struct IdentityHandleResult {
    pub code: u16,
    pub handle: u64,
    pub signing_pubkey: Vec<u8>,
    pub encryption_pubkey: Vec<u8>,
    pub wrapped_seed: Vec<u8>,
}

impl fmt::Debug for IdentityHandleResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IdentityHandleResult")
            .field("code", &self.code)
            .field("handle", &self.handle)
            .field("signing_pubkey_len", &self.signing_pubkey.len())
            .field("encryption_pubkey_len", &self.encryption_pubkey.len())
            .field("wrapped_seed_len", &self.wrapped_seed.len())
            .finish()
    }
}

/// UniFFI record for epoch-key handle results.
#[derive(Clone, PartialEq, Eq, uniffi::Record)]
pub struct EpochKeyHandleResult {
    pub code: u16,
    pub handle: u64,
    pub epoch_id: u32,
    pub wrapped_epoch_seed: Vec<u8>,
    pub sign_public_key: Vec<u8>,
}

impl fmt::Debug for EpochKeyHandleResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EpochKeyHandleResult")
            .field("code", &self.code)
            .field("handle", &self.handle)
            .field("epoch_id", &self.epoch_id)
            .field("wrapped_epoch_seed_len", &self.wrapped_epoch_seed.len())
            .field("sign_public_key_len", &self.sign_public_key.len())
            .finish()
    }
}

/// UniFFI record for epoch-key handle status checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct EpochKeyHandleStatusResult {
    pub code: u16,
    pub is_open: bool,
}

/// UniFFI record for encrypted shard results.
#[derive(Clone, PartialEq, Eq, uniffi::Record)]
pub struct EncryptedShardResult {
    pub code: u16,
    pub envelope_bytes: Vec<u8>,
    pub sha256: String,
}

impl fmt::Debug for EncryptedShardResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EncryptedShardResult")
            .field("code", &self.code)
            .field("envelope_bytes_len", &self.envelope_bytes.len())
            .field("sha256", &self.sha256)
            .finish()
    }
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

/// UniFFI record for a privacy-safe upload shard reference in an upload snapshot.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ClientCoreUploadShardRef {
    pub tier: u8,
    pub shard_index: u32,
    pub shard_id: String,
    pub sha256: Vec<u8>,
    pub content_length: u64,
    pub envelope_version: u8,
    pub uploaded: bool,
}

/// UniFFI record for initializing a client-core upload job state machine.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ClientCoreUploadJobRequest {
    pub job_id: String,
    pub album_id: String,
    pub asset_id: String,
    pub idempotency_key: String,
    pub max_retry_count: u8,
}

/// UniFFI record for a persistence-safe upload job snapshot.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ClientCoreUploadJobSnapshot {
    pub schema_version: u32,
    pub job_id: String,
    pub album_id: String,
    pub phase: String,
    pub retry_count: u32,
    pub max_retry_count: u8,
    pub next_retry_not_before_ms: i64,
    pub has_next_retry_not_before_ms: bool,
    pub idempotency_key: String,
    pub tiered_shards: Vec<ClientCoreUploadShardRef>,
    pub shard_set_hash: Vec<u8>,
    pub snapshot_revision: u64,
    pub last_effect_id: String,
    pub last_acknowledged_effect_id: String,
    pub last_applied_event_id: String,
    pub failure_code: u16,
}

/// UniFFI compact upload event record supplied by platform adapters.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ClientCoreUploadJobEvent {
    pub kind: String,
    pub effect_id: String,
    pub tier: u8,
    pub shard_index: u32,
    pub shard_id: String,
    pub sha256: Vec<u8>,
    pub content_length: u64,
    pub envelope_version: u8,
    pub uploaded: bool,
    pub tiered_shards: Vec<ClientCoreUploadShardRef>,
    pub shard_set_hash: Vec<u8>,
    pub asset_id: String,
    pub since_metadata_version: u64,
    pub recovery_outcome: String,
    pub now_ms: i64,
    pub base_backoff_ms: u64,
    pub server_retry_after_ms: u64,
    pub has_server_retry_after_ms: bool,
    pub has_error_code: bool,
    pub error_code: u16,
    pub target_phase: String,
}

/// UniFFI compact upload effect record emitted to platform adapters.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ClientCoreUploadJobEffect {
    pub kind: String,
    pub effect_id: String,
    pub tier: u8,
    pub shard_index: u32,
    pub shard_id: String,
    pub sha256: Vec<u8>,
    pub content_length: u64,
    pub envelope_version: u8,
    pub attempt: u32,
    pub not_before_ms: i64,
    pub target_phase: String,
    pub reason: String,
    pub asset_id: String,
    pub since_metadata_version: u64,
    pub idempotency_key: String,
    pub shard_set_hash: Vec<u8>,
}

/// UniFFI upload transition record.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ClientCoreUploadJobTransition {
    pub next_snapshot: ClientCoreUploadJobSnapshot,
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
    pub max_retry_count: u32,
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
    pub has_error_code: bool,
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

/// Returns the historical UniFFI API changelog label for diagnostics.
///
/// This string is documentation only. The authoritative API-shape lock is
/// `tests/api_shape_lock.rs`, which derives its golden from the exported
/// UniFFI records and `#[uniffi::export]` functions in this crate.
#[must_use]
pub const fn uniffi_api_snapshot() -> &'static str {
    "mosaic-uniffi ffi-spike:v10 protocol_version()->String parse_envelope_header(bytes)->HeaderResult progress(total,cancel_after)->ProgressResult account(unlock/status/close) identity(create/open/close/pubkeys/sign,from-raw-seed) epoch(create/open/status/close/encrypt/decrypt/legacy-raw-key-decrypt)->EpochKeyHandleResult{code,handle,epoch_id,wrapped_epoch_seed,sign_public_key} metadata(canonical/encrypt,media-canonical/media-encrypt) media(inspect/plan) vectors(crypto-domain)->CryptoDomainGoldenVectorSnapshot client-core(state-machine-snapshot,upload-init/upload-advance,sync-init/sync-advance) cross-client-vectors(derive-link-keys,derive-identity-from-raw-seed,build-auth-challenge-transcript,sign-auth-challenge-raw-seed,verify-auth-challenge-signature,verify-and-open-bundle-recipient-seed,decrypt-content-raw-key)"
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
///
/// The caller-owned `password` buffer is wrapped in `Zeroizing` so it is
/// guaranteed to be wiped on every exit path, including panics during the
/// inner call. The wrapped account key in `request` is also wrapped in
/// `Zeroizing` because it carries password-equivalent material at rest.
#[uniffi::export]
#[must_use]
pub fn unlock_account_key(password: Vec<u8>, request: AccountUnlockRequest) -> AccountUnlockResult {
    let mut password = Zeroizing::new(password);
    // Move the wrapped key into a Zeroizing wrapper so it is wiped on drop
    // regardless of whether the inner call returns or panics.
    let wrapped_account_key = Zeroizing::new(request.wrapped_account_key);
    let user_salt = request.user_salt;
    let account_salt = request.account_salt;
    let result = mosaic_client::unlock_account_key(mosaic_client::AccountUnlockRequest {
        password: password.as_mut_slice(),
        user_salt: &user_salt,
        account_salt: &account_salt,
        wrapped_account_key: &wrapped_account_key,
        kdf_memory_kib: request.kdf_memory_kib,
        kdf_iterations: request.kdf_iterations,
        kdf_parallelism: request.kdf_parallelism,
    });
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
///
/// `wrapped_identity_seed` is wrapped in `Zeroizing` so the caller-owned
/// buffer is wiped on every exit path.
#[uniffi::export]
#[must_use]
pub fn open_identity_handle(
    wrapped_identity_seed: Vec<u8>,
    account_key_handle: u64,
) -> IdentityHandleResult {
    let wrapped_identity_seed = Zeroizing::new(wrapped_identity_seed);
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
///
/// `transcript_bytes` is wrapped in `Zeroizing` so the caller-owned buffer is
/// wiped on every exit path. The transcript may contain manifest payloads.
#[uniffi::export]
#[must_use]
pub fn sign_manifest_with_identity(handle: u64, transcript_bytes: Vec<u8>) -> BytesResult {
    let transcript_bytes = Zeroizing::new(transcript_bytes);
    bytes_result_from_client(mosaic_client::sign_manifest_with_identity(
        handle,
        &transcript_bytes,
    ))
}

/// Builds canonical plaintext metadata sidecar bytes from a compact encoded field list.
///
/// `encoded_fields` is wrapped in `Zeroizing` so the caller-owned buffer is
/// wiped on every exit path. The encoded fields contain plaintext metadata.
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
    let encoded_fields = Zeroizing::new(encoded_fields);
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
///
/// `encoded_fields` is wrapped in `Zeroizing` so the caller-owned buffer is
/// wiped on every exit path. The intermediate canonical bytes are also kept
/// in `Zeroizing` so they are wiped after encryption succeeds or fails.
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
    let encoded_fields = Zeroizing::new(encoded_fields);
    let plaintext = match canonical_metadata_sidecar_bytes_result(
        &album_id,
        &photo_id,
        epoch_id,
        &encoded_fields,
    ) {
        Ok(bytes) => Zeroizing::new(bytes),
        Err(code) => {
            return EncryptedShardResult {
                code,
                envelope_bytes: Vec::new(),
                sha256: String::new(),
            };
        }
    };

    encrypted_shard_result_from_client(mosaic_client::encrypt_shard_with_epoch_handle(
        handle,
        &plaintext,
        shard_index,
        ShardTier::Thumbnail.to_byte(),
    ))
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
/// `media_bytes` is wrapped in `Zeroizing` (via the inner `media_metadata_sidecar_bytes_result`
/// helper) so the caller-owned buffer is wiped on every exit path.
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
///
/// The media bytes flow through `media_metadata_sidecar_bytes_result` which already wraps
/// them in `Zeroizing` internally. The intermediate canonical bytes are also wrapped in
/// `Zeroizing` so they are wiped after encryption succeeds or fails.
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
    let plaintext =
        match media_metadata_sidecar_bytes_result(&album_id, &photo_id, epoch_id, media_bytes) {
            Ok(bytes) => Zeroizing::new(bytes),
            Err(code) => {
                return EncryptedShardResult {
                    code,
                    envelope_bytes: Vec::new(),
                    sha256: String::new(),
                };
            }
        };

    encrypted_shard_result_from_client(mosaic_client::encrypt_shard_with_epoch_handle(
        handle,
        &plaintext,
        shard_index,
        ShardTier::Thumbnail.to_byte(),
    ))
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
///
/// `wrapped_epoch_seed` is wrapped in `Zeroizing` so the caller-owned buffer
/// is wiped on every exit path.
#[uniffi::export]
#[must_use]
pub fn open_epoch_key_handle(
    wrapped_epoch_seed: Vec<u8>,
    account_key_handle: u64,
    epoch_id: u32,
) -> EpochKeyHandleResult {
    let wrapped_epoch_seed = Zeroizing::new(wrapped_epoch_seed);
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
///
/// `plaintext` is wrapped in `Zeroizing` so the caller-owned plaintext shard
/// buffer is wiped on every exit path. This mirrors the Kotlin-side
/// `encryptShardWipingPlaintext` extension and ensures plaintext does not
/// linger in heap memory beyond the encryption call.
#[uniffi::export]
#[must_use]
pub fn encrypt_shard_with_epoch_handle(
    handle: u64,
    plaintext: Vec<u8>,
    shard_index: u32,
    tier_byte: u8,
) -> EncryptedShardResult {
    let plaintext = Zeroizing::new(plaintext);
    encrypted_shard_result_from_client(mosaic_client::encrypt_shard_with_epoch_handle(
        handle,
        &plaintext,
        shard_index,
        tier_byte,
    ))
}

/// Decrypts shard envelope bytes with a Rust-owned epoch-key handle.
///
/// `envelope_bytes` is wrapped in `Zeroizing` so the caller-owned buffer is
/// wiped on every exit path. The envelope is encrypted ciphertext so this is
/// defense-in-depth, but consistent with the broader wipe-discipline pattern.
#[uniffi::export]
#[must_use]
pub fn decrypt_shard_with_epoch_handle(
    handle: u64,
    envelope_bytes: Vec<u8>,
) -> DecryptedShardResult {
    let envelope_bytes = Zeroizing::new(envelope_bytes);
    decrypted_shard_result_from_client(mosaic_client::decrypt_shard_with_epoch_handle(
        handle,
        &envelope_bytes,
    ))
}

/// Decrypts a legacy raw-key shard envelope with a Rust-owned epoch-key handle.
///
/// `envelope_bytes` is wiped on every exit path for parity with
/// `decrypt_shard_with_epoch_handle`. The raw epoch seed remains inside the
/// client registry and never crosses UniFFI.
#[uniffi::export]
#[must_use]
pub fn decrypt_shard_with_legacy_raw_key_handle(
    handle: u64,
    envelope_bytes: Vec<u8>,
) -> DecryptedShardResult {
    let envelope_bytes = Zeroizing::new(envelope_bytes);
    match mosaic_client::decrypt_shard_with_legacy_raw_key_handle(handle, &envelope_bytes) {
        Ok(plaintext) => DecryptedShardResult {
            code: mosaic_client::ClientErrorCode::Ok.as_u16(),
            plaintext,
        },
        Err(error) => DecryptedShardResult {
            code: error.code.as_u16(),
            plaintext: Vec::new(),
        },
    }
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
    let request = match upload_request_to_client(request) {
        Ok(value) => value,
        Err(code) => {
            return ClientCoreUploadJobResult {
                code,
                snapshot: empty_upload_snapshot(),
            };
        }
    };
    match mosaic_client::new_upload_job(request) {
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
    let snapshot = match upload_snapshot_to_client(snapshot) {
        Ok(value) => value,
        Err(code) => {
            return ClientCoreUploadJobTransitionResult {
                code,
                transition: empty_upload_transition(),
            };
        }
    };
    let event = match upload_event_to_client(event) {
        Ok(value) => value,
        Err(code) => {
            return ClientCoreUploadJobTransitionResult {
                code,
                transition: empty_upload_transition(),
            };
        }
    };
    match mosaic_client::advance_upload_job(&snapshot, event) {
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
    let snapshot = match album_sync_snapshot_to_client(snapshot) {
        Ok(value) => value,
        Err(code) => {
            return ClientCoreAlbumSyncTransitionResult {
                code,
                transition: empty_album_sync_transition(),
            };
        }
    };
    let event = match album_sync_event_to_client(event, &snapshot.album_id) {
        Ok(value) => value,
        Err(code) => {
            return ClientCoreAlbumSyncTransitionResult {
                code,
                transition: empty_album_sync_transition(),
            };
        }
    };
    match mosaic_client::advance_album_sync(&snapshot, event) {
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
        sign_public_key: result.sign_public_key,
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
    mut result: mosaic_client::DecryptedShardResult,
) -> DecryptedShardResult {
    DecryptedShardResult {
        code: result.code.as_u16(),
        plaintext: std::mem::take(&mut result.plaintext),
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
) -> Result<mosaic_client::UploadJobRequest, u16> {
    Ok(mosaic_client::UploadJobRequest {
        job_id: uuid_from_string(&request.job_id)?,
        album_id: uuid_from_string(&request.album_id)?,
        asset_id: uuid_from_string(&request.asset_id)?,
        idempotency_key: uuid_from_string(&request.idempotency_key)?,
        max_retry_count: request.max_retry_count,
    })
}

fn upload_snapshot_to_client(
    snapshot: ClientCoreUploadJobSnapshot,
) -> Result<mosaic_client::UploadJobSnapshot, u16> {
    let phase = upload_phase_from_string(&snapshot.phase)
        .ok_or_else(|| mosaic_client::ClientErrorCode::ClientCoreInvalidSnapshot.as_u16())?;
    let schema_version = schema_version_u16(snapshot.schema_version)?;
    let retry_count = u8_from_u32(snapshot.retry_count)?;
    let max_retry_count = snapshot.max_retry_count;
    let shard_set_hash = optional_bytes_32(&snapshot.shard_set_hash)?;
    let last_acknowledged_effect_id =
        optional_uuid_from_string(&snapshot.last_acknowledged_effect_id)?;
    let last_applied_event_id = if snapshot.last_applied_event_id.is_empty() {
        optional_uuid_from_string(&snapshot.last_effect_id)?
    } else {
        optional_uuid_from_string(&snapshot.last_applied_event_id)?
    };
    let failure_code = optional_client_error_code(snapshot.failure_code)?;

    Ok(mosaic_client::UploadJobSnapshot {
        schema_version,
        job_id: uuid_from_string(&snapshot.job_id)?,
        album_id: uuid_from_string(&snapshot.album_id)?,
        phase,
        retry_count,
        max_retry_count,
        next_retry_not_before_ms: snapshot
            .has_next_retry_not_before_ms
            .then_some(snapshot.next_retry_not_before_ms),
        idempotency_key: uuid_from_string(&snapshot.idempotency_key)?,
        tiered_shards: snapshot
            .tiered_shards
            .iter()
            .map(upload_shard_to_client)
            .collect::<Result<Vec<_>, _>>()?,
        shard_set_hash,
        snapshot_revision: snapshot.snapshot_revision,
        last_acknowledged_effect_id,
        last_applied_event_id,
        failure_code,
    })
}

fn upload_event_to_client(
    event: ClientCoreUploadJobEvent,
) -> Result<mosaic_client::UploadJobEvent, u16> {
    let invalid_snapshot = mosaic_client::ClientErrorCode::ClientCoreInvalidSnapshot.as_u16();
    let effect_id = uuid_from_string(&event.effect_id)?;
    validate_error_code_presence(event.has_error_code, event.error_code)?;
    Ok(match event.kind.as_str() {
        "StartRequested" | "Start" => mosaic_client::UploadJobEvent::StartRequested { effect_id },
        "MediaPrepared" | "PreparedMedia" => mosaic_client::UploadJobEvent::MediaPrepared {
            effect_id,
            tiered_shards: upload_event_tiered_shards(&event)?,
            shard_set_hash: optional_bytes_32(&event.shard_set_hash)?,
        },
        "EpochHandleAcquired" | "EpochHandleReady" => {
            mosaic_client::UploadJobEvent::EpochHandleAcquired { effect_id }
        }
        "ShardEncrypted" => mosaic_client::UploadJobEvent::ShardEncrypted {
            effect_id,
            shard: upload_shard_event_to_client(&event)?,
        },
        "ShardUploadCreated" => mosaic_client::UploadJobEvent::ShardUploadCreated {
            effect_id,
            shard: upload_shard_event_to_client(&event)?,
        },
        "ShardUploaded" => mosaic_client::UploadJobEvent::ShardUploaded {
            effect_id,
            shard: upload_shard_event_to_client(&event)?,
        },
        "ManifestCreated" => mosaic_client::UploadJobEvent::ManifestCreated { effect_id },
        "ManifestOutcomeUnknown" => mosaic_client::UploadJobEvent::ManifestOutcomeUnknown {
            effect_id,
            asset_id: uuid_from_string(&event.asset_id)?,
            since_metadata_version: event.since_metadata_version,
        },
        "ManifestRecoveryResolved" => mosaic_client::UploadJobEvent::ManifestRecoveryResolved {
            effect_id,
            outcome: manifest_recovery_outcome_from_string(&event.recovery_outcome)
                .ok_or(invalid_snapshot)?,
            now_ms: event.now_ms,
            base_backoff_ms: event.base_backoff_ms,
            server_retry_after_ms: event
                .has_server_retry_after_ms
                .then_some(event.server_retry_after_ms),
        },
        "SyncConfirmed" => mosaic_client::UploadJobEvent::SyncConfirmed { effect_id },
        "EffectAck" => mosaic_client::UploadJobEvent::EffectAck { effect_id },
        "RetryableFailure" => mosaic_client::UploadJobEvent::RetryableFailure {
            effect_id,
            code: required_event_error_code(event.has_error_code, event.error_code)?,
            now_ms: event.now_ms,
            base_backoff_ms: event.base_backoff_ms,
            server_retry_after_ms: event
                .has_server_retry_after_ms
                .then_some(event.server_retry_after_ms),
        },
        "RetryTimerElapsed" => mosaic_client::UploadJobEvent::RetryTimerElapsed {
            effect_id,
            target_phase: upload_phase_from_string(&event.target_phase).ok_or(invalid_snapshot)?,
        },
        "CancelRequested" => mosaic_client::UploadJobEvent::CancelRequested { effect_id },
        "AlbumDeleted" => mosaic_client::UploadJobEvent::AlbumDeleted { effect_id },
        "NonRetryableFailure" => mosaic_client::UploadJobEvent::NonRetryableFailure {
            effect_id,
            code: required_event_error_code(event.has_error_code, event.error_code)?,
        },
        "IdempotencyExpired" => mosaic_client::UploadJobEvent::IdempotencyExpired { effect_id },
        _ => return Err(mosaic_client::ClientErrorCode::ClientCoreInvalidTransition.as_u16()),
    })
}

fn upload_snapshot_from_client(
    snapshot: mosaic_client::UploadJobSnapshot,
) -> ClientCoreUploadJobSnapshot {
    ClientCoreUploadJobSnapshot {
        schema_version: u32::from(snapshot.schema_version),
        job_id: uuid_to_string(snapshot.job_id),
        album_id: uuid_to_string(snapshot.album_id),
        phase: upload_phase_to_string(snapshot.phase),
        retry_count: u32::from(snapshot.retry_count),
        max_retry_count: snapshot.max_retry_count,
        next_retry_not_before_ms: snapshot.next_retry_not_before_ms.unwrap_or_default(),
        has_next_retry_not_before_ms: snapshot.next_retry_not_before_ms.is_some(),
        idempotency_key: uuid_to_string(snapshot.idempotency_key),
        tiered_shards: snapshot
            .tiered_shards
            .into_iter()
            .map(upload_shard_from_client)
            .collect(),
        shard_set_hash: snapshot
            .shard_set_hash
            .map_or_else(Vec::new, |hash| hash.to_vec()),
        snapshot_revision: snapshot.snapshot_revision,
        last_effect_id: snapshot
            .last_applied_event_id
            .map_or_else(String::new, uuid_to_string),
        last_acknowledged_effect_id: snapshot
            .last_acknowledged_effect_id
            .map_or_else(String::new, uuid_to_string),
        last_applied_event_id: snapshot
            .last_applied_event_id
            .map_or_else(String::new, uuid_to_string),
        failure_code: snapshot
            .failure_code
            .map_or(0, mosaic_client::ClientErrorCode::as_u16),
    }
}

fn upload_transition_from_client(
    transition: mosaic_client::UploadJobTransition,
) -> ClientCoreUploadJobTransition {
    ClientCoreUploadJobTransition {
        next_snapshot: upload_snapshot_from_client(transition.next_snapshot),
        effects: transition
            .effects
            .into_iter()
            .map(upload_effect_from_client)
            .collect(),
    }
}

fn album_sync_request_to_client(
    request: ClientCoreAlbumSyncRequest,
) -> mosaic_client::AlbumSyncRequest {
    mosaic_client::AlbumSyncRequest {
        sync_id: request.request_id,
        album_id: request.album_id,
        initial_page_token: optional_string(request.start_cursor),
        max_retry_count: request.max_retry_count,
    }
}

fn album_sync_snapshot_to_client(
    snapshot: ClientCoreAlbumSyncSnapshot,
) -> Result<mosaic_client::AlbumSyncSnapshot, u16> {
    let invalid_snapshot = mosaic_client::ClientErrorCode::ClientCoreInvalidSnapshot.as_u16();

    let retry_target_phase = if snapshot.last_error_stage.is_empty() {
        None
    } else {
        Some(album_sync_phase_from_string(&snapshot.last_error_stage).ok_or(invalid_snapshot)?)
    };
    let last_error_code = match client_error_code_from_u16(snapshot.last_error_code) {
        Some(code) => Some(code),
        None => return Err(invalid_snapshot),
    };
    let phase = album_sync_phase_from_string(&snapshot.phase).ok_or(invalid_snapshot)?;
    let schema_version = schema_version_u16(snapshot.schema_version)?;

    Ok(mosaic_client::AlbumSyncSnapshot {
        schema_version,
        sync_id: snapshot.album_id.clone(),
        album_id: snapshot.album_id,
        phase,
        initial_page_token: optional_string(snapshot.active_cursor.clone()),
        next_page_token: optional_string(snapshot.active_cursor),
        current_page: None,
        rerun_requested: snapshot.rerun_requested,
        completed_cycle_count: 0,
        retry: mosaic_client::AlbumSyncRetryMetadata {
            attempt_count: snapshot.retry_count,
            max_attempts: snapshot.max_retry_count,
            retry_after_ms: (snapshot.next_retry_unix_ms != 0)
                .then_some(snapshot.next_retry_unix_ms),
            last_error_code,
            last_error_stage: retry_target_phase,
            retry_target_phase,
        },
        failure_code: last_error_code,
    })
}

fn album_sync_event_to_client(
    event: ClientCoreAlbumSyncEvent,
    album_id: &str,
) -> Result<mosaic_client::AlbumSyncEvent, u16> {
    validate_error_code_presence(event.has_error_code, event.error_code)?;
    Ok(match event.kind.as_str() {
        "SyncRequested" | "StartRequested" | "Start" => {
            mosaic_client::AlbumSyncEvent::SyncRequested {
                request: Some(mosaic_client::AlbumSyncRequest {
                    sync_id: if event.fetched_cursor.is_empty() {
                        "sync".to_owned()
                    } else {
                        event.fetched_cursor
                    },
                    album_id: album_id.to_owned(),
                    initial_page_token: optional_string(event.next_cursor),
                    max_retry_count: 0,
                }),
            }
        }
        "PageFetched" => mosaic_client::AlbumSyncEvent::PageFetched {
            page: Some(mosaic_client::SyncPageSummary {
                previous_page_token: optional_string(event.fetched_cursor),
                next_page_token: optional_string(event.next_cursor.clone()),
                reached_end: event.next_cursor.is_empty(),
                encrypted_item_count: event.applied_count,
            }),
        },
        "PageApplied" => mosaic_client::AlbumSyncEvent::PageApplied,
        "RetryableFailure" => mosaic_client::AlbumSyncEvent::RetryableFailure {
            code: required_event_error_code(event.has_error_code, event.error_code)?,
            retry_after_ms: (event.retry_after_unix_ms != 0).then_some(event.retry_after_unix_ms),
        },
        "RetryTimerElapsed" => mosaic_client::AlbumSyncEvent::RetryTimerElapsed,
        "CancelRequested" => mosaic_client::AlbumSyncEvent::CancelRequested,
        "NonRetryableFailure" => mosaic_client::AlbumSyncEvent::NonRetryableFailure {
            code: required_event_error_code(event.has_error_code, event.error_code)?,
        },
        _ => return Err(mosaic_client::ClientErrorCode::ClientCoreInvalidTransition.as_u16()),
    })
}

fn album_sync_snapshot_from_client(
    snapshot: mosaic_client::AlbumSyncSnapshot,
) -> ClientCoreAlbumSyncSnapshot {
    let last_error_code = snapshot
        .retry
        .last_error_code
        .or(snapshot.failure_code)
        .map_or(0, mosaic_client::ClientErrorCode::as_u16);

    ClientCoreAlbumSyncSnapshot {
        schema_version: u32::from(snapshot.schema_version),
        album_id: snapshot.album_id,
        phase: album_sync_phase_to_string(snapshot.phase),
        active_cursor: snapshot.next_page_token.unwrap_or_default(),
        pending_cursor: snapshot
            .current_page
            .and_then(|page| page.next_page_token)
            .unwrap_or_default(),
        rerun_requested: snapshot.rerun_requested,
        retry_count: snapshot.retry.attempt_count,
        max_retry_count: snapshot.retry.max_attempts,
        next_retry_unix_ms: snapshot.retry.retry_after_ms.unwrap_or_default(),
        last_error_code,
        last_error_stage: snapshot
            .retry
            .last_error_stage
            .map_or_else(String::new, album_sync_phase_to_string),
        updated_at_unix_ms: 0,
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
            .map(album_sync_effect_from_client)
            .collect(),
    }
}

fn upload_shard_to_client(
    shard: &ClientCoreUploadShardRef,
) -> Result<mosaic_client::UploadShardRef, u16> {
    Ok(mosaic_client::UploadShardRef {
        tier: shard.tier,
        shard_index: shard.shard_index,
        shard_id: uuid_from_string(&shard.shard_id)?,
        sha256: bytes_32(&shard.sha256)?,
        content_length: shard.content_length,
        envelope_version: shard.envelope_version,
        uploaded: shard.uploaded,
    })
}

fn upload_shard_event_to_client(
    event: &ClientCoreUploadJobEvent,
) -> Result<mosaic_client::UploadShardRef, u16> {
    let kind_uploaded = matches!(event.kind.as_str(), "ShardUploaded");
    if event.uploaded != kind_uploaded {
        return Err(mosaic_client::ClientErrorCode::ClientCoreInvalidTransition.as_u16());
    }
    Ok(mosaic_client::UploadShardRef {
        tier: event.tier,
        shard_index: event.shard_index,
        shard_id: uuid_from_string(&event.shard_id)?,
        sha256: bytes_32(&event.sha256)?,
        content_length: event.content_length,
        envelope_version: event.envelope_version,
        uploaded: event.uploaded,
    })
}

fn upload_event_tiered_shards(
    event: &ClientCoreUploadJobEvent,
) -> Result<Vec<mosaic_client::UploadShardRef>, u16> {
    if !event.tiered_shards.is_empty() {
        return event
            .tiered_shards
            .iter()
            .map(upload_shard_to_client)
            .collect();
    }
    upload_shard_event_to_client(event).map(|shard| vec![shard])
}

fn upload_shard_from_client(shard: mosaic_client::UploadShardRef) -> ClientCoreUploadShardRef {
    ClientCoreUploadShardRef {
        tier: shard.tier,
        shard_index: shard.shard_index,
        shard_id: uuid_to_string(shard.shard_id),
        sha256: shard.sha256.to_vec(),
        content_length: shard.content_length,
        envelope_version: shard.envelope_version,
        uploaded: shard.uploaded,
    }
}

fn upload_effect_from_client(effect: mosaic_client::UploadJobEffect) -> ClientCoreUploadJobEffect {
    match effect {
        mosaic_client::UploadJobEffect::PrepareMedia { effect_id } => {
            upload_effect("PrepareMedia", effect_id)
        }
        mosaic_client::UploadJobEffect::AcquireEpochHandle { effect_id } => {
            upload_effect("AcquireEpochHandle", effect_id)
        }
        mosaic_client::UploadJobEffect::EncryptShard {
            effect_id,
            tier,
            shard_index,
        } => ClientCoreUploadJobEffect {
            kind: "EncryptShard".to_owned(),
            effect_id: uuid_to_string(effect_id),
            tier,
            shard_index,
            ..empty_upload_effect_fields()
        },
        mosaic_client::UploadJobEffect::CreateShardUpload { effect_id, shard } => {
            upload_shard_effect("CreateShardUpload", effect_id, shard)
        }
        mosaic_client::UploadJobEffect::UploadShard { effect_id, shard } => {
            upload_shard_effect("UploadShard", effect_id, shard)
        }
        mosaic_client::UploadJobEffect::CreateManifest {
            effect_id,
            idempotency_key,
            tiered_shards,
            shard_set_hash,
        } => ClientCoreUploadJobEffect {
            kind: "CreateManifest".to_owned(),
            effect_id: uuid_to_string(effect_id),
            idempotency_key: uuid_to_string(idempotency_key),
            shard_set_hash: shard_set_hash.map_or_else(Vec::new, |hash| hash.to_vec()),
            content_length: u64::try_from(tiered_shards.len()).unwrap_or(u64::MAX),
            ..empty_upload_effect_fields()
        },
        mosaic_client::UploadJobEffect::AwaitSyncConfirmation { effect_id } => {
            upload_effect("AwaitSyncConfirmation", effect_id)
        }
        mosaic_client::UploadJobEffect::RecoverManifestThroughSync {
            effect_id,
            asset_id,
            since_metadata_version,
            shard_set_hash,
        } => ClientCoreUploadJobEffect {
            kind: "RecoverManifestThroughSync".to_owned(),
            effect_id: uuid_to_string(effect_id),
            asset_id: uuid_to_string(asset_id),
            since_metadata_version,
            shard_set_hash: shard_set_hash.map_or_else(Vec::new, |hash| hash.to_vec()),
            ..empty_upload_effect_fields()
        },
        mosaic_client::UploadJobEffect::ScheduleRetry {
            effect_id,
            attempt,
            not_before_ms,
            target_phase,
        } => ClientCoreUploadJobEffect {
            kind: "ScheduleRetry".to_owned(),
            effect_id: uuid_to_string(effect_id),
            attempt: u32::from(attempt),
            not_before_ms,
            target_phase: upload_phase_to_string(target_phase),
            ..empty_upload_effect_fields()
        },
        mosaic_client::UploadJobEffect::CleanupStaging { effect_id, reason } => {
            ClientCoreUploadJobEffect {
                kind: "CleanupStaging".to_owned(),
                effect_id: uuid_to_string(effect_id),
                reason: format!("{reason:?}"),
                ..empty_upload_effect_fields()
            }
        }
    }
}

fn upload_effect(kind: &str, effect_id: mosaic_client::Uuid) -> ClientCoreUploadJobEffect {
    ClientCoreUploadJobEffect {
        kind: kind.to_owned(),
        effect_id: uuid_to_string(effect_id),
        ..empty_upload_effect_fields()
    }
}

fn upload_shard_effect(
    kind: &str,
    effect_id: mosaic_client::Uuid,
    shard: mosaic_client::UploadShardRef,
) -> ClientCoreUploadJobEffect {
    ClientCoreUploadJobEffect {
        kind: kind.to_owned(),
        effect_id: uuid_to_string(effect_id),
        tier: shard.tier,
        shard_index: shard.shard_index,
        shard_id: uuid_to_string(shard.shard_id),
        sha256: shard.sha256.to_vec(),
        content_length: shard.content_length,
        envelope_version: shard.envelope_version,
        ..empty_upload_effect_fields()
    }
}

fn empty_upload_effect_fields() -> ClientCoreUploadJobEffect {
    ClientCoreUploadJobEffect {
        kind: String::new(),
        effect_id: String::new(),
        tier: 0,
        shard_index: 0,
        shard_id: String::new(),
        sha256: Vec::new(),
        content_length: 0,
        envelope_version: 0,
        attempt: 0,
        not_before_ms: 0,
        target_phase: String::new(),
        reason: String::new(),
        asset_id: String::new(),
        since_metadata_version: 0,
        idempotency_key: String::new(),
        shard_set_hash: Vec::new(),
    }
}

fn album_sync_effect_from_client(
    effect: mosaic_client::AlbumSyncEffect,
) -> ClientCoreAlbumSyncEffect {
    match effect {
        mosaic_client::AlbumSyncEffect::FetchPage { page_token } => ClientCoreAlbumSyncEffect {
            kind: "FetchPage".to_owned(),
            cursor: page_token.unwrap_or_default(),
        },
        mosaic_client::AlbumSyncEffect::ApplyPage {
            encrypted_item_count,
        } => ClientCoreAlbumSyncEffect {
            kind: "ApplyPage".to_owned(),
            cursor: encrypted_item_count.to_string(),
        },
        mosaic_client::AlbumSyncEffect::ScheduleRetry { target_phase, .. } => {
            ClientCoreAlbumSyncEffect {
                kind: format!("ScheduleRetry:{}", album_sync_phase_to_string(target_phase)),
                cursor: String::new(),
            }
        }
    }
}

fn upload_phase_to_string(phase: mosaic_client::UploadJobPhase) -> String {
    format!("{phase:?}")
}

fn upload_phase_from_string(value: &str) -> Option<mosaic_client::UploadJobPhase> {
    match value {
        "Queued" => Some(mosaic_client::UploadJobPhase::Queued),
        "AwaitingPreparedMedia" => Some(mosaic_client::UploadJobPhase::AwaitingPreparedMedia),
        "AwaitingEpochHandle" => Some(mosaic_client::UploadJobPhase::AwaitingEpochHandle),
        "EncryptingShard" => Some(mosaic_client::UploadJobPhase::EncryptingShard),
        "CreatingShardUpload" => Some(mosaic_client::UploadJobPhase::CreatingShardUpload),
        "UploadingShard" => Some(mosaic_client::UploadJobPhase::UploadingShard),
        "CreatingManifest" => Some(mosaic_client::UploadJobPhase::CreatingManifest),
        "ManifestCommitUnknown" => Some(mosaic_client::UploadJobPhase::ManifestCommitUnknown),
        "AwaitingSyncConfirmation" => Some(mosaic_client::UploadJobPhase::AwaitingSyncConfirmation),
        "RetryWaiting" => Some(mosaic_client::UploadJobPhase::RetryWaiting),
        "Confirmed" => Some(mosaic_client::UploadJobPhase::Confirmed),
        "Cancelled" => Some(mosaic_client::UploadJobPhase::Cancelled),
        "Failed" => Some(mosaic_client::UploadJobPhase::Failed),
        _ => None,
    }
}

fn album_sync_phase_to_string(phase: mosaic_client::AlbumSyncPhase) -> String {
    format!("{phase:?}")
}

fn album_sync_phase_from_string(value: &str) -> Option<mosaic_client::AlbumSyncPhase> {
    match value {
        "Idle" => Some(mosaic_client::AlbumSyncPhase::Idle),
        "FetchingPage" => Some(mosaic_client::AlbumSyncPhase::FetchingPage),
        "ApplyingPage" => Some(mosaic_client::AlbumSyncPhase::ApplyingPage),
        "RetryWaiting" => Some(mosaic_client::AlbumSyncPhase::RetryWaiting),
        "Completed" => Some(mosaic_client::AlbumSyncPhase::Completed),
        "Cancelled" => Some(mosaic_client::AlbumSyncPhase::Cancelled),
        "Failed" => Some(mosaic_client::AlbumSyncPhase::Failed),
        _ => None,
    }
}

fn optional_string(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

fn uuid_from_string(value: &str) -> Result<mosaic_client::Uuid, u16> {
    let invalid_snapshot = mosaic_client::ClientErrorCode::ClientCoreInvalidSnapshot.as_u16();
    let mut hex = String::with_capacity(32);
    for character in value.chars() {
        if character == '-' {
            continue;
        }
        if !character.is_ascii_hexdigit() {
            return Err(invalid_snapshot);
        }
        hex.push(character);
    }
    if hex.len() != 32 {
        return Err(invalid_snapshot);
    }
    let mut bytes = [0_u8; 16];
    for (index, byte) in bytes.iter_mut().enumerate() {
        let start = index * 2;
        let end = start + 2;
        let Some(pair) = hex.get(start..end) else {
            return Err(invalid_snapshot);
        };
        let Ok(parsed) = u8::from_str_radix(pair, 16) else {
            return Err(invalid_snapshot);
        };
        *byte = parsed;
    }
    let uuid = mosaic_client::Uuid::from_bytes(bytes);
    if !uuid.is_uuid_v7() {
        return Err(invalid_snapshot);
    }
    Ok(uuid)
}

fn optional_uuid_from_string(value: &str) -> Result<Option<mosaic_client::Uuid>, u16> {
    if value.is_empty() {
        Ok(None)
    } else {
        uuid_from_string(value).map(Some)
    }
}

fn uuid_to_string(uuid: mosaic_client::Uuid) -> String {
    let bytes = uuid.as_bytes();
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

fn bytes_32(value: &[u8]) -> Result<[u8; 32], u16> {
    value
        .try_into()
        .map_err(|_| mosaic_client::ClientErrorCode::InvalidInputLength.as_u16())
}

fn optional_bytes_32(value: &[u8]) -> Result<Option<[u8; 32]>, u16> {
    if value.is_empty() {
        Ok(None)
    } else {
        bytes_32(value).map(Some)
    }
}

fn u8_from_u32(value: u32) -> Result<u8, u16> {
    u8::try_from(value)
        .map_err(|_| mosaic_client::ClientErrorCode::ClientCoreInvalidSnapshot.as_u16())
}

fn manifest_recovery_outcome_from_string(
    value: &str,
) -> Option<mosaic_client::ManifestRecoveryOutcome> {
    match value {
        "Match" => Some(mosaic_client::ManifestRecoveryOutcome::Match),
        "ShardSetConflict" => Some(mosaic_client::ManifestRecoveryOutcome::ShardSetConflict),
        "NotFoundTimedOut" => Some(mosaic_client::ManifestRecoveryOutcome::NotFoundTimedOut),
        "IdempotencyExpired" => Some(mosaic_client::ManifestRecoveryOutcome::IdempotencyExpired),
        _ => None,
    }
}

fn schema_version_u16(value: u32) -> Result<u16, u16> {
    u16::try_from(value)
        .map_err(|_| mosaic_client::ClientErrorCode::ClientCoreInvalidSnapshot.as_u16())
}

fn optional_client_error_code(value: u16) -> Result<Option<mosaic_client::ClientErrorCode>, u16> {
    if value == 0 {
        Ok(None)
    } else {
        client_error_code_from_u16(value)
            .ok_or_else(|| mosaic_client::ClientErrorCode::ClientCoreInvalidSnapshot.as_u16())
            .map(Some)
    }
}

fn validate_error_code_presence(has_error_code: bool, error_code: u16) -> Result<(), u16> {
    if !has_error_code && error_code != 0 {
        return Err(mosaic_client::ClientErrorCode::ClientCoreInvalidSnapshot.as_u16());
    }
    Ok(())
}

fn required_event_error_code(
    has_error_code: bool,
    error_code: u16,
) -> Result<mosaic_client::ClientErrorCode, u16> {
    if !has_error_code || error_code == 0 {
        return Err(mosaic_client::ClientErrorCode::ClientCoreInvalidSnapshot.as_u16());
    }
    client_error_code_from_u16(error_code)
        .ok_or_else(|| mosaic_client::ClientErrorCode::ClientCoreInvalidSnapshot.as_u16())
}

/// Converts a stable `ClientErrorCode` number at the UniFFI boundary.
#[must_use]
pub const fn client_error_code_from_u16(value: u16) -> Option<mosaic_client::ClientErrorCode> {
    mosaic_client::ClientErrorCode::try_from_u16(value)
}
fn empty_upload_snapshot() -> ClientCoreUploadJobSnapshot {
    ClientCoreUploadJobSnapshot {
        schema_version: 0,
        job_id: String::new(),
        album_id: String::new(),
        phase: String::new(),
        retry_count: 0,
        max_retry_count: 0,
        next_retry_not_before_ms: 0,
        has_next_retry_not_before_ms: false,
        idempotency_key: String::new(),
        tiered_shards: Vec::new(),
        shard_set_hash: Vec::new(),
        snapshot_revision: 0,
        last_effect_id: String::new(),
        last_acknowledged_effect_id: String::new(),
        last_applied_event_id: String::new(),
        failure_code: 0,
    }
}

fn empty_upload_transition() -> ClientCoreUploadJobTransition {
    ClientCoreUploadJobTransition {
        next_snapshot: empty_upload_snapshot(),
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
        max_retry_count: 0,
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

/// Maximum byte length permitted for a single encoded metadata field value. Larger values
/// are rejected with `ClientErrorCode::InvalidInputLength` to prevent host-supplied length
/// fields from driving large allocations or downstream `usize`-truncation footguns.
const MAX_METADATA_FIELD_VALUE_BYTES: usize = 64 * 1024;

fn metadata_fields_from_encoded(
    encoded_fields: &[u8],
) -> Result<Vec<MetadataSidecarField<'_>>, u16> {
    let invalid_input_length = mosaic_client::ClientErrorCode::InvalidInputLength.as_u16();
    let mut fields = Vec::new();
    let mut offset = 0_usize;
    while offset < encoded_fields.len() {
        let remaining = &encoded_fields[offset..];
        if remaining.len() < 6 {
            return Err(invalid_input_length);
        }

        let tag = u16::from_le_bytes([remaining[0], remaining[1]]);
        let value_len_u32 =
            u32::from_le_bytes([remaining[2], remaining[3], remaining[4], remaining[5]]);
        // Compare against the cap as u64 so the check is independent of host pointer width
        // and runs before any `usize` cast on the user-supplied length.
        if u64::from(value_len_u32) > MAX_METADATA_FIELD_VALUE_BYTES as u64 {
            return Err(invalid_input_length);
        }
        let value_len = value_len_u32 as usize;
        offset += 6;

        let end = match offset.checked_add(value_len) {
            Some(value) => value,
            None => return Err(invalid_input_length),
        };
        if end > encoded_fields.len() {
            return Err(invalid_input_length);
        }

        fields.push(MetadataSidecarField::new(tag, &encoded_fields[offset..end]));
        offset = end;
    }
    Ok(fields)
}

fn map_metadata_sidecar_error(error: MetadataSidecarError) -> u16 {
    match error {
        MetadataSidecarError::LengthTooLarge { .. } => {
            mosaic_client::ClientErrorCode::SidecarFieldOverflow.as_u16()
        }
        MetadataSidecarError::ReservedTagNotPromoted { .. } => {
            mosaic_client::ClientErrorCode::MetadataSidecarReservedTagNotPromoted.as_u16()
        }
        MetadataSidecarError::ForbiddenTag { .. } | MetadataSidecarError::UnknownTag { .. } => {
            mosaic_client::ClientErrorCode::SidecarTagUnknown.as_u16()
        }
        MetadataSidecarError::ZeroFieldTag
        | MetadataSidecarError::EmptyFieldValue { .. }
        | MetadataSidecarError::DuplicateFieldTag { .. }
        | MetadataSidecarError::UnsortedFieldTag { .. } => {
            mosaic_client::ClientErrorCode::MalformedSidecar.as_u16()
        }
    }
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

fn map_crypto_error_uniffi(error: mosaic_crypto::MosaicCryptoError) -> u16 {
    match error {
        mosaic_crypto::MosaicCryptoError::EmptyContext => {
            mosaic_client::ClientErrorCode::EmptyContext.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::InvalidKeyLength { .. } => {
            mosaic_client::ClientErrorCode::InvalidKeyLength.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::InvalidInputLength { .. } => {
            mosaic_client::ClientErrorCode::InvalidInputLength.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::AuthenticationFailed => {
            mosaic_client::ClientErrorCode::AuthenticationFailed.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::WrappedKeyTooShort { .. } => {
            mosaic_client::ClientErrorCode::WrappedKeyTooShort.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::InvalidSaltLength { .. } => {
            mosaic_client::ClientErrorCode::InvalidSaltLength.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::InvalidSignatureLength { .. } => {
            mosaic_client::ClientErrorCode::InvalidSignatureLength.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::InvalidPublicKey => {
            mosaic_client::ClientErrorCode::InvalidPublicKey.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::InvalidUsername => {
            mosaic_client::ClientErrorCode::InvalidUsername.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::KdfFailure => {
            mosaic_client::ClientErrorCode::KdfFailure.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::KdfProfileTooWeak => {
            mosaic_client::ClientErrorCode::KdfProfileTooWeak.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::KdfProfileTooCostly => {
            mosaic_client::ClientErrorCode::KdfProfileTooCostly.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::RngFailure => {
            mosaic_client::ClientErrorCode::RngFailure.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::InvalidEnvelope => {
            mosaic_client::ClientErrorCode::InvalidEnvelope.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::MissingCiphertext => {
            mosaic_client::ClientErrorCode::MissingCiphertext.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::BundleSignatureInvalid => {
            mosaic_client::ClientErrorCode::BundleSignatureInvalid.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::BundleAlbumIdEmpty => {
            mosaic_client::ClientErrorCode::BundleAlbumIdEmpty.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::BundleAlbumIdMismatch => {
            mosaic_client::ClientErrorCode::BundleAlbumIdMismatch.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::BundleEpochTooOld => {
            mosaic_client::ClientErrorCode::BundleEpochTooOld.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::BundleRecipientMismatch => {
            mosaic_client::ClientErrorCode::BundleRecipientMismatch.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::BundleJsonParse => {
            mosaic_client::ClientErrorCode::BundleJsonParse.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::BundleSealOpenFailed => {
            mosaic_client::ClientErrorCode::BundleSealOpenFailed.as_u16()
        }
        _ => mosaic_client::ClientErrorCode::InternalStatePoisoned.as_u16(),
    }
}

// ---------------------------------------------------------------------------
// Slice 0C — raw-input cross-client crypto entry points
//
// These exports exist exclusively to drive the cross-client byte-equality
// tests in `tests/vectors/*.json` from the Android (and other) FFI consumer.
// Each takes raw secret bytes (link secrets, identity seeds, content keys,
// auth signing seeds, recipient identity seeds) ONLY because the canonical
// vectors are defined in terms of those raw inputs.
//
// Production code MUST continue to use the handle-based exports
// (`open_identity_handle`, `encrypt_album_content_with_epoch_handle`, etc.)
// so long-lived key material stays inside the registry with structured
// zeroization. The architecture-guard at
// `tests/architecture/kotlin-raw-input-ffi.{ps1,sh}` enforces that no
// non-test Kotlin caller references the bridges added on top of these
// exports.
//
// Inputs are wrapped in `Zeroizing` and wiped before return. Result records
// implement custom `fmt::Debug` that redacts byte payloads per the
// commit `fb26573` (M5) discipline.
// ---------------------------------------------------------------------------

/// UniFFI record for raw-secret link-key derivation results.
///
/// `link_id` is server-visible (16 bytes); `wrapping_key` is
/// secret-equivalent (32 bytes) and the cross-client vector requires
/// byte-equality on it.
#[derive(Clone, PartialEq, Eq, uniffi::Record)]
pub struct LinkKeysFfiResult {
    pub code: u16,
    pub link_id: Vec<u8>,
    pub wrapping_key: Vec<u8>,
}

impl fmt::Debug for LinkKeysFfiResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LinkKeysFfiResult")
            .field("code", &self.code)
            .field("link_id_len", &self.link_id.len())
            .field("wrapping_key_len", &self.wrapping_key.len())
            .finish()
    }
}

/// UniFFI record for raw-seed identity derivation results.
///
/// All three fields are public-cryptographic outputs (no secret seed bytes
/// leave the FFI boundary).
#[derive(Clone, PartialEq, Eq, uniffi::Record)]
pub struct IdentityFromSeedFfiResult {
    pub code: u16,
    pub signing_pubkey: Vec<u8>,
    pub encryption_pubkey: Vec<u8>,
    pub signature: Vec<u8>,
}

impl fmt::Debug for IdentityFromSeedFfiResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IdentityFromSeedFfiResult")
            .field("code", &self.code)
            .field("signing_pubkey_len", &self.signing_pubkey.len())
            .field("encryption_pubkey_len", &self.encryption_pubkey.len())
            .field("signature_len", &self.signature.len())
            .finish()
    }
}

/// UniFFI record for auth-challenge signature verification results.
#[derive(Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct AuthChallengeVerifyFfiResult {
    pub code: u16,
    pub valid: bool,
}

impl fmt::Debug for AuthChallengeVerifyFfiResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AuthChallengeVerifyFfiResult")
            .field("code", &self.code)
            .field("valid", &self.valid)
            .finish()
    }
}

/// UniFFI record for sealed-bundle verify-and-open results.
///
/// Mirrors `mosaic_client::OpenedBundleResult` but intentionally omits
/// `sign_secret_seed` — production sealed-sharing flows use the handle-based
/// `verify_and_open_bundle_with_identity_handle` so the per-epoch manifest
/// signing secret stays inside the registry. `epoch_seed` is
/// secret-equivalent and the cross-client vector asserts byte-equality on it.
#[derive(Clone, PartialEq, Eq, uniffi::Record)]
pub struct OpenedBundleFfiResult {
    pub code: u16,
    pub version: u32,
    pub album_id: String,
    pub epoch_id: u32,
    pub recipient_pubkey: Vec<u8>,
    pub epoch_seed: Vec<u8>,
    pub sign_public_key: Vec<u8>,
}

impl fmt::Debug for OpenedBundleFfiResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenedBundleFfiResult")
            .field("code", &self.code)
            .field("version", &self.version)
            .field("album_id_len", &self.album_id.len())
            .field("epoch_id", &self.epoch_id)
            .field("recipient_pubkey_len", &self.recipient_pubkey.len())
            .field("epoch_seed_len", &self.epoch_seed.len())
            .field("sign_public_key_len", &self.sign_public_key.len())
            .finish()
    }
}

/// UniFFI record for raw-key album-content decrypt results.
///
/// `plaintext` is secret-equivalent and the cross-client vector asserts
/// byte-equality on it.
#[derive(Clone, PartialEq, Eq, uniffi::Record)]
pub struct ContentDecryptFfiResult {
    pub code: u16,
    pub plaintext: Vec<u8>,
}

impl fmt::Debug for ContentDecryptFfiResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ContentDecryptFfiResult")
            .field("code", &self.code)
            .field("plaintext_len", &self.plaintext.len())
            .finish()
    }
}

/// Derives the `(link_id, wrapping_key)` pair from a 32-byte share-link
/// secret.
///
/// Used by the cross-client `link_keys.json` corpus driver. Production code
/// should use the higher-level link-sharing helpers, not this raw-input
/// surface.
///
/// SECURITY: The caller-provided link secret is wiped on the Rust side
/// before this function returns. `wrapping_key` in the result is
/// secret-equivalent — Kotlin callers MUST wipe the byte array after use.
#[uniffi::export]
#[must_use]
pub fn derive_link_keys_from_raw_secret(link_secret: Vec<u8>) -> LinkKeysFfiResult {
    let mut secret_buf = link_secret;
    let result = match mosaic_crypto::derive_link_keys(&secret_buf) {
        Ok(keys) => LinkKeysFfiResult {
            code: mosaic_client::ClientErrorCode::Ok.as_u16(),
            link_id: keys.link_id.to_vec(),
            wrapping_key: keys.wrapping_key.as_bytes().to_vec(),
        },
        Err(error) => LinkKeysFfiResult {
            code: map_crypto_error_uniffi(error),
            link_id: Vec::new(),
            wrapping_key: Vec::new(),
        },
    };
    use zeroize::Zeroize;
    secret_buf.zeroize();
    result
}

/// Derives identity public keys + a deterministic Ed25519 detached
/// signature over a caller-supplied message from a 32-byte identity seed.
///
/// Used by the cross-client `identity.json` corpus driver. Production code
/// should use the handle-based `create_identity_handle` /
/// `open_identity_handle` exports.
///
/// SECURITY: The caller-provided seed is wiped on the Rust side before
/// this function returns. The result does not contain the seed.
#[uniffi::export]
#[must_use]
pub fn derive_identity_from_raw_seed(
    identity_seed: Vec<u8>,
    message: Vec<u8>,
) -> IdentityFromSeedFfiResult {
    use zeroize::Zeroize;
    if identity_seed.len() != 32 {
        let mut seed_buf = identity_seed;
        seed_buf.zeroize();
        return IdentityFromSeedFfiResult {
            code: mosaic_client::ClientErrorCode::InvalidKeyLength.as_u16(),
            signing_pubkey: Vec::new(),
            encryption_pubkey: Vec::new(),
            signature: Vec::new(),
        };
    }
    let mut seed_buf = Zeroizing::new(identity_seed);
    let mut keypair = match mosaic_crypto::derive_identity_keypair(seed_buf.as_mut_slice()) {
        Ok(value) => value,
        Err(error) => {
            return IdentityFromSeedFfiResult {
                code: map_crypto_error_uniffi(error),
                signing_pubkey: Vec::new(),
                encryption_pubkey: Vec::new(),
                signature: Vec::new(),
            };
        }
    };
    let signing_pubkey = keypair.signing_public_key().as_bytes().to_vec();
    let encryption_pubkey = keypair.encryption_public_key().as_bytes().to_vec();
    let signature = mosaic_crypto::sign_manifest_with_identity(&message, keypair.secret_key())
        .as_bytes()
        .to_vec();
    keypair.zeroize_secret();
    IdentityFromSeedFfiResult {
        code: mosaic_client::ClientErrorCode::Ok.as_u16(),
        signing_pubkey,
        encryption_pubkey,
        signature,
    }
}

/// Builds the canonical LocalAuth challenge transcript bytes.
///
/// `timestamp_ms < 0` selects the no-timestamp transcript variant (matches
/// the JS API where the timestamp argument is optional). The resulting
/// bytes are suitable for direct Ed25519 detached signing via
/// [`sign_auth_challenge_with_raw_seed`].
#[uniffi::export]
#[must_use]
pub fn build_auth_challenge_transcript_bytes(
    username: String,
    timestamp_ms: i64,
    challenge: Vec<u8>,
) -> BytesResult {
    let timestamp = if timestamp_ms < 0 {
        None
    } else {
        Some(timestamp_ms as u64)
    };
    match mosaic_crypto::build_auth_challenge_transcript(&username, timestamp, &challenge) {
        Ok(bytes) => BytesResult {
            code: mosaic_client::ClientErrorCode::Ok.as_u16(),
            bytes,
        },
        Err(error) => BytesResult {
            code: map_crypto_error_uniffi(error),
            bytes: Vec::new(),
        },
    }
}

/// Signs LocalAuth challenge transcript bytes with a 32-byte auth signing
/// seed and returns a 64-byte detached Ed25519 signature.
///
/// Used by the cross-client `auth_challenge.json` corpus driver.
///
/// SECURITY: The caller-provided seed is wiped on the Rust side before
/// this function returns.
#[uniffi::export]
#[must_use]
pub fn sign_auth_challenge_with_raw_seed(
    transcript_bytes: Vec<u8>,
    auth_signing_seed: Vec<u8>,
) -> BytesResult {
    use zeroize::Zeroize;
    let mut seed_buf = auth_signing_seed;
    let secret = match mosaic_crypto::AuthSigningSecretKey::from_seed(seed_buf.as_mut_slice()) {
        Ok(value) => value,
        Err(error) => {
            seed_buf.zeroize();
            return BytesResult {
                code: map_crypto_error_uniffi(error),
                bytes: Vec::new(),
            };
        }
    };
    let signature = mosaic_crypto::sign_auth_challenge(&transcript_bytes, &secret);
    seed_buf.zeroize();
    BytesResult {
        code: mosaic_client::ClientErrorCode::Ok.as_u16(),
        bytes: signature.as_bytes().to_vec(),
    }
}

/// Verifies a LocalAuth challenge transcript signature against a 32-byte
/// public key.
///
/// On success returns `code = 0` and `valid = true`. Any verification
/// failure (wrong key, tampered transcript, tampered signature) returns
/// `code = 205` (`AuthenticationFailed`) and `valid = false`. Malformed
/// inputs return their length/shape error codes (211/212/201) with
/// `valid = false`.
#[uniffi::export]
#[must_use]
pub fn verify_auth_challenge_signature(
    transcript_bytes: Vec<u8>,
    signature: Vec<u8>,
    auth_public_key: Vec<u8>,
) -> AuthChallengeVerifyFfiResult {
    let signature_value = match mosaic_crypto::AuthSignature::from_bytes(&signature) {
        Ok(value) => value,
        Err(error) => {
            return AuthChallengeVerifyFfiResult {
                code: map_crypto_error_uniffi(error),
                valid: false,
            };
        }
    };
    let public_key = match mosaic_crypto::AuthSigningPublicKey::from_bytes(&auth_public_key) {
        Ok(value) => value,
        Err(error) => {
            return AuthChallengeVerifyFfiResult {
                code: map_crypto_error_uniffi(error),
                valid: false,
            };
        }
    };
    if mosaic_crypto::verify_auth_challenge(&transcript_bytes, &signature_value, &public_key) {
        AuthChallengeVerifyFfiResult {
            code: mosaic_client::ClientErrorCode::Ok.as_u16(),
            valid: true,
        }
    } else {
        AuthChallengeVerifyFfiResult {
            code: mosaic_client::ClientErrorCode::AuthenticationFailed.as_u16(),
            valid: false,
        }
    }
}

/// Verifies and opens a sealed epoch bundle using a caller-supplied raw
/// 32-byte recipient identity seed.
///
/// `expected_owner_pubkey` is the Ed25519 public key the caller expects to
/// match `sealed_bundle.sharer_pubkey`. `expected_album_id` and
/// `expected_min_epoch_id` enforce album/epoch policy. When
/// `allow_legacy_empty_album_id` is true the open succeeds even if the
/// embedded album_id is empty.
///
/// Used exclusively by the cross-client `sealed_bundle.json` corpus driver.
/// Production code should use the handle-based
/// `verify_and_open_bundle_with_identity_handle`.
///
/// SECURITY: `epoch_seed` in the result is secret-equivalent. Kotlin
/// callers MUST wipe the byte array after use. The recipient seed is wiped
/// on the Rust side before return. `sign_secret_seed` (the per-epoch
/// manifest signing secret carried by `mosaic_client::OpenedBundleResult`)
/// is intentionally NOT exposed across this FFI surface.
#[uniffi::export]
#[must_use]
#[allow(clippy::too_many_arguments)]
pub fn verify_and_open_bundle_with_recipient_seed(
    recipient_identity_seed: Vec<u8>,
    sealed: Vec<u8>,
    signature: Vec<u8>,
    sharer_pubkey: Vec<u8>,
    expected_owner_pubkey: Vec<u8>,
    expected_album_id: String,
    expected_min_epoch_id: u32,
    allow_legacy_empty_album_id: bool,
) -> OpenedBundleFfiResult {
    use zeroize::Zeroize;
    let empty_result = |code: u16| OpenedBundleFfiResult {
        code,
        version: 0,
        album_id: String::new(),
        epoch_id: 0,
        recipient_pubkey: Vec::new(),
        epoch_seed: Vec::new(),
        sign_public_key: Vec::new(),
    };

    let mut seed_buf = recipient_identity_seed;
    if seed_buf.len() != 32 {
        seed_buf.zeroize();
        return empty_result(mosaic_client::ClientErrorCode::InvalidKeyLength.as_u16());
    }
    if signature.len() != 64 {
        seed_buf.zeroize();
        return empty_result(mosaic_client::ClientErrorCode::InvalidSignatureLength.as_u16());
    }
    if sharer_pubkey.len() != 32 || expected_owner_pubkey.len() != 32 {
        seed_buf.zeroize();
        return empty_result(mosaic_client::ClientErrorCode::InvalidKeyLength.as_u16());
    }

    let mut keypair = match mosaic_crypto::derive_identity_keypair(seed_buf.as_mut_slice()) {
        Ok(value) => value,
        Err(error) => {
            seed_buf.zeroize();
            return empty_result(map_crypto_error_uniffi(error));
        }
    };

    let mut signature_array = [0_u8; 64];
    signature_array.copy_from_slice(&signature);
    let mut sharer_array = [0_u8; 32];
    sharer_array.copy_from_slice(&sharer_pubkey);
    let mut expected_owner_array = [0_u8; 32];
    expected_owner_array.copy_from_slice(&expected_owner_pubkey);

    let sealed_bundle = mosaic_crypto::SealedBundle {
        sealed,
        signature: signature_array,
        sharer_pubkey: sharer_array,
    };

    let context = mosaic_crypto::BundleValidationContext {
        album_id: expected_album_id,
        min_epoch_id: expected_min_epoch_id,
        allow_legacy_empty_album_id,
        expected_owner_ed25519_pub: expected_owner_array,
    };

    let outcome = mosaic_crypto::verify_and_open_bundle(&sealed_bundle, &keypair, &context);
    keypair.zeroize_secret();

    match outcome {
        Ok(bundle) => {
            let recipient_pubkey = bundle.recipient_pubkey.to_vec();
            let epoch_seed = bundle.epoch_seed.as_bytes().to_vec();
            let sign_public_key = bundle.sign_public_key.as_bytes().to_vec();
            OpenedBundleFfiResult {
                code: mosaic_client::ClientErrorCode::Ok.as_u16(),
                version: bundle.version,
                album_id: bundle.album_id,
                epoch_id: bundle.epoch_id,
                recipient_pubkey,
                epoch_seed,
                sign_public_key,
            }
        }
        Err(error) => empty_result(map_crypto_error_uniffi(error)),
    }
}

/// Decrypts album content with a caller-supplied raw 32-byte content key
/// and 24-byte XChaCha20 nonce.
///
/// Used exclusively by the cross-client `content_encrypt.json` corpus
/// driver. Production code should use the handle-based
/// `decrypt_album_content_with_epoch_handle`.
///
/// SECURITY: The caller-provided content key is wiped on the Rust side
/// before this function returns. `plaintext` in the result is
/// secret-equivalent — Kotlin callers MUST wipe the byte array after use.
#[uniffi::export]
#[must_use]
pub fn decrypt_content_with_raw_key(
    content_key: Vec<u8>,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
    epoch_id: u32,
) -> ContentDecryptFfiResult {
    use zeroize::Zeroize;
    if nonce.len() != 24 {
        let mut key_buf = content_key;
        key_buf.zeroize();
        return ContentDecryptFfiResult {
            code: mosaic_client::ClientErrorCode::InvalidInputLength.as_u16(),
            plaintext: Vec::new(),
        };
    }
    let mut key_buf = Zeroizing::new(content_key);
    let content_key_value = match mosaic_crypto::SecretKey::from_bytes(key_buf.as_mut_slice()) {
        Ok(value) => value,
        Err(error) => {
            return ContentDecryptFfiResult {
                code: map_crypto_error_uniffi(error),
                plaintext: Vec::new(),
            };
        }
    };
    let mut nonce_array = [0_u8; 24];
    nonce_array.copy_from_slice(&nonce);
    match mosaic_crypto::decrypt_content(&ciphertext, &nonce_array, &content_key_value, epoch_id) {
        Ok(plaintext) => ContentDecryptFfiResult {
            code: mosaic_client::ClientErrorCode::Ok.as_u16(),
            plaintext: plaintext.to_vec(),
        },
        Err(error) => ContentDecryptFfiResult {
            code: map_crypto_error_uniffi(error),
            plaintext: Vec::new(),
        },
    }
}

// =============================================================================
// Phase 1 download orchestrator UniFFI bindings.
//
// These bindings expose the same `mosaic_client::download` orchestrator that
// `mosaic-wasm` exposes to the web worker, but adapted to UniFFI's typed
// `Record` style. The CBOR byte format used for `plan_cbor`, `state_cbor`,
// `event_cbor`, and snapshot bytes is byte-identical to the WASM facade so a
// future native iOS/Android app drives the SAME canonical wire format the web
// already drives. The duplicated CBOR helpers are kept source-equivalent with
// the WASM helpers via `tests/parser_equivalence.rs`.
// =============================================================================

/// UniFFI record describing a single shard input to the download plan builder.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct DownloadPlanShardInput {
    pub shard_id: Vec<u8>,
    pub epoch_id: u32,
    pub tier: u8,
    pub expected_hash: Vec<u8>,
    pub declared_size: u64,
}

/// UniFFI record describing one photo + its shards as input to the plan builder.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct DownloadPlanEntryInput {
    pub photo_id: String,
    pub filename: String,
    pub shards: Vec<DownloadPlanShardInput>,
}

/// UniFFI record for `build_download_plan` input.
///
/// `album_id` is carried for symmetry with `init_download_job` but is not
/// validated here — the orchestrator binds the album id at snapshot init.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct DownloadPlanInput {
    pub album_id: Vec<u8>,
    pub entries: Vec<DownloadPlanEntryInput>,
}

/// UniFFI record for canonical download plan construction results.
///
/// `plan_cbor` is opaque to consumers and stable across UniFFI/WASM. On error
/// it is empty and `error_detail` carries a privacy-safe diagnostic string
/// (no shard bytes; photo ids are project-internal opaque strings).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct DownloadPlanResult {
    pub code: u16,
    pub plan_cbor: Vec<u8>,
    pub error_detail: Option<String>,
}

/// UniFFI record for `init_download_job` input.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct DownloadInitInput {
    pub job_id: Vec<u8>,
    pub album_id: Vec<u8>,
    pub plan_cbor: Vec<u8>,
    pub now_ms: u64,
}

/// UniFFI record carrying canonical snapshot body bytes plus a BLAKE2b-256
/// checksum over those bytes.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SnapshotBytesResult {
    pub code: u16,
    pub body: Vec<u8>,
    pub checksum: Vec<u8>,
}

/// UniFFI record for `apply_download_event` results.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ApplyEventResult {
    pub code: u16,
    pub new_state_cbor: Vec<u8>,
}

/// UniFFI record for `load_download_snapshot` results.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct LoadSnapshotResult {
    pub code: u16,
    pub snapshot_cbor: Vec<u8>,
    pub schema_version_loaded: u32,
}

/// UniFFI record for constant-time `verify_download_snapshot` results.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct VerifySnapshotResult {
    pub code: u16,
    pub valid: bool,
}

/// Builds a canonical download plan from a typed UniFFI input record.
///
/// Returns the same canonical CBOR bytes a future native app would obtain by
/// driving `mosaic_wasm::download_build_plan_v1` via `wasm-bindgen` from JS.
/// The Rust orchestrator (`mosaic_client::download::plan::DownloadPlanBuilder`)
/// is the authoritative source of truth for both wrappers.
#[uniffi::export]
#[must_use]
pub fn build_download_plan(input: DownloadPlanInput) -> DownloadPlanResult {
    let _ = input.album_id;
    let mut builder = mosaic_client::download::plan::DownloadPlanBuilder::new();
    for entry in input.entries {
        let mut shards = Vec::with_capacity(entry.shards.len());
        for shard in entry.shards {
            let shard_id = match <[u8; 16]>::try_from(shard.shard_id.as_slice()) {
                Ok(value) => value,
                Err(_) => {
                    return build_download_plan_error(
                        mosaic_client::ClientErrorCode::InvalidInputLength,
                        Some("shard_id must be 16 bytes".to_owned()),
                    );
                }
            };
            let expected_hash = match <[u8; 32]>::try_from(shard.expected_hash.as_slice()) {
                Ok(value) => value,
                Err(_) => {
                    return build_download_plan_error(
                        mosaic_client::ClientErrorCode::InvalidInputLength,
                        Some("expected_hash must be 32 bytes".to_owned()),
                    );
                }
            };
            let tier = match ShardTier::try_from(shard.tier) {
                Ok(value) => value,
                Err(_) => {
                    return build_download_plan_error(
                        mosaic_client::ClientErrorCode::DownloadInvalidPlan,
                        Some(format!("unknown tier {}", shard.tier)),
                    );
                }
            };
            shards.push(mosaic_client::download::plan::DownloadShardInput {
                shard_id: mosaic_client::download::plan::ShardId::from_bytes(shard_id),
                epoch_id: shard.epoch_id,
                tier,
                expected_hash,
                declared_size: shard.declared_size,
            });
        }
        builder = builder.with_photo(mosaic_client::download::plan::DownloadPlanInput {
            photo_id: mosaic_client::download::plan::PhotoId::new(entry.photo_id),
            filename: entry.filename,
            shards,
        });
    }
    match builder.build() {
        Ok(plan) => match download_plan_to_cbor(&plan) {
            Ok(plan_cbor) => DownloadPlanResult {
                code: mosaic_client::ClientErrorCode::Ok.as_u16(),
                plan_cbor,
                error_detail: None,
            },
            Err(code) => build_download_plan_error(code, None),
        },
        Err(error) => build_download_plan_error(
            mosaic_client::ClientErrorCode::DownloadInvalidPlan,
            Some(download_plan_error_detail(&error)),
        ),
    }
}

/// Initializes a fresh canonical download job snapshot.
///
/// The returned `body` and `checksum` are byte-identical to the bytes a
/// future native consumer would obtain by driving `download_init_snapshot_v1`
/// from the WASM facade with the same inputs.
#[uniffi::export]
#[must_use]
pub fn init_download_job(input: DownloadInitInput) -> SnapshotBytesResult {
    let job_id = match <[u8; 16]>::try_from(input.job_id.as_slice()) {
        Ok(value) => value,
        Err(_) => {
            return snapshot_bytes_error(mosaic_client::ClientErrorCode::InvalidInputLength);
        }
    };
    let album_id = match <[u8; 16]>::try_from(input.album_id.as_slice()) {
        Ok(value) => value,
        Err(_) => {
            return snapshot_bytes_error(mosaic_client::ClientErrorCode::InvalidInputLength);
        }
    };
    let plan = match download_plan_from_cbor(&input.plan_cbor) {
        Ok(value) => value,
        Err(code) => return snapshot_bytes_error(code),
    };
    let photos = plan
        .entries
        .iter()
        .map(|entry| mosaic_client::download::snapshot::PhotoState {
            photo_id: entry.photo_id.clone(),
            status: mosaic_client::download::state::PhotoStatus::Pending,
            bytes_written: 0,
            last_attempt_at_ms: None,
            retry_count: 0,
        })
        .collect();
    let snapshot = mosaic_client::download::snapshot::DownloadJobSnapshot {
        schema_version: mosaic_client::download::snapshot::CURRENT_DOWNLOAD_SNAPSHOT_SCHEMA_VERSION,
        job_id: mosaic_client::download::snapshot::JobId::from_bytes(job_id),
        album_id: mosaic_client::Uuid::from_bytes(album_id),
        created_at_ms: input.now_ms,
        last_updated_at_ms: input.now_ms,
        state: mosaic_client::download::state::DownloadJobState::Idle,
        plan,
        photos,
        failure_log: Vec::new(),
        lease_token: None,
    };
    match mosaic_client::download::snapshot::prepare_snapshot_bytes(&snapshot) {
        Ok(bytes) => SnapshotBytesResult {
            code: mosaic_client::ClientErrorCode::Ok.as_u16(),
            body: bytes.body,
            checksum: bytes.checksum.to_vec(),
        },
        Err(error) => snapshot_bytes_error(download_snapshot_error_code(&error)),
    }
}

/// Applies a download state-machine event to a CBOR-encoded state.
#[uniffi::export]
#[must_use]
pub fn apply_download_event(state_cbor: Vec<u8>, event_cbor: Vec<u8>) -> ApplyEventResult {
    let state = match download_state_from_cbor(&state_cbor) {
        Ok(value) => value,
        Err(code) => return apply_event_error(code),
    };
    let event = match download_event_from_cbor(&event_cbor) {
        Ok(value) => value,
        Err(code) => return apply_event_error(code),
    };
    match mosaic_client::download::state::apply(&state, &event) {
        Ok(new_state) => match download_state_to_cbor(&new_state) {
            Ok(new_state_cbor) => ApplyEventResult {
                code: mosaic_client::ClientErrorCode::Ok.as_u16(),
                new_state_cbor,
            },
            Err(code) => apply_event_error(code),
        },
        Err(_) => apply_event_error(mosaic_client::ClientErrorCode::DownloadIllegalTransition),
    }
}

/// Validates a persisted snapshot body against its expected checksum and
/// returns the canonicalized snapshot CBOR plus its loaded schema version.
#[uniffi::export]
#[must_use]
pub fn load_download_snapshot(snapshot_cbor: Vec<u8>, checksum: Vec<u8>) -> LoadSnapshotResult {
    let expected = match checksum_32(&checksum) {
        Ok(value) => value,
        Err(code) => return load_snapshot_error(code),
    };
    let actual = match download_checksum_body(&snapshot_cbor) {
        Ok(value) => value,
        Err(code) => return load_snapshot_error(code),
    };
    if !checksum_matches(&actual, &expected) {
        return load_snapshot_error(
            mosaic_client::ClientErrorCode::DownloadSnapshotChecksumMismatch,
        );
    }
    match mosaic_client::download::snapshot::DownloadJobSnapshot::from_canonical_cbor(
        &snapshot_cbor,
    ) {
        Ok(snapshot) => match snapshot.to_canonical_cbor() {
            Ok(canonical) => LoadSnapshotResult {
                code: mosaic_client::ClientErrorCode::Ok.as_u16(),
                snapshot_cbor: canonical,
                schema_version_loaded: snapshot.schema_version,
            },
            Err(error) => load_snapshot_error(download_snapshot_error_code(&error)),
        },
        Err(error) => load_snapshot_error(download_snapshot_error_code(&error)),
    }
}

/// Computes the canonical BLAKE2b-256 checksum for a download snapshot body.
///
/// The returned `body` is the canonically re-encoded snapshot CBOR; the
/// `checksum` is the BLAKE2b-256 of that body. Callers can persist `body`
/// plus `checksum` directly.
#[uniffi::export]
#[must_use]
pub fn commit_download_snapshot(snapshot_cbor: Vec<u8>) -> SnapshotBytesResult {
    match mosaic_client::download::snapshot::DownloadJobSnapshot::from_canonical_cbor(
        &snapshot_cbor,
    )
    .and_then(|snapshot| mosaic_client::download::snapshot::prepare_snapshot_bytes(&snapshot))
    {
        Ok(bytes) => SnapshotBytesResult {
            code: mosaic_client::ClientErrorCode::Ok.as_u16(),
            body: bytes.body,
            checksum: bytes.checksum.to_vec(),
        },
        Err(error) => snapshot_bytes_error(download_snapshot_error_code(&error)),
    }
}

/// Verifies a download snapshot body checksum without branching on the bytes.
#[uniffi::export]
#[must_use]
pub fn verify_download_snapshot(
    snapshot_cbor: Vec<u8>,
    checksum: Vec<u8>,
) -> VerifySnapshotResult {
    let actual = match download_checksum_body(&snapshot_cbor) {
        Ok(value) => value,
        Err(code) => return verify_snapshot_error(code),
    };
    let expected = checksum_32_padded(&checksum);
    let valid = checksum.len() == 32 && checksum_matches(&actual, &expected);
    VerifySnapshotResult {
        code: mosaic_client::ClientErrorCode::Ok.as_u16(),
        valid,
    }
}

// ---- internal helpers (kept source-equivalent with mosaic-wasm) -------------

fn build_download_plan_error(
    code: mosaic_client::ClientErrorCode,
    error_detail: Option<String>,
) -> DownloadPlanResult {
    DownloadPlanResult {
        code: code.as_u16(),
        plan_cbor: Vec::new(),
        error_detail,
    }
}

fn snapshot_bytes_error(code: mosaic_client::ClientErrorCode) -> SnapshotBytesResult {
    SnapshotBytesResult {
        code: code.as_u16(),
        body: Vec::new(),
        checksum: Vec::new(),
    }
}

fn apply_event_error(code: mosaic_client::ClientErrorCode) -> ApplyEventResult {
    ApplyEventResult {
        code: code.as_u16(),
        new_state_cbor: Vec::new(),
    }
}

fn load_snapshot_error(code: mosaic_client::ClientErrorCode) -> LoadSnapshotResult {
    LoadSnapshotResult {
        code: code.as_u16(),
        snapshot_cbor: Vec::new(),
        schema_version_loaded: 0,
    }
}

fn verify_snapshot_error(code: mosaic_client::ClientErrorCode) -> VerifySnapshotResult {
    VerifySnapshotResult {
        code: code.as_u16(),
        valid: false,
    }
}

fn cbor_value(bytes: &[u8]) -> Result<Value, mosaic_client::ClientErrorCode> {
    ciborium::de::from_reader(Cursor::new(bytes))
        .map_err(|_| mosaic_client::ClientErrorCode::DownloadSnapshotCorrupt)
}

fn cbor_bytes(value: &Value) -> Result<Vec<u8>, mosaic_client::ClientErrorCode> {
    let mut out = Vec::new();
    ciborium::ser::into_writer(value, &mut out)
        .map_err(|_| mosaic_client::ClientErrorCode::DownloadSnapshotCorrupt)?;
    Ok(out)
}

fn download_state_from_cbor(
    bytes: &[u8],
) -> Result<mosaic_client::download::state::DownloadJobState, mosaic_client::ClientErrorCode> {
    decode_download_state(&cbor_value(bytes)?)
}

fn download_state_to_cbor(
    state: &mosaic_client::download::state::DownloadJobState,
) -> Result<Vec<u8>, mosaic_client::ClientErrorCode> {
    cbor_bytes(&download_state_value(state))
}

fn download_event_from_cbor(
    bytes: &[u8],
) -> Result<mosaic_client::download::state::DownloadJobEvent, mosaic_client::ClientErrorCode> {
    decode_download_event(&cbor_value(bytes)?)
}

fn download_plan_to_cbor(
    plan: &mosaic_client::download::plan::DownloadPlan,
) -> Result<Vec<u8>, mosaic_client::ClientErrorCode> {
    cbor_bytes(&download_plan_value(plan))
}

fn download_plan_from_cbor(
    bytes: &[u8],
) -> Result<mosaic_client::download::plan::DownloadPlan, mosaic_client::ClientErrorCode> {
    decode_download_plan(&cbor_value(bytes)?)
}

fn download_state_value(state: &mosaic_client::download::state::DownloadJobState) -> Value {
    match state {
        mosaic_client::download::state::DownloadJobState::Errored { reason } => Value::Map(vec![
            cbor_kv(0, cbor_uint(u64::from(state.to_u8()))),
            cbor_kv(1, download_error_value(*reason)),
        ]),
        mosaic_client::download::state::DownloadJobState::Cancelled { soft } => Value::Map(vec![
            cbor_kv(0, cbor_uint(u64::from(state.to_u8()))),
            cbor_kv(2, Value::Bool(*soft)),
        ]),
        _ => Value::Map(vec![cbor_kv(0, cbor_uint(u64::from(state.to_u8())))]),
    }
}

fn decode_download_state(
    value: &Value,
) -> Result<mosaic_client::download::state::DownloadJobState, mosaic_client::ClientErrorCode> {
    use mosaic_client::download::snapshot::download_job_state_codes as codes;
    let entries = map_entries(value)?;
    let code = u8_from_value(required_entry(entries, 0)?)?;
    match code {
        codes::IDLE => Ok(mosaic_client::download::state::DownloadJobState::Idle),
        codes::PREPARING => Ok(mosaic_client::download::state::DownloadJobState::Preparing),
        codes::RUNNING => Ok(mosaic_client::download::state::DownloadJobState::Running),
        codes::PAUSED => Ok(mosaic_client::download::state::DownloadJobState::Paused),
        codes::FINALIZING => Ok(mosaic_client::download::state::DownloadJobState::Finalizing),
        codes::DONE => Ok(mosaic_client::download::state::DownloadJobState::Done),
        codes::ERRORED => Ok(mosaic_client::download::state::DownloadJobState::Errored {
            reason: decode_download_error(required_entry(entries, 1)?)?,
        }),
        codes::CANCELLED => Ok(
            mosaic_client::download::state::DownloadJobState::Cancelled {
                soft: bool_from_value(required_entry(entries, 2)?)?,
            },
        ),
        _ => Err(mosaic_client::ClientErrorCode::DownloadSnapshotCorrupt),
    }
}

fn decode_download_event(
    value: &Value,
) -> Result<mosaic_client::download::state::DownloadJobEvent, mosaic_client::ClientErrorCode> {
    let entries = map_entries(value)?;
    let kind = u8_from_value(required_entry(entries, 0)?)?;
    match kind {
        0 => Ok(
            mosaic_client::download::state::DownloadJobEvent::StartRequested {
                job_id: mosaic_client::download::snapshot::JobId::from_bytes(bytes_16_from_value(
                    required_entry(entries, 1)?,
                )?),
                album_id: uuid_from_cbor_value(required_entry(entries, 2)?)?,
            },
        ),
        1 => Ok(mosaic_client::download::state::DownloadJobEvent::PlanReady),
        2 => Ok(mosaic_client::download::state::DownloadJobEvent::PauseRequested),
        3 => Ok(mosaic_client::download::state::DownloadJobEvent::ResumeRequested),
        4 => Ok(
            mosaic_client::download::state::DownloadJobEvent::CancelRequested {
                soft: bool_from_value(required_entry(entries, 3)?)?,
            },
        ),
        5 => Ok(
            mosaic_client::download::state::DownloadJobEvent::ErrorEncountered {
                reason: decode_download_error(required_entry(entries, 4)?)?,
            },
        ),
        6 => Ok(mosaic_client::download::state::DownloadJobEvent::AllPhotosDone),
        7 => Ok(mosaic_client::download::state::DownloadJobEvent::FinalizationDone),
        _ => Err(mosaic_client::ClientErrorCode::DownloadIllegalTransition),
    }
}

fn download_plan_value(plan: &mosaic_client::download::plan::DownloadPlan) -> Value {
    Value::Array(plan.entries.iter().map(download_plan_entry_value).collect())
}

fn download_plan_entry_value(entry: &mosaic_client::download::plan::DownloadPlanEntry) -> Value {
    Value::Map(vec![
        cbor_kv(0, Value::Text(entry.photo_id.as_str().to_owned())),
        cbor_kv(1, cbor_uint(u64::from(entry.epoch_id))),
        cbor_kv(2, cbor_uint(u64::from(entry.tier.to_byte()))),
        cbor_kv(
            3,
            Value::Array(
                entry
                    .shard_ids
                    .iter()
                    .map(|id| Value::Bytes(id.as_bytes().to_vec()))
                    .collect(),
            ),
        ),
        cbor_kv(
            4,
            Value::Array(
                entry
                    .expected_hashes
                    .iter()
                    .map(|hash| Value::Bytes(hash.to_vec()))
                    .collect(),
            ),
        ),
        cbor_kv(5, Value::Text(entry.filename.clone())),
        cbor_kv(6, cbor_uint(entry.total_bytes)),
    ])
}

fn decode_download_plan(
    value: &Value,
) -> Result<mosaic_client::download::plan::DownloadPlan, mosaic_client::ClientErrorCode> {
    let items = array_items(value)?;
    let mut entries = Vec::with_capacity(items.len());
    for item in items {
        let fields = map_entries(item)?;
        let tier = shard_tier_from_value(required_entry(fields, 2)?)?;
        let shard_ids = array_items(required_entry(fields, 3)?)?
            .iter()
            .map(|value| {
                bytes_16_from_value(value).map(mosaic_client::download::plan::ShardId::from_bytes)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let expected_hashes = array_items(required_entry(fields, 4)?)?
            .iter()
            .map(bytes_32_from_value)
            .collect::<Result<Vec<_>, _>>()?;
        if shard_ids.is_empty() || shard_ids.len() != expected_hashes.len() {
            return Err(mosaic_client::ClientErrorCode::DownloadInvalidPlan);
        }
        entries.push(mosaic_client::download::plan::DownloadPlanEntry {
            photo_id: mosaic_client::download::plan::PhotoId::new(text_from_value(
                required_entry(fields, 0)?,
            )?),
            epoch_id: u32_from_value(required_entry(fields, 1)?)?,
            tier,
            shard_ids,
            expected_hashes,
            filename: text_from_value(required_entry(fields, 5)?)?,
            total_bytes: u64_from_value(required_entry(fields, 6)?)?,
        });
    }
    Ok(mosaic_client::download::plan::DownloadPlan { entries })
}

fn download_plan_error_detail(error: &mosaic_client::download::plan::DownloadPlanError) -> String {
    match error {
        mosaic_client::download::plan::DownloadPlanError::DisallowedTier { photo_id, tier } => {
            format!("DisallowedTier:photoId={photo_id},tier={}", tier.to_byte())
        }
        mosaic_client::download::plan::DownloadPlanError::MultiEpochPhoto { photo_id, epochs } => {
            let epochs = epochs
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(",");
            format!("MultiEpochPhoto:photoId={photo_id},epochs=[{epochs}]")
        }
        mosaic_client::download::plan::DownloadPlanError::PhotoHasNoShards { photo_id } => {
            format!("PhotoHasNoShards:photoId={photo_id}")
        }
        mosaic_client::download::plan::DownloadPlanError::SizeOverflow { photo_id } => {
            format!("SizeOverflow:photoId={photo_id}")
        }
    }
}

fn download_snapshot_error_code(
    error: &mosaic_client::download::snapshot::DownloadSnapshotError,
) -> mosaic_client::ClientErrorCode {
    match error {
        mosaic_client::download::snapshot::DownloadSnapshotError::ChecksumMismatch => {
            mosaic_client::ClientErrorCode::DownloadSnapshotChecksumMismatch
        }
        mosaic_client::download::snapshot::DownloadSnapshotError::SchemaTooNew { .. } => {
            mosaic_client::ClientErrorCode::DownloadSnapshotMigration
        }
        mosaic_client::download::snapshot::DownloadSnapshotError::Torn { .. } => {
            mosaic_client::ClientErrorCode::DownloadSnapshotTorn
        }
        mosaic_client::download::snapshot::DownloadSnapshotError::CborDecodeFailed
        | mosaic_client::download::snapshot::DownloadSnapshotError::SchemaVersionMissing
        | mosaic_client::download::snapshot::DownloadSnapshotError::SchemaCorrupt
        | mosaic_client::download::snapshot::DownloadSnapshotError::ForbiddenField => {
            mosaic_client::ClientErrorCode::DownloadSnapshotCorrupt
        }
    }
}

fn download_checksum_body(body: &[u8]) -> Result<[u8; 32], mosaic_client::ClientErrorCode> {
    let mut hasher =
        Blake2bVar::new(32).map_err(|_| mosaic_client::ClientErrorCode::DownloadSnapshotCorrupt)?;
    hasher.update(body);
    let mut out = [0_u8; 32];
    hasher
        .finalize_variable(&mut out)
        .map_err(|_| mosaic_client::ClientErrorCode::DownloadSnapshotCorrupt)?;
    Ok(out)
}

fn checksum_32(bytes: &[u8]) -> Result<[u8; 32], mosaic_client::ClientErrorCode> {
    if bytes.len() != 32 {
        return Err(mosaic_client::ClientErrorCode::DownloadSnapshotCorrupt);
    }
    Ok(checksum_32_padded(bytes))
}

fn checksum_32_padded(bytes: &[u8]) -> [u8; 32] {
    let mut out = [0_u8; 32];
    let mut index = 0_usize;
    while index < out.len() {
        if let Some(value) = bytes.get(index) {
            out[index] = *value;
        }
        index += 1;
    }
    out
}

fn checksum_matches(actual: &[u8; 32], expected: &[u8; 32]) -> bool {
    let mut diff = 0_u8;
    let mut index = 0_usize;
    while index < actual.len() {
        diff |= actual[index] ^ expected[index];
        index += 1;
    }
    diff == 0
}

fn map_entries(value: &Value) -> Result<&[(Value, Value)], mosaic_client::ClientErrorCode> {
    match value {
        Value::Map(entries) => Ok(entries.as_slice()),
        _ => Err(mosaic_client::ClientErrorCode::DownloadSnapshotCorrupt),
    }
}

fn array_items(value: &Value) -> Result<&[Value], mosaic_client::ClientErrorCode> {
    match value {
        Value::Array(items) => Ok(items.as_slice()),
        _ => Err(mosaic_client::ClientErrorCode::DownloadSnapshotCorrupt),
    }
}

fn required_entry(
    entries: &[(Value, Value)],
    key: u32,
) -> Result<&Value, mosaic_client::ClientErrorCode> {
    entries
        .iter()
        .find_map(|(candidate, value)| {
            match candidate
                .as_integer()
                .and_then(|integer| u32::try_from(integer).ok())
            {
                Some(found) if found == key => Some(value),
                _ => None,
            }
        })
        .ok_or(mosaic_client::ClientErrorCode::DownloadSnapshotCorrupt)
}

fn cbor_kv(key: u32, value: Value) -> (Value, Value) {
    (Value::Integer(Integer::from(key)), value)
}

fn cbor_uint(value: u64) -> Value {
    Value::Integer(Integer::from(value))
}

fn u8_from_value(value: &Value) -> Result<u8, mosaic_client::ClientErrorCode> {
    value
        .as_integer()
        .and_then(|integer| u8::try_from(integer).ok())
        .ok_or(mosaic_client::ClientErrorCode::DownloadSnapshotCorrupt)
}

fn u32_from_value(value: &Value) -> Result<u32, mosaic_client::ClientErrorCode> {
    value
        .as_integer()
        .and_then(|integer| u32::try_from(integer).ok())
        .ok_or(mosaic_client::ClientErrorCode::DownloadSnapshotCorrupt)
}

fn u64_from_value(value: &Value) -> Result<u64, mosaic_client::ClientErrorCode> {
    value
        .as_integer()
        .and_then(|integer| u64::try_from(integer).ok())
        .ok_or(mosaic_client::ClientErrorCode::DownloadSnapshotCorrupt)
}

fn bool_from_value(value: &Value) -> Result<bool, mosaic_client::ClientErrorCode> {
    match value {
        Value::Bool(value) => Ok(*value),
        _ => Err(mosaic_client::ClientErrorCode::DownloadSnapshotCorrupt),
    }
}

fn text_from_value(value: &Value) -> Result<String, mosaic_client::ClientErrorCode> {
    match value {
        Value::Text(value) => Ok(value.clone()),
        _ => Err(mosaic_client::ClientErrorCode::DownloadSnapshotCorrupt),
    }
}

fn bytes_from_value(value: &Value) -> Result<Vec<u8>, mosaic_client::ClientErrorCode> {
    match value {
        Value::Bytes(value) => Ok(value.clone()),
        _ => Err(mosaic_client::ClientErrorCode::DownloadSnapshotCorrupt),
    }
}

fn bytes_16_from_value(value: &Value) -> Result<[u8; 16], mosaic_client::ClientErrorCode> {
    bytes_from_value(value)?
        .as_slice()
        .try_into()
        .map_err(|_| mosaic_client::ClientErrorCode::DownloadSnapshotCorrupt)
}

fn bytes_32_from_value(value: &Value) -> Result<[u8; 32], mosaic_client::ClientErrorCode> {
    bytes_from_value(value)?
        .as_slice()
        .try_into()
        .map_err(|_| mosaic_client::ClientErrorCode::DownloadSnapshotCorrupt)
}

fn uuid_from_cbor_value(
    value: &Value,
) -> Result<mosaic_client::Uuid, mosaic_client::ClientErrorCode> {
    match value {
        Value::Bytes(_) => Ok(mosaic_client::Uuid::from_bytes(bytes_16_from_value(value)?)),
        Value::Text(text) => uuid_from_string(text)
            .map_err(|_| mosaic_client::ClientErrorCode::DownloadSnapshotCorrupt),
        _ => Err(mosaic_client::ClientErrorCode::DownloadSnapshotCorrupt),
    }
}

fn shard_tier_from_value(value: &Value) -> Result<ShardTier, mosaic_client::ClientErrorCode> {
    ShardTier::try_from(u8_from_value(value)?)
        .map_err(|_| mosaic_client::ClientErrorCode::DownloadInvalidPlan)
}

fn download_error_value(error: mosaic_client::download::error::DownloadErrorCode) -> Value {
    cbor_uint(u64::from(match error {
        mosaic_client::download::error::DownloadErrorCode::TransientNetwork => 0_u8,
        mosaic_client::download::error::DownloadErrorCode::Integrity => 1,
        mosaic_client::download::error::DownloadErrorCode::Decrypt => 2,
        mosaic_client::download::error::DownloadErrorCode::NotFound => 3,
        mosaic_client::download::error::DownloadErrorCode::AccessRevoked => 4,
        mosaic_client::download::error::DownloadErrorCode::AuthorizationChanged => 5,
        mosaic_client::download::error::DownloadErrorCode::Quota => 6,
        mosaic_client::download::error::DownloadErrorCode::Cancelled => 7,
        mosaic_client::download::error::DownloadErrorCode::IllegalState => 8,
    }))
}

fn decode_download_error(
    value: &Value,
) -> Result<mosaic_client::download::error::DownloadErrorCode, mosaic_client::ClientErrorCode> {
    match u8_from_value(value)? {
        0 => Ok(mosaic_client::download::error::DownloadErrorCode::TransientNetwork),
        1 => Ok(mosaic_client::download::error::DownloadErrorCode::Integrity),
        2 => Ok(mosaic_client::download::error::DownloadErrorCode::Decrypt),
        3 => Ok(mosaic_client::download::error::DownloadErrorCode::NotFound),
        4 => Ok(mosaic_client::download::error::DownloadErrorCode::AccessRevoked),
        5 => Ok(mosaic_client::download::error::DownloadErrorCode::AuthorizationChanged),
        6 => Ok(mosaic_client::download::error::DownloadErrorCode::Quota),
        7 => Ok(mosaic_client::download::error::DownloadErrorCode::Cancelled),
        8 => Ok(mosaic_client::download::error::DownloadErrorCode::IllegalState),
        _ => Err(mosaic_client::ClientErrorCode::DownloadSnapshotCorrupt),
    }
}

uniffi::setup_scaffolding!();

#[cfg(test)]
mod tests {
    #[test]
    fn uses_client_protocol_version() {
        assert_eq!(super::protocol_version(), "mosaic-v1");
    }

    #[test]
    fn debug_output_redacts_boundary_byte_payloads() {
        assert_debug_redacts(
            &super::BytesResult {
                code: 0,
                bytes: vec![231, 232, 233],
            },
            &["bytes_len: 3"],
            &["231", "232", "233", "bytes: ["],
        );

        assert_debug_redacts(
            &super::AccountUnlockRequest {
                user_salt: vec![201; 16],
                account_salt: vec![202; 16],
                wrapped_account_key: vec![203, 204, 205],
                kdf_memory_kib: 65_536,
                kdf_iterations: 3,
                kdf_parallelism: 1,
            },
            &[
                "user_salt_len: 16",
                "account_salt_len: 16",
                "wrapped_account_key_len: 3",
            ],
            &["201", "202", "203", "wrapped_account_key: ["],
        );

        assert_debug_redacts(
            &super::IdentityHandleResult {
                code: 0,
                handle: 7,
                signing_pubkey: vec![211; 32],
                encryption_pubkey: vec![212; 32],
                wrapped_seed: vec![213, 214, 215],
            },
            &[
                "signing_pubkey_len: 32",
                "encryption_pubkey_len: 32",
                "wrapped_seed_len: 3",
            ],
            &["211", "212", "213", "wrapped_seed: ["],
        );

        assert_debug_redacts(
            &super::EpochKeyHandleResult {
                code: 0,
                handle: 11,
                epoch_id: 42,
                wrapped_epoch_seed: vec![221, 222, 223],
                sign_public_key: vec![224; 32],
            },
            &["wrapped_epoch_seed_len: 3", "sign_public_key_len: 32"],
            &["221", "222", "223", "224", "wrapped_epoch_seed: ["],
        );

        assert_debug_redacts(
            &super::EncryptedShardResult {
                code: 0,
                envelope_bytes: vec![224, 225, 226],
                sha256: "digest".to_owned(),
            },
            &["envelope_bytes_len: 3", "sha256: \"digest\""],
            &["224", "225", "226", "envelope_bytes: ["],
        );
    }

    fn assert_debug_redacts<T: std::fmt::Debug>(
        value: &T,
        expected_fragments: &[&str],
        forbidden_fragments: &[&str],
    ) {
        let debug = format!("{value:?}");
        for fragment in expected_fragments {
            assert!(
                debug.contains(fragment),
                "expected debug output to contain {fragment:?}: {debug}"
            );
        }
        for fragment in forbidden_fragments {
            assert!(
                !debug.contains(fragment),
                "debug output leaked {fragment:?}: {debug}"
            );
        }
    }
}
