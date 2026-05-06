//! Sidecar PAKE handshake (SPAKE2 over Ed25519 group).
//!
//! # ADR (inline)
//!
//! **Choice:** `spake2 = "0.4.0"` (RustCrypto org, MIT/Apache, last released
//! 2023, used by Magic Wormhole, builds on `curve25519-dalek` already in our
//! workspace lockfile).
//!
//! **Survey results:**
//! - `spake2 0.4.0` (chosen) - mature, audited transitively via curve25519-dalek,
//!   compiles to wasm32-unknown-unknown via the `getrandom` v0.4 feature flag
//!   we already enable workspace-wide. Provides deterministic
//!   `start_*_with_rng()` constructors that let us pin test vectors without
//!   patching the crate.
//! - `spake2 0.5.0-pre.0` - rejected (pre-release; API unstable).
//! - `spake2-conflux 0.6.0` - rejected (smaller user base, single maintainer).
//! - `cpace_ristretto255` (interstellar-network) - rejected (CPace is younger
//!   than SPAKE2 in the wild and the Rust impl has fewer downstream users).
//! - `pakery-spake2` 0.2.0 - rejected (unaudited, single contributor).
//!
//! **Protocol (`mosaic.sidecar.v1`):**
//! 1. Initiator -> Responder: `Msg1` (32 bytes; SPAKE2 A->B element).
//! 2. Responder -> Initiator: `Msg2` (32 bytes; SPAKE2 B->A element) **and**
//!    `ResponderConfirm` (32-byte HMAC-SHA256 over the transcript hash, keyed
//!    by `responder-confirm` sub-key).
//! 3. Initiator -> Responder: `InitiatorConfirm` (same shape, `initiator-confirm` sub-key).
//!
//! Confirm messages provide explicit key-confirmation, harden the protocol
//! against transcript tampering by a malicious signaling server, and let each
//! side fail fast (`ConfirmationFailed`) instead of falling through to AEAD
//! open errors deep in the data path.
//!
//! Both PAKE state structs zeroize their inner SPAKE2 state and the derived
//! 32-byte session secret on drop via [`zeroize::ZeroizeOnDrop`] proxies.
//!
//! # Logging policy (ZK-safe)
//! No `Debug` impl on this module emits pairing-code digits, transcript
//! bytes, SPAKE2 messages, or session-key material. Tests that need raw
//! bytes use the explicit `as_bytes()` accessors and never go through
//! `format!("{:?}", ...)`.

use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand_core::{CryptoRng, RngCore};
use sha2::Sha256;
use spake2::{Ed25519Group, Identity, Password, Spake2};
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use super::errors::SidecarError;
use super::{
    DOMAIN_TAG, PAIRING_CODE_DIGITS, PAKE_MESSAGE_BYTES, SESSION_SECRET_BYTES, TUNNEL_KEY_BYTES,
};

type HmacSha256 = Hmac<Sha256>;

/// Length of a PAKE message on the wire.
pub const MSG_BYTES: usize = PAKE_MESSAGE_BYTES;
/// Length of a key-confirmation tag on the wire.
pub const CONFIRM_BYTES: usize = 32;

/// SPAKE2 identity for the initiator role (visible peer name).
const IDENTITY_INITIATOR: &[u8] = b"mosaic.sidecar.v1.initiator";
/// SPAKE2 identity for the responder role.
const IDENTITY_RESPONDER: &[u8] = b"mosaic.sidecar.v1.responder";
/// HKDF info for the responder confirm sub-key.
const CONFIRM_RESPONDER_INFO: &[u8] = b"mosaic.sidecar.v1.responder-confirm";
/// HKDF info for the initiator confirm sub-key.
const CONFIRM_INITIATOR_INFO: &[u8] = b"mosaic.sidecar.v1.initiator-confirm";
/// HKDF info for the tunnel-key seed (mixed with side-specific info inside the tunnel module).
const TUNNEL_SEED_INFO: &[u8] = b"mosaic.sidecar.v1.tunnel-seed";
/// HKDF salt across all confirm/tunnel derivations - binds derivations to the protocol version.
const HKDF_SALT: &[u8] = DOMAIN_TAG;

/// First wire message (initiator -> responder).
#[derive(Clone, PartialEq, Eq)]
pub struct Msg1(pub(crate) [u8; MSG_BYTES]);
/// Second wire message (responder -> initiator).
#[derive(Clone, PartialEq, Eq)]
pub struct Msg2(pub(crate) [u8; MSG_BYTES]);
/// Key-confirmation tag (either direction; same byte shape).
#[derive(Clone, PartialEq, Eq)]
pub struct Confirm(pub(crate) [u8; CONFIRM_BYTES]);

impl Msg1 {
    /// Borrow the wire bytes.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; MSG_BYTES] {
        &self.0
    }
    /// Parse from a wire slice.
    pub fn from_slice(bytes: &[u8]) -> Result<Self, SidecarError> {
        let arr = <[u8; MSG_BYTES]>::try_from(bytes).map_err(|_| {
            SidecarError::InvalidPakeMessageLength {
                actual: bytes.len(),
            }
        })?;
        Ok(Self(arr))
    }
}

impl Msg2 {
    /// Borrow the wire bytes.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; MSG_BYTES] {
        &self.0
    }
    /// Parse from a wire slice.
    pub fn from_slice(bytes: &[u8]) -> Result<Self, SidecarError> {
        let arr = <[u8; MSG_BYTES]>::try_from(bytes).map_err(|_| {
            SidecarError::InvalidPakeMessageLength {
                actual: bytes.len(),
            }
        })?;
        Ok(Self(arr))
    }
}

impl Confirm {
    /// Borrow the wire bytes.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; CONFIRM_BYTES] {
        &self.0
    }
    /// Parse from a wire slice.
    pub fn from_slice(bytes: &[u8]) -> Result<Self, SidecarError> {
        let arr = <[u8; CONFIRM_BYTES]>::try_from(bytes).map_err(|_| {
            SidecarError::InvalidPakeMessageLength {
                actual: bytes.len(),
            }
        })?;
        Ok(Self(arr))
    }
}

// ZK-safe Debug: never print bytes.
impl core::fmt::Debug for Msg1 {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Msg1").field("len", &MSG_BYTES).finish()
    }
}
impl core::fmt::Debug for Msg2 {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Msg2").field("len", &MSG_BYTES).finish()
    }
}
impl core::fmt::Debug for Confirm {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Confirm")
            .field("len", &CONFIRM_BYTES)
            .finish()
    }
}

/// Tunnel-key material derived from the PAKE session secret.
///
/// Holds the raw HKDF "tunnel seed" (32 bytes); per-direction sub-keys are
/// derived inside [`super::tunnel::open_tunnel`] so this struct can be
/// transferred between handshake and tunnel without intermediate exposure
/// of the four sub-keys.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct TunnelKeyMaterial {
    pub(crate) seed: [u8; TUNNEL_KEY_BYTES],
    pub(crate) role: TunnelRoleTag,
}

/// Role tag carried alongside the tunnel-key material.
///
/// The PAKE side stamps this so a caller cannot accidentally open a tunnel
/// with the wrong role and produce silent key-direction inversion.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Zeroize)]
pub enum TunnelRoleTag {
    Initiator,
    Responder,
}

impl TunnelKeyMaterial {
    /// Tunnel-side role tag stamped at PAKE finish.
    #[must_use]
    pub fn role(&self) -> TunnelRoleTag {
        self.role
    }
    /// Length of the underlying tunnel seed (always [`crate::sidecar::TUNNEL_KEY_BYTES`]).
    #[must_use]
    pub fn seed_len(&self) -> usize {
        self.seed.len()
    }
}

/// Borrow the raw tunnel seed bytes.
///
/// SECURITY: this is exposed for test-vector parity only; production code
/// MUST hand the [`TunnelKeyMaterial`] directly to [`crate::sidecar::open_tunnel`]
/// (which consumes it and zeroizes the seed on drop).
impl TunnelKeyMaterial {
    /// Borrow the raw tunnel seed bytes (32 bytes).
    #[must_use]
    pub fn seed_for_tests(&self) -> &[u8] {
        &self.seed
    }
}

impl core::fmt::Debug for TunnelKeyMaterial {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("TunnelKeyMaterial")
            .field("role", &self.role)
            .field("seed_len", &TUNNEL_KEY_BYTES)
            .finish()
    }
}

/// Initiator handshake state. Holds the in-flight SPAKE2 instance and the
/// transcript bytes accumulated so far.
pub struct PakeInitiator {
    spake: Option<Spake2<Ed25519Group>>,
    transcript: TranscriptHasher,
}

/// Responder handshake state. Carries the derived session secret and the
/// pending responder confirm tag; only releases [`TunnelKeyMaterial`] after
/// verifying the initiator's confirm.
pub struct PakeResponder {
    session: Zeroizing<[u8; SESSION_SECRET_BYTES]>,
    transcript_hash: [u8; 32],
    responder_confirm: Confirm,
}

impl core::fmt::Debug for PakeInitiator {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("PakeInitiator").finish()
    }
}
impl core::fmt::Debug for PakeResponder {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("PakeResponder").finish()
    }
}

/// SHA-256 transcript binder. Accumulates the bytes of the PAKE wire messages
/// in the canonical order so both sides commit to the same transcript hash.
struct TranscriptHasher {
    hasher: sha2::Sha256,
}

impl TranscriptHasher {
    fn new() -> Self {
        use sha2::Digest;
        let mut hasher = sha2::Sha256::new();
        hasher.update(DOMAIN_TAG);
        Self { hasher }
    }
    fn absorb(&mut self, bytes: &[u8]) {
        use sha2::Digest;
        // Length-prefix each segment to remove any chance of canonical-form
        // ambiguity (e.g. two short messages vs one long).
        let len = u32::try_from(bytes.len()).unwrap_or(u32::MAX);
        self.hasher.update(len.to_be_bytes());
        self.hasher.update(bytes);
    }
    fn finalize(self) -> [u8; 32] {
        use sha2::Digest;
        let out = self.hasher.finalize();
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&out);
        arr
    }
}

/// Validate a 6-digit pairing code and reduce it to ASCII bytes.
fn pairing_code_password(code: &[u8]) -> Result<Zeroizing<Vec<u8>>, SidecarError> {
    if code.len() != PAIRING_CODE_DIGITS {
        return Err(SidecarError::InvalidPairingCodeLength { actual: code.len() });
    }
    // Domain-tag the password input so a code reused in some other Mosaic
    // protocol cannot collide with the sidecar PAKE password.
    let mut buf: Vec<u8> = Vec::with_capacity(DOMAIN_TAG.len() + 1 + PAIRING_CODE_DIGITS);
    buf.extend_from_slice(DOMAIN_TAG);
    buf.push(b':');
    buf.extend_from_slice(code);
    Ok(Zeroizing::new(buf))
}

/// Begin the initiator side of the handshake.
pub fn pake_initiator_start_with_rng<R: RngCore + CryptoRng>(
    code: &[u8],
    rng: &mut R,
) -> Result<(PakeInitiator, Msg1), SidecarError> {
    let password = pairing_code_password(code)?;
    let (spake, msg) = Spake2::<Ed25519Group>::start_a_with_rng(
        &Password::new(password.as_slice()),
        &Identity::new(IDENTITY_INITIATOR),
        &Identity::new(IDENTITY_RESPONDER),
        rng,
    );
    let msg_arr = <[u8; MSG_BYTES]>::try_from(msg.as_slice())
        .map_err(|_| SidecarError::InvalidPakeMessageLength { actual: msg.len() })?;
    let mut transcript = TranscriptHasher::new();
    transcript.absorb(&msg_arr);
    Ok((
        PakeInitiator {
            spake: Some(spake),
            transcript,
        },
        Msg1(msg_arr),
    ))
}

/// Convenience: begin the initiator side using OS randomness via [`getrandom`].
pub fn pake_initiator_start(code: &[u8]) -> Result<(PakeInitiator, Msg1), SidecarError> {
    let mut rng = GetrandomRng;
    pake_initiator_start_with_rng(code, &mut rng)
}

/// Run the responder half: consume the initiator's `Msg1`, produce `Msg2` and
/// the responder's confirm tag, and stash partial state until the initiator's
/// confirm arrives.
pub fn pake_responder_with_rng<R: RngCore + CryptoRng>(
    code: &[u8],
    msg1: &Msg1,
    rng: &mut R,
) -> Result<(PakeResponder, Msg2, Confirm), SidecarError> {
    let password = pairing_code_password(code)?;
    let (spake, msg2_bytes) = Spake2::<Ed25519Group>::start_b_with_rng(
        &Password::new(password.as_slice()),
        &Identity::new(IDENTITY_INITIATOR),
        &Identity::new(IDENTITY_RESPONDER),
        rng,
    );
    let msg2_arr = <[u8; MSG_BYTES]>::try_from(msg2_bytes.as_slice()).map_err(|_| {
        SidecarError::InvalidPakeMessageLength {
            actual: msg2_bytes.len(),
        }
    })?;

    let session_vec = spake
        .finish(msg1.as_bytes().as_slice())
        .map_err(|_| SidecarError::PakeFailed)?;
    let session_arr = <[u8; SESSION_SECRET_BYTES]>::try_from(session_vec.as_slice())
        .map_err(|_| SidecarError::PakeFailed)?;
    let session = Zeroizing::new(session_arr);

    let mut transcript = TranscriptHasher::new();
    transcript.absorb(msg1.as_bytes());
    transcript.absorb(&msg2_arr);
    let transcript_hash = transcript.finalize();

    let responder_confirm = derive_confirm(&session, &transcript_hash, CONFIRM_RESPONDER_INFO)?;

    Ok((
        PakeResponder {
            session,
            transcript_hash,
            responder_confirm: responder_confirm.clone(),
        },
        Msg2(msg2_arr),
        responder_confirm,
    ))
}

/// Convenience: run the responder using OS randomness via [`getrandom`].
pub fn pake_responder(
    code: &[u8],
    msg1: &Msg1,
) -> Result<(PakeResponder, Msg2, Confirm), SidecarError> {
    let mut rng = GetrandomRng;
    pake_responder_with_rng(code, msg1, &mut rng)
}

/// Tiny `RngCore + CryptoRng` adapter over [`getrandom::getrandom`].
///
/// Avoids a second `rand_core` feature/version split (the workspace pins
/// `getrandom = 0.4`; enabling `rand_core/getrandom` would pull in 0.2 as
/// well). On `wasm32`, the workspace's `wasm_js` feature wires this into
/// `crypto.getRandomValues`.
struct GetrandomRng;

impl RngCore for GetrandomRng {
    fn next_u32(&mut self) -> u32 {
        let mut buf = [0u8; 4];
        self.fill_bytes(&mut buf);
        u32::from_le_bytes(buf)
    }
    fn next_u64(&mut self) -> u64 {
        let mut buf = [0u8; 8];
        self.fill_bytes(&mut buf);
        u64::from_le_bytes(buf)
    }
    fn fill_bytes(&mut self, dest: &mut [u8]) {
        require_getrandom_success(getrandom::fill(dest));
    }
    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rand_core::Error> {
        // Stable nonzero opaque code; we deliberately do not surface the
        // upstream `getrandom` error code to avoid leaking platform details
        // through telemetry/logs.
        getrandom::fill(dest).map_err(|_| {
            #[allow(clippy::expect_used)]
            let code = core::num::NonZeroU32::new(rand_core::Error::CUSTOM_START)
                .expect("CUSTOM_START is nonzero by construction");
            rand_core::Error::from(code)
        })
    }
}

fn require_getrandom_success(result: Result<(), getrandom::Error>) {
    // SECURITY: SPAKE2 draws its secret scalar through `RngCore::fill_bytes`.
    // Continuing after an OS CSPRNG failure can leave an all-zero scalar and
    // expose the pairing code to offline dictionary attacks. `RngCore` requires
    // fill-or-panic semantics here, so fail closed instead of producing bytes.
    #[allow(clippy::expect_used)]
    result.expect("OS CSPRNG failed while generating SPAKE2 scalar");
}

impl CryptoRng for GetrandomRng {}

impl PakeInitiator {
    /// Finish the initiator side: consume `Msg2`, verify the responder's
    /// confirm tag, and emit our own confirm + tunnel material.
    pub fn finish(
        mut self,
        msg2: &Msg2,
        responder_confirm: &Confirm,
    ) -> Result<(TunnelKeyMaterial, Confirm), SidecarError> {
        let spake = self.spake.take().ok_or(SidecarError::PakeFailed)?;
        let session_vec = spake
            .finish(msg2.as_bytes().as_slice())
            .map_err(|_| SidecarError::PakeFailed)?;
        let session_arr = <[u8; SESSION_SECRET_BYTES]>::try_from(session_vec.as_slice())
            .map_err(|_| SidecarError::PakeFailed)?;
        let session = Zeroizing::new(session_arr);

        self.transcript.absorb(msg2.as_bytes());
        let transcript_hash = self.transcript.finalize();

        let expected_responder =
            derive_confirm(&session, &transcript_hash, CONFIRM_RESPONDER_INFO)?;
        if expected_responder
            .as_bytes()
            .ct_eq(responder_confirm.as_bytes())
            .unwrap_u8()
            != 1
        {
            return Err(SidecarError::ConfirmationFailed);
        }
        let initiator_confirm = derive_confirm(&session, &transcript_hash, CONFIRM_INITIATOR_INFO)?;
        let seed = derive_tunnel_seed(&session, &transcript_hash)?;
        Ok((
            TunnelKeyMaterial {
                seed,
                role: TunnelRoleTag::Initiator,
            },
            initiator_confirm,
        ))
    }
}

impl PakeResponder {
    /// The tag this responder advertises (also returned from `pake_responder`).
    #[must_use]
    pub fn confirm_message(&self) -> Confirm {
        self.responder_confirm.clone()
    }

    /// Finish the responder side after receiving the initiator's confirm.
    pub fn finish(self, initiator_confirm: &Confirm) -> Result<TunnelKeyMaterial, SidecarError> {
        let expected_initiator =
            derive_confirm(&self.session, &self.transcript_hash, CONFIRM_INITIATOR_INFO)?;
        if expected_initiator
            .as_bytes()
            .ct_eq(initiator_confirm.as_bytes())
            .unwrap_u8()
            != 1
        {
            return Err(SidecarError::ConfirmationFailed);
        }
        let seed = derive_tunnel_seed(&self.session, &self.transcript_hash)?;
        Ok(TunnelKeyMaterial {
            seed,
            role: TunnelRoleTag::Responder,
        })
    }
}

/// HKDF-SHA256(salt = DOMAIN_TAG, ikm = session, info = label) -> 32 bytes,
/// then HMAC-SHA256(sub-key, transcript_hash) -> Confirm.
fn derive_confirm(
    session: &[u8; SESSION_SECRET_BYTES],
    transcript_hash: &[u8; 32],
    label: &[u8],
) -> Result<Confirm, SidecarError> {
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), session.as_slice());
    let mut sub = Zeroizing::new([0u8; 32]);
    hk.expand(label, sub.as_mut_slice())
        .map_err(|_| SidecarError::KdfFailure)?;
    let mut mac = <HmacSha256 as Mac>::new_from_slice(sub.as_slice())
        .map_err(|_| SidecarError::KdfFailure)?;
    mac.update(transcript_hash);
    let tag = mac.finalize().into_bytes();
    let mut out = [0u8; CONFIRM_BYTES];
    out.copy_from_slice(&tag[..CONFIRM_BYTES]);
    Ok(Confirm(out))
}

fn derive_tunnel_seed(
    session: &[u8; SESSION_SECRET_BYTES],
    transcript_hash: &[u8; 32],
) -> Result<[u8; TUNNEL_KEY_BYTES], SidecarError> {
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), session.as_slice());
    let mut info: Vec<u8> = Vec::with_capacity(TUNNEL_SEED_INFO.len() + transcript_hash.len());
    info.extend_from_slice(TUNNEL_SEED_INFO);
    info.extend_from_slice(transcript_hash);
    let mut out = [0u8; TUNNEL_KEY_BYTES];
    hk.expand(&info, &mut out)
        .map_err(|_| SidecarError::KdfFailure)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[should_panic(expected = "OS CSPRNG failed while generating SPAKE2 scalar")]
    fn getrandom_failure_panics_before_scalar_generation() {
        require_getrandom_success(Err(getrandom::Error::new_custom(7)));
    }
}
