//! WASM facade boundary crate for the Mosaic web worker integration.

#![forbid(unsafe_code)]

use std::{fmt, sync::Mutex};

use self_cell::self_cell;
use wasm_bindgen::prelude::{JsError, JsValue, wasm_bindgen};
use zeroize::Zeroizing;

use mosaic_domain::{
    MetadataSidecar, MetadataSidecarError, MetadataSidecarField, ShardTier as DomainShardTier,
};

type CryptoStreamingEncryptor<'a> = mosaic_crypto::StreamingEncryptor<'a>;
type CryptoStreamingDecryptor<'a> = mosaic_crypto::StreamingDecryptor<'a>;

struct CryptoStreamingEncryptorState<'a>(Option<CryptoStreamingEncryptor<'a>>);
struct CryptoStreamingDecryptorState<'a>(Option<CryptoStreamingDecryptor<'a>>);

self_cell!(
    struct StreamingEncryptorCell {
        owner: mosaic_crypto::EpochKeyMaterial,

        #[not_covariant]
        dependent: CryptoStreamingEncryptorState,
    }
);

self_cell!(
    struct StreamingDecryptorCell {
        owner: mosaic_crypto::EpochKeyMaterial,

        #[not_covariant]
        dependent: CryptoStreamingDecryptorState,
    }
);

/// WASM-visible shard tiers pinned to the Mosaic envelope wire protocol.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShardTier {
    Thumbnail = 1,
    Preview = 2,
    Original = 3,
}

impl From<ShardTier> for DomainShardTier {
    fn from(tier: ShardTier) -> Self {
        match tier {
            ShardTier::Thumbnail => Self::Thumbnail,
            ShardTier::Preview => Self::Preview,
            ShardTier::Original => Self::Original,
        }
    }
}

/// Rust-side WASM facade result for header parsing.
#[derive(Clone, PartialEq, Eq)]
pub struct HeaderResult {
    pub code: u16,
    pub epoch_id: u32,
    pub shard_index: u32,
    pub tier: u8,
    pub nonce: Vec<u8>,
}

impl fmt::Debug for HeaderResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HeaderResult")
            .field("code", &self.code)
            .field("epoch_id", &self.epoch_id)
            .field("shard_index", &self.shard_index)
            .field("tier", &self.tier)
            .field("nonce_len", &self.nonce.len())
            .finish()
    }
}

/// Rust-side WASM facade progress event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgressEvent {
    pub completed_steps: u32,
    pub total_steps: u32,
}

/// Rust-side WASM facade progress result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgressResult {
    pub code: u16,
    pub events: Vec<ProgressEvent>,
}

/// Rust-side WASM facade bytes result.
#[derive(Clone, PartialEq, Eq)]
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

/// Rust-side WASM facade result for metadata stripping.
#[derive(Clone, PartialEq, Eq)]
pub struct StripResult {
    pub code: u16,
    pub stripped_bytes: Vec<u8>,
    pub removed_metadata_count: u32,
}

/// Rust-side WASM facade result for image container inspection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageInspectResult {
    pub code: u16,
    pub format: u8,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub orientation: u8,
    pub encoded_sidecar_fields: Vec<u8>,
    pub camera_make: String,
    pub camera_model: String,
    pub device_timestamp_ms: u64,
    pub has_device_timestamp_ms: bool,
    pub subseconds_ms: u32,
    pub has_subseconds_ms: bool,
    pub gps_lat_microdegrees: i32,
    pub gps_lon_microdegrees: i32,
    pub gps_altitude_meters: i32,
    pub gps_accuracy_meters: u16,
    pub has_gps: bool,
}

/// Rust-side WASM facade result for video container inspection.
#[derive(Debug, Clone, PartialEq)]
pub struct VideoInspectResult {
    pub code: u16,
    pub container: String,
    pub video_codec: String,
    pub width_px: u32,
    pub height_px: u32,
    pub duration_ms: u64,
    pub frame_rate_fps: f64,
    pub orientation: String,
}

/// Rust-side WASM facade record for one canonical media tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MediaTierDimensions {
    pub tier: u8,
    pub width: u32,
    pub height: u32,
}

/// Rust-side WASM facade record for canonical media tier dimensions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MediaTierLayoutResult {
    pub code: u16,
    pub thumbnail: MediaTierDimensions,
    pub preview: MediaTierDimensions,
    pub original: MediaTierDimensions,
}

impl fmt::Debug for StripResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StripResult")
            .field("code", &self.code)
            .field("stripped_bytes_len", &self.stripped_bytes.len())
            .field("removed_metadata_count", &self.removed_metadata_count)
            .finish()
    }
}

/// Rust-side WASM facade account unlock parameters.
#[derive(Clone, PartialEq, Eq)]
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

/// Rust-side WASM facade account unlock result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountUnlockResult {
    pub code: u16,
    pub handle: u64,
}

/// Rust-side WASM facade new-account creation result.
///
/// Returned by [`create_new_account`]. Carries the freshly minted account
/// handle plus the wrapped account key the caller must persist on the
/// server. The L2 account key never crosses the WASM boundary.
///
/// `Debug` is implemented manually to redact the `wrapped_account_key`
/// byte payload (see SPEC-CrossPlatformHardening "Secret, PII, and Log
/// Redaction Rules"; mirrors the M5 wrapped-key redaction precedent).
#[derive(Clone, PartialEq, Eq)]
pub struct CreateAccountResult {
    pub code: u16,
    pub handle: u64,
    pub wrapped_account_key: Vec<u8>,
}

impl fmt::Debug for CreateAccountResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CreateAccountResult")
            .field("code", &self.code)
            .field("handle", &self.handle)
            .field("wrapped_account_key_len", &self.wrapped_account_key.len())
            .finish()
    }
}

/// Rust-side WASM facade account-key handle status result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AccountKeyHandleStatusResult {
    pub code: u16,
    pub is_open: bool,
}

/// Rust-side WASM facade identity handle result.
#[derive(Clone, PartialEq, Eq)]
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

/// Rust-side WASM facade epoch-key handle result.
#[derive(Clone, PartialEq, Eq)]
pub struct EpochKeyHandleResult {
    pub code: u16,
    pub handle: u64,
    pub epoch_id: u32,
    pub wrapped_epoch_seed: Vec<u8>,
    /// Per-epoch Ed25519 manifest signing public key. Empty when the handle
    /// has no sign keypair (legacy `open_epoch_key_handle` re-derivation).
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

/// Rust-side WASM facade epoch-key handle status result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EpochKeyHandleStatusResult {
    pub code: u16,
    pub is_open: bool,
}

/// Rust-side WASM facade encrypted shard result.
#[derive(Clone, PartialEq, Eq)]
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

/// Rust-side WASM facade decrypted shard result.
///
/// This type carries client-local plaintext media bytes on success.
#[derive(Clone, PartialEq, Eq)]
pub struct DecryptedShardResult {
    pub code: u16,
    pub plaintext: Vec<u8>,
}

impl fmt::Debug for DecryptedShardResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DecryptedShardResult")
            .field("code", &self.code)
            .field("plaintext_len", &self.plaintext.len())
            .finish()
    }
}

/// Rust-side WASM facade streaming encrypted frame result.
#[derive(Clone, PartialEq, Eq)]
pub struct StreamingFrameResult {
    pub code: u16,
    pub frame_index: u32,
    pub bytes: Vec<u8>,
}

impl fmt::Debug for StreamingFrameResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StreamingFrameResult")
            .field("code", &self.code)
            .field("frame_index", &self.frame_index)
            .field("bytes_len", &self.bytes.len())
            .finish()
    }
}

/// Rust-side WASM facade finalized streaming envelope result.
#[derive(Clone, PartialEq, Eq)]
pub struct StreamingEnvelopeResult {
    pub code: u16,
    pub header: Vec<u8>,
    pub bytes: Vec<u8>,
    pub frame_count: u32,
    pub final_frame_size: u32,
}

impl fmt::Debug for StreamingEnvelopeResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StreamingEnvelopeResult")
            .field("code", &self.code)
            .field("header_len", &self.header.len())
            .field("bytes_len", &self.bytes.len())
            .field("frame_count", &self.frame_count)
            .field("final_frame_size", &self.final_frame_size)
            .finish()
    }
}

/// Rust-side WASM facade public crypto/domain golden-vector snapshot.
#[derive(Clone, PartialEq, Eq)]
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

impl fmt::Debug for CryptoDomainGoldenVectorSnapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CryptoDomainGoldenVectorSnapshot")
            .field("code", &self.code)
            .field("envelope_header_len", &self.envelope_header.len())
            .field("envelope_epoch_id", &self.envelope_epoch_id)
            .field("envelope_shard_index", &self.envelope_shard_index)
            .field("envelope_tier", &self.envelope_tier)
            .field("envelope_nonce_len", &self.envelope_nonce.len())
            .field("manifest_transcript_len", &self.manifest_transcript.len())
            .field("identity_message_len", &self.identity_message.len())
            .field(
                "identity_signing_pubkey_len",
                &self.identity_signing_pubkey.len(),
            )
            .field(
                "identity_encryption_pubkey_len",
                &self.identity_encryption_pubkey.len(),
            )
            .field("identity_signature_len", &self.identity_signature.len())
            .finish()
    }
}

/// Rust-side WASM facade privacy-safe upload shard reference.
#[derive(Clone, PartialEq, Eq)]
pub struct ClientCoreUploadShardRef {
    pub tier: u8,
    pub shard_index: u32,
    pub shard_id: String,
    pub sha256: Vec<u8>,
    pub content_length: u64,
    pub envelope_version: u8,
    pub uploaded: bool,
}

impl fmt::Debug for ClientCoreUploadShardRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientCoreUploadShardRef")
            .field("tier", &self.tier)
            .field("shard_index", &self.shard_index)
            .field("shard_id", &self.shard_id)
            .field("sha256_len", &self.sha256.len())
            .field("content_length", &self.content_length)
            .field("envelope_version", &self.envelope_version)
            .field("uploaded", &self.uploaded)
            .finish()
    }
}

/// Rust-side WASM facade upload job initialization request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientCoreUploadJobRequest {
    pub job_id: String,
    pub album_id: String,
    pub asset_id: String,
    pub idempotency_key: String,
    pub max_retry_count: u8,
}

/// Rust-side WASM facade persistence-safe upload job snapshot.
#[derive(Clone, PartialEq, Eq)]
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

impl fmt::Debug for ClientCoreUploadJobSnapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientCoreUploadJobSnapshot")
            .field("schema_version", &self.schema_version)
            .field("job_id", &self.job_id)
            .field("album_id", &self.album_id)
            .field("phase", &self.phase)
            .field("retry_count", &self.retry_count)
            .field("max_retry_count", &self.max_retry_count)
            .field("next_retry_not_before_ms", &self.next_retry_not_before_ms)
            .field(
                "has_next_retry_not_before_ms",
                &self.has_next_retry_not_before_ms,
            )
            .field("idempotency_key", &self.idempotency_key)
            .field("tiered_shards", &self.tiered_shards)
            .field("shard_set_hash_len", &self.shard_set_hash.len())
            .field("snapshot_revision", &self.snapshot_revision)
            .field("last_effect_id", &self.last_effect_id)
            .field(
                "last_acknowledged_effect_id",
                &self.last_acknowledged_effect_id,
            )
            .field("last_applied_event_id", &self.last_applied_event_id)
            .field("failure_code", &self.failure_code)
            .finish()
    }
}

/// Rust-side WASM facade compact upload event.
#[derive(Clone, PartialEq, Eq)]
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

impl fmt::Debug for ClientCoreUploadJobEvent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientCoreUploadJobEvent")
            .field("kind", &self.kind)
            .field("effect_id", &self.effect_id)
            .field("tier", &self.tier)
            .field("shard_index", &self.shard_index)
            .field("shard_id", &self.shard_id)
            .field("sha256_len", &self.sha256.len())
            .field("content_length", &self.content_length)
            .field("envelope_version", &self.envelope_version)
            .field("uploaded", &self.uploaded)
            .field("tiered_shards", &self.tiered_shards)
            .field("shard_set_hash_len", &self.shard_set_hash.len())
            .field("asset_id", &self.asset_id)
            .field("since_metadata_version", &self.since_metadata_version)
            .field("recovery_outcome", &self.recovery_outcome)
            .field("now_ms", &self.now_ms)
            .field("base_backoff_ms", &self.base_backoff_ms)
            .field("server_retry_after_ms", &self.server_retry_after_ms)
            .field("has_server_retry_after_ms", &self.has_server_retry_after_ms)
            .field("has_error_code", &self.has_error_code)
            .field("error_code", &self.error_code)
            .field("target_phase", &self.target_phase)
            .finish()
    }
}

/// Rust-side WASM facade compact upload effect.
#[derive(Clone, PartialEq, Eq)]
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

impl fmt::Debug for ClientCoreUploadJobEffect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientCoreUploadJobEffect")
            .field("kind", &self.kind)
            .field("effect_id", &self.effect_id)
            .field("tier", &self.tier)
            .field("shard_index", &self.shard_index)
            .field("shard_id", &self.shard_id)
            .field("sha256_len", &self.sha256.len())
            .field("content_length", &self.content_length)
            .field("envelope_version", &self.envelope_version)
            .field("attempt", &self.attempt)
            .field("not_before_ms", &self.not_before_ms)
            .field("target_phase", &self.target_phase)
            .field("reason", &self.reason)
            .field("asset_id", &self.asset_id)
            .field("since_metadata_version", &self.since_metadata_version)
            .field("idempotency_key", &self.idempotency_key)
            .field("shard_set_hash_len", &self.shard_set_hash.len())
            .finish()
    }
}

/// Rust-side WASM facade upload transition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientCoreUploadJobTransition {
    pub next_snapshot: ClientCoreUploadJobSnapshot,
    pub effects: Vec<ClientCoreUploadJobEffect>,
}

/// Rust-side WASM facade upload initialization result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientCoreUploadJobResult {
    pub code: u16,
    pub snapshot: ClientCoreUploadJobSnapshot,
}

/// Rust-side WASM facade upload advance result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientCoreUploadJobTransitionResult {
    pub code: u16,
    pub transition: ClientCoreUploadJobTransition,
}

/// Rust-side WASM facade album sync initialization request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientCoreAlbumSyncRequest {
    pub album_id: String,
    pub request_id: String,
    pub start_cursor: String,
    pub now_unix_ms: u64,
    pub max_retry_count: u32,
}

/// Rust-side WASM facade persistence-safe album sync snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
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

/// Rust-side WASM facade compact album sync event.
#[derive(Debug, Clone, PartialEq, Eq)]
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

/// Rust-side WASM facade compact album sync effect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientCoreAlbumSyncEffect {
    pub kind: String,
    pub cursor: String,
}

/// Rust-side WASM facade album sync transition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientCoreAlbumSyncTransition {
    pub snapshot: ClientCoreAlbumSyncSnapshot,
    pub effects: Vec<ClientCoreAlbumSyncEffect>,
}

/// Rust-side WASM facade album sync initialization result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientCoreAlbumSyncResult {
    pub code: u16,
    pub snapshot: ClientCoreAlbumSyncSnapshot,
}

/// Rust-side WASM facade album sync advance result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientCoreAlbumSyncTransitionResult {
    pub code: u16,
    pub transition: ClientCoreAlbumSyncTransition,
}

/// Rust-side WASM facade auth keypair derivation result.
///
/// The auth signing secret stays inside Rust; only the 32-byte Ed25519
/// public key is exposed across the FFI boundary.
///
/// `Debug` is implemented manually to redact the `auth_public_key` byte
/// payload — same `<redacted>` discipline applied to other key-bearing
/// FFI structs (`IdentityHandleResult`, etc.), established by M5
/// (commit fb26573).
#[derive(Clone, PartialEq, Eq)]
pub struct AuthKeypairResult {
    pub code: u16,
    pub auth_public_key: Vec<u8>,
}

impl fmt::Debug for AuthKeypairResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AuthKeypairResult")
            .field("code", &self.code)
            .field("auth_public_key_len", &self.auth_public_key.len())
            .finish()
    }
}

/// Rust-side WASM facade result for creating a link-share handle and first wrapped tier.
///
/// `link_url_token` is a bearer URL fragment token by design. It is not
/// the derived link wrapping key; the wrapping key remains Rust-owned.
#[derive(Clone, PartialEq, Eq)]
pub struct CreateLinkShareHandleResult {
    pub code: u16,
    pub handle: u64,
    pub link_id: Vec<u8>,
    pub link_url_token: Vec<u8>,
    pub tier: u8,
    pub nonce: Vec<u8>,
    pub encrypted_key: Vec<u8>,
}

impl fmt::Debug for CreateLinkShareHandleResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CreateLinkShareHandleResult")
            .field("code", &self.code)
            .field("handle", &self.handle)
            .field("link_id_len", &self.link_id.len())
            .field("link_url_token_len", &self.link_url_token.len())
            .field("tier", &self.tier)
            .field("nonce_len", &self.nonce.len())
            .field("encrypted_key_len", &self.encrypted_key.len())
            .finish()
    }
}

/// Rust-side WASM facade result for imported link-tier handles.
#[derive(Clone, PartialEq, Eq)]
pub struct LinkTierHandleResult {
    pub code: u16,
    pub handle: u64,
    pub link_id: Vec<u8>,
    pub tier: u8,
}

impl fmt::Debug for LinkTierHandleResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LinkTierHandleResult")
            .field("code", &self.code)
            .field("handle", &self.handle)
            .field("link_id_len", &self.link_id.len())
            .field("tier", &self.tier)
            .finish()
    }
}

/// Rust-side WASM facade wrapped tier key result.
#[derive(Clone, PartialEq, Eq)]
pub struct WrappedTierKeyResult {
    pub code: u16,
    pub tier: u8,
    pub nonce: Vec<u8>,
    pub encrypted_key: Vec<u8>,
}

impl fmt::Debug for WrappedTierKeyResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WrappedTierKeyResult")
            .field("code", &self.code)
            .field("tier", &self.tier)
            .field("nonce_len", &self.nonce.len())
            .field("encrypted_key_len", &self.encrypted_key.len())
            .finish()
    }
}

/// Rust-side WASM facade sealed bundle result.
#[derive(Clone, PartialEq, Eq)]
pub struct SealedBundleResult {
    pub code: u16,
    pub sealed: Vec<u8>,
    pub signature: Vec<u8>,
    pub sharer_pubkey: Vec<u8>,
}

impl fmt::Debug for SealedBundleResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SealedBundleResult")
            .field("code", &self.code)
            .field("sealed_len", &self.sealed.len())
            .field("signature_len", &self.signature.len())
            .field("sharer_pubkey_len", &self.sharer_pubkey.len())
            .finish()
    }
}

/// Rust-side WASM facade encrypted album content result.
#[derive(Clone, PartialEq, Eq)]
pub struct EncryptedContentResult {
    pub code: u16,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

impl fmt::Debug for EncryptedContentResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EncryptedContentResult")
            .field("code", &self.code)
            .field("nonce_len", &self.nonce.len())
            .field("ciphertext_len", &self.ciphertext.len())
            .finish()
    }
}

/// Rust-side WASM facade decrypted album content result.
///
/// Carries client-local plaintext bytes on success.
#[derive(Clone, PartialEq, Eq)]
pub struct DecryptedContentResult {
    pub code: u16,
    pub plaintext: Vec<u8>,
}

impl fmt::Debug for DecryptedContentResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DecryptedContentResult")
            .field("code", &self.code)
            .field("plaintext_len", &self.plaintext.len())
            .finish()
    }
}

fn parse_uuid_string(input: &str) -> Result<mosaic_client::Uuid, ()> {
    let mut hex = String::with_capacity(32);
    for ch in input.chars() {
        if ch == '-' {
            continue;
        }
        if !ch.is_ascii_hexdigit() {
            return Err(());
        }
        hex.push(ch);
    }
    if hex.len() != 32 {
        return Err(());
    }
    let mut bytes = [0_u8; 16];
    for (index, byte) in bytes.iter_mut().enumerate() {
        let start = index * 2;
        *byte = u8::from_str_radix(&hex[start..start + 2], 16).map_err(|_| ())?;
    }
    Ok(mosaic_client::Uuid::from_bytes(bytes))
}

/// Builds the canonical v1 share-link URL in Rust so web callers do not
/// duplicate route assembly logic. The fragment token is a bearer token by
/// design and remains after `#k=` so it is never sent to the server.
#[wasm_bindgen(js_name = buildShareLinkUrl)]
#[must_use]
pub fn build_share_link_url(
    base_url: String,
    album_id: String,
    link_id: String,
    link_url_token: String,
) -> String {
    match parse_uuid_string(&album_id) {
        Ok(album_uuid) => {
            mosaic_client::build_share_link_url(&base_url, &album_uuid, &link_id, &link_url_token)
        }
        Err(()) => String::new(),
    }
}

/// WASM-bindgen class for header parse results.
#[wasm_bindgen(js_name = HeaderResult)]
pub struct JsHeaderResult {
    code: u16,
    epoch_id: u32,
    shard_index: u32,
    tier: u8,
    nonce: Vec<u8>,
}

#[wasm_bindgen(js_class = HeaderResult)]
impl JsHeaderResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Parsed epoch ID when parsing succeeds.
    #[wasm_bindgen(getter, js_name = epochId)]
    #[must_use]
    pub fn epoch_id(&self) -> u32 {
        self.epoch_id
    }

    /// Parsed shard index when parsing succeeds.
    #[wasm_bindgen(getter, js_name = shardIndex)]
    #[must_use]
    pub fn shard_index(&self) -> u32 {
        self.shard_index
    }

    /// Parsed tier byte when parsing succeeds.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn tier(&self) -> u8 {
        self.tier
    }

    /// Parsed nonce when parsing succeeds.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn nonce(&self) -> Vec<u8> {
        self.nonce.clone()
    }
}

/// WASM-bindgen class for progress events.
#[wasm_bindgen(js_name = ProgressEvent)]
pub struct JsProgressEvent {
    completed_steps: u32,
    total_steps: u32,
}

#[wasm_bindgen(js_class = ProgressEvent)]
impl JsProgressEvent {
    /// Completed operation steps.
    #[wasm_bindgen(getter, js_name = completedSteps)]
    #[must_use]
    pub fn completed_steps(&self) -> u32 {
        self.completed_steps
    }

    /// Total operation steps.
    #[wasm_bindgen(getter, js_name = totalSteps)]
    #[must_use]
    pub fn total_steps(&self) -> u32 {
        self.total_steps
    }
}

/// WASM-bindgen class for progress results.
#[wasm_bindgen(js_name = ProgressResult)]
pub struct JsProgressResult {
    code: u16,
    event_pairs: Vec<u32>,
}

#[wasm_bindgen(js_class = ProgressResult)]
impl JsProgressResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Flattened completed/total pairs for low-friction JS marshalling.
    #[wasm_bindgen(getter, js_name = eventPairs)]
    #[must_use]
    pub fn event_pairs(&self) -> Vec<u32> {
        self.event_pairs.clone()
    }
}

/// WASM-bindgen class for byte-array results.
#[wasm_bindgen(js_name = BytesResult)]
pub struct JsBytesResult {
    code: u16,
    bytes: Vec<u8>,
}

#[wasm_bindgen(js_class = BytesResult)]
impl JsBytesResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Public bytes or signature bytes.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }
}

/// WASM-bindgen class for metadata stripping results.
#[wasm_bindgen(js_name = StripResult)]
pub struct JsStripResult {
    code: u16,
    stripped_bytes: Vec<u8>,
    removed_metadata_count: u32,
}

#[wasm_bindgen(js_class = StripResult)]
impl JsStripResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Image or video bytes after metadata stripping.
    #[wasm_bindgen(getter, js_name = strippedBytes)]
    #[must_use]
    pub fn stripped_bytes(&self) -> Vec<u8> {
        self.stripped_bytes.clone()
    }

    /// Number of metadata container segments removed.
    #[wasm_bindgen(getter, js_name = removedMetadataCount)]
    #[must_use]
    pub fn removed_metadata_count(&self) -> u32 {
        self.removed_metadata_count
    }
}

/// WASM-bindgen class for one canonical media tier.
#[wasm_bindgen(js_name = MediaTierDimensions)]
pub struct JsMediaTierDimensions {
    tier: u8,
    width: u32,
    height: u32,
}

#[wasm_bindgen(js_class = MediaTierDimensions)]
impl JsMediaTierDimensions {
    /// Shard tier protocol byte.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn tier(&self) -> u8 {
        self.tier
    }

    /// Canonical max width for this tier.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Canonical max height for this tier.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn height(&self) -> u32 {
        self.height
    }
}

/// WASM-bindgen class for canonical media tier dimensions.
#[wasm_bindgen(js_name = MediaTierLayoutResult)]
pub struct JsMediaTierLayoutResult {
    code: u16,
    thumbnail: MediaTierDimensions,
    preview: MediaTierDimensions,
    original: MediaTierDimensions,
}

#[wasm_bindgen(js_class = MediaTierLayoutResult)]
impl JsMediaTierLayoutResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Canonical thumbnail tier dimensions.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn thumbnail(&self) -> JsMediaTierDimensions {
        js_media_tier_dimensions_from_rust(self.thumbnail)
    }

    /// Canonical preview tier dimensions.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn preview(&self) -> JsMediaTierDimensions {
        js_media_tier_dimensions_from_rust(self.preview)
    }

    /// Canonical original tier dimensions.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn original(&self) -> JsMediaTierDimensions {
        js_media_tier_dimensions_from_rust(self.original)
    }
}

/// WASM-bindgen class for image inspection results.
#[wasm_bindgen(js_name = ImageInspectResult)]
pub struct JsImageInspectResult {
    code: u16,
    format: u8,
    mime_type: String,
    width: u32,
    height: u32,
    orientation: u8,
    encoded_sidecar_fields: Vec<u8>,
    camera_make: String,
    camera_model: String,
    device_timestamp_ms: u64,
    has_device_timestamp_ms: bool,
    subseconds_ms: u32,
    has_subseconds_ms: bool,
    gps_lat_microdegrees: i32,
    gps_lon_microdegrees: i32,
    gps_altitude_meters: i32,
    gps_accuracy_meters: u16,
    has_gps: bool,
}

#[wasm_bindgen(js_class = ImageInspectResult)]
impl JsImageInspectResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Stable media format code derived from container bytes (JPEG=1, PNG=2, WebP=3, AVIF=4, HEIC=5).
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn format(&self) -> u8 {
        self.format
    }

    /// Trusted MIME type derived from container bytes.
    #[wasm_bindgen(getter, js_name = mimeType)]
    #[must_use]
    pub fn mime_type(&self) -> String {
        self.mime_type.clone()
    }

    /// Display width after orientation normalization.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Display height after orientation normalization.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn height(&self) -> u32 {
        self.height
    }

    /// EXIF orientation value normalized by the Rust media parser.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn orientation(&self) -> u8 {
        self.orientation
    }

    /// Compact encoded canonical metadata sidecar fields.
    #[wasm_bindgen(getter, js_name = encodedSidecarFields)]
    #[must_use]
    pub fn encoded_sidecar_fields(&self) -> Vec<u8> {
        self.encoded_sidecar_fields.clone()
    }

    /// Camera make extracted from EXIF, or empty when absent.
    #[wasm_bindgen(getter, js_name = cameraMake)]
    #[must_use]
    pub fn camera_make(&self) -> String {
        self.camera_make.clone()
    }

    /// Camera model extracted from EXIF, or empty when absent.
    #[wasm_bindgen(getter, js_name = cameraModel)]
    #[must_use]
    pub fn camera_model(&self) -> String {
        self.camera_model.clone()
    }

    /// Whether `deviceTimestampMs` carries an extracted EXIF timestamp.
    #[wasm_bindgen(getter, js_name = hasDeviceTimestampMs)]
    #[must_use]
    pub fn has_device_timestamp_ms(&self) -> bool {
        self.has_device_timestamp_ms
    }

    /// Device timestamp extracted from EXIF, valid when `hasDeviceTimestampMs` is true.
    #[wasm_bindgen(getter, js_name = deviceTimestampMs)]
    #[must_use]
    pub fn device_timestamp_ms(&self) -> u64 {
        self.device_timestamp_ms
    }

    /// Whether `subsecondsMs` carries extracted EXIF subseconds.
    #[wasm_bindgen(getter, js_name = hasSubsecondsMs)]
    #[must_use]
    pub fn has_subseconds_ms(&self) -> bool {
        self.has_subseconds_ms
    }

    /// EXIF subseconds in milliseconds, valid when `hasSubsecondsMs` is true.
    #[wasm_bindgen(getter, js_name = subsecondsMs)]
    #[must_use]
    pub fn subseconds_ms(&self) -> u32 {
        self.subseconds_ms
    }

    /// Whether GPS fields were extracted from EXIF.
    #[wasm_bindgen(getter, js_name = hasGps)]
    #[must_use]
    pub fn has_gps(&self) -> bool {
        self.has_gps
    }

    #[wasm_bindgen(getter, js_name = gpsLatMicrodegrees)]
    #[must_use]
    pub fn gps_lat_microdegrees(&self) -> i32 {
        self.gps_lat_microdegrees
    }

    #[wasm_bindgen(getter, js_name = gpsLonMicrodegrees)]
    #[must_use]
    pub fn gps_lon_microdegrees(&self) -> i32 {
        self.gps_lon_microdegrees
    }

    #[wasm_bindgen(getter, js_name = gpsAltitudeMeters)]
    #[must_use]
    pub fn gps_altitude_meters(&self) -> i32 {
        self.gps_altitude_meters
    }

    #[wasm_bindgen(getter, js_name = gpsAccuracyMeters)]
    #[must_use]
    pub fn gps_accuracy_meters(&self) -> u16 {
        self.gps_accuracy_meters
    }
}

/// WASM-bindgen class for video inspection results.
#[wasm_bindgen(js_name = VideoInspectResult)]
pub struct JsVideoInspectResult {
    code: u16,
    container: String,
    video_codec: String,
    width_px: u32,
    height_px: u32,
    duration_ms: u64,
    frame_rate_fps: f64,
    orientation: String,
}

#[wasm_bindgen(js_class = VideoInspectResult)]
impl JsVideoInspectResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Trusted video container label derived from bytes.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn container(&self) -> String {
        self.container.clone()
    }

    /// Trusted codec label, or empty string when unavailable.
    #[wasm_bindgen(getter, js_name = videoCodec)]
    #[must_use]
    pub fn video_codec(&self) -> String {
        self.video_codec.clone()
    }

    /// Video track width in pixels.
    #[wasm_bindgen(getter, js_name = widthPx)]
    #[must_use]
    pub fn width_px(&self) -> u32 {
        self.width_px
    }

    /// Video track height in pixels.
    #[wasm_bindgen(getter, js_name = heightPx)]
    #[must_use]
    pub fn height_px(&self) -> u32 {
        self.height_px
    }

    /// Video duration in milliseconds.
    #[wasm_bindgen(getter, js_name = durationMs)]
    #[must_use]
    pub fn duration_ms(&self) -> u64 {
        self.duration_ms
    }

    /// Video frame rate in frames per second, or NaN when unavailable.
    #[wasm_bindgen(getter, js_name = frameRateFps)]
    #[must_use]
    pub fn frame_rate_fps(&self) -> f64 {
        self.frame_rate_fps
    }

    /// Rotation label, or empty string when unavailable.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn orientation(&self) -> String {
        self.orientation.clone()
    }
}

/// WASM-bindgen class for account unlock results.
#[wasm_bindgen(js_name = AccountUnlockResult)]
pub struct JsAccountUnlockResult {
    code: u16,
    handle: u64,
}

#[wasm_bindgen(js_class = AccountUnlockResult)]
impl JsAccountUnlockResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Opaque Rust-owned account-key handle.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn handle(&self) -> u64 {
        self.handle
    }
}

/// WASM-bindgen class for new-account creation results.
#[wasm_bindgen(js_name = CreateAccountResult)]
pub struct JsCreateAccountResult {
    code: u16,
    handle: u64,
    wrapped_account_key: Vec<u8>,
}

#[wasm_bindgen(js_class = CreateAccountResult)]
impl JsCreateAccountResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Opaque Rust-owned account-key handle for the newly minted L2.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn handle(&self) -> u64 {
        self.handle
    }

    /// Server-storable wrapped account key. Caller persists this; it is
    /// re-supplied at the next login as the input to `unlockAccountKey`.
    #[wasm_bindgen(getter, js_name = wrappedAccountKey)]
    #[must_use]
    pub fn wrapped_account_key(&self) -> Vec<u8> {
        self.wrapped_account_key.clone()
    }
}

/// WASM-bindgen class for account-key handle status results.
#[wasm_bindgen(js_name = AccountKeyHandleStatusResult)]
pub struct JsAccountKeyHandleStatusResult {
    code: u16,
    is_open: bool,
}

#[wasm_bindgen(js_class = AccountKeyHandleStatusResult)]
impl JsAccountKeyHandleStatusResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Whether the handle is currently open.
    #[wasm_bindgen(getter, js_name = isOpen)]
    #[must_use]
    pub fn is_open(&self) -> bool {
        self.is_open
    }
}

/// WASM-bindgen class for identity handle results.
#[wasm_bindgen(js_name = IdentityHandleResult)]
pub struct JsIdentityHandleResult {
    code: u16,
    handle: u64,
    signing_pubkey: Vec<u8>,
    encryption_pubkey: Vec<u8>,
    wrapped_seed: Vec<u8>,
}

#[wasm_bindgen(js_class = IdentityHandleResult)]
impl JsIdentityHandleResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Opaque Rust-owned identity handle.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn handle(&self) -> u64 {
        self.handle
    }

    /// Ed25519 public identity key.
    #[wasm_bindgen(getter, js_name = signingPubkey)]
    #[must_use]
    pub fn signing_pubkey(&self) -> Vec<u8> {
        self.signing_pubkey.clone()
    }

    /// X25519 recipient public key.
    #[wasm_bindgen(getter, js_name = encryptionPubkey)]
    #[must_use]
    pub fn encryption_pubkey(&self) -> Vec<u8> {
        self.encryption_pubkey.clone()
    }

    /// Wrapped identity seed bytes returned on creation.
    #[wasm_bindgen(getter, js_name = wrappedSeed)]
    #[must_use]
    pub fn wrapped_seed(&self) -> Vec<u8> {
        self.wrapped_seed.clone()
    }
}

/// WASM-bindgen class for epoch-key handle results.
#[wasm_bindgen(js_name = EpochKeyHandleResult)]
pub struct JsEpochKeyHandleResult {
    code: u16,
    handle: u64,
    epoch_id: u32,
    wrapped_epoch_seed: Vec<u8>,
    sign_public_key: Vec<u8>,
}

#[wasm_bindgen(js_class = EpochKeyHandleResult)]
impl JsEpochKeyHandleResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Opaque Rust-owned epoch-key handle.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn handle(&self) -> u64 {
        self.handle
    }

    /// Epoch identifier associated with this handle.
    #[wasm_bindgen(getter, js_name = epochId)]
    #[must_use]
    pub fn epoch_id(&self) -> u32 {
        self.epoch_id
    }

    /// Wrapped epoch seed bytes returned on creation.
    #[wasm_bindgen(getter, js_name = wrappedEpochSeed)]
    #[must_use]
    pub fn wrapped_epoch_seed(&self) -> Vec<u8> {
        self.wrapped_epoch_seed.clone()
    }

    /// Per-epoch Ed25519 manifest signing public key, or an empty array when
    /// the handle has no sign keypair attached.
    #[wasm_bindgen(getter, js_name = signPublicKey)]
    #[must_use]
    pub fn sign_public_key(&self) -> Vec<u8> {
        self.sign_public_key.clone()
    }
}

/// WASM-bindgen class for epoch-key handle status results.
#[wasm_bindgen(js_name = EpochKeyHandleStatusResult)]
pub struct JsEpochKeyHandleStatusResult {
    code: u16,
    is_open: bool,
}

#[wasm_bindgen(js_class = EpochKeyHandleStatusResult)]
impl JsEpochKeyHandleStatusResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Whether the handle is currently open.
    #[wasm_bindgen(getter, js_name = isOpen)]
    #[must_use]
    pub fn is_open(&self) -> bool {
        self.is_open
    }
}

/// WASM-bindgen class for encrypted shard results.
#[wasm_bindgen(js_name = EncryptedShardResult)]
pub struct JsEncryptedShardResult {
    code: u16,
    envelope_bytes: Vec<u8>,
    sha256: String,
}

#[wasm_bindgen(js_class = EncryptedShardResult)]
impl JsEncryptedShardResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Full encrypted shard envelope bytes.
    #[wasm_bindgen(getter, js_name = envelopeBytes)]
    #[must_use]
    pub fn envelope_bytes(&self) -> Vec<u8> {
        self.envelope_bytes.clone()
    }

    /// Base64url SHA-256 digest of the full envelope bytes.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn sha256(&self) -> String {
        self.sha256.clone()
    }
}

/// WASM-bindgen class for decrypted shard results.
#[wasm_bindgen(js_name = DecryptedShardResult)]
pub struct JsDecryptedShardResult {
    code: u16,
    plaintext: Vec<u8>,
}

#[wasm_bindgen(js_class = DecryptedShardResult)]
impl JsDecryptedShardResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Client-local plaintext bytes on successful decryption.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn plaintext(&self) -> Vec<u8> {
        self.plaintext.clone()
    }
}

/// WASM-bindgen class for streaming encrypted/decrypted frame results.
#[wasm_bindgen(js_name = StreamingFrameResult)]
pub struct JsStreamingFrameResult {
    code: u16,
    frame_index: u32,
    bytes: Vec<u8>,
}

#[wasm_bindgen(js_class = StreamingFrameResult)]
impl JsStreamingFrameResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Zero-based frame index assigned by the streaming encryptor.
    #[wasm_bindgen(getter, js_name = frameIndex)]
    #[must_use]
    pub fn frame_index(&self) -> u32 {
        self.frame_index
    }

    /// Serialized frame bytes.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }
}

/// WASM-bindgen class for finalized streaming envelope results.
#[wasm_bindgen(js_name = StreamingEnvelopeResult)]
pub struct JsStreamingEnvelopeResult {
    code: u16,
    header: Vec<u8>,
    bytes: Vec<u8>,
    frame_count: u32,
    final_frame_size: u32,
}

#[wasm_bindgen(js_class = StreamingEnvelopeResult)]
impl JsStreamingEnvelopeResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Final v0x04 streaming envelope header bytes.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn header(&self) -> Vec<u8> {
        self.header.clone()
    }

    /// Full v0x04 streaming envelope bytes: header followed by frames.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }

    /// Declared frame count.
    #[wasm_bindgen(getter, js_name = frameCount)]
    #[must_use]
    pub fn frame_count(&self) -> u32 {
        self.frame_count
    }

    /// Plaintext byte length of the final frame.
    #[wasm_bindgen(getter, js_name = finalFrameSize)]
    #[must_use]
    pub fn final_frame_size(&self) -> u32 {
        self.final_frame_size
    }
}

/// WASM-bindgen class for public crypto/domain golden-vector snapshots.
#[wasm_bindgen(js_name = CryptoDomainGoldenVectorSnapshot)]
pub struct JsCryptoDomainGoldenVectorSnapshot {
    code: u16,
    envelope_header: Vec<u8>,
    envelope_epoch_id: u32,
    envelope_shard_index: u32,
    envelope_tier: u8,
    envelope_nonce: Vec<u8>,
    manifest_transcript: Vec<u8>,
    identity_message: Vec<u8>,
    identity_signing_pubkey: Vec<u8>,
    identity_encryption_pubkey: Vec<u8>,
    identity_signature: Vec<u8>,
}

#[wasm_bindgen(js_class = CryptoDomainGoldenVectorSnapshot)]
impl JsCryptoDomainGoldenVectorSnapshot {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Serialized 64-byte shard envelope header vector.
    #[wasm_bindgen(getter, js_name = envelopeHeader)]
    #[must_use]
    pub fn envelope_header(&self) -> Vec<u8> {
        self.envelope_header.clone()
    }

    /// Parsed envelope epoch ID.
    #[wasm_bindgen(getter, js_name = envelopeEpochId)]
    #[must_use]
    pub fn envelope_epoch_id(&self) -> u32 {
        self.envelope_epoch_id
    }

    /// Parsed envelope shard index.
    #[wasm_bindgen(getter, js_name = envelopeShardIndex)]
    #[must_use]
    pub fn envelope_shard_index(&self) -> u32 {
        self.envelope_shard_index
    }

    /// Parsed envelope tier byte.
    #[wasm_bindgen(getter, js_name = envelopeTier)]
    #[must_use]
    pub fn envelope_tier(&self) -> u8 {
        self.envelope_tier
    }

    /// Parsed envelope nonce bytes.
    #[wasm_bindgen(getter, js_name = envelopeNonce)]
    #[must_use]
    pub fn envelope_nonce(&self) -> Vec<u8> {
        self.envelope_nonce.clone()
    }

    /// Canonical manifest transcript vector bytes.
    #[wasm_bindgen(getter, js_name = manifestTranscript)]
    #[must_use]
    pub fn manifest_transcript(&self) -> Vec<u8> {
        self.manifest_transcript.clone()
    }

    /// Fixed public identity signing message bytes.
    #[wasm_bindgen(getter, js_name = identityMessage)]
    #[must_use]
    pub fn identity_message(&self) -> Vec<u8> {
        self.identity_message.clone()
    }

    /// Ed25519 identity public key bytes.
    #[wasm_bindgen(getter, js_name = identitySigningPubkey)]
    #[must_use]
    pub fn identity_signing_pubkey(&self) -> Vec<u8> {
        self.identity_signing_pubkey.clone()
    }

    /// X25519 recipient public key bytes.
    #[wasm_bindgen(getter, js_name = identityEncryptionPubkey)]
    #[must_use]
    pub fn identity_encryption_pubkey(&self) -> Vec<u8> {
        self.identity_encryption_pubkey.clone()
    }

    /// Ed25519 detached identity signature bytes.
    #[wasm_bindgen(getter, js_name = identitySignature)]
    #[must_use]
    pub fn identity_signature(&self) -> Vec<u8> {
        self.identity_signature.clone()
    }
}

/// WASM-bindgen class for auth keypair derivation results.
#[wasm_bindgen(js_name = AuthKeypairResult)]
pub struct JsAuthKeypairResult {
    code: u16,
    auth_public_key: Vec<u8>,
}

#[wasm_bindgen(js_class = AuthKeypairResult)]
impl JsAuthKeypairResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// 32-byte Ed25519 LocalAuth public key. Non-secret.
    #[wasm_bindgen(getter, js_name = authPublicKey)]
    #[must_use]
    pub fn auth_public_key(&self) -> Vec<u8> {
        self.auth_public_key.clone()
    }
}

/// WASM-bindgen class for link-share handle creation results.
#[wasm_bindgen(js_name = CreateLinkShareHandleResult)]
pub struct JsCreateLinkShareHandleResult {
    code: u16,
    handle: u64,
    link_id: Vec<u8>,
    link_url_token: Vec<u8>,
    tier: u8,
    nonce: Vec<u8>,
    encrypted_key: Vec<u8>,
}

#[wasm_bindgen(js_class = CreateLinkShareHandleResult)]
impl JsCreateLinkShareHandleResult {
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn handle(&self) -> u64 {
        self.handle
    }
    #[wasm_bindgen(getter, js_name = linkId)]
    #[must_use]
    pub fn link_id(&self) -> Vec<u8> {
        self.link_id.clone()
    }
    /// Bearer URL fragment token allowed by the link-share protocol.
    #[wasm_bindgen(getter, js_name = linkUrlToken)]
    #[must_use]
    pub fn link_url_token(&self) -> Vec<u8> {
        self.link_url_token.clone()
    }
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn tier(&self) -> u8 {
        self.tier
    }
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn nonce(&self) -> Vec<u8> {
        self.nonce.clone()
    }
    #[wasm_bindgen(getter, js_name = encryptedKey)]
    #[must_use]
    pub fn encrypted_key(&self) -> Vec<u8> {
        self.encrypted_key.clone()
    }
}

/// WASM-bindgen class for imported link-tier handle results.
#[wasm_bindgen(js_name = LinkTierHandleResult)]
pub struct JsLinkTierHandleResult {
    code: u16,
    handle: u64,
    link_id: Vec<u8>,
    tier: u8,
}

#[wasm_bindgen(js_class = LinkTierHandleResult)]
impl JsLinkTierHandleResult {
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn handle(&self) -> u64 {
        self.handle
    }
    #[wasm_bindgen(getter, js_name = linkId)]
    #[must_use]
    pub fn link_id(&self) -> Vec<u8> {
        self.link_id.clone()
    }
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn tier(&self) -> u8 {
        self.tier
    }
}

/// WASM-bindgen class for wrapped tier key results.
#[wasm_bindgen(js_name = WrappedTierKeyResult)]
pub struct JsWrappedTierKeyResult {
    code: u16,
    tier: u8,
    nonce: Vec<u8>,
    encrypted_key: Vec<u8>,
}

#[wasm_bindgen(js_class = WrappedTierKeyResult)]
impl JsWrappedTierKeyResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Shard tier byte the wrapped key grants access to.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn tier(&self) -> u8 {
        self.tier
    }

    /// 24-byte XChaCha20 nonce used by the wrapping AEAD.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn nonce(&self) -> Vec<u8> {
        self.nonce.clone()
    }

    /// Wrapped tier-key ciphertext including the 16-byte Poly1305 tag.
    #[wasm_bindgen(getter, js_name = encryptedKey)]
    #[must_use]
    pub fn encrypted_key(&self) -> Vec<u8> {
        self.encrypted_key.clone()
    }
}

/// WASM-bindgen class for sealed bundle results.
#[wasm_bindgen(js_name = SealedBundleResult)]
pub struct JsSealedBundleResult {
    code: u16,
    sealed: Vec<u8>,
    signature: Vec<u8>,
    sharer_pubkey: Vec<u8>,
}

#[wasm_bindgen(js_class = SealedBundleResult)]
impl JsSealedBundleResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Sealed-box ciphertext bytes.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn sealed(&self) -> Vec<u8> {
        self.sealed.clone()
    }

    /// 64-byte detached Ed25519 signature over `BUNDLE_SIGN_CONTEXT || sealed`.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn signature(&self) -> Vec<u8> {
        self.signature.clone()
    }

    /// 32-byte sharer Ed25519 identity public key.
    #[wasm_bindgen(getter, js_name = sharerPubkey)]
    #[must_use]
    pub fn sharer_pubkey(&self) -> Vec<u8> {
        self.sharer_pubkey.clone()
    }
}

/// WASM-bindgen class for encrypted album content results.
#[wasm_bindgen(js_name = EncryptedContentResult)]
pub struct JsEncryptedContentResult {
    code: u16,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}

#[wasm_bindgen(js_class = EncryptedContentResult)]
impl JsEncryptedContentResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// 24-byte XChaCha20 nonce.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn nonce(&self) -> Vec<u8> {
        self.nonce.clone()
    }

    /// Ciphertext including the trailing 16-byte Poly1305 tag.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn ciphertext(&self) -> Vec<u8> {
        self.ciphertext.clone()
    }
}

/// WASM-bindgen class for decrypted album content results.
#[wasm_bindgen(js_name = DecryptedContentResult)]
pub struct JsDecryptedContentResult {
    code: u16,
    plaintext: Vec<u8>,
}

#[wasm_bindgen(js_class = DecryptedContentResult)]
impl JsDecryptedContentResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Client-local plaintext album content on successful decryption.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn plaintext(&self) -> Vec<u8> {
        self.plaintext.clone()
    }
}

/// Returns the crate name for smoke tests and generated wrapper diagnostics.
#[must_use]
pub const fn crate_name() -> &'static str {
    "mosaic-wasm"
}

/// Returns the domain protocol version this WASM facade is compiled against.
#[must_use]
pub const fn protocol_version() -> &'static str {
    mosaic_client::protocol_version()
}

/// Returns the ADR-022 canonical manifest-finalize idempotency key.
#[must_use]
pub fn finalize_idempotency_key(job_id: String) -> Result<String, u16> {
    let uuid = uuid_from_string(&job_id)?;
    Ok(mosaic_client::finalize_idempotency_key(&uuid))
}

/// Returns the protocol byte pinned for a WASM shard tier.
#[must_use]
pub const fn shard_tier_byte(tier: ShardTier) -> u8 {
    tier as u8
}

/// Parses a protocol byte into a typed WASM shard tier.
///
/// Valid bytes are pinned by `mosaic_domain::ShardTier`: 1=thumbnail,
/// 2=preview, 3=original.
pub fn shard_tier_from_byte(byte: u8) -> Result<ShardTier, JsError> {
    match byte {
        1 => Ok(ShardTier::Thumbnail),
        2 => Ok(ShardTier::Preview),
        3 => Ok(ShardTier::Original),
        _ => Err(JsError::new("invalid shard tier byte")),
    }
}

/// Lists all protocol-supported shard tiers in ascending wire-byte order.
#[must_use]
pub fn list_shard_tiers() -> Vec<ShardTier> {
    vec![
        ShardTier::Thumbnail,
        ShardTier::Preview,
        ShardTier::Original,
    ]
}

/// Returns the historical WASM API changelog label for diagnostics.
///
/// This string is documentation only. The authoritative API-shape lock is
/// `tests/api_shape_lock.rs`, which compares the generated wasm-bindgen
/// TypeScript declaration file against a golden file.
#[must_use]
pub const fn wasm_api_snapshot() -> &'static str {
    "mosaic-wasm ffi-spike:v6 parse_envelope_header(bytes)->HeaderResult progress(total,cancel_after)->ProgressResult account(unlock/status/close) identity(create/open/close/pubkeys/sign/verify) epoch(create/open/status/close/encrypt/decrypt/legacy-raw-key-decrypt) metadata(canonical/encrypt) vectors(crypto-domain)->CryptoDomainGoldenVectorSnapshot client-core(state-machine-snapshot,upload-init/upload-advance,sync-init/sync-advance)"
}

const CLIENT_CORE_STATE_MACHINE_SURFACE: &str = "client-core-state-machines:v1 \
upload(init_upload_job(ClientCoreUploadJobRequest)->ClientCoreUploadJobResult,\
advance_upload_job(ClientCoreUploadJobSnapshot,ClientCoreUploadJobEvent)->ClientCoreUploadJobTransitionResult,\
ClientCoreUploadJobSnapshot,ClientCoreUploadJobTransition,ClientCoreUploadJobEffect) \
sync(init_album_sync(ClientCoreAlbumSyncRequest)->ClientCoreAlbumSyncResult,\
advance_album_sync(ClientCoreAlbumSyncSnapshot,ClientCoreAlbumSyncEvent)->ClientCoreAlbumSyncTransitionResult,\
ClientCoreAlbumSyncSnapshot,ClientCoreAlbumSyncTransition,ClientCoreAlbumSyncEffect)";

/// Parses a shard envelope header for Rust-side wrapper tests.
#[must_use]
pub fn parse_envelope_header(bytes: Vec<u8>) -> HeaderResult {
    header_result_from_client(mosaic_client::parse_shard_header_for_ffi(&bytes))
}

/// Runs the progress probe for Rust-side wrapper tests.
#[must_use]
pub fn wasm_progress_probe(total_steps: u32, cancel_after: Option<u32>) -> ProgressResult {
    progress_result_from_client(mosaic_client::run_progress_probe(total_steps, cancel_after))
}

/// Unwraps an account key into a Rust-owned opaque account-key handle.
#[must_use]
pub fn unlock_account_key(password: Vec<u8>, request: AccountUnlockRequest) -> AccountUnlockResult {
    let mut password = Zeroizing::new(password);
    let wrapped_account_key = Zeroizing::new(request.wrapped_account_key);
    let user_salt = request.user_salt;
    let account_salt = request.account_salt;
    account_unlock_result_from_client(mosaic_client::unlock_account_key(
        mosaic_client::AccountUnlockRequest {
            password: password.as_mut_slice(),
            user_salt: &user_salt,
            account_salt: &account_salt,
            wrapped_account_key: &wrapped_account_key,
            kdf_memory_kib: request.kdf_memory_kib,
            kdf_iterations: request.kdf_iterations,
            kdf_parallelism: request.kdf_parallelism,
        },
    ))
}

/// Creates a fresh account-key handle in a single Argon2id pass.
///
/// Generates a random L2, wraps it under L1 (`Argon2id(password,
/// user_salt) → HKDF(account_salt)`), and opens an opaque secret handle.
/// The caller-owned `password` buffer is zeroized on every path before
/// this function returns.
#[must_use]
pub fn create_new_account(
    password: Vec<u8>,
    user_salt: Vec<u8>,
    account_salt: Vec<u8>,
    kdf_memory_kib: u32,
    kdf_iterations: u32,
    kdf_parallelism: u32,
) -> CreateAccountResult {
    let mut password = Zeroizing::new(password);
    create_account_result_from_client(mosaic_client::create_new_account_handle(
        password.as_mut_slice(),
        &user_salt,
        &account_salt,
        kdf_memory_kib,
        kdf_iterations,
        kdf_parallelism,
    ))
}

/// Wraps `plaintext` with the L2 account key referenced by `account_handle`.
#[must_use]
pub fn wrap_with_account_handle(account_handle: u64, plaintext: Vec<u8>) -> BytesResult {
    let plaintext = Zeroizing::new(plaintext);
    let result = mosaic_client::wrap_with_account_handle(account_handle, &plaintext);
    bytes_result_from_client(result)
}

/// Unwraps a previously wrapped blob with the L2 account key referenced by
/// `account_handle`.
#[must_use]
pub fn unwrap_with_account_handle(account_handle: u64, wrapped: Vec<u8>) -> BytesResult {
    let result = mosaic_client::unwrap_with_account_handle(account_handle, &wrapped);
    bytes_result_from_client(result)
}

/// Builds the canonical LocalAuth challenge transcript byte string.
///
/// `timestamp_ms_present == false` omits the timestamp segment to match
/// the optional shape the backend accepts. Returns
/// `ClientErrorCode::InvalidUsername` for empty/invalid usernames or
/// `InvalidInputLength` for non-32-byte challenges.
#[must_use]
pub fn build_auth_challenge_transcript(
    username: String,
    timestamp_ms: u64,
    timestamp_ms_present: bool,
    challenge: Vec<u8>,
) -> BytesResult {
    let timestamp = if timestamp_ms_present {
        Some(timestamp_ms)
    } else {
        None
    };
    bytes_result_from_client(mosaic_client::build_auth_challenge_transcript_for_ffi(
        &username, timestamp, &challenge,
    ))
}

/// Returns whether an account-key handle is currently open.
#[must_use]
pub fn account_key_handle_is_open(handle: u64) -> AccountKeyHandleStatusResult {
    account_status_result_from_client(mosaic_client::account_key_handle_is_open(handle))
}

/// Closes an account-key handle and returns the stable error code.
#[must_use]
pub fn close_account_key_handle(handle: u64) -> u16 {
    match mosaic_client::close_account_key_handle(handle) {
        Ok(()) => mosaic_client::ClientErrorCode::Ok.as_u16(),
        Err(error) => error.code.as_u16(),
    }
}

/// Creates a new identity handle for an existing account-key handle.
#[must_use]
pub fn create_identity_handle(account_key_handle: u64) -> IdentityHandleResult {
    identity_result_from_client(mosaic_client::create_identity_handle(account_key_handle))
}

/// Opens an identity handle from wrapped identity seed bytes.
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
#[must_use]
pub fn identity_signing_pubkey(handle: u64) -> BytesResult {
    bytes_result_from_client(mosaic_client::identity_signing_pubkey(handle))
}

/// Returns an identity handle's X25519 recipient public key.
#[must_use]
pub fn identity_encryption_pubkey(handle: u64) -> BytesResult {
    bytes_result_from_client(mosaic_client::identity_encryption_pubkey(handle))
}

/// Signs manifest transcript bytes with an identity handle.
#[must_use]
pub fn sign_manifest_with_identity(handle: u64, transcript_bytes: Vec<u8>) -> BytesResult {
    bytes_result_from_client(mosaic_client::sign_manifest_with_identity(
        handle,
        &transcript_bytes,
    ))
}

/// Verifies manifest transcript bytes with a public identity signing key.
#[must_use]
pub fn verify_manifest_with_identity(
    transcript_bytes: Vec<u8>,
    signature: Vec<u8>,
    public_key: Vec<u8>,
) -> u16 {
    mosaic_client::verify_manifest_with_identity(&transcript_bytes, &signature, &public_key)
        .as_u16()
}

/// Signs manifest transcript bytes with the per-epoch manifest signing key
/// attached to a Rust-owned epoch handle.
///
/// Slice 4 — the per-epoch signing secret never crosses the FFI boundary.
#[must_use]
pub fn sign_manifest_with_epoch_handle(handle: u64, transcript_bytes: Vec<u8>) -> BytesResult {
    bytes_result_from_client(mosaic_client::sign_manifest_with_epoch_handle(
        handle,
        &transcript_bytes,
    ))
}

/// Verifies manifest transcript bytes with a per-epoch manifest signing
/// public key.
#[must_use]
pub fn verify_manifest_with_epoch(
    transcript_bytes: Vec<u8>,
    signature: Vec<u8>,
    public_key: Vec<u8>,
) -> u16 {
    mosaic_client::verify_manifest_with_epoch(&transcript_bytes, &signature, &public_key).as_u16()
}

/// Builds canonical plaintext metadata sidecar bytes from a compact encoded field list.
///
/// `encoded_fields` is a repeated sequence of `tag:u16le | value_len:u32le | value`.
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

/// Builds canonical plaintext video metadata sidecar bytes from inspected video bytes.
#[must_use]
pub fn video_metadata_sidecar_bytes(
    album_id: Vec<u8>,
    photo_id: Vec<u8>,
    epoch_id: u32,
    input_bytes: Vec<u8>,
) -> BytesResult {
    let inspect = mosaic_media::inspect_video_container(&input_bytes);
    if inspect.code != 0 {
        return BytesResult {
            code: inspect.code,
            bytes: Vec::new(),
        };
    }

    let pairs = mosaic_media::video_metadata_sidecar_fields(&inspect);
    let mut encoded_fields = Vec::new();
    for (tag, value) in pairs {
        let value_len = match u32::try_from(value.len()) {
            Ok(length) => length,
            Err(_) => {
                return BytesResult {
                    code: mosaic_client::ClientErrorCode::InvalidInputLength.as_u16(),
                    bytes: Vec::new(),
                };
            }
        };
        encoded_fields.extend_from_slice(&tag.to_le_bytes());
        encoded_fields.extend_from_slice(&value_len.to_le_bytes());
        encoded_fields.extend_from_slice(&value);
    }

    canonical_metadata_sidecar_bytes(album_id, photo_id, epoch_id, encoded_fields)
}

/// Builds canonical manifest transcript bytes from opaque encrypted metadata and shard refs.
///
/// `encoded_shards` is a repeated sequence of
/// `chunk_index:u32le | tier:u8 | shard_id:16 bytes | sha256:32 bytes`.
#[must_use]
pub fn manifest_transcript_bytes(
    album_id: Vec<u8>,
    epoch_id: u32,
    encrypted_meta: Vec<u8>,
    encoded_shards: Vec<u8>,
) -> BytesResult {
    match manifest_transcript_bytes_result(&album_id, epoch_id, &encrypted_meta, &encoded_shards) {
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
#[must_use]
pub fn encrypt_metadata_sidecar_with_epoch_handle(
    handle: u64,
    album_id: Vec<u8>,
    photo_id: Vec<u8>,
    epoch_id: u32,
    encoded_fields: Vec<u8>,
    shard_index: u32,
) -> EncryptedShardResult {
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
        DomainShardTier::Thumbnail.to_byte(),
    ))
}

/// Creates a new epoch-key handle for an existing account-key handle.
#[must_use]
pub fn create_epoch_key_handle(account_key_handle: u64, epoch_id: u32) -> EpochKeyHandleResult {
    epoch_result_from_client(mosaic_client::create_epoch_key_handle(
        account_key_handle,
        epoch_id,
    ))
}

/// Opens an epoch-key handle from wrapped epoch seed bytes.
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
#[must_use]
pub fn close_epoch_key_handle(handle: u64) -> u16 {
    match mosaic_client::close_epoch_key_handle(handle) {
        Ok(()) => mosaic_client::ClientErrorCode::Ok.as_u16(),
        Err(error) => error.code.as_u16(),
    }
}

/// Encrypts shard bytes with a Rust-owned epoch-key handle.
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

/// Encrypts shard bytes with a Rust-owned epoch-key handle and typed shard tier.
#[must_use]
pub fn encrypt_shard_with_tier(
    handle: u64,
    plaintext: Vec<u8>,
    shard_index: u32,
    tier: ShardTier,
) -> EncryptedShardResult {
    encrypt_shard_with_epoch_handle(
        handle,
        plaintext,
        shard_index,
        DomainShardTier::from(tier).to_byte(),
    )
}

/// Decrypts shard envelope bytes with a Rust-owned epoch-key handle.
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

/// Decrypts shard envelope bytes and returns plaintext bytes.
///
/// The shard tier is read from the envelope header by the client core.
#[must_use]
pub fn decrypt_shard_with_tier(handle: u64, envelope_bytes: Vec<u8>) -> BytesResult {
    let result = decrypt_shard_with_epoch_handle(handle, envelope_bytes);
    BytesResult {
        code: result.code,
        bytes: result.plaintext,
    }
}

fn streaming_frame_error(code: u16) -> StreamingFrameResult {
    StreamingFrameResult {
        code,
        frame_index: 0,
        bytes: Vec::new(),
    }
}

fn streaming_envelope_error(code: u16) -> StreamingEnvelopeResult {
    StreamingEnvelopeResult {
        code,
        header: Vec::new(),
        bytes: Vec::new(),
        frame_count: 0,
        final_frame_size: 0,
    }
}

fn already_finalized_code() -> u16 {
    mosaic_client::ClientErrorCode::InvalidInputLength.as_u16()
}

/// Stateful v0x04 streaming shard encryptor exposed to WASM.
#[wasm_bindgen]
pub struct StreamingShardEncryptor {
    code: u16,
    inner: Mutex<Option<StreamingEncryptorCell>>,
}

#[wasm_bindgen]
impl StreamingShardEncryptor {
    /// Initializes a streaming encryptor for an existing epoch handle.
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new(_epoch_handle_id: u64, _tier: u8, _expected_frame_count: Option<u32>) -> Self {
        let key_material = match mosaic_client::epoch_key_material_for_handle(_epoch_handle_id) {
            Ok(key_material) => key_material,
            Err(error) => {
                return Self {
                    code: error.code.as_u16(),
                    inner: Mutex::new(None),
                };
            }
        };
        let tier = match mosaic_domain::ShardTier::try_from(_tier) {
            Ok(tier) => tier,
            Err(_) => {
                return Self {
                    code: mosaic_client::ClientErrorCode::InvalidTier.as_u16(),
                    inner: Mutex::new(None),
                };
            }
        };
        let cell = match StreamingEncryptorCell::try_new(key_material, |handle| {
            mosaic_crypto::streaming_encrypt_init(handle, tier, _expected_frame_count)
                .map(|inner| CryptoStreamingEncryptorState(Some(inner)))
        }) {
            Ok(cell) => cell,
            Err(error) => {
                return Self {
                    code: client_error_code_from_crypto(error),
                    inner: Mutex::new(None),
                };
            }
        };
        Self {
            code: mosaic_client::ClientErrorCode::Ok.as_u16(),
            inner: Mutex::new(Some(cell)),
        }
    }

    /// Encrypts one plaintext frame.
    #[wasm_bindgen(js_name = encryptFrame)]
    #[must_use]
    pub fn encrypt_frame(&mut self, _plaintext: Vec<u8>) -> JsValue {
        if self.code != 0 {
            return js_streaming_frame_result_from_rust(streaming_frame_error(self.code)).into();
        }
        let plaintext = Zeroizing::new(_plaintext);
        let result = self
            .inner
            .lock()
            .map_err(|_| mosaic_client::ClientErrorCode::InternalStatePoisoned.as_u16())
            .and_then(|mut guard| {
                let cell = guard.as_mut().ok_or_else(already_finalized_code)?;
                cell.with_dependent_mut(|_, state| {
                    let encryptor = state.0.as_mut().ok_or_else(already_finalized_code)?;
                    encryptor.encrypt_frame(&plaintext).map_or_else(
                        |error| Err(client_error_code_from_crypto(error)),
                        |frame| {
                            Ok(StreamingFrameResult {
                                code: mosaic_client::ClientErrorCode::Ok.as_u16(),
                                frame_index: frame.frame_index,
                                bytes: frame.bytes,
                            })
                        },
                    )
                })
            })
            .unwrap_or_else(streaming_frame_error);
        js_streaming_frame_result_from_rust(result).into()
    }

    /// Finalizes the stream and returns the v0x04 envelope.
    #[must_use]
    pub fn finalize(self) -> JsValue {
        if self.code != 0 {
            return js_streaming_envelope_result_from_rust(streaming_envelope_error(self.code))
                .into();
        }
        let result = self
            .inner
            .lock()
            .map_err(|_| mosaic_client::ClientErrorCode::InternalStatePoisoned.as_u16())
            .and_then(|mut guard| {
                let mut cell = guard.take().ok_or_else(already_finalized_code)?;
                cell.with_dependent_mut(|_, state| {
                    let encryptor = state.0.take().ok_or_else(already_finalized_code)?;
                    encryptor.finalize().map_or_else(
                        |error| Err(client_error_code_from_crypto(error)),
                        |envelope| {
                            Ok(StreamingEnvelopeResult {
                                code: mosaic_client::ClientErrorCode::Ok.as_u16(),
                                header: envelope.header.to_vec(),
                                bytes: envelope.bytes,
                                frame_count: envelope.frame_count,
                                final_frame_size: envelope.final_frame_size,
                            })
                        },
                    )
                })
            })
            .unwrap_or_else(streaming_envelope_error);
        js_streaming_envelope_result_from_rust(result).into()
    }
}

/// Stateful v0x04 streaming shard decryptor exposed to WASM.
#[wasm_bindgen]
pub struct StreamingShardDecryptor {
    code: u16,
    inner: Mutex<Option<StreamingDecryptorCell>>,
}

#[wasm_bindgen]
impl StreamingShardDecryptor {
    /// Initializes a streaming decryptor from a v0x04 envelope header.
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new(_epoch_handle_id: u64, _envelope_header: Vec<u8>) -> Self {
        let key_material = match mosaic_client::epoch_key_material_for_handle(_epoch_handle_id) {
            Ok(key_material) => key_material,
            Err(error) => {
                return Self {
                    code: error.code.as_u16(),
                    inner: Mutex::new(None),
                };
            }
        };
        let cell = match StreamingDecryptorCell::try_new(key_material, |handle| {
            mosaic_crypto::streaming_decrypt_init(handle, &_envelope_header)
                .map(|inner| CryptoStreamingDecryptorState(Some(inner)))
        }) {
            Ok(cell) => cell,
            Err(error) => {
                return Self {
                    code: client_error_code_from_crypto(error),
                    inner: Mutex::new(None),
                };
            }
        };
        Self {
            code: mosaic_client::ClientErrorCode::Ok.as_u16(),
            inner: Mutex::new(Some(cell)),
        }
    }

    /// Decrypts one serialized streaming frame.
    #[wasm_bindgen(js_name = decryptFrame)]
    #[must_use]
    pub fn decrypt_frame(&mut self, _frame: Vec<u8>) -> JsValue {
        if self.code != 0 {
            return js_decrypted_shard_result_from_rust(DecryptedShardResult {
                code: self.code,
                plaintext: Vec::new(),
            })
            .into();
        }
        let result = self
            .inner
            .lock()
            .map_err(|_| mosaic_client::ClientErrorCode::InternalStatePoisoned.as_u16())
            .and_then(|mut guard| {
                let cell = guard.as_mut().ok_or_else(already_finalized_code)?;
                cell.with_dependent_mut(|_, state| {
                    let decryptor = state.0.as_mut().ok_or_else(already_finalized_code)?;
                    decryptor.decrypt_frame(&_frame).map_or_else(
                        |error| Err(client_error_code_from_crypto(error)),
                        |plaintext| {
                            Ok(DecryptedShardResult {
                                code: mosaic_client::ClientErrorCode::Ok.as_u16(),
                                plaintext,
                            })
                        },
                    )
                })
            })
            .unwrap_or_else(|code| DecryptedShardResult {
                code,
                plaintext: Vec::new(),
            });
        js_decrypted_shard_result_from_rust(result).into()
    }

    /// Returns a `BytesResult` whose `bytes` field is always empty by contract.
    /// Future callers should ignore `bytes` and check only `code`. Reason: the
    /// finalize step performs final-frame AAD verification only — there is no
    /// payload data to return. UniFFI mirror returns `Result<(), MosaicError>` honestly;
    /// WASM uses `BytesResult` for cross-API uniformity.
    #[must_use]
    pub fn finalize(self) -> JsValue {
        if self.code != 0 {
            return js_bytes_result_from_rust(BytesResult {
                code: self.code,
                bytes: Vec::new(),
            })
            .into();
        }
        let code = self
            .inner
            .lock()
            .map_err(|_| mosaic_client::ClientErrorCode::InternalStatePoisoned.as_u16())
            .and_then(|mut guard| {
                let mut cell = guard.take().ok_or_else(already_finalized_code)?;
                cell.with_dependent_mut(|_, state| {
                    let decryptor = state.0.take().ok_or_else(already_finalized_code)?;
                    decryptor.finalize().map_or_else(
                        |error| Err(client_error_code_from_crypto(error)),
                        |_| Ok(()),
                    )
                })
            })
            .map_or_else(|code| code, |_| mosaic_client::ClientErrorCode::Ok.as_u16());
        js_bytes_result_from_rust(BytesResult {
            code,
            bytes: Vec::new(),
        })
        .into()
    }
}

/// Decrypts a v0x03/v0x04 envelope using the epoch-handle dispatcher surface.
#[wasm_bindgen(js_name = decryptEnvelope)]
#[must_use]
pub fn decrypt_envelope_js(epoch_handle_id: u64, envelope: Vec<u8>) -> JsValue {
    let result = mosaic_client::epoch_key_material_for_handle(epoch_handle_id).map_or_else(
        |error| DecryptedShardResult {
            code: error.code.as_u16(),
            plaintext: Vec::new(),
        },
        |key_material| {
            mosaic_crypto::decrypt_envelope(&key_material, &envelope).map_or_else(
                |error| DecryptedShardResult {
                    code: client_error_code_from_crypto(error),
                    plaintext: Vec::new(),
                },
                |plaintext| DecryptedShardResult {
                    code: mosaic_client::ClientErrorCode::Ok.as_u16(),
                    plaintext,
                },
            )
        },
    );
    js_decrypted_shard_result_from_rust(result).into()
}

/// Decrypts a legacy raw-key shard envelope with a Rust-owned epoch-key handle.
#[must_use]
pub fn decrypt_shard_with_legacy_raw_key_handle(
    handle: u64,
    envelope_bytes: Vec<u8>,
) -> DecryptedShardResult {
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

/// Returns deterministic public crypto/domain golden vectors for Rust-side wrapper tests.
#[must_use]
pub fn crypto_domain_golden_vector_snapshot() -> CryptoDomainGoldenVectorSnapshot {
    crypto_domain_vector_from_client(mosaic_client::crypto_domain_golden_vector_snapshot())
}

/// Returns the stable client-core state machine WASM proof surface.
#[must_use]
pub fn client_core_state_machine_snapshot() -> String {
    CLIENT_CORE_STATE_MACHINE_SURFACE.to_owned()
}

/// Initializes a client-core upload job through the Rust-side WASM DTO surface.
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

/// Advances a client-core upload job through the Rust-side WASM DTO surface.
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

/// Initializes an album sync coordinator through the Rust-side WASM DTO surface.
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

/// Advances an album sync coordinator through the Rust-side WASM DTO surface.
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

/// Closes an identity handle and returns the stable error code.
#[must_use]
pub fn close_identity_handle(handle: u64) -> u16 {
    match mosaic_client::close_identity_handle(handle) {
        Ok(()) => mosaic_client::ClientErrorCode::Ok.as_u16(),
        Err(error) => error.code.as_u16(),
    }
}

/// Derives the deterministic LocalAuth Ed25519 keypair from an account-key
/// handle and returns the public key. The signing secret stays in Rust.
#[must_use]
pub fn derive_auth_keypair_from_account(account_handle: u64) -> AuthKeypairResult {
    auth_keypair_result_from_client(mosaic_client::derive_auth_keypair_from_account_handle(
        account_handle,
    ))
}

/// Signs caller-built LocalAuth challenge transcript bytes with the auth
/// keypair derived from the supplied account-key handle.
#[must_use]
pub fn sign_auth_challenge_with_account(
    account_handle: u64,
    challenge_bytes: Vec<u8>,
) -> BytesResult {
    bytes_result_from_client(mosaic_client::sign_auth_challenge_with_account_handle(
        account_handle,
        &challenge_bytes,
    ))
}

/// Returns the 32-byte Ed25519 LocalAuth public key for the supplied
/// account-key handle.
#[must_use]
pub fn get_auth_public_key_from_account(account_handle: u64) -> BytesResult {
    bytes_result_from_client(mosaic_client::get_auth_public_key_from_account_handle(
        account_handle,
    ))
}

/// Derives the password-rooted LocalAuth Ed25519 keypair from `password` +
/// `user_salt` (Argon2id+HKDF) and returns the public key.
///
/// Used by LocalAuth login/register **before** an account handle is open.
/// The auth signing secret stays Rust-side; only the 32-byte public key
/// crosses the WASM boundary. The caller-owned `password` buffer is
/// zeroized on every path before this function returns.
#[must_use]
pub fn derive_auth_keypair_from_password(
    password: Vec<u8>,
    user_salt: Vec<u8>,
    kdf_memory_kib: u32,
    kdf_iterations: u32,
    kdf_parallelism: u32,
) -> AuthKeypairResult {
    let mut password = Zeroizing::new(password);
    let result = mosaic_client::derive_auth_keypair_from_password(
        password.as_mut_slice(),
        &user_salt,
        kdf_memory_kib,
        kdf_iterations,
        kdf_parallelism,
    );
    auth_keypair_result_from_client(result)
}

/// Signs a caller-built LocalAuth challenge transcript with the
/// password-rooted auth keypair.
///
/// Re-runs Argon2id+HKDF on every call. Used by the worker's pre-auth
/// signing path during LocalAuth login/register. The caller-owned
/// `password` buffer is zeroized on every path before this function
/// returns.
#[must_use]
pub fn sign_auth_challenge_with_password(
    password: Vec<u8>,
    user_salt: Vec<u8>,
    kdf_memory_kib: u32,
    kdf_iterations: u32,
    kdf_parallelism: u32,
    transcript_bytes: Vec<u8>,
) -> BytesResult {
    let mut password = Zeroizing::new(password);
    let result = mosaic_client::sign_auth_challenge_with_password(
        password.as_mut_slice(),
        &user_salt,
        kdf_memory_kib,
        kdf_iterations,
        kdf_parallelism,
        &transcript_bytes,
    );
    bytes_result_from_client(result)
}

/// Returns the 32-byte Ed25519 LocalAuth public key derived from
/// `password` + `user_salt`.
///
/// Convenience wrapper. Re-runs Argon2id+HKDF on every call; callers who
/// also need to sign should prefer `sign_auth_challenge_with_password` to
/// amortise the KDF cost.
#[must_use]
pub fn get_auth_public_key_from_password(
    password: Vec<u8>,
    user_salt: Vec<u8>,
    kdf_memory_kib: u32,
    kdf_iterations: u32,
    kdf_parallelism: u32,
) -> BytesResult {
    let mut password = Zeroizing::new(password);
    let result = mosaic_client::get_auth_public_key_from_password(
        password.as_mut_slice(),
        &user_salt,
        kdf_memory_kib,
        kdf_iterations,
        kdf_parallelism,
    );
    bytes_result_from_client(result)
}

/// Creates a share-link handle and returns the first wrapped tier key.
///
/// `link_url_token` is a bearer URL fragment token by design. It is not the
/// derived wrapping key; Rust derives and retains the wrapping key behind the
/// returned opaque handle.
#[must_use]
pub fn create_link_share_handle(
    album_id: String,
    epoch_handle: u64,
    tier_byte: u8,
) -> CreateLinkShareHandleResult {
    create_link_share_handle_result_from_client(mosaic_client::create_link_share_handle(
        album_id,
        epoch_handle,
        tier_byte,
    ))
}

/// Imports a URL fragment seed into a Rust-owned share-link handle.
#[must_use]
pub fn import_link_share_handle(link_url_token: Vec<u8>) -> LinkTierHandleResult {
    let link_url_token = Zeroizing::new(link_url_token);
    link_tier_handle_result_from_client(mosaic_client::import_link_share_handle(&link_url_token))
}

/// Wraps an epoch tier for an existing Rust-owned share-link handle.
#[must_use]
pub fn wrap_link_tier_handle(
    link_share_handle: u64,
    epoch_handle: u64,
    tier_byte: u8,
) -> WrappedTierKeyResult {
    wrapped_tier_key_result_from_client(mosaic_client::wrap_link_tier_handle(
        link_share_handle,
        epoch_handle,
        tier_byte,
    ))
}

/// Imports a wrapped tier key into a Rust-owned link-tier handle.
#[must_use]
pub fn import_link_tier_handle(
    link_url_token: Vec<u8>,
    nonce: Vec<u8>,
    encrypted_key: Vec<u8>,
    album_id: String,
    tier_byte: u8,
) -> LinkTierHandleResult {
    let link_url_token = Zeroizing::new(link_url_token);
    link_tier_handle_result_from_client(mosaic_client::import_link_tier_handle(
        &link_url_token,
        &nonce,
        &encrypted_key,
        album_id,
        tier_byte,
    ))
}

/// Decrypts a shard using a Rust-owned share-link tier handle.
#[must_use]
pub fn decrypt_shard_with_link_tier_handle(
    link_tier_handle: u64,
    envelope_bytes: Vec<u8>,
) -> DecryptedShardResult {
    decrypted_shard_result_from_client(mosaic_client::decrypt_shard_with_link_tier_handle(
        link_tier_handle,
        &envelope_bytes,
    ))
}

/// Closes a Rust-owned share-link handle.
#[must_use]
pub fn close_link_share_handle(handle: u64) -> u16 {
    mosaic_client::close_link_share_handle(handle)
}

/// Closes a Rust-owned link-tier handle.
#[must_use]
pub fn close_link_tier_handle(handle: u64) -> u16 {
    mosaic_client::close_link_tier_handle(handle)
}

/// Verifies a sealed bundle's signature and imports the recovered epoch
/// payload directly into the Rust epoch-handle registry.
#[allow(clippy::too_many_arguments)]
#[must_use]
pub fn verify_and_import_epoch_bundle(
    identity_handle: u64,
    sealed: Vec<u8>,
    signature: Vec<u8>,
    sharer_pubkey: Vec<u8>,
    expected_album_id: String,
    expected_min_epoch: u32,
    allow_legacy_empty: bool,
) -> EpochKeyHandleResult {
    let sealed = Zeroizing::new(sealed);
    epoch_result_from_client(
        mosaic_client::verify_and_import_epoch_bundle_with_identity_handle(
            identity_handle,
            &sealed,
            &signature,
            &sharer_pubkey,
            expected_album_id,
            expected_min_epoch,
            allow_legacy_empty,
        ),
    )
}

/// Atomically seals an epoch key bundle for `recipient_pubkey` using a
/// Rust-owned epoch handle. Bundle payload bytes never cross the FFI
/// boundary — the caller only supplies the recipient's public key and the
/// album id.
#[must_use]
pub fn seal_bundle_with_epoch_handle(
    identity_handle: u64,
    epoch_handle: u64,
    recipient_pubkey: Vec<u8>,
    album_id: String,
) -> SealedBundleResult {
    sealed_bundle_result_from_client(mosaic_client::seal_bundle_with_epoch_handle(
        identity_handle,
        epoch_handle,
        &recipient_pubkey,
        album_id,
    ))
}

/// Encrypts album content with the content key derived from `epoch_handle`.
#[must_use]
pub fn encrypt_album_content(epoch_handle: u64, plaintext: Vec<u8>) -> EncryptedContentResult {
    let plaintext = Zeroizing::new(plaintext);
    encrypted_content_result_from_client(mosaic_client::encrypt_album_content_with_epoch_handle(
        epoch_handle,
        &plaintext,
    ))
}

/// Decrypts album content with the content key derived from `epoch_handle`.
#[must_use]
pub fn decrypt_album_content(
    epoch_handle: u64,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
) -> DecryptedContentResult {
    decrypted_content_result_from_client(mosaic_client::decrypt_album_content_with_epoch_handle(
        epoch_handle,
        &nonce,
        &ciphertext,
    ))
}

/// Parses a shard envelope header through the generated WASM binding surface.
#[wasm_bindgen(js_name = parseEnvelopeHeader)]
#[must_use]
pub fn parse_envelope_header_js(bytes: Vec<u8>) -> JsHeaderResult {
    let result = parse_envelope_header(bytes);
    JsHeaderResult {
        code: result.code,
        epoch_id: result.epoch_id,
        shard_index: result.shard_index,
        tier: result.tier,
        nonce: result.nonce,
    }
}

/// Returns the protocol byte pinned for a WASM shard tier.
#[wasm_bindgen(js_name = shardTierByte)]
#[must_use]
pub fn shard_tier_byte_js(tier: ShardTier) -> u8 {
    shard_tier_byte(tier)
}

/// Parses a protocol byte into a typed WASM shard tier.
#[wasm_bindgen(js_name = shardTierFromByte)]
pub fn shard_tier_from_byte_js(byte: u8) -> Result<ShardTier, JsError> {
    shard_tier_from_byte(byte)
}

/// Lists all protocol-supported shard tiers in ascending wire-byte order.
#[wasm_bindgen(js_name = listShardTiers)]
#[must_use]
pub fn list_shard_tiers_js() -> Vec<ShardTier> {
    list_shard_tiers()
}

/// Runs the progress probe through the generated WASM binding surface.
#[wasm_bindgen(js_name = progressProbe)]
#[must_use]
pub fn wasm_progress_probe_js(total_steps: u32, cancel_after: i64) -> JsProgressResult {
    let cancel_after = if cancel_after < 0 {
        None
    } else {
        u32::try_from(cancel_after).ok()
    };
    let result = mosaic_client::run_progress_probe(total_steps, cancel_after);
    let event_pairs_capacity = match result.events.len().checked_mul(2) {
        Some(value) => value,
        None => {
            return JsProgressResult {
                code: mosaic_client::ClientErrorCode::InvalidInputLength.as_u16(),
                event_pairs: Vec::new(),
            };
        }
    };
    let mut event_pairs = Vec::with_capacity(event_pairs_capacity);
    for event in result.events {
        event_pairs.push(event.completed_steps);
        event_pairs.push(event.total_steps);
    }

    JsProgressResult {
        code: result.code.as_u16(),
        event_pairs,
    }
}

const MEDIA_INVALID_JPEG_CODE: u16 = 601;
const MEDIA_INVALID_PNG_CODE: u16 = 602;
const MEDIA_INVALID_WEBP_CODE: u16 = 603;
const MEDIA_OUTPUT_TOO_LARGE_CODE: u16 = 604;
/// Strip-result-namespace code for `removed.len() > u32::MAX` overflow on the
/// strip wrapper path (effectively unreachable since input is bounded by image
/// size limits, but defensive). NOT a `WorkerCryptoErrorCode`: this lives in
/// the wasm strip-result namespace and flows only through `JsStripResult.code`
/// (see `apps/web/src/lib/exif-stripper.ts`). The numeric collision with
/// `WorkerCryptoErrorCode.InvalidMediaSidecar = 605` (TS-side) is intentional —
/// the two namespaces are independent and never cross.
const METADATA_STRIP_OVERFLOW_CODE: u16 = 605;
const MEDIA_UNKNOWN_ERROR_CODE: u16 = 699;

fn media_error_code(error: mosaic_media::MosaicMediaError) -> u16 {
    match error {
        mosaic_media::MosaicMediaError::InvalidJpeg => MEDIA_INVALID_JPEG_CODE,
        mosaic_media::MosaicMediaError::InvalidPng => MEDIA_INVALID_PNG_CODE,
        mosaic_media::MosaicMediaError::InvalidWebP => MEDIA_INVALID_WEBP_CODE,
        mosaic_media::MosaicMediaError::OutputTooLarge => MEDIA_OUTPUT_TOO_LARGE_CODE,
        _ => MEDIA_UNKNOWN_ERROR_CODE,
    }
}

fn strip_metadata(format: mosaic_media::MediaFormat, input_bytes: Vec<u8>) -> StripResult {
    strip_with_result(mosaic_media::strip_known_metadata(format, &input_bytes))
}

fn strip_with_result(
    result: Result<mosaic_media::StrippedMedia, mosaic_media::MosaicMediaError>,
) -> StripResult {
    match result {
        Ok(stripped) => {
            let removed_metadata_count = match u32::try_from(stripped.removed.len()) {
                Ok(value) => value,
                Err(_) => {
                    return StripResult {
                        code: METADATA_STRIP_OVERFLOW_CODE,
                        stripped_bytes: Vec::new(),
                        removed_metadata_count: 0,
                    };
                }
            };
            StripResult {
                code: 0,
                stripped_bytes: stripped.bytes,
                removed_metadata_count,
            }
        }
        Err(error) => StripResult {
            code: media_error_code(error),
            stripped_bytes: Vec::new(),
            removed_metadata_count: 0,
        },
    }
}

fn image_format_code(format: mosaic_media::MediaFormat) -> u8 {
    match format {
        mosaic_media::MediaFormat::Jpeg => 1,
        mosaic_media::MediaFormat::Png => 2,
        mosaic_media::MediaFormat::WebP => 3,
    }
}

fn video_container_label(container: mosaic_media::VideoContainer) -> &'static str {
    match container {
        mosaic_media::VideoContainer::Mp4 => "mp4",
        mosaic_media::VideoContainer::Mov => "mov",
        mosaic_media::VideoContainer::WebM => "webm",
        mosaic_media::VideoContainer::Matroska => "matroska",
    }
}

fn video_codec_label(codec: mosaic_media::VideoCodec) -> &'static str {
    match codec {
        mosaic_media::VideoCodec::H264 => "h264",
        mosaic_media::VideoCodec::H265 => "h265",
        mosaic_media::VideoCodec::AV1 => "av1",
        mosaic_media::VideoCodec::VP8 => "vp8",
        mosaic_media::VideoCodec::VP9 => "vp9",
    }
}

fn orientation_label(orientation: mosaic_media::Orientation) -> &'static str {
    match orientation {
        mosaic_media::Orientation::Rotate0 => "rotate0",
        mosaic_media::Orientation::Rotate90 => "rotate90",
        mosaic_media::Orientation::Rotate180 => "rotate180",
        mosaic_media::Orientation::Rotate270 => "rotate270",
    }
}

fn image_inspect_result_from_media(
    result: Result<mosaic_media::ImageMetadata, mosaic_media::MosaicMediaError>,
    input_bytes: &[u8],
) -> ImageInspectResult {
    match result {
        Ok(metadata) => ImageInspectResult {
            code: 0,
            format: image_format_code(metadata.format),
            mime_type: metadata.mime_type.to_owned(),
            width: metadata.width,
            height: metadata.height,
            orientation: metadata.orientation,
            ..image_sidecar_fields_for_format(input_bytes, metadata.format)
        },
        Err(error) => iso_bmff_image_inspect_result(input_bytes)
            .unwrap_or_else(|| empty_image_inspect_result(media_error_code(error))),
    }
}

fn iso_bmff_image_inspect_result(input_bytes: &[u8]) -> Option<ImageInspectResult> {
    let boxes = mosaic_media::BoxParser::new(input_bytes).parse().ok()?;
    let ftyp = boxes
        .iter()
        .find(|candidate| candidate.box_type == *b"ftyp")?;
    let (format, mime_type, sidecar_fields) =
        if iso_bmff_brands(ftyp.payload).any(|brand| matches!(brand, b"avif" | b"avis")) {
            (
                4,
                "image/avif",
                image_sidecar_fields_from_extract(
                    mosaic_media::extract_avif_canonical_sidecar_fields(input_bytes),
                ),
            )
        } else if iso_bmff_brands(ftyp.payload).any(|brand| {
            matches!(
                brand,
                b"heic" | b"heix" | b"hevc" | b"hevx" | b"heim" | b"heis" | b"mif1" | b"msf1"
            )
        }) {
            (
                5,
                "image/heic",
                image_sidecar_fields_from_extract(
                    mosaic_media::extract_heic_canonical_sidecar_fields(input_bytes),
                ),
            )
        } else {
            return None;
        };

    let meta = boxes
        .iter()
        .find(|candidate| candidate.box_type == *b"meta")?;
    let (width, height) = find_ispe_dimensions(&meta.children)?;
    Some(ImageInspectResult {
        code: 0,
        format,
        mime_type: mime_type.to_owned(),
        width,
        height,
        orientation: mosaic_media::NORMAL_EXIF_ORIENTATION,
        ..sidecar_fields
    })
}

fn iso_bmff_brands(payload: &[u8]) -> impl Iterator<Item = &[u8]> {
    let first = payload.get(..4).into_iter();
    let compatible = payload
        .get(8..)
        .into_iter()
        .flat_map(|tail| tail.chunks_exact(4));
    first.chain(compatible)
}

fn find_ispe_dimensions(boxes: &[mosaic_media::iso_bmff::Box<'_>]) -> Option<(u32, u32)> {
    for candidate in boxes {
        if candidate.box_type == *b"ispe" && candidate.payload.len() >= 12 {
            let width = u32::from_be_bytes(candidate.payload[4..8].try_into().ok()?);
            let height = u32::from_be_bytes(candidate.payload[8..12].try_into().ok()?);
            if width > 0 && height > 0 {
                return Some((width, height));
            }
        }
        if let Some(dimensions) = find_ispe_dimensions(&candidate.children) {
            return Some(dimensions);
        }
    }
    None
}

fn empty_image_inspect_result(code: u16) -> ImageInspectResult {
    ImageInspectResult {
        code,
        format: 0,
        mime_type: String::new(),
        width: 0,
        height: 0,
        orientation: 0,
        encoded_sidecar_fields: Vec::new(),
        camera_make: String::new(),
        camera_model: String::new(),
        device_timestamp_ms: 0,
        has_device_timestamp_ms: false,
        subseconds_ms: 0,
        has_subseconds_ms: false,
        gps_lat_microdegrees: 0,
        gps_lon_microdegrees: 0,
        gps_altitude_meters: 0,
        gps_accuracy_meters: 0,
        has_gps: false,
    }
}

fn image_sidecar_fields_for_format(
    input_bytes: &[u8],
    format: mosaic_media::MediaFormat,
) -> ImageInspectResult {
    image_sidecar_fields_from_extract(mosaic_media::extract_canonical_sidecar_fields(
        input_bytes,
        format,
    ))
}

fn image_sidecar_fields_from_extract(
    result: mosaic_media::SidecarExtractResult,
) -> ImageInspectResult {
    let mut fields = empty_image_inspect_result(0);
    let Some(extracted) = result.fields else {
        return fields;
    };
    if let Some(value) = extracted.device_timestamp_ms {
        fields.has_device_timestamp_ms = true;
        fields.device_timestamp_ms = value;
        append_encoded_sidecar_field(
            &mut fields.encoded_sidecar_fields,
            mosaic_domain::metadata_field_tags::DEVICE_TIMESTAMP_MS,
            &value.to_le_bytes(),
        );
    }
    if let Some(value) = extracted.camera_make {
        append_encoded_sidecar_field(
            &mut fields.encoded_sidecar_fields,
            mosaic_domain::metadata_field_tags::CAMERA_MAKE,
            value.as_bytes(),
        );
        fields.camera_make = value;
    }
    if let Some(value) = extracted.camera_model {
        append_encoded_sidecar_field(
            &mut fields.encoded_sidecar_fields,
            mosaic_domain::metadata_field_tags::CAMERA_MODEL,
            value.as_bytes(),
        );
        fields.camera_model = value;
    }
    if let Some(value) = extracted.subseconds_ms {
        fields.has_subseconds_ms = true;
        fields.subseconds_ms = value;
        append_encoded_sidecar_field(
            &mut fields.encoded_sidecar_fields,
            mosaic_domain::metadata_field_tags::SUBSECONDS_MS,
            &value.to_le_bytes(),
        );
    }
    if let Some(value) = extracted.gps {
        fields.has_gps = true;
        fields.gps_lat_microdegrees = value.lat_microdegrees;
        fields.gps_lon_microdegrees = value.lon_microdegrees;
        fields.gps_altitude_meters = value.altitude_meters;
        fields.gps_accuracy_meters = value.accuracy_meters;
        append_encoded_sidecar_field(
            &mut fields.encoded_sidecar_fields,
            mosaic_domain::metadata_field_tags::GPS,
            &value.to_tag_value_bytes(),
        );
    }
    fields
}

fn append_encoded_sidecar_field(encoded: &mut Vec<u8>, tag: u16, value: &[u8]) {
    let Ok(value_len) = u32::try_from(value.len()) else {
        return;
    };
    encoded.extend_from_slice(&tag.to_le_bytes());
    encoded.extend_from_slice(&value_len.to_le_bytes());
    encoded.extend_from_slice(value);
}

fn video_inspect_result_from_media(result: mosaic_media::VideoInspectResult) -> VideoInspectResult {
    VideoInspectResult {
        code: result.code,
        container: video_container_label(result.container).to_owned(),
        video_codec: result
            .video_codec
            .map_or_else(String::new, |codec| video_codec_label(codec).to_owned()),
        width_px: result.width_px,
        height_px: result.height_px,
        duration_ms: result.duration_ms,
        frame_rate_fps: result.frame_rate_fps.map_or(f64::NAN, f64::from),
        orientation: result.orientation.map_or_else(String::new, |orientation| {
            orientation_label(orientation).to_owned()
        }),
    }
}

const fn media_tier_dimensions(dimensions: mosaic_media::TierDimensions) -> MediaTierDimensions {
    MediaTierDimensions {
        tier: dimensions.tier.to_byte(),
        width: dimensions.width,
        height: dimensions.height,
    }
}

fn canonical_tier_layout_result() -> MediaTierLayoutResult {
    let layout = mosaic_media::plan_tier_layout(
        mosaic_media::ORIGINAL_MAX_DIMENSION,
        mosaic_media::ORIGINAL_MAX_DIMENSION,
    )
    .expect("canonical original dimensions must be valid");
    MediaTierLayoutResult {
        code: mosaic_client::ClientErrorCode::Ok.as_u16(),
        thumbnail: media_tier_dimensions(layout.thumbnail),
        preview: media_tier_dimensions(layout.preview),
        original: media_tier_dimensions(layout.original),
    }
}

fn js_media_tier_dimensions_from_rust(dimensions: MediaTierDimensions) -> JsMediaTierDimensions {
    JsMediaTierDimensions {
        tier: dimensions.tier,
        width: dimensions.width,
        height: dimensions.height,
    }
}

fn js_media_tier_layout_from_rust(result: MediaTierLayoutResult) -> JsMediaTierLayoutResult {
    JsMediaTierLayoutResult {
        code: result.code,
        thumbnail: result.thumbnail,
        preview: result.preview,
        original: result.original,
    }
}

fn js_strip_result_from_rust(result: StripResult) -> JsStripResult {
    JsStripResult {
        code: result.code,
        stripped_bytes: result.stripped_bytes,
        removed_metadata_count: result.removed_metadata_count,
    }
}

fn js_image_inspect_result_from_rust(result: ImageInspectResult) -> JsImageInspectResult {
    JsImageInspectResult {
        code: result.code,
        format: result.format,
        mime_type: result.mime_type,
        width: result.width,
        height: result.height,
        orientation: result.orientation,
        encoded_sidecar_fields: result.encoded_sidecar_fields,
        camera_make: result.camera_make,
        camera_model: result.camera_model,
        device_timestamp_ms: result.device_timestamp_ms,
        has_device_timestamp_ms: result.has_device_timestamp_ms,
        subseconds_ms: result.subseconds_ms,
        has_subseconds_ms: result.has_subseconds_ms,
        gps_lat_microdegrees: result.gps_lat_microdegrees,
        gps_lon_microdegrees: result.gps_lon_microdegrees,
        gps_altitude_meters: result.gps_altitude_meters,
        gps_accuracy_meters: result.gps_accuracy_meters,
        has_gps: result.has_gps,
    }
}

fn js_video_inspect_result_from_rust(result: VideoInspectResult) -> JsVideoInspectResult {
    JsVideoInspectResult {
        code: result.code,
        container: result.container,
        video_codec: result.video_codec,
        width_px: result.width_px,
        height_px: result.height_px,
        duration_ms: result.duration_ms,
        frame_rate_fps: result.frame_rate_fps,
        orientation: result.orientation,
    }
}

/// Returns the canonical media tier dimensions shared by web and native clients.
#[must_use]
pub fn canonical_tier_layout() -> MediaTierLayoutResult {
    canonical_tier_layout_result()
}

/// Returns the canonical media tier dimensions through WASM.
#[wasm_bindgen(js_name = canonicalTierLayout)]
#[must_use]
pub fn canonical_tier_layout_js() -> JsMediaTierLayoutResult {
    js_media_tier_layout_from_rust(canonical_tier_layout_result())
}

/// Strips JPEG metadata through the shared Rust media parser.
#[wasm_bindgen(js_name = stripJpegMetadata)]
#[must_use]
pub fn strip_jpeg_metadata_js(input_bytes: Vec<u8>) -> JsStripResult {
    js_strip_result_from_rust(strip_metadata(mosaic_media::MediaFormat::Jpeg, input_bytes))
}

/// Strips PNG metadata through the shared Rust media parser.
#[wasm_bindgen(js_name = stripPngMetadata)]
#[must_use]
pub fn strip_png_metadata_js(input_bytes: Vec<u8>) -> JsStripResult {
    js_strip_result_from_rust(strip_metadata(mosaic_media::MediaFormat::Png, input_bytes))
}

/// Strips WebP metadata through the shared Rust media parser.
#[wasm_bindgen(js_name = stripWebpMetadata)]
#[must_use]
pub fn strip_webp_metadata_js(input_bytes: Vec<u8>) -> JsStripResult {
    js_strip_result_from_rust(strip_metadata(mosaic_media::MediaFormat::WebP, input_bytes))
}

/// Strips AVIF metadata through the shared Rust media parser.
#[wasm_bindgen(js_name = stripAvifMetadata)]
#[must_use]
pub fn strip_avif_metadata_js(input_bytes: Vec<u8>) -> JsStripResult {
    js_strip_result_from_rust(strip_with_result(mosaic_media::strip_avif_metadata(
        &input_bytes,
    )))
}

/// Strips HEIC/HEIF metadata through the shared Rust media parser.
#[wasm_bindgen(js_name = stripHeicMetadata)]
#[must_use]
pub fn strip_heic_metadata_js(input_bytes: Vec<u8>) -> JsStripResult {
    js_strip_result_from_rust(strip_with_result(mosaic_media::strip_heic_metadata(
        &input_bytes,
    )))
}

/// Strips video container metadata through the shared Rust media parser.
#[wasm_bindgen(js_name = stripVideoMetadata)]
#[must_use]
pub fn strip_video_metadata_js(input_bytes: Vec<u8>) -> JsStripResult {
    js_strip_result_from_rust(strip_with_result(mosaic_media::strip_video_metadata(
        &input_bytes,
    )))
}

/// Inspects image container metadata through the shared Rust media parser.
#[wasm_bindgen(js_name = inspectImage)]
#[must_use]
pub fn inspect_image_js(input_bytes: Vec<u8>) -> JsImageInspectResult {
    js_image_inspect_result_from_rust(image_inspect_result_from_media(
        mosaic_media::inspect_image(&input_bytes),
        &input_bytes,
    ))
}

/// Inspects video container metadata through the shared Rust media parser.
#[wasm_bindgen(js_name = inspectVideoContainer)]
#[must_use]
pub fn inspect_video_container_js(input_bytes: Vec<u8>) -> JsVideoInspectResult {
    js_video_inspect_result_from_rust(video_inspect_result_from_media(
        mosaic_media::inspect_video_container(&input_bytes),
    ))
}

/// Unwraps an account key through the generated WASM binding surface.
#[wasm_bindgen(js_name = unlockAccountKey)]
#[must_use]
pub fn unlock_account_key_js(
    password: Vec<u8>,
    user_salt: Vec<u8>,
    account_salt: Vec<u8>,
    wrapped_account_key: Vec<u8>,
    kdf_memory_kib: u32,
    kdf_iterations: u32,
    kdf_parallelism: u32,
) -> JsAccountUnlockResult {
    js_account_unlock_result_from_rust(unlock_account_key(
        password,
        AccountUnlockRequest {
            user_salt,
            account_salt,
            wrapped_account_key,
            kdf_memory_kib,
            kdf_iterations,
            kdf_parallelism,
        },
    ))
}

/// Creates a fresh account-key handle through the generated WASM binding
/// surface. Returns the opaque handle plus the wrapped account key the
/// caller must persist on the server for future logins.
#[wasm_bindgen(js_name = createAccount)]
#[must_use]
pub fn create_account_js(
    password: Vec<u8>,
    user_salt: Vec<u8>,
    account_salt: Vec<u8>,
    kdf_memory_kib: u32,
    kdf_iterations: u32,
    kdf_parallelism: u32,
) -> JsCreateAccountResult {
    js_create_account_result_from_rust(create_new_account(
        password,
        user_salt,
        account_salt,
        kdf_memory_kib,
        kdf_iterations,
        kdf_parallelism,
    ))
}

/// Returns account-key handle status through WASM.
#[wasm_bindgen(js_name = accountKeyHandleIsOpen)]
#[must_use]
pub fn account_key_handle_is_open_js(handle: u64) -> JsAccountKeyHandleStatusResult {
    js_account_status_result_from_rust(account_key_handle_is_open(handle))
}

/// Closes an account-key handle through WASM.
#[wasm_bindgen(js_name = closeAccountKeyHandle)]
#[must_use]
pub fn close_account_key_handle_js(handle: u64) -> u16 {
    close_account_key_handle(handle)
}

/// Creates a new identity handle through the generated WASM binding surface.
#[wasm_bindgen(js_name = createIdentityHandle)]
#[must_use]
pub fn create_identity_handle_js(account_key_handle: u64) -> JsIdentityHandleResult {
    js_identity_result_from_rust(create_identity_handle(account_key_handle))
}

/// Opens an identity handle through the generated WASM binding surface.
#[wasm_bindgen(js_name = openIdentityHandle)]
#[must_use]
pub fn open_identity_handle_js(
    wrapped_identity_seed: Vec<u8>,
    account_key_handle: u64,
) -> JsIdentityHandleResult {
    js_identity_result_from_rust(open_identity_handle(
        wrapped_identity_seed,
        account_key_handle,
    ))
}

/// Returns an identity handle's Ed25519 public key through WASM.
#[wasm_bindgen(js_name = identitySigningPubkey)]
#[must_use]
pub fn identity_signing_pubkey_js(handle: u64) -> JsBytesResult {
    js_bytes_result_from_rust(identity_signing_pubkey(handle))
}

/// Returns an identity handle's X25519 public key through WASM.
#[wasm_bindgen(js_name = identityEncryptionPubkey)]
#[must_use]
pub fn identity_encryption_pubkey_js(handle: u64) -> JsBytesResult {
    js_bytes_result_from_rust(identity_encryption_pubkey(handle))
}

/// Signs manifest transcript bytes through WASM.
#[wasm_bindgen(js_name = signManifestWithIdentity)]
#[must_use]
pub fn sign_manifest_with_identity_js(handle: u64, transcript_bytes: Vec<u8>) -> JsBytesResult {
    js_bytes_result_from_rust(sign_manifest_with_identity(handle, transcript_bytes))
}

/// Verifies manifest transcript bytes through WASM.
#[wasm_bindgen(js_name = verifyManifestWithIdentity)]
#[must_use]
pub fn verify_manifest_with_identity_js(
    transcript_bytes: Vec<u8>,
    signature: Vec<u8>,
    public_key: Vec<u8>,
) -> u16 {
    verify_manifest_with_identity(transcript_bytes, signature, public_key)
}

/// Signs manifest transcript bytes with the per-epoch manifest signing key
/// attached to an epoch handle through WASM.
#[wasm_bindgen(js_name = signManifestWithEpochHandle)]
#[must_use]
pub fn sign_manifest_with_epoch_handle_js(handle: u64, transcript_bytes: Vec<u8>) -> JsBytesResult {
    js_bytes_result_from_rust(sign_manifest_with_epoch_handle(handle, transcript_bytes))
}

/// Verifies manifest transcript bytes with a per-epoch manifest signing
/// public key through WASM.
#[wasm_bindgen(js_name = verifyManifestWithEpoch)]
#[must_use]
pub fn verify_manifest_with_epoch_js(
    transcript_bytes: Vec<u8>,
    signature: Vec<u8>,
    public_key: Vec<u8>,
) -> u16 {
    verify_manifest_with_epoch(transcript_bytes, signature, public_key)
}

/// Builds canonical metadata sidecar bytes through WASM.
#[wasm_bindgen(js_name = canonicalMetadataSidecarBytes)]
#[must_use]
pub fn canonical_metadata_sidecar_bytes_js(
    album_id: Vec<u8>,
    photo_id: Vec<u8>,
    epoch_id: u32,
    encoded_fields: Vec<u8>,
) -> JsBytesResult {
    js_bytes_result_from_rust(canonical_metadata_sidecar_bytes(
        album_id,
        photo_id,
        epoch_id,
        encoded_fields,
    ))
}

/// Builds canonical video metadata sidecar bytes through WASM.
#[wasm_bindgen(js_name = canonicalVideoSidecarBytes)]
#[must_use]
pub fn canonical_video_sidecar_bytes_js(
    album_id: Vec<u8>,
    photo_id: Vec<u8>,
    epoch_id: u32,
    input_bytes: Vec<u8>,
) -> JsBytesResult {
    js_bytes_result_from_rust(video_metadata_sidecar_bytes(
        album_id,
        photo_id,
        epoch_id,
        input_bytes,
    ))
}

/// Builds canonical manifest transcript bytes through WASM.
///
/// `encoded_shards` is a repeated sequence of
/// `chunk_index:u32le | tier:u8 | shard_id:16 bytes | sha256:32 bytes`.
#[wasm_bindgen(js_name = manifestTranscriptBytes)]
#[must_use]
pub fn manifest_transcript_bytes_js(
    album_id: Vec<u8>,
    epoch_id: u32,
    encrypted_meta: Vec<u8>,
    encoded_shards: Vec<u8>,
) -> JsBytesResult {
    js_bytes_result_from_rust(manifest_transcript_bytes(
        album_id,
        epoch_id,
        encrypted_meta,
        encoded_shards,
    ))
}

/// Returns the ADR-022 canonical manifest-finalize idempotency key through WASM.
#[wasm_bindgen(js_name = finalizeIdempotencyKey)]
pub fn finalize_idempotency_key_js(job_id: String) -> Result<String, JsError> {
    finalize_idempotency_key(job_id).map_err(|_| JsError::new("invalid UUIDv7"))
}

/// Encrypts metadata sidecar bytes with an epoch handle through WASM.
#[wasm_bindgen(js_name = encryptMetadataSidecarWithEpochHandle)]
#[must_use]
pub fn encrypt_metadata_sidecar_with_epoch_handle_js(
    handle: u64,
    album_id: Vec<u8>,
    photo_id: Vec<u8>,
    epoch_id: u32,
    encoded_fields: Vec<u8>,
    shard_index: u32,
) -> JsEncryptedShardResult {
    js_encrypted_shard_result_from_rust(encrypt_metadata_sidecar_with_epoch_handle(
        handle,
        album_id,
        photo_id,
        epoch_id,
        encoded_fields,
        shard_index,
    ))
}

/// Creates a new epoch-key handle through WASM.
#[wasm_bindgen(js_name = createEpochKeyHandle)]
#[must_use]
pub fn create_epoch_key_handle_js(
    account_key_handle: u64,
    epoch_id: u32,
) -> JsEpochKeyHandleResult {
    js_epoch_result_from_rust(create_epoch_key_handle(account_key_handle, epoch_id))
}

/// Opens an epoch-key handle through WASM.
#[wasm_bindgen(js_name = openEpochKeyHandle)]
#[must_use]
pub fn open_epoch_key_handle_js(
    wrapped_epoch_seed: Vec<u8>,
    account_key_handle: u64,
    epoch_id: u32,
) -> JsEpochKeyHandleResult {
    js_epoch_result_from_rust(open_epoch_key_handle(
        wrapped_epoch_seed,
        account_key_handle,
        epoch_id,
    ))
}

/// Returns epoch-key handle status through WASM.
#[wasm_bindgen(js_name = epochKeyHandleIsOpen)]
#[must_use]
pub fn epoch_key_handle_is_open_js(handle: u64) -> JsEpochKeyHandleStatusResult {
    js_epoch_status_result_from_rust(epoch_key_handle_is_open(handle))
}

/// Closes an epoch-key handle through WASM.
#[wasm_bindgen(js_name = closeEpochKeyHandle)]
#[must_use]
pub fn close_epoch_key_handle_js(handle: u64) -> u16 {
    close_epoch_key_handle(handle)
}

/// Encrypts shard bytes with an epoch-key handle through WASM.
#[wasm_bindgen(js_name = encryptShardWithEpochHandle)]
#[must_use]
pub fn encrypt_shard_with_epoch_handle_js(
    handle: u64,
    plaintext: Vec<u8>,
    shard_index: u32,
    tier_byte: u8,
) -> JsEncryptedShardResult {
    js_encrypted_shard_result_from_rust(encrypt_shard_with_epoch_handle(
        handle,
        plaintext,
        shard_index,
        tier_byte,
    ))
}

/// Decrypts shard envelope bytes with an epoch-key handle through WASM.
#[wasm_bindgen(js_name = decryptShardWithEpochHandle)]
#[must_use]
pub fn decrypt_shard_with_epoch_handle_js(
    handle: u64,
    envelope_bytes: Vec<u8>,
) -> JsDecryptedShardResult {
    js_decrypted_shard_result_from_rust(decrypt_shard_with_epoch_handle(handle, envelope_bytes))
}

/// Encrypts shard bytes with an epoch-key handle and typed shard tier through WASM.
#[wasm_bindgen(js_name = encryptShardWithTier)]
#[must_use]
pub fn encrypt_shard_with_tier_js(
    handle: u64,
    plaintext: Vec<u8>,
    shard_index: u32,
    tier: ShardTier,
) -> JsEncryptedShardResult {
    js_encrypted_shard_result_from_rust(encrypt_shard_with_tier(
        handle,
        plaintext,
        shard_index,
        tier,
    ))
}

/// Decrypts shard envelope bytes with an epoch-key handle through WASM.
///
/// The shard tier is read from the envelope header by the client core.
#[wasm_bindgen(js_name = decryptShardWithTier)]
#[must_use]
pub fn decrypt_shard_with_tier_js(handle: u64, envelope_bytes: Vec<u8>) -> JsBytesResult {
    js_bytes_result_from_rust(decrypt_shard_with_tier(handle, envelope_bytes))
}

/// Decrypts a legacy raw-key shard envelope with an epoch-key handle through WASM.
#[wasm_bindgen(js_name = decryptShardWithLegacyRawKeyHandle)]
#[must_use]
pub fn decrypt_shard_with_legacy_raw_key_handle_js(
    handle: u64,
    envelope_bytes: Vec<u8>,
) -> JsDecryptedShardResult {
    js_decrypted_shard_result_from_rust(decrypt_shard_with_legacy_raw_key_handle(
        handle,
        envelope_bytes,
    ))
}

/// Returns deterministic public crypto/domain golden vectors through WASM.
#[wasm_bindgen(js_name = cryptoDomainGoldenVectorSnapshot)]
#[must_use]
pub fn crypto_domain_golden_vector_snapshot_js() -> JsCryptoDomainGoldenVectorSnapshot {
    js_crypto_domain_vector_from_rust(crypto_domain_golden_vector_snapshot())
}

/// Returns the client-core state machine surface through WASM.
#[wasm_bindgen(js_name = clientCoreStateMachineSnapshot)]
#[must_use]
pub fn client_core_state_machine_snapshot_js() -> String {
    client_core_state_machine_snapshot()
}

/// Initializes a client-core upload job through a primitive WASM proof surface.
#[wasm_bindgen(js_name = initUploadJob)]
#[must_use]
pub fn init_upload_job_js(
    job_id: String,
    album_id: String,
    asset_id: String,
    idempotency_key: String,
    max_retry_count: u8,
) -> String {
    upload_job_result_json(init_upload_job(ClientCoreUploadJobRequest {
        job_id,
        album_id,
        asset_id,
        idempotency_key,
        max_retry_count,
    }))
}

/// Advances a client-core upload job through a primitive WASM proof surface.
#[wasm_bindgen(js_name = advanceUploadJob)]
#[allow(clippy::too_many_arguments)]
#[must_use]
pub fn advance_upload_job_js(
    job_id: String,
    album_id: String,
    idempotency_key: String,
    phase: String,
    retry_count: u32,
    max_retry_count: u8,
    next_retry_not_before_ms: i64,
    has_next_retry_not_before_ms: bool,
    snapshot_revision: u64,
    last_effect_id: String,
    event_kind: String,
    event_effect_id: String,
    event_tier: u8,
    event_shard_index: u32,
    event_shard_id: String,
    event_sha256: Vec<u8>,
    event_content_length: u64,
    event_envelope_version: u8,
    event_asset_id: String,
    event_since_metadata_version: u64,
    event_recovery_outcome: String,
    event_now_ms: i64,
    event_base_backoff_ms: u64,
    event_server_retry_after_ms: u64,
    event_has_server_retry_after_ms: bool,
    event_error_code: u16,
    event_target_phase: String,
) -> String {
    upload_job_transition_result_json(advance_upload_job(
        ClientCoreUploadJobSnapshot {
            schema_version: 1,
            job_id,
            album_id,
            phase,
            retry_count,
            max_retry_count,
            next_retry_not_before_ms,
            has_next_retry_not_before_ms,
            idempotency_key,
            tiered_shards: Vec::new(),
            shard_set_hash: Vec::new(),
            snapshot_revision,
            last_effect_id: last_effect_id.clone(),
            last_acknowledged_effect_id: String::new(),
            last_applied_event_id: last_effect_id,
            failure_code: 0,
        },
        ClientCoreUploadJobEvent {
            kind: event_kind.clone(),
            effect_id: event_effect_id,
            tier: event_tier,
            shard_index: event_shard_index,
            shard_id: event_shard_id,
            sha256: event_sha256,
            content_length: event_content_length,
            envelope_version: event_envelope_version,
            uploaded: event_kind == "ShardUploaded",
            tiered_shards: Vec::new(),
            shard_set_hash: Vec::new(),
            asset_id: event_asset_id,
            since_metadata_version: event_since_metadata_version,
            recovery_outcome: event_recovery_outcome,
            now_ms: event_now_ms,
            base_backoff_ms: event_base_backoff_ms,
            server_retry_after_ms: event_server_retry_after_ms,
            has_server_retry_after_ms: event_has_server_retry_after_ms,
            has_error_code: event_error_code != 0,
            error_code: event_error_code,
            target_phase: event_target_phase,
        },
    ))
}

/// Initializes an album sync coordinator through a primitive WASM proof surface.
#[wasm_bindgen(js_name = initAlbumSync)]
#[must_use]
pub fn init_album_sync_js(
    album_id: String,
    request_id: String,
    start_cursor: String,
    now_unix_ms: u64,
    max_retry_count: u32,
) -> String {
    album_sync_result_json(init_album_sync(ClientCoreAlbumSyncRequest {
        album_id,
        request_id,
        start_cursor,
        now_unix_ms,
        max_retry_count,
    }))
}

/// Advances an album sync coordinator through a primitive WASM proof surface.
#[wasm_bindgen(js_name = advanceAlbumSync)]
#[allow(clippy::too_many_arguments)]
#[must_use]
pub fn advance_album_sync_js(
    album_id: String,
    phase: String,
    active_cursor: String,
    pending_cursor: String,
    rerun_requested: bool,
    retry_count: u32,
    max_retry_count: u32,
    next_retry_unix_ms: u64,
    last_error_code: u16,
    last_error_stage: String,
    updated_at_unix_ms: u64,
    event_kind: String,
    fetched_cursor: String,
    next_cursor: String,
    applied_count: u32,
    retry_after_unix_ms: u64,
    event_error_code: u16,
) -> String {
    album_sync_transition_result_json(advance_album_sync(
        ClientCoreAlbumSyncSnapshot {
            schema_version: 1,
            album_id,
            phase,
            active_cursor,
            pending_cursor,
            rerun_requested,
            retry_count,
            max_retry_count,
            next_retry_unix_ms,
            last_error_code,
            last_error_stage,
            updated_at_unix_ms,
        },
        ClientCoreAlbumSyncEvent {
            kind: event_kind.clone(),
            fetched_cursor,
            next_cursor,
            applied_count,
            observed_asset_ids: Vec::new(),
            retry_after_unix_ms,
            has_error_code: event_error_code != 0,
            error_code: event_error_code,
        },
    ))
}

/// Closes an identity handle through WASM.
#[wasm_bindgen(js_name = closeIdentityHandle)]
#[must_use]
pub fn close_identity_handle_js(handle: u64) -> u16 {
    close_identity_handle(handle)
}

/// Wraps `plaintext` with the L2 account key referenced by `account_handle`
/// through WASM. The L2 bytes never cross the JS boundary.
#[wasm_bindgen(js_name = wrapWithAccountHandle)]
#[must_use]
pub fn wrap_with_account_handle_js(account_handle: u64, plaintext: Vec<u8>) -> JsBytesResult {
    js_bytes_result_from_rust(wrap_with_account_handle(account_handle, plaintext))
}

/// Unwraps `wrapped` with the L2 account key referenced by `account_handle`
/// through WASM.
#[wasm_bindgen(js_name = unwrapWithAccountHandle)]
#[must_use]
pub fn unwrap_with_account_handle_js(account_handle: u64, wrapped: Vec<u8>) -> JsBytesResult {
    js_bytes_result_from_rust(unwrap_with_account_handle(account_handle, wrapped))
}

/// Builds the canonical LocalAuth challenge transcript through WASM.
///
/// `timestamp_ms_present == false` omits the timestamp segment.
#[wasm_bindgen(js_name = buildAuthChallengeTranscript)]
#[must_use]
pub fn build_auth_challenge_transcript_js(
    username: String,
    timestamp_ms: u64,
    timestamp_ms_present: bool,
    challenge: Vec<u8>,
) -> JsBytesResult {
    js_bytes_result_from_rust(build_auth_challenge_transcript(
        username,
        timestamp_ms,
        timestamp_ms_present,
        challenge,
    ))
}

/// Derives the LocalAuth Ed25519 keypair from an account-key handle through WASM.
#[wasm_bindgen(js_name = deriveAuthKeypairFromAccount)]
#[must_use]
pub fn derive_auth_keypair_from_account_js(account_handle: u64) -> JsAuthKeypairResult {
    js_auth_keypair_result_from_rust(derive_auth_keypair_from_account(account_handle))
}

/// Signs a LocalAuth challenge transcript with an account-key handle through WASM.
#[wasm_bindgen(js_name = signAuthChallengeWithAccount)]
#[must_use]
pub fn sign_auth_challenge_with_account_js(
    account_handle: u64,
    challenge_bytes: Vec<u8>,
) -> JsBytesResult {
    js_bytes_result_from_rust(sign_auth_challenge_with_account(
        account_handle,
        challenge_bytes,
    ))
}

/// Returns the LocalAuth Ed25519 public key for an account-key handle through WASM.
#[wasm_bindgen(js_name = getAuthPublicKeyFromAccount)]
#[must_use]
pub fn get_auth_public_key_from_account_js(account_handle: u64) -> JsBytesResult {
    js_bytes_result_from_rust(get_auth_public_key_from_account(account_handle))
}

/// Derives the password-rooted LocalAuth Ed25519 keypair through WASM.
///
/// Used by the worker's `deriveAuthKey()` pre-auth slot to mint an auth
/// keypair before the account handle is opened. Only the 32-byte public
/// key crosses the WASM boundary.
#[wasm_bindgen(js_name = deriveAuthKeypairFromPassword)]
#[must_use]
pub fn derive_auth_keypair_from_password_js(
    password: Vec<u8>,
    user_salt: Vec<u8>,
    kdf_memory_kib: u32,
    kdf_iterations: u32,
    kdf_parallelism: u32,
) -> JsAuthKeypairResult {
    js_auth_keypair_result_from_rust(derive_auth_keypair_from_password(
        password,
        user_salt,
        kdf_memory_kib,
        kdf_iterations,
        kdf_parallelism,
    ))
}

/// Signs a LocalAuth challenge transcript with the password-rooted auth
/// keypair through WASM.
#[wasm_bindgen(js_name = signAuthChallengeWithPassword)]
#[must_use]
pub fn sign_auth_challenge_with_password_js(
    password: Vec<u8>,
    user_salt: Vec<u8>,
    kdf_memory_kib: u32,
    kdf_iterations: u32,
    kdf_parallelism: u32,
    transcript_bytes: Vec<u8>,
) -> JsBytesResult {
    js_bytes_result_from_rust(sign_auth_challenge_with_password(
        password,
        user_salt,
        kdf_memory_kib,
        kdf_iterations,
        kdf_parallelism,
        transcript_bytes,
    ))
}

/// Returns the LocalAuth Ed25519 public key derived from `password` +
/// `user_salt` through WASM.
#[wasm_bindgen(js_name = getAuthPublicKeyFromPassword)]
#[must_use]
pub fn get_auth_public_key_from_password_js(
    password: Vec<u8>,
    user_salt: Vec<u8>,
    kdf_memory_kib: u32,
    kdf_iterations: u32,
    kdf_parallelism: u32,
) -> JsBytesResult {
    js_bytes_result_from_rust(get_auth_public_key_from_password(
        password,
        user_salt,
        kdf_memory_kib,
        kdf_iterations,
        kdf_parallelism,
    ))
}

/// Creates a share-link handle and first wrapped tier through WASM.
#[wasm_bindgen(js_name = createLinkShareHandle)]
#[must_use]
pub fn create_link_share_handle_js(
    album_id: String,
    epoch_handle: u64,
    tier_byte: u8,
) -> JsCreateLinkShareHandleResult {
    js_create_link_share_handle_result_from_rust(create_link_share_handle(
        album_id,
        epoch_handle,
        tier_byte,
    ))
}

/// Imports a URL fragment seed into a share-link handle through WASM.
#[wasm_bindgen(js_name = importLinkShareHandle)]
#[must_use]
pub fn import_link_share_handle_js(link_url_token: Vec<u8>) -> JsLinkTierHandleResult {
    js_link_tier_handle_result_from_rust(import_link_share_handle(link_url_token))
}

/// Wraps an epoch tier for an existing share-link handle through WASM.
#[wasm_bindgen(js_name = wrapLinkTierHandle)]
#[must_use]
pub fn wrap_link_tier_handle_js(
    link_share_handle: u64,
    epoch_handle: u64,
    tier_byte: u8,
) -> JsWrappedTierKeyResult {
    js_wrapped_tier_key_result_from_rust(wrap_link_tier_handle(
        link_share_handle,
        epoch_handle,
        tier_byte,
    ))
}

/// Imports a wrapped tier key into a link-tier handle through WASM.
#[wasm_bindgen(js_name = importLinkTierHandle)]
#[must_use]
pub fn import_link_tier_handle_js(
    link_url_token: Vec<u8>,
    nonce: Vec<u8>,
    encrypted_key: Vec<u8>,
    album_id: String,
    tier_byte: u8,
) -> JsLinkTierHandleResult {
    js_link_tier_handle_result_from_rust(import_link_tier_handle(
        link_url_token,
        nonce,
        encrypted_key,
        album_id,
        tier_byte,
    ))
}

/// Decrypts a shard using a link-tier handle through WASM.
#[wasm_bindgen(js_name = decryptShardWithLinkTierHandle)]
#[must_use]
pub fn decrypt_shard_with_link_tier_handle_js(
    link_tier_handle: u64,
    envelope_bytes: Vec<u8>,
) -> JsDecryptedShardResult {
    js_decrypted_shard_result_from_rust(decrypt_shard_with_link_tier_handle(
        link_tier_handle,
        envelope_bytes,
    ))
}

/// Closes a share-link handle through WASM.
#[wasm_bindgen(js_name = closeLinkShareHandle)]
#[must_use]
pub fn close_link_share_handle_js(handle: u64) -> u16 {
    close_link_share_handle(handle)
}

/// Closes a link-tier handle through WASM.
#[wasm_bindgen(js_name = closeLinkTierHandle)]
#[must_use]
pub fn close_link_tier_handle_js(handle: u64) -> u16 {
    close_link_tier_handle(handle)
}

/// Verifies and imports a sealed epoch key bundle through WASM.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen(js_name = verifyAndImportEpochBundle)]
#[must_use]
pub fn verify_and_import_epoch_bundle_js(
    identity_handle: u64,
    sealed: Vec<u8>,
    signature: Vec<u8>,
    sharer_pubkey: Vec<u8>,
    expected_album_id: String,
    expected_min_epoch: u32,
    allow_legacy_empty: bool,
) -> JsEpochKeyHandleResult {
    js_epoch_result_from_rust(verify_and_import_epoch_bundle(
        identity_handle,
        sealed,
        signature,
        sharer_pubkey,
        expected_album_id,
        expected_min_epoch,
        allow_legacy_empty,
    ))
}

/// Atomically seals an epoch key bundle for `recipient_pubkey` using a
/// Rust-owned epoch handle through WASM. Bundle payload bytes never cross
/// the FFI boundary.
#[wasm_bindgen(js_name = sealBundleWithEpochHandle)]
#[must_use]
pub fn seal_bundle_with_epoch_handle_js(
    identity_handle: u64,
    epoch_handle: u64,
    recipient_pubkey: Vec<u8>,
    album_id: String,
) -> JsSealedBundleResult {
    js_sealed_bundle_result_from_rust(seal_bundle_with_epoch_handle(
        identity_handle,
        epoch_handle,
        recipient_pubkey,
        album_id,
    ))
}

/// Encrypts album content with an epoch handle through WASM.
#[wasm_bindgen(js_name = encryptAlbumContent)]
#[must_use]
pub fn encrypt_album_content_js(epoch_handle: u64, plaintext: Vec<u8>) -> JsEncryptedContentResult {
    js_encrypted_content_result_from_rust(encrypt_album_content(epoch_handle, plaintext))
}

/// Decrypts album content with an epoch handle through WASM.
#[wasm_bindgen(js_name = decryptAlbumContent)]
#[must_use]
pub fn decrypt_album_content_js(
    epoch_handle: u64,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
) -> JsDecryptedContentResult {
    js_decrypted_content_result_from_rust(decrypt_album_content(epoch_handle, nonce, ciphertext))
}

fn header_result_from_client(result: mosaic_client::HeaderResult) -> HeaderResult {
    HeaderResult {
        code: result.code.as_u16(),
        epoch_id: result.epoch_id,
        shard_index: result.shard_index,
        tier: result.tier,
        nonce: result.nonce,
    }
}

fn progress_result_from_client(result: mosaic_client::ProgressResult) -> ProgressResult {
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

fn account_unlock_result_from_client(
    result: mosaic_client::AccountUnlockResult,
) -> AccountUnlockResult {
    AccountUnlockResult {
        code: result.code.as_u16(),
        handle: result.handle,
    }
}

fn create_account_result_from_client(
    result: mosaic_client::CreateAccountResult,
) -> CreateAccountResult {
    CreateAccountResult {
        code: result.code.as_u16(),
        handle: result.handle,
        wrapped_account_key: result.wrapped_account_key,
    }
}

fn account_status_result_from_client(
    result: Result<bool, mosaic_client::ClientError>,
) -> AccountKeyHandleStatusResult {
    match result {
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

fn epoch_result_from_client(result: mosaic_client::EpochKeyHandleResult) -> EpochKeyHandleResult {
    EpochKeyHandleResult {
        code: result.code.as_u16(),
        handle: result.handle,
        epoch_id: result.epoch_id,
        wrapped_epoch_seed: result.wrapped_epoch_seed,
        sign_public_key: result.sign_public_key,
    }
}

fn bytes_result_from_client(result: mosaic_client::BytesResult) -> BytesResult {
    BytesResult {
        code: result.code.as_u16(),
        bytes: result.bytes,
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

fn auth_keypair_result_from_client(result: mosaic_client::AuthKeypairResult) -> AuthKeypairResult {
    AuthKeypairResult {
        code: result.code.as_u16(),
        auth_public_key: result.auth_public_key,
    }
}

fn create_link_share_handle_result_from_client(
    result: mosaic_client::CreateLinkShareHandleResult,
) -> CreateLinkShareHandleResult {
    CreateLinkShareHandleResult {
        code: result.code.as_u16(),
        handle: result.handle,
        link_id: result.link_id,
        link_url_token: result.link_url_token,
        tier: result.tier,
        nonce: result.nonce,
        encrypted_key: result.encrypted_key,
    }
}

fn link_tier_handle_result_from_client(
    result: mosaic_client::LinkTierHandleResult,
) -> LinkTierHandleResult {
    LinkTierHandleResult {
        code: result.code.as_u16(),
        handle: result.handle,
        link_id: result.link_id,
        tier: result.tier,
    }
}

fn wrapped_tier_key_result_from_client(
    result: mosaic_client::WrappedTierKeyResult,
) -> WrappedTierKeyResult {
    WrappedTierKeyResult {
        code: result.code.as_u16(),
        tier: result.tier,
        nonce: result.nonce,
        encrypted_key: result.encrypted_key,
    }
}

fn sealed_bundle_result_from_client(
    result: mosaic_client::SealedBundleResult,
) -> SealedBundleResult {
    SealedBundleResult {
        code: result.code.as_u16(),
        sealed: result.sealed,
        signature: result.signature,
        sharer_pubkey: result.sharer_pubkey,
    }
}

fn encrypted_content_result_from_client(
    result: mosaic_client::EncryptedContentResult,
) -> EncryptedContentResult {
    EncryptedContentResult {
        code: result.code.as_u16(),
        nonce: result.nonce,
        ciphertext: result.ciphertext,
    }
}

fn decrypted_content_result_from_client(
    mut result: mosaic_client::DecryptedContentResult,
) -> DecryptedContentResult {
    DecryptedContentResult {
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

/// Converts a stable `ClientErrorCode` number at the WASM boundary.
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

fn upload_job_result_json(result: ClientCoreUploadJobResult) -> String {
    upload_snapshot_json(result.code, &result.snapshot)
}

fn upload_job_transition_result_json(result: ClientCoreUploadJobTransitionResult) -> String {
    upload_snapshot_json(result.code, &result.transition.next_snapshot)
}

fn upload_snapshot_json(code: u16, snapshot: &ClientCoreUploadJobSnapshot) -> String {
    format!(
        "{{\"code\":{},\"schemaVersion\":{},\"jobId\":\"{}\",\"albumId\":\"{}\",\"phase\":\"{}\",\"shardRefCount\":{}}}",
        code,
        snapshot.schema_version,
        json_escape(&snapshot.job_id),
        json_escape(&snapshot.album_id),
        json_escape(&snapshot.phase),
        snapshot.tiered_shards.len()
    )
}

fn album_sync_result_json(result: ClientCoreAlbumSyncResult) -> String {
    album_sync_snapshot_json(result.code, &result.snapshot)
}

fn album_sync_transition_result_json(result: ClientCoreAlbumSyncTransitionResult) -> String {
    album_sync_snapshot_json(result.code, &result.transition.snapshot)
}

fn album_sync_snapshot_json(code: u16, snapshot: &ClientCoreAlbumSyncSnapshot) -> String {
    format!(
        "{{\"code\":{},\"schemaVersion\":{},\"albumId\":\"{}\",\"phase\":\"{}\",\"rerunRequested\":{}}}",
        code,
        snapshot.schema_version,
        json_escape(&snapshot.album_id),
        json_escape(&snapshot.phase),
        snapshot.rerun_requested
    )
}

fn json_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            '\u{08}' => escaped.push_str("\\b"),
            '\u{0c}' => escaped.push_str("\\f"),
            character if character.is_control() => {
                escaped.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => escaped.push(character),
        }
    }
    escaped
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

fn manifest_transcript_bytes_result(
    album_id: &[u8],
    epoch_id: u32,
    encrypted_meta: &[u8],
    encoded_shards: &[u8],
) -> Result<Vec<u8>, u16> {
    let album_id = uuid_bytes(album_id)?;
    let shards = manifest_shards_from_encoded(encoded_shards)?;
    let encrypted_meta = mosaic_domain::EncryptedMetadataEnvelope::new(encrypted_meta);
    let transcript =
        mosaic_domain::ManifestTranscript::new(album_id, epoch_id, encrypted_meta, &shards);
    mosaic_domain::canonical_manifest_transcript_bytes(&transcript)
        .map_err(map_manifest_transcript_error)
}

fn uuid_bytes(bytes: &[u8]) -> Result<[u8; 16], u16> {
    if bytes.len() != 16 {
        return Err(mosaic_client::ClientErrorCode::InvalidInputLength.as_u16());
    }
    let mut value = [0_u8; 16];
    value.copy_from_slice(bytes);
    Ok(value)
}

fn sha256_bytes(bytes: &[u8]) -> Result<[u8; 32], u16> {
    if bytes.len() != 32 {
        return Err(mosaic_client::ClientErrorCode::InvalidInputLength.as_u16());
    }
    let mut value = [0_u8; 32];
    value.copy_from_slice(bytes);
    Ok(value)
}

const ENCODED_MANIFEST_SHARD_REF_BYTES: usize = 4 + 1 + 16 + 32;

fn manifest_shards_from_encoded(
    encoded_shards: &[u8],
) -> Result<Vec<mosaic_domain::ManifestShardRef>, u16> {
    let invalid_input_length = mosaic_client::ClientErrorCode::InvalidInputLength.as_u16();
    let chunks = encoded_shards.chunks_exact(ENCODED_MANIFEST_SHARD_REF_BYTES);
    if !chunks.remainder().is_empty() {
        return Err(invalid_input_length);
    }

    let mut shards = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        let chunk_index = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        let tier = mosaic_domain::ShardTier::try_from(chunk[4])
            .map_err(|_| mosaic_client::ClientErrorCode::InvalidTier.as_u16())?;
        let shard_id = uuid_bytes(&chunk[5..21])?;
        let sha256 = sha256_bytes(&chunk[21..53])?;
        shards.push(mosaic_domain::ManifestShardRef::new(
            chunk_index,
            shard_id,
            tier,
            sha256,
        ));
    }
    Ok(shards)
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
        | MetadataSidecarError::UnsortedFieldTag { .. }
        | MetadataSidecarError::InvalidGpsValue { .. } => {
            mosaic_client::ClientErrorCode::MalformedSidecar.as_u16()
        }
    }
}

fn map_manifest_transcript_error(error: mosaic_domain::ManifestTranscriptError) -> u16 {
    match error {
        mosaic_domain::ManifestTranscriptError::LengthTooLarge { .. } => {
            mosaic_client::ClientErrorCode::InvalidInputLength.as_u16()
        }
        mosaic_domain::ManifestTranscriptError::EmptyEncryptedMeta
        | mosaic_domain::ManifestTranscriptError::EmptyShardList
        | mosaic_domain::ManifestTranscriptError::NonSequentialShardIndex { .. } => {
            mosaic_client::ClientErrorCode::InvalidEnvelope.as_u16()
        }
    }
}

fn client_error_code_from_crypto(error: mosaic_crypto::MosaicCryptoError) -> u16 {
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
        mosaic_crypto::MosaicCryptoError::InvalidEnvelope => {
            mosaic_client::ClientErrorCode::InvalidEnvelope.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::MissingCiphertext => {
            mosaic_client::ClientErrorCode::MissingCiphertext.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::AuthenticationFailed => {
            mosaic_client::ClientErrorCode::AuthenticationFailed.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::RngFailure => {
            mosaic_client::ClientErrorCode::RngFailure.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::WrappedKeyTooShort { .. } => {
            mosaic_client::ClientErrorCode::WrappedKeyTooShort.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::KdfProfileTooWeak => {
            mosaic_client::ClientErrorCode::KdfProfileTooWeak.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::KdfProfileTooCostly => {
            mosaic_client::ClientErrorCode::KdfProfileTooCostly.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::InvalidSaltLength { .. } => {
            mosaic_client::ClientErrorCode::InvalidSaltLength.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::KdfFailure => {
            mosaic_client::ClientErrorCode::KdfFailure.as_u16()
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
        mosaic_crypto::MosaicCryptoError::BundleSignatureInvalid => {
            mosaic_client::ClientErrorCode::BundleSignatureInvalid.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::BundleSealOpenFailed => {
            mosaic_client::ClientErrorCode::BundleSealOpenFailed.as_u16()
        }
        mosaic_crypto::MosaicCryptoError::LinkTierMismatch { .. } => {
            mosaic_client::ClientErrorCode::LinkTierMismatch.as_u16()
        }
    }
}

fn js_account_unlock_result_from_rust(result: AccountUnlockResult) -> JsAccountUnlockResult {
    JsAccountUnlockResult {
        code: result.code,
        handle: result.handle,
    }
}

fn js_create_account_result_from_rust(result: CreateAccountResult) -> JsCreateAccountResult {
    JsCreateAccountResult {
        code: result.code,
        handle: result.handle,
        wrapped_account_key: result.wrapped_account_key,
    }
}

fn js_account_status_result_from_rust(
    result: AccountKeyHandleStatusResult,
) -> JsAccountKeyHandleStatusResult {
    JsAccountKeyHandleStatusResult {
        code: result.code,
        is_open: result.is_open,
    }
}

fn js_identity_result_from_rust(result: IdentityHandleResult) -> JsIdentityHandleResult {
    JsIdentityHandleResult {
        code: result.code,
        handle: result.handle,
        signing_pubkey: result.signing_pubkey,
        encryption_pubkey: result.encryption_pubkey,
        wrapped_seed: result.wrapped_seed,
    }
}

fn js_epoch_result_from_rust(result: EpochKeyHandleResult) -> JsEpochKeyHandleResult {
    JsEpochKeyHandleResult {
        code: result.code,
        handle: result.handle,
        epoch_id: result.epoch_id,
        wrapped_epoch_seed: result.wrapped_epoch_seed,
        sign_public_key: result.sign_public_key,
    }
}

fn js_epoch_status_result_from_rust(
    result: EpochKeyHandleStatusResult,
) -> JsEpochKeyHandleStatusResult {
    JsEpochKeyHandleStatusResult {
        code: result.code,
        is_open: result.is_open,
    }
}

fn js_bytes_result_from_rust(result: BytesResult) -> JsBytesResult {
    JsBytesResult {
        code: result.code,
        bytes: result.bytes,
    }
}

fn js_encrypted_shard_result_from_rust(result: EncryptedShardResult) -> JsEncryptedShardResult {
    JsEncryptedShardResult {
        code: result.code,
        envelope_bytes: result.envelope_bytes,
        sha256: result.sha256,
    }
}

fn js_decrypted_shard_result_from_rust(result: DecryptedShardResult) -> JsDecryptedShardResult {
    JsDecryptedShardResult {
        code: result.code,
        plaintext: result.plaintext,
    }
}

fn js_streaming_frame_result_from_rust(result: StreamingFrameResult) -> JsStreamingFrameResult {
    JsStreamingFrameResult {
        code: result.code,
        frame_index: result.frame_index,
        bytes: result.bytes,
    }
}

fn js_streaming_envelope_result_from_rust(
    result: StreamingEnvelopeResult,
) -> JsStreamingEnvelopeResult {
    JsStreamingEnvelopeResult {
        code: result.code,
        header: result.header,
        bytes: result.bytes,
        frame_count: result.frame_count,
        final_frame_size: result.final_frame_size,
    }
}

fn js_auth_keypair_result_from_rust(result: AuthKeypairResult) -> JsAuthKeypairResult {
    JsAuthKeypairResult {
        code: result.code,
        auth_public_key: result.auth_public_key,
    }
}

fn js_create_link_share_handle_result_from_rust(
    result: CreateLinkShareHandleResult,
) -> JsCreateLinkShareHandleResult {
    JsCreateLinkShareHandleResult {
        code: result.code,
        handle: result.handle,
        link_id: result.link_id,
        link_url_token: result.link_url_token,
        tier: result.tier,
        nonce: result.nonce,
        encrypted_key: result.encrypted_key,
    }
}

fn js_link_tier_handle_result_from_rust(result: LinkTierHandleResult) -> JsLinkTierHandleResult {
    JsLinkTierHandleResult {
        code: result.code,
        handle: result.handle,
        link_id: result.link_id,
        tier: result.tier,
    }
}

fn js_wrapped_tier_key_result_from_rust(result: WrappedTierKeyResult) -> JsWrappedTierKeyResult {
    JsWrappedTierKeyResult {
        code: result.code,
        tier: result.tier,
        nonce: result.nonce,
        encrypted_key: result.encrypted_key,
    }
}

fn js_sealed_bundle_result_from_rust(result: SealedBundleResult) -> JsSealedBundleResult {
    JsSealedBundleResult {
        code: result.code,
        sealed: result.sealed,
        signature: result.signature,
        sharer_pubkey: result.sharer_pubkey,
    }
}

fn js_encrypted_content_result_from_rust(
    result: EncryptedContentResult,
) -> JsEncryptedContentResult {
    JsEncryptedContentResult {
        code: result.code,
        nonce: result.nonce,
        ciphertext: result.ciphertext,
    }
}

fn js_decrypted_content_result_from_rust(
    result: DecryptedContentResult,
) -> JsDecryptedContentResult {
    JsDecryptedContentResult {
        code: result.code,
        plaintext: result.plaintext,
    }
}

fn js_crypto_domain_vector_from_rust(
    result: CryptoDomainGoldenVectorSnapshot,
) -> JsCryptoDomainGoldenVectorSnapshot {
    JsCryptoDomainGoldenVectorSnapshot {
        code: result.code,
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

#[cfg(test)]
mod tests {
    #[test]
    fn uses_client_protocol_version() {
        assert_eq!(super::protocol_version(), "mosaic-v1");
    }

    #[test]
    fn metadata_strip_overflow_code_is_distinct_from_media_output_too_large() {
        assert_eq!(
            super::media_error_code(mosaic_media::MosaicMediaError::OutputTooLarge),
            604
        );
        assert_eq!(super::METADATA_STRIP_OVERFLOW_CODE, 605);
        assert_ne!(
            super::METADATA_STRIP_OVERFLOW_CODE,
            super::media_error_code(mosaic_media::MosaicMediaError::OutputTooLarge)
        );
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
                sign_public_key: vec![223; 32],
            },
            &["wrapped_epoch_seed_len: 3", "sign_public_key_len: 32"],
            &[
                "221",
                "222",
                "223",
                "wrapped_epoch_seed: [",
                "sign_public_key: [",
            ],
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

        assert_debug_redacts(
            &super::WrappedTierKeyResult {
                code: 0,
                tier: 1,
                nonce: vec![234; 24],
                encrypted_key: vec![235, 236, 237],
            },
            &["nonce_len: 24", "encrypted_key_len: 3"],
            &["234", "235", "236", "encrypted_key: ["],
        );

        assert_debug_redacts(
            &super::SealedBundleResult {
                code: 0,
                sealed: vec![238, 239, 240],
                signature: vec![241, 242],
                sharer_pubkey: vec![243; 32],
            },
            &["sealed_len: 3", "signature_len: 2", "sharer_pubkey_len: 32"],
            &["238", "239", "241", "243", "sealed: ["],
        );

        assert_debug_redacts(
            &super::EncryptedContentResult {
                code: 0,
                nonce: vec![244; 24],
                ciphertext: vec![245, 246, 247],
            },
            &["nonce_len: 24", "ciphertext_len: 3"],
            &["244", "245", "246", "ciphertext: ["],
        );

        // D3 lock-down: wrapped account-key bytes must never surface in
        // `{:?}` output (see SPEC-CrossPlatformHardening "Secret, PII, and
        // Log Redaction Rules"). 248..=250 are the sentinels we forbid.
        assert_debug_redacts(
            &super::CreateAccountResult {
                code: 0,
                handle: 19,
                wrapped_account_key: vec![248, 249, 250],
            },
            &["code: 0", "handle: 19", "wrapped_account_key_len: 3"],
            &["248", "249", "250", "wrapped_account_key: ["],
        );

        // D3 lock-down: keep auth-public-key Debug output length-only,
        // mirroring the IdentityHandleResult precedent established by M5.
        assert_debug_redacts(
            &super::AuthKeypairResult {
                code: 0,
                auth_public_key: vec![251, 252, 253, 254],
            },
            &["code: 0", "auth_public_key_len: 4"],
            &["251", "252", "253", "254", "auth_public_key: ["],
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
