//! Cryptographic boundary crate for the Mosaic Rust client core.

#![forbid(unsafe_code)]

use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use mosaic_domain::{SHARD_ENVELOPE_HEADER_LEN, ShardEnvelopeHeader, ShardTier};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

/// Maximum allowed plaintext size for shard encryption (100 MiB).
const MAX_SHARD_BYTES: usize = 100 * 1024 * 1024;

/// Minimum valid wrapped key length: 24-byte nonce + 16-byte AEAD tag + 1-byte payload.
const MIN_WRAPPED_KEY_BYTES: usize = 24 + 16 + 1;

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
}

/// Opaque 32-byte secret key that zeroizes its contents on drop.
///
/// Intentionally does not implement `Clone`, `Copy`, `Debug`, `Display`, or `Serialize`
/// to prevent accidental leakage.
pub struct SecretKey([u8; 32]);

impl SecretKey {
    /// Constructs a `SecretKey` from a raw 32-byte array, taking ownership.
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Returns a reference to the underlying key bytes.
    ///
    /// Use only inside controlled cryptographic operations; never log or display the result.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl Drop for SecretKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Output of a successful shard encryption.
pub struct EncryptedShard {
    /// Serialized envelope: 64-byte header || ciphertext || 16-byte AEAD tag.
    pub bytes: Vec<u8>,
    /// Base64url no-padding SHA-256 digest of `bytes`.
    pub sha256: String,
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

/// Deterministic test-only derivation used by the FFI spike.
///
/// This is not production cryptography. Production KDF/encryption work lands in
/// the crypto-core phase with audited primitives and golden vectors.
pub fn test_only_derive_probe_key(
    input: &[u8],
    context: &[u8],
) -> Result<[u8; 32], MosaicCryptoError> {
    if context.is_empty() {
        return Err(MosaicCryptoError::EmptyContext);
    }

    let mut state = [
        0x6d6f_7361_6963_2d31_u64,
        0x6666_692d_7370_696b_u64,
        0x6465_7269_7665_2d31_u64,
        0x636f_6e74_6578_7421_u64,
    ];

    mix_bytes(&mut state, context);
    mix_byte(&mut state, 0xff);
    mix_bytes(&mut state, input);

    let mut output = [0_u8; 32];
    for (index, value) in state.iter().enumerate() {
        output[index * 8..(index + 1) * 8].copy_from_slice(&value.to_le_bytes());
    }
    Ok(output)
}

fn mix_bytes(state: &mut [u64; 4], bytes: &[u8]) {
    for byte in bytes {
        mix_byte(state, *byte);
    }
}

fn mix_byte(state: &mut [u64; 4], byte: u8) {
    state[0] ^= u64::from(byte);
    state[0] = state[0].wrapping_mul(0x1000_0000_01b3);
    state[1] ^= state[0].rotate_left(13);
    state[2] = state[2].wrapping_add(state[1] ^ 0x9e37_79b9_7f4a_7c15);
    state[3] ^= state[2].rotate_right(17);
}

#[cfg(test)]
mod tests {
    #[test]
    fn uses_domain_protocol_version() {
        assert_eq!(super::protocol_version(), "mosaic-v1");
    }
}
