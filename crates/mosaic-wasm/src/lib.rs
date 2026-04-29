//! WASM facade boundary crate for the Mosaic web worker integration.

#![forbid(unsafe_code)]

use wasm_bindgen::prelude::wasm_bindgen;
use zeroize::Zeroize;

use mosaic_domain::{MetadataSidecar, MetadataSidecarError, MetadataSidecarField, ShardTier};

/// Rust-side WASM facade result for header parsing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeaderResult {
    pub code: u16,
    pub epoch_id: u32,
    pub shard_index: u32,
    pub tier: u8,
    pub nonce: Vec<u8>,
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
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BytesResult {
    pub code: u16,
    pub bytes: Vec<u8>,
}

/// Rust-side WASM facade non-secret account unlock parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountUnlockRequest {
    pub user_salt: Vec<u8>,
    pub account_salt: Vec<u8>,
    pub wrapped_account_key: Vec<u8>,
    pub kdf_memory_kib: u32,
    pub kdf_iterations: u32,
    pub kdf_parallelism: u32,
}

/// Rust-side WASM facade account unlock result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountUnlockResult {
    pub code: u16,
    pub handle: u64,
}

/// Rust-side WASM facade account-key handle status result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AccountKeyHandleStatusResult {
    pub code: u16,
    pub is_open: bool,
}

/// Rust-side WASM facade identity handle result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityHandleResult {
    pub code: u16,
    pub handle: u64,
    pub signing_pubkey: Vec<u8>,
    pub encryption_pubkey: Vec<u8>,
    pub wrapped_seed: Vec<u8>,
}

/// Rust-side WASM facade epoch-key handle result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpochKeyHandleResult {
    pub code: u16,
    pub handle: u64,
    pub epoch_id: u32,
    pub wrapped_epoch_seed: Vec<u8>,
}

/// Rust-side WASM facade epoch-key handle status result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EpochKeyHandleStatusResult {
    pub code: u16,
    pub is_open: bool,
}

/// Rust-side WASM facade encrypted shard result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedShardResult {
    pub code: u16,
    pub envelope_bytes: Vec<u8>,
    pub sha256: String,
}

/// Rust-side WASM facade decrypted shard result.
///
/// This type carries client-local plaintext media bytes on success and
/// intentionally does not implement `Debug`.
#[derive(Clone, PartialEq, Eq)]
pub struct DecryptedShardResult {
    pub code: u16,
    pub plaintext: Vec<u8>,
}

/// Rust-side WASM facade public crypto/domain golden-vector snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
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

/// Rust-side WASM facade privacy-safe uploaded shard reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientCoreUploadShardRef {
    pub tier: u8,
    pub shard_index: u32,
    pub shard_id: String,
    pub sha256: String,
    pub uploaded: bool,
}

/// Rust-side WASM facade manifest receipt known after server commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientCoreManifestReceipt {
    pub manifest_id: String,
    pub manifest_version: u64,
}

/// Rust-side WASM facade upload job initialization request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientCoreUploadJobRequest {
    pub job_id: String,
    pub album_id: String,
    pub asset_id: String,
    pub epoch_id: u32,
    pub now_unix_ms: u64,
    pub max_retry_count: u32,
}

/// Rust-side WASM facade persistence-safe upload job snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
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
    pub max_retry_count: u32,
    pub next_retry_unix_ms: u64,
    pub last_error_code: u16,
    pub last_error_stage: String,
    pub sync_confirmed: bool,
    pub updated_at_unix_ms: u64,
}

/// Rust-side WASM facade compact upload event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientCoreUploadJobEvent {
    pub kind: String,
    pub epoch_id: u32,
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

/// Rust-side WASM facade compact upload effect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientCoreUploadJobEffect {
    pub kind: String,
    pub tier: u8,
    pub shard_index: u32,
}

/// Rust-side WASM facade upload transition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientCoreUploadJobTransition {
    pub snapshot: ClientCoreUploadJobSnapshot,
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

/// Returns the stable WASM API snapshot for this FFI spike.
#[must_use]
pub const fn wasm_api_snapshot() -> &'static str {
    "mosaic-wasm ffi-spike:v6 parse_envelope_header(bytes)->HeaderResult progress(total,cancel_after)->ProgressResult account(unlock/status/close) identity(create/open/close/pubkeys/sign/verify) epoch(create/open/status/close/encrypt/decrypt) metadata(canonical/encrypt) vectors(crypto-domain)->CryptoDomainGoldenVectorSnapshot client-core(state-machine-snapshot,upload-init/upload-advance,sync-init/sync-advance)"
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
    account_unlock_result_from_client(result)
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
    epoch_id: u32,
    now_unix_ms: u64,
    max_retry_count: u32,
) -> String {
    upload_job_result_json(init_upload_job(ClientCoreUploadJobRequest {
        job_id,
        album_id,
        asset_id,
        epoch_id,
        now_unix_ms,
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
    asset_id: String,
    epoch_id: u32,
    phase: String,
    active_tier: u8,
    active_shard_index: u32,
    retry_count: u32,
    max_retry_count: u32,
    next_retry_unix_ms: u64,
    last_error_code: u16,
    last_error_stage: String,
    sync_confirmed: bool,
    updated_at_unix_ms: u64,
    event_kind: String,
    event_epoch_id: u32,
    event_tier: u8,
    event_shard_index: u32,
    event_shard_id: String,
    event_sha256: String,
    event_manifest_id: String,
    event_manifest_version: u64,
    observed_asset_id: String,
    retry_after_unix_ms: u64,
    event_error_code: u16,
) -> String {
    upload_job_transition_result_json(advance_upload_job(
        ClientCoreUploadJobSnapshot {
            schema_version: 1,
            job_id,
            album_id,
            asset_id,
            epoch_id,
            phase,
            active_tier,
            active_shard_index,
            completed_shards: Vec::new(),
            has_manifest_receipt: false,
            manifest_receipt: empty_manifest_receipt(),
            retry_count,
            max_retry_count,
            next_retry_unix_ms,
            last_error_code,
            last_error_stage,
            sync_confirmed,
            updated_at_unix_ms,
        },
        ClientCoreUploadJobEvent {
            kind: event_kind,
            epoch_id: event_epoch_id,
            tier: event_tier,
            shard_index: event_shard_index,
            shard_id: event_shard_id,
            sha256: event_sha256,
            manifest_id: event_manifest_id,
            manifest_version: event_manifest_version,
            observed_asset_id,
            retry_after_unix_ms,
            error_code: event_error_code,
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
            kind: event_kind,
            fetched_cursor,
            next_cursor,
            applied_count,
            observed_asset_ids: Vec::new(),
            retry_after_unix_ms,
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
        local_job_id: request.job_id.clone(),
        upload_id: request.job_id,
        album_id: request.album_id,
        asset_id: request.asset_id,
        max_retry_count: request.max_retry_count,
    }
}

fn upload_snapshot_to_client(
    snapshot: ClientCoreUploadJobSnapshot,
) -> Result<mosaic_client::UploadJobSnapshot, u16> {
    let invalid_snapshot = mosaic_client::ClientErrorCode::ClientCoreInvalidSnapshot.as_u16();
    let invalid_input_length = mosaic_client::ClientErrorCode::InvalidInputLength.as_u16();

    let asset_id = snapshot.asset_id.clone();
    let pending_shard = snapshot
        .completed_shards
        .iter()
        .find(|shard| !shard.uploaded)
        .map(|shard| mosaic_client::PendingShardRef {
            tier: shard.tier,
            index: shard.shard_index,
            sha256: shard.sha256.clone(),
            shard_id: if shard.shard_id.is_empty() {
                None
            } else {
                Some(shard.shard_id.clone())
            },
        });
    let completed_shards: Vec<_> = snapshot
        .completed_shards
        .iter()
        .filter(|shard| shard.uploaded)
        .map(|shard| mosaic_client::CompletedShardRef {
            tier: shard.tier,
            index: shard.shard_index,
            shard_id: shard.shard_id.clone(),
            sha256: shard.sha256.clone(),
        })
        .collect();
    let planned_shards =
        upload_planned_shards_from_dto(&snapshot, &completed_shards, &pending_shard);
    let planned_shard_count =
        u32::try_from(planned_shards.len()).map_err(|_| invalid_input_length)?;
    let manifest_receipt = if snapshot.has_manifest_receipt {
        Some(mosaic_client::ManifestReceipt {
            manifest_id: snapshot.manifest_receipt.manifest_id,
            version: snapshot.manifest_receipt.manifest_version,
        })
    } else {
        None
    };
    let retry_target_phase = if snapshot.last_error_stage.is_empty() {
        None
    } else {
        Some(upload_phase_from_string(&snapshot.last_error_stage).ok_or(invalid_snapshot)?)
    };
    let last_error_code = match client_error_code_from_u16(snapshot.last_error_code) {
        Some(code) => Some(code),
        None => return Err(invalid_snapshot),
    };
    let phase = upload_phase_from_string(&snapshot.phase).ok_or(invalid_snapshot)?;
    let schema_version = schema_version_u16(snapshot.schema_version)?;

    Ok(mosaic_client::UploadJobSnapshot {
        schema_version,
        local_job_id: snapshot.job_id.clone(),
        upload_id: snapshot.job_id,
        album_id: snapshot.album_id,
        asset_id: asset_id.clone(),
        epoch_id: (snapshot.epoch_id != 0).then_some(snapshot.epoch_id),
        phase,
        planned_shard_count,
        planned_shards,
        next_shard_index: snapshot.active_shard_index,
        pending_shard,
        completed_shards,
        manifest_receipt,
        retry: mosaic_client::UploadRetryMetadata {
            attempt_count: snapshot.retry_count,
            max_attempts: snapshot.max_retry_count,
            retry_after_ms: (snapshot.next_retry_unix_ms != 0)
                .then_some(snapshot.next_retry_unix_ms),
            last_error_code,
            last_error_stage: retry_target_phase,
            retry_target_phase,
        },
        confirmation_metadata: snapshot.sync_confirmed.then_some({
            mosaic_client::UploadSyncConfirmation {
                asset_id,
                confirmed_at_ms: snapshot.updated_at_unix_ms,
                sync_cursor: None,
            }
        }),
        failure_code: last_error_code,
    })
}

fn upload_event_to_client(
    event: ClientCoreUploadJobEvent,
) -> Result<mosaic_client::UploadJobEvent, u16> {
    let invalid_snapshot = mosaic_client::ClientErrorCode::ClientCoreInvalidSnapshot.as_u16();
    Ok(match event.kind.as_str() {
        "StartRequested" | "Start" => mosaic_client::UploadJobEvent::StartRequested,
        "MediaPrepared" | "PreparedMedia" => mosaic_client::UploadJobEvent::MediaPrepared {
            plan: Some(mosaic_client::PreparedMediaPlan {
                planned_shards: vec![mosaic_client::UploadShardSlot {
                    tier: event.tier,
                    index: event.shard_index,
                }],
            }),
        },
        "EpochHandleAcquired" | "EpochHandleReady" => {
            mosaic_client::UploadJobEvent::EpochHandleAcquired {
                epoch_id: Some(event.epoch_id),
            }
        }
        "ShardEncrypted" => mosaic_client::UploadJobEvent::ShardEncrypted {
            shard: Some(mosaic_client::EncryptedShardRef {
                tier: event.tier,
                index: event.shard_index,
                sha256: event.sha256,
            }),
        },
        "ShardUploadCreated" => mosaic_client::UploadJobEvent::ShardUploadCreated {
            upload: Some(mosaic_client::CreatedShardUpload {
                tier: event.tier,
                index: event.shard_index,
                shard_id: event.shard_id,
                sha256: event.sha256,
            }),
        },
        "ShardUploaded" => mosaic_client::UploadJobEvent::ShardUploaded {
            shard: Some(mosaic_client::CompletedShardRef {
                tier: event.tier,
                index: event.shard_index,
                shard_id: event.shard_id,
                sha256: event.sha256,
            }),
        },
        "ManifestCreated" => mosaic_client::UploadJobEvent::ManifestCreated {
            receipt: Some(mosaic_client::ManifestReceipt {
                manifest_id: event.manifest_id,
                version: event.manifest_version,
            }),
        },
        "ManifestOutcomeUnknown" => mosaic_client::UploadJobEvent::ManifestOutcomeUnknown,
        "SyncConfirmed" => mosaic_client::UploadJobEvent::SyncConfirmed {
            confirmation: Some(mosaic_client::UploadSyncConfirmation {
                asset_id: event.observed_asset_id,
                confirmed_at_ms: 0,
                sync_cursor: None,
            }),
        },
        "RetryableFailure" => mosaic_client::UploadJobEvent::RetryableFailure {
            code: client_error_code_from_u16(event.error_code).ok_or(invalid_snapshot)?,
            retry_after_ms: (event.retry_after_unix_ms != 0).then_some(event.retry_after_unix_ms),
        },
        "RetryTimerElapsed" => mosaic_client::UploadJobEvent::RetryTimerElapsed,
        "CancelRequested" => mosaic_client::UploadJobEvent::CancelRequested,
        "NonRetryableFailure" => mosaic_client::UploadJobEvent::NonRetryableFailure {
            code: client_error_code_from_u16(event.error_code).ok_or(invalid_snapshot)?,
        },
        // Unknown event kinds drive the SM to its invalid-transition path; the SM owns the
        // rejection so the host receives a stable Failed phase rather than an opaque code.
        _ => mosaic_client::UploadJobEvent::NonRetryableFailure {
            code: mosaic_client::ClientErrorCode::ClientCoreInvalidTransition,
        },
    })
}

fn upload_snapshot_from_client(
    snapshot: mosaic_client::UploadJobSnapshot,
) -> ClientCoreUploadJobSnapshot {
    let (has_manifest_receipt, manifest_receipt) = match snapshot.manifest_receipt {
        Some(ref receipt) => (
            true,
            ClientCoreManifestReceipt {
                manifest_id: receipt.manifest_id.clone(),
                manifest_version: receipt.version,
            },
        ),
        None => (false, empty_manifest_receipt()),
    };
    let pending_ref = snapshot
        .pending_shard
        .as_ref()
        .map(|shard| ClientCoreUploadShardRef {
            tier: shard.tier,
            shard_index: shard.index,
            shard_id: shard.shard_id.clone().unwrap_or_default(),
            sha256: shard.sha256.clone(),
            uploaded: false,
        });
    let active = upload_active_slot(&snapshot);
    let last_error_code = snapshot
        .retry
        .last_error_code
        .or(snapshot.failure_code)
        .map_or(0, mosaic_client::ClientErrorCode::as_u16);

    ClientCoreUploadJobSnapshot {
        schema_version: u32::from(snapshot.schema_version),
        job_id: snapshot.local_job_id,
        album_id: snapshot.album_id,
        asset_id: snapshot.asset_id,
        epoch_id: snapshot.epoch_id.unwrap_or_default(),
        phase: upload_phase_to_string(snapshot.phase),
        active_tier: active.as_ref().map_or(0, |slot| slot.tier),
        active_shard_index: active.as_ref().map_or(0, |slot| slot.index),
        completed_shards: snapshot
            .completed_shards
            .into_iter()
            .map(|shard| ClientCoreUploadShardRef {
                tier: shard.tier,
                shard_index: shard.index,
                shard_id: shard.shard_id,
                sha256: shard.sha256,
                uploaded: true,
            })
            .chain(pending_ref)
            .collect(),
        has_manifest_receipt,
        manifest_receipt,
        retry_count: snapshot.retry.attempt_count,
        max_retry_count: snapshot.retry.max_attempts,
        next_retry_unix_ms: snapshot.retry.retry_after_ms.unwrap_or_default(),
        last_error_code,
        last_error_stage: snapshot
            .retry
            .last_error_stage
            .map_or_else(String::new, upload_phase_to_string),
        sync_confirmed: snapshot.confirmation_metadata.is_some(),
        updated_at_unix_ms: snapshot
            .confirmation_metadata
            .as_ref()
            .map_or(0, |confirmation| confirmation.confirmed_at_ms),
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
    let invalid_snapshot = mosaic_client::ClientErrorCode::ClientCoreInvalidSnapshot.as_u16();
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
            code: client_error_code_from_u16(event.error_code).ok_or(invalid_snapshot)?,
            retry_after_ms: (event.retry_after_unix_ms != 0).then_some(event.retry_after_unix_ms),
        },
        "RetryTimerElapsed" => mosaic_client::AlbumSyncEvent::RetryTimerElapsed,
        "CancelRequested" => mosaic_client::AlbumSyncEvent::CancelRequested,
        "NonRetryableFailure" => mosaic_client::AlbumSyncEvent::NonRetryableFailure {
            code: client_error_code_from_u16(event.error_code).ok_or(invalid_snapshot)?,
        },
        // Unknown event kinds drive the SM to its invalid-transition path; the SM owns the
        // rejection so the host receives a stable Failed phase rather than an opaque code.
        _ => mosaic_client::AlbumSyncEvent::NonRetryableFailure {
            code: mosaic_client::ClientErrorCode::ClientCoreInvalidTransition,
        },
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

fn upload_planned_shards_from_dto(
    snapshot: &ClientCoreUploadJobSnapshot,
    completed_shards: &[mosaic_client::CompletedShardRef],
    pending_shard: &Option<mosaic_client::PendingShardRef>,
) -> Vec<mosaic_client::UploadShardSlot> {
    let mut planned: Vec<_> = completed_shards
        .iter()
        .map(|shard| mosaic_client::UploadShardSlot {
            tier: shard.tier,
            index: shard.index,
        })
        .collect();
    if let Some(shard) = pending_shard {
        planned.push(mosaic_client::UploadShardSlot {
            tier: shard.tier,
            index: shard.index,
        });
    } else if snapshot.active_tier != 0 {
        planned.push(mosaic_client::UploadShardSlot {
            tier: snapshot.active_tier,
            index: snapshot.active_shard_index,
        });
    }
    planned.sort_by_key(|slot| (slot.tier, slot.index));
    planned.dedup_by_key(|slot| (slot.tier, slot.index));
    planned
}

fn upload_active_slot(
    snapshot: &mosaic_client::UploadJobSnapshot,
) -> Option<mosaic_client::UploadShardSlot> {
    if let Some(shard) = &snapshot.pending_shard {
        return Some(mosaic_client::UploadShardSlot {
            tier: shard.tier,
            index: shard.index,
        });
    }
    if snapshot.phase == mosaic_client::UploadJobPhase::EncryptingShard {
        return snapshot
            .planned_shards
            .iter()
            .find(|slot| slot.index == snapshot.next_shard_index)
            .cloned();
    }
    None
}

fn upload_effect_from_client(effect: mosaic_client::UploadJobEffect) -> ClientCoreUploadJobEffect {
    match effect {
        mosaic_client::UploadJobEffect::PrepareMedia => ClientCoreUploadJobEffect {
            kind: "PrepareMedia".to_owned(),
            tier: 0,
            shard_index: 0,
        },
        mosaic_client::UploadJobEffect::AcquireEpochHandle => ClientCoreUploadJobEffect {
            kind: "AcquireEpochHandle".to_owned(),
            tier: 0,
            shard_index: 0,
        },
        mosaic_client::UploadJobEffect::EncryptShard { tier, index } => ClientCoreUploadJobEffect {
            kind: "EncryptShard".to_owned(),
            tier,
            shard_index: index,
        },
        mosaic_client::UploadJobEffect::CreateShardUpload { tier, index, .. } => {
            ClientCoreUploadJobEffect {
                kind: "CreateShardUpload".to_owned(),
                tier,
                shard_index: index,
            }
        }
        mosaic_client::UploadJobEffect::UploadShard { tier, index, .. } => {
            ClientCoreUploadJobEffect {
                kind: "UploadShard".to_owned(),
                tier,
                shard_index: index,
            }
        }
        mosaic_client::UploadJobEffect::CreateManifest => ClientCoreUploadJobEffect {
            kind: "CreateManifest".to_owned(),
            tier: 0,
            shard_index: 0,
        },
        mosaic_client::UploadJobEffect::AwaitSyncConfirmation => ClientCoreUploadJobEffect {
            kind: "AwaitSyncConfirmation".to_owned(),
            tier: 0,
            shard_index: 0,
        },
        mosaic_client::UploadJobEffect::RecoverManifestThroughSync => ClientCoreUploadJobEffect {
            kind: "RecoverManifestThroughSync".to_owned(),
            tier: 0,
            shard_index: 0,
        },
        mosaic_client::UploadJobEffect::ScheduleRetry { target_phase, .. } => {
            ClientCoreUploadJobEffect {
                kind: format!("ScheduleRetry:{}", upload_phase_to_string(target_phase)),
                tier: 0,
                shard_index: 0,
            }
        }
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

fn schema_version_u16(value: u32) -> Result<u16, u16> {
    u16::try_from(value)
        .map_err(|_| mosaic_client::ClientErrorCode::ClientCoreInvalidSnapshot.as_u16())
}

fn client_error_code_from_u16(value: u16) -> Option<mosaic_client::ClientErrorCode> {
    match value {
        0 => Some(mosaic_client::ClientErrorCode::Ok),
        100 => Some(mosaic_client::ClientErrorCode::InvalidHeaderLength),
        101 => Some(mosaic_client::ClientErrorCode::InvalidMagic),
        102 => Some(mosaic_client::ClientErrorCode::UnsupportedVersion),
        103 => Some(mosaic_client::ClientErrorCode::InvalidTier),
        104 => Some(mosaic_client::ClientErrorCode::NonZeroReservedByte),
        200 => Some(mosaic_client::ClientErrorCode::EmptyContext),
        201 => Some(mosaic_client::ClientErrorCode::InvalidKeyLength),
        202 => Some(mosaic_client::ClientErrorCode::InvalidInputLength),
        203 => Some(mosaic_client::ClientErrorCode::InvalidEnvelope),
        204 => Some(mosaic_client::ClientErrorCode::MissingCiphertext),
        205 => Some(mosaic_client::ClientErrorCode::AuthenticationFailed),
        206 => Some(mosaic_client::ClientErrorCode::RngFailure),
        207 => Some(mosaic_client::ClientErrorCode::WrappedKeyTooShort),
        208 => Some(mosaic_client::ClientErrorCode::KdfProfileTooWeak),
        209 => Some(mosaic_client::ClientErrorCode::InvalidSaltLength),
        210 => Some(mosaic_client::ClientErrorCode::KdfFailure),
        211 => Some(mosaic_client::ClientErrorCode::InvalidSignatureLength),
        212 => Some(mosaic_client::ClientErrorCode::InvalidPublicKey),
        213 => Some(mosaic_client::ClientErrorCode::InvalidUsername),
        214 => Some(mosaic_client::ClientErrorCode::KdfProfileTooCostly),
        300 => Some(mosaic_client::ClientErrorCode::OperationCancelled),
        400 => Some(mosaic_client::ClientErrorCode::SecretHandleNotFound),
        401 => Some(mosaic_client::ClientErrorCode::IdentityHandleNotFound),
        402 => Some(mosaic_client::ClientErrorCode::HandleSpaceExhausted),
        403 => Some(mosaic_client::ClientErrorCode::EpochHandleNotFound),
        500 => Some(mosaic_client::ClientErrorCode::InternalStatePoisoned),
        600 => Some(mosaic_client::ClientErrorCode::UnsupportedMediaFormat),
        601 => Some(mosaic_client::ClientErrorCode::InvalidMediaContainer),
        602 => Some(mosaic_client::ClientErrorCode::InvalidMediaDimensions),
        603 => Some(mosaic_client::ClientErrorCode::MediaOutputTooLarge),
        604 => Some(mosaic_client::ClientErrorCode::MediaMetadataMismatch),
        605 => Some(mosaic_client::ClientErrorCode::InvalidMediaSidecar),
        606 => Some(mosaic_client::ClientErrorCode::MediaAdapterOutputMismatch),
        700 => Some(mosaic_client::ClientErrorCode::ClientCoreInvalidTransition),
        701 => Some(mosaic_client::ClientErrorCode::ClientCoreMissingEventPayload),
        702 => Some(mosaic_client::ClientErrorCode::ClientCoreRetryBudgetExhausted),
        703 => Some(mosaic_client::ClientErrorCode::ClientCoreSyncPageDidNotAdvance),
        704 => Some(mosaic_client::ClientErrorCode::ClientCoreManifestOutcomeUnknown),
        705 => Some(mosaic_client::ClientErrorCode::ClientCoreUnsupportedSnapshotVersion),
        706 => Some(mosaic_client::ClientErrorCode::ClientCoreInvalidSnapshot),
        _ => None,
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
        max_retry_count: 0,
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
    upload_snapshot_json(result.code, &result.transition.snapshot)
}

fn upload_snapshot_json(code: u16, snapshot: &ClientCoreUploadJobSnapshot) -> String {
    format!(
        "{{\"code\":{},\"schemaVersion\":{},\"jobId\":\"{}\",\"albumId\":\"{}\",\"assetId\":\"{}\",\"phase\":\"{}\",\"shardRefCount\":{}}}",
        code,
        snapshot.schema_version,
        json_escape(&snapshot.job_id),
        json_escape(&snapshot.album_id),
        json_escape(&snapshot.asset_id),
        json_escape(&snapshot.phase),
        snapshot.completed_shards.len()
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

fn map_metadata_sidecar_error(_error: MetadataSidecarError) -> u16 {
    mosaic_client::ClientErrorCode::InvalidInputLength.as_u16()
}

fn js_account_unlock_result_from_rust(result: AccountUnlockResult) -> JsAccountUnlockResult {
    JsAccountUnlockResult {
        code: result.code,
        handle: result.handle,
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
}
