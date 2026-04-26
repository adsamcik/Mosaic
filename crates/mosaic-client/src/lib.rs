//! Client orchestration boundary crate for Mosaic upload and sync state machines.

#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use mosaic_crypto::MosaicCryptoError;
use mosaic_domain::{MosaicDomainError, ShardEnvelopeHeader};

/// Stable client error codes exported through FFI facades.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum ClientErrorCode {
    Ok = 0,
    InvalidHeaderLength = 100,
    InvalidMagic = 101,
    UnsupportedVersion = 102,
    InvalidTier = 103,
    NonZeroReservedByte = 104,
    EmptyContext = 200,
    OperationCancelled = 300,
    SecretHandleNotFound = 400,
    InternalStatePoisoned = 500,
}

impl ClientErrorCode {
    /// Returns the numeric representation used across generated bindings.
    #[must_use]
    pub const fn as_u16(self) -> u16 {
        self as u16
    }
}

/// Client error with a stable code and redacted message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientError {
    pub code: ClientErrorCode,
    pub message: String,
}

impl ClientError {
    fn new(code: ClientErrorCode, message: &str) -> Self {
        Self {
            code,
            message: message.to_owned(),
        }
    }
}

/// FFI-safe header parse result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeaderResult {
    pub code: ClientErrorCode,
    pub epoch_id: u32,
    pub shard_index: u32,
    pub tier: u8,
    pub nonce: Vec<u8>,
}

impl HeaderResult {
    fn ok(header: ShardEnvelopeHeader) -> Self {
        Self {
            code: ClientErrorCode::Ok,
            epoch_id: header.epoch_id(),
            shard_index: header.shard_index(),
            tier: header.tier().to_byte(),
            nonce: header.nonce().to_vec(),
        }
    }

    fn error(code: ClientErrorCode) -> Self {
        Self {
            code,
            epoch_id: 0,
            shard_index: 0,
            tier: 0,
            nonce: Vec::new(),
        }
    }
}

/// FFI-safe bytes result for the test-only derivation probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BytesResult {
    pub code: ClientErrorCode,
    pub bytes: Vec<u8>,
}

/// FFI-safe progress event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgressEvent {
    pub completed_steps: u32,
    pub total_steps: u32,
}

/// FFI-safe progress result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgressResult {
    pub code: ClientErrorCode,
    pub events: Vec<ProgressEvent>,
}

struct SecretRecord {
    bytes: Vec<u8>,
    open: bool,
}

impl SecretRecord {
    fn close(&mut self) {
        self.bytes.fill(0);
        self.bytes.clear();
        self.open = false;
    }
}

impl Drop for SecretRecord {
    fn drop(&mut self) {
        self.close();
    }
}

static NEXT_SECRET_HANDLE: AtomicU64 = AtomicU64::new(1);
static SECRET_REGISTRY: OnceLock<Mutex<HashMap<u64, SecretRecord>>> = OnceLock::new();

fn secret_registry() -> &'static Mutex<HashMap<u64, SecretRecord>> {
    SECRET_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Returns the crate name for smoke tests and FFI wrapper diagnostics.
#[must_use]
pub const fn crate_name() -> &'static str {
    "mosaic-client"
}

/// Returns the domain protocol version this client crate is compiled against.
#[must_use]
pub const fn protocol_version() -> &'static str {
    mosaic_crypto::protocol_version()
}

/// Parses a shard header into a FFI-stable result.
#[must_use]
pub fn parse_shard_header_for_ffi(bytes: &[u8]) -> HeaderResult {
    match ShardEnvelopeHeader::parse(bytes) {
        Ok(header) => HeaderResult::ok(header),
        Err(error) => HeaderResult::error(map_domain_error(error)),
    }
}

/// Runs the explicit FFI-spike-only derivation probe.
#[must_use]
pub fn ffi_spike_probe_key(input: &[u8], context: &[u8]) -> BytesResult {
    match mosaic_crypto::test_only_derive_probe_key(input, context) {
        Ok(bytes) => BytesResult {
            code: ClientErrorCode::Ok,
            bytes: bytes.to_vec(),
        },
        Err(error) => BytesResult {
            code: map_crypto_error(error),
            bytes: Vec::new(),
        },
    }
}

/// Opens a Rust-owned opaque secret handle.
pub fn open_secret_handle(secret: &[u8]) -> Result<u64, ClientError> {
    let handle = NEXT_SECRET_HANDLE.fetch_add(1, Ordering::Relaxed);
    let registry = secret_registry();
    let mut guard = registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "secret registry lock was poisoned",
        )
    })?;

    guard.insert(
        handle,
        SecretRecord {
            bytes: secret.to_vec(),
            open: true,
        },
    );
    Ok(handle)
}

/// Returns whether an opaque secret handle is still open.
pub fn secret_handle_is_open(handle: u64) -> Result<bool, ClientError> {
    let registry = secret_registry();
    let guard = registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "secret registry lock was poisoned",
        )
    })?;

    Ok(guard.get(&handle).is_some_and(|record| record.open))
}

/// Closes and wipes a Rust-owned opaque secret handle.
pub fn close_secret_handle(handle: u64) -> Result<(), ClientError> {
    let registry = secret_registry();
    let mut guard = registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "secret registry lock was poisoned",
        )
    })?;

    match guard.remove(&handle) {
        Some(mut record) if record.open => {
            record.close();
            Ok(())
        }
        _ => Err(ClientError::new(
            ClientErrorCode::SecretHandleNotFound,
            "secret handle is not open",
        )),
    }
}

/// Runs a deterministic long-operation progress probe with optional cancellation.
#[must_use]
pub fn run_progress_probe(total_steps: u32, cancel_after: Option<u32>) -> ProgressResult {
    let mut events = Vec::new();

    if cancel_after == Some(0) {
        return ProgressResult {
            code: ClientErrorCode::OperationCancelled,
            events,
        };
    }

    for completed_steps in 1..=total_steps {
        events.push(ProgressEvent {
            completed_steps,
            total_steps,
        });

        if cancel_after.is_some_and(|cancel_step| completed_steps >= cancel_step) {
            return ProgressResult {
                code: ClientErrorCode::OperationCancelled,
                events,
            };
        }
    }

    ProgressResult {
        code: ClientErrorCode::Ok,
        events,
    }
}

fn map_domain_error(error: MosaicDomainError) -> ClientErrorCode {
    match error {
        MosaicDomainError::InvalidHeaderLength { .. } => ClientErrorCode::InvalidHeaderLength,
        MosaicDomainError::InvalidMagic => ClientErrorCode::InvalidMagic,
        MosaicDomainError::UnsupportedVersion { .. } => ClientErrorCode::UnsupportedVersion,
        MosaicDomainError::InvalidTier { .. } => ClientErrorCode::InvalidTier,
        MosaicDomainError::NonZeroReservedByte { .. } => ClientErrorCode::NonZeroReservedByte,
    }
}

fn map_crypto_error(error: MosaicCryptoError) -> ClientErrorCode {
    match error {
        MosaicCryptoError::EmptyContext => ClientErrorCode::EmptyContext,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn uses_crypto_protocol_version() {
        assert_eq!(super::protocol_version(), "mosaic-v1");
    }

    #[test]
    fn closing_secret_handle_removes_registry_entry() {
        let handle = match super::open_secret_handle(b"registry entry should be removed") {
            Ok(value) => value,
            Err(error) => panic!("secret handle should open: {error:?}"),
        };

        if let Err(error) = super::close_secret_handle(handle) {
            panic!("secret handle should close: {error:?}");
        }

        let registry = super::secret_registry();
        let guard = match registry.lock() {
            Ok(value) => value,
            Err(error) => panic!("secret registry lock should be available: {error:?}"),
        };
        assert!(!guard.contains_key(&handle));
    }
}
