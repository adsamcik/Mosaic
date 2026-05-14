//! Sealed epoch key bundle distribution primitives.
//!
//! Mirrors the TypeScript `libs/crypto/src/sharing.ts` protocol: encrypt the
//! bundle JSON with a libsodium-compatible sealed box (X25519 +
//! XSalsa20-Poly1305) so only the recipient can open it, then sign the
//! ciphertext with the sharer's Ed25519 identity key. Verification always
//! checks the signature *before* attempting to decrypt the sealed box so
//! forged bundles are rejected without consuming the X25519 private key.

extern crate alloc;

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use core::convert::TryInto;
use core::num::NonZeroU32;

use crypto_box::{PublicKey as BoxPublicKey, SecretKey as BoxSecretKey};
use rand_core::{CryptoRng, Error as RandError, RngCore, impls};
use serde::Deserialize;
use zeroize::Zeroizing;

use crate::{
    BUNDLE_SIGN_CONTEXT, IdentityKeypair, IdentitySignature, IdentitySigningPublicKey,
    ManifestSigningPublicKey, ManifestSigningSecretKey, MosaicCryptoError, SecretKey,
    base64url_no_pad, sign_manifest_with_identity, verify_manifest_identity_signature,
};

const SIGNATURE_BYTES: usize = 64;
const X25519_KEY_BYTES: usize = 32;
const ED25519_PUBLIC_KEY_BYTES: usize = 32;
const SEED_BYTES: usize = 32;
const SIGN_KEYPAIR_SECRET_BYTES: usize = 64;

/// In-memory representation of a Mosaic epoch key bundle.
///
/// All secret fields are owned by zeroizing wrappers. Construct directly with
/// `pub` field initialisation; consumers transfer ownership of the epoch
/// seed and signing seed when sealing or after opening.
pub struct EpochKeyBundle {
    /// Bundle format version. Current Rust implementation emits `1` and
    /// happily parses any non-negative version produced by an interop peer.
    pub version: u32,
    /// Album the bundle belongs to. Empty string is permitted only when the
    /// validation context explicitly enables the legacy fallback.
    pub album_id: String,
    /// Epoch identifier this bundle distributes keys for.
    pub epoch_id: u32,
    /// Recipient's Ed25519 identity public key. Pinned in the payload to
    /// bind the bundle to a specific account.
    pub recipient_pubkey: [u8; ED25519_PUBLIC_KEY_BYTES],
    /// 32-byte epoch seed used to derive every tier and content key.
    pub epoch_seed: SecretKey,
    /// Per-epoch Ed25519 signing seed (used by manifest signing).
    pub sign_secret_key: ManifestSigningSecretKey,
    /// Per-epoch Ed25519 signing public key matching `sign_secret_key`.
    pub sign_public_key: ManifestSigningPublicKey,
}

/// Output of [`seal_and_sign_bundle`].
#[derive(Clone)]
pub struct SealedBundle {
    /// Sealed-box ciphertext addressed to the recipient X25519 public key.
    pub sealed: Vec<u8>,
    /// Detached Ed25519 signature over `BUNDLE_SIGN_CONTEXT || sealed`.
    pub signature: [u8; SIGNATURE_BYTES],
    /// Sharer's Ed25519 identity public key (claimed authorship).
    pub sharer_pubkey: [u8; ED25519_PUBLIC_KEY_BYTES],
}

/// Validation policy applied while opening a bundle.
pub struct BundleValidationContext {
    /// Album identifier the recipient expects to find inside the payload.
    pub album_id: String,
    /// Lowest acceptable epoch identifier (used to defeat replay).
    pub min_epoch_id: u32,
    /// Permit payloads with `albumId == ""` for compatibility with bundles
    /// distributed before album binding was introduced.
    pub allow_legacy_empty_album_id: bool,
    /// Sharer Ed25519 public key the signature must verify against.
    pub expected_owner_ed25519_pub: [u8; ED25519_PUBLIC_KEY_BYTES],
}

#[derive(Deserialize)]
struct WireSignKeypair {
    #[serde(rename = "publicKey")]
    public_key: String,
    #[serde(rename = "secretKey")]
    secret_key: String,
}

#[derive(Deserialize)]
struct WireBundle {
    version: u32,
    #[serde(rename = "albumId")]
    album_id: String,
    #[serde(rename = "epochId")]
    epoch_id: u32,
    #[serde(rename = "recipientPubkey")]
    recipient_pubkey: String,
    #[serde(rename = "epochSeed")]
    epoch_seed: String,
    #[serde(rename = "signKeypair")]
    sign_keypair: WireSignKeypair,
}

/// Seal and sign a bundle for delivery to `recipient_ed25519_pub`.
///
/// The bundle JSON is encrypted with a libsodium-compatible sealed box using
/// the recipient's X25519 public key (derived from their Ed25519 identity)
/// and authenticated with a detached Ed25519 signature over
/// `BUNDLE_SIGN_CONTEXT || sealed` using the owner's identity key.
///
/// # Errors
/// - [`MosaicCryptoError::InvalidPublicKey`] if `recipient_ed25519_pub` is
///   not a valid Ed25519 point or fails X25519 conversion.
/// - [`MosaicCryptoError::AuthenticationFailed`] if the underlying AEAD seal
///   reports a failure (e.g. ephemeral key generation issue).
pub fn seal_and_sign_bundle(
    bundle: &EpochKeyBundle,
    recipient_ed25519_pub: &[u8; ED25519_PUBLIC_KEY_BYTES],
    owner_identity: &IdentityKeypair,
) -> Result<SealedBundle, MosaicCryptoError> {
    let recipient_signing_pub = IdentitySigningPublicKey::from_bytes(recipient_ed25519_pub)?;
    let recipient_x25519_pub = recipient_signing_pub.encryption_public_key()?;

    let bundle_json = encode_bundle_json(bundle);

    let mut rng = MosaicSealRng;
    let recipient_box_pub = BoxPublicKey::from(*recipient_x25519_pub.as_bytes());
    let sealed = recipient_box_pub
        .seal(&mut rng, bundle_json.as_slice())
        .map_err(|_| MosaicCryptoError::AuthenticationFailed)?;

    let mut to_sign = Vec::with_capacity(BUNDLE_SIGN_CONTEXT.len() + sealed.len());
    to_sign.extend_from_slice(BUNDLE_SIGN_CONTEXT);
    to_sign.extend_from_slice(&sealed);

    let signature = sign_manifest_with_identity(&to_sign, owner_identity.secret_key());

    Ok(SealedBundle {
        sealed,
        signature: *signature.as_bytes(),
        sharer_pubkey: *owner_identity.signing_public_key().as_bytes(),
    })
}

/// Verify the signature on a sealed bundle and decrypt it for the recipient.
///
/// Verification proceeds in this order:
/// 1. Validate the sharer pubkey against `expected.expected_owner_ed25519_pub`.
/// 2. Verify the detached Ed25519 signature over `BUNDLE_SIGN_CONTEXT || sealed`.
/// 3. Open the sealed box with the recipient's X25519 secret derived from
///    `my_identity`.
/// 4. Parse the JSON payload and apply album/epoch/recipient validation.
///
/// # Errors
/// See the [`MosaicCryptoError`] variants prefixed with `Bundle*` for
/// the full failure surface; each is mapped one-to-one to a specific
/// validation step listed above.
pub fn verify_and_open_bundle(
    sealed: &SealedBundle,
    my_identity: &IdentityKeypair,
    expected: &BundleValidationContext,
) -> Result<EpochKeyBundle, MosaicCryptoError> {
    if sealed.sharer_pubkey != expected.expected_owner_ed25519_pub {
        return Err(MosaicCryptoError::BundleSignatureInvalid);
    }

    let signing_public_key = IdentitySigningPublicKey::from_bytes(&sealed.sharer_pubkey)
        .map_err(|_| MosaicCryptoError::BundleSignatureInvalid)?;
    let signature = IdentitySignature::from_bytes(&sealed.signature)
        .map_err(|_| MosaicCryptoError::BundleSignatureInvalid)?;

    let mut to_verify = Vec::with_capacity(BUNDLE_SIGN_CONTEXT.len() + sealed.sealed.len());
    to_verify.extend_from_slice(BUNDLE_SIGN_CONTEXT);
    to_verify.extend_from_slice(&sealed.sealed);

    if !verify_manifest_identity_signature(&to_verify, &signature, &signing_public_key) {
        return Err(MosaicCryptoError::BundleSignatureInvalid);
    }

    let plaintext = open_sealed_box(&sealed.sealed, my_identity)?;

    let wire: WireBundle = serde_json::from_slice(plaintext.as_slice())
        .map_err(|_| MosaicCryptoError::BundleJsonParse)?;

    if wire.album_id.is_empty() {
        if !expected.allow_legacy_empty_album_id {
            return Err(MosaicCryptoError::BundleAlbumIdEmpty);
        }
    } else if wire.album_id != expected.album_id {
        return Err(MosaicCryptoError::BundleAlbumIdMismatch);
    }

    if wire.epoch_id < expected.min_epoch_id {
        return Err(MosaicCryptoError::BundleEpochTooOld);
    }

    let recipient_pubkey =
        decode_fixed_base64url::<ED25519_PUBLIC_KEY_BYTES>(&wire.recipient_pubkey)
            .ok_or(MosaicCryptoError::BundleJsonParse)?;
    if &recipient_pubkey != my_identity.signing_public_key().as_bytes() {
        return Err(MosaicCryptoError::BundleRecipientMismatch);
    }

    let mut epoch_seed_bytes = decode_fixed_base64url_zeroizing::<SEED_BYTES>(&wire.epoch_seed)
        .ok_or(MosaicCryptoError::BundleJsonParse)?;
    let epoch_seed = SecretKey::from_bytes(&mut epoch_seed_bytes[..])
        .map_err(|_| MosaicCryptoError::BundleJsonParse)?;

    let sign_public_key_bytes =
        decode_fixed_base64url::<ED25519_PUBLIC_KEY_BYTES>(&wire.sign_keypair.public_key)
            .ok_or(MosaicCryptoError::BundleJsonParse)?;
    let sign_public_key = ManifestSigningPublicKey::from_bytes(&sign_public_key_bytes)
        .map_err(|_| MosaicCryptoError::BundleJsonParse)?;

    let sign_secret_full_bytes = decode_fixed_base64url_zeroizing::<SIGN_KEYPAIR_SECRET_BYTES>(
        &wire.sign_keypair.secret_key,
    )
    .ok_or(MosaicCryptoError::BundleJsonParse)?;
    let trailing_pubkey: [u8; ED25519_PUBLIC_KEY_BYTES] = sign_secret_full_bytes
        [SEED_BYTES..SIGN_KEYPAIR_SECRET_BYTES]
        .try_into()
        .map_err(|_| MosaicCryptoError::BundleJsonParse)?;
    if &trailing_pubkey != sign_public_key.as_bytes() {
        return Err(MosaicCryptoError::BundleJsonParse);
    }
    let mut sign_secret_seed = Zeroizing::new([0_u8; SEED_BYTES]);
    sign_secret_seed.copy_from_slice(&sign_secret_full_bytes[..SEED_BYTES]);
    drop(sign_secret_full_bytes);

    let sign_secret_key = ManifestSigningSecretKey::from_seed(&mut sign_secret_seed[..])
        .map_err(|_| MosaicCryptoError::BundleJsonParse)?;

    Ok(EpochKeyBundle {
        version: wire.version,
        album_id: wire.album_id,
        epoch_id: wire.epoch_id,
        recipient_pubkey,
        epoch_seed,
        sign_secret_key,
        sign_public_key,
    })
}

fn open_sealed_box(
    sealed: &[u8],
    my_identity: &IdentityKeypair,
) -> Result<Zeroizing<Vec<u8>>, MosaicCryptoError> {
    let secret_bytes: Zeroizing<[u8; X25519_KEY_BYTES]> =
        my_identity.secret_key().x25519_secret_bytes();
    let recipient_secret = BoxSecretKey::from(*secret_bytes);
    let plaintext = recipient_secret
        .unseal(sealed)
        .map_err(|_| MosaicCryptoError::BundleSealOpenFailed)?;
    drop(recipient_secret);
    drop(secret_bytes);

    Ok(Zeroizing::new(plaintext))
}

fn encode_bundle_json(bundle: &EpochKeyBundle) -> Zeroizing<Vec<u8>> {
    let recipient_pubkey_b64 = base64url_no_pad(&bundle.recipient_pubkey);
    let epoch_seed_b64 = base64url_no_pad(bundle.epoch_seed.as_bytes());
    let sign_public_b64 = base64url_no_pad(bundle.sign_public_key.as_bytes());

    let mut sign_secret_combined = Zeroizing::new([0_u8; SIGN_KEYPAIR_SECRET_BYTES]);
    sign_secret_combined[..SEED_BYTES].copy_from_slice(bundle.sign_secret_key.seed_bytes());
    sign_secret_combined[SEED_BYTES..].copy_from_slice(bundle.sign_public_key.as_bytes());
    let sign_secret_b64 = base64url_no_pad(sign_secret_combined.as_ref());

    let json = format!(
        "{{\"version\":{version},\"albumId\":{album},\"epochId\":{epoch},\"recipientPubkey\":\"{recipient}\",\"epochSeed\":\"{seed}\",\"signKeypair\":{{\"publicKey\":\"{spk}\",\"secretKey\":\"{ssk}\"}}}}",
        version = bundle.version,
        album = json_string_literal(&bundle.album_id),
        epoch = bundle.epoch_id,
        recipient = recipient_pubkey_b64,
        seed = epoch_seed_b64,
        spk = sign_public_b64,
        ssk = sign_secret_b64,
    );

    Zeroizing::new(json.into_bytes())
}

fn json_string_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            ch if (ch as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", ch as u32));
            }
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn decode_fixed_base64url<const N: usize>(input: &str) -> Option<[u8; N]> {
    let mut out = [0_u8; N];
    decode_base64url_into(input, &mut out)?;
    Some(out)
}

fn decode_fixed_base64url_zeroizing<const N: usize>(input: &str) -> Option<Zeroizing<[u8; N]>> {
    let mut out = Zeroizing::new([0_u8; N]);
    decode_base64url_into(input, &mut out[..])?;
    Some(out)
}

fn decode_base64url_into(input: &str, out: &mut [u8]) -> Option<()> {
    let bytes = input.as_bytes();
    if bytes.contains(&b'=') {
        return None;
    }
    let expected_len = out.len();
    let expected_chars = (expected_len * 4).div_ceil(3);
    if bytes.len() != expected_chars {
        return None;
    }

    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut written: usize = 0;
    for &b in bytes {
        let value = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            if written >= expected_len {
                return None;
            }
            out[written] = ((acc >> bits) & 0xFF) as u8;
            written += 1;
        }
    }
    if written != expected_len {
        return None;
    }
    let leftover_mask: u32 = (1_u32 << bits).wrapping_sub(1);
    if (acc & leftover_mask) != 0 {
        return None;
    }
    Some(())
}

struct MosaicSealRng;

impl RngCore for MosaicSealRng {
    fn next_u32(&mut self) -> u32 {
        impls::next_u32_via_fill(self)
    }

    fn next_u64(&mut self) -> u64 {
        impls::next_u64_via_fill(self)
    }

    fn fill_bytes(&mut self, dest: &mut [u8]) {
        if let Err(error) = self.try_fill_bytes(dest) {
            // RngCore::fill_bytes cannot return an error and the seal API
            // calls it with no escape hatch. Failing closed protects against
            // silently producing predictable ephemeral keys.
            panic!("Mosaic crypto seal CSPRNG failure: {error:?}");
        }
    }

    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), RandError> {
        getrandom::fill(dest).map_err(|_| {
            // Any non-zero u32 satisfies rand_core::Error::from. CUSTOM_START
            // is by definition non-zero (its top bit is set), so the fallback
            // branch is unreachable in practice but keeps the lint happy.
            let code = NonZeroU32::new(rand_core::Error::CUSTOM_START).unwrap_or(NonZeroU32::MIN);
            RandError::from(code)
        })
    }
}

impl CryptoRng for MosaicSealRng {}
