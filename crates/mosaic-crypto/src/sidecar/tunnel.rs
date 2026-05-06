//! Sidecar AEAD tunnel.
//!
//! Wraps the WebRTC data channel with XChaCha20-Poly1305. Each direction has
//! its own 32-byte sub-key derived from [`super::pake::TunnelKeyMaterial`] via
//! HKDF-SHA256 with role-specific labels:
//!
//! - `K_initiator_send` = K_responder_recv
//! - `K_responder_send` = K_initiator_recv
//!
//! Nonce strategy: each direction maintains a `u64` counter starting at 0.
//! The 24-byte XChaCha20 nonce is `domain_tag(8) || counter(16-byte big-endian)`.
//! Using a 16-byte big-endian counter (the high 8 bytes are always zero in
//! v1) future-proofs the wire format.
//!
//! Frame layout on the wire:
//! ```text
//! offset 0  .. 8   counter (u64 big-endian)
//! offset 8  .. n   ciphertext + 16-byte Poly1305 tag
//! ```
//!
//! Strict in-order delivery: `RecvTunnel::open` rejects any frame whose
//! counter does not match the expected next value. Out-of-order or replayed
//! frames return [`SidecarError::OutOfOrderFrame`]. WebRTC's reliable+ordered
//! data channel mode is the assumed transport.

use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

use super::errors::SidecarError;
use super::pake::{TunnelKeyMaterial, TunnelRoleTag};
use super::{
    DOMAIN_TAG, NONCE_DOMAIN_PREFIX, TUNNEL_KEY_BYTES, TUNNEL_SUBKEY_I2R_INFO,
    TUNNEL_SUBKEY_R2I_INFO,
};

/// Role for [`open_tunnel`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TunnelRole {
    Initiator,
    Responder,
}

impl From<TunnelRoleTag> for TunnelRole {
    fn from(tag: TunnelRoleTag) -> Self {
        match tag {
            TunnelRoleTag::Initiator => TunnelRole::Initiator,
            TunnelRoleTag::Responder => TunnelRole::Responder,
        }
    }
}

/// Length of the per-frame counter prefix on the wire.
pub const COUNTER_PREFIX_BYTES: usize = 8;
/// AEAD tag length appended after each frame's ciphertext.
pub const FRAME_TAG_BYTES: usize = 16;

/// Sender half of a sidecar tunnel.
pub struct SendTunnel {
    key: Zeroizing<[u8; TUNNEL_KEY_BYTES]>,
    counter: u64,
}

/// Receiver half of a sidecar tunnel.
pub struct RecvTunnel {
    key: Zeroizing<[u8; TUNNEL_KEY_BYTES]>,
    next_counter: u64,
}

impl core::fmt::Debug for SendTunnel {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("SendTunnel")
            .field("counter", &self.counter)
            .finish()
    }
}
impl core::fmt::Debug for RecvTunnel {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("RecvTunnel")
            .field("next_counter", &self.next_counter)
            .finish()
    }
}

impl Drop for SendTunnel {
    fn drop(&mut self) {
        // Zeroizing<[u8;_]> handles the buffer; explicit zeroize for paranoia.
        self.key.zeroize();
    }
}
impl Drop for RecvTunnel {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

/// Open a duplex sidecar tunnel from PAKE-derived material. Consumes
/// `material` so the caller cannot accidentally hold the seed past the
/// derivation.
#[must_use]
pub fn open_tunnel(material: TunnelKeyMaterial) -> (SendTunnel, RecvTunnel) {
    // Role -> flow-direction mapping (cross-zip):
    //   Initiator sends on i2r, recvs on r2i.
    //   Responder sends on r2i, recvs on i2r.
    let (send_label, recv_label) = match material.role {
        TunnelRoleTag::Initiator => (TUNNEL_SUBKEY_I2R_INFO, TUNNEL_SUBKEY_R2I_INFO),
        TunnelRoleTag::Responder => (TUNNEL_SUBKEY_R2I_INFO, TUNNEL_SUBKEY_I2R_INFO),
    };
    let send_key = derive_subkey(&material.seed, send_label);
    let recv_key = derive_subkey(&material.seed, recv_label);
    (
        SendTunnel {
            key: Zeroizing::new(send_key),
            counter: 0,
        },
        RecvTunnel {
            key: Zeroizing::new(recv_key),
            next_counter: 0,
        },
    )
    // material is dropped here -> seed is zeroized by ZeroizeOnDrop.
}

fn derive_subkey(seed: &[u8; TUNNEL_KEY_BYTES], label: &[u8]) -> [u8; TUNNEL_KEY_BYTES] {
    let hk = Hkdf::<Sha256>::new(Some(DOMAIN_TAG), seed.as_slice());
    let mut out = [0u8; TUNNEL_KEY_BYTES];
    // Length here is fixed; expand never errors for 32-byte output.
    let _ = hk.expand(label, &mut out);
    out
}

fn build_nonce(counter: u64) -> [u8; 24] {
    let mut nonce = [0u8; 24];
    nonce[..NONCE_DOMAIN_PREFIX.len()].copy_from_slice(NONCE_DOMAIN_PREFIX);
    // Counter occupies the trailing 16 bytes; high 8 bytes are zero in v1.
    let counter_bytes = counter.to_be_bytes();
    nonce[24 - 8..].copy_from_slice(&counter_bytes);
    nonce
}

impl SendTunnel {
    /// Encrypt `plaintext`. Returns `counter(8) || ciphertext+tag`.
    pub fn seal(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, SidecarError> {
        if self.counter == u64::MAX {
            return Err(SidecarError::NonceOverflow);
        }
        let counter = self.counter;
        let nonce_bytes = build_nonce(counter);
        let aead = XChaCha20Poly1305::new_from_slice(self.key.as_slice())
            .map_err(|_| SidecarError::KdfFailure)?;
        let nonce = XNonce::from_slice(&nonce_bytes);
        let ct = aead
            .encrypt(
                nonce,
                Payload {
                    msg: plaintext,
                    aad: DOMAIN_TAG,
                },
            )
            .map_err(|_| SidecarError::KdfFailure)?;
        // Reserve and assemble. Counter prefix is plain on the wire so the
        // receiver can reconstruct the nonce; integrity is provided by AEAD.
        let mut out = Vec::with_capacity(COUNTER_PREFIX_BYTES + ct.len());
        out.extend_from_slice(&counter.to_be_bytes());
        out.extend_from_slice(&ct);
        // Best-effort wipe of the ephemeral ciphertext buffer.
        let mut ct_owned = ct;
        ct_owned.zeroize();
        self.counter = counter.wrapping_add(1);
        Ok(out)
    }

    /// Peek the next counter without advancing.
    #[must_use]
    pub fn counter(&self) -> u64 {
        self.counter
    }
}

impl RecvTunnel {
    /// Decrypt a wire frame. Strict in-order; replays/reorders are rejected.
    pub fn open(&mut self, sealed: &[u8]) -> Result<Vec<u8>, SidecarError> {
        if sealed.len() < COUNTER_PREFIX_BYTES + FRAME_TAG_BYTES {
            return Err(SidecarError::TruncatedFrame);
        }
        let mut counter_arr = [0u8; COUNTER_PREFIX_BYTES];
        counter_arr.copy_from_slice(&sealed[..COUNTER_PREFIX_BYTES]);
        let counter = u64::from_be_bytes(counter_arr);
        if counter != self.next_counter {
            return Err(SidecarError::OutOfOrderFrame);
        }
        let nonce_bytes = build_nonce(counter);
        let aead = XChaCha20Poly1305::new_from_slice(self.key.as_slice())
            .map_err(|_| SidecarError::KdfFailure)?;
        let nonce = XNonce::from_slice(&nonce_bytes);
        let pt = aead
            .decrypt(
                nonce,
                Payload {
                    msg: &sealed[COUNTER_PREFIX_BYTES..],
                    aad: DOMAIN_TAG,
                },
            )
            .map_err(|_| SidecarError::TunnelDecryptFailed)?;
        if self.next_counter == u64::MAX {
            return Err(SidecarError::NonceOverflow);
        }
        self.next_counter = self.next_counter.wrapping_add(1);
        Ok(pt)
    }

    /// Peek the next expected counter.
    #[must_use]
    pub fn next_counter(&self) -> u64 {
        self.next_counter
    }
}
