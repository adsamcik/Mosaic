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
    "mosaic-wasm ffi-spike:v5 parse_envelope_header(bytes)->HeaderResult progress(total,cancel_after)->ProgressResult account(unlock/status/close) identity(create/open/close/pubkeys/sign/verify) epoch(create/open/status/close/encrypt/decrypt) metadata(canonical/encrypt) vectors(crypto-domain)->CryptoDomainGoldenVectorSnapshot"
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
