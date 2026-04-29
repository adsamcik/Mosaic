//! TypeScript-canonical primitives for cross-client byte-exact parity.
//!
//! The Mosaic Rust core has historically used HKDF-SHA256 + XChaCha20-Poly1305
//! for the L0→L1 root-key chain, the auth signing seed, and tier-key wrapping.
//! The shipped TypeScript reference (`libs/crypto`) instead uses BLAKE2b-keyed
//! derivation and `crypto_secretbox` (XSalsa20-Poly1305) for the equivalent
//! operations. The mismatch is documented in `tests/vectors/deviations.md`.
//!
//! This module exposes a parallel set of TS-canonical primitives that produce
//! byte-identical outputs to the captured `tests/vectors/*.json` corpus. They
//! are wired through the FFI bindings (mosaic-wasm + mosaic-uniffi) so the
//! cross-client differential tests can lock byte-equality on every supported
//! client implementation. Production code paths continue to use the existing
//! HKDF/XChaCha20 primitives until a protocol-level cutover is decided; this
//! module never touches them.
//!
//! All functions in this module zeroize secret inputs and intermediates on
//! exit. The returned secret material (auth signing seeds, root keys, account
//! keys) is wrapped in [`Zeroizing`] so it cannot accidentally outlive the
//! caller's scope.

use blake2::Blake2b;
use blake2::digest::{Digest, KeyInit as Blake2KeyInit, Mac as Blake2Mac};
use blake2::digest::{
    consts::{U16, U32},
    typenum::IsLessOrEqual,
    typenum::NonZero,
    typenum::U64 as Blake2bMaxKey,
};
use crypto_secretbox::aead::Aead;
use crypto_secretbox::{Nonce as SecretboxNonce, XSalsa20Poly1305};
use zeroize::{Zeroize, Zeroizing};

use crate::SALT_BYTES;
use crate::{MosaicCryptoError, SecretKey};

/// XSalsa20-Poly1305 nonce length in bytes (libsodium `crypto_secretbox`).
pub const SECRETBOX_NONCE_BYTES: usize = 24;

/// Poly1305 authentication tag length in bytes.
pub const SECRETBOX_TAG_BYTES: usize = 16;

/// 32-byte BLAKE2b output length used by every Mosaic L0/L1/L2 primitive.
const BLAKE2B_OUT_BYTES: usize = 32;

/// Domain context the TypeScript reference mixes into the auth signing seed.
///
/// Must be byte-identical to `auth.ts`: `'Mosaic_AuthKey_v1'` (16 bytes ASCII).
const TS_AUTH_KEY_CONTEXT: &[u8] = b"Mosaic_AuthKey_v1";

/// Domain context the TypeScript reference uses for the L1 root-key
/// derivation (BLAKE2b-keyed first stage).
///
/// Must be byte-identical to `keychain.ts`: `'Mosaic_RootKey_v1'` (17 bytes).
const TS_ROOT_KEY_CONTEXT: &[u8] = b"Mosaic_RootKey_v1";

/// Domain context the TypeScript reference uses for the L1 root-key
/// derivation (BLAKE2b-keyed account-salt mixing stage).
///
/// Must be byte-identical to `keychain.ts`: `'Mosaic_AccountKey_v1'` (20 bytes).
const TS_ACCOUNT_KEY_CONTEXT: &[u8] = b"Mosaic_AccountKey_v1";

/// Computes `BLAKE2b(out_len = 32, key = key, msg = msg)` matching libsodium's
/// `crypto_generichash(out_len, msg, key)` exactly.
fn blake2b_keyed_32(key: &[u8], msg: &[u8]) -> Result<[u8; BLAKE2B_OUT_BYTES], MosaicCryptoError> {
    fn inner<OutSize>(
        key: &[u8],
        msg: &[u8],
    ) -> Result<blake2::digest::Output<blake2::Blake2bMac<OutSize>>, MosaicCryptoError>
    where
        OutSize: blake2::digest::generic_array::ArrayLength<u8>
            + IsLessOrEqual<Blake2bMaxKey>,
        blake2::digest::typenum::LeEq<OutSize, Blake2bMaxKey>: NonZero,
    {
        let mut mac = <blake2::Blake2bMac<OutSize> as Blake2KeyInit>::new_from_slice(key)
            .map_err(|_| MosaicCryptoError::InvalidKeyLength { actual: key.len() })?;
        Blake2Mac::update(&mut mac, msg);
        Ok(mac.finalize().into_bytes())
    }

    let bytes = inner::<U32>(key, msg)?;
    let mut out = [0_u8; BLAKE2B_OUT_BYTES];
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// Computes `BLAKE2b(out_len = 32, key = none, msg = msg)` matching
/// libsodium's two-argument `crypto_generichash(out_len, msg)`.
///
/// Used by the TS-canonical auth-keypair derivation, which calls
/// `sodium.crypto_generichash(KEY_SIZE, concat(authContext, l0))` with no key.
fn blake2b_unkeyed_32(msg: &[u8]) -> Result<[u8; BLAKE2B_OUT_BYTES], MosaicCryptoError> {
    let mut hasher = <Blake2b<U32> as Digest>::new();
    Digest::update(&mut hasher, msg);
    let bytes = hasher.finalize();
    let mut out = [0_u8; BLAKE2B_OUT_BYTES];
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// Computes `BLAKE2b(out_len = 16, key = key, msg = msg)` matching libsodium's
/// `crypto_generichash(out_len = 16, msg, key)`.
///
/// Re-exported through [`crate::derive_link_keys`] in production but provided
/// here as a helper for the cross-client TS-canonical wire-up so callers do
/// not need to depend on the link-sharing module internals.
pub fn blake2b_keyed_16(key: &[u8], msg: &[u8]) -> Result<[u8; 16], MosaicCryptoError> {
    let mut mac = <blake2::Blake2bMac<U16> as Blake2KeyInit>::new_from_slice(key)
        .map_err(|_| MosaicCryptoError::InvalidKeyLength { actual: key.len() })?;
    Blake2Mac::update(&mut mac, msg);
    let bytes = mac.finalize().into_bytes();
    let mut out = [0_u8; 16];
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// Derives the TS-canonical auth signing seed from a 32-byte L0 master key.
///
/// Mirrors `auth.ts`:
/// ```text
/// authSeed = BLAKE2b(out_len = 32, msg = "Mosaic_AuthKey_v1" || L0)
/// ```
///
/// The returned 32-byte buffer is the Ed25519 signing seed that
/// `sodium.crypto_sign_seed_keypair` would expand into a (pk, sk) pair. The
/// caller is responsible for zeroizing the returned [`Zeroizing`] buffer
/// before it leaves a long-lived scope.
///
/// # Errors
/// * [`MosaicCryptoError::InvalidKeyLength`] if `l0_master_key` is not exactly
///   32 bytes.
/// * [`MosaicCryptoError::KdfFailure`] if BLAKE2b reports an unexpected
///   internal error (should never happen for fixed 32-byte output).
pub fn derive_auth_signing_seed_blake2b(
    l0_master_key: &[u8],
) -> Result<Zeroizing<[u8; BLAKE2B_OUT_BYTES]>, MosaicCryptoError> {
    if l0_master_key.len() != BLAKE2B_OUT_BYTES {
        return Err(MosaicCryptoError::InvalidKeyLength {
            actual: l0_master_key.len(),
        });
    }

    let mut msg = Zeroizing::new(Vec::with_capacity(
        TS_AUTH_KEY_CONTEXT.len() + BLAKE2B_OUT_BYTES,
    ));
    msg.extend_from_slice(TS_AUTH_KEY_CONTEXT);
    msg.extend_from_slice(l0_master_key);

    let seed = blake2b_unkeyed_32(msg.as_slice())?;
    Ok(Zeroizing::new(seed))
}

/// Derives the TS-canonical L1 root key from `(L0, account_salt)`.
///
/// Mirrors the BLAKE2b chain in `keychain.ts`:
/// ```text
/// rootKeyIntermediate = BLAKE2b(out=32, key="Mosaic_RootKey_v1", msg=L0)
/// inner               = BLAKE2b(out=32, key="Mosaic_AccountKey_v1", msg=account_salt)
/// rootKey             = BLAKE2b(out=32, key=inner, msg=rootKeyIntermediate)
/// ```
///
/// Both keyed BLAKE2b calls follow RFC 7693 §2.5 for the parameter block
/// (zero salt, zero personalisation, `key_length = key.len()`,
/// `digest_length = 32`), exactly as libsodium's `crypto_generichash`.
///
/// # Errors
/// * [`MosaicCryptoError::InvalidKeyLength`] if `l0_master_key` is not 32 bytes.
/// * [`MosaicCryptoError::InvalidSaltLength`] if `account_salt` is not 16 bytes.
/// * [`MosaicCryptoError::KdfFailure`] if BLAKE2b reports an internal error.
pub fn derive_root_key_blake2b(
    l0_master_key: &[u8],
    account_salt: &[u8],
) -> Result<SecretKey, MosaicCryptoError> {
    if l0_master_key.len() != BLAKE2B_OUT_BYTES {
        return Err(MosaicCryptoError::InvalidKeyLength {
            actual: l0_master_key.len(),
        });
    }
    if account_salt.len() != SALT_BYTES {
        return Err(MosaicCryptoError::InvalidSaltLength {
            actual: account_salt.len(),
        });
    }

    let mut intermediate = Zeroizing::new(blake2b_keyed_32(TS_ROOT_KEY_CONTEXT, l0_master_key)?);
    let mut inner = Zeroizing::new(blake2b_keyed_32(TS_ACCOUNT_KEY_CONTEXT, account_salt)?);
    let mut root_bytes =
        Zeroizing::new(blake2b_keyed_32(inner.as_slice(), intermediate.as_slice())?);

    intermediate.zeroize();
    inner.zeroize();

    let mut root_buf = Zeroizing::new([0_u8; BLAKE2B_OUT_BYTES]);
    root_buf.copy_from_slice(root_bytes.as_slice());
    root_bytes.zeroize();

    SecretKey::from_bytes(root_buf.as_mut_slice())
}

/// Wraps `key_bytes` with `wrapper` using libsodium's `crypto_secretbox`
/// (XSalsa20-Poly1305) and a freshly generated 24-byte nonce.
///
/// Output layout matches the TS reference (`keychain.ts`):
/// `nonce(24) || ciphertext_with_tag`. The ciphertext segment is exactly
/// `key_bytes.len() + 16` bytes (Poly1305 tag appended by the AEAD).
///
/// # Errors
/// * [`MosaicCryptoError::InvalidKeyLength`] if `wrapper` is not 32 bytes
///   (defensive; enforced by [`SecretKey::from_bytes`]).
/// * [`MosaicCryptoError::InvalidInputLength`] if `key_bytes` is empty.
/// * [`MosaicCryptoError::RngFailure`] if the OS CSPRNG is unavailable.
/// * [`MosaicCryptoError::AuthenticationFailed`] if the AEAD reports an
///   unexpected error.
pub fn wrap_key_secretbox(
    key_bytes: &[u8],
    wrapper: &SecretKey,
) -> Result<Vec<u8>, MosaicCryptoError> {
    if key_bytes.is_empty() {
        return Err(MosaicCryptoError::InvalidInputLength { actual: 0 });
    }
    if wrapper.as_bytes().len() != BLAKE2B_OUT_BYTES {
        return Err(MosaicCryptoError::InvalidKeyLength {
            actual: wrapper.as_bytes().len(),
        });
    }

    let mut nonce_bytes = [0_u8; SECRETBOX_NONCE_BYTES];
    getrandom::fill(&mut nonce_bytes).map_err(|_| MosaicCryptoError::RngFailure)?;

    let cipher = XSalsa20Poly1305::new_from_slice(wrapper.as_bytes()).map_err(|_| {
        MosaicCryptoError::InvalidKeyLength {
            actual: wrapper.as_bytes().len(),
        }
    })?;
    let nonce = SecretboxNonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, key_bytes)
        .map_err(|_| MosaicCryptoError::AuthenticationFailed)?;

    let mut output = Vec::with_capacity(SECRETBOX_NONCE_BYTES + ciphertext.len());
    output.extend_from_slice(&nonce_bytes);
    output.extend_from_slice(&ciphertext);
    Ok(output)
}

/// Unwraps a `nonce(24) || ciphertext_with_tag` blob produced by
/// [`wrap_key_secretbox`] (or by libsodium's `crypto_secretbox_easy`).
///
/// # Errors
/// * [`MosaicCryptoError::WrappedKeyTooShort`] if `wrapped` is shorter than
///   `24 + 16 + 1` bytes.
/// * [`MosaicCryptoError::InvalidKeyLength`] if `wrapper` is not 32 bytes.
/// * [`MosaicCryptoError::AuthenticationFailed`] if the AEAD verification
///   fails (wrong wrapper, tampered ciphertext, or tampered nonce).
pub fn unwrap_key_secretbox(
    wrapped: &[u8],
    wrapper: &SecretKey,
) -> Result<Zeroizing<Vec<u8>>, MosaicCryptoError> {
    if wrapped.len() < SECRETBOX_NONCE_BYTES + SECRETBOX_TAG_BYTES + 1 {
        return Err(MosaicCryptoError::WrappedKeyTooShort {
            actual: wrapped.len(),
        });
    }
    if wrapper.as_bytes().len() != BLAKE2B_OUT_BYTES {
        return Err(MosaicCryptoError::InvalidKeyLength {
            actual: wrapper.as_bytes().len(),
        });
    }

    let nonce = SecretboxNonce::from_slice(&wrapped[..SECRETBOX_NONCE_BYTES]);
    let ciphertext_and_tag = &wrapped[SECRETBOX_NONCE_BYTES..];

    let cipher = XSalsa20Poly1305::new_from_slice(wrapper.as_bytes()).map_err(|_| {
        MosaicCryptoError::InvalidKeyLength {
            actual: wrapper.as_bytes().len(),
        }
    })?;
    let plaintext = cipher
        .decrypt(nonce, ciphertext_and_tag)
        .map_err(|_| MosaicCryptoError::AuthenticationFailed)?;

    Ok(Zeroizing::new(plaintext))
}

/// Unwraps a TS-canonical wrapped account key from
/// `(l0_master_key, account_salt, wrapped_account_key)`.
///
/// Combines [`derive_root_key_blake2b`] and [`unwrap_key_secretbox`] into a
/// single byte-exact-with-TS operation matching `tests/vectors/account_unlock.json`.
/// On success returns the unwrapped 32-byte L2 account key; the L1 root key is
/// zeroized internally before return.
///
/// # Errors
/// Returns the first error from the underlying primitives (root-key
/// derivation, secretbox unwrap).
pub fn unwrap_account_key_v1(
    l0_master_key: &[u8],
    account_salt: &[u8],
    wrapped_account_key: &[u8],
) -> Result<SecretKey, MosaicCryptoError> {
    let root_key = derive_root_key_blake2b(l0_master_key, account_salt)?;
    let mut unwrapped = unwrap_key_secretbox(wrapped_account_key, &root_key)?;
    if unwrapped.len() != BLAKE2B_OUT_BYTES {
        let actual = unwrapped.len();
        unwrapped.zeroize();
        return Err(MosaicCryptoError::InvalidKeyLength { actual });
    }
    SecretKey::from_bytes(unwrapped.as_mut_slice())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn from_hex(value: &str) -> Vec<u8> {
        let mut out = Vec::with_capacity(value.len() / 2);
        let mut iter = value.as_bytes().chunks_exact(2);
        for chunk in &mut iter {
            let high = char::from(chunk[0]).to_digit(16).expect("valid hex");
            let low = char::from(chunk[1]).to_digit(16).expect("valid hex");
            out.push(((high as u8) << 4) | low as u8);
        }
        assert!(iter.remainder().is_empty(), "odd-length hex literal");
        out
    }

    fn hex_lower(bytes: &[u8]) -> String {
        const ALPHABET: &[u8; 16] = b"0123456789abcdef";
        let mut out = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            out.push(ALPHABET[(byte >> 4) as usize] as char);
            out.push(ALPHABET[(byte & 0x0F) as usize] as char);
        }
        out
    }

    #[test]
    fn auth_keypair_blake2b_matches_corpus() {
        // tests/vectors/auth_keypair.json
        let l0 = from_hex("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20");
        let expected_seed =
            from_hex("ff7a15bea29b406647454c0eec9288f0935103a51e7b444106415eee10ee4f14");
        let seed = derive_auth_signing_seed_blake2b(&l0).expect("derive");
        assert_eq!(hex_lower(seed.as_slice()), hex_lower(&expected_seed));
    }

    #[test]
    fn auth_keypair_blake2b_short_input_rejected() {
        let mut short = vec![0u8; 31];
        let err = derive_auth_signing_seed_blake2b(&short).unwrap_err();
        assert!(matches!(
            err,
            MosaicCryptoError::InvalidKeyLength { actual: 31 }
        ));
        short.iter_mut().for_each(|b| *b = 0);
    }

    #[test]
    fn root_key_blake2b_matches_corpus() {
        // tests/vectors/account_unlock.json
        let l0 = from_hex("11223344556677889900aabbccddeeff0011223344556677889900aabbccddee");
        let salt = from_hex("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf");
        let expected_root =
            from_hex("ec5c870d829d2d00ddb37889e72cc6f29bb7ad877b8764fb3799ae5010e3d039");
        let root = derive_root_key_blake2b(&l0, &salt).expect("derive root");
        assert_eq!(hex_lower(root.as_bytes()), hex_lower(&expected_root));
    }

    #[test]
    fn root_key_blake2b_invalid_salt_length_rejected() {
        let l0 = from_hex("11223344556677889900aabbccddeeff0011223344556677889900aabbccddee");
        let bad_salt = vec![0u8; 15];
        let err = derive_root_key_blake2b(&l0, &bad_salt)
            .map(|_| ())
            .unwrap_err();
        assert!(matches!(
            err,
            MosaicCryptoError::InvalidSaltLength { actual: 15 }
        ));
    }

    #[test]
    fn account_unlock_v1_full_chain_matches_corpus() {
        // tests/vectors/account_unlock.json
        let l0 = from_hex("11223344556677889900aabbccddeeff0011223344556677889900aabbccddee");
        let salt = from_hex("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf");
        let wrapped = from_hex(
            "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff8962072bb381c574cafdba9c\
             3fedcdf86f45201309a031bf0ff6285967da0b68683c64dabd9355b44439a0efdbf0c9e5",
        );
        let expected_account =
            from_hex("deadbeefcafebabe0102030405060708090a0b0c0d0e0f101112131415161718");
        let account = unwrap_account_key_v1(&l0, &salt, &wrapped).expect("unwrap account");
        assert_eq!(hex_lower(account.as_bytes()), hex_lower(&expected_account));
    }

    #[test]
    fn account_unlock_v1_tampered_wrap_authentication_failed() {
        let l0 = from_hex("11223344556677889900aabbccddeeff0011223344556677889900aabbccddee");
        let salt = from_hex("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf");
        let mut wrapped = from_hex(
            "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff8962072bb381c574cafdba9c\
             3fedcdf86f45201309a031bf0ff6285967da0b68683c64dabd9355b44439a0efdbf0c9e5",
        );
        // Flip the first ciphertext byte (offset 24).
        wrapped[24] ^= 0x01;
        let err = unwrap_account_key_v1(&l0, &salt, &wrapped)
            .map(|_| ())
            .unwrap_err();
        assert_eq!(err, MosaicCryptoError::AuthenticationFailed);
    }

    #[test]
    fn account_unlock_v1_wrong_account_salt_rejected() {
        let l0 = from_hex("11223344556677889900aabbccddeeff0011223344556677889900aabbccddee");
        let mut salt = from_hex("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf");
        salt[0] ^= 0x01; // tamper salt
        let wrapped = from_hex(
            "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff8962072bb381c574cafdba9c\
             3fedcdf86f45201309a031bf0ff6285967da0b68683c64dabd9355b44439a0efdbf0c9e5",
        );
        let err = unwrap_account_key_v1(&l0, &salt, &wrapped)
            .map(|_| ())
            .unwrap_err();
        assert_eq!(err, MosaicCryptoError::AuthenticationFailed);
    }

    #[test]
    fn secretbox_wrap_unwrap_roundtrip() {
        let mut wrapper_buf = [0_u8; 32];
        for (i, byte) in wrapper_buf.iter_mut().enumerate() {
            *byte = i as u8;
        }
        let wrapper = SecretKey::from_bytes(&mut wrapper_buf).unwrap();
        let payload = b"payload \xff\x00 with secret bytes";
        let wrapped = wrap_key_secretbox(payload, &wrapper).expect("wrap");
        assert!(wrapped.len() >= SECRETBOX_NONCE_BYTES + SECRETBOX_TAG_BYTES + payload.len());
        let unwrapped = unwrap_key_secretbox(&wrapped, &wrapper).expect("unwrap");
        assert_eq!(unwrapped.as_slice(), payload);
    }

    #[test]
    fn secretbox_unwrap_too_short_rejected() {
        let mut wrapper_buf = [0_u8; 32];
        let wrapper = SecretKey::from_bytes(&mut wrapper_buf).unwrap();
        let too_short = vec![0_u8; SECRETBOX_NONCE_BYTES + SECRETBOX_TAG_BYTES];
        let err = unwrap_key_secretbox(&too_short, &wrapper).unwrap_err();
        assert!(matches!(err, MosaicCryptoError::WrappedKeyTooShort { .. }));
    }

    #[test]
    fn secretbox_unwrap_tampered_authentication_failed() {
        let mut wrapper_buf = [0_u8; 32];
        let wrapper = SecretKey::from_bytes(&mut wrapper_buf).unwrap();
        let payload = b"abc";
        let mut wrapped = wrap_key_secretbox(payload, &wrapper).expect("wrap");
        let last = wrapped.len() - 1;
        wrapped[last] ^= 0x01;
        let err = unwrap_key_secretbox(&wrapped, &wrapper).unwrap_err();
        assert_eq!(err, MosaicCryptoError::AuthenticationFailed);
    }

    #[test]
    fn blake2b_keyed_16_matches_corpus_link_id() {
        // tests/vectors/link_keys.json — link_id derivation.
        let secret = from_hex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
        let expected = from_hex("0bf33461e2803351e36ef8f8b3e57ac0");
        let id = blake2b_keyed_16(&secret, b"mosaic:link:id:v1").unwrap();
        assert_eq!(hex_lower(&id), hex_lower(&expected));
    }
}
