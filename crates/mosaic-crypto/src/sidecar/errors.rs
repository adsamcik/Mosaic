//! Sidecar Beacon error types.
//!
//! Cross-device WebRTC download handoff: PAKE handshake + AEAD tunnel over
//! the data channel. Logs MUST NEVER include key material, transcript bytes,
//! pairing-code digits, or peer identity strings.

use core::fmt;

/// Errors raised by the sidecar PAKE + tunnel modules.
///
/// Variants are deliberately coarse - refining them further would risk leaking
/// timing/state information about the password or shared secret to a
/// network-level attacker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidecarError {
    /// Pairing code byte length must be exactly [`crate::sidecar::PAIRING_CODE_DIGITS`].
    InvalidPairingCodeLength { actual: usize },
    /// SPAKE2 message had an unexpected wire length.
    InvalidPakeMessageLength { actual: usize },
    /// SPAKE2 finish failed (curve point invalid, low-order, etc.). Rolls up
    /// every spake2 internal error so callers cannot timing-distinguish them.
    PakeFailed,
    /// Key-confirmation MAC mismatch.
    ConfirmationFailed,
    /// AEAD open failed (wrong key, tampered ciphertext, wrong AAD).
    TunnelDecryptFailed,
    /// Sealed frame is shorter than the 8-byte counter prefix + 16-byte tag.
    TruncatedFrame,
    /// Sealed frame's counter prefix does not match the expected next counter
    /// (reordering, replay, or drop on the wire). v1 enforces strict in-order
    /// delivery; relaxing this is a future protocol revision.
    OutOfOrderFrame,
    /// Per-direction nonce counter exhausted. Operationally unreachable.
    NonceOverflow,
    /// Internal HKDF/HMAC failure (length mismatch).
    KdfFailure,
}

impl fmt::Display for SidecarError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPairingCodeLength { actual } => {
                write!(f, "invalid sidecar pairing-code length: {actual}")
            }
            Self::InvalidPakeMessageLength { actual } => {
                write!(f, "invalid sidecar PAKE message length: {actual}")
            }
            Self::PakeFailed => f.write_str("sidecar PAKE handshake failed"),
            Self::ConfirmationFailed => f.write_str("sidecar PAKE confirmation failed"),
            Self::TunnelDecryptFailed => f.write_str("sidecar tunnel decryption failed"),
            Self::TruncatedFrame => f.write_str("sidecar tunnel frame truncated"),
            Self::OutOfOrderFrame => f.write_str("sidecar tunnel frame out of order"),
            Self::NonceOverflow => f.write_str("sidecar tunnel nonce counter exhausted"),
            Self::KdfFailure => f.write_str("sidecar KDF/HMAC failure"),
        }
    }
}
