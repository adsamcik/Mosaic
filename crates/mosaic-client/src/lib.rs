//! Client orchestration boundary crate for Mosaic upload and sync state machines.

#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use mosaic_crypto::{
    ACCOUNT_DATA_AAD, AuthSigningSecretKey, BundleValidationContext, EPOCH_SEED_AAD,
    EncryptedContent, EpochKeyBundle, EpochKeyMaterial, IDENTITY_SEED_AAD, IdentityKeypair,
    IdentitySignature, IdentitySigningPublicKey, KdfProfile, LinkKeys, ManifestSignature,
    ManifestSigningKeypair, ManifestSigningPublicKey, ManifestSigningSecretKey, MosaicCryptoError,
    SealedBundle, SecretKey, WrappedTierKey, build_auth_challenge_transcript, decrypt_content,
    decrypt_shard, decrypt_shard_with_legacy_raw_key, derive_account_key,
    derive_auth_signing_keypair, derive_content_key, derive_epoch_key_material,
    derive_identity_keypair, derive_link_keys as crypto_derive_link_keys, encrypt_content,
    encrypt_shard, generate_epoch_key_material, generate_identity_seed,
    generate_link_secret as crypto_generate_link_secret,
    generate_manifest_signing_keypair as crypto_generate_manifest_signing_keypair, get_tier_key,
    seal_and_sign_bundle as crypto_seal_and_sign_bundle, sign_auth_challenge,
    sign_manifest_transcript as crypto_sign_manifest_transcript,
    sign_manifest_with_identity as crypto_sign_manifest_with_identity, unwrap_account_key,
    unwrap_secret_with_aad, unwrap_tier_key_from_link as crypto_unwrap_tier_key_from_link,
    verify_and_open_bundle as crypto_verify_and_open_bundle, verify_manifest_identity_signature,
    verify_manifest_transcript as crypto_verify_manifest_transcript, wrap_secret_with_aad,
    wrap_tier_key_for_link as crypto_wrap_tier_key_for_link,
};
use mosaic_domain::{MosaicDomainError, ShardEnvelopeHeader, ShardTier};
use zeroize::{Zeroize, Zeroizing};

pub mod snapshot_schema;
pub mod state_machine;
pub use snapshot_schema::{
    AlbumSyncSnapshotPlaceholder, CURRENT_SNAPSHOT_SCHEMA_VERSION, FORBIDDEN_FIELD_NAMES,
    SCHEMA_VERSION_KEY, SNAPSHOT_SCHEMA_VERSION_V1, SnapshotMigrationError, album_sync_phase_codes,
    album_sync_snapshot_keys, upgrade_album_sync_snapshot, upgrade_upload_job_snapshot,
    upload_job_phase_codes, upload_job_snapshot_keys,
};
pub use state_machine::*;

pub use mosaic_crypto::{ShardIntegrityError, ShardSha256, verify_shard_integrity};

/// Stable client error codes exported through FFI facades.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(
    feature = "__variant-introspection",
    derive(strum::EnumCount, strum::EnumIter)
)]
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
    LinkTierMismatch = 215,
    BundleSignatureInvalid = 216,
    BundleAlbumIdEmpty = 217,
    BundleAlbumIdMismatch = 218,
    BundleEpochTooOld = 219,
    BundleRecipientMismatch = 220,
    BundleJsonParse = 221,
    BundleSealOpenFailed = 222,
    /// Shard bytes failed digest/integrity verification against the manifest commitment.
    ShardIntegrityFailed = 223,
    /// Legacy raw-key decrypt fallback succeeded and should emit telemetry only.
    LegacyRawKeyDecryptFallback = 224,
    /// Streaming AEAD decrypt observed a chunk index that did not follow the expected order.
    StreamingChunkOutOfOrder = 225,
    /// Streaming AEAD decrypt observed a final chunk count that differs from the committed total.
    StreamingTotalChunkMismatch = 226,
    /// Streaming AEAD encrypt panic recovery detected output divergence for the same plaintext.
    StreamingPlaintextDivergence = 227,
    OperationCancelled = 300,
    SecretHandleNotFound = 400,
    IdentityHandleNotFound = 401,
    HandleSpaceExhausted = 402,
    EpochHandleNotFound = 403,
    InternalStatePoisoned = 500,
    UnsupportedMediaFormat = 600,
    InvalidMediaContainer = 601,
    InvalidMediaDimensions = 602,
    MediaOutputTooLarge = 603,
    MediaMetadataMismatch = 604,
    InvalidMediaSidecar = 605,
    MediaAdapterOutputMismatch = 606,
    /// Video container parsing rejected malformed or unsupported container structure.
    VideoContainerInvalid = 607,
    /// Media inspection failed before a safe format and tier plan could be produced.
    MediaInspectFailed = 608,
    /// Metadata stripping failed before producing sanitized media bytes.
    MediaStripFailed = 609,
    /// A canonical sidecar field exceeded its append-only registry byte cap.
    SidecarFieldOverflow = 610,
    /// A canonical sidecar field used an unknown append-only registry tag.
    SidecarTagUnknown = 611,
    /// Canonical sidecar bytes failed structural validation.
    MalformedSidecar = 612,
    /// EXIF MakerNote metadata was encountered where parsing is disallowed.
    MakerNoteRejected = 613,
    /// EXIF traversal exceeded bounded parser depth, entry, or offset limits.
    ExifTraversalLimitExceeded = 614,
    /// Video input exceeds the v1 maximum accepted size.
    VideoTooLargeForV1 = 615,
    /// Video source bytes cannot be read due to corruption, DRM, or unsupported source encoding.
    VideoSourceUnreadable = 616,
    /// Generated video tier dimensions or duration shape violate the v1 tier policy.
    VideoTierShapeRejected = 617,
    /// A canonical sidecar field used a reserved tag before layout promotion.
    MetadataSidecarReservedTagNotPromoted = 618,
    ClientCoreInvalidTransition = 700,
    ClientCoreMissingEventPayload = 701,
    ClientCoreRetryBudgetExhausted = 702,
    ClientCoreSyncPageDidNotAdvance = 703,
    ClientCoreManifestOutcomeUnknown = 704,
    ClientCoreUnsupportedSnapshotVersion = 705,
    ClientCoreInvalidSnapshot = 706,
    /// Manifest finalization payload shape failed client-side contract validation.
    ManifestShapeRejected = 707,
    /// Backend idempotency state expired before a manifest/upload operation could be resolved.
    IdempotencyExpired = 708,
    /// Manifest set reconciliation found a conflicting committed manifest set.
    ManifestSetConflict = 709,
    /// Backend idempotency response conflicts with the client operation fingerprint.
    BackendIdempotencyConflict = 710,
    /// Video poster extraction failed; emitted as an event code without failing the upload.
    VideoPosterExtractionFailed = 711,
    /// Android TLS certificate pin validation failed for a configured Mosaic endpoint.
    PinValidationFailed = 800,
}

/// Opaque epoch-key handle identifier.
pub type EpochHandleId = u64;
/// Opaque share-link wrapping-state handle identifier.
pub type LinkShareHandleId = u64;
/// Opaque imported share-link tier-key handle identifier.
pub type LinkTierHandleId = u64;

impl ClientErrorCode {
    /// Returns the numeric representation used across generated bindings.
    #[must_use]
    pub const fn as_u16(self) -> u16 {
        self as u16
    }

    /// Converts a stable numeric representation back to a client error code.
    #[must_use]
    pub const fn try_from_u16(value: u16) -> Option<Self> {
        match value {
            0 => Some(Self::Ok),
            100 => Some(Self::InvalidHeaderLength),
            101 => Some(Self::InvalidMagic),
            102 => Some(Self::UnsupportedVersion),
            103 => Some(Self::InvalidTier),
            104 => Some(Self::NonZeroReservedByte),
            200 => Some(Self::EmptyContext),
            201 => Some(Self::InvalidKeyLength),
            202 => Some(Self::InvalidInputLength),
            203 => Some(Self::InvalidEnvelope),
            204 => Some(Self::MissingCiphertext),
            205 => Some(Self::AuthenticationFailed),
            206 => Some(Self::RngFailure),
            207 => Some(Self::WrappedKeyTooShort),
            208 => Some(Self::KdfProfileTooWeak),
            209 => Some(Self::InvalidSaltLength),
            210 => Some(Self::KdfFailure),
            211 => Some(Self::InvalidSignatureLength),
            212 => Some(Self::InvalidPublicKey),
            213 => Some(Self::InvalidUsername),
            214 => Some(Self::KdfProfileTooCostly),
            215 => Some(Self::LinkTierMismatch),
            216 => Some(Self::BundleSignatureInvalid),
            217 => Some(Self::BundleAlbumIdEmpty),
            218 => Some(Self::BundleAlbumIdMismatch),
            219 => Some(Self::BundleEpochTooOld),
            220 => Some(Self::BundleRecipientMismatch),
            221 => Some(Self::BundleJsonParse),
            222 => Some(Self::BundleSealOpenFailed),
            223 => Some(Self::ShardIntegrityFailed),
            224 => Some(Self::LegacyRawKeyDecryptFallback),
            225 => Some(Self::StreamingChunkOutOfOrder),
            226 => Some(Self::StreamingTotalChunkMismatch),
            227 => Some(Self::StreamingPlaintextDivergence),
            300 => Some(Self::OperationCancelled),
            400 => Some(Self::SecretHandleNotFound),
            401 => Some(Self::IdentityHandleNotFound),
            402 => Some(Self::HandleSpaceExhausted),
            403 => Some(Self::EpochHandleNotFound),
            500 => Some(Self::InternalStatePoisoned),
            600 => Some(Self::UnsupportedMediaFormat),
            601 => Some(Self::InvalidMediaContainer),
            602 => Some(Self::InvalidMediaDimensions),
            603 => Some(Self::MediaOutputTooLarge),
            604 => Some(Self::MediaMetadataMismatch),
            605 => Some(Self::InvalidMediaSidecar),
            606 => Some(Self::MediaAdapterOutputMismatch),
            607 => Some(Self::VideoContainerInvalid),
            608 => Some(Self::MediaInspectFailed),
            609 => Some(Self::MediaStripFailed),
            610 => Some(Self::SidecarFieldOverflow),
            611 => Some(Self::SidecarTagUnknown),
            612 => Some(Self::MalformedSidecar),
            613 => Some(Self::MakerNoteRejected),
            614 => Some(Self::ExifTraversalLimitExceeded),
            615 => Some(Self::VideoTooLargeForV1),
            616 => Some(Self::VideoSourceUnreadable),
            617 => Some(Self::VideoTierShapeRejected),
            618 => Some(Self::MetadataSidecarReservedTagNotPromoted),
            700 => Some(Self::ClientCoreInvalidTransition),
            701 => Some(Self::ClientCoreMissingEventPayload),
            702 => Some(Self::ClientCoreRetryBudgetExhausted),
            703 => Some(Self::ClientCoreSyncPageDidNotAdvance),
            704 => Some(Self::ClientCoreManifestOutcomeUnknown),
            705 => Some(Self::ClientCoreUnsupportedSnapshotVersion),
            706 => Some(Self::ClientCoreInvalidSnapshot),
            707 => Some(Self::ManifestShapeRejected),
            708 => Some(Self::IdempotencyExpired),
            709 => Some(Self::ManifestSetConflict),
            710 => Some(Self::BackendIdempotencyConflict),
            711 => Some(Self::VideoPosterExtractionFailed),
            800 => Some(Self::PinValidationFailed),
            _ => None,
        }
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
    pub(crate) fn new(code: ClientErrorCode, message: &str) -> Self {
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
#[derive(Clone, PartialEq, Eq)]
pub struct BytesResult {
    pub code: ClientErrorCode,
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

/// FFI-safe new-account creation result.
///
/// Mirrors the `(handle, wrapped_account_key)` shape produced by
/// [`create_new_account`]: the L2 account key never crosses the FFI boundary
/// — only the opaque handle plus its server-storable wrapped form.
///
/// `Debug` is implemented manually to redact the `wrapped_account_key` byte
/// payload (see SPEC-CrossPlatformHardening "Secret, PII, and Log Redaction
/// Rules"; matches the M5 `<redacted>` precedent used for every other
/// wrapped-key result). Only the byte length is exposed in the formatted
/// string so accidental `{:?}` log lines or panic messages cannot leak the
/// wrapped account key bytes.
#[derive(Clone, PartialEq, Eq)]
pub struct CreateAccountResult {
    pub code: ClientErrorCode,
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

impl CreateAccountResult {
    fn ok(handle: u64, wrapped_account_key: Vec<u8>) -> Self {
        Self {
            code: ClientErrorCode::Ok,
            handle,
            wrapped_account_key,
        }
    }

    fn error(code: ClientErrorCode) -> Self {
        Self {
            code,
            handle: 0,
            wrapped_account_key: Vec::new(),
        }
    }
}

/// FFI-safe identity handle result.
#[derive(Clone, PartialEq, Eq)]
pub struct IdentityHandleResult {
    pub code: ClientErrorCode,
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

/// FFI-safe epoch-key handle result.
#[derive(Clone, PartialEq, Eq)]
pub struct EpochKeyHandleResult {
    pub code: ClientErrorCode,
    pub handle: u64,
    pub epoch_id: u32,
    pub wrapped_epoch_seed: Vec<u8>,
    /// Per-epoch Ed25519 manifest signing public key.
    ///
    /// Empty when the epoch handle has no sign keypair attached (the legacy
    /// `open_epoch_key_handle` path which only restores tier-key material).
    /// Bundle-derived (`import_epoch_key_handle_from_bundle`) and freshly
    /// generated (`create_epoch_key_handle`) handles always populate this
    /// field with the 32-byte Ed25519 public key so callers can publish it
    /// in the `signPubkey` field of the create/rotate API requests without
    /// touching secret material.
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

impl EpochKeyHandleResult {
    fn ok(
        handle: u64,
        epoch_id: u32,
        wrapped_epoch_seed: Vec<u8>,
        sign_public_key: Vec<u8>,
    ) -> Self {
        Self {
            code: ClientErrorCode::Ok,
            handle,
            epoch_id,
            wrapped_epoch_seed,
            sign_public_key,
        }
    }

    fn error(code: ClientErrorCode) -> Self {
        Self {
            code,
            handle: 0,
            epoch_id: 0,
            wrapped_epoch_seed: Vec::new(),
            sign_public_key: Vec::new(),
        }
    }
}

/// FFI-safe epoch-key handle status result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EpochKeyHandleStatusResult {
    pub code: ClientErrorCode,
    pub is_open: bool,
}

/// FFI-safe encrypted shard result.
#[derive(Clone, PartialEq, Eq)]
pub struct EncryptedShardResult {
    pub code: ClientErrorCode,
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

impl EncryptedShardResult {
    fn ok(envelope_bytes: Vec<u8>, sha256: String) -> Self {
        Self {
            code: ClientErrorCode::Ok,
            envelope_bytes,
            sha256,
        }
    }

    fn error(code: ClientErrorCode) -> Self {
        Self {
            code,
            envelope_bytes: Vec::new(),
            sha256: String::new(),
        }
    }
}

/// FFI-safe decrypted shard result.
///
/// This type carries client-local plaintext media bytes on success and
/// intentionally does not implement `Debug`. The `Drop` impl proactively
/// zeroes the plaintext buffer so dropped (un-consumed) results do not leak
/// plaintext shard bytes through heap memory.
#[derive(Clone, PartialEq, Eq)]
pub struct DecryptedShardResult {
    pub code: ClientErrorCode,
    pub plaintext: Vec<u8>,
}

impl Drop for DecryptedShardResult {
    fn drop(&mut self) {
        self.plaintext.zeroize();
    }
}

impl DecryptedShardResult {
    fn ok(plaintext: Vec<u8>) -> Self {
        Self {
            code: ClientErrorCode::Ok,
            plaintext,
        }
    }

    fn error(code: ClientErrorCode) -> Self {
        Self {
            code,
            plaintext: Vec::new(),
        }
    }
}

/// FFI-safe auth keypair derivation result.
///
/// The auth signing secret stays inside Rust (it is re-derived on demand for
/// every `sign_auth_challenge_with_account_handle` call) so only the public
/// key is exposed across the WASM boundary. Callers that want to memzero
/// the public key bytes after use are free to do so but the value is not
/// secret on its own.
///
/// `Debug` is implemented manually to redact the `auth_public_key` byte
/// payload — same `<redacted>` discipline applied to every other key-bearing
/// FFI struct (`IdentityHandleResult` etc., established by M5,
/// commit fb26573). Only the byte length surfaces in the formatted string so
/// a stray `{:?}` log or panic cannot dump the public-key bytes alongside
/// neighbouring sensitive context.
#[derive(Clone, PartialEq, Eq)]
pub struct AuthKeypairResult {
    pub code: ClientErrorCode,
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

impl AuthKeypairResult {
    fn ok(auth_public_key: Vec<u8>) -> Self {
        Self {
            code: ClientErrorCode::Ok,
            auth_public_key,
        }
    }

    fn error(code: ClientErrorCode) -> Self {
        Self {
            code,
            auth_public_key: Vec::new(),
        }
    }
}

/// FFI-safe link-key derivation result.
///
/// The 16-byte `link_id` is server-visible by design (it is the lookup
/// token). The 32-byte `wrapping_key` stays client-side; the `Drop` impl
/// proactively zeroes it so dropped results do not leak the wrapping key.
///
/// Intentionally does not derive `Debug` to avoid accidental logging of
/// `wrapping_key`. Callers that need a privacy-safe log line should format
/// only `code` and the length of `link_id`.
#[derive(Clone, PartialEq, Eq)]
pub struct LinkKeysResult {
    pub code: ClientErrorCode,
    pub link_id: Vec<u8>,
    pub wrapping_key: Vec<u8>,
}

impl Drop for LinkKeysResult {
    fn drop(&mut self) {
        self.wrapping_key.zeroize();
    }
}

impl LinkKeysResult {
    fn ok(link_id: Vec<u8>, wrapping_key: Vec<u8>) -> Self {
        Self {
            code: ClientErrorCode::Ok,
            link_id,
            wrapping_key,
        }
    }

    fn error(code: ClientErrorCode) -> Self {
        Self {
            code,
            link_id: Vec::new(),
            wrapping_key: Vec::new(),
        }
    }
}

/// FFI-safe wrapped tier key produced by `wrap_tier_key_for_link`.
///
/// Layout matches the TypeScript reference: `tier` byte, `nonce` 24 bytes,
/// `encrypted_key` ciphertext (32 bytes payload + 16 bytes Poly1305 tag).
#[derive(Clone, PartialEq, Eq)]
pub struct WrappedTierKeyResult {
    pub code: ClientErrorCode,
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

impl WrappedTierKeyResult {
    fn ok(tier: u8, nonce: Vec<u8>, encrypted_key: Vec<u8>) -> Self {
        Self {
            code: ClientErrorCode::Ok,
            tier,
            nonce,
            encrypted_key,
        }
    }

    fn error(code: ClientErrorCode) -> Self {
        Self {
            code,
            tier: 0,
            nonce: Vec::new(),
            encrypted_key: Vec::new(),
        }
    }
}

/// FFI-safe result for creating a link-share handle and its first wrapped tier.
///
/// `link_secret_for_url` is the protocol-mandated URL fragment seed. It is not
/// the derived wrapping key and must only be placed in the share URL fragment.
#[derive(Clone, PartialEq, Eq)]
pub struct CreateLinkShareHandleResult {
    pub code: ClientErrorCode,
    pub handle: LinkShareHandleId,
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

impl CreateLinkShareHandleResult {
    fn ok(
        handle: LinkShareHandleId,
        link_id: Vec<u8>,
        link_secret_for_url: Vec<u8>,
        wrapped: WrappedTierKeyResult,
    ) -> Self {
        Self {
            code: ClientErrorCode::Ok,
            handle,
            link_id,
            link_secret_for_url,
            tier: wrapped.tier,
            nonce: wrapped.nonce,
            encrypted_key: wrapped.encrypted_key,
        }
    }

    fn error(code: ClientErrorCode) -> Self {
        Self {
            code,
            handle: 0,
            link_id: Vec::new(),
            link_secret_for_url: Vec::new(),
            tier: 0,
            nonce: Vec::new(),
            encrypted_key: Vec::new(),
        }
    }
}

/// FFI-safe result for importing a share-link tier key into an opaque handle.
#[derive(Clone, PartialEq, Eq)]
pub struct LinkTierHandleResult {
    pub code: ClientErrorCode,
    pub handle: LinkTierHandleId,
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

impl LinkTierHandleResult {
    fn ok(handle: LinkTierHandleId, link_id: Vec<u8>, tier: u8) -> Self {
        Self {
            code: ClientErrorCode::Ok,
            handle,
            link_id,
            tier,
        }
    }

    fn error(code: ClientErrorCode) -> Self {
        Self {
            code,
            handle: 0,
            link_id: Vec::new(),
            tier: 0,
        }
    }
}

/// FFI-safe sealed bundle result returned by `seal_and_sign_bundle_with_identity_handle`.
#[derive(Clone, PartialEq, Eq)]
pub struct SealedBundleResult {
    pub code: ClientErrorCode,
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

impl SealedBundleResult {
    fn ok(sealed: Vec<u8>, signature: Vec<u8>, sharer_pubkey: Vec<u8>) -> Self {
        Self {
            code: ClientErrorCode::Ok,
            sealed,
            signature,
            sharer_pubkey,
        }
    }

    fn error(code: ClientErrorCode) -> Self {
        Self {
            code,
            sealed: Vec::new(),
            signature: Vec::new(),
            sharer_pubkey: Vec::new(),
        }
    }
}

/// FFI-safe opened-bundle result.
///
/// Carries the recovered epoch seed, manifest signing seed/pubkey, and
/// metadata fields. The `Drop` impl proactively zeroes the secret seed
/// buffers (`epoch_seed`, `sign_secret_seed`) so dropped results do not
/// leak key material; callers that consume the seeds must do so via
/// `std::mem::take` or a destructuring move while the struct is still
/// owned by the caller.
#[derive(Clone, PartialEq, Eq)]
pub struct OpenedBundleResult {
    pub code: ClientErrorCode,
    pub version: u32,
    pub album_id: String,
    pub epoch_id: u32,
    pub recipient_pubkey: Vec<u8>,
    pub epoch_seed: Vec<u8>,
    pub sign_secret_seed: Vec<u8>,
    pub sign_public_key: Vec<u8>,
}

impl Drop for OpenedBundleResult {
    fn drop(&mut self) {
        self.epoch_seed.zeroize();
        self.sign_secret_seed.zeroize();
    }
}

impl OpenedBundleResult {
    fn ok(
        version: u32,
        album_id: String,
        epoch_id: u32,
        recipient_pubkey: Vec<u8>,
        epoch_seed: Vec<u8>,
        sign_secret_seed: Vec<u8>,
        sign_public_key: Vec<u8>,
    ) -> Self {
        Self {
            code: ClientErrorCode::Ok,
            version,
            album_id,
            epoch_id,
            recipient_pubkey,
            epoch_seed,
            sign_secret_seed,
            sign_public_key,
        }
    }

    fn error(code: ClientErrorCode) -> Self {
        Self {
            code,
            version: 0,
            album_id: String::new(),
            epoch_id: 0,
            recipient_pubkey: Vec::new(),
            epoch_seed: Vec::new(),
            sign_secret_seed: Vec::new(),
            sign_public_key: Vec::new(),
        }
    }
}

/// FFI-safe encrypted album content result (24-byte nonce + ciphertext+tag).
#[derive(Clone, PartialEq, Eq)]
pub struct EncryptedContentResult {
    pub code: ClientErrorCode,
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

impl EncryptedContentResult {
    fn ok(nonce: Vec<u8>, ciphertext: Vec<u8>) -> Self {
        Self {
            code: ClientErrorCode::Ok,
            nonce,
            ciphertext,
        }
    }

    fn error(code: ClientErrorCode) -> Self {
        Self {
            code,
            nonce: Vec::new(),
            ciphertext: Vec::new(),
        }
    }
}

/// FFI-safe decrypted album content result.
///
/// Carries client-local plaintext bytes on success and intentionally does
/// not implement `Debug`. The `Drop` impl proactively zeroes the plaintext
/// buffer.
#[derive(Clone, PartialEq, Eq)]
pub struct DecryptedContentResult {
    pub code: ClientErrorCode,
    pub plaintext: Vec<u8>,
}

impl Drop for DecryptedContentResult {
    fn drop(&mut self) {
        self.plaintext.zeroize();
    }
}

impl DecryptedContentResult {
    fn ok(plaintext: Vec<u8>) -> Self {
        Self {
            code: ClientErrorCode::Ok,
            plaintext,
        }
    }

    fn error(code: ClientErrorCode) -> Self {
        Self {
            code,
            plaintext: Vec::new(),
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

struct EpochRecord {
    account_handle: u64,
    epoch_id: u32,
    key_material: EpochKeyMaterial,
    /// Per-epoch manifest signing keypair, populated for handles that are
    /// expected to seal/open key bundles. Freshly minted handles
    /// (`create_epoch_key_handle`) and bundle-imported handles
    /// (`import_epoch_key_handle_from_bundle`) carry a `Some(..)` here. The
    /// legacy `open_epoch_key_handle` path that re-derives material from a
    /// wrapped seed only is left at `None`; bundle-emitting operations on
    /// such a handle return `EpochHandleNotFound` so the caller is forced
    /// onto the bundle-import path.
    sign_keypair: Option<ManifestSigningKeypair>,
    open: bool,
}

impl EpochRecord {
    fn close(&mut self) {
        // Eagerly wipe key material in place so the keys are zeroed even on
        // soft-close paths that keep the record allocated. The Drop chain
        // would also zeroize via each SecretKey's Drop impl, but explicit
        // close keeps the symmetry with `SecretRecord::close` and
        // `IdentityRecord::close`.
        self.key_material.zeroize_keys();
        self.open = false;
    }
}

impl Drop for EpochRecord {
    fn drop(&mut self) {
        self.close();
    }
}

static NEXT_EPOCH_HANDLE: AtomicU64 = AtomicU64::new(1);
static EPOCH_REGISTRY: OnceLock<Mutex<HashMap<u64, EpochRecord>>> = OnceLock::new();

struct LinkShareRecord {
    link_secret_for_url: Zeroizing<Vec<u8>>,
    link_wrap_bytes: Zeroizing<Vec<u8>>,
    open: bool,
}

impl LinkShareRecord {
    fn close(&mut self) {
        self.link_secret_for_url.zeroize();
        self.link_wrap_bytes.zeroize();
        self.open = false;
    }
}

impl Drop for LinkShareRecord {
    fn drop(&mut self) {
        self.close();
    }
}

struct LinkTierRecord {
    album_id: String,
    tier: ShardTier,
    key_bytes: Zeroizing<Vec<u8>>,
    open: bool,
}

impl LinkTierRecord {
    fn close(&mut self) {
        self.key_bytes.zeroize();
        self.open = false;
    }
}

impl Drop for LinkTierRecord {
    fn drop(&mut self) {
        self.close();
    }
}

static NEXT_LINK_SHARE_HANDLE: AtomicU64 = AtomicU64::new(1);
static LINK_SHARE_REGISTRY: OnceLock<Mutex<HashMap<u64, LinkShareRecord>>> = OnceLock::new();
static NEXT_LINK_TIER_HANDLE: AtomicU64 = AtomicU64::new(1);
static LINK_TIER_REGISTRY: OnceLock<Mutex<HashMap<u64, LinkTierRecord>>> = OnceLock::new();

fn secret_registry() -> &'static Mutex<HashMap<u64, SecretRecord>> {
    SECRET_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn identity_registry() -> &'static Mutex<HashMap<u64, IdentityRecord>> {
    IDENTITY_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn epoch_registry() -> &'static Mutex<HashMap<u64, EpochRecord>> {
    EPOCH_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn link_share_registry() -> &'static Mutex<HashMap<u64, LinkShareRecord>> {
    LINK_SHARE_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn link_tier_registry() -> &'static Mutex<HashMap<u64, LinkTierRecord>> {
    LINK_TIER_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
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

    if let Err(error) = close_child_handles_for_account(handle) {
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

/// Creates a brand-new account-key handle in a single Argon2id pass.
///
/// Generates a random 32-byte L2 account key, wraps it under the L1 derived
/// from `password + user_salt + account_salt`, and opens an opaque secret
/// handle pointing at L2. Returns the handle ID and the server-storable
/// wrapped account key. The `password` buffer is zeroized on every path
/// before this function returns.
///
/// Slice 2 collapses what was previously two Argon2id passes (TS
/// `deriveKeys` followed by Rust `unlockAccount`) into one — see the
/// migration plan for details.
#[must_use]
pub fn create_new_account_handle(
    password: &mut [u8],
    user_salt: &[u8],
    account_salt: &[u8],
    kdf_memory_kib: u32,
    kdf_iterations: u32,
    kdf_parallelism: u32,
) -> CreateAccountResult {
    let password_copy = Zeroizing::new(password.to_vec());
    password.zeroize();

    let profile = match KdfProfile::new(kdf_memory_kib, kdf_iterations, kdf_parallelism) {
        Ok(value) => value,
        Err(error) => return CreateAccountResult::error(map_crypto_error(error)),
    };

    let material = match derive_account_key(password_copy, user_salt, account_salt, profile) {
        Ok(value) => value,
        Err(error) => return CreateAccountResult::error(map_crypto_error(error)),
    };

    match open_secret_handle(material.account_key.as_bytes()) {
        Ok(handle) => CreateAccountResult::ok(handle, material.wrapped_account_key),
        Err(error) => CreateAccountResult::error(error.code),
    }
}

/// Wraps `plaintext` with the L2 account key referenced by `handle`.
///
/// Output layout: `nonce(24) || ciphertext_with_tag`. The L2 bytes never
/// leave the Rust registry; this clones the key into a short-lived
/// `SecretKey`, performs the wrap, and zeroizes the clone before returning.
#[must_use]
pub fn wrap_with_account_handle(handle: u64, plaintext: &[u8]) -> BytesResult {
    let account_key = match account_secret_key_from_handle(handle) {
        Ok(value) => value,
        Err(error) => return bytes_error(error),
    };
    match wrap_secret_with_aad(plaintext, &account_key, ACCOUNT_DATA_AAD) {
        Ok(bytes) => BytesResult {
            code: ClientErrorCode::Ok,
            bytes,
        },
        Err(error) => bytes_error_code(map_crypto_error(error)),
    }
}

/// Unwraps `wrapped` with the L2 account key referenced by `handle`.
#[must_use]
pub fn unwrap_with_account_handle(handle: u64, wrapped: &[u8]) -> BytesResult {
    let account_key = match account_secret_key_from_handle(handle) {
        Ok(value) => value,
        Err(error) => return bytes_error(error),
    };
    match unwrap_secret_with_aad(wrapped, &account_key, ACCOUNT_DATA_AAD) {
        Ok(bytes) => BytesResult {
            code: ClientErrorCode::Ok,
            bytes: bytes.to_vec(),
        },
        Err(error) => bytes_error_code(map_crypto_error(error)),
    }
}

/// Builds the canonical LocalAuth challenge transcript byte string the
/// backend verifies.
///
/// Wraps [`build_auth_challenge_transcript`] so the worker can use the
/// Rust-canonical encoding instead of re-implementing it in JavaScript.
/// `timestamp_ms` is `None` to omit the timestamp segment, matching the
/// optional shape the backend accepts.
#[must_use]
pub fn build_auth_challenge_transcript_for_ffi(
    username: &str,
    timestamp_ms: Option<u64>,
    challenge: &[u8],
) -> BytesResult {
    match build_auth_challenge_transcript(username, timestamp_ms, challenge) {
        Ok(bytes) => BytesResult {
            code: ClientErrorCode::Ok,
            bytes,
        },
        Err(error) => bytes_error_code(map_crypto_error(error)),
    }
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

/// Creates a new Rust-owned epoch-key handle and returns the wrapped epoch seed.
#[must_use]
pub fn create_epoch_key_handle(account_key_handle: u64, epoch_id: u32) -> EpochKeyHandleResult {
    match create_epoch_key_handle_result(account_key_handle, epoch_id) {
        Ok(value) => value,
        Err(error) => EpochKeyHandleResult::error(error.code),
    }
}

/// Opens a Rust-owned epoch-key handle from a wrapped epoch seed.
#[must_use]
pub fn open_epoch_key_handle(
    wrapped_epoch_seed: &[u8],
    account_key_handle: u64,
    epoch_id: u32,
) -> EpochKeyHandleResult {
    match open_epoch_key_handle_result(wrapped_epoch_seed, account_key_handle, epoch_id) {
        Ok(value) => value,
        Err(error) => EpochKeyHandleResult::error(error.code),
    }
}

/// Returns whether an opaque epoch-key handle is still open.
pub fn epoch_key_handle_is_open(handle: u64) -> Result<bool, ClientError> {
    let registry = epoch_registry();
    let guard = registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "epoch registry lock was poisoned",
        )
    })?;

    Ok(guard.get(&handle).is_some_and(|record| record.open))
}

/// Closes and wipes a Rust-owned opaque epoch-key handle.
pub fn close_epoch_key_handle(handle: u64) -> Result<(), ClientError> {
    let registry = epoch_registry();
    let mut guard = registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "epoch registry lock was poisoned",
        )
    })?;

    match guard.remove(&handle) {
        Some(mut record) if record.open => {
            record.close();
            Ok(())
        }
        _ => Err(ClientError::new(
            ClientErrorCode::EpochHandleNotFound,
            "epoch handle is not open",
        )),
    }
}

/// Encrypts plaintext shard bytes with a Rust-owned epoch-key handle.
#[must_use]
pub fn encrypt_shard_with_epoch_handle(
    handle: u64,
    plaintext: &[u8],
    shard_index: u32,
    tier_byte: u8,
) -> EncryptedShardResult {
    match encrypt_shard_with_epoch_handle_result(handle, plaintext, shard_index, tier_byte) {
        Ok(value) => value,
        Err(error) => EncryptedShardResult::error(error.code),
    }
}

/// Decrypts encrypted shard envelope bytes with a Rust-owned epoch-key handle.
#[must_use]
pub fn decrypt_shard_with_epoch_handle(handle: u64, envelope_bytes: &[u8]) -> DecryptedShardResult {
    match decrypt_shard_with_epoch_handle_result(handle, envelope_bytes) {
        Ok(value) => value,
        Err(error) => DecryptedShardResult::error(error.code),
    }
}

/// Handle-API wrapper for the legacy raw-key fallback. The handle resolves to
/// an opaque epoch state inside the secret registry; the raw seed never
/// crosses the FFI boundary.
///
/// **Telemetry side-effect:** on success, stages a counter increment for
/// `ClientErrorCode::LegacyRawKeyDecryptFallback` (code 224) via a no-op hook.
/// ADR-018's local ring-buffer telemetry port is not wired in this crate yet.
///
/// # Errors
/// Returns `ClientError { code: EpochHandleNotFound }` if the handle is invalid.
/// Returns `ClientError { code: AuthenticationFailed }` if the envelope is not
/// a legacy ciphertext. Tier-key decryption MUST be tried first.
pub fn decrypt_shard_with_legacy_raw_key_handle(
    handle: EpochHandleId,
    envelope_bytes: &[u8],
) -> Result<Vec<u8>, ClientError> {
    let registry = epoch_registry();
    let guard = registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "epoch registry lock was poisoned",
        )
    })?;
    let record = guard
        .get(&handle)
        .filter(|record| record.open)
        .ok_or_else(|| {
            ClientError::new(
                ClientErrorCode::EpochHandleNotFound,
                "epoch handle is not open",
            )
        })?;

    let plaintext =
        decrypt_shard_with_legacy_raw_key(record.key_material.epoch_seed(), envelope_bytes)
            .map_err(client_error_from_crypto)?;
    emit_telemetry_counter(ClientErrorCode::LegacyRawKeyDecryptFallback);
    Ok(plaintext)
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

/// Signs manifest transcript bytes with the per-epoch Ed25519 manifest signing
/// secret key attached to a Rust-owned epoch handle.
///
/// Slice 4 — the per-epoch sign-secret never crosses Comlink. The registry
/// lock is briefly taken to clone the secret seed into a `Zeroizing` buffer,
/// then released before the AEAD-free Ed25519 signing step runs.
///
/// Errors:
/// - `EpochHandleNotFound` if the epoch handle is closed or has no
///   per-epoch sign keypair (e.g. created via the legacy
///   `open_epoch_key_handle` path that did not bootstrap a manifest signing
///   keypair from a bundle).
#[must_use]
pub fn sign_manifest_with_epoch_handle(handle: u64, transcript_bytes: &[u8]) -> BytesResult {
    let payload = match clone_epoch_bundle_payload(handle) {
        Ok(value) => value,
        Err(error) => return bytes_error(error),
    };

    let mut sign_seed = Zeroizing::new(payload.sign_secret_seed.to_vec());
    let secret_key = match ManifestSigningSecretKey::from_seed(sign_seed.as_mut_slice()) {
        Ok(value) => value,
        Err(error) => return bytes_error(client_error_from_crypto(error)),
    };

    let signature = crypto_sign_manifest_transcript(transcript_bytes, &secret_key);
    BytesResult {
        code: ClientErrorCode::Ok,
        bytes: signature.as_bytes().to_vec(),
    }
}

/// Verifies manifest transcript bytes with a per-epoch manifest signing
/// public key.
///
/// Slice 4 — replaces the legacy `verifyManifest` path that called the
/// identity verifier under the hood; the manifest protocol uses the
/// per-epoch `ManifestSigningPublicKey` for signature verification.
#[must_use]
pub fn verify_manifest_with_epoch(
    transcript_bytes: &[u8],
    signature_bytes: &[u8],
    public_key_bytes: &[u8],
) -> ClientErrorCode {
    let signature = match ManifestSignature::from_bytes(signature_bytes) {
        Ok(value) => value,
        Err(error) => return map_crypto_error(error),
    };
    let public_key = match ManifestSigningPublicKey::from_bytes(public_key_bytes) {
        Ok(value) => value,
        Err(error) => return map_crypto_error(error),
    };

    if crypto_verify_manifest_transcript(transcript_bytes, &signature, &public_key) {
        ClientErrorCode::Ok
    } else {
        ClientErrorCode::AuthenticationFailed
    }
}

/// Verifies manifest transcript bytes with a public identity signing key.
///
/// Returns a stable error code so web/Android bindings can reject invalid
/// signatures without exposing cryptographic library internals.
#[must_use]
pub fn verify_manifest_with_identity(
    transcript_bytes: &[u8],
    signature_bytes: &[u8],
    public_key_bytes: &[u8],
) -> ClientErrorCode {
    let signature = match IdentitySignature::from_bytes(signature_bytes) {
        Ok(value) => value,
        Err(error) => return map_crypto_error(error),
    };
    let public_key = match IdentitySigningPublicKey::from_bytes(public_key_bytes) {
        Ok(value) => value,
        Err(error) => return map_crypto_error(error),
    };

    if verify_manifest_identity_signature(transcript_bytes, &signature, &public_key) {
        ClientErrorCode::Ok
    } else {
        ClientErrorCode::AuthenticationFailed
    }
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

/// Derives the password-rooted LocalAuth Ed25519 keypair from an account-key
/// handle and returns the public key only.
///
/// The L2 account key bytes are used as the deterministic 32-byte Ed25519
/// auth signing seed. The auth secret is constructed inside this call,
/// consumed to derive the public key, and dropped (wiped) before returning.
#[must_use]
pub fn derive_auth_keypair_from_account_handle(handle: u64) -> AuthKeypairResult {
    match auth_signing_secret_from_account_handle(handle) {
        Ok(secret) => AuthKeypairResult::ok(secret.public_key().as_bytes().to_vec()),
        Err(error) => AuthKeypairResult::error(error.code),
    }
}

/// Signs a caller-built LocalAuth challenge transcript with the auth keypair
/// derived from the supplied account-key handle.
///
/// Returns a 64-byte detached Ed25519 signature on success.
#[must_use]
pub fn sign_auth_challenge_with_account_handle(
    handle: u64,
    transcript_bytes: &[u8],
) -> BytesResult {
    match auth_signing_secret_from_account_handle(handle) {
        Ok(secret) => BytesResult {
            code: ClientErrorCode::Ok,
            bytes: sign_auth_challenge(transcript_bytes, &secret)
                .as_bytes()
                .to_vec(),
        },
        Err(error) => bytes_error(error),
    }
}

/// Returns the 32-byte Ed25519 auth public key for an account-key handle.
#[must_use]
pub fn get_auth_public_key_from_account_handle(handle: u64) -> BytesResult {
    match auth_signing_secret_from_account_handle(handle) {
        Ok(secret) => BytesResult {
            code: ClientErrorCode::Ok,
            bytes: secret.public_key().as_bytes().to_vec(),
        },
        Err(error) => bytes_error(error),
    }
}

/// Derives the password-rooted LocalAuth Ed25519 keypair from `password` +
/// `user_salt` via Argon2id+HKDF and returns the public key only.
///
/// Used by LocalAuth login/register **before** an account handle is open
/// (the wrapped account key has not yet been fetched from the server).
/// The password buffer is zeroized on every path before this function
/// returns. Callers should still memzero the public key bytes when they
/// are no longer needed (the value is not secret on its own, but
/// hygienic wiping keeps the worker memory profile consistent).
#[must_use]
pub fn derive_auth_keypair_from_password(
    password: &mut [u8],
    user_salt: &[u8],
    kdf_memory_kib: u32,
    kdf_iterations: u32,
    kdf_parallelism: u32,
) -> AuthKeypairResult {
    match derive_auth_signing_keypair_from_password(
        password,
        user_salt,
        kdf_memory_kib,
        kdf_iterations,
        kdf_parallelism,
    ) {
        Ok(keypair) => AuthKeypairResult::ok(keypair.public_key().as_bytes().to_vec()),
        Err(error) => AuthKeypairResult::error(error.code),
    }
}

/// Signs a caller-built LocalAuth challenge transcript with the
/// password-rooted auth keypair.
///
/// This re-runs Argon2id+HKDF on every call. The current LocalAuth flow
/// only signs at most twice per login session (once during register, once
/// during login challenge-response), so the simple re-derive path is
/// chosen over caching to keep the worker state minimal. A later perf
/// pass (Slice 9 cleanup) may swap this for a transient pre-auth handle.
///
/// Returns a 64-byte detached Ed25519 signature on success.
#[must_use]
pub fn sign_auth_challenge_with_password(
    password: &mut [u8],
    user_salt: &[u8],
    kdf_memory_kib: u32,
    kdf_iterations: u32,
    kdf_parallelism: u32,
    transcript_bytes: &[u8],
) -> BytesResult {
    match derive_auth_signing_keypair_from_password(
        password,
        user_salt,
        kdf_memory_kib,
        kdf_iterations,
        kdf_parallelism,
    ) {
        Ok(keypair) => BytesResult {
            code: ClientErrorCode::Ok,
            bytes: sign_auth_challenge(transcript_bytes, keypair.secret_key())
                .as_bytes()
                .to_vec(),
        },
        Err(error) => bytes_error(error),
    }
}

/// Returns the 32-byte Ed25519 LocalAuth public key derived from
/// `password` + `user_salt`.
///
/// Convenience wrapper that exposes only the public key. Re-runs
/// Argon2id+HKDF on every call; callers who also need to sign should
/// prefer `sign_auth_challenge_with_password` to amortise the KDF cost
/// against a sign rather than calling both.
#[must_use]
pub fn get_auth_public_key_from_password(
    password: &mut [u8],
    user_salt: &[u8],
    kdf_memory_kib: u32,
    kdf_iterations: u32,
    kdf_parallelism: u32,
) -> BytesResult {
    match derive_auth_signing_keypair_from_password(
        password,
        user_salt,
        kdf_memory_kib,
        kdf_iterations,
        kdf_parallelism,
    ) {
        Ok(keypair) => BytesResult {
            code: ClientErrorCode::Ok,
            bytes: keypair.public_key().as_bytes().to_vec(),
        },
        Err(error) => bytes_error(error),
    }
}

/// Generates a fresh 32-byte share-link secret using the OS CSPRNG.
#[must_use]
pub fn generate_link_secret() -> BytesResult {
    match crypto_generate_link_secret() {
        Ok(secret) => BytesResult {
            code: ClientErrorCode::Ok,
            bytes: secret.as_slice().to_vec(),
        },
        Err(error) => bytes_error_code(map_crypto_error(error)),
    }
}

/// Derives the `(link_id, wrapping_key)` pair from a 32-byte share-link
/// secret.
///
/// `link_id` is server-visible; `wrapping_key` MUST stay client-side.
#[must_use]
pub fn derive_link_keys(link_secret: &[u8]) -> LinkKeysResult {
    match crypto_derive_link_keys(link_secret) {
        Ok(LinkKeys {
            link_id,
            wrapping_key,
        }) => LinkKeysResult::ok(link_id.to_vec(), wrapping_key.as_bytes().to_vec()),
        Err(error) => LinkKeysResult::error(map_crypto_error(error)),
    }
}

/// Wraps the tier key for a given epoch handle so it can be stored on a
/// share-link record.
///
/// Internally clones the tier key from the registry, wraps it with the
/// caller-supplied 32-byte wrapping key, and returns the canonical
/// `(tier, nonce, encrypted_key)` triple. The cloned tier key is wiped on
/// drop before this function returns.
#[must_use]
pub fn wrap_tier_key_for_link_with_epoch_handle(
    epoch_handle: u64,
    tier_byte: u8,
    wrapping_key_bytes: &[u8],
) -> WrappedTierKeyResult {
    let tier = match ShardTier::try_from(tier_byte) {
        Ok(value) => value,
        Err(error) => return WrappedTierKeyResult::error(map_domain_error(error)),
    };
    let (_, tier_key_bytes) = match clone_tier_key_for_handle(epoch_handle, tier) {
        Ok(value) => value,
        Err(error) => return WrappedTierKeyResult::error(error.code),
    };

    let mut wrapping_buf = Zeroizing::new(wrapping_key_bytes.to_vec());
    let wrapping_key = match SecretKey::from_bytes(wrapping_buf.as_mut_slice()) {
        Ok(value) => value,
        Err(error) => return WrappedTierKeyResult::error(map_crypto_error(error)),
    };

    match crypto_wrap_tier_key_for_link(tier_key_bytes.as_slice(), tier, &wrapping_key) {
        Ok(WrappedTierKey {
            tier,
            nonce,
            encrypted_key,
        }) => WrappedTierKeyResult::ok(tier.to_byte(), nonce.to_vec(), encrypted_key),
        Err(error) => WrappedTierKeyResult::error(map_crypto_error(error)),
    }
}

/// Unwraps a tier key previously produced by `wrap_tier_key_for_link`.
///
/// Returns the 32-byte tier key bytes; callers MUST memzero the buffer
/// after use.
#[must_use]
pub fn unwrap_tier_key_from_link_bytes(
    nonce: &[u8],
    encrypted_key: &[u8],
    tier_byte: u8,
    wrapping_key_bytes: &[u8],
) -> BytesResult {
    let tier = match ShardTier::try_from(tier_byte) {
        Ok(value) => value,
        Err(error) => return bytes_error_code(map_domain_error(error)),
    };
    if nonce.len() != 24 {
        return bytes_error_code(ClientErrorCode::InvalidInputLength);
    }
    let mut nonce_array = [0_u8; 24];
    nonce_array.copy_from_slice(nonce);

    let mut wrapping_buf = Zeroizing::new(wrapping_key_bytes.to_vec());
    let wrapping_key = match SecretKey::from_bytes(wrapping_buf.as_mut_slice()) {
        Ok(value) => value,
        Err(error) => return bytes_error_code(map_crypto_error(error)),
    };

    let wrapped = WrappedTierKey {
        tier,
        nonce: nonce_array,
        encrypted_key: encrypted_key.to_vec(),
    };

    match crypto_unwrap_tier_key_from_link(&wrapped, tier, &wrapping_key) {
        Ok(bytes) => BytesResult {
            code: ClientErrorCode::Ok,
            bytes: bytes.to_vec(),
        },
        Err(error) => bytes_error_code(map_crypto_error(error)),
    }
}

/// Creates a share-link handle and wraps the first tier key without exposing
/// the derived per-link wrapping key across FFI.
///
/// `link_secret_for_url` in the result is the protocol-mandated URL fragment
/// seed. It is intentionally returned so the creator can build the URL; it is
/// not the derived wrapping key used to seal tier keys.
#[must_use]
pub fn create_link_share_handle(
    _album_id: String,
    epoch_handle: u64,
    tier_byte: u8,
) -> CreateLinkShareHandleResult {
    match create_link_share_handle_result(epoch_handle, tier_byte) {
        Ok(result) => result,
        Err(error) => CreateLinkShareHandleResult::error(error.code),
    }
}

/// Imports an existing URL fragment seed into a share-link handle for wrapping
/// additional epoch tier keys without exposing the derived wrapping key.
#[must_use]
pub fn import_link_share_handle(link_secret_for_url: &[u8]) -> LinkTierHandleResult {
    match import_link_share_handle_result(link_secret_for_url) {
        Ok((handle, link_id)) => LinkTierHandleResult::ok(handle, link_id, 0),
        Err(error) => LinkTierHandleResult::error(error.code),
    }
}

/// Wraps a tier key for an existing share-link handle.
#[must_use]
pub fn wrap_link_tier_handle(
    link_share_handle: u64,
    epoch_handle: u64,
    tier_byte: u8,
) -> WrappedTierKeyResult {
    match wrap_link_tier_handle_result(link_share_handle, epoch_handle, tier_byte) {
        Ok(result) => result,
        Err(error) => WrappedTierKeyResult::error(error.code),
    }
}

/// Imports a share-link wrapped tier key into an opaque tier handle.
#[must_use]
pub fn import_link_tier_handle(
    link_secret_for_url: &[u8],
    wrapped_nonce: &[u8],
    encrypted_key: &[u8],
    album_id: String,
    tier_byte: u8,
) -> LinkTierHandleResult {
    match import_link_tier_handle_result(
        link_secret_for_url,
        wrapped_nonce,
        encrypted_key,
        album_id,
        tier_byte,
    ) {
        Ok(result) => result,
        Err(error) => LinkTierHandleResult::error(error.code),
    }
}

/// Decrypts a shard with an imported share-link tier handle.
#[must_use]
pub fn decrypt_shard_with_link_tier_handle(
    link_tier_handle: u64,
    envelope_bytes: &[u8],
) -> DecryptedShardResult {
    match decrypt_shard_with_link_tier_handle_result(link_tier_handle, envelope_bytes) {
        Ok(result) => result,
        Err(error) => DecryptedShardResult::error(error.code),
    }
}

/// Closes and wipes a share-link wrapping handle.
#[must_use]
pub fn close_link_share_handle(handle: u64) -> u16 {
    close_link_share_handle_result(handle).as_u16()
}

/// Closes and wipes an imported share-link tier handle.
#[must_use]
pub fn close_link_tier_handle(handle: u64) -> u16 {
    close_link_tier_handle_result(handle).as_u16()
}

fn create_link_share_handle_result(
    epoch_handle: u64,
    tier_byte: u8,
) -> Result<CreateLinkShareHandleResult, ClientError> {
    let secret = crypto_generate_link_secret().map_err(client_error_from_crypto)?;
    let link_secret_for_url = secret.as_slice().to_vec();
    let LinkKeys {
        link_id,
        wrapping_key,
    } = crypto_derive_link_keys(secret.as_slice()).map_err(client_error_from_crypto)?;
    let handle = insert_link_share_handle(link_secret_for_url.clone(), wrapping_key.as_bytes())?;
    let wrapped = wrap_link_tier_handle_result(handle, epoch_handle, tier_byte)?;
    Ok(CreateLinkShareHandleResult::ok(
        handle,
        link_id.to_vec(),
        link_secret_for_url,
        wrapped,
    ))
}

fn import_link_share_handle_result(
    link_secret_for_url: &[u8],
) -> Result<(LinkShareHandleId, Vec<u8>), ClientError> {
    let LinkKeys {
        link_id,
        wrapping_key,
    } = crypto_derive_link_keys(link_secret_for_url).map_err(client_error_from_crypto)?;
    let handle = insert_link_share_handle(link_secret_for_url.to_vec(), wrapping_key.as_bytes())?;
    Ok((handle, link_id.to_vec()))
}

fn insert_link_share_handle(
    link_secret_for_url: Vec<u8>,
    link_wrap_bytes: &[u8],
) -> Result<LinkShareHandleId, ClientError> {
    let handle = allocate_handle(&NEXT_LINK_SHARE_HANDLE)?;
    let registry = link_share_registry();
    let mut guard = registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "link share registry lock was poisoned",
        )
    })?;
    if guard.contains_key(&handle) {
        return Err(ClientError::new(
            ClientErrorCode::HandleSpaceExhausted,
            "link share handle space is exhausted",
        ));
    }
    guard.insert(
        handle,
        LinkShareRecord {
            link_secret_for_url: Zeroizing::new(link_secret_for_url),
            link_wrap_bytes: Zeroizing::new(link_wrap_bytes.to_vec()),
            open: true,
        },
    );
    Ok(handle)
}

fn clone_link_wrap_bytes_for_handle(handle: u64) -> Result<Zeroizing<Vec<u8>>, ClientError> {
    let registry = link_share_registry();
    let guard = registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "link share registry lock was poisoned",
        )
    })?;
    let record = guard
        .get(&handle)
        .filter(|record| record.open)
        .ok_or_else(|| {
            ClientError::new(
                ClientErrorCode::SecretHandleNotFound,
                "link share handle is not open",
            )
        })?;
    Ok(Zeroizing::new(record.link_wrap_bytes.to_vec()))
}

fn wrap_link_tier_handle_result(
    link_share_handle: u64,
    epoch_handle: u64,
    tier_byte: u8,
) -> Result<WrappedTierKeyResult, ClientError> {
    let mut link_wrap_bytes = clone_link_wrap_bytes_for_handle(link_share_handle)?;
    let result = wrap_tier_key_for_link_with_epoch_handle(
        epoch_handle,
        tier_byte,
        link_wrap_bytes.as_mut_slice(),
    );
    if result.code == ClientErrorCode::Ok {
        Ok(result)
    } else {
        Err(ClientError::new(result.code, "failed to wrap link tier"))
    }
}

fn import_link_tier_handle_result(
    link_secret_for_url: &[u8],
    wrapped_nonce: &[u8],
    encrypted_key: &[u8],
    album_id: String,
    tier_byte: u8,
) -> Result<LinkTierHandleResult, ClientError> {
    let tier = ShardTier::try_from(tier_byte).map_err(client_error_from_domain)?;
    let LinkKeys {
        link_id,
        wrapping_key,
    } = crypto_derive_link_keys(link_secret_for_url).map_err(client_error_from_crypto)?;
    if wrapped_nonce.len() != 24 {
        return Err(ClientError::new(
            ClientErrorCode::InvalidInputLength,
            "link tier nonce must be 24 bytes",
        ));
    }
    let mut nonce = [0_u8; 24];
    nonce.copy_from_slice(wrapped_nonce);
    let wrapped = WrappedTierKey {
        tier,
        nonce,
        encrypted_key: encrypted_key.to_vec(),
    };
    let key_bytes = crypto_unwrap_tier_key_from_link(&wrapped, tier, &wrapping_key)
        .map_err(client_error_from_crypto)?;
    let handle = insert_link_tier_handle(album_id, tier, key_bytes.as_slice())?;
    Ok(LinkTierHandleResult::ok(
        handle,
        link_id.to_vec(),
        tier.to_byte(),
    ))
}

fn insert_link_tier_handle(
    album_id: String,
    tier: ShardTier,
    key_bytes: &[u8],
) -> Result<LinkTierHandleId, ClientError> {
    let handle = allocate_handle(&NEXT_LINK_TIER_HANDLE)?;
    let registry = link_tier_registry();
    let mut guard = registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "link tier registry lock was poisoned",
        )
    })?;
    if guard.contains_key(&handle) {
        return Err(ClientError::new(
            ClientErrorCode::HandleSpaceExhausted,
            "link tier handle space is exhausted",
        ));
    }
    guard.insert(
        handle,
        LinkTierRecord {
            album_id,
            tier,
            key_bytes: Zeroizing::new(key_bytes.to_vec()),
            open: true,
        },
    );
    Ok(handle)
}

fn decrypt_shard_with_link_tier_handle_result(
    link_tier_handle: u64,
    envelope_bytes: &[u8],
) -> Result<DecryptedShardResult, ClientError> {
    let (tier, mut key_bytes) = clone_link_tier_key_for_handle(link_tier_handle)?;
    let header_bytes = if envelope_bytes.len() >= mosaic_domain::SHARD_ENVELOPE_HEADER_LEN {
        &envelope_bytes[..mosaic_domain::SHARD_ENVELOPE_HEADER_LEN]
    } else {
        envelope_bytes
    };
    let header = ShardEnvelopeHeader::parse(header_bytes).map_err(client_error_from_domain)?;
    if header.tier() != tier {
        return Err(ClientError::new(
            ClientErrorCode::LinkTierMismatch,
            "link tier handle does not match envelope tier",
        ));
    }
    let tier_key =
        SecretKey::from_bytes(key_bytes.as_mut_slice()).map_err(client_error_from_crypto)?;
    let plaintext = decrypt_shard(envelope_bytes, &tier_key).map_err(client_error_from_crypto)?;
    Ok(DecryptedShardResult::ok(plaintext.to_vec()))
}

fn clone_link_tier_key_for_handle(
    handle: u64,
) -> Result<(ShardTier, Zeroizing<Vec<u8>>), ClientError> {
    let registry = link_tier_registry();
    let guard = registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "link tier registry lock was poisoned",
        )
    })?;
    let record = guard
        .get(&handle)
        .filter(|record| record.open)
        .ok_or_else(|| {
            ClientError::new(
                ClientErrorCode::SecretHandleNotFound,
                "link tier handle is not open",
            )
        })?;
    let _album_id_len = record.album_id.len();
    Ok((record.tier, Zeroizing::new(record.key_bytes.to_vec())))
}

fn close_link_share_handle_result(handle: u64) -> ClientErrorCode {
    let registry = link_share_registry();
    let Ok(mut guard) = registry.lock() else {
        return ClientErrorCode::InternalStatePoisoned;
    };
    if let Some(record) = guard.get_mut(&handle) {
        record.close();
        guard.remove(&handle);
    }
    ClientErrorCode::Ok
}

fn close_link_tier_handle_result(handle: u64) -> ClientErrorCode {
    let registry = link_tier_registry();
    let Ok(mut guard) = registry.lock() else {
        return ClientErrorCode::InternalStatePoisoned;
    };
    if let Some(record) = guard.get_mut(&handle) {
        record.close();
        guard.remove(&handle);
    }
    ClientErrorCode::Ok
}

/// Seals an `EpochKeyBundle` for `recipient_pubkey` and signs the sealed
/// ciphertext with the identity behind `identity_handle`.
///
/// The bundle is built from the supplied epoch metadata and the caller's
/// per-epoch signing seed/public key. The signing seed is consumed and
/// wiped before this call returns.
#[allow(clippy::too_many_arguments)]
#[must_use]
pub(crate) fn seal_and_sign_bundle_with_identity_handle(
    identity_handle: u64,
    recipient_pubkey: &[u8],
    album_id: String,
    epoch_id: u32,
    epoch_seed_bytes: &[u8],
    sign_secret_seed: &[u8],
    sign_public_key_bytes: &[u8],
) -> SealedBundleResult {
    if recipient_pubkey.len() != 32 {
        return SealedBundleResult::error(ClientErrorCode::InvalidKeyLength);
    }
    let mut recipient_array = [0_u8; 32];
    recipient_array.copy_from_slice(recipient_pubkey);

    let mut epoch_seed_buf = Zeroizing::new(epoch_seed_bytes.to_vec());
    let epoch_seed = match SecretKey::from_bytes(epoch_seed_buf.as_mut_slice()) {
        Ok(value) => value,
        Err(error) => return SealedBundleResult::error(map_crypto_error(error)),
    };

    let mut sign_seed_buf = Zeroizing::new(sign_secret_seed.to_vec());
    let sign_secret_key = match ManifestSigningSecretKey::from_seed(sign_seed_buf.as_mut_slice()) {
        Ok(value) => value,
        Err(error) => return SealedBundleResult::error(map_crypto_error(error)),
    };

    let sign_public_key =
        match mosaic_crypto::ManifestSigningPublicKey::from_bytes(sign_public_key_bytes) {
            Ok(value) => value,
            Err(error) => return SealedBundleResult::error(map_crypto_error(error)),
        };

    let bundle = EpochKeyBundle {
        version: 1,
        album_id,
        epoch_id,
        recipient_pubkey: recipient_array,
        epoch_seed,
        sign_secret_key,
        sign_public_key,
    };

    let outcome = with_identity(identity_handle, |record| {
        crypto_seal_and_sign_bundle(&bundle, &recipient_array, &record.keypair)
    });

    match outcome {
        Ok(Ok(SealedBundle {
            sealed,
            signature,
            sharer_pubkey,
        })) => SealedBundleResult::ok(sealed, signature.to_vec(), sharer_pubkey.to_vec()),
        Ok(Err(error)) => SealedBundleResult::error(map_crypto_error(error)),
        Err(error) => SealedBundleResult::error(error.code),
    }
}

/// Verifies a sealed bundle's signature, opens it for the recipient bound to
/// `identity_handle`, and validates album/epoch fields.
#[allow(clippy::too_many_arguments)]
#[must_use]
pub fn verify_and_open_bundle_with_identity_handle(
    identity_handle: u64,
    sealed: &[u8],
    signature: &[u8],
    sharer_pubkey: &[u8],
    expected_album_id: String,
    expected_min_epoch_id: u32,
    allow_legacy_empty_album_id: bool,
) -> OpenedBundleResult {
    if signature.len() != 64 {
        return OpenedBundleResult::error(ClientErrorCode::InvalidSignatureLength);
    }
    if sharer_pubkey.len() != 32 {
        return OpenedBundleResult::error(ClientErrorCode::InvalidKeyLength);
    }

    let mut signature_array = [0_u8; 64];
    signature_array.copy_from_slice(signature);
    let mut sharer_array = [0_u8; 32];
    sharer_array.copy_from_slice(sharer_pubkey);

    let sealed_bundle = SealedBundle {
        sealed: sealed.to_vec(),
        signature: signature_array,
        sharer_pubkey: sharer_array,
    };

    let context = BundleValidationContext {
        album_id: expected_album_id,
        min_epoch_id: expected_min_epoch_id,
        allow_legacy_empty_album_id,
        expected_owner_ed25519_pub: sharer_array,
    };

    let outcome = with_identity(identity_handle, |record| {
        crypto_verify_and_open_bundle(&sealed_bundle, &record.keypair, &context)
    });

    match outcome {
        Ok(Ok(EpochKeyBundle {
            version,
            album_id,
            epoch_id,
            recipient_pubkey,
            epoch_seed,
            sign_secret_key,
            sign_public_key,
        })) => OpenedBundleResult::ok(
            version,
            album_id,
            epoch_id,
            recipient_pubkey.to_vec(),
            epoch_seed.as_bytes().to_vec(),
            sign_secret_key.expose_seed_bytes().to_vec(),
            sign_public_key.as_bytes().to_vec(),
        ),
        Ok(Err(error)) => OpenedBundleResult::error(map_crypto_error(error)),
        Err(error) => OpenedBundleResult::error(error.code),
    }
}

/// Verifies a sealed bundle's signature, opens it for the recipient bound to
/// `identity_handle`, and imports the recovered epoch/signing secrets directly
/// into the Rust epoch-handle registry. No raw bundle payload secrets cross FFI.
#[allow(clippy::too_many_arguments)]
#[must_use]
pub fn verify_and_import_epoch_bundle_with_identity_handle(
    identity_handle: u64,
    sealed: &[u8],
    signature: &[u8],
    sharer_pubkey: &[u8],
    expected_album_id: String,
    expected_min_epoch_id: u32,
    allow_legacy_empty_album_id: bool,
) -> EpochKeyHandleResult {
    if signature.len() != 64 {
        return EpochKeyHandleResult::error(ClientErrorCode::InvalidSignatureLength);
    }
    if sharer_pubkey.len() != 32 {
        return EpochKeyHandleResult::error(ClientErrorCode::InvalidKeyLength);
    }

    let mut signature_array = [0_u8; 64];
    signature_array.copy_from_slice(signature);
    let mut sharer_array = [0_u8; 32];
    sharer_array.copy_from_slice(sharer_pubkey);

    let sealed_bundle = SealedBundle {
        sealed: sealed.to_vec(),
        signature: signature_array,
        sharer_pubkey: sharer_array,
    };
    let context = BundleValidationContext {
        album_id: expected_album_id,
        min_epoch_id: expected_min_epoch_id,
        allow_legacy_empty_album_id,
        expected_owner_ed25519_pub: sharer_array,
    };

    let outcome = with_identity(identity_handle, |record| {
        crypto_verify_and_open_bundle(&sealed_bundle, &record.keypair, &context)
            .map(|bundle| (record.account_handle, bundle))
    });

    match outcome {
        Ok(Ok((
            account_handle,
            EpochKeyBundle {
                epoch_id,
                epoch_seed,
                sign_secret_key,
                sign_public_key,
                ..
            },
        ))) => import_epoch_key_handle_from_bundle(
            account_handle,
            epoch_id,
            epoch_seed.as_bytes(),
            sign_secret_key.expose_seed_bytes(),
            sign_public_key.as_bytes(),
        ),
        Ok(Err(error)) => EpochKeyHandleResult::error(map_crypto_error(error)),
        Err(error) => EpochKeyHandleResult::error(error.code),
    }
}

/// Atomically seals an epoch key bundle for a recipient using a Rust-owned
/// epoch handle. Bundle payload bytes (epoch seed + per-epoch sign keypair)
/// never cross the FFI boundary — the caller only supplies the recipient's
/// public key and the album id.
///
/// Errors:
/// - `InvalidKeyLength` if `recipient_pubkey` is not exactly 32 bytes.
/// - `IdentityHandleNotFound` if the identity handle is closed.
/// - `EpochHandleNotFound` if the epoch handle is closed or was created via
///   the legacy `open_epoch_key_handle` path (no sign keypair attached).
#[must_use]
pub fn seal_bundle_with_epoch_handle(
    identity_handle: u64,
    epoch_handle: u64,
    recipient_pubkey: &[u8],
    album_id: String,
) -> SealedBundleResult {
    if recipient_pubkey.len() != 32 {
        return SealedBundleResult::error(ClientErrorCode::InvalidKeyLength);
    }

    let payload = match clone_epoch_bundle_payload(epoch_handle) {
        Ok(value) => value,
        Err(error) => return SealedBundleResult::error(error.code),
    };

    seal_and_sign_bundle_with_identity_handle(
        identity_handle,
        recipient_pubkey,
        album_id,
        payload.epoch_id,
        payload.epoch_seed.as_slice(),
        payload.sign_secret_seed.as_slice(),
        payload.sign_public_bytes.as_slice(),
    )
}

/// Cloned bundle payload bytes used by the seal path. All secret material is
/// stored in `Zeroizing` and wiped on drop.
struct EpochBundlePayloadClone {
    epoch_id: u32,
    epoch_seed: Zeroizing<Vec<u8>>,
    sign_secret_seed: Zeroizing<Vec<u8>>,
    sign_public_bytes: Vec<u8>,
}

/// Briefly takes the epoch registry lock to copy the underlying epoch seed
/// and per-epoch manifest signing keypair seed into `Zeroizing` buffers. The
/// returned struct auto-wipes secret payload on drop.
fn clone_epoch_bundle_payload(handle: u64) -> Result<EpochBundlePayloadClone, ClientError> {
    let registry = epoch_registry();
    let guard = registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "epoch registry lock was poisoned",
        )
    })?;
    let record = guard
        .get(&handle)
        .filter(|record| record.open)
        .ok_or_else(|| {
            ClientError::new(
                ClientErrorCode::EpochHandleNotFound,
                "epoch handle is not open",
            )
        })?;

    let sign_keypair = record.sign_keypair.as_ref().ok_or_else(|| {
        ClientError::new(
            ClientErrorCode::EpochHandleNotFound,
            "epoch handle has no manifest signing keypair attached (not bundle-derived)",
        )
    })?;

    let seed = record.key_material.epoch_seed();
    let mut seed_bytes = Zeroizing::new(vec![0_u8; seed.as_bytes().len()]);
    seed_bytes.copy_from_slice(seed.as_bytes());

    let sign_seed = sign_keypair.secret_key().expose_seed_bytes();
    let mut sign_seed_bytes = Zeroizing::new(vec![0_u8; sign_seed.len()]);
    sign_seed_bytes.copy_from_slice(sign_seed);

    let sign_public_bytes = sign_keypair.public_key().as_bytes().to_vec();

    Ok(EpochBundlePayloadClone {
        epoch_id: record.epoch_id,
        epoch_seed: seed_bytes,
        sign_secret_seed: sign_seed_bytes,
        sign_public_bytes,
    })
}

/// Encrypts album content with the content key derived from an epoch handle.
///
/// Output: `(nonce, ciphertext+tag)`. Authenticated AAD binds the ciphertext
/// to `epoch_id` so cross-epoch replay is rejected on decrypt.
#[must_use]
pub fn encrypt_album_content_with_epoch_handle(
    epoch_handle: u64,
    plaintext: &[u8],
) -> EncryptedContentResult {
    let mut seed_bytes = match clone_epoch_seed_for_handle(epoch_handle) {
        Ok(value) => value,
        Err(error) => return EncryptedContentResult::error(error.code),
    };
    let epoch_id = seed_bytes.0;
    let epoch_seed = match SecretKey::from_bytes(seed_bytes.1.as_mut_slice()) {
        Ok(value) => value,
        Err(error) => return EncryptedContentResult::error(map_crypto_error(error)),
    };
    let content_key = match derive_content_key(&epoch_seed) {
        Ok(value) => value,
        Err(error) => return EncryptedContentResult::error(map_crypto_error(error)),
    };

    match encrypt_content(plaintext, &content_key, epoch_id) {
        Ok(EncryptedContent { nonce, ciphertext }) => {
            EncryptedContentResult::ok(nonce.to_vec(), ciphertext)
        }
        Err(error) => EncryptedContentResult::error(map_crypto_error(error)),
    }
}

/// Decrypts album content produced by `encrypt_album_content_with_epoch_handle`.
#[must_use]
pub fn decrypt_album_content_with_epoch_handle(
    epoch_handle: u64,
    nonce: &[u8],
    ciphertext: &[u8],
) -> DecryptedContentResult {
    if nonce.len() != 24 {
        return DecryptedContentResult::error(ClientErrorCode::InvalidInputLength);
    }
    let mut nonce_array = [0_u8; 24];
    nonce_array.copy_from_slice(nonce);

    let mut seed_bytes = match clone_epoch_seed_for_handle(epoch_handle) {
        Ok(value) => value,
        Err(error) => return DecryptedContentResult::error(error.code),
    };
    let epoch_id = seed_bytes.0;
    let epoch_seed = match SecretKey::from_bytes(seed_bytes.1.as_mut_slice()) {
        Ok(value) => value,
        Err(error) => return DecryptedContentResult::error(map_crypto_error(error)),
    };
    let content_key = match derive_content_key(&epoch_seed) {
        Ok(value) => value,
        Err(error) => return DecryptedContentResult::error(map_crypto_error(error)),
    };

    match decrypt_content(ciphertext, &nonce_array, &content_key, epoch_id) {
        Ok(plaintext) => DecryptedContentResult::ok(plaintext.to_vec()),
        Err(error) => DecryptedContentResult::error(map_crypto_error(error)),
    }
}

fn create_identity_handle_result(
    account_key_handle: u64,
) -> Result<IdentityHandleResult, ClientError> {
    let account_key = account_secret_key_from_handle(account_key_handle)?;
    let mut identity_seed = generate_identity_seed().map_err(client_error_from_crypto)?;
    let wrapped_seed =
        wrap_secret_with_aad(identity_seed.as_slice(), &account_key, IDENTITY_SEED_AAD)
            .map_err(client_error_from_crypto)?;
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
        unwrap_secret_with_aad(wrapped_identity_seed, &account_key, IDENTITY_SEED_AAD)
            .map_err(client_error_from_crypto)?;
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

fn create_epoch_key_handle_result(
    account_key_handle: u64,
    epoch_id: u32,
) -> Result<EpochKeyHandleResult, ClientError> {
    let account_key = account_secret_key_from_handle(account_key_handle)?;
    let key_material = generate_epoch_key_material(epoch_id).map_err(client_error_from_crypto)?;
    let wrapped_epoch_seed = wrap_secret_with_aad(
        key_material.epoch_seed().as_bytes(),
        &account_key,
        EPOCH_SEED_AAD,
    )
    .map_err(client_error_from_crypto)?;
    let sign_keypair =
        crypto_generate_manifest_signing_keypair().map_err(client_error_from_crypto)?;

    insert_epoch_key_handle(
        account_key_handle,
        key_material,
        Some(sign_keypair),
        wrapped_epoch_seed,
    )
}

fn open_epoch_key_handle_result(
    wrapped_epoch_seed: &[u8],
    account_key_handle: u64,
    epoch_id: u32,
) -> Result<EpochKeyHandleResult, ClientError> {
    let account_key = account_secret_key_from_handle(account_key_handle)?;
    let mut epoch_seed = unwrap_secret_with_aad(wrapped_epoch_seed, &account_key, EPOCH_SEED_AAD)
        .map_err(client_error_from_crypto)?;
    let key_material = derive_epoch_key_material(epoch_id, epoch_seed.as_mut_slice())
        .map_err(client_error_from_crypto)?;

    // The legacy wrapped-seed path predates the bundle-derived sign keypair
    // contract — the recovered material lacks the per-epoch signing keypair
    // so handles instantiated this way cannot seal new bundles. Bundle ops
    // explicitly check `sign_keypair.is_some()` and surface
    // `EpochHandleNotFound`.
    insert_epoch_key_handle(account_key_handle, key_material, None, Vec::new())
}

/// Imports an epoch handle from the cleartext bundle payload that comes out of
/// `verify_and_open_bundle_with_identity_handle`. The caller-provided seed
/// material is wrapped under the account key for callers that want to persist
/// a re-openable wrapped seed and is otherwise consumed inside Rust — neither
/// the epoch seed nor the manifest signing seed cross the FFI boundary in
/// either direction after this returns.
///
/// Errors:
/// - `InvalidKeyLength` if any of the input buffers has the wrong length.
/// - `InvalidPublicKey` if `sign_public_bytes` does not match the key derived
///   from `sign_secret_seed`.
/// - `SecretHandleNotFound` if the account handle is closed.
#[must_use]
pub(crate) fn import_epoch_key_handle_from_bundle(
    account_key_handle: u64,
    epoch_id: u32,
    epoch_seed_bytes: &[u8],
    sign_secret_seed: &[u8],
    sign_public_bytes: &[u8],
) -> EpochKeyHandleResult {
    match import_epoch_key_handle_from_bundle_result(
        account_key_handle,
        epoch_id,
        epoch_seed_bytes,
        sign_secret_seed,
        sign_public_bytes,
    ) {
        Ok(value) => value,
        Err(error) => EpochKeyHandleResult::error(error.code),
    }
}

fn import_epoch_key_handle_from_bundle_result(
    account_key_handle: u64,
    epoch_id: u32,
    epoch_seed_bytes: &[u8],
    sign_secret_seed: &[u8],
    sign_public_bytes: &[u8],
) -> Result<EpochKeyHandleResult, ClientError> {
    if epoch_seed_bytes.len() != 32 {
        return Err(ClientError::new(
            ClientErrorCode::InvalidKeyLength,
            "epoch_seed must be exactly 32 bytes",
        ));
    }

    // Build the manifest signing secret first so we can reject mismatched
    // public keys before touching the account registry.
    let mut sign_seed_buf = Zeroizing::new(sign_secret_seed.to_vec());
    let sign_secret_key = ManifestSigningSecretKey::from_seed(sign_seed_buf.as_mut_slice())
        .map_err(client_error_from_crypto)?;
    let derived_public = sign_secret_key.public_key();
    let provided_public = ManifestSigningPublicKey::from_bytes(sign_public_bytes)
        .map_err(client_error_from_crypto)?;
    if derived_public.as_bytes() != provided_public.as_bytes() {
        return Err(ClientError::new(
            ClientErrorCode::InvalidPublicKey,
            "sign_public_bytes does not match the public key derived from sign_secret_seed",
        ));
    }
    let sign_keypair = ManifestSigningKeypair::from_parts(sign_secret_key, provided_public);

    let account_key = account_secret_key_from_handle(account_key_handle)?;
    let wrapped_epoch_seed = wrap_secret_with_aad(epoch_seed_bytes, &account_key, EPOCH_SEED_AAD)
        .map_err(client_error_from_crypto)?;

    // `derive_epoch_key_material` zeroizes its input — copy first so we leave
    // the caller-provided slice untouched (the caller is expected to wipe it
    // on their side as well).
    let mut seed_copy = Zeroizing::new(epoch_seed_bytes.to_vec());
    let key_material = derive_epoch_key_material(epoch_id, seed_copy.as_mut_slice())
        .map_err(client_error_from_crypto)?;

    insert_epoch_key_handle(
        account_key_handle,
        key_material,
        Some(sign_keypair),
        wrapped_epoch_seed,
    )
}

fn insert_epoch_key_handle(
    account_handle: u64,
    key_material: EpochKeyMaterial,
    sign_keypair: Option<ManifestSigningKeypair>,
    wrapped_epoch_seed: Vec<u8>,
) -> Result<EpochKeyHandleResult, ClientError> {
    let handle = allocate_handle(&NEXT_EPOCH_HANDLE)?;
    let epoch_id = key_material.epoch_id();
    let sign_public_bytes = sign_keypair
        .as_ref()
        .map(|kp| kp.public_key().as_bytes().to_vec())
        .unwrap_or_default();
    let result = EpochKeyHandleResult::ok(handle, epoch_id, wrapped_epoch_seed, sign_public_bytes);

    let registry = epoch_registry();
    let mut guard = registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "epoch registry lock was poisoned",
        )
    })?;
    if guard.contains_key(&handle) {
        return Err(ClientError::new(
            ClientErrorCode::HandleSpaceExhausted,
            "epoch handle space is exhausted",
        ));
    }
    guard.insert(
        handle,
        EpochRecord {
            account_handle,
            epoch_id,
            key_material,
            sign_keypair,
            open: true,
        },
    );

    Ok(result)
}

fn encrypt_shard_with_epoch_handle_result(
    handle: u64,
    plaintext: &[u8],
    shard_index: u32,
    tier_byte: u8,
) -> Result<EncryptedShardResult, ClientError> {
    let tier = ShardTier::try_from(tier_byte).map_err(client_error_from_domain)?;
    let (epoch_id, key_bytes) = clone_tier_key_for_handle(handle, tier)?;
    let mut key_bytes = key_bytes;
    let tier_key =
        SecretKey::from_bytes(key_bytes.as_mut_slice()).map_err(client_error_from_crypto)?;
    let encrypted = encrypt_shard(plaintext, &tier_key, epoch_id, shard_index, tier)
        .map_err(client_error_from_crypto)?;
    Ok(EncryptedShardResult::ok(encrypted.bytes, encrypted.sha256))
}

fn decrypt_shard_with_epoch_handle_result(
    handle: u64,
    envelope_bytes: &[u8],
) -> Result<DecryptedShardResult, ClientError> {
    // Handle lookup happens before envelope parsing so a missing or closed
    // handle still returns `EpochHandleNotFound` regardless of malformed
    // envelope bytes. The registry mutex is released before the AEAD step.
    let key_clone = clone_epoch_keys_for_handle(handle)?;

    let header_bytes = if envelope_bytes.len() >= mosaic_domain::SHARD_ENVELOPE_HEADER_LEN {
        &envelope_bytes[..mosaic_domain::SHARD_ENVELOPE_HEADER_LEN]
    } else {
        envelope_bytes
    };
    let header = ShardEnvelopeHeader::parse(header_bytes).map_err(client_error_from_domain)?;
    if header.epoch_id() != key_clone.epoch_id {
        return Err(ClientError::new(
            ClientErrorCode::AuthenticationFailed,
            "envelope epoch does not match epoch handle",
        ));
    }

    let mut key_bytes = match header.tier() {
        ShardTier::Thumbnail => key_clone.thumb_key,
        ShardTier::Preview => key_clone.preview_key,
        ShardTier::Original => key_clone.full_key,
    };
    let tier_key =
        SecretKey::from_bytes(key_bytes.as_mut_slice()).map_err(client_error_from_crypto)?;
    let plaintext = decrypt_shard(envelope_bytes, &tier_key).map_err(client_error_from_crypto)?;
    Ok(DecryptedShardResult::ok(plaintext.to_vec()))
}

/// Briefly takes the epoch registry lock to copy the requested tier key bytes
/// into a `Zeroizing<Vec<u8>>` and returns the epoch id, then drops the guard
/// before the caller-visible AEAD work runs. The returned key bytes are wiped
/// on drop, and the caller is expected to reconstruct a fresh `SecretKey` via
/// `SecretKey::from_bytes`.
///
/// Used by encrypt, where the tier is known up-front.
fn clone_tier_key_for_handle(
    handle: u64,
    tier: ShardTier,
) -> Result<(u32, Zeroizing<Vec<u8>>), ClientError> {
    let registry = epoch_registry();
    let guard = registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "epoch registry lock was poisoned",
        )
    })?;
    let record = guard
        .get(&handle)
        .filter(|record| record.open)
        .ok_or_else(|| {
            ClientError::new(
                ClientErrorCode::EpochHandleNotFound,
                "epoch handle is not open",
            )
        })?;

    let tier_key = get_tier_key(&record.key_material, tier);
    let mut bytes = Zeroizing::new(vec![0_u8; tier_key.as_bytes().len()]);
    bytes.copy_from_slice(tier_key.as_bytes());
    Ok((record.epoch_id, bytes))
}

/// Lock-released clone of all shard-tier keys for an epoch handle, used by
/// decrypt where the tier is determined by parsing the envelope after the
/// registry lookup. Wiping happens on drop via `Zeroizing`.
struct EpochKeyClone {
    epoch_id: u32,
    thumb_key: Zeroizing<Vec<u8>>,
    preview_key: Zeroizing<Vec<u8>>,
    full_key: Zeroizing<Vec<u8>>,
}

fn clone_epoch_keys_for_handle(handle: u64) -> Result<EpochKeyClone, ClientError> {
    let registry = epoch_registry();
    let guard = registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "epoch registry lock was poisoned",
        )
    })?;
    let record = guard
        .get(&handle)
        .filter(|record| record.open)
        .ok_or_else(|| {
            ClientError::new(
                ClientErrorCode::EpochHandleNotFound,
                "epoch handle is not open",
            )
        })?;

    let thumb = get_tier_key(&record.key_material, ShardTier::Thumbnail);
    let preview = get_tier_key(&record.key_material, ShardTier::Preview);
    let full = get_tier_key(&record.key_material, ShardTier::Original);

    let mut thumb_bytes = Zeroizing::new(vec![0_u8; thumb.as_bytes().len()]);
    thumb_bytes.copy_from_slice(thumb.as_bytes());
    let mut preview_bytes = Zeroizing::new(vec![0_u8; preview.as_bytes().len()]);
    preview_bytes.copy_from_slice(preview.as_bytes());
    let mut full_bytes = Zeroizing::new(vec![0_u8; full.as_bytes().len()]);
    full_bytes.copy_from_slice(full.as_bytes());

    Ok(EpochKeyClone {
        epoch_id: record.epoch_id,
        thumb_key: thumb_bytes,
        preview_key: preview_bytes,
        full_key: full_bytes,
    })
}

/// Briefly takes the epoch registry lock to copy the underlying 32-byte
/// epoch seed bytes, returning the epoch id and a `Zeroizing` clone of the
/// seed for downstream HKDF derivations (content key, link wrapping, etc.).
fn clone_epoch_seed_for_handle(handle: u64) -> Result<(u32, Zeroizing<Vec<u8>>), ClientError> {
    let registry = epoch_registry();
    let guard = registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "epoch registry lock was poisoned",
        )
    })?;
    let record = guard
        .get(&handle)
        .filter(|record| record.open)
        .ok_or_else(|| {
            ClientError::new(
                ClientErrorCode::EpochHandleNotFound,
                "epoch handle is not open",
            )
        })?;

    let seed = record.key_material.epoch_seed();
    let mut bytes = Zeroizing::new(vec![0_u8; seed.as_bytes().len()]);
    bytes.copy_from_slice(seed.as_bytes());
    Ok((record.epoch_id, bytes))
}

/// Local telemetry hook for ADR-021 sunset-tracked client error codes.
///
/// Currently a no-op: ADR-018's local telemetry ring-buffer port is not yet
/// wired into `mosaic-client` (tracked under follow-up ticket R-C3.1). Until
/// the port lands, callsites such as
/// `decrypt_shard_with_legacy_raw_key_handle` invoke this with
/// [`ClientErrorCode::LegacyRawKeyDecryptFallback`] (224) on success, and
/// emission is silently dropped — meaning the sunset metric ADR-021 was
/// designed around does not actually fire yet. The hook exists so that
/// production callers and tests already route through the right surface,
/// and replacing the body is a single-file change once the ADR-018 port
/// is available.
fn emit_telemetry_counter(_code: ClientErrorCode) {
    // TODO(ADR-018, R-C3.1): wire to the local telemetry ring buffer once
    // its port surface lands. See `ClientErrorCode::LegacyRawKeyDecryptFallback`
    // (= 224) for the canonical sunset-tracked code.
}

/// Resolves an account-key handle and constructs the deterministic LocalAuth
/// signing secret rooted in the L2 account key.
///
/// The L2 bytes are used directly as the 32-byte Ed25519 auth signing seed.
/// The returned `AuthSigningSecretKey` zeroizes itself on drop, so callers
/// should drop it as soon as they are done signing or extracting the public
/// key.
fn auth_signing_secret_from_account_handle(
    handle: u64,
) -> Result<AuthSigningSecretKey, ClientError> {
    let account_key = account_secret_key_from_handle(handle)?;
    let mut seed = Zeroizing::new(account_key.as_bytes().to_vec());
    AuthSigningSecretKey::from_seed(seed.as_mut_slice()).map_err(client_error_from_crypto)
}

/// Internal helper: validate the KDF profile, run the password-rooted auth
/// derivation, and zeroize the caller-owned password buffer on every path.
fn derive_auth_signing_keypair_from_password(
    password: &mut [u8],
    user_salt: &[u8],
    kdf_memory_kib: u32,
    kdf_iterations: u32,
    kdf_parallelism: u32,
) -> Result<mosaic_crypto::AuthSigningKeypair, ClientError> {
    let password_copy = Zeroizing::new(password.to_vec());
    password.zeroize();

    let profile = KdfProfile::new(kdf_memory_kib, kdf_iterations, kdf_parallelism)
        .map_err(client_error_from_crypto)?;
    derive_auth_signing_keypair(password_copy, user_salt, profile).map_err(client_error_from_crypto)
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

fn close_child_handles_for_account(account_handle: u64) -> Result<(), ClientError> {
    let identity_registry = identity_registry();
    let mut identity_guard = identity_registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "identity registry lock was poisoned",
        )
    })?;

    let epoch_registry = epoch_registry();
    let mut epoch_guard = epoch_registry.lock().map_err(|_| {
        ClientError::new(
            ClientErrorCode::InternalStatePoisoned,
            "epoch registry lock was poisoned",
        )
    })?;

    identity_guard.retain(|_, record| {
        if record.account_handle == account_handle {
            record.close();
            false
        } else {
            true
        }
    });
    epoch_guard.retain(|_, record| {
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

fn bytes_error_code(code: ClientErrorCode) -> BytesResult {
    BytesResult {
        code,
        bytes: Vec::new(),
    }
}

fn client_error_from_domain(error: MosaicDomainError) -> ClientError {
    ClientError::new(map_domain_error(error), "domain validation failed")
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
        MosaicCryptoError::LinkTierMismatch { .. } => ClientErrorCode::LinkTierMismatch,
        MosaicCryptoError::BundleSignatureInvalid => ClientErrorCode::BundleSignatureInvalid,
        MosaicCryptoError::BundleAlbumIdEmpty => ClientErrorCode::BundleAlbumIdEmpty,
        MosaicCryptoError::BundleAlbumIdMismatch => ClientErrorCode::BundleAlbumIdMismatch,
        MosaicCryptoError::BundleEpochTooOld => ClientErrorCode::BundleEpochTooOld,
        MosaicCryptoError::BundleRecipientMismatch => ClientErrorCode::BundleRecipientMismatch,
        MosaicCryptoError::BundleJsonParse => ClientErrorCode::BundleJsonParse,
        MosaicCryptoError::BundleSealOpenFailed => ClientErrorCode::BundleSealOpenFailed,
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

    #[test]
    fn debug_output_redacts_boundary_byte_payloads() {
        assert_debug_redacts(
            &super::BytesResult {
                code: super::ClientErrorCode::Ok,
                bytes: vec![231, 232, 233],
            },
            &["bytes_len: 3"],
            &["231", "232", "233", "bytes: ["],
        );

        assert_debug_redacts(
            &super::IdentityHandleResult {
                code: super::ClientErrorCode::Ok,
                handle: 7,
                signing_pubkey: vec![201; 32],
                encryption_pubkey: vec![202; 32],
                wrapped_seed: vec![203, 204, 205],
            },
            &[
                "signing_pubkey_len: 32",
                "encryption_pubkey_len: 32",
                "wrapped_seed_len: 3",
            ],
            &["201", "202", "203", "wrapped_seed: ["],
        );

        assert_debug_redacts(
            &super::EpochKeyHandleResult {
                code: super::ClientErrorCode::Ok,
                handle: 11,
                epoch_id: 42,
                wrapped_epoch_seed: vec![211, 212, 213],
                sign_public_key: vec![214; 32],
            },
            &["wrapped_epoch_seed_len: 3"],
            &[
                "211",
                "212",
                "213",
                "wrapped_epoch_seed: [",
                "sign_public_key",
            ],
        );

        assert_debug_redacts(
            &super::EncryptedShardResult {
                code: super::ClientErrorCode::Ok,
                envelope_bytes: vec![221, 222, 223],
                sha256: "digest".to_owned(),
            },
            &["envelope_bytes_len: 3", "sha256: \"digest\""],
            &["221", "222", "223", "envelope_bytes: ["],
        );

        assert_debug_redacts(
            &super::WrappedTierKeyResult {
                code: super::ClientErrorCode::Ok,
                tier: 1,
                nonce: vec![224; 24],
                encrypted_key: vec![225, 226, 227],
            },
            &["nonce_len: 24", "encrypted_key_len: 3"],
            &["224", "225", "226", "encrypted_key: ["],
        );

        assert_debug_redacts(
            &super::SealedBundleResult {
                code: super::ClientErrorCode::Ok,
                sealed: vec![228, 229, 230],
                signature: vec![234, 235],
                sharer_pubkey: vec![236; 32],
            },
            &["sealed_len: 3", "signature_len: 2", "sharer_pubkey_len: 32"],
            &["228", "229", "234", "236", "sealed: ["],
        );

        assert_debug_redacts(
            &super::EncryptedContentResult {
                code: super::ClientErrorCode::Ok,
                nonce: vec![237; 24],
                ciphertext: vec![238, 239, 240],
            },
            &["nonce_len: 24", "ciphertext_len: 3"],
            &["237", "238", "239", "ciphertext: ["],
        );

        // D3 lock-down: SPEC-CrossPlatformHardening "Secret, PII, and Log
        // Redaction Rules" requires wrapped account-key bytes to never
        // surface in `{:?}` output. The byte values 241..=243 below are the
        // sentinels we forbid in the rendered string.
        assert_debug_redacts(
            &super::CreateAccountResult {
                code: super::ClientErrorCode::Ok,
                handle: 17,
                wrapped_account_key: vec![241, 242, 243],
            },
            &["code: Ok", "handle: 17", "wrapped_account_key_len: 3"],
            &["241", "242", "243", "wrapped_account_key: ["],
        );

        // D3 lock-down: even the auth public key (server-visible by
        // design) is rendered length-only in Debug to keep the redaction
        // discipline uniform with `IdentityHandleResult` (M5 fb26573).
        assert_debug_redacts(
            &super::AuthKeypairResult {
                code: super::ClientErrorCode::Ok,
                auth_public_key: vec![244, 245, 246, 247],
            },
            &["code: Ok", "auth_public_key_len: 4"],
            &["244", "245", "246", "247", "auth_public_key: ["],
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
