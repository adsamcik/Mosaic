//! Sidecar Beacon: cross-device WebRTC download handoff.
//!
//! Phase 4A delivers the cryptographic foundations only:
//! - PAKE handshake ([`pake`]) backed by `spake2` 0.4 (Ed25519 group),
//!   wrapping a 6-digit pairing code into a 32-byte session secret.
//! - AEAD tunnel ([`tunnel`]) using XChaCha20-Poly1305 with HKDF-derived
//!   per-flow-direction sub-keys and counter-based nonces.
//!
//! No WebRTC, no signaling, no UI is exposed here. The browser/web app and
//! native clients consume this module via the `mosaic-wasm` handle facade.
//!
//! All key-bearing structs implement zeroize-on-drop. ZK-safe Debug impls in
//! every public type elide bytes; logs that hit a `Debug` formatter for any
//! sidecar value cannot leak key material, transcript bytes, or the pairing
//! code.
//!
//! # Sub-key cross-zip
//! The protocol carries two flow directions over the data channel:
//! initiator->responder and responder->initiator. We derive **one HKDF
//! sub-key per direction** so that on the wire `K_initiator_send` is byte-
//! identical to `K_responder_recv` (and vice versa) -- this is the only
//! arrangement that lets both sides AEAD-decrypt each other's frames.
//! Spec'ing four labels (initiator-send / initiator-recv / responder-send /
//! responder-recv) would force two labels to collide, so we instead use two
//! flow-direction labels (`i2r` / `r2i`) and document the role->direction
//! mapping inside [`tunnel::open_tunnel`].

pub mod errors;
pub mod pake;
pub mod tunnel;

pub use errors::SidecarError;
pub use pake::{
    Confirm, Msg1, Msg2, PakeInitiator, PakeResponder, TunnelKeyMaterial, TunnelRoleTag,
    pake_initiator_start, pake_initiator_start_with_rng, pake_responder, pake_responder_with_rng,
};
pub use tunnel::{
    COUNTER_PREFIX_BYTES, FRAME_TAG_BYTES, RecvTunnel, SendTunnel, TunnelRole, open_tunnel,
};

/// Protocol version tag - included in HKDF salt + transcript prefix + AEAD AAD.
pub const DOMAIN_TAG: &[u8] = b"mosaic.sidecar.v1";

/// 8-byte nonce prefix.
///
/// Built from the first 8 bytes of [`DOMAIN_TAG`].
pub const NONCE_DOMAIN_PREFIX: &[u8; 8] = b"mosaic.s";

/// 6-digit pairing code length (decimal ASCII bytes).
pub const PAIRING_CODE_DIGITS: usize = 6;

/// Wire length of a SPAKE2-Ed25519 message element.
pub const PAKE_MESSAGE_BYTES: usize = 33;

/// Length of a SPAKE2-Ed25519 session secret.
pub const SESSION_SECRET_BYTES: usize = 32;

/// Length of every PAKE/tunnel sub-key.
pub const TUNNEL_KEY_BYTES: usize = 32;

/// HKDF info label for the initiator-to-responder flow direction.
///
/// Used as `K_initiator_send` on the initiator side and `K_responder_recv`
/// on the responder side. The two roles MUST derive the same bytes here.
pub const TUNNEL_SUBKEY_I2R_INFO: &[u8] = b"mosaic.sidecar.v1.i2r";

/// HKDF info label for the responder-to-initiator flow direction.
pub const TUNNEL_SUBKEY_R2I_INFO: &[u8] = b"mosaic.sidecar.v1.r2i";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonce_prefix_is_eight_bytes() {
        assert_eq!(NONCE_DOMAIN_PREFIX.len(), 8);
    }

    #[test]
    fn flow_labels_distinct() {
        assert_ne!(TUNNEL_SUBKEY_I2R_INFO, TUNNEL_SUBKEY_R2I_INFO);
    }
}
