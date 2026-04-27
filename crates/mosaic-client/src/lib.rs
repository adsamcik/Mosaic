//! Client orchestration boundary crate for Mosaic upload and sync state machines.

#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use mosaic_crypto::{
    IdentityKeypair, KdfProfile, MosaicCryptoError, SecretKey, derive_identity_keypair,
    generate_identity_seed, sign_manifest_with_identity as crypto_sign_manifest_with_identity,
    unwrap_account_key, unwrap_key, wrap_key,
};
use mosaic_domain::{MosaicDomainError, ShardEnvelopeHeader};
use zeroize::{Zeroize, Zeroizing};

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
    InvalidKeyLength = 201,
    InvalidInputLength = 202,
    InvalidEnvelope = 203,
    MissingCiphertext = 204,
    AuthenticationFailed = 205,
    RngFailure = 206,
    WrappedKeyTooShort = 207,
    KdfProfileTooWeak = 208,
    InvalidSaltLength = 209,
    KdfFailure = 210,
    InvalidSignatureLength = 211,
    InvalidPublicKey = 212,
    InvalidUsername = 213,
    KdfProfileTooCostly = 214,
    OperationCancelled = 300,
    SecretHandleNotFound = 400,
    IdentityHandleNotFound = 401,
    HandleSpaceExhausted = 402,
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
    /// Redacted diagnostic text for logs/UI. This must never include password bytes,
    /// key material, plaintext metadata, or other secret/user-provided content.
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

/// FFI-adjacent account unlock request.
///
/// This type intentionally does not derive `Debug`, `Clone`, `Copy`, or serialization traits
/// because it carries caller-owned password bytes.
pub struct AccountUnlockRequest<'a> {
    pub password: &'a mut [u8],
    pub user_salt: &'a [u8],
    pub account_salt: &'a [u8],
    pub wrapped_account_key: &'a [u8],
    pub kdf_memory_kib: u32,
    pub kdf_iterations: u32,
    pub kdf_parallelism: u32,
}

/// FFI-safe account unlock result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountUnlockResult {
    pub code: ClientErrorCode,
    pub handle: u64,
}

impl AccountUnlockResult {
    const fn ok(handle: u64) -> Self {
        Self {
            code: ClientErrorCode::Ok,
            handle,
        }
    }

    const fn error(code: ClientErrorCode) -> Self {
        Self { code, handle: 0 }
    }
}

/// FFI-safe identity handle result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityHandleResult {
    pub code: ClientErrorCode,
    pub handle: u64,
    pub signing_pubkey: Vec<u8>,
    pub encryption_pubkey: Vec<u8>,
    pub wrapped_seed: Vec<u8>,
}

impl IdentityHandleResult {
    fn ok(handle: u64, keypair: &IdentityKeypair, wrapped_seed: Vec<u8>) -> Self {
        Self {
            code: ClientErrorCode::Ok,
            handle,
            signing_pubkey: keypair.signing_public_key().as_bytes().to_vec(),
            encryption_pubkey: keypair.encryption_public_key().as_bytes().to_vec(),
            wrapped_seed,
        }
    }

    fn error(code: ClientErrorCode) -> Self {
        Self {
            code,
            handle: 0,
            signing_pubkey: Vec::new(),
            encryption_pubkey: Vec::new(),
            wrapped_seed: Vec::new(),
        }
    }
}

/// FFI-safe public golden-vector snapshot for cross-platform wrapper tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CryptoDomainGoldenVectorSnapshot {
    pub code: ClientErrorCode,
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

impl CryptoDomainGoldenVectorSnapshot {
    fn error(code: ClientErrorCode) -> Self {
        Self {
            code,
            envelope_header: Vec::new(),
            envelope_epoch_id: 0,
            envelope_shard_index: 0,
            envelope_tier: 0,
            envelope_nonce: Vec::new(),
            manifest_transcript: Vec::new(),
            identity_message: Vec::new(),
            identity_signing_pubkey: Vec::new(),
            identity_encryption_pubkey: Vec::new(),
            identity_signature: Vec::new(),
        }
    }
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

const MAX_PROGRESS_EVENTS: u32 = 10_000;

struct SecretRecord {
    bytes: Zeroizing<Vec<u8>>,
    open: bool,
}

impl SecretRecord {
    fn close(&mut self) {
        self.bytes.zeroize();
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

struct IdentityRecord {
    account_handle: u64,
    keypair: IdentityKeypair,
    open: bool,
}

impl IdentityRecord {
    fn close(&mut self) {
        self.keypair.zeroize_secret();
        self.open = false;
    }
}

impl Drop for IdentityRecord {
    fn drop(&mut self) {
        self.close();
    }
}

static NEXT_IDENTITY_HANDLE: AtomicU64 = AtomicU64::new(1);
static IDENTITY_REGISTRY: OnceLock<Mutex<HashMap<u64, IdentityRecord>>> = OnceLock::new();

fn secret_registry() -> &'static Mutex<HashMap<u64, SecretRecord>> {
    SECRET_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn identity_registry() -> &'static Mutex<HashMap<u64, IdentityRecord>> {
    IDENTITY_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
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

/// Returns deterministic public crypto/domain vectors for wrapper parity tests.
#[must_use]
pub fn crypto_domain_golden_vector_snapshot() -> CryptoDomainGoldenVectorSnapshot {
    let envelope_header = mosaic_domain::golden_vectors::envelope_header_bytes();
    let header_result = parse_shard_header_for_ffi(&envelope_header);
    if header_result.code != ClientErrorCode::Ok {
        return CryptoDomainGoldenVectorSnapshot::error(header_result.code);
    }

    let manifest_transcript = match mosaic_domain::golden_vectors::manifest_transcript_bytes() {
        Ok(value) => value,
        Err(_) => {
            return CryptoDomainGoldenVectorSnapshot::error(ClientErrorCode::InternalStatePoisoned);
        }
    };

    let identity_vector = match mosaic_crypto::golden_vectors::identity_public_vector() {
        Ok(value) => value,
        Err(error) => return CryptoDomainGoldenVectorSnapshot::error(map_crypto_error(error)),
    };

    CryptoDomainGoldenVectorSnapshot {
        code: ClientErrorCode::Ok,
        envelope_header: envelope_header.to_vec(),
        envelope_epoch_id: header_result.epoch_id,
        envelope_shard_index: header_result.shard_index,
        envelope_tier: header_result.tier,
        envelope_nonce: header_result.nonce,
        manifest_transcript,
        identity_message: mosaic_crypto::golden_vectors::IDENTITY_MESSAGE.to_vec(),
        identity_signing_pubkey: identity_vector.signing_pubkey().to_vec(),
        identity_encryption_pubkey: identity_vector.encryption_pubkey().to_vec(),
        identity_signature: identity_vector.signature().to_vec(),
    }
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
    let handle = allocate_handle(&NEXT_SECRET_HANDLE)?;
    let registry = secret_registry();
    let mut guard = registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "secret registry lock was poisoned",
        )
    })?;

    if guard.contains_key(&handle) {
        return Err(ClientError::new(
            ClientErrorCode::HandleSpaceExhausted,
            "secret handle space is exhausted",
        ));
    }

    guard.insert(
        handle,
        SecretRecord {
            bytes: Zeroizing::new(secret.to_vec()),
            open: true,
        },
    );
    Ok(handle)
}

/// Unwraps an account key and stores it behind a Rust-owned opaque handle.
///
/// The caller-provided password buffer is zeroized before this function returns on every path.
#[must_use]
pub fn unlock_account_key(request: AccountUnlockRequest<'_>) -> AccountUnlockResult {
    match unlock_account_key_result(request) {
        Ok(handle) => AccountUnlockResult::ok(handle),
        Err(error) => AccountUnlockResult::error(error.code),
    }
}

/// Returns whether an opaque account-key handle is still open.
pub fn account_key_handle_is_open(handle: u64) -> Result<bool, ClientError> {
    secret_handle_is_open(handle)
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

/// Closes and wipes an opaque account-key handle, cascading to linked identity handles.
pub fn close_account_key_handle(handle: u64) -> Result<(), ClientError> {
    close_secret_handle(handle)
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

    match guard.get_mut(&handle) {
        Some(record) if record.open => {
            record.open = false;
        }
        _ => {
            return Err(ClientError::new(
                ClientErrorCode::SecretHandleNotFound,
                "secret handle is not open",
            ));
        }
    }

    if let Err(error) = close_identity_handles_for_account(handle) {
        if let Some(record) = guard.get_mut(&handle) {
            record.open = true;
        }
        return Err(error);
    }

    match guard.remove(&handle) {
        Some(mut record) => {
            record.close();
        }
        None => {
            return Err(ClientError::new(
                ClientErrorCode::SecretHandleNotFound,
                "secret handle is not open",
            ));
        }
    }

    Ok(())
}

fn unlock_account_key_result(request: AccountUnlockRequest<'_>) -> Result<u64, ClientError> {
    let AccountUnlockRequest {
        password,
        user_salt,
        account_salt,
        wrapped_account_key,
        kdf_memory_kib,
        kdf_iterations,
        kdf_parallelism,
    } = request;

    let password_copy = Zeroizing::new(password.to_vec());
    password.zeroize();

    let profile = KdfProfile::new(kdf_memory_kib, kdf_iterations, kdf_parallelism)
        .map_err(client_error_from_crypto)?;
    let account_key = unwrap_account_key(
        password_copy,
        user_salt,
        account_salt,
        wrapped_account_key,
        profile,
    )
    .map_err(client_error_from_crypto)?;

    open_secret_handle(account_key.as_bytes())
}

/// Creates a new Rust-owned identity handle and returns the wrapped identity seed.
#[must_use]
pub fn create_identity_handle(account_key_handle: u64) -> IdentityHandleResult {
    match create_identity_handle_result(account_key_handle) {
        Ok(value) => value,
        Err(error) => IdentityHandleResult::error(error.code),
    }
}

/// Opens a Rust-owned identity handle from a wrapped identity seed.
#[must_use]
pub fn open_identity_handle(
    wrapped_identity_seed: &[u8],
    account_key_handle: u64,
) -> IdentityHandleResult {
    match open_identity_handle_result(wrapped_identity_seed, account_key_handle) {
        Ok(value) => value,
        Err(error) => IdentityHandleResult::error(error.code),
    }
}

/// Returns whether an opaque identity handle is still open.
pub fn identity_handle_is_open(handle: u64) -> Result<bool, ClientError> {
    let registry = identity_registry();
    let guard = registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "identity registry lock was poisoned",
        )
    })?;

    Ok(guard.get(&handle).is_some_and(|record| record.open))
}

/// Returns the Ed25519 public identity key for an open identity handle.
#[must_use]
pub fn identity_signing_pubkey(handle: u64) -> BytesResult {
    with_identity(handle, |record| BytesResult {
        code: ClientErrorCode::Ok,
        bytes: record
            .keypair
            .signing_public_key()
            .as_bytes()
            .as_slice()
            .to_vec(),
    })
    .unwrap_or_else(bytes_error)
}

/// Returns the X25519 recipient public key for an open identity handle.
#[must_use]
pub fn identity_encryption_pubkey(handle: u64) -> BytesResult {
    with_identity(handle, |record| BytesResult {
        code: ClientErrorCode::Ok,
        bytes: record
            .keypair
            .encryption_public_key()
            .as_bytes()
            .as_slice()
            .to_vec(),
    })
    .unwrap_or_else(bytes_error)
}

/// Signs manifest transcript bytes with an open identity handle.
#[must_use]
pub fn sign_manifest_with_identity(handle: u64, transcript_bytes: &[u8]) -> BytesResult {
    with_identity(handle, |record| {
        let signature =
            crypto_sign_manifest_with_identity(transcript_bytes, record.keypair.secret_key());
        BytesResult {
            code: ClientErrorCode::Ok,
            bytes: signature.as_bytes().to_vec(),
        }
    })
    .unwrap_or_else(bytes_error)
}

/// Closes and wipes a Rust-owned opaque identity handle.
pub fn close_identity_handle(handle: u64) -> Result<(), ClientError> {
    let registry = identity_registry();
    let mut guard = registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "identity registry lock was poisoned",
        )
    })?;

    match guard.remove(&handle) {
        Some(mut record) if record.open => {
            record.close();
            Ok(())
        }
        _ => Err(ClientError::new(
            ClientErrorCode::IdentityHandleNotFound,
            "identity handle is not open",
        )),
    }
}

fn create_identity_handle_result(
    account_key_handle: u64,
) -> Result<IdentityHandleResult, ClientError> {
    let account_key = account_secret_key_from_handle(account_key_handle)?;
    let mut identity_seed = generate_identity_seed().map_err(client_error_from_crypto)?;
    let wrapped_seed =
        wrap_key(identity_seed.as_slice(), &account_key).map_err(client_error_from_crypto)?;
    insert_identity_handle(
        account_key_handle,
        identity_seed.as_mut_slice(),
        wrapped_seed,
    )
}

fn open_identity_handle_result(
    wrapped_identity_seed: &[u8],
    account_key_handle: u64,
) -> Result<IdentityHandleResult, ClientError> {
    let account_key = account_secret_key_from_handle(account_key_handle)?;
    let mut identity_seed =
        unwrap_key(wrapped_identity_seed, &account_key).map_err(client_error_from_crypto)?;
    insert_identity_handle(account_key_handle, identity_seed.as_mut_slice(), Vec::new())
}

fn insert_identity_handle(
    account_handle: u64,
    identity_seed: &mut [u8],
    wrapped_seed: Vec<u8>,
) -> Result<IdentityHandleResult, ClientError> {
    let keypair = derive_identity_keypair(identity_seed).map_err(client_error_from_crypto)?;
    let handle = allocate_handle(&NEXT_IDENTITY_HANDLE)?;
    let result = IdentityHandleResult::ok(handle, &keypair, wrapped_seed);

    let registry = identity_registry();
    let mut guard = registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "identity registry lock was poisoned",
        )
    })?;
    if guard.contains_key(&handle) {
        return Err(ClientError::new(
            ClientErrorCode::HandleSpaceExhausted,
            "identity handle space is exhausted",
        ));
    }
    guard.insert(
        handle,
        IdentityRecord {
            account_handle,
            keypair,
            open: true,
        },
    );

    Ok(result)
}

fn account_secret_key_from_handle(handle: u64) -> Result<SecretKey, ClientError> {
    let mut account_key_bytes = {
        let registry = secret_registry();
        let guard = registry.lock().map_err(|_| {
            ClientError::new(
                ClientErrorCode::InternalStatePoisoned,
                "secret registry lock was poisoned",
            )
        })?;
        let record = guard
            .get(&handle)
            .filter(|record| record.open)
            .ok_or_else(|| {
                ClientError::new(
                    ClientErrorCode::SecretHandleNotFound,
                    "account key handle is not open",
                )
            })?;

        Zeroizing::new(record.bytes.as_slice().to_vec())
    };

    SecretKey::from_bytes(account_key_bytes.as_mut_slice()).map_err(client_error_from_crypto)
}

fn close_identity_handles_for_account(account_handle: u64) -> Result<(), ClientError> {
    let registry = identity_registry();
    let mut guard = registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "identity registry lock was poisoned",
        )
    })?;

    guard.retain(|_, record| {
        if record.account_handle == account_handle {
            record.close();
            false
        } else {
            true
        }
    });
    Ok(())
}

fn with_identity<T>(
    handle: u64,
    action: impl FnOnce(&IdentityRecord) -> T,
) -> Result<T, ClientError> {
    let registry = identity_registry();
    let guard = registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "identity registry lock was poisoned",
        )
    })?;
    let record = guard
        .get(&handle)
        .filter(|record| record.open)
        .ok_or_else(|| {
            ClientError::new(
                ClientErrorCode::IdentityHandleNotFound,
                "identity handle is not open",
            )
        })?;

    Ok(action(record))
}

fn bytes_error(error: ClientError) -> BytesResult {
    BytesResult {
        code: error.code,
        bytes: Vec::new(),
    }
}

fn client_error_from_crypto(error: MosaicCryptoError) -> ClientError {
    ClientError::new(map_crypto_error(error), "cryptographic operation failed")
}

fn allocate_handle(counter: &AtomicU64) -> Result<u64, ClientError> {
    counter
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
            if current == 0 {
                return None;
            }
            current.checked_add(1)
        })
        .map_err(|_| {
            ClientError::new(
                ClientErrorCode::HandleSpaceExhausted,
                "handle space is exhausted",
            )
        })
}

/// Runs a deterministic long-operation progress probe with optional cancellation.
#[must_use]
pub fn run_progress_probe(total_steps: u32, cancel_after: Option<u32>) -> ProgressResult {
    if total_steps > MAX_PROGRESS_EVENTS {
        return ProgressResult {
            code: ClientErrorCode::InvalidInputLength,
            events: Vec::new(),
        };
    }

    let mut events = Vec::with_capacity(total_steps as usize);

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
        MosaicCryptoError::InvalidKeyLength { .. } => ClientErrorCode::InvalidKeyLength,
        MosaicCryptoError::InvalidInputLength { .. } => ClientErrorCode::InvalidInputLength,
        MosaicCryptoError::InvalidEnvelope => ClientErrorCode::InvalidEnvelope,
        MosaicCryptoError::MissingCiphertext => ClientErrorCode::MissingCiphertext,
        MosaicCryptoError::AuthenticationFailed => ClientErrorCode::AuthenticationFailed,
        MosaicCryptoError::RngFailure => ClientErrorCode::RngFailure,
        MosaicCryptoError::WrappedKeyTooShort { .. } => ClientErrorCode::WrappedKeyTooShort,
        MosaicCryptoError::KdfProfileTooWeak => ClientErrorCode::KdfProfileTooWeak,
        MosaicCryptoError::KdfProfileTooCostly => ClientErrorCode::KdfProfileTooCostly,
        MosaicCryptoError::InvalidSaltLength { .. } => ClientErrorCode::InvalidSaltLength,
        MosaicCryptoError::KdfFailure => ClientErrorCode::KdfFailure,
        MosaicCryptoError::InvalidSignatureLength { .. } => ClientErrorCode::InvalidSignatureLength,
        MosaicCryptoError::InvalidPublicKey => ClientErrorCode::InvalidPublicKey,
        MosaicCryptoError::InvalidUsername => ClientErrorCode::InvalidUsername,
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

    #[test]
    fn handle_allocator_rejects_wraparound() {
        let counter = std::sync::atomic::AtomicU64::new(u64::MAX);

        let error = match super::allocate_handle(&counter) {
            Ok(handle) => panic!("wrapped handle should be rejected: {handle}"),
            Err(error) => error,
        };

        assert_eq!(error.code, super::ClientErrorCode::HandleSpaceExhausted);
        assert_eq!(counter.load(std::sync::atomic::Ordering::Relaxed), u64::MAX);
    }
}
