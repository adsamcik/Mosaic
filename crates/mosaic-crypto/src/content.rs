//! Album content encryption and decryption.
//!
//! Mirrors the TypeScript implementation in `libs/crypto/src/content.ts`.
//! Uses XChaCha20-Poly1305 AEAD with an 8-byte AAD that binds the ciphertext
//! to a specific album epoch, preventing cross-epoch replay after key rotation.

use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use zeroize::Zeroizing;

use crate::{MAX_SHARD_BYTES, MosaicCryptoError, SecretKey};

/// Length of the content AAD in bytes (magic + version + reserved + epoch_id).
const CONTENT_AAD_LEN: usize = 8;

/// Length of the XChaCha20-Poly1305 nonce in bytes.
const CONTENT_NONCE_LEN: usize = 24;

/// Encrypted album content: a 24-byte nonce paired with `ciphertext || tag`.
#[derive(Clone, PartialEq, Eq)]
pub struct EncryptedContent {
    /// 24-byte XChaCha20 nonce used for this encryption.
    pub nonce: [u8; CONTENT_NONCE_LEN],
    /// Ciphertext including the trailing 16-byte Poly1305 authentication tag.
    pub ciphertext: Vec<u8>,
}

/// Builds the 8-byte content AAD for the given epoch.
///
/// Layout (matches `buildContentAAD` in `libs/crypto/src/content.ts`):
///
/// | Offset | Size | Value                       |
/// |--------|------|-----------------------------|
/// | 0      | 1    | `0x4d` ('M')                |
/// | 1      | 1    | `0x43` ('C')                |
/// | 2      | 1    | `0x01` (version)            |
/// | 3      | 1    | `0x00` (reserved)           |
/// | 4..8   | 4    | `epoch_id` little-endian u32 |
fn build_content_aad(epoch_id: u32) -> [u8; CONTENT_AAD_LEN] {
    let mut aad = [0_u8; CONTENT_AAD_LEN];
    aad[0] = 0x4d;
    aad[1] = 0x43;
    aad[2] = 0x01;
    aad[3] = 0x00;
    aad[4..8].copy_from_slice(&epoch_id.to_le_bytes());
    aad
}

/// Encrypts album content with XChaCha20-Poly1305 bound to `epoch_id`.
///
/// Generates a fresh 24-byte random nonce per call. The plaintext is sealed
/// with the 8-byte AAD produced by [`build_content_aad`], so any change to
/// `epoch_id` between encrypt and decrypt produces an authentication failure.
///
/// # Errors
/// - `InvalidInputLength` if `plaintext` exceeds 100 MiB (`MAX_SHARD_BYTES`).
/// - `InvalidKeyLength` if `content_key` is not 32 bytes (defensive; enforced
///   by [`SecretKey`] construction).
/// - `RngFailure` if the OS CSPRNG is unavailable.
/// - `AuthenticationFailed` if the AEAD cipher reports an unexpected error.
pub fn encrypt_content(
    plaintext: &[u8],
    content_key: &SecretKey,
    epoch_id: u32,
) -> Result<EncryptedContent, MosaicCryptoError> {
    if plaintext.len() > MAX_SHARD_BYTES {
        return Err(MosaicCryptoError::InvalidInputLength {
            actual: plaintext.len(),
        });
    }

    let mut nonce_bytes = [0_u8; CONTENT_NONCE_LEN];
    getrandom::fill(&mut nonce_bytes).map_err(|_| MosaicCryptoError::RngFailure)?;

    let cipher = XChaCha20Poly1305::new_from_slice(content_key.as_bytes()).map_err(|_| {
        MosaicCryptoError::InvalidKeyLength {
            actual: content_key.as_bytes().len(),
        }
    })?;
    let nonce = XNonce::from_slice(&nonce_bytes);
    let aad = build_content_aad(epoch_id);

    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| MosaicCryptoError::AuthenticationFailed)?;

    Ok(EncryptedContent {
        nonce: nonce_bytes,
        ciphertext,
    })
}

/// Decrypts content produced by [`encrypt_content`].
///
/// The expected `epoch_id` must exactly match the value used at encryption
/// time, otherwise the AAD comparison fails and decryption returns
/// `AuthenticationFailed`.
///
/// Returns plaintext wrapped in [`Zeroizing`] so callers cannot accidentally
/// leak the buffer when it leaves scope.
///
/// # Errors
/// - `InvalidKeyLength` if `content_key` is not 32 bytes (defensive; enforced
///   by [`SecretKey`] construction).
/// - `AuthenticationFailed` if the AEAD verification fails (wrong key,
///   tampered ciphertext, tampered nonce, or mismatched `epoch_id`).
pub fn decrypt_content(
    ciphertext: &[u8],
    nonce: &[u8; CONTENT_NONCE_LEN],
    content_key: &SecretKey,
    epoch_id: u32,
) -> Result<Zeroizing<Vec<u8>>, MosaicCryptoError> {
    let cipher = XChaCha20Poly1305::new_from_slice(content_key.as_bytes()).map_err(|_| {
        MosaicCryptoError::InvalidKeyLength {
            actual: content_key.as_bytes().len(),
        }
    })?;
    let xnonce = XNonce::from_slice(nonce);
    let aad = build_content_aad(epoch_id);

    let plaintext = cipher
        .decrypt(
            xnonce,
            Payload {
                msg: ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| MosaicCryptoError::AuthenticationFailed)?;

    Ok(Zeroizing::new(plaintext))
}

#[cfg(test)]
mod tests {
    use super::{CONTENT_AAD_LEN, build_content_aad};

    #[test]
    fn aad_prefix_is_static_magic_version_reserved() {
        let aad = build_content_aad(0);
        assert_eq!(aad.len(), CONTENT_AAD_LEN);
        assert_eq!(&aad[0..4], &[0x4d, 0x43, 0x01, 0x00]);
    }

    #[test]
    fn aad_epoch_id_is_little_endian() {
        let cases: [u32; 4] = [0, 1, 0x1234_5678, 0xFFFF_FFFF];
        for epoch_id in cases {
            let aad = build_content_aad(epoch_id);
            assert_eq!(&aad[0..4], &[0x4d, 0x43, 0x01, 0x00]);
            assert_eq!(&aad[4..8], &epoch_id.to_le_bytes());
        }
    }
}
