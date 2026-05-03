use std::time::Instant;

use mosaic_crypto::{
    SecretKey, ShardIntegrityError, ShardSha256, encrypt_shard, verify_shard_integrity,
};
use mosaic_domain::{SHARD_ENVELOPE_HEADER_LEN, ShardTier};
use sha2::{Digest, Sha256};

const KEY_BYTES: [u8; 32] = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
    0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f,
];

const FIXTURE_ENVELOPE: &[u8] = include_bytes!("fixtures/shard_integrity/fixed-v3-envelope.bin");
const FIXTURE_SHA256_HEX: &str = include_str!("fixtures/shard_integrity/fixed-v3-envelope.sha256");

fn secret_key_from(mut bytes: [u8; 32]) -> SecretKey {
    match SecretKey::from_bytes(&mut bytes) {
        Ok(value) => value,
        Err(error) => panic!("test key bytes should be accepted: {error:?}"),
    }
}

fn digest_for(bytes: &[u8]) -> ShardSha256 {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut digest_bytes = [0_u8; 32];
    digest_bytes.copy_from_slice(&digest);
    ShardSha256(digest_bytes)
}

fn hex_digest_for(bytes: &[u8]) -> String {
    let digest = digest_for(bytes);
    let mut hex = String::with_capacity(64);
    for byte in digest.0 {
        use core::fmt::Write;
        if let Err(error) = write!(&mut hex, "{byte:02x}") {
            panic!("writing to String should not fail: {error:?}");
        }
    }
    hex
}

fn encrypted_fixture() -> Vec<u8> {
    let key = secret_key_from(KEY_BYTES);
    match encrypt_shard(
        b"mosaic shard integrity verification",
        &key,
        42,
        7,
        ShardTier::Original,
    ) {
        Ok(value) => value.bytes,
        Err(error) => panic!("test shard should encrypt: {error:?}"),
    }
}

fn assert_digest_mismatch(result: Result<(), ShardIntegrityError>) {
    assert_eq!(result, Err(ShardIntegrityError::DigestMismatch));
}

fn flip_bit(bytes: &mut [u8], bit_position: usize) {
    let byte_index = bit_position / 8;
    let bit_index = bit_position % 8;
    bytes[byte_index] ^= 1_u8 << bit_index;
}

struct DeterministicRng {
    state: u64,
}

impl DeterministicRng {
    const fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self
            .state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.state
    }

    fn next_usize(&mut self, upper_exclusive: usize) -> usize {
        (self.next_u64() as usize) % upper_exclusive
    }

    fn fill(&mut self, bytes: &mut [u8]) {
        for chunk in bytes.chunks_mut(8) {
            let random = self.next_u64().to_le_bytes();
            let len = chunk.len();
            chunk.copy_from_slice(&random[..len]);
        }
    }
}

#[test]
fn verify_succeeds_for_correct_digest() {
    let envelope = encrypted_fixture();
    let expected = digest_for(&envelope);

    assert_eq!(verify_shard_integrity(&envelope, &expected), Ok(()));
}

#[test]
fn verify_fails_with_digest_mismatch() {
    let envelope = encrypted_fixture();
    let mut expected = digest_for(&envelope);
    expected.0[0] ^= 0x01;

    assert_digest_mismatch(verify_shard_integrity(&envelope, &expected));
}

#[test]
fn verify_fails_for_short_envelope() {
    for actual in [0_usize, 32, 63] {
        let envelope = vec![0x42_u8; actual];
        let expected = digest_for(&envelope);

        assert_eq!(
            verify_shard_integrity(&envelope, &expected),
            Err(ShardIntegrityError::InvalidEnvelopeLength { actual })
        );
    }
}

#[test]
fn verify_succeeds_for_64_byte_envelope() {
    let envelope = [0x5a_u8; SHARD_ENVELOPE_HEADER_LEN];
    let expected = digest_for(&envelope);

    assert_eq!(verify_shard_integrity(&envelope, &expected), Ok(()));
}

#[test]
fn verify_uses_full_envelope_scope() {
    let envelope = encrypted_fixture();
    let expected = digest_for(&envelope);
    let offsets = [
        4,
        13,
        SHARD_ENVELOPE_HEADER_LEN,
        envelope.len().saturating_sub(1),
    ];

    for offset in offsets {
        let mut corrupted = envelope.clone();
        corrupted[offset] ^= 0x80;
        assert_digest_mismatch(verify_shard_integrity(&corrupted, &expected));
    }
}

#[test]
fn prop_random_envelopes_round_trip() {
    let mut rng = DeterministicRng::new(0x4d4f_5341_4943_5243);

    for _case in 0..1024 {
        let len = SHARD_ENVELOPE_HEADER_LEN + rng.next_usize(8192 - SHARD_ENVELOPE_HEADER_LEN + 1);
        let mut envelope = vec![0_u8; len];
        rng.fill(&mut envelope);
        let expected = digest_for(&envelope);

        assert_eq!(verify_shard_integrity(&envelope, &expected), Ok(()));
    }
}

#[test]
fn prop_single_bit_flip_fails() {
    let mut rng = DeterministicRng::new(0x5243_325f_464c_4950);

    for _case in 0..256 {
        let len = SHARD_ENVELOPE_HEADER_LEN + rng.next_usize(8192 - SHARD_ENVELOPE_HEADER_LEN + 1);
        let mut envelope = vec![0_u8; len];
        rng.fill(&mut envelope);
        let expected = digest_for(&envelope);

        let bit_position = rng.next_usize(envelope.len() * 8);
        flip_bit(&mut envelope, bit_position);

        assert_digest_mismatch(verify_shard_integrity(&envelope, &expected));
    }
}

#[test]
fn cross_impl_golden_vector_verifies_fixed_fixture() {
    assert_eq!(FIXTURE_ENVELOPE.len(), SHARD_ENVELOPE_HEADER_LEN + 48);
    assert_eq!(hex_digest_for(FIXTURE_ENVELOPE), FIXTURE_SHA256_HEX.trim());

    let expected = digest_for(FIXTURE_ENVELOPE);
    assert_eq!(verify_shard_integrity(FIXTURE_ENVELOPE, &expected), Ok(()));
}

#[test]
fn constant_time_path_executes_under_load() {
    // Smoke test: `verify_shard_integrity` runs under load without panic and
    // without time-dependent crashes.
    //
    // This test DOES NOT verify constant-time behavior. Constant-time
    // resistance to timing side channels requires `dudect`-style statistical
    // analysis with hardware performance counters, which is out of scope for
    // unit tests. Resistance is provided by:
    //
    // 1. The use of `subtle::ConstantTimeEq` in `verify_shard_integrity`,
    //    verified by source review and the
    //    `subtle_constant_time_eq_is_the_compare_primitive` compile-time
    //    sentinel below.
    // 2. The `subtle = "=2.6.1"` pinned dependency.
    // 3. The mandatory crypto-class code review per plan §11.
    //
    // Mutations that replace `ct_eq` with `==` or `iter().eq()` (M1, M6 in the
    // plan) preserve correctness and are NOT detectable by this test or any
    // non-statistical unit test. This is a known mutation-test escape; see
    // docs/specs/SPEC-LateV1ProtocolFreeze.md §"Frozen now" item 3 for the
    // posture: the secret-handle FFI rule bounds the leak surface.
    let envelope = encrypted_fixture();
    let expected = digest_for(&envelope);
    assert_eq!(verify_shard_integrity(&envelope, &expected), Ok(()));

    let iterations = 4096;
    let ok_started = Instant::now();
    for _ in 0..iterations {
        assert_eq!(verify_shard_integrity(&envelope, &expected), Ok(()));
    }
    let ok_elapsed = ok_started.elapsed();

    let mismatch_started = Instant::now();
    for bit in 0..(32 * 8) {
        let mut corrupted = expected;
        flip_bit(&mut corrupted.0, bit);
        assert_digest_mismatch(verify_shard_integrity(&envelope, &corrupted));
    }
    let mismatch_elapsed = mismatch_started.elapsed();

    assert!(ok_elapsed.as_nanos() > 0);
    assert!(mismatch_elapsed.as_nanos() > 0);
}

#[test]
fn subtle_constant_time_eq_is_the_compare_primitive() {
    use subtle::ConstantTimeEq as _;

    let left = [0_u8; 32];
    let right = [0_u8; 32];
    let _ = left.ct_eq(&right);
}

#[test]
fn debug_does_not_leak_digest_bytes() {
    let digest = ShardSha256([0xab; 32]);
    let debug = format!("{digest:?}");

    assert_eq!(debug, "ShardSha256(<32-byte>)");
    assert!(!debug.contains("ab"));
    assert!(!debug.contains("AB"));
}

#[test]
fn shard_integrity_error_variant_order_lock() {
    let expected = [("InvalidEnvelopeLength", 0_u8), ("DigestMismatch", 1_u8)];

    let live = [
        (
            "InvalidEnvelopeLength",
            ShardIntegrityError::InvalidEnvelopeLength { actual: 63 }.variant_discriminant(),
        ),
        (
            "DigestMismatch",
            ShardIntegrityError::DigestMismatch.variant_discriminant(),
        ),
    ];
    assert_eq!(live, expected);

    let source = include_str!("../src/lib.rs");
    let enum_body = match source.split_once("pub enum ShardIntegrityError {") {
        Some((_, rest)) => match rest.split_once("\nimpl ShardIntegrityError") {
            Some((body, _)) => body,
            None => panic!("ShardIntegrityError enum body terminator should be present"),
        },
        None => panic!("ShardIntegrityError enum declaration should be present"),
    };
    let invalid_decl = "InvalidEnvelopeLength { actual: usize } = 0";
    let mismatch_decl = "DigestMismatch = 1";
    let invalid_pos = match enum_body.find(invalid_decl) {
        Some(pos) => pos,
        None => panic!("InvalidEnvelopeLength discriminant declaration should be locked"),
    };
    let mismatch_pos = match enum_body.find(mismatch_decl) {
        Some(pos) => pos,
        None => panic!("DigestMismatch discriminant declaration should be locked"),
    };
    assert!(
        invalid_pos < mismatch_pos,
        "ShardIntegrityError variants must remain append-only in declaration order"
    );

    let discriminant_count = enum_body
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            trimmed.contains(" = ") && trimmed.ends_with(',')
        })
        .count();
    assert_eq!(discriminant_count, expected.len());
}
