//! WASM facade boundary crate for the Mosaic web worker integration.

#![forbid(unsafe_code)]

use std::fmt;
use std::io::Cursor;

use blake2::{
    Blake2bVar,
    digest::{Update, VariableOutput},
};
use ciborium::value::{Integer, Value};

use wasm_bindgen::prelude::wasm_bindgen;
use zeroize::{Zeroize, Zeroizing};

use mosaic_domain::{MetadataSidecar, MetadataSidecarError, MetadataSidecarField, ShardTier};

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

/// Rust-side WASM facade result for stateless seed-based shard decrypt.
///
/// Carries client-local plaintext bytes on success and zeroizes them on drop.
#[derive(Clone, PartialEq, Eq)]
pub struct DecryptShardResult {
    /// 0 on success; [`mosaic_client::ClientErrorCode`] otherwise.
    pub code: u32,
    /// Plaintext bytes on success. Empty on error.
    pub plaintext: Vec<u8>,
}

impl Drop for DecryptShardResult {
    fn drop(&mut self) {
        self.plaintext.zeroize();
    }
}

impl fmt::Debug for DecryptShardResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DecryptShardResult")
            .field("code", &self.code)
            .field("plaintext_len", &self.plaintext.len())
            .finish()
    }
}

/// Rust-side WASM facade result for stateless shard integrity verification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifyShardResult {
    /// 0 on success; [`mosaic_client::ClientErrorCode`] otherwise.
    pub code: u32,
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
/// `link_secret_for_url` is the protocol-mandated URL fragment seed. It is
/// not the derived link wrapping key; the wrapping key remains Rust-owned.
#[derive(Clone, PartialEq, Eq)]
pub struct CreateLinkShareHandleResult {
    pub code: u16,
    pub handle: u64,
    pub link_id: Vec<u8>,
    pub link_secret_for_url: Vec<u8>,
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
            .field("link_secret_for_url_len", &self.link_secret_for_url.len())
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

    /// Image bytes after metadata stripping.
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

/// WASM-bindgen class for stateless seed-based decrypted shard results.
#[wasm_bindgen(js_name = DecryptShardResult)]
pub struct JsDecryptShardResult {
    code: u32,
    plaintext: Vec<u8>,
}

impl Drop for JsDecryptShardResult {
    fn drop(&mut self) {
        self.plaintext.zeroize();
    }
}

#[wasm_bindgen(js_class = DecryptShardResult)]
impl JsDecryptShardResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u32 {
        self.code
    }

    /// Client-local plaintext bytes on successful decryption.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn plaintext(&self) -> Vec<u8> {
        self.plaintext.clone()
    }
}

/// WASM-bindgen class for stateless shard integrity verification results.
#[wasm_bindgen(js_name = VerifyShardResult)]
pub struct JsVerifyShardResult {
    code: u32,
}

#[wasm_bindgen(js_class = VerifyShardResult)]
impl JsVerifyShardResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u32 {
        self.code
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
    link_secret_for_url: Vec<u8>,
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
    /// URL fragment seed allowed by the link-share protocol; not a derived key.
    #[wasm_bindgen(getter, js_name = linkSecretForUrl)]
    #[must_use]
    pub fn link_secret_for_url(&self) -> Vec<u8> {
        self.link_secret_for_url.clone()
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

/// Rust-side WASM facade result for a pure download state transition.
#[derive(Clone, PartialEq, Eq)]
pub struct ApplyEventResult {
    pub code: u32,
    pub new_state_cbor: Vec<u8>,
}

impl fmt::Debug for ApplyEventResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ApplyEventResult")
            .field("code", &self.code)
            .field("new_state_cbor_len", &self.new_state_cbor.len())
            .finish()
    }
}

/// Rust-side WASM facade result for canonical download plan construction.
#[derive(Clone, PartialEq, Eq)]
pub struct BuildPlanResult {
    pub code: u32,
    pub plan_cbor: Vec<u8>,
    pub error_detail: String,
}

impl fmt::Debug for BuildPlanResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BuildPlanResult")
            .field("code", &self.code)
            .field("plan_cbor_len", &self.plan_cbor.len())
            .field("error_detail", &self.error_detail)
            .finish()
    }
}

/// Rust-side WASM facade result for fresh snapshot serialization.
#[derive(Clone, PartialEq, Eq)]
pub struct SerializeSnapshotResult {
    pub code: u32,
    pub body: Vec<u8>,
    pub checksum: Vec<u8>,
}

impl fmt::Debug for SerializeSnapshotResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SerializeSnapshotResult")
            .field("code", &self.code)
            .field("body_len", &self.body.len())
            .field("checksum_len", &self.checksum.len())
            .finish()
    }
}

/// Rust-side WASM facade result for verified snapshot loading.
#[derive(Clone, PartialEq, Eq)]
pub struct LoadSnapshotResult {
    pub code: u32,
    pub snapshot_cbor: Vec<u8>,
    pub schema_version_loaded: u32,
}

impl fmt::Debug for LoadSnapshotResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LoadSnapshotResult")
            .field("code", &self.code)
            .field("snapshot_cbor_len", &self.snapshot_cbor.len())
            .field("schema_version_loaded", &self.schema_version_loaded)
            .finish()
    }
}

/// Rust-side WASM facade result for snapshot checksum commits.
#[derive(Clone, PartialEq, Eq)]
pub struct CommitSnapshotResult {
    pub code: u32,
    pub checksum: Vec<u8>,
}

impl fmt::Debug for CommitSnapshotResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CommitSnapshotResult")
            .field("code", &self.code)
            .field("checksum_len", &self.checksum.len())
            .finish()
    }
}

/// Rust-side WASM facade result for constant-time snapshot verification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifySnapshotResult {
    pub code: u32,
    pub valid: bool,
}

#[wasm_bindgen(js_name = ApplyEventResult)]
pub struct JsApplyEventResult {
    code: u32,
    new_state_cbor: Vec<u8>,
}

#[wasm_bindgen(js_class = ApplyEventResult)]
impl JsApplyEventResult {
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u32 {
        self.code
    }

    #[wasm_bindgen(getter, js_name = newStateCbor)]
    #[must_use]
    pub fn new_state_cbor(&self) -> Vec<u8> {
        self.new_state_cbor.clone()
    }
}

#[wasm_bindgen(js_name = BuildPlanResult)]
pub struct JsBuildPlanResult {
    code: u32,
    plan_cbor: Vec<u8>,
    error_detail: String,
}

#[wasm_bindgen(js_class = BuildPlanResult)]
impl JsBuildPlanResult {
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u32 {
        self.code
    }

    #[wasm_bindgen(getter, js_name = planCbor)]
    #[must_use]
    pub fn plan_cbor(&self) -> Vec<u8> {
        self.plan_cbor.clone()
    }

    #[wasm_bindgen(getter, js_name = errorDetail)]
    #[must_use]
    pub fn error_detail(&self) -> String {
        self.error_detail.clone()
    }
}

#[wasm_bindgen(js_name = SerializeSnapshotResult)]
pub struct JsSerializeSnapshotResult {
    code: u32,
    body: Vec<u8>,
    checksum: Vec<u8>,
}

#[wasm_bindgen(js_class = SerializeSnapshotResult)]
impl JsSerializeSnapshotResult {
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u32 {
        self.code
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn body(&self) -> Vec<u8> {
        self.body.clone()
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn checksum(&self) -> Vec<u8> {
        self.checksum.clone()
    }
}

#[wasm_bindgen(js_name = LoadSnapshotResult)]
pub struct JsLoadSnapshotResult {
    code: u32,
    snapshot_cbor: Vec<u8>,
    schema_version_loaded: u32,
}

#[wasm_bindgen(js_class = LoadSnapshotResult)]
impl JsLoadSnapshotResult {
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u32 {
        self.code
    }

    #[wasm_bindgen(getter, js_name = snapshotCbor)]
    #[must_use]
    pub fn snapshot_cbor(&self) -> Vec<u8> {
        self.snapshot_cbor.clone()
    }

    #[wasm_bindgen(getter, js_name = schemaVersionLoaded)]
    #[must_use]
    pub fn schema_version_loaded(&self) -> u32 {
        self.schema_version_loaded
    }
}

#[wasm_bindgen(js_name = CommitSnapshotResult)]
pub struct JsCommitSnapshotResult {
    code: u32,
    checksum: Vec<u8>,
}

#[wasm_bindgen(js_class = CommitSnapshotResult)]
impl JsCommitSnapshotResult {
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u32 {
        self.code
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn checksum(&self) -> Vec<u8> {
        self.checksum.clone()
    }
}

#[wasm_bindgen(js_name = VerifySnapshotResult)]
pub struct JsVerifySnapshotResult {
    code: u32,
    valid: bool,
}

#[wasm_bindgen(js_class = VerifySnapshotResult)]
impl JsVerifySnapshotResult {
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u32 {
        self.code
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn valid(&self) -> bool {
        self.valid
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

/// Applies a download state-machine event to a CBOR-encoded state.
#[must_use]
pub fn download_apply_event_v1(state_cbor: &[u8], event_cbor: &[u8]) -> ApplyEventResult {
    let state = match download_state_from_cbor(state_cbor) {
        Ok(value) => value,
        Err(code) => return apply_event_error(code),
    };
    let event = match download_event_from_cbor(event_cbor) {
        Ok(value) => value,
        Err(code) => return apply_event_error(code),
    };
    match mosaic_client::download::state::apply(&state, &event) {
        Ok(new_state) => match download_state_to_cbor(&new_state) {
            Ok(new_state_cbor) => ApplyEventResult {
                code: client_ok(),
                new_state_cbor,
            },
            Err(code) => apply_event_error(code),
        },
        Err(_) => apply_event_error(mosaic_client::ClientErrorCode::DownloadIllegalTransition),
    }
}

/// Builds a canonical download plan from the stable CBOR plan-builder input.
#[must_use]
pub fn download_build_plan_v1(input_cbor: &[u8]) -> BuildPlanResult {
    let photos = match download_plan_inputs_from_cbor(input_cbor) {
        Ok(value) => value,
        Err(code) => return build_plan_error(code, String::new()),
    };
    let mut builder = mosaic_client::download::plan::DownloadPlanBuilder::new();
    for photo in photos {
        builder = builder.with_photo(photo);
    }
    match builder.build() {
        Ok(plan) => match download_plan_to_cbor(&plan) {
            Ok(plan_cbor) => BuildPlanResult {
                code: client_ok(),
                plan_cbor,
                error_detail: String::new(),
            },
            Err(code) => build_plan_error(code, String::new()),
        },
        Err(error) => build_plan_error(
            mosaic_client::ClientErrorCode::DownloadInvalidPlan,
            download_plan_error_detail(&error),
        ),
    }
}

/// Initializes a canonical download job snapshot from a CBOR input envelope.
#[must_use]
pub fn download_init_snapshot_v1(input_cbor: &[u8]) -> SerializeSnapshotResult {
    let input = match download_init_snapshot_input_from_cbor(input_cbor) {
        Ok(value) => value,
        Err(code) => return serialize_snapshot_error(code),
    };
    let photos = input
        .plan
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
        job_id: mosaic_client::download::snapshot::JobId::from_bytes(input.job_id),
        album_id: input.album_id,
        created_at_ms: input.now_ms,
        last_updated_at_ms: input.now_ms,
        state: mosaic_client::download::state::DownloadJobState::Idle,
        plan: input.plan,
        photos,
        failure_log: Vec::new(),
        lease_token: None,
    };
    match mosaic_client::download::snapshot::prepare_snapshot_bytes(&snapshot) {
        Ok(bytes) => SerializeSnapshotResult {
            code: client_ok(),
            body: bytes.body,
            checksum: bytes.checksum.to_vec(),
        },
        Err(error) => serialize_snapshot_error(download_snapshot_error_code(&error)),
    }
}

/// Validates and canonicalizes a persisted download snapshot body.
#[must_use]
pub fn download_load_snapshot_v1(snapshot_cbor: &[u8], checksum: &[u8]) -> LoadSnapshotResult {
    let expected = match checksum_32(checksum) {
        Ok(value) => value,
        Err(code) => return load_snapshot_error(code),
    };
    let actual = match download_checksum_body(snapshot_cbor) {
        Ok(value) => value,
        Err(code) => return load_snapshot_error(code),
    };
    if !checksum_matches(&actual, &expected) {
        return load_snapshot_error(
            mosaic_client::ClientErrorCode::DownloadSnapshotChecksumMismatch,
        );
    }
    match mosaic_client::download::snapshot::DownloadJobSnapshot::from_canonical_cbor(snapshot_cbor)
    {
        Ok(snapshot) => match snapshot.to_canonical_cbor() {
            Ok(snapshot_cbor) => LoadSnapshotResult {
                code: client_ok(),
                snapshot_cbor,
                schema_version_loaded: snapshot.schema_version,
            },
            Err(error) => load_snapshot_error(download_snapshot_error_code(&error)),
        },
        Err(error) => load_snapshot_error(download_snapshot_error_code(&error)),
    }
}

/// Computes the canonical BLAKE2b-256 checksum for a download snapshot body.
#[must_use]
pub fn download_commit_snapshot_v1(snapshot_cbor: &[u8]) -> CommitSnapshotResult {
    match mosaic_client::download::snapshot::DownloadJobSnapshot::from_canonical_cbor(snapshot_cbor)
        .and_then(|snapshot| mosaic_client::download::snapshot::prepare_snapshot_bytes(&snapshot))
    {
        Ok(bytes) => CommitSnapshotResult {
            code: client_ok(),
            checksum: bytes.checksum.to_vec(),
        },
        Err(error) => commit_snapshot_error(download_snapshot_error_code(&error)),
    }
}

/// Verifies a download snapshot body checksum without branching on checksum byte contents.
#[must_use]
pub fn download_verify_snapshot_v1(snapshot_cbor: &[u8], checksum: &[u8]) -> VerifySnapshotResult {
    let actual = match download_checksum_body(snapshot_cbor) {
        Ok(value) => value,
        Err(code) => return verify_snapshot_error(code),
    };
    let expected = checksum_32_padded(checksum);
    VerifySnapshotResult {
        code: client_ok(),
        valid: checksum.len() == 32 && checksum_matches(&actual, &expected),
    }
}
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
        ShardTier::Thumbnail.to_byte(),
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

/// Stateless seed-based shard decrypt. Used by stateless crypto worker pool members.
///
/// Key is the 32-byte `SecretKey` (epoch tier seed for authenticated viewers;
/// tier key for share-link viewers). Plaintext is zeroized when the result is dropped.
#[must_use]
pub fn decrypt_shard_with_seed_v1(envelope: &[u8], key: &[u8]) -> DecryptShardResult {
    let mut key_bytes = Zeroizing::new(key.to_vec());
    let secret_key = match mosaic_crypto::SecretKey::from_bytes(key_bytes.as_mut_slice()) {
        Ok(value) => value,
        Err(error) => {
            return DecryptShardResult {
                code: download_decrypt_error_code(error),
                plaintext: Vec::new(),
            };
        }
    };

    match mosaic_crypto::decrypt_shard(envelope, &secret_key) {
        Ok(plaintext) => DecryptShardResult {
            code: client_ok(),
            plaintext: plaintext.to_vec(),
        },
        Err(error) => DecryptShardResult {
            code: download_decrypt_error_code(error),
            plaintext: Vec::new(),
        },
    }
}

/// Stateless shard integrity verification against the expected envelope SHA-256.
#[must_use]
pub fn verify_shard_integrity_v1(envelope: &[u8], expected_hash: &[u8]) -> VerifyShardResult {
    let expected = match <[u8; 32]>::try_from(expected_hash) {
        Ok(value) => mosaic_crypto::ShardSha256(value),
        Err(_) => {
            return VerifyShardResult {
                code: client_code(mosaic_client::ClientErrorCode::InvalidInputLength),
            };
        }
    };

    match mosaic_crypto::verify_shard_integrity(envelope, &expected) {
        Ok(()) => VerifyShardResult { code: client_ok() },
        Err(error) => VerifyShardResult {
            code: shard_integrity_error_code(error),
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
/// `link_secret_for_url` is the protocol-mandated URL fragment seed. It is not
/// the derived wrapping key; Rust derives and retains the wrapping key behind
/// the returned opaque handle.
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
pub fn import_link_share_handle(link_secret_for_url: Vec<u8>) -> LinkTierHandleResult {
    let link_secret_for_url = Zeroizing::new(link_secret_for_url);
    link_tier_handle_result_from_client(mosaic_client::import_link_share_handle(
        &link_secret_for_url,
    ))
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
    link_secret_for_url: Vec<u8>,
    nonce: Vec<u8>,
    encrypted_key: Vec<u8>,
    album_id: String,
    tier_byte: u8,
) -> LinkTierHandleResult {
    let link_secret_for_url = Zeroizing::new(link_secret_for_url);
    link_tier_handle_result_from_client(mosaic_client::import_link_tier_handle(
        &link_secret_for_url,
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

fn media_error_code(error: mosaic_media::MosaicMediaError) -> u16 {
    match error {
        mosaic_media::MosaicMediaError::InvalidJpeg => 601,
        mosaic_media::MosaicMediaError::InvalidPng => 602,
        mosaic_media::MosaicMediaError::InvalidWebP => 603,
        mosaic_media::MosaicMediaError::OutputTooLarge => 604,
        _ => 699,
    }
}

fn strip_metadata(format: mosaic_media::MediaFormat, input_bytes: Vec<u8>) -> StripResult {
    match mosaic_media::strip_known_metadata(format, &input_bytes) {
        Ok(stripped) => {
            let removed_metadata_count = match u32::try_from(stripped.removed.len()) {
                Ok(value) => value,
                Err(_) => {
                    return StripResult {
                        code: 604,
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

fn js_strip_result_from_rust(result: StripResult) -> JsStripResult {
    JsStripResult {
        code: result.code,
        stripped_bytes: result.stripped_bytes,
        removed_metadata_count: result.removed_metadata_count,
    }
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

/// Stateless seed-based shard decrypt through WASM.
#[wasm_bindgen(js_name = decryptShardWithSeedV1)]
#[must_use]
pub fn decrypt_shard_with_seed_v1_js(envelope: Vec<u8>, key: Vec<u8>) -> JsDecryptShardResult {
    js_decrypt_shard_result_from_rust(decrypt_shard_with_seed_v1(&envelope, &key))
}

/// Stateless shard integrity verification through WASM.
#[wasm_bindgen(js_name = verifyShardIntegrityV1)]
#[must_use]
pub fn verify_shard_integrity_v1_js(
    envelope: Vec<u8>,
    expected_hash: Vec<u8>,
) -> JsVerifyShardResult {
    js_verify_shard_result_from_rust(verify_shard_integrity_v1(&envelope, &expected_hash))
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
pub fn import_link_share_handle_js(link_secret_for_url: Vec<u8>) -> JsLinkTierHandleResult {
    js_link_tier_handle_result_from_rust(import_link_share_handle(link_secret_for_url))
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
    link_secret_for_url: Vec<u8>,
    nonce: Vec<u8>,
    encrypted_key: Vec<u8>,
    album_id: String,
    tier_byte: u8,
) -> JsLinkTierHandleResult {
    js_link_tier_handle_result_from_rust(import_link_tier_handle(
        link_secret_for_url,
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

/// Applies a download state-machine event through WASM.
#[wasm_bindgen(js_name = downloadApplyEventV1)]
#[must_use]
pub fn download_apply_event_v1_js(state_cbor: Vec<u8>, event_cbor: Vec<u8>) -> JsApplyEventResult {
    js_apply_event_result_from_rust(download_apply_event_v1(&state_cbor, &event_cbor))
}

/// Builds a canonical download plan through WASM.
#[wasm_bindgen(js_name = downloadBuildPlanV1)]
#[must_use]
pub fn download_build_plan_v1_js(input_cbor: Vec<u8>) -> JsBuildPlanResult {
    js_build_plan_result_from_rust(download_build_plan_v1(&input_cbor))
}

/// Initializes a canonical download snapshot through WASM.
#[wasm_bindgen(js_name = downloadInitSnapshotV1)]
#[must_use]
pub fn download_init_snapshot_v1_js(input_cbor: Vec<u8>) -> JsSerializeSnapshotResult {
    js_serialize_snapshot_result_from_rust(download_init_snapshot_v1(&input_cbor))
}

/// Loads and canonicalizes a checksum-protected download snapshot through WASM.
#[wasm_bindgen(js_name = downloadLoadSnapshotV1)]
#[must_use]
pub fn download_load_snapshot_v1_js(
    snapshot_cbor: Vec<u8>,
    checksum: Vec<u8>,
) -> JsLoadSnapshotResult {
    js_load_snapshot_result_from_rust(download_load_snapshot_v1(&snapshot_cbor, &checksum))
}

/// Commits a canonical download snapshot through WASM.
#[wasm_bindgen(js_name = downloadCommitSnapshotV1)]
#[must_use]
pub fn download_commit_snapshot_v1_js(snapshot_cbor: Vec<u8>) -> JsCommitSnapshotResult {
    js_commit_snapshot_result_from_rust(download_commit_snapshot_v1(&snapshot_cbor))
}

/// Verifies a download snapshot checksum through WASM.
#[wasm_bindgen(js_name = downloadVerifySnapshotV1)]
#[must_use]
pub fn download_verify_snapshot_v1_js(
    snapshot_cbor: Vec<u8>,
    checksum: Vec<u8>,
) -> JsVerifySnapshotResult {
    js_verify_snapshot_result_from_rust(download_verify_snapshot_v1(&snapshot_cbor, &checksum))
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

fn js_decrypt_shard_result_from_rust(mut result: DecryptShardResult) -> JsDecryptShardResult {
    JsDecryptShardResult {
        code: result.code,
        plaintext: std::mem::take(&mut result.plaintext),
    }
}

fn js_verify_shard_result_from_rust(result: VerifyShardResult) -> JsVerifyShardResult {
    JsVerifyShardResult { code: result.code }
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
        link_secret_for_url: result.link_secret_for_url,
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

struct DownloadInitSnapshotInput {
    job_id: [u8; 16],
    album_id: mosaic_client::Uuid,
    plan: mosaic_client::download::plan::DownloadPlan,
    now_ms: u64,
}

fn client_ok() -> u32 {
    u32::from(mosaic_client::ClientErrorCode::Ok.as_u16())
}

fn client_code(code: mosaic_client::ClientErrorCode) -> u32 {
    u32::from(code.as_u16())
}

fn download_decrypt_error_code(error: mosaic_crypto::MosaicCryptoError) -> u32 {
    let code = match error {
        mosaic_crypto::MosaicCryptoError::InvalidEnvelope
        | mosaic_crypto::MosaicCryptoError::MissingCiphertext => {
            mosaic_client::ClientErrorCode::InvalidEnvelope
        }
        mosaic_crypto::MosaicCryptoError::AuthenticationFailed => {
            mosaic_client::ClientErrorCode::DownloadDecrypt
        }
        mosaic_crypto::MosaicCryptoError::InvalidKeyLength { .. } => {
            mosaic_client::ClientErrorCode::InvalidKeyLength
        }
        mosaic_crypto::MosaicCryptoError::InvalidInputLength { .. } => {
            mosaic_client::ClientErrorCode::InvalidInputLength
        }
        _ => mosaic_client::ClientErrorCode::DownloadDecrypt,
    };
    client_code(code)
}

fn shard_integrity_error_code(error: mosaic_crypto::ShardIntegrityError) -> u32 {
    let code = match error {
        mosaic_crypto::ShardIntegrityError::InvalidEnvelopeLength { .. } => {
            mosaic_client::ClientErrorCode::InvalidEnvelope
        }
        mosaic_crypto::ShardIntegrityError::DigestMismatch => {
            mosaic_client::ClientErrorCode::DownloadIntegrity
        }
    };
    client_code(code)
}

fn apply_event_error(code: mosaic_client::ClientErrorCode) -> ApplyEventResult {
    ApplyEventResult {
        code: client_code(code),
        new_state_cbor: Vec::new(),
    }
}

fn build_plan_error(code: mosaic_client::ClientErrorCode, error_detail: String) -> BuildPlanResult {
    BuildPlanResult {
        code: client_code(code),
        plan_cbor: Vec::new(),
        error_detail,
    }
}

fn serialize_snapshot_error(code: mosaic_client::ClientErrorCode) -> SerializeSnapshotResult {
    SerializeSnapshotResult {
        code: client_code(code),
        body: Vec::new(),
        checksum: Vec::new(),
    }
}

fn load_snapshot_error(code: mosaic_client::ClientErrorCode) -> LoadSnapshotResult {
    LoadSnapshotResult {
        code: client_code(code),
        snapshot_cbor: Vec::new(),
        schema_version_loaded: 0,
    }
}

fn commit_snapshot_error(code: mosaic_client::ClientErrorCode) -> CommitSnapshotResult {
    CommitSnapshotResult {
        code: client_code(code),
        checksum: Vec::new(),
    }
}

fn verify_snapshot_error(code: mosaic_client::ClientErrorCode) -> VerifySnapshotResult {
    VerifySnapshotResult {
        code: client_code(code),
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

fn download_plan_inputs_from_cbor(
    bytes: &[u8],
) -> Result<Vec<mosaic_client::download::plan::DownloadPlanInput>, mosaic_client::ClientErrorCode> {
    let value = cbor_value(bytes)?;
    let entries = map_entries(&value)?;
    let photos = array_items(required_entry(entries, 0)?)?;
    photos.iter().map(decode_download_plan_input).collect()
}

fn download_init_snapshot_input_from_cbor(
    bytes: &[u8],
) -> Result<DownloadInitSnapshotInput, mosaic_client::ClientErrorCode> {
    let value = cbor_value(bytes)?;
    let entries = map_entries(&value)?;
    let job_id = bytes_16_from_value(required_entry(entries, 0)?)?;
    let album_id = uuid_from_cbor_value(required_entry(entries, 1)?)?;
    let plan_bytes = bytes_from_value(required_entry(entries, 2)?)?;
    let plan = download_plan_from_cbor(&plan_bytes)?;
    let now_ms = u64_from_value(required_entry(entries, 3)?)?;
    Ok(DownloadInitSnapshotInput {
        job_id,
        album_id,
        plan,
        now_ms,
    })
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

fn decode_download_plan_input(
    value: &Value,
) -> Result<mosaic_client::download::plan::DownloadPlanInput, mosaic_client::ClientErrorCode> {
    let fields = map_entries(value)?;
    let shards = array_items(required_entry(fields, 2)?)?
        .iter()
        .map(decode_download_shard_input)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(mosaic_client::download::plan::DownloadPlanInput {
        photo_id: mosaic_client::download::plan::PhotoId::new(text_from_value(required_entry(
            fields, 0,
        )?)?),
        filename: text_from_value(required_entry(fields, 1)?)?,
        shards,
    })
}

fn decode_download_shard_input(
    value: &Value,
) -> Result<mosaic_client::download::plan::DownloadShardInput, mosaic_client::ClientErrorCode> {
    let fields = map_entries(value)?;
    Ok(mosaic_client::download::plan::DownloadShardInput {
        shard_id: mosaic_client::download::plan::ShardId::from_bytes(bytes_16_from_value(
            required_entry(fields, 0)?,
        )?),
        epoch_id: u32_from_value(required_entry(fields, 1)?)?,
        tier: shard_tier_from_value(required_entry(fields, 2)?)?,
        expected_hash: bytes_32_from_value(required_entry(fields, 3)?)?,
        declared_size: u64_from_value(required_entry(fields, 4)?)?,
    })
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
        link_secret_for_url: result.link_secret_for_url,
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

fn js_apply_event_result_from_rust(result: ApplyEventResult) -> JsApplyEventResult {
    JsApplyEventResult {
        code: result.code,
        new_state_cbor: result.new_state_cbor,
    }
}

fn js_build_plan_result_from_rust(result: BuildPlanResult) -> JsBuildPlanResult {
    JsBuildPlanResult {
        code: result.code,
        plan_cbor: result.plan_cbor,
        error_detail: result.error_detail,
    }
}

fn js_serialize_snapshot_result_from_rust(
    result: SerializeSnapshotResult,
) -> JsSerializeSnapshotResult {
    JsSerializeSnapshotResult {
        code: result.code,
        body: result.body,
        checksum: result.checksum,
    }
}

fn js_load_snapshot_result_from_rust(result: LoadSnapshotResult) -> JsLoadSnapshotResult {
    JsLoadSnapshotResult {
        code: result.code,
        snapshot_cbor: result.snapshot_cbor,
        schema_version_loaded: result.schema_version_loaded,
    }
}

fn js_commit_snapshot_result_from_rust(result: CommitSnapshotResult) -> JsCommitSnapshotResult {
    JsCommitSnapshotResult {
        code: result.code,
        checksum: result.checksum,
    }
}

fn js_verify_snapshot_result_from_rust(result: VerifySnapshotResult) -> JsVerifySnapshotResult {
    JsVerifySnapshotResult {
        code: result.code,
        valid: result.valid,
    }
}

// ---------------------------------------------------------------------------
// Streaming-AEAD shard decryptor (envelope variant 1).
//
// A simple Mutex<HashMap<u32, StreamingShardDecryptor>> registry keyed by an
// AtomicU32 id. Lifetime is owned by the worker; callers MUST invoke
// streaming_shard_close_v1 (or successfully reach the final chunk, which
// removes the entry automatically) to avoid leaking decryptors.
// ---------------------------------------------------------------------------

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};

use mosaic_crypto::StreamingShardDecryptor;
use mosaic_domain::SHARD_ENVELOPE_HEADER_LEN;

fn streaming_registry() -> &'static Mutex<HashMap<u32, StreamingShardDecryptor>> {
    static REGISTRY: OnceLock<Mutex<HashMap<u32, StreamingShardDecryptor>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn streaming_next_handle_id() -> u32 {
    static NEXT_ID: AtomicU32 = AtomicU32::new(1);
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamingShardOpenResult {
    pub code: u32,
    pub handle_id: u32,
    pub chunk_size_bytes: u32,
}

#[derive(Clone, PartialEq, Eq)]
pub struct StreamingShardChunkResult {
    pub code: u32,
    pub plaintext: Vec<u8>,
}

impl Drop for StreamingShardChunkResult {
    fn drop(&mut self) {
        self.plaintext.zeroize();
    }
}

impl fmt::Debug for StreamingShardChunkResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StreamingShardChunkResult")
            .field("code", &self.code)
            .field("plaintext_len", &self.plaintext.len())
            .finish()
    }
}

#[must_use]
pub fn open_streaming_shard_v1(envelope_header: &[u8], key: &[u8]) -> StreamingShardOpenResult {
    let header_array = match <[u8; SHARD_ENVELOPE_HEADER_LEN]>::try_from(envelope_header) {
        Ok(value) => value,
        Err(_) => {
            return StreamingShardOpenResult {
                code: client_code(mosaic_client::ClientErrorCode::InvalidHeaderLength),
                handle_id: 0,
                chunk_size_bytes: 0,
            };
        }
    };

    let mut key_bytes = Zeroizing::new(key.to_vec());
    let secret_key = match mosaic_crypto::SecretKey::from_bytes(key_bytes.as_mut_slice()) {
        Ok(value) => value,
        Err(error) => {
            return StreamingShardOpenResult {
                code: download_decrypt_error_code(error),
                handle_id: 0,
                chunk_size_bytes: 0,
            };
        }
    };

    let decryptor = match mosaic_crypto::open_streaming_shard(&header_array, &secret_key) {
        Ok(value) => value,
        Err(error) => {
            return StreamingShardOpenResult {
                code: download_decrypt_error_code(error),
                handle_id: 0,
                chunk_size_bytes: 0,
            };
        }
    };
    let chunk_size_bytes = decryptor.chunk_size_bytes();

    let handle_id = streaming_next_handle_id();
    let registry = streaming_registry();
    match registry.lock() {
        Ok(mut guard) => {
            guard.insert(handle_id, decryptor);
        }
        Err(_) => {
            return StreamingShardOpenResult {
                code: client_code(mosaic_client::ClientErrorCode::InternalStatePoisoned),
                handle_id: 0,
                chunk_size_bytes: 0,
            };
        }
    }

    StreamingShardOpenResult {
        code: client_ok(),
        handle_id,
        chunk_size_bytes,
    }
}

#[must_use]
pub fn streaming_shard_process_chunk_v1(
    handle_id: u32,
    chunk: &[u8],
    is_final: bool,
) -> StreamingShardChunkResult {
    let registry = streaming_registry();

    if is_final {
        let mut decryptor = {
            let mut guard = match registry.lock() {
                Ok(value) => value,
                Err(_) => {
                    return StreamingShardChunkResult {
                        code: client_code(mosaic_client::ClientErrorCode::InternalStatePoisoned),
                        plaintext: Vec::new(),
                    };
                }
            };
            match guard.remove(&handle_id) {
                Some(value) => value,
                None => {
                    return StreamingShardChunkResult {
                        code: client_code(mosaic_client::ClientErrorCode::SecretHandleNotFound),
                        plaintext: Vec::new(),
                    };
                }
            }
        };
        match decryptor.finish_chunk(chunk) {
            Ok(plaintext) => StreamingShardChunkResult {
                code: client_ok(),
                plaintext: plaintext.to_vec(),
            },
            Err(error) => StreamingShardChunkResult {
                code: download_decrypt_error_code(error),
                plaintext: Vec::new(),
            },
        }
    } else {
        let mut guard = match registry.lock() {
            Ok(value) => value,
            Err(_) => {
                return StreamingShardChunkResult {
                    code: client_code(mosaic_client::ClientErrorCode::InternalStatePoisoned),
                    plaintext: Vec::new(),
                };
            }
        };
        let decryptor = match guard.get_mut(&handle_id) {
            Some(value) => value,
            None => {
                return StreamingShardChunkResult {
                    code: client_code(mosaic_client::ClientErrorCode::SecretHandleNotFound),
                    plaintext: Vec::new(),
                };
            }
        };
        match decryptor.process_chunk(chunk) {
            Ok(plaintext) => StreamingShardChunkResult {
                code: client_ok(),
                plaintext: plaintext.to_vec(),
            },
            Err(error) => {
                guard.remove(&handle_id);
                StreamingShardChunkResult {
                    code: download_decrypt_error_code(error),
                    plaintext: Vec::new(),
                }
            }
        }
    }
}

#[must_use]
pub fn streaming_shard_close_v1(handle_id: u32) -> u32 {
    let registry = streaming_registry();
    match registry.lock() {
        Ok(mut guard) => {
            guard.remove(&handle_id);
            client_ok()
        }
        Err(_) => client_code(mosaic_client::ClientErrorCode::InternalStatePoisoned),
    }
}

#[wasm_bindgen(js_name = StreamingShardOpenResult)]
#[derive(Clone, Copy)]
pub struct JsStreamingShardOpenResult {
    code: u32,
    handle_id: u32,
    chunk_size_bytes: u32,
}

#[wasm_bindgen(js_class = StreamingShardOpenResult)]
impl JsStreamingShardOpenResult {
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u32 {
        self.code
    }

    #[wasm_bindgen(getter, js_name = handleId)]
    #[must_use]
    pub fn handle_id(&self) -> u32 {
        self.handle_id
    }

    #[wasm_bindgen(getter, js_name = chunkSizeBytes)]
    #[must_use]
    pub fn chunk_size_bytes(&self) -> u32 {
        self.chunk_size_bytes
    }
}

#[wasm_bindgen(js_name = StreamingShardChunkResult)]
pub struct JsStreamingShardChunkResult {
    code: u32,
    plaintext: Vec<u8>,
}

impl Drop for JsStreamingShardChunkResult {
    fn drop(&mut self) {
        self.plaintext.zeroize();
    }
}

#[wasm_bindgen(js_class = StreamingShardChunkResult)]
impl JsStreamingShardChunkResult {
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u32 {
        self.code
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn plaintext(&self) -> Vec<u8> {
        self.plaintext.clone()
    }
}

#[wasm_bindgen(js_name = openStreamingShardV1)]
#[must_use]
pub fn open_streaming_shard_v1_js(
    envelope_header: Vec<u8>,
    key: Vec<u8>,
) -> JsStreamingShardOpenResult {
    let result = open_streaming_shard_v1(&envelope_header, &key);
    JsStreamingShardOpenResult {
        code: result.code,
        handle_id: result.handle_id,
        chunk_size_bytes: result.chunk_size_bytes,
    }
}

#[wasm_bindgen(js_name = streamingShardProcessChunkV1)]
#[must_use]
pub fn streaming_shard_process_chunk_v1_js(
    handle_id: u32,
    chunk: Vec<u8>,
    is_final: bool,
) -> JsStreamingShardChunkResult {
    let mut result = streaming_shard_process_chunk_v1(handle_id, &chunk, is_final);
    let plaintext = std::mem::take(&mut result.plaintext);
    JsStreamingShardChunkResult {
        code: result.code,
        plaintext,
    }
}

#[wasm_bindgen(js_name = streamingShardCloseV1)]
#[must_use]
pub fn streaming_shard_close_v1_js(handle_id: u32) -> u32 {
    streaming_shard_close_v1(handle_id)
}

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

// ---------------------------------------------------------------------------

