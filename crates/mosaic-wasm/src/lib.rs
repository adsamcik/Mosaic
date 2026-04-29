//! WASM facade boundary crate for the Mosaic web worker integration.

#![forbid(unsafe_code)]

use std::fmt;

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
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateAccountResult {
    pub code: u16,
    pub handle: u64,
    pub wrapped_account_key: Vec<u8>,
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

/// Rust-side WASM facade auth keypair derivation result.
///
/// The auth signing secret stays inside Rust; only the 32-byte Ed25519
/// public key is exposed across the FFI boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthKeypairResult {
    pub code: u16,
    pub auth_public_key: Vec<u8>,
}

/// Rust-side WASM facade share-link key derivation result.
#[derive(Clone, PartialEq, Eq)]
pub struct LinkKeysResult {
    pub code: u16,
    pub link_id: Vec<u8>,
    pub wrapping_key: Vec<u8>,
}

impl fmt::Debug for LinkKeysResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LinkKeysResult")
            .field("code", &self.code)
            .field("link_id_len", &self.link_id.len())
            .field("wrapping_key_len", &self.wrapping_key.len())
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

/// Rust-side WASM facade opened-bundle result.
///
/// Carries client-local secret bytes (`epoch_seed`, `sign_secret_seed`) so
/// it intentionally does not implement `Debug`.
#[derive(Clone, PartialEq, Eq)]
pub struct OpenedBundleResult {
    pub code: u16,
    pub version: u32,
    pub album_id: String,
    pub epoch_id: u32,
    pub recipient_pubkey: Vec<u8>,
    pub epoch_seed: Vec<u8>,
    pub sign_secret_seed: Vec<u8>,
    pub sign_public_key: Vec<u8>,
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
/// Carries client-local plaintext bytes on success and intentionally does
/// not implement `Debug`.
#[derive(Clone, PartialEq, Eq)]
pub struct DecryptedContentResult {
    pub code: u16,
    pub plaintext: Vec<u8>,
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

/// WASM-bindgen class for share-link key derivation results.
#[wasm_bindgen(js_name = LinkKeysResult)]
pub struct JsLinkKeysResult {
    code: u16,
    link_id: Vec<u8>,
    wrapping_key: Vec<u8>,
}

#[wasm_bindgen(js_class = LinkKeysResult)]
impl JsLinkKeysResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// 16-byte server-visible share-link lookup ID.
    #[wasm_bindgen(getter, js_name = linkId)]
    #[must_use]
    pub fn link_id(&self) -> Vec<u8> {
        self.link_id.clone()
    }

    /// 32-byte client-side wrapping key. Callers MUST memzero after use.
    #[wasm_bindgen(getter, js_name = wrappingKey)]
    #[must_use]
    pub fn wrapping_key(&self) -> Vec<u8> {
        self.wrapping_key.clone()
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

/// WASM-bindgen class for opened-bundle results.
#[wasm_bindgen(js_name = OpenedBundleResult)]
pub struct JsOpenedBundleResult {
    code: u16,
    version: u32,
    album_id: String,
    epoch_id: u32,
    recipient_pubkey: Vec<u8>,
    epoch_seed: Vec<u8>,
    sign_secret_seed: Vec<u8>,
    sign_public_key: Vec<u8>,
}

#[wasm_bindgen(js_class = OpenedBundleResult)]
impl JsOpenedBundleResult {
    /// Stable error code. Zero means success.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn code(&self) -> u16 {
        self.code
    }

    /// Bundle format version recovered from the payload.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn version(&self) -> u32 {
        self.version
    }

    /// Album identifier the bundle was issued for.
    #[wasm_bindgen(getter, js_name = albumId)]
    #[must_use]
    pub fn album_id(&self) -> String {
        self.album_id.clone()
    }

    /// Epoch identifier inside the bundle payload.
    #[wasm_bindgen(getter, js_name = epochId)]
    #[must_use]
    pub fn epoch_id(&self) -> u32 {
        self.epoch_id
    }

    /// 32-byte recipient Ed25519 public key from the payload.
    #[wasm_bindgen(getter, js_name = recipientPubkey)]
    #[must_use]
    pub fn recipient_pubkey(&self) -> Vec<u8> {
        self.recipient_pubkey.clone()
    }

    /// 32-byte epoch seed. Callers MUST memzero after deriving tier/content keys.
    #[wasm_bindgen(getter, js_name = epochSeed)]
    #[must_use]
    pub fn epoch_seed(&self) -> Vec<u8> {
        self.epoch_seed.clone()
    }

    /// 32-byte per-epoch Ed25519 manifest signing seed. Callers MUST memzero.
    #[wasm_bindgen(getter, js_name = signSecretSeed)]
    #[must_use]
    pub fn sign_secret_seed(&self) -> Vec<u8> {
        self.sign_secret_seed.clone()
    }

    /// 32-byte per-epoch Ed25519 manifest signing public key.
    #[wasm_bindgen(getter, js_name = signPublicKey)]
    #[must_use]
    pub fn sign_public_key(&self) -> Vec<u8> {
        self.sign_public_key.clone()
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

/// Creates a fresh account-key handle in a single Argon2id pass.
///
/// Generates a random L2, wraps it under L1 (`Argon2id(password,
/// user_salt) → HKDF(account_salt)`), and opens an opaque secret handle.
/// The caller-owned `password` buffer is zeroized on every path before
/// this function returns.
#[must_use]
pub fn create_new_account(
    mut password: Vec<u8>,
    user_salt: Vec<u8>,
    account_salt: Vec<u8>,
    kdf_memory_kib: u32,
    kdf_iterations: u32,
    kdf_parallelism: u32,
) -> CreateAccountResult {
    let result = mosaic_client::create_new_account_handle(
        password.as_mut_slice(),
        &user_salt,
        &account_salt,
        kdf_memory_kib,
        kdf_iterations,
        kdf_parallelism,
    );
    password.zeroize();
    create_account_result_from_client(result)
}

/// Wraps `plaintext` with the L2 account key referenced by `account_handle`.
#[must_use]
pub fn wrap_with_account_handle(account_handle: u64, plaintext: Vec<u8>) -> BytesResult {
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

/// Derives the OPFS-snapshot DB session key from the L2 account key
/// referenced by `account_handle`.
#[must_use]
pub fn derive_db_session_key_from_account(account_handle: u64) -> BytesResult {
    bytes_result_from_client(mosaic_client::derive_db_session_key_from_account_handle(
        account_handle,
    ))
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

/// Returns the per-tier 32-byte key bytes for an open epoch-key handle.
///
/// Callers MUST memzero `BytesResult.bytes` after use; the returned vector
/// is the raw HKDF tier key for the requested shard tier.
#[must_use]
pub fn get_tier_key_from_epoch(epoch_handle: u64, tier_byte: u8) -> BytesResult {
    bytes_result_from_client(mosaic_client::get_tier_key_from_epoch_handle(
        epoch_handle,
        tier_byte,
    ))
}

/// Derives the album content encryption key from an epoch-key handle.
///
/// Callers MUST memzero `BytesResult.bytes` after use.
#[must_use]
pub fn derive_content_key_from_epoch(epoch_handle: u64) -> BytesResult {
    bytes_result_from_client(mosaic_client::derive_content_key_from_epoch_handle(
        epoch_handle,
    ))
}

/// Wraps `key_bytes` with the supplied 32-byte wrapper key.
#[must_use]
pub fn wrap_key(mut key_bytes: Vec<u8>, mut wrapper_key: Vec<u8>) -> BytesResult {
    let result = bytes_result_from_client(mosaic_client::wrap_key_with_wrapper_bytes(
        &key_bytes,
        &wrapper_key,
    ));
    key_bytes.zeroize();
    wrapper_key.zeroize();
    result
}

/// Unwraps a previously wrapped key with the supplied 32-byte wrapper key.
#[must_use]
pub fn unwrap_key(wrapped: Vec<u8>, mut wrapper_key: Vec<u8>) -> BytesResult {
    let result = bytes_result_from_client(mosaic_client::unwrap_key_with_wrapper_bytes(
        &wrapped,
        &wrapper_key,
    ));
    wrapper_key.zeroize();
    result
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
    mut password: Vec<u8>,
    user_salt: Vec<u8>,
    kdf_memory_kib: u32,
    kdf_iterations: u32,
    kdf_parallelism: u32,
) -> AuthKeypairResult {
    let result = mosaic_client::derive_auth_keypair_from_password(
        password.as_mut_slice(),
        &user_salt,
        kdf_memory_kib,
        kdf_iterations,
        kdf_parallelism,
    );
    password.zeroize();
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
    mut password: Vec<u8>,
    user_salt: Vec<u8>,
    kdf_memory_kib: u32,
    kdf_iterations: u32,
    kdf_parallelism: u32,
    transcript_bytes: Vec<u8>,
) -> BytesResult {
    let result = mosaic_client::sign_auth_challenge_with_password(
        password.as_mut_slice(),
        &user_salt,
        kdf_memory_kib,
        kdf_iterations,
        kdf_parallelism,
        &transcript_bytes,
    );
    password.zeroize();
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
    mut password: Vec<u8>,
    user_salt: Vec<u8>,
    kdf_memory_kib: u32,
    kdf_iterations: u32,
    kdf_parallelism: u32,
) -> BytesResult {
    let result = mosaic_client::get_auth_public_key_from_password(
        password.as_mut_slice(),
        &user_salt,
        kdf_memory_kib,
        kdf_iterations,
        kdf_parallelism,
    );
    password.zeroize();
    bytes_result_from_client(result)
}

/// Generates a fresh 32-byte share-link secret using the OS CSPRNG.
#[must_use]
pub fn generate_link_secret() -> BytesResult {
    bytes_result_from_client(mosaic_client::generate_link_secret())
}

/// Derives the `(link_id, wrapping_key)` pair from a 32-byte share-link secret.
#[must_use]
pub fn derive_link_keys(mut link_secret: Vec<u8>) -> LinkKeysResult {
    let result = link_keys_result_from_client(mosaic_client::derive_link_keys(&link_secret));
    link_secret.zeroize();
    result
}

/// Wraps the tier key for `epoch_handle` so it can be stored on a
/// share-link record.
#[must_use]
pub fn wrap_tier_key_for_link(
    epoch_handle: u64,
    tier_byte: u8,
    mut wrapping_key: Vec<u8>,
) -> WrappedTierKeyResult {
    let result = wrapped_tier_key_result_from_client(
        mosaic_client::wrap_tier_key_for_link_with_epoch_handle(
            epoch_handle,
            tier_byte,
            &wrapping_key,
        ),
    );
    wrapping_key.zeroize();
    result
}

/// Unwraps a previously wrapped tier key from a share-link record.
///
/// Callers MUST memzero `BytesResult.bytes` after use.
#[must_use]
pub fn unwrap_tier_key_from_link(
    nonce: Vec<u8>,
    encrypted_key: Vec<u8>,
    tier_byte: u8,
    mut wrapping_key: Vec<u8>,
) -> BytesResult {
    let result = bytes_result_from_client(mosaic_client::unwrap_tier_key_from_link_bytes(
        &nonce,
        &encrypted_key,
        tier_byte,
        &wrapping_key,
    ));
    wrapping_key.zeroize();
    result
}

/// Seals an epoch key bundle for `recipient_pubkey` and signs it with the
/// supplied identity handle.
#[allow(clippy::too_many_arguments)]
#[must_use]
pub fn seal_and_sign_bundle(
    identity_handle: u64,
    recipient_pubkey: Vec<u8>,
    album_id: String,
    epoch_id: u32,
    mut epoch_seed: Vec<u8>,
    mut sign_secret: Vec<u8>,
    sign_public: Vec<u8>,
) -> SealedBundleResult {
    let result =
        sealed_bundle_result_from_client(mosaic_client::seal_and_sign_bundle_with_identity_handle(
            identity_handle,
            &recipient_pubkey,
            album_id,
            epoch_id,
            &epoch_seed,
            &sign_secret,
            &sign_public,
        ));
    epoch_seed.zeroize();
    sign_secret.zeroize();
    result
}

/// Verifies a sealed bundle's signature and opens it for the recipient
/// bound to `identity_handle`.
#[allow(clippy::too_many_arguments)]
#[must_use]
pub fn verify_and_open_bundle(
    identity_handle: u64,
    sealed: Vec<u8>,
    signature: Vec<u8>,
    sharer_pubkey: Vec<u8>,
    expected_album_id: String,
    expected_min_epoch: u32,
    allow_legacy_empty: bool,
) -> OpenedBundleResult {
    opened_bundle_result_from_client(mosaic_client::verify_and_open_bundle_with_identity_handle(
        identity_handle,
        &sealed,
        &signature,
        &sharer_pubkey,
        expected_album_id,
        expected_min_epoch,
        allow_legacy_empty,
    ))
}

/// Imports an epoch handle from cleartext bundle payload bytes (epoch seed
/// plus the per-epoch manifest signing keypair) returned by
/// `verify_and_open_bundle`. Both secret buffers are zeroized inside this
/// function on every path.
#[must_use]
pub fn import_epoch_key_handle_from_bundle(
    account_key_handle: u64,
    epoch_id: u32,
    mut epoch_seed: Vec<u8>,
    mut sign_secret_seed: Vec<u8>,
    sign_public: Vec<u8>,
) -> EpochKeyHandleResult {
    let result = epoch_result_from_client(mosaic_client::import_epoch_key_handle_from_bundle(
        account_key_handle,
        epoch_id,
        &epoch_seed,
        &sign_secret_seed,
        &sign_public,
    ));
    epoch_seed.zeroize();
    sign_secret_seed.zeroize();
    result
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
pub fn encrypt_album_content(epoch_handle: u64, mut plaintext: Vec<u8>) -> EncryptedContentResult {
    let result = encrypted_content_result_from_client(
        mosaic_client::encrypt_album_content_with_epoch_handle(epoch_handle, &plaintext),
    );
    plaintext.zeroize();
    result
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

/// Returns a tier key for an epoch handle through WASM.
#[wasm_bindgen(js_name = getTierKeyFromEpoch)]
#[must_use]
pub fn get_tier_key_from_epoch_js(epoch_handle: u64, tier_byte: u8) -> JsBytesResult {
    js_bytes_result_from_rust(get_tier_key_from_epoch(epoch_handle, tier_byte))
}

/// Derives the content key from an epoch handle through WASM.
#[wasm_bindgen(js_name = deriveContentKeyFromEpoch)]
#[must_use]
pub fn derive_content_key_from_epoch_js(epoch_handle: u64) -> JsBytesResult {
    js_bytes_result_from_rust(derive_content_key_from_epoch(epoch_handle))
}

/// Wraps a key with a 32-byte wrapper key through WASM.
#[wasm_bindgen(js_name = wrapKey)]
#[must_use]
pub fn wrap_key_js(key_bytes: Vec<u8>, wrapper_key: Vec<u8>) -> JsBytesResult {
    js_bytes_result_from_rust(wrap_key(key_bytes, wrapper_key))
}

/// Unwraps a wrapped key with a 32-byte wrapper key through WASM.
#[wasm_bindgen(js_name = unwrapKey)]
#[must_use]
pub fn unwrap_key_js(wrapped: Vec<u8>, wrapper_key: Vec<u8>) -> JsBytesResult {
    js_bytes_result_from_rust(unwrap_key(wrapped, wrapper_key))
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

/// Derives the OPFS-snapshot DB session key from the L2 account key
/// referenced by `account_handle` through WASM. Caller MUST memzero the
/// returned bytes after use.
#[wasm_bindgen(js_name = deriveDbSessionKeyFromAccount)]
#[must_use]
pub fn derive_db_session_key_from_account_js(account_handle: u64) -> JsBytesResult {
    js_bytes_result_from_rust(derive_db_session_key_from_account(account_handle))
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

/// Generates a fresh share-link secret through WASM.
#[wasm_bindgen(js_name = generateLinkSecret)]
#[must_use]
pub fn generate_link_secret_js() -> JsBytesResult {
    js_bytes_result_from_rust(generate_link_secret())
}

/// Derives the (link_id, wrapping_key) pair from a share-link secret through WASM.
#[wasm_bindgen(js_name = deriveLinkKeys)]
#[must_use]
pub fn derive_link_keys_js(link_secret: Vec<u8>) -> JsLinkKeysResult {
    js_link_keys_result_from_rust(derive_link_keys(link_secret))
}

/// Wraps a tier key for share-link distribution through WASM.
#[wasm_bindgen(js_name = wrapTierKeyForLink)]
#[must_use]
pub fn wrap_tier_key_for_link_js(
    epoch_handle: u64,
    tier_byte: u8,
    wrapping_key: Vec<u8>,
) -> JsWrappedTierKeyResult {
    js_wrapped_tier_key_result_from_rust(wrap_tier_key_for_link(
        epoch_handle,
        tier_byte,
        wrapping_key,
    ))
}

/// Unwraps a tier key from a share-link record through WASM.
#[wasm_bindgen(js_name = unwrapTierKeyFromLink)]
#[must_use]
pub fn unwrap_tier_key_from_link_js(
    nonce: Vec<u8>,
    encrypted_key: Vec<u8>,
    tier_byte: u8,
    wrapping_key: Vec<u8>,
) -> JsBytesResult {
    js_bytes_result_from_rust(unwrap_tier_key_from_link(
        nonce,
        encrypted_key,
        tier_byte,
        wrapping_key,
    ))
}

/// Seals and signs an epoch key bundle through WASM.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen(js_name = sealAndSignBundle)]
#[must_use]
pub fn seal_and_sign_bundle_js(
    identity_handle: u64,
    recipient_pubkey: Vec<u8>,
    album_id: String,
    epoch_id: u32,
    epoch_seed: Vec<u8>,
    sign_secret: Vec<u8>,
    sign_public: Vec<u8>,
) -> JsSealedBundleResult {
    js_sealed_bundle_result_from_rust(seal_and_sign_bundle(
        identity_handle,
        recipient_pubkey,
        album_id,
        epoch_id,
        epoch_seed,
        sign_secret,
        sign_public,
    ))
}

/// Verifies and opens a sealed epoch key bundle through WASM.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen(js_name = verifyAndOpenBundle)]
#[must_use]
pub fn verify_and_open_bundle_js(
    identity_handle: u64,
    sealed: Vec<u8>,
    signature: Vec<u8>,
    sharer_pubkey: Vec<u8>,
    expected_album_id: String,
    expected_min_epoch: u32,
    allow_legacy_empty: bool,
) -> JsOpenedBundleResult {
    js_opened_bundle_result_from_rust(verify_and_open_bundle(
        identity_handle,
        sealed,
        signature,
        sharer_pubkey,
        expected_album_id,
        expected_min_epoch,
        allow_legacy_empty,
    ))
}

/// Imports an epoch handle from cleartext bundle payload bytes through WASM.
/// Both the epoch seed and the manifest signing seed are zeroized inside
/// Rust on every path.
#[wasm_bindgen(js_name = importEpochKeyHandleFromBundle)]
#[must_use]
pub fn import_epoch_key_handle_from_bundle_js(
    account_key_handle: u64,
    epoch_id: u32,
    epoch_seed: Vec<u8>,
    sign_secret_seed: Vec<u8>,
    sign_public: Vec<u8>,
) -> JsEpochKeyHandleResult {
    js_epoch_result_from_rust(import_epoch_key_handle_from_bundle(
        account_key_handle,
        epoch_id,
        epoch_seed,
        sign_secret_seed,
        sign_public,
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

fn link_keys_result_from_client(mut result: mosaic_client::LinkKeysResult) -> LinkKeysResult {
    LinkKeysResult {
        code: result.code.as_u16(),
        link_id: std::mem::take(&mut result.link_id),
        wrapping_key: std::mem::take(&mut result.wrapping_key),
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

fn opened_bundle_result_from_client(
    mut result: mosaic_client::OpenedBundleResult,
) -> OpenedBundleResult {
    OpenedBundleResult {
        code: result.code.as_u16(),
        version: result.version,
        album_id: std::mem::take(&mut result.album_id),
        epoch_id: result.epoch_id,
        recipient_pubkey: std::mem::take(&mut result.recipient_pubkey),
        epoch_seed: std::mem::take(&mut result.epoch_seed),
        sign_secret_seed: std::mem::take(&mut result.sign_secret_seed),
        sign_public_key: std::mem::take(&mut result.sign_public_key),
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

fn js_link_keys_result_from_rust(result: LinkKeysResult) -> JsLinkKeysResult {
    JsLinkKeysResult {
        code: result.code,
        link_id: result.link_id,
        wrapping_key: result.wrapping_key,
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

fn js_opened_bundle_result_from_rust(result: OpenedBundleResult) -> JsOpenedBundleResult {
    JsOpenedBundleResult {
        code: result.code,
        version: result.version,
        album_id: result.album_id,
        epoch_id: result.epoch_id,
        recipient_pubkey: result.recipient_pubkey,
        epoch_seed: result.epoch_seed,
        sign_secret_seed: result.sign_secret_seed,
        sign_public_key: result.sign_public_key,
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
            &["wrapped_epoch_seed_len: 3"],
            &["221", "222", "223", "wrapped_epoch_seed: [", "sign_public_key"],
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
            &super::LinkKeysResult {
                code: 0,
                link_id: vec![227; 16],
                wrapping_key: vec![228, 229, 230],
            },
            &["link_id_len: 16", "wrapping_key_len: 3"],
            &["227", "228", "229", "wrapping_key: ["],
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
