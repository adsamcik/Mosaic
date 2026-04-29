//! Shareable album link cryptography.
//!
//! Mirrors the TypeScript implementation in `libs/crypto/src/link-sharing.ts`.
//!
//! A *link secret* is 32 random bytes embedded in the URL fragment (so it
//! never reaches the server). From it the client deterministically derives:
//!
//! * a 16-byte `link_id` for server-side lookup (safe to expose), and
//! * a 32-byte `wrapping_key` that wraps each tier key the link grants
//!   access to (never sent to the server).
//!
//! Both derivations are BLAKE2b keyed-hashes with stable domain-separating
//! contexts. The contexts MUST match the TS module byte-for-byte so existing
//! share links continue to resolve after the Rust cutover.
//!
//! ```text
//!   link_id      = BLAKE2b-128(key = link_secret, msg = "mosaic:link:id:v1")
//!   wrapping_key = BLAKE2b-256(key = link_secret, msg = "mosaic:link:wrap:v1")
//! ```
//!
//! Tier-key wrapping reuses the workspace [`crate::wrap_key`] /
//! [`crate::unwrap_key`] helpers (XChaCha20-Poly1305 with a fresh 24-byte
//! nonce per call). The wrapped output is split into `(nonce, encrypted_key)`
//! for clean serialisation alongside the `tier` byte.

use blake2::Blake2bMac;
use blake2::digest::{KeyInit, Mac, consts::U16, consts::U32};
use mosaic_domain::ShardTier;
use std::fmt;
use zeroize::Zeroizing;

use crate::{
    KEY_BYTES, LINK_ID_BYTES, LINK_SECRET_BYTES, MosaicCryptoError, SecretKey, unwrap_key, wrap_key,
};

/// Length of the XChaCha20-Poly1305 nonce embedded in every wrapped tier key.
const LINK_WRAP_NONCE_BYTES: usize = 24;

/// BLAKE2b-keyed domain separation context for `link_id`.
///
/// Must match `LINK_ID_CONTEXT` in `libs/crypto/src/link-sharing.ts`.
const LINK_ID_CONTEXT: &[u8] = b"mosaic:link:id:v1";

/// BLAKE2b-keyed domain separation context for `wrapping_key`.
///
/// Must match `LINK_WRAP_CONTEXT` in `libs/crypto/src/link-sharing.ts`.
const LINK_WRAP_CONTEXT: &[u8] = b"mosaic:link:wrap:v1";

/// Result of [`derive_link_keys`].
///
/// The `wrapping_key` is deliberately a [`SecretKey`] so it zeroizes on drop
/// and cannot be accidentally cloned, logged, or serialised. The `link_id`
/// is non-secret (it is the server-visible lookup token) and is therefore a
/// plain fixed-size array.
pub struct LinkKeys {
    /// 16-byte server-visible lookup ID for the share link.
    pub link_id: [u8; LINK_ID_BYTES],
    /// 32-byte wrapping key derived from the link secret.
    pub wrapping_key: SecretKey,
}

/// One tier key wrapped for storage on the share-link record.
///
/// The pair `(nonce, encrypted_key)` is the same shape that
/// `wrapTierKeyForLink` produces in TypeScript; concatenated as
/// `nonce || encrypted_key` it is exactly what [`crate::unwrap_key`]
/// expects.
#[derive(Clone, PartialEq, Eq)]
pub struct WrappedTierKey {
    /// The tier this wrapped key grants access to.
    pub tier: ShardTier,
    /// 24-byte XChaCha20 nonce used by `wrap_key`.
    pub nonce: [u8; LINK_WRAP_NONCE_BYTES],
    /// Ciphertext including the trailing 16-byte Poly1305 tag.
    pub encrypted_key: Vec<u8>,
}

impl fmt::Debug for WrappedTierKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WrappedTierKey")
            .field("tier", &self.tier)
            .field("nonce_len", &self.nonce.len())
            .field("encrypted_key_len", &self.encrypted_key.len())
            .finish()
    }
}

/// Generates a fresh 32-byte link secret using the OS CSPRNG.
///
/// The result is wrapped in [`Zeroizing`] so the bytes are erased when the
/// caller drops them.
///
/// # Errors
/// Returns [`MosaicCryptoError::RngFailure`] if the OS CSPRNG is unavailable.
pub fn generate_link_secret() -> Result<Zeroizing<[u8; LINK_SECRET_BYTES]>, MosaicCryptoError> {
    let mut bytes = Zeroizing::new([0_u8; LINK_SECRET_BYTES]);
    getrandom::fill(bytes.as_mut_slice()).map_err(|_| MosaicCryptoError::RngFailure)?;
    Ok(bytes)
}

/// Derives the `(link_id, wrapping_key)` pair from a 32-byte link secret.
///
/// Both outputs are BLAKE2b keyed hashes (libsodium calls this
/// `crypto_generichash(out_len, message=context, key=link_secret)`) with
/// distinct domain-separating contexts. The Rust `blake2::Blake2bMac<OutSize>`
/// type produces the exact same bytes because both implementations follow
/// RFC 7693 §2.5 for the parameter block (zero salt, zero personalisation,
/// `key_length = key.len()`, `digest_length = OutSize`).
///
/// # Errors
/// Returns [`MosaicCryptoError::InvalidKeyLength`] if `link_secret` is not
/// exactly 32 bytes. This mirrors the TypeScript reference, which raises
/// `CryptoError(INVALID_KEY_LENGTH)` for the same condition.
pub fn derive_link_keys(link_secret: &[u8]) -> Result<LinkKeys, MosaicCryptoError> {
    if link_secret.len() != LINK_SECRET_BYTES {
        return Err(MosaicCryptoError::InvalidKeyLength {
            actual: link_secret.len(),
        });
    }

    let link_id = blake2_keyed::<U16>(link_secret, LINK_ID_CONTEXT)?;
    let wrapping_key_bytes = blake2_keyed::<U32>(link_secret, LINK_WRAP_CONTEXT)?;

    let mut link_id_arr = [0_u8; LINK_ID_BYTES];
    link_id_arr.copy_from_slice(&link_id);

    let mut wrapping_key_buf = [0_u8; KEY_BYTES];
    wrapping_key_buf.copy_from_slice(&wrapping_key_bytes);
    let wrapping_key = SecretKey::from_bytes(&mut wrapping_key_buf)?;

    Ok(LinkKeys {
        link_id: link_id_arr,
        wrapping_key,
    })
}

/// Wraps a 32-byte tier key for storage on the share-link record.
///
/// Output layout matches `wrapTierKeyForLink` in the TS module:
/// `nonce(24) || encrypted_key(payload(32) || tag(16))` split apart so the
/// caller can serialise the components independently.
///
/// # Errors
/// * [`MosaicCryptoError::InvalidKeyLength`] if `tier_key` is not 32 bytes.
/// * Any error propagated from [`crate::wrap_key`] (RNG / AEAD failures).
pub fn wrap_tier_key_for_link(
    tier_key: &[u8],
    tier: ShardTier,
    wrapping_key: &SecretKey,
) -> Result<WrappedTierKey, MosaicCryptoError> {
    if tier_key.len() != KEY_BYTES {
        return Err(MosaicCryptoError::InvalidKeyLength {
            actual: tier_key.len(),
        });
    }

    let wrapped = wrap_key(tier_key, wrapping_key)?;

    // wrap_key always returns nonce(24) || ciphertext_with_tag(>=17). The
    // explicit length check is defensive — if it ever shortens, fail loudly
    // rather than panicking on slice indexing.
    if wrapped.len() < LINK_WRAP_NONCE_BYTES {
        return Err(MosaicCryptoError::WrappedKeyTooShort {
            actual: wrapped.len(),
        });
    }

    let mut nonce = [0_u8; LINK_WRAP_NONCE_BYTES];
    nonce.copy_from_slice(&wrapped[..LINK_WRAP_NONCE_BYTES]);
    let encrypted_key = wrapped[LINK_WRAP_NONCE_BYTES..].to_vec();

    Ok(WrappedTierKey {
        tier,
        nonce,
        encrypted_key,
    })
}

/// Unwraps a tier key previously produced by [`wrap_tier_key_for_link`].
///
/// Verifies that the stored `tier` matches `expected_tier`, reconstructs the
/// `nonce || encrypted_key` blob, and delegates to [`crate::unwrap_key`].
///
/// # Errors
/// * [`MosaicCryptoError::LinkTierMismatch`] if `wrapped.tier != expected_tier`.
/// * Any error propagated from [`crate::unwrap_key`] (most commonly
///   [`MosaicCryptoError::AuthenticationFailed`] on tampering or a wrong
///   wrapping key).
pub fn unwrap_tier_key_from_link(
    wrapped: &WrappedTierKey,
    expected_tier: ShardTier,
    wrapping_key: &SecretKey,
) -> Result<Zeroizing<Vec<u8>>, MosaicCryptoError> {
    if wrapped.tier != expected_tier {
        return Err(MosaicCryptoError::LinkTierMismatch {
            expected: expected_tier.to_byte(),
            actual: wrapped.tier.to_byte(),
        });
    }

    let mut full_wrapped = Vec::with_capacity(wrapped.nonce.len() + wrapped.encrypted_key.len());
    full_wrapped.extend_from_slice(&wrapped.nonce);
    full_wrapped.extend_from_slice(&wrapped.encrypted_key);

    unwrap_key(&full_wrapped, wrapping_key)
}

/// Computes `BLAKE2b(out_len = OutSize, key, msg)` matching libsodium's
/// `crypto_generichash(out_len, msg, key)`.
///
/// `Blake2bMac<OutSize>` accepts any key length up to 64 bytes (the BLAKE2b
/// block size) and uses zero salt + zero personalisation, exactly the
/// configuration libsodium picks for unparameterised `crypto_generichash`.
fn blake2_keyed<OutSize>(
    key: &[u8],
    msg: &[u8],
) -> Result<blake2::digest::Output<Blake2bMac<OutSize>>, MosaicCryptoError>
where
    OutSize: blake2::digest::generic_array::ArrayLength<u8>
        + blake2::digest::typenum::IsLessOrEqual<blake2::digest::consts::U64>,
    blake2::digest::typenum::LeEq<OutSize, blake2::digest::consts::U64>:
        blake2::digest::typenum::NonZero,
{
    let mut mac = <Blake2bMac<OutSize> as KeyInit>::new_from_slice(key)
        .map_err(|_| MosaicCryptoError::InvalidKeyLength { actual: key.len() })?;
    Mac::update(&mut mac, msg);
    Ok(mac.finalize().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrapped_tier_key_debug_redacts_wrapped_key_bytes() {
        let wrapped = WrappedTierKey {
            tier: ShardTier::Preview,
            nonce: [201; LINK_WRAP_NONCE_BYTES],
            encrypted_key: vec![231, 232, 233],
        };

        let debug = format!("{wrapped:?}");
        assert!(debug.contains("tier: Preview"), "{debug}");
        assert!(debug.contains("nonce_len: 24"), "{debug}");
        assert!(debug.contains("encrypted_key_len: 3"), "{debug}");
        assert!(!debug.contains("201"), "{debug}");
        assert!(!debug.contains("231"), "{debug}");
        assert!(!debug.contains("encrypted_key: ["), "{debug}");
    }
}
