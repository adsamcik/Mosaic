//! Cross-platform sidecar AEAD tunnel vectors.
//!
//! Pins the byte-level wire format for the seal/open frame so the TS facade
//! cannot drift. Only relies on public sidecar APIs.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use mosaic_crypto::sidecar::{
    SidecarError, TunnelKeyMaterial, open_tunnel,
    pake_initiator_start_with_rng, pake_responder_with_rng,
};
use rand_core::{CryptoRng, Error as RandError, RngCore, SeedableRng};

/// (Same RNG as the PAKE vectors test - inlined to keep the test crates
/// independent.)
struct DeterministicRng {
    state: [u8; 32],
    counter: u64,
    buf: [u8; 64],
    buf_pos: usize,
}

impl DeterministicRng {
    fn new(seed: [u8; 32]) -> Self {
        Self { state: seed, counter: 0, buf: [0u8; 64], buf_pos: 64 }
    }
    fn refill(&mut self) {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(b"mosaic.sidecar.test.rng");
        h.update(self.state);
        h.update(self.counter.to_be_bytes());
        let a = h.finalize_reset();
        h.update(b"mosaic.sidecar.test.rng");
        h.update(self.state);
        h.update((self.counter + 1).to_be_bytes());
        let b = h.finalize();
        self.buf[..32].copy_from_slice(&a);
        self.buf[32..].copy_from_slice(&b);
        self.counter = self.counter.wrapping_add(2);
        self.buf_pos = 0;
    }
}
impl SeedableRng for DeterministicRng {
    type Seed = [u8; 32];
    fn from_seed(seed: Self::Seed) -> Self { Self::new(seed) }
}
impl RngCore for DeterministicRng {
    fn next_u32(&mut self) -> u32 { let mut b=[0;4]; self.fill_bytes(&mut b); u32::from_le_bytes(b) }
    fn next_u64(&mut self) -> u64 { let mut b=[0;8]; self.fill_bytes(&mut b); u64::from_le_bytes(b) }
    fn fill_bytes(&mut self, dest: &mut [u8]) {
        for byte in dest.iter_mut() {
            if self.buf_pos >= self.buf.len() { self.refill(); }
            *byte = self.buf[self.buf_pos];
            self.buf_pos += 1;
        }
    }
    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), RandError> { self.fill_bytes(dest); Ok(()) }
}
impl CryptoRng for DeterministicRng {}

const SEED_INITIATOR: [u8; 32] = [1; 32];
const SEED_RESPONDER: [u8; 32] = [2; 32];
const CODE: &[u8; 6] = b"039184";

fn complete_handshake() -> (TunnelKeyMaterial, TunnelKeyMaterial) {
    let mut a = DeterministicRng::from_seed(SEED_INITIATOR);
    let mut b = DeterministicRng::from_seed(SEED_RESPONDER);
    let (init, msg1) = pake_initiator_start_with_rng(CODE, &mut a).unwrap();
    let (resp, msg2, c_b) = pake_responder_with_rng(CODE, &msg1, &mut b).unwrap();
    let (mat_a, c_a) = init.finish(&msg2, &c_b).unwrap();
    let mat_b = resp.finish(&c_a).unwrap();
    (mat_a, mat_b)
}

#[test]
fn duplex_roundtrip() {
    let (mat_i, mat_r) = complete_handshake();
    let (mut send_i, mut recv_i) = open_tunnel(mat_i);
    let (mut send_r, mut recv_r) = open_tunnel(mat_r);

    // Initiator -> Responder.
    let plain = b"hello sidecar";
    let sealed = send_i.seal(plain).unwrap();
    let opened = recv_r.open(&sealed).unwrap();
    assert_eq!(opened, plain);

    // Responder -> Initiator (separate flow direction, different sub-key).
    let plain2 = b"echo back";
    let sealed2 = send_r.seal(plain2).unwrap();
    let opened2 = recv_i.open(&sealed2).unwrap();
    assert_eq!(opened2, plain2);
}

#[test]
fn cross_zip_subkey_separation() {
    // A frame sealed by initiator's send key MUST NOT decrypt with the
    // initiator's recv key (which == responder's send key).
    let (mat_i, _mat_r) = complete_handshake();
    let (mut send_i, mut recv_i) = open_tunnel(mat_i);

    let sealed = send_i.seal(b"separation check").unwrap();
    let err = recv_i
        .open(&sealed)
        .expect_err("opening own send-frame on own recv side must fail");
    assert_eq!(err, SidecarError::TunnelDecryptFailed);
}

#[test]
fn nonce_counter_advances_each_seal() {
    let (mat_i, mat_r) = complete_handshake();
    let (mut send_i, _) = open_tunnel(mat_i);
    let (_, mut recv_r) = open_tunnel(mat_r);

    let mut prev_prefix: Option<[u8; 8]> = None;
    for i in 0..100u32 {
        let plain = i.to_be_bytes();
        let sealed = send_i.seal(&plain).unwrap();
        let mut prefix = [0u8; 8];
        prefix.copy_from_slice(&sealed[..8]);
        // Counter prefix is a strictly increasing big-endian u64.
        if let Some(prev) = prev_prefix {
            assert!(u64::from_be_bytes(prefix) > u64::from_be_bytes(prev));
        }
        prev_prefix = Some(prefix);
        let opened = recv_r.open(&sealed).unwrap();
        assert_eq!(opened, plain);
    }
    assert_eq!(send_i.counter(), 100);
    assert_eq!(recv_r.next_counter(), 100);
}

#[test]
fn tampered_ciphertext_rejected() {
    let (mat_i, mat_r) = complete_handshake();
    let (mut send_i, _) = open_tunnel(mat_i);
    let (_, mut recv_r) = open_tunnel(mat_r);

    let mut sealed = send_i.seal(b"don't tamper with me").unwrap();
    // Flip a byte inside the ciphertext (after the 8-byte counter prefix).
    let pos = 12;
    sealed[pos] ^= 0x80;
    let err = recv_r.open(&sealed).expect_err("tamper must fail");
    assert_eq!(err, SidecarError::TunnelDecryptFailed);
}

#[test]
fn truncated_frame_rejected() {
    let (mat_i, mat_r) = complete_handshake();
    let (mut send_i, _) = open_tunnel(mat_i);
    let (_, mut recv_r) = open_tunnel(mat_r);

    let sealed = send_i.seal(b"short").unwrap();
    let trunc = &sealed[..10]; // < 8 prefix + 16 tag = 24
    let err = recv_r.open(trunc).expect_err("truncated must fail");
    assert_eq!(err, SidecarError::TruncatedFrame);
}

#[test]
fn out_of_order_frame_rejected() {
    let (mat_i, mat_r) = complete_handshake();
    let (mut send_i, _) = open_tunnel(mat_i);
    let (_, mut recv_r) = open_tunnel(mat_r);

    let s0 = send_i.seal(b"frame zero").unwrap();
    let s1 = send_i.seal(b"frame one").unwrap();
    // Skip s0; deliver s1 first.
    let err = recv_r.open(&s1).expect_err("out-of-order");
    assert_eq!(err, SidecarError::OutOfOrderFrame);
    // The strict in-order recv tunnel will not advance after a rejected
    // frame; delivering s0 next succeeds.
    let opened0 = recv_r.open(&s0).unwrap();
    assert_eq!(opened0, b"frame zero");
}

#[test]
fn replayed_frame_rejected() {
    let (mat_i, mat_r) = complete_handshake();
    let (mut send_i, _) = open_tunnel(mat_i);
    let (_, mut recv_r) = open_tunnel(mat_r);

    let s0 = send_i.seal(b"once").unwrap();
    let _ = recv_r.open(&s0).unwrap();
    let err = recv_r.open(&s0).expect_err("replay");
    assert_eq!(err, SidecarError::OutOfOrderFrame);
}

#[test]
fn wire_layout_is_counter_prefix_plus_ciphertext_tag() {
    let (mat_i, _mat_r) = complete_handshake();
    let (mut send_i, _) = open_tunnel(mat_i);
    let plain = vec![0xABu8; 64];
    let sealed = send_i.seal(&plain).unwrap();
    // 8-byte counter + 64-byte ciphertext + 16-byte Poly1305 tag.
    assert_eq!(sealed.len(), 8 + 64 + 16);
    // Counter is zero on the first frame.
    assert_eq!(&sealed[..8], &[0u8; 8]);
}
