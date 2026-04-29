//! Targeted tests that kill mutation-testing survivors that are not covered by
//! the broader behavioral test suites. Each test is anchored to specific lines
//! in `crates/mosaic-crypto/src/lib.rs` and is intentionally low-level: it
//! asserts byte-exact, capacity-exact, or distribution-exact properties so a
//! single-character source mutation observably changes the result.

use mosaic_crypto::{
    AUTH_CHALLENGE_CONTEXT, build_auth_challenge_transcript, generate_identity_seed,
};

const CHALLENGE: [u8; 32] = [
    0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
    0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf,
];

// --- Section 3: build_auth_challenge_transcript capacity ---

#[test]
fn auth_transcript_capacity_matches_exact_formula_with_timestamp() {
    let username = "alice";
    let transcript = match build_auth_challenge_transcript(username, Some(123_456_789), &CHALLENGE)
    {
        Ok(value) => value,
        Err(error) => panic!("auth transcript should build: {error:?}"),
    };

    // Original formula:
    //   AUTH_CHALLENGE_CONTEXT.len() + 4 + username_bytes.len() + timestamp_len + 32
    // For "alice" + Some(timestamp) + 32-byte challenge:
    //   24 + 4 + 5 + 8 + 32 = 73
    let expected_capacity = AUTH_CHALLENGE_CONTEXT.len() + 4 + username.len() + 8 + 32;
    assert_eq!(expected_capacity, 73);

    // Vec<u8>::with_capacity(n) on the default allocator returns exactly `n`
    // for sizes in this range. If any additive term in the capacity formula is
    // mutated, the requested capacity differs and the post-extend capacity
    // will not equal expected_capacity (either reallocated to a larger value
    // or kept at the wrong larger value).
    assert_eq!(transcript.len(), expected_capacity);
    assert_eq!(transcript.capacity(), expected_capacity);
}

#[test]
fn auth_transcript_capacity_matches_exact_formula_without_timestamp() {
    let username = "alice";
    let transcript = match build_auth_challenge_transcript(username, None, &CHALLENGE) {
        Ok(value) => value,
        Err(error) => panic!("auth transcript without timestamp should build: {error:?}"),
    };

    // Without timestamp: timestamp_len = 0
    //   24 + 4 + 5 + 0 + 32 = 65
    let timestamp_len: usize = 0;
    let expected_capacity = AUTH_CHALLENGE_CONTEXT.len() + 4 + username.len() + timestamp_len + 32;
    assert_eq!(expected_capacity, 65);
    assert_eq!(transcript.len(), expected_capacity);
    assert_eq!(transcript.capacity(), expected_capacity);
}

#[test]
fn auth_transcript_capacity_matches_exact_formula_for_long_username() {
    // 256-byte username (policy max) exposes overflow-shaped mutations that
    // pass with short usernames (e.g. `*` with timestamp_len silently produces
    // a different but still plausibly-sized capacity).
    let username = "a".repeat(256);
    let transcript = match build_auth_challenge_transcript(&username, Some(u64::MAX), &CHALLENGE) {
        Ok(value) => value,
        Err(error) => panic!("auth transcript with long username should build: {error:?}"),
    };

    // 24 + 4 + 256 + 8 + 32 = 324
    let expected_capacity = AUTH_CHALLENGE_CONTEXT.len() + 4 + username.len() + 8 + 32;
    assert_eq!(expected_capacity, 324);
    assert_eq!(transcript.len(), expected_capacity);
    assert_eq!(transcript.capacity(), expected_capacity);
}

// --- Section 3: generate_identity_seed ---

#[test]
fn generate_identity_seed_returns_distinct_random_bytes_per_call() {
    // Catches survivors that return a fixed array (e.g. `[0; 32]` or `[1; 32]`).
    let first = match generate_identity_seed() {
        Ok(value) => value,
        Err(error) => panic!("first identity seed should generate: {error:?}"),
    };
    let second = match generate_identity_seed() {
        Ok(value) => value,
        Err(error) => panic!("second identity seed should generate: {error:?}"),
    };

    assert_eq!(first.len(), 32);
    assert_eq!(second.len(), 32);
    // Two consecutive seeds must differ for any random source.
    assert_ne!(*first, *second);

    // Eliminate the specific [0; 32] and [1; 32] constant-array survivors even
    // if (effectively impossibly) two RNG draws happened to collide.
    assert!(
        !first.iter().all(|byte| *byte == 0),
        "fresh identity seed must not be all-zero",
    );
    assert!(
        !first.iter().all(|byte| *byte == 1),
        "fresh identity seed must not be all-one",
    );
    assert!(
        !second.iter().all(|byte| *byte == 0),
        "fresh identity seed must not be all-zero",
    );
    assert!(
        !second.iter().all(|byte| *byte == 1),
        "fresh identity seed must not be all-one",
    );
}
