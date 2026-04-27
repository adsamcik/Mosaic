//! Cryptographic boundary crate for the Mosaic Rust client core.

#![forbid(unsafe_code)]

use argon2::{Algorithm, Argon2, Block, Params, Version};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use ed25519_dalek::{Signature as Ed25519Signature, Signer, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use mosaic_domain::{SHARD_ENVELOPE_HEADER_LEN, ShardEnvelopeHeader, ShardTier};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

/// Maximum allowed plaintext size for shard encryption (100 MiB).
const MAX_SHARD_BYTES: usize = 100 * 1024 * 1024;

/// Minimum valid wrapped key length: 24-byte nonce + 16-byte AEAD tag + 1-byte payload.
const MIN_WRAPPED_KEY_BYTES: usize = 24 + 16 + 1;

/// Backend LocalAuth username length limit.
const MAX_AUTH_USERNAME_BYTES: usize = 256;

/// Minimum Mosaic Argon2id memory cost in KiB (64 MiB).
const MIN_KDF_MEMORY_KIB: u32 = 64 * 1024;

/// Minimum Mosaic Argon2id iteration count.
const MIN_KDF_ITERATIONS: u32 = 3;

/// Maximum Mosaic Argon2id memory cost in KiB (256 MiB).
pub const MAX_KDF_MEMORY_KIB: u32 = 256 * 1024;

/// Maximum Mosaic Argon2id iteration count.
pub const MAX_KDF_ITERATIONS: u32 = 10;

/// Maximum Mosaic Argon2id parallelism/lane count.
pub const MAX_KDF_PARALLELISM: u32 = 4;

/// Fixed output length for Mosaic L0/L1/L2 keys.
const KEY_BYTES: usize = 32;

/// Ed25519 signing seed length.
const SIGNING_SEED_BYTES: usize = 32;

/// Ed25519 public key length.
const SIGNING_PUBLIC_KEY_BYTES: usize = 32;

/// Ed25519 detached signature length.
const SIGNATURE_BYTES: usize = 64;

/// Required length for user and account salts.
const SALT_BYTES: usize = 16;

/// HKDF-SHA256 domain separation label for deriving L1 root keys from L0.
const ROOT_KEY_INFO: &[u8] = b"mosaic:root-key:v1";

/// LocalAuth challenge transcript context. Must match the backend verifier.
pub const AUTH_CHALLENGE_CONTEXT: &[u8] = b"Mosaic_Auth_Challenge_v1";

/// LocalAuth server challenge length.
pub const AUTH_CHALLENGE_BYTES: usize = 32;

/// HKDF-SHA256 domain separation label for password-rooted auth signing seeds.
const AUTH_SIGNING_KEY_INFO: &[u8] = b"mosaic:auth-signing:v1";

/// HKDF-SHA256 domain separation label for thumbnail shard keys.
const THUMB_KEY_INFO: &[u8] = b"mosaic:tier:thumb:v1";

/// HKDF-SHA256 domain separation label for preview shard keys.
const PREVIEW_KEY_INFO: &[u8] = b"mosaic:tier:preview:v1";

/// HKDF-SHA256 domain separation label for original shard keys.
const FULL_KEY_INFO: &[u8] = b"mosaic:tier:full:v1";

/// HKDF-SHA256 domain separation label for album content keys.
const CONTENT_KEY_INFO: &[u8] = b"mosaic:tier:content:v1";

/// Crypto crate errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MosaicCryptoError {
    /// The FFI spike probe operation requires an explicit context label.
    EmptyContext,
    /// A key argument had an unexpected byte length.
    InvalidKeyLength { actual: usize },
    /// Input data exceeded the maximum allowed plaintext size.
    InvalidInputLength { actual: usize },
    /// The envelope bytes do not conform to the expected domain format.
    InvalidEnvelope,
    /// The envelope contains a valid header but no ciphertext bytes.
    MissingCiphertext,
    /// AEAD authentication failed (wrong key, tampered ciphertext, or tampered AAD).
    AuthenticationFailed,
    /// OS random-number generation failed unexpectedly.
    RngFailure,
    /// Wrapped-key bytes are shorter than the minimum required length.
    WrappedKeyTooShort { actual: usize },
    /// KDF profile is below Mosaic's current security minimums.
    KdfProfileTooWeak,
    /// KDF profile exceeds Mosaic's resource-exhaustion guardrails.
    KdfProfileTooCostly,
    /// Salt argument had an unexpected byte length.
    InvalidSaltLength { actual: usize },
    /// Argon2id or HKDF derivation failed.
    KdfFailure,
    /// Signature bytes had an unexpected length.
    InvalidSignatureLength { actual: usize },
    /// Public signing key bytes did not decode as a valid Ed25519 verifying key.
    InvalidPublicKey,
    /// Auth username was empty or otherwise invalid for transcript construction.
    InvalidUsername,
}

/// Opaque 32-byte secret key that zeroizes its contents on drop.
///
/// Intentionally does not implement `Clone`, `Copy`, `Debug`, `Display`, or `Serialize`
/// to prevent accidental leakage.
pub struct SecretKey(Zeroizing<Vec<u8>>);

impl SecretKey {
    /// Constructs a `SecretKey` from mutable raw bytes and zeroizes the source.
    ///
    /// # Errors
    /// Returns `InvalidKeyLength` if `bytes` is not exactly 32 bytes long.
    pub fn from_bytes(bytes: &mut [u8]) -> Result<Self, MosaicCryptoError> {
        if bytes.len() != KEY_BYTES {
            let actual = bytes.len();
            bytes.zeroize();
            return Err(MosaicCryptoError::InvalidKeyLength { actual });
        }

        let mut key_bytes = Zeroizing::new(vec![0_u8; KEY_BYTES]);
        key_bytes.copy_from_slice(bytes);
        bytes.zeroize();
        Ok(Self(key_bytes))
    }

    /// Returns a reference to the underlying key bytes.
    ///
    /// Use only inside controlled cryptographic operations; never log or display the result.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        self.0.as_slice()
    }
}

impl Drop for SecretKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Rust-owned Ed25519 manifest signing secret.
///
/// Stores the 32-byte Ed25519 seed in zeroizing memory. Intentionally does not
/// implement `Clone`, `Copy`, `Debug`, `Display`, or serialization traits.
pub struct ManifestSigningSecretKey(Zeroizing<[u8; SIGNING_SEED_BYTES]>);

impl ManifestSigningSecretKey {
    /// Constructs a manifest signing secret from a 32-byte Ed25519 seed.
    ///
    /// The caller-provided seed is zeroized on success and invalid length.
    ///
    /// # Errors
    /// Returns `InvalidKeyLength` if `seed` is not exactly 32 bytes.
    pub fn from_seed(seed: &mut [u8]) -> Result<Self, MosaicCryptoError> {
        if seed.len() != SIGNING_SEED_BYTES {
            let actual = seed.len();
            seed.zeroize();
            return Err(MosaicCryptoError::InvalidKeyLength { actual });
        }

        let mut seed_bytes = Zeroizing::new([0_u8; SIGNING_SEED_BYTES]);
        seed_bytes.copy_from_slice(seed);
        seed.zeroize();
        Ok(Self(seed_bytes))
    }

    /// Derives the public Ed25519 verifying key for this signing secret.
    #[must_use]
    pub fn public_key(&self) -> ManifestSigningPublicKey {
        let signing_key = SigningKey::from_bytes(&self.0);
        ManifestSigningPublicKey(signing_key.verifying_key().to_bytes())
    }
}

impl Drop for ManifestSigningSecretKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Ed25519 manifest signing public key.
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(transparent)]
pub struct ManifestSigningPublicKey([u8; SIGNING_PUBLIC_KEY_BYTES]);

impl ManifestSigningPublicKey {
    /// Constructs a public key from raw bytes.
    ///
    /// # Errors
    /// Returns `InvalidKeyLength` if `bytes` is not exactly 32 bytes, or
    /// `InvalidPublicKey` if the bytes are not accepted by the Ed25519 verifier.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, MosaicCryptoError> {
        if bytes.len() != SIGNING_PUBLIC_KEY_BYTES {
            return Err(MosaicCryptoError::InvalidKeyLength {
                actual: bytes.len(),
            });
        }

        let mut public_key = [0_u8; SIGNING_PUBLIC_KEY_BYTES];
        public_key.copy_from_slice(bytes);
        let verifying_key = VerifyingKey::from_bytes(&public_key)
            .map_err(|_| MosaicCryptoError::InvalidPublicKey)?;
        if verifying_key.is_weak() {
            return Err(MosaicCryptoError::InvalidPublicKey);
        }
        Ok(Self(public_key))
    }

    /// Returns the raw 32-byte public key.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; SIGNING_PUBLIC_KEY_BYTES] {
        &self.0
    }
}

/// Ed25519 detached manifest signature.
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(transparent)]
pub struct ManifestSignature([u8; SIGNATURE_BYTES]);

impl ManifestSignature {
    /// Constructs a manifest signature from raw bytes.
    ///
    /// # Errors
    /// Returns `InvalidSignatureLength` if `bytes` is not exactly 64 bytes.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, MosaicCryptoError> {
        if bytes.len() != SIGNATURE_BYTES {
            return Err(MosaicCryptoError::InvalidSignatureLength {
                actual: bytes.len(),
            });
        }

        let mut signature = [0_u8; SIGNATURE_BYTES];
        signature.copy_from_slice(bytes);
        Ok(Self(signature))
    }

    /// Returns the raw 64-byte detached signature.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; SIGNATURE_BYTES] {
        &self.0
    }
}

/// Manifest signing keypair.
pub struct ManifestSigningKeypair {
    secret_key: ManifestSigningSecretKey,
    public_key: ManifestSigningPublicKey,
}

impl ManifestSigningKeypair {
    /// Returns the Rust-owned signing secret.
    #[must_use]
    pub const fn secret_key(&self) -> &ManifestSigningSecretKey {
        &self.secret_key
    }

    /// Returns the public verifying key.
    #[must_use]
    pub const fn public_key(&self) -> &ManifestSigningPublicKey {
        &self.public_key
    }
}

/// Rust-owned Ed25519 LocalAuth signing secret.
///
/// Stores the 32-byte Ed25519 seed in zeroizing memory. Intentionally does not
/// implement `Clone`, `Copy`, `Debug`, `Display`, or serialization traits.
pub struct AuthSigningSecretKey(Zeroizing<[u8; SIGNING_SEED_BYTES]>);

impl AuthSigningSecretKey {
    /// Constructs an auth signing secret from a 32-byte Ed25519 seed.
    ///
    /// The caller-provided seed is zeroized on success and invalid length.
    ///
    /// # Errors
    /// Returns `InvalidKeyLength` if `seed` is not exactly 32 bytes.
    pub fn from_seed(seed: &mut [u8]) -> Result<Self, MosaicCryptoError> {
        if seed.len() != SIGNING_SEED_BYTES {
            let actual = seed.len();
            seed.zeroize();
            return Err(MosaicCryptoError::InvalidKeyLength { actual });
        }

        let mut seed_bytes = Zeroizing::new([0_u8; SIGNING_SEED_BYTES]);
        seed_bytes.copy_from_slice(seed);
        seed.zeroize();
        Ok(Self(seed_bytes))
    }

    /// Derives the public Ed25519 verifying key for this auth signing secret.
    #[must_use]
    pub fn public_key(&self) -> AuthSigningPublicKey {
        let signing_key = SigningKey::from_bytes(&self.0);
        AuthSigningPublicKey(signing_key.verifying_key().to_bytes())
    }
}

impl Drop for AuthSigningSecretKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Ed25519 LocalAuth signing public key.
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(transparent)]
pub struct AuthSigningPublicKey([u8; SIGNING_PUBLIC_KEY_BYTES]);

impl AuthSigningPublicKey {
    /// Constructs an auth public key from raw bytes.
    ///
    /// # Errors
    /// Returns `InvalidKeyLength` if `bytes` is not exactly 32 bytes, or
    /// `InvalidPublicKey` if the bytes are not accepted by the Ed25519 verifier.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, MosaicCryptoError> {
        if bytes.len() != SIGNING_PUBLIC_KEY_BYTES {
            return Err(MosaicCryptoError::InvalidKeyLength {
                actual: bytes.len(),
            });
        }

        let mut public_key = [0_u8; SIGNING_PUBLIC_KEY_BYTES];
        public_key.copy_from_slice(bytes);
        let verifying_key = VerifyingKey::from_bytes(&public_key)
            .map_err(|_| MosaicCryptoError::InvalidPublicKey)?;
        if verifying_key.is_weak() {
            return Err(MosaicCryptoError::InvalidPublicKey);
        }
        Ok(Self(public_key))
    }

    /// Returns the raw 32-byte public key.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; SIGNING_PUBLIC_KEY_BYTES] {
        &self.0
    }
}

/// Ed25519 detached LocalAuth signature.
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(transparent)]
pub struct AuthSignature([u8; SIGNATURE_BYTES]);

impl AuthSignature {
    /// Constructs an auth signature from raw bytes.
    ///
    /// # Errors
    /// Returns `InvalidSignatureLength` if `bytes` is not exactly 64 bytes.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, MosaicCryptoError> {
        if bytes.len() != SIGNATURE_BYTES {
            return Err(MosaicCryptoError::InvalidSignatureLength {
                actual: bytes.len(),
            });
        }

        let mut signature = [0_u8; SIGNATURE_BYTES];
        signature.copy_from_slice(bytes);
        Ok(Self(signature))
    }

    /// Returns the raw 64-byte detached signature.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; SIGNATURE_BYTES] {
        &self.0
    }
}

/// LocalAuth signing keypair.
pub struct AuthSigningKeypair {
    secret_key: AuthSigningSecretKey,
    public_key: AuthSigningPublicKey,
}

impl AuthSigningKeypair {
    /// Returns the Rust-owned auth signing secret.
    #[must_use]
    pub const fn secret_key(&self) -> &AuthSigningSecretKey {
        &self.secret_key
    }

    /// Returns the public auth verifying key.
    #[must_use]
    pub const fn public_key(&self) -> &AuthSigningPublicKey {
        &self.public_key
    }
}

/// Rust-owned Ed25519 identity signing secret.
///
/// Stores the 32-byte Ed25519 seed in zeroizing memory. Intentionally does not
/// implement `Clone`, `Copy`, `Debug`, `Display`, or serialization traits.
pub struct IdentitySigningSecretKey(Zeroizing<[u8; SIGNING_SEED_BYTES]>);

impl IdentitySigningSecretKey {
    /// Constructs an identity signing secret from a 32-byte Ed25519 seed.
    ///
    /// The caller-provided seed is zeroized on success and invalid length.
    ///
    /// # Errors
    /// Returns `InvalidKeyLength` if `seed` is not exactly 32 bytes.
    pub fn from_seed(seed: &mut [u8]) -> Result<Self, MosaicCryptoError> {
        if seed.len() != SIGNING_SEED_BYTES {
            let actual = seed.len();
            seed.zeroize();
            return Err(MosaicCryptoError::InvalidKeyLength { actual });
        }

        let mut seed_bytes = Zeroizing::new([0_u8; SIGNING_SEED_BYTES]);
        seed_bytes.copy_from_slice(seed);
        seed.zeroize();
        Ok(Self(seed_bytes))
    }

    /// Derives the public Ed25519 identity verifying key.
    #[must_use]
    pub fn public_key(&self) -> IdentitySigningPublicKey {
        let signing_key = SigningKey::from_bytes(&self.0);
        IdentitySigningPublicKey(signing_key.verifying_key().to_bytes())
    }

    /// Derives the X25519 recipient public key from the Ed25519 identity key.
    #[must_use]
    pub fn encryption_public_key(&self) -> IdentityEncryptionPublicKey {
        let signing_key = SigningKey::from_bytes(&self.0);
        IdentityEncryptionPublicKey(*signing_key.verifying_key().to_montgomery().as_bytes())
    }

    /// Wipes the Rust-owned signing seed in place.
    pub fn zeroize_secret(&mut self) {
        self.0.zeroize();
    }
}

impl Drop for IdentitySigningSecretKey {
    fn drop(&mut self) {
        self.zeroize_secret();
    }
}

/// Ed25519 identity signing public key.
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(transparent)]
pub struct IdentitySigningPublicKey([u8; SIGNING_PUBLIC_KEY_BYTES]);

impl IdentitySigningPublicKey {
    /// Constructs an identity public key from raw Ed25519 bytes.
    ///
    /// # Errors
    /// Returns `InvalidKeyLength` if `bytes` is not exactly 32 bytes, or
    /// `InvalidPublicKey` if the bytes are not accepted by the Ed25519 verifier.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, MosaicCryptoError> {
        if bytes.len() != SIGNING_PUBLIC_KEY_BYTES {
            return Err(MosaicCryptoError::InvalidKeyLength {
                actual: bytes.len(),
            });
        }

        let mut public_key = [0_u8; SIGNING_PUBLIC_KEY_BYTES];
        public_key.copy_from_slice(bytes);
        let verifying_key = VerifyingKey::from_bytes(&public_key)
            .map_err(|_| MosaicCryptoError::InvalidPublicKey)?;
        if verifying_key.is_weak() {
            return Err(MosaicCryptoError::InvalidPublicKey);
        }
        Ok(Self(public_key))
    }

    /// Returns the raw 32-byte Ed25519 public key.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; SIGNING_PUBLIC_KEY_BYTES] {
        &self.0
    }

    /// Converts this Ed25519 identity public key to its X25519 recipient public key.
    ///
    /// # Errors
    /// Returns `InvalidPublicKey` if the key unexpectedly fails Ed25519 decoding.
    pub fn encryption_public_key(self) -> Result<IdentityEncryptionPublicKey, MosaicCryptoError> {
        let verifying_key =
            VerifyingKey::from_bytes(&self.0).map_err(|_| MosaicCryptoError::InvalidPublicKey)?;
        Ok(IdentityEncryptionPublicKey(
            *verifying_key.to_montgomery().as_bytes(),
        ))
    }
}

/// X25519 recipient public key derived from an Ed25519 identity key.
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(transparent)]
pub struct IdentityEncryptionPublicKey([u8; SIGNING_PUBLIC_KEY_BYTES]);

impl IdentityEncryptionPublicKey {
    /// Returns the raw 32-byte X25519 public key.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; SIGNING_PUBLIC_KEY_BYTES] {
        &self.0
    }
}

/// Ed25519 detached identity signature.
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(transparent)]
pub struct IdentitySignature([u8; SIGNATURE_BYTES]);

impl IdentitySignature {
    /// Constructs an identity signature from raw bytes.
    ///
    /// # Errors
    /// Returns `InvalidSignatureLength` if `bytes` is not exactly 64 bytes.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, MosaicCryptoError> {
        if bytes.len() != SIGNATURE_BYTES {
            return Err(MosaicCryptoError::InvalidSignatureLength {
                actual: bytes.len(),
            });
        }

        let mut signature = [0_u8; SIGNATURE_BYTES];
        signature.copy_from_slice(bytes);
        Ok(Self(signature))
    }

    /// Returns the raw 64-byte detached signature.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; SIGNATURE_BYTES] {
        &self.0
    }
}

/// Identity key material derived from a 32-byte account identity seed.
pub struct IdentityKeypair {
    secret_key: IdentitySigningSecretKey,
    signing_public_key: IdentitySigningPublicKey,
    encryption_public_key: IdentityEncryptionPublicKey,
}

impl IdentityKeypair {
    /// Returns the Rust-owned identity signing secret.
    #[must_use]
    pub const fn secret_key(&self) -> &IdentitySigningSecretKey {
        &self.secret_key
    }

    /// Returns the Ed25519 identity signing public key.
    #[must_use]
    pub const fn signing_public_key(&self) -> &IdentitySigningPublicKey {
        &self.signing_public_key
    }

    /// Returns the X25519 recipient public key.
    #[must_use]
    pub const fn encryption_public_key(&self) -> &IdentityEncryptionPublicKey {
        &self.encryption_public_key
    }

    /// Wipes the Rust-owned signing seed in place.
    pub fn zeroize_secret(&mut self) {
        self.secret_key.zeroize_secret();
    }
}

/// Output of a successful shard encryption.
pub struct EncryptedShard {
    /// Serialized envelope: 64-byte header || ciphertext || 16-byte AEAD tag.
    pub bytes: Vec<u8>,
    /// Base64url no-padding SHA-256 digest of `bytes`.
    pub sha256: String,
}

/// Mosaic Argon2id profile for deriving password-rooted key material.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfProfile {
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
}

impl KdfProfile {
    /// Creates a KDF profile if it satisfies Mosaic's security and resource policy.
    ///
    /// `memory_kib` is in KiB/Argon2 memory blocks. The current minimum is
    /// 64 MiB, 3 iterations, and at least 1 lane. Upper bounds prevent hostile
    /// FFI callers from requesting unbounded Argon2 memory or CPU work.
    pub const fn new(
        memory_kib: u32,
        iterations: u32,
        parallelism: u32,
    ) -> Result<Self, MosaicCryptoError> {
        if memory_kib < MIN_KDF_MEMORY_KIB || iterations < MIN_KDF_ITERATIONS || parallelism < 1 {
            return Err(MosaicCryptoError::KdfProfileTooWeak);
        }

        if memory_kib > MAX_KDF_MEMORY_KIB
            || iterations > MAX_KDF_ITERATIONS
            || parallelism > MAX_KDF_PARALLELISM
        {
            return Err(MosaicCryptoError::KdfProfileTooCostly);
        }

        Ok(Self {
            memory_kib,
            iterations,
            parallelism,
        })
    }

    /// Returns the memory cost in KiB.
    #[must_use]
    pub const fn memory_kib(self) -> u32 {
        self.memory_kib
    }

    /// Returns the Argon2id iteration count.
    #[must_use]
    pub const fn iterations(self) -> u32 {
        self.iterations
    }

    /// Returns the Argon2id parallelism/lane count.
    #[must_use]
    pub const fn parallelism(self) -> u32 {
        self.parallelism
    }

    /// Returns Mosaic's fixed KDF output length.
    #[must_use]
    pub const fn output_len(self) -> usize {
        KEY_BYTES
    }
}

/// Safe account-key derivation result.
///
/// L0 and L1 are zeroized before return. Only the random L2 account key and
/// L2 wrapped by L1 are returned.
pub struct AccountKeyMaterial {
    pub account_key: SecretKey,
    pub wrapped_account_key: Vec<u8>,
}

/// Per-epoch key material derived from a random 32-byte epoch seed.
///
/// All secrets are Rust-owned and zeroizing. This type intentionally does not
/// expose mutable key references or implement serialization traits.
pub struct EpochKeyMaterial {
    epoch_id: u32,
    epoch_seed: SecretKey,
    thumb_key: SecretKey,
    preview_key: SecretKey,
    full_key: SecretKey,
    content_key: SecretKey,
}

impl EpochKeyMaterial {
    /// Returns the epoch identifier.
    #[must_use]
    pub const fn epoch_id(&self) -> u32 {
        self.epoch_id
    }

    /// Returns the random epoch seed used to derive this material.
    #[must_use]
    pub const fn epoch_seed(&self) -> &SecretKey {
        &self.epoch_seed
    }

    /// Returns the thumbnail shard encryption key.
    #[must_use]
    pub const fn thumb_key(&self) -> &SecretKey {
        &self.thumb_key
    }

    /// Returns the preview shard encryption key.
    #[must_use]
    pub const fn preview_key(&self) -> &SecretKey {
        &self.preview_key
    }

    /// Returns the original/full-resolution shard encryption key.
    #[must_use]
    pub const fn full_key(&self) -> &SecretKey {
        &self.full_key
    }

    /// Returns the album content encryption key.
    #[must_use]
    pub const fn content_key(&self) -> &SecretKey {
        &self.content_key
    }
}

/// Derives the L1 root key from password, user salt, and account salt.
///
/// This is an internal building block for account-key unwrap and test vectors.
/// Callers should prefer [`derive_account_key`] or [`unwrap_account_key`] for
/// production flows so L0/L1 stay short-lived.
///
/// # Errors
/// - `InvalidSaltLength` if either salt is not exactly 16 bytes.
/// - `KdfProfileTooWeak` if the profile is below policy.
/// - `KdfProfileTooCostly` if the profile exceeds resource limits.
/// - `KdfFailure` if Argon2id/HKDF reports an error.
pub fn derive_root_key(
    password: Zeroizing<Vec<u8>>,
    user_salt: &[u8],
    account_salt: &[u8],
    profile: KdfProfile,
) -> Result<SecretKey, MosaicCryptoError> {
    validate_salt(user_salt)?;
    validate_salt(account_salt)?;

    let argon_params = Params::new(
        profile.memory_kib(),
        profile.iterations(),
        profile.parallelism(),
        Some(profile.output_len()),
    )
    .map_err(|_| MosaicCryptoError::KdfFailure)?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params.clone());

    let mut master_key = Zeroizing::new([0_u8; KEY_BYTES]);
    let mut memory_blocks = Zeroizing::new(vec![Block::default(); argon_params.block_count()]);
    argon2
        .hash_password_into_with_memory(
            password.as_slice(),
            user_salt,
            &mut master_key[..],
            memory_blocks.as_mut_slice(),
        )
        .map_err(|_| MosaicCryptoError::KdfFailure)?;

    let mut root_key = Zeroizing::new([0_u8; KEY_BYTES]);
    Hkdf::<Sha256>::new(Some(account_salt), &master_key[..])
        .expand(ROOT_KEY_INFO, &mut root_key[..])
        .map_err(|_| MosaicCryptoError::KdfFailure)?;

    SecretKey::from_bytes(&mut root_key[..])
}

/// Derives a fresh L2 account key and wraps it with the password-derived L1 key.
///
/// # Errors
/// Returns salt, KDF, RNG, or wrapping errors from the underlying operations.
pub fn derive_account_key(
    password: Zeroizing<Vec<u8>>,
    user_salt: &[u8],
    account_salt: &[u8],
    profile: KdfProfile,
) -> Result<AccountKeyMaterial, MosaicCryptoError> {
    let root_key = derive_root_key(password, user_salt, account_salt, profile)?;

    let mut account_key_bytes = Zeroizing::new(vec![0_u8; KEY_BYTES]);
    getrandom::fill(account_key_bytes.as_mut_slice()).map_err(|_| MosaicCryptoError::RngFailure)?;
    let account_key = SecretKey::from_bytes(account_key_bytes.as_mut_slice())?;
    let wrapped_account_key = wrap_key(account_key.as_bytes(), &root_key)?;

    Ok(AccountKeyMaterial {
        account_key,
        wrapped_account_key,
    })
}

/// Unwraps a previously created L2 account key using password-derived L1.
///
/// # Errors
/// Returns salt, KDF, or authentication errors from the underlying operations.
pub fn unwrap_account_key(
    password: Zeroizing<Vec<u8>>,
    user_salt: &[u8],
    account_salt: &[u8],
    wrapped_account_key: &[u8],
    profile: KdfProfile,
) -> Result<SecretKey, MosaicCryptoError> {
    let root_key = derive_root_key(password, user_salt, account_salt, profile)?;
    let mut account_key_bytes = unwrap_key(wrapped_account_key, &root_key)?;

    if account_key_bytes.len() != KEY_BYTES {
        return Err(MosaicCryptoError::InvalidKeyLength {
            actual: account_key_bytes.len(),
        });
    }

    SecretKey::from_bytes(account_key_bytes.as_mut_slice())
}

/// Derives the password-rooted LocalAuth signing keypair.
///
/// This is separate from the L1/L2 account-key hierarchy: it exists only to
/// authenticate account unlock before the server returns wrapped account state.
///
/// # Errors
/// - `InvalidSaltLength` if `user_salt` is not exactly 16 bytes.
/// - `KdfProfileTooWeak` if the profile is below policy.
/// - `KdfProfileTooCostly` if the profile exceeds resource limits.
/// - `KdfFailure` if Argon2id/HKDF reports an error.
pub fn derive_auth_signing_keypair(
    password: Zeroizing<Vec<u8>>,
    user_salt: &[u8],
    profile: KdfProfile,
) -> Result<AuthSigningKeypair, MosaicCryptoError> {
    validate_salt(user_salt)?;

    let argon_params = Params::new(
        profile.memory_kib(),
        profile.iterations(),
        profile.parallelism(),
        Some(profile.output_len()),
    )
    .map_err(|_| MosaicCryptoError::KdfFailure)?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params.clone());

    let mut master_key = Zeroizing::new([0_u8; KEY_BYTES]);
    let mut memory_blocks = Zeroizing::new(vec![Block::default(); argon_params.block_count()]);
    argon2
        .hash_password_into_with_memory(
            password.as_slice(),
            user_salt,
            &mut master_key[..],
            memory_blocks.as_mut_slice(),
        )
        .map_err(|_| MosaicCryptoError::KdfFailure)?;

    let mut auth_seed = Zeroizing::new([0_u8; SIGNING_SEED_BYTES]);
    Hkdf::<Sha256>::new(Some(user_salt), &master_key[..])
        .expand(AUTH_SIGNING_KEY_INFO, &mut auth_seed[..])
        .map_err(|_| MosaicCryptoError::KdfFailure)?;

    let secret_key = AuthSigningSecretKey::from_seed(&mut auth_seed[..])?;
    let public_key = secret_key.public_key();

    Ok(AuthSigningKeypair {
        secret_key,
        public_key,
    })
}

/// Builds the canonical LocalAuth challenge transcript verified by the backend.
///
/// Transcript format:
/// `Mosaic_Auth_Challenge_v1 || username_len_be_u32 || username_utf8 ||
/// timestamp_be_u64? || challenge_32`.
///
/// # Errors
/// Returns `InvalidUsername` for empty or whitespace-only usernames, or
/// `InvalidInputLength` if the challenge is not exactly 32 bytes.
pub fn build_auth_challenge_transcript(
    username: &str,
    timestamp_ms: Option<u64>,
    challenge: &[u8],
) -> Result<Vec<u8>, MosaicCryptoError> {
    let username_bytes = validate_auth_username(username)?;
    if challenge.len() != AUTH_CHALLENGE_BYTES {
        return Err(MosaicCryptoError::InvalidInputLength {
            actual: challenge.len(),
        });
    }

    let username_len =
        u32::try_from(username_bytes.len()).map_err(|_| MosaicCryptoError::InvalidInputLength {
            actual: username_bytes.len(),
        })?;

    let timestamp_len = if timestamp_ms.is_some() { 8 } else { 0 };
    let capacity = AUTH_CHALLENGE_CONTEXT.len() + 4 + username_bytes.len() + timestamp_len + 32;
    let mut transcript = Vec::with_capacity(capacity);
    transcript.extend_from_slice(AUTH_CHALLENGE_CONTEXT);
    transcript.extend_from_slice(&username_len.to_be_bytes());
    transcript.extend_from_slice(username_bytes);
    if let Some(value) = timestamp_ms {
        transcript.extend_from_slice(&value.to_be_bytes());
    }
    transcript.extend_from_slice(challenge);
    Ok(transcript)
}

fn validate_auth_username(username: &str) -> Result<&[u8], MosaicCryptoError> {
    let bytes = username.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_AUTH_USERNAME_BYTES {
        return Err(MosaicCryptoError::InvalidUsername);
    }

    if bytes
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'_' | b'-' | b'@' | b'.'))
    {
        Ok(bytes)
    } else {
        Err(MosaicCryptoError::InvalidUsername)
    }
}

/// Signs canonical LocalAuth challenge transcript bytes.
#[must_use]
pub fn sign_auth_challenge(
    transcript_bytes: &[u8],
    secret_key: &AuthSigningSecretKey,
) -> AuthSignature {
    let signing_key = SigningKey::from_bytes(&secret_key.0);
    let signature: Ed25519Signature = signing_key.sign(transcript_bytes);
    AuthSignature(signature.to_bytes())
}

/// Verifies a canonical LocalAuth challenge transcript signature.
///
/// Returns `false` for wrong keys, tampered transcripts, or tampered signatures.
#[must_use]
pub fn verify_auth_challenge(
    transcript_bytes: &[u8],
    signature: &AuthSignature,
    public_key: &AuthSigningPublicKey,
) -> bool {
    let verifying_key = match VerifyingKey::from_bytes(public_key.as_bytes()) {
        Ok(value) => value,
        Err(_) => return false,
    };
    let signature = Ed25519Signature::from_bytes(signature.as_bytes());

    verifying_key
        .verify_strict(transcript_bytes, &signature)
        .is_ok()
}

/// Generates fresh per-epoch key material for a new album epoch.
///
/// # Errors
/// Returns `RngFailure` if the OS CSPRNG is unavailable.
pub fn generate_epoch_key_material(epoch_id: u32) -> Result<EpochKeyMaterial, MosaicCryptoError> {
    let mut epoch_seed = Zeroizing::new(vec![0_u8; KEY_BYTES]);
    getrandom::fill(epoch_seed.as_mut_slice()).map_err(|_| MosaicCryptoError::RngFailure)?;
    derive_epoch_key_material(epoch_id, epoch_seed.as_mut_slice())
}

/// Generates a fresh manifest signing keypair with the OS CSPRNG.
///
/// # Errors
/// Returns `RngFailure` if the OS CSPRNG is unavailable.
pub fn generate_manifest_signing_keypair() -> Result<ManifestSigningKeypair, MosaicCryptoError> {
    let mut seed = Zeroizing::new([0_u8; SIGNING_SEED_BYTES]);
    getrandom::fill(&mut seed[..]).map_err(|_| MosaicCryptoError::RngFailure)?;
    let secret_key = ManifestSigningSecretKey::from_seed(&mut seed[..])?;
    let public_key = secret_key.public_key();

    Ok(ManifestSigningKeypair {
        secret_key,
        public_key,
    })
}

/// Generates a fresh 32-byte identity seed for account identity creation.
///
/// # Errors
/// Returns `RngFailure` if the OS CSPRNG is unavailable.
pub fn generate_identity_seed() -> Result<Zeroizing<[u8; SIGNING_SEED_BYTES]>, MosaicCryptoError> {
    let mut seed = Zeroizing::new([0_u8; SIGNING_SEED_BYTES]);
    getrandom::fill(&mut seed[..]).map_err(|_| MosaicCryptoError::RngFailure)?;
    Ok(seed)
}

/// Derives identity signing and recipient public key material from a 32-byte seed.
///
/// The caller-provided seed buffer is zeroized on success and invalid length.
///
/// # Errors
/// Returns `InvalidKeyLength` if `seed` is not exactly 32 bytes.
pub fn derive_identity_keypair(seed: &mut [u8]) -> Result<IdentityKeypair, MosaicCryptoError> {
    let secret_key = IdentitySigningSecretKey::from_seed(seed)?;
    let signing_public_key = secret_key.public_key();
    let encryption_public_key = secret_key.encryption_public_key();

    Ok(IdentityKeypair {
        secret_key,
        signing_public_key,
        encryption_public_key,
    })
}

/// Converts an Ed25519 identity public key to its X25519 recipient public key.
///
/// # Errors
/// Returns `InvalidKeyLength` or `InvalidPublicKey` for invalid input bytes.
pub fn identity_encryption_public_key_from_signing_public_key(
    signing_public_key: &[u8],
) -> Result<IdentityEncryptionPublicKey, MosaicCryptoError> {
    IdentitySigningPublicKey::from_bytes(signing_public_key)?.encryption_public_key()
}

/// Signs canonical manifest transcript bytes with the account identity key.
#[must_use]
pub fn sign_manifest_with_identity(
    transcript_bytes: &[u8],
    secret_key: &IdentitySigningSecretKey,
) -> IdentitySignature {
    let signing_key = SigningKey::from_bytes(&secret_key.0);
    let signature: Ed25519Signature = signing_key.sign(transcript_bytes);
    IdentitySignature(signature.to_bytes())
}

/// Verifies a canonical manifest transcript signature made by an identity key.
///
/// Returns `false` for wrong keys, tampered transcripts, or tampered signatures.
#[must_use]
pub fn verify_manifest_identity_signature(
    transcript_bytes: &[u8],
    signature: &IdentitySignature,
    public_key: &IdentitySigningPublicKey,
) -> bool {
    let verifying_key = match VerifyingKey::from_bytes(public_key.as_bytes()) {
        Ok(value) => value,
        Err(_) => return false,
    };
    let signature = Ed25519Signature::from_bytes(signature.as_bytes());

    verifying_key
        .verify_strict(transcript_bytes, &signature)
        .is_ok()
}

/// Deterministic public crypto vectors shared by native Rust and FFI facades.
pub mod golden_vectors {
    use super::{
        MosaicCryptoError, SIGNATURE_BYTES, SIGNING_PUBLIC_KEY_BYTES, derive_identity_keypair,
        sign_manifest_with_identity,
    };

    /// Fixed message for the Ed25519 identity signing vector.
    pub const IDENTITY_MESSAGE: &[u8] = b"";

    // Public RFC 8032 test vector seed. This is not production secret material.
    const IDENTITY_SEED: [u8; 32] = [
        0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c,
        0xc4, 0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae,
        0x7f, 0x60,
    ];

    /// Public outputs for the deterministic identity vector.
    pub struct IdentityPublicVector {
        signing_pubkey: [u8; SIGNING_PUBLIC_KEY_BYTES],
        encryption_pubkey: [u8; SIGNING_PUBLIC_KEY_BYTES],
        signature: [u8; SIGNATURE_BYTES],
    }

    impl IdentityPublicVector {
        /// Returns the Ed25519 identity public key bytes.
        #[must_use]
        pub const fn signing_pubkey(&self) -> &[u8; SIGNING_PUBLIC_KEY_BYTES] {
            &self.signing_pubkey
        }

        /// Returns the X25519 recipient public key bytes.
        #[must_use]
        pub const fn encryption_pubkey(&self) -> &[u8; SIGNING_PUBLIC_KEY_BYTES] {
            &self.encryption_pubkey
        }

        /// Returns the Ed25519 detached signature bytes.
        #[must_use]
        pub const fn signature(&self) -> &[u8; SIGNATURE_BYTES] {
            &self.signature
        }
    }

    /// Returns deterministic identity public bytes and signature.
    ///
    /// The private seed is an RFC 8032 test-only input and is never returned.
    ///
    /// # Errors
    /// Returns identity key derivation errors if the fixed vector seed stops
    /// satisfying the identity key constructor.
    pub fn identity_public_vector() -> Result<IdentityPublicVector, MosaicCryptoError> {
        let mut seed = IDENTITY_SEED;
        let mut keypair = derive_identity_keypair(&mut seed)?;
        let signature = sign_manifest_with_identity(IDENTITY_MESSAGE, keypair.secret_key());
        let signing_pubkey = *keypair.signing_public_key().as_bytes();
        let encryption_pubkey = *keypair.encryption_public_key().as_bytes();
        let signature = *signature.as_bytes();
        keypair.zeroize_secret();

        Ok(IdentityPublicVector {
            signing_pubkey,
            encryption_pubkey,
            signature,
        })
    }
}

/// Signs canonical manifest transcript bytes.
///
/// The transcript bytes must already include the manifest signing context and
/// transcript version from `mosaic-domain`; this function does not prepend an
/// additional context string.
#[must_use]
pub fn sign_manifest_transcript(
    transcript_bytes: &[u8],
    secret_key: &ManifestSigningSecretKey,
) -> ManifestSignature {
    let signing_key = SigningKey::from_bytes(&secret_key.0);
    let signature: Ed25519Signature = signing_key.sign(transcript_bytes);
    ManifestSignature(signature.to_bytes())
}

/// Verifies a canonical manifest transcript signature.
///
/// Returns `false` for wrong keys, tampered transcripts, or tampered signatures.
#[must_use]
pub fn verify_manifest_transcript(
    transcript_bytes: &[u8],
    signature: &ManifestSignature,
    public_key: &ManifestSigningPublicKey,
) -> bool {
    let verifying_key = match VerifyingKey::from_bytes(public_key.as_bytes()) {
        Ok(value) => value,
        Err(_) => return false,
    };
    let signature = Ed25519Signature::from_bytes(signature.as_bytes());

    verifying_key
        .verify_strict(transcript_bytes, &signature)
        .is_ok()
}

/// Derives all current Mosaic tier/content keys from a 32-byte epoch seed.
///
/// Rust v1 uses canonical HKDF-SHA256 with fixed Mosaic labels. The input seed
/// buffer is zeroized before return on both success and invalid length.
///
/// # Errors
/// Returns `InvalidKeyLength` if `epoch_seed` is not exactly 32 bytes long, or
/// `KdfFailure` if HKDF expansion reports an error.
pub fn derive_epoch_key_material(
    epoch_id: u32,
    epoch_seed: &mut [u8],
) -> Result<EpochKeyMaterial, MosaicCryptoError> {
    let seed = epoch_seed;
    if seed.len() != KEY_BYTES {
        let actual = seed.len();
        seed.zeroize();
        return Err(MosaicCryptoError::InvalidKeyLength { actual });
    }

    let thumb_key = derive_labeled_key(seed, THUMB_KEY_INFO)?;
    let preview_key = derive_labeled_key(seed, PREVIEW_KEY_INFO)?;
    let full_key = derive_labeled_key(seed, FULL_KEY_INFO)?;
    let content_key = derive_labeled_key(seed, CONTENT_KEY_INFO)?;
    let epoch_seed = SecretKey::from_bytes(seed)?;

    Ok(EpochKeyMaterial {
        epoch_id,
        epoch_seed,
        thumb_key,
        preview_key,
        full_key,
        content_key,
    })
}

/// Derives the album content key from an epoch seed.
///
/// # Errors
/// Returns `KdfFailure` if HKDF expansion reports an error.
pub fn derive_content_key(epoch_seed: &SecretKey) -> Result<SecretKey, MosaicCryptoError> {
    derive_labeled_key(epoch_seed.as_bytes(), CONTENT_KEY_INFO)
}

/// Returns the key for the requested shard tier.
#[must_use]
pub const fn get_tier_key(epoch_key: &EpochKeyMaterial, tier: ShardTier) -> &SecretKey {
    match tier {
        ShardTier::Thumbnail => epoch_key.thumb_key(),
        ShardTier::Preview => epoch_key.preview_key(),
        ShardTier::Original => epoch_key.full_key(),
    }
}

fn derive_labeled_key(seed: &[u8], info: &[u8]) -> Result<SecretKey, MosaicCryptoError> {
    let mut key_bytes = Zeroizing::new(vec![0_u8; KEY_BYTES]);
    Hkdf::<Sha256>::new(None, seed)
        .expand(info, key_bytes.as_mut_slice())
        .map_err(|_| MosaicCryptoError::KdfFailure)?;
    SecretKey::from_bytes(key_bytes.as_mut_slice())
}

fn validate_salt(salt: &[u8]) -> Result<(), MosaicCryptoError> {
    if salt.len() != SALT_BYTES {
        return Err(MosaicCryptoError::InvalidSaltLength { actual: salt.len() });
    }
    Ok(())
}

/// Encrypts `data` as a shard envelope authenticated with `key`.
///
/// # Errors
/// - `InvalidInputLength` if `data` exceeds 100 MiB.
/// - `RngFailure` if the OS CSPRNG is unavailable.
/// - `AuthenticationFailed` if the AEAD cipher reports an unexpected error.
pub fn encrypt_shard(
    data: &[u8],
    key: &SecretKey,
    epoch_id: u32,
    shard_index: u32,
    tier: ShardTier,
) -> Result<EncryptedShard, MosaicCryptoError> {
    if data.len() > MAX_SHARD_BYTES {
        return Err(MosaicCryptoError::InvalidInputLength { actual: data.len() });
    }

    let mut nonce_bytes = [0u8; 24];
    getrandom::fill(&mut nonce_bytes).map_err(|_| MosaicCryptoError::RngFailure)?;

    let header = ShardEnvelopeHeader::new(epoch_id, shard_index, nonce_bytes, tier);
    let header_bytes = header.to_bytes();

    let cipher = XChaCha20Poly1305::new_from_slice(key.as_bytes()).map_err(|_| {
        MosaicCryptoError::InvalidKeyLength {
            actual: key.as_bytes().len(),
        }
    })?;
    let nonce = XNonce::from_slice(&nonce_bytes);

    let ciphertext_and_tag = cipher
        .encrypt(
            nonce,
            Payload {
                msg: data,
                aad: &header_bytes,
            },
        )
        .map_err(|_| MosaicCryptoError::AuthenticationFailed)?;

    let mut envelope = Vec::with_capacity(SHARD_ENVELOPE_HEADER_LEN + ciphertext_and_tag.len());
    envelope.extend_from_slice(&header_bytes);
    envelope.extend_from_slice(&ciphertext_and_tag);

    let sha256 = sha256_bytes(&envelope);
    Ok(EncryptedShard {
        bytes: envelope,
        sha256,
    })
}

/// Decrypts a shard envelope produced by [`encrypt_shard`].
///
/// # Errors
/// - `InvalidEnvelope` if `envelope` is shorter than 64 bytes or the header is malformed.
/// - `MissingCiphertext` if `envelope` is exactly 64 bytes (header only, no ciphertext).
/// - `AuthenticationFailed` if AEAD verification fails (wrong key or tampered bytes).
pub fn decrypt_shard(
    envelope: &[u8],
    key: &SecretKey,
) -> Result<Zeroizing<Vec<u8>>, MosaicCryptoError> {
    if envelope.len() < SHARD_ENVELOPE_HEADER_LEN {
        return Err(MosaicCryptoError::InvalidEnvelope);
    }

    let header_bytes = &envelope[..SHARD_ENVELOPE_HEADER_LEN];
    let header =
        ShardEnvelopeHeader::parse(header_bytes).map_err(|_| MosaicCryptoError::InvalidEnvelope)?;

    let ciphertext_and_tag = &envelope[SHARD_ENVELOPE_HEADER_LEN..];
    if ciphertext_and_tag.is_empty() {
        return Err(MosaicCryptoError::MissingCiphertext);
    }

    let cipher = XChaCha20Poly1305::new_from_slice(key.as_bytes()).map_err(|_| {
        MosaicCryptoError::InvalidKeyLength {
            actual: key.as_bytes().len(),
        }
    })?;
    let nonce = XNonce::from_slice(header.nonce());

    let plaintext = cipher
        .decrypt(
            nonce,
            Payload {
                msg: ciphertext_and_tag,
                aad: header_bytes,
            },
        )
        .map_err(|_| MosaicCryptoError::AuthenticationFailed)?;

    Ok(Zeroizing::new(plaintext))
}

/// Wraps `key_bytes` with the `wrapper` key using XChaCha20-Poly1305.
///
/// Output format: `nonce(24) || ciphertext || tag(16)`.
///
/// # Errors
/// - `RngFailure` if the OS CSPRNG is unavailable.
/// - `AuthenticationFailed` if the AEAD cipher reports an unexpected error.
pub fn wrap_key(key_bytes: &[u8], wrapper: &SecretKey) -> Result<Vec<u8>, MosaicCryptoError> {
    let mut nonce_bytes = [0u8; 24];
    getrandom::fill(&mut nonce_bytes).map_err(|_| MosaicCryptoError::RngFailure)?;

    let cipher = XChaCha20Poly1305::new_from_slice(wrapper.as_bytes()).map_err(|_| {
        MosaicCryptoError::InvalidKeyLength {
            actual: wrapper.as_bytes().len(),
        }
    })?;
    let nonce = XNonce::from_slice(&nonce_bytes);

    let ciphertext_and_tag = cipher
        .encrypt(nonce, key_bytes)
        .map_err(|_| MosaicCryptoError::AuthenticationFailed)?;

    let mut output = Vec::with_capacity(24 + ciphertext_and_tag.len());
    output.extend_from_slice(&nonce_bytes);
    output.extend_from_slice(&ciphertext_and_tag);
    Ok(output)
}

/// Unwraps a key previously wrapped with [`wrap_key`].
///
/// # Errors
/// - `WrappedKeyTooShort` if `wrapped` is shorter than 41 bytes (24 nonce + 16 tag + 1 payload).
/// - `AuthenticationFailed` if AEAD verification fails.
pub fn unwrap_key(
    wrapped: &[u8],
    wrapper: &SecretKey,
) -> Result<Zeroizing<Vec<u8>>, MosaicCryptoError> {
    if wrapped.len() < MIN_WRAPPED_KEY_BYTES {
        return Err(MosaicCryptoError::WrappedKeyTooShort {
            actual: wrapped.len(),
        });
    }

    let nonce = XNonce::from_slice(&wrapped[..24]);
    let ciphertext_and_tag = &wrapped[24..];

    let cipher = XChaCha20Poly1305::new_from_slice(wrapper.as_bytes()).map_err(|_| {
        MosaicCryptoError::InvalidKeyLength {
            actual: wrapper.as_bytes().len(),
        }
    })?;

    let plaintext = cipher
        .decrypt(nonce, ciphertext_and_tag)
        .map_err(|_| MosaicCryptoError::AuthenticationFailed)?;

    Ok(Zeroizing::new(plaintext))
}

/// Returns the base64url no-padding SHA-256 digest of `bytes` as a `String`.
#[must_use]
pub fn sha256_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    base64url_no_pad(digest.as_slice())
}

/// Encodes `bytes` as base64url with no padding characters (RFC 4648 §5, no `=`).
fn base64url_no_pad(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let cap = (bytes.len() * 4).div_ceil(3);
    let mut output = String::with_capacity(cap);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = if chunk.len() > 1 {
            u32::from(chunk[1])
        } else {
            0
        };
        let b2 = if chunk.len() > 2 {
            u32::from(chunk[2])
        } else {
            0
        };
        let combined = (b0 << 16) | (b1 << 8) | b2;
        // All indexed values are in 0..64 so the cast to char is valid ASCII.
        output.push(ALPHABET[((combined >> 18) & 0x3F) as usize] as char);
        output.push(ALPHABET[((combined >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            output.push(ALPHABET[((combined >> 6) & 0x3F) as usize] as char);
        }
        if chunk.len() > 2 {
            output.push(ALPHABET[(combined & 0x3F) as usize] as char);
        }
    }
    output
}

#[must_use]
pub const fn crate_name() -> &'static str {
    "mosaic-crypto"
}

/// Returns the domain protocol version this crypto crate is compiled against.
#[must_use]
pub const fn protocol_version() -> &'static str {
    mosaic_domain::PROTOCOL_VERSION
}

/// Deterministic derivation used by the explicit FFI spike probe.
pub fn test_only_derive_probe_key(
    input: &[u8],
    context: &[u8],
) -> Result<[u8; 32], MosaicCryptoError> {
    if context.is_empty() {
        return Err(MosaicCryptoError::EmptyContext);
    }

    let mut output = [0_u8; 32];
    Hkdf::<Sha256>::new(Some(context), input)
        .expand(b"mosaic:ffi-spike-probe:v1", &mut output)
        .map_err(|_| MosaicCryptoError::KdfFailure)?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    #[test]
    fn uses_domain_protocol_version() {
        assert_eq!(super::protocol_version(), "mosaic-v1");
    }
}
