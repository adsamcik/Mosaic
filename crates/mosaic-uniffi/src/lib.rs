//! UniFFI/JNI facade boundary crate for the Mosaic Android integration.

#![forbid(unsafe_code)]

use zeroize::Zeroize;

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

/// Returns the crate name for smoke tests and generated wrapper diagnostics.
#[must_use]
pub const fn crate_name() -> &'static str {
    "mosaic-uniffi"
}

/// Returns the domain protocol version this UniFFI facade is compiled against.
#[must_use]
pub const fn protocol_version() -> &'static str {
    mosaic_client::protocol_version()
}

/// Returns the stable UniFFI API snapshot for this FFI spike.
#[must_use]
pub const fn uniffi_api_snapshot() -> &'static str {
    "mosaic-uniffi ffi-spike:v3 parse_envelope_header(bytes)->HeaderResult progress(total,cancel_after)->ProgressResult account(unlock/status/close) identity(create/open/close/pubkeys/sign)"
}

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

/// Closes an identity handle and returns the stable error code.
#[uniffi::export]
#[must_use]
pub fn close_identity_handle(handle: u64) -> u16 {
    match mosaic_client::close_identity_handle(handle) {
        Ok(()) => mosaic_client::ClientErrorCode::Ok.as_u16(),
        Err(error) => error.code.as_u16(),
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

uniffi::setup_scaffolding!();

#[cfg(test)]
mod tests {
    #[test]
    fn uses_client_protocol_version() {
        assert_eq!(super::protocol_version(), "mosaic-v1");
    }
}
