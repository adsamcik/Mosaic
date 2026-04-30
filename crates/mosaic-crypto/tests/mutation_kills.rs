//! Targeted tests that kill mutation-testing survivors that are not covered by
//! the broader behavioral test suites. Each test is anchored to specific lines
//! in the `crates/mosaic-crypto/src/*.rs` sources and is intentionally
//! low-level: it asserts byte-exact, capacity-exact, or distribution-exact
//! properties so a single-character source mutation observably changes the
//! result.

use mosaic_crypto::{
    AUTH_CHALLENGE_CONTEXT, BundleValidationContext, EpochKeyBundle, IdentityKeypair, KdfProfile,
    MIN_KDF_ITERATIONS, MIN_KDF_MEMORY_KIB, ManifestSigningPublicKey, ManifestSigningSecretKey,
    MosaicCryptoError, SecretKey, build_auth_challenge_transcript, crate_name,
    derive_auth_signing_keypair, derive_identity_keypair, encrypt_content, encrypt_shard,
    generate_identity_seed, seal_and_sign_bundle, sha256_bytes, sign_auth_challenge,
    verify_and_open_bundle, verify_auth_challenge, wrap_key,
};
use mosaic_domain::ShardTier;
use zeroize::Zeroizing;

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

// --- Section 4: MIN_KDF_MEMORY_KIB constant value ---
//
// `MIN_KDF_MEMORY_KIB` is gated on the `weak-kdf` Cargo feature. Each
// branch is its own mutation site:
//   * `lib.rs:51:40` (production): `64 * 1024` -> `+` gives 1088, `/` gives 0.
//   * `lib.rs:60:39` (weak-kdf):   `8 * 1024`  -> `+` gives 1032.
// Pinning the exact KiB value catches every operator mutation.

#[test]
#[cfg(not(feature = "weak-kdf"))]
fn min_kdf_memory_kib_production_equals_64_mib() {
    // 64 MiB expressed in KiB: 64 * 1024 = 65_536. Asserting on the
    // *value* rather than the formula prevents the test itself from
    // moving in lockstep with a `*` -> `+` mutation in the source.
    assert_eq!(MIN_KDF_MEMORY_KIB, 65_536);
}

#[test]
#[cfg(feature = "weak-kdf")]
fn min_kdf_memory_kib_weak_equals_8_mib() {
    // 8 MiB expressed in KiB: 8 * 1024 = 8_192. With `*` -> `+` the
    // mutated constant would be 1_032 (still passes the < MIN guard for
    // most callers, so a downstream behavior test would not catch it),
    // so we anchor on the literal.
    assert_eq!(MIN_KDF_MEMORY_KIB, 8_192);
}

// --- Section 5: ManifestSigningSecretKey::expose_seed_bytes ---
//
// Mutants replace the body with `Vec::leak(Vec::new())` (empty),
// `Vec::leak(vec![0])` (single zero byte), and `Vec::leak(vec![1])`
// (single one byte). Pinning length AND content kills all three.

#[test]
fn manifest_signing_expose_seed_bytes_returns_constructor_seed_bytes() {
    // Distinct, non-trivial bytes so mutants returning `[0]`, `[1]`, or
    // an empty slice cannot accidentally match.
    let original: [u8; 32] = [
        0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc,
        0xfe, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
        0xff, 0x00,
    ];
    let mut seed = original;
    let secret = match ManifestSigningSecretKey::from_seed(&mut seed) {
        Ok(value) => value,
        Err(error) => panic!("32-byte manifest seed should be accepted: {error:?}"),
    };

    let exposed = secret.expose_seed_bytes();

    // Length pin kills `Vec::leak(Vec::new())` (len 0), `vec![0]` (len 1),
    // `vec![1]` (len 1).
    assert_eq!(exposed.len(), 32);
    // Byte-for-byte pin kills any constant-array variant even if its
    // length somehow matched.
    assert_eq!(exposed, &original[..]);
}

// --- Section 6: verify_auth_challenge positive path (feature-agnostic) ---
//
// Survivor: `lib.rs:1058:5 verify_auth_challenge -> bool with false`.
// The hex-pinned vectors in `tests/auth_challenge_signing.rs` are gated
// on `cfg(not(feature = "weak-kdf"))`, so under `weak-kdf` no positive
// path covers this function. Build the signature dynamically so the
// test runs under both feature configurations.

const AUTH_CHALLENGE_BYTES: [u8; 32] = [
    0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
    0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf,
];

#[test]
fn verify_auth_challenge_returns_true_for_freshly_signed_transcript() {
    // The minimum profile is feature-agnostic: it picks up whichever
    // (memory, iterations) pair is exposed by the active build.
    let profile = match KdfProfile::new(MIN_KDF_MEMORY_KIB, MIN_KDF_ITERATIONS, 1) {
        Ok(value) => value,
        Err(error) => panic!("minimum Mosaic KDF profile should be valid: {error:?}"),
    };

    let salt = [0x42_u8; 16];
    let keypair = match derive_auth_signing_keypair(
        Zeroizing::new(b"correct horse battery staple".to_vec()),
        &salt,
        profile,
    ) {
        Ok(value) => value,
        Err(error) => panic!("auth signing keypair should derive: {error:?}"),
    };

    let transcript =
        match build_auth_challenge_transcript("alice", Some(123_456_789), &AUTH_CHALLENGE_BYTES) {
            Ok(value) => value,
            Err(error) => panic!("auth challenge transcript should build: {error:?}"),
        };
    // Sanity-check that the transcript was actually populated with the
    // domain-separating context. If a future refactor accidentally returns
    // an empty buffer, this assertion fires before we reach verify().
    assert!(transcript.starts_with(AUTH_CHALLENGE_CONTEXT));

    let signature = sign_auth_challenge(&transcript, keypair.secret_key());

    // Mutating `verify_auth_challenge` to always return `false` flips
    // this assertion. The test does not depend on any pinned hex vector,
    // so it survives the `weak-kdf` gate that excludes the golden tests.
    assert!(verify_auth_challenge(
        &transcript,
        &signature,
        keypair.public_key(),
    ));
}

// --- Section 7: 100 MiB shard size boundary ---
//
// Survivors:
//   * `lib.rs:1362:19` `>` -> `==` / `>=` in `encrypt_shard`.
//   * `lib.rs:1452:48` `>` -> `==` / `>=` in `wrap_key`.
//   * `content.rs:68:24` `>` -> `>=` in `encrypt_content`.
// All three guard a `> MAX_SHARD_BYTES` boundary at exactly 100 MiB.
// Asserting that the function accepts a payload of length MAX_SHARD_BYTES
// and rejects MAX_SHARD_BYTES + 1 disambiguates `>`, `>=`, and `==`.
//
// The MAX_SHARD_BYTES literal is mirrored from `crates/mosaic-crypto/src/lib.rs`
// (it is a `const`, not `pub const`, so external tests must duplicate the
// value). Keep this in sync with the source.
const MAX_SHARD_BYTES_LOCAL: usize = 100 * 1024 * 1024;

fn boundary_secret_key(seed: u8) -> SecretKey {
    let mut bytes = [seed; 32];
    match SecretKey::from_bytes(&mut bytes) {
        Ok(value) => value,
        Err(error) => panic!("32-byte secret key should be accepted: {error:?}"),
    }
}

#[test]
fn encrypt_shard_accepts_exactly_max_shard_bytes() {
    // One 100 MiB allocation. Heap usage is acceptable for an integration
    // test; it mirrors the largest legitimate plaintext we expect to ship.
    let buffer = vec![0_u8; MAX_SHARD_BYTES_LOCAL];
    let key = boundary_secret_key(0x11);

    let result = encrypt_shard(&buffer, &key, 1, 0, ShardTier::Original);

    // `>` accepts MAX_SHARD_BYTES, `>=` rejects it (caught here),
    // `==` rejects it (caught here).
    assert!(
        result.is_ok(),
        "encrypt_shard at MAX_SHARD_BYTES must succeed; got {:?}",
        result.err(),
    );
}

#[test]
fn encrypt_shard_rejects_one_byte_over_max_shard_bytes() {
    let buffer = vec![0_u8; MAX_SHARD_BYTES_LOCAL + 1];
    let key = boundary_secret_key(0x12);

    let result = encrypt_shard(&buffer, &key, 1, 0, ShardTier::Original);

    // `>` rejects MAX_SHARD_BYTES + 1, `==` would *accept* it (only
    // exact-equality fails), so this catches the `>` -> `==` mutant.
    match result {
        Ok(_) => {
            panic!("encrypt_shard at MAX_SHARD_BYTES + 1 must return InvalidInputLength; got Ok(_)")
        }
        Err(MosaicCryptoError::InvalidInputLength { actual })
            if actual == MAX_SHARD_BYTES_LOCAL + 1 => {}
        Err(error) => panic!(
            "encrypt_shard at MAX_SHARD_BYTES + 1 must return InvalidInputLength; got {error:?}"
        ),
    }
}

#[test]
fn wrap_key_accepts_exactly_max_shard_bytes() {
    let buffer = vec![0_u8; MAX_SHARD_BYTES_LOCAL];
    let wrapper = boundary_secret_key(0x21);

    let result = wrap_key(&buffer, &wrapper);

    assert!(
        result.is_ok(),
        "wrap_key at MAX_SHARD_BYTES must succeed; got {:?}",
        result.err(),
    );
}

#[test]
fn wrap_key_rejects_one_byte_over_max_shard_bytes() {
    let buffer = vec![0_u8; MAX_SHARD_BYTES_LOCAL + 1];
    let wrapper = boundary_secret_key(0x22);

    let result = wrap_key(&buffer, &wrapper);

    // wrap_key returns Vec<u8>, which already implements Debug, but be
    // explicit for symmetry with the encrypt_shard/encrypt_content
    // boundary tests above.
    match result {
        Ok(_) => {
            panic!("wrap_key at MAX_SHARD_BYTES + 1 must return InvalidInputLength; got Ok(_)")
        }
        Err(MosaicCryptoError::InvalidInputLength { actual })
            if actual == MAX_SHARD_BYTES_LOCAL + 1 => {}
        Err(error) => {
            panic!("wrap_key at MAX_SHARD_BYTES + 1 must return InvalidInputLength; got {error:?}")
        }
    }
}

#[test]
fn encrypt_content_accepts_exactly_max_shard_bytes() {
    let buffer = vec![0_u8; MAX_SHARD_BYTES_LOCAL];
    let key = boundary_secret_key(0x31);

    let result = encrypt_content(&buffer, &key, 1);

    assert!(
        result.is_ok(),
        "encrypt_content at MAX_SHARD_BYTES must succeed; got {:?}",
        result.err(),
    );
}

#[test]
fn encrypt_content_rejects_one_byte_over_max_shard_bytes() {
    let buffer = vec![0_u8; MAX_SHARD_BYTES_LOCAL + 1];
    let key = boundary_secret_key(0x32);

    let result = encrypt_content(&buffer, &key, 1);

    match result {
        Ok(_) => panic!(
            "encrypt_content at MAX_SHARD_BYTES + 1 must return InvalidInputLength; got Ok(_)"
        ),
        Err(MosaicCryptoError::InvalidInputLength { actual })
            if actual == MAX_SHARD_BYTES_LOCAL + 1 => {}
        Err(error) => panic!(
            "encrypt_content at MAX_SHARD_BYTES + 1 must return InvalidInputLength; got {error:?}"
        ),
    }
}

// --- Section 8: base64url_no_pad pre-allocated capacity ---
//
// Survivor: `lib.rs:1519:28` `*` -> `+` / `/` in
// `base64url_no_pad`'s `(bytes.len() * 4).div_ceil(3)` capacity formula.
//
// `base64url_no_pad` is `pub(crate)`, so the test exercises it through
// its only public caller, `sha256_bytes`. SHA-256 always produces 32
// bytes, so the input length to `base64url_no_pad` is always 32 and the
// capacity formula evaluates to:
//   * original (`*`): (32 * 4).div_ceil(3) = 128.div_ceil(3) = 43.
//   * `*` -> `+`:     (32 + 4).div_ceil(3) =  36.div_ceil(3) = 12.
//   * `*` -> `/`:     (32 / 4).div_ceil(3) =   8.div_ceil(3) = 3.
//
// `base64url_no_pad` builds the result with `String::with_capacity(cap)`
// followed by `push` only. With cap=43 the string never reallocates and
// the final capacity is exactly 43. With cap=12 or cap=3 the push loop
// triggers `RawVec` doubling (each grow doubles or matches the requested
// length), so the post-encoding capacity is observably > 43.

#[test]
fn sha256_bytes_capacity_matches_exact_base64url_formula() {
    let digest = sha256_bytes(b"mosaic mutation kill #8");

    // Base64url without padding for 32 bytes is 43 ASCII characters
    // (10 full 3-byte chunks emit 4 chars each, plus a 2-byte tail
    // emitting 3 chars: 10 * 4 + 3 = 43).
    assert_eq!(digest.len(), 43);

    // RawVec with the system allocator on Windows/Linux/macOS reports
    // capacity exactly equal to the requested value when the allocation
    // is small (<= a few KiB) and the type is u8. If a future toolchain
    // change relaxes that, this assertion still catches the mutants
    // because the `+` / `/` mutants force at least one realloc whose
    // post-grow capacity is strictly greater than 43.
    assert_eq!(digest.capacity(), 43);
}

// --- Section 9: crate_name ---
//
// Survivors: `lib.rs:1549:5 crate_name -> ""` and `-> "xyzzy"`.

#[test]
fn crate_name_returns_exact_package_name() {
    assert_eq!(crate_name(), "mosaic-crypto");
}

// --- Section 10: MosaicSealRng nondeterminism via seal_and_sign_bundle ---
//
// Survivors: `sharing.rs:369..386` — the four `RngCore for MosaicSealRng`
// methods get replaced with constants (`0`, `1`), no-ops, or `Ok(())`.
// Each of these collapses the ephemeral key generation inside the
// libsodium-compatible sealed box, making `seal_and_sign_bundle` produce
// either identical ciphertext for identical inputs (constant RNG) or
// outright failure (uninitialised buffers).
//
// The assertion: two seal calls on identical bundles must produce
// distinct sealed bytes. Under the original RNG, the ephemeral X25519
// keypair is freshly random per call. Under a degenerate RNG, the
// ephemeral key is constant and so is the sealed payload.

fn seal_test_identity(seed_byte: u8) -> IdentityKeypair {
    let mut seed = [seed_byte; 32];
    match derive_identity_keypair(&mut seed) {
        Ok(value) => value,
        Err(error) => panic!("identity derivation failed: {error:?}"),
    }
}

fn seal_test_signing_pair(seed_byte: u8) -> (ManifestSigningSecretKey, ManifestSigningPublicKey) {
    let mut seed = [seed_byte ^ 0x5A; 32];
    let secret = match ManifestSigningSecretKey::from_seed(&mut seed) {
        Ok(value) => value,
        Err(error) => panic!("manifest signing seed rejected: {error:?}"),
    };
    let public = secret.public_key();
    (secret, public)
}

fn seal_test_secret_key(seed_byte: u8) -> SecretKey {
    let mut bytes = [seed_byte; 32];
    match SecretKey::from_bytes(&mut bytes) {
        Ok(value) => value,
        Err(error) => panic!("secret key construction failed: {error:?}"),
    }
}

fn seal_test_bundle(recipient: &IdentityKeypair, album_id: &str) -> EpochKeyBundle {
    let (sign_secret_key, sign_public_key) = seal_test_signing_pair(0x33);
    EpochKeyBundle {
        version: 1,
        album_id: album_id.into(),
        epoch_id: 7,
        recipient_pubkey: *recipient.signing_public_key().as_bytes(),
        epoch_seed: seal_test_secret_key(0xA5),
        sign_secret_key,
        sign_public_key,
    }
}

#[test]
fn seal_and_sign_bundle_produces_distinct_outputs_for_identical_bundles() {
    let owner = seal_test_identity(0x10);
    let recipient = seal_test_identity(0x20);

    let bundle_a = seal_test_bundle(&recipient, "album-rng-mutation");
    let bundle_b = seal_test_bundle(&recipient, "album-rng-mutation");

    let sealed_a =
        match seal_and_sign_bundle(&bundle_a, recipient.signing_public_key().as_bytes(), &owner) {
            Ok(value) => value,
            Err(error) => panic!("first seal_and_sign_bundle failed: {error:?}"),
        };
    let sealed_b =
        match seal_and_sign_bundle(&bundle_b, recipient.signing_public_key().as_bytes(), &owner) {
            Ok(value) => value,
            Err(error) => panic!("second seal_and_sign_bundle failed: {error:?}"),
        };

    // The sealed-box ciphertext is deterministic given the ephemeral
    // X25519 keypair. The keypair is generated from `MosaicSealRng`
    // inside `crypto_box::seal`. If `next_u32`/`next_u64` is replaced
    // with a constant, or `fill_bytes` becomes a no-op, the ephemeral
    // key collapses and both seals produce identical bytes.
    assert_ne!(sealed_a.sealed, sealed_b.sealed);
}

// --- Section 11: json_string_literal control-character escaping ---
//
// Survivors: `sharing.rs:299:19` (match guard `(ch as u32) < 0x20`
// replaced with `true` / `false`) and `sharing.rs:299:31` (`<` replaced
// with `==` / `>` / `<=`).
//
// `json_string_literal` is private to the `sharing` module. The only
// public surface that exercises it is `seal_and_sign_bundle`, which
// formats `bundle.album_id` directly into the bundle JSON.
//
// IMPORTANT: the mutated guard sits in the *last* match arm, so it only
// fires for control characters that are NOT already handled by the
// earlier `\n` / `\r` / `\t` / `\u{08}` / `\u{0c}` / `"` / `\\` arms.
// We must therefore probe with a control char like U+0001 (SOH) that
// reaches the guard. With U+000A the guard is dead code (caught by the
// preceding `'\n'` arm), and every mutant would survive trivially.
//
// Round-tripping a bundle whose `album_id` contains a U+0001 byte
// distinguishes three of the five mutants:
//
//   * `false` (always non-control): U+0001 is pushed raw, producing a
//     JSON string with an unescaped control byte. RFC 8259 §7 forbids
//     this, and `serde_json::from_slice` rejects it with a control-
//     character error, so `verify_and_open_bundle` returns
//     `BundleJsonParse` and the test panics on the open path.
//   * `< -> ==`: only U+0020 is escaped; U+0001 is pushed raw, same
//     parse failure.
//   * `< -> >`: U+0001 is < 0x20 so is *not* > 0x20; pushed raw, same
//     parse failure.
//
// Two mutants are equivalent and are documented (not tested):
//   * `true` (always control): every char goes through `\u{:04x}`,
//     producing valid JSON like `"\u0061\u006c..."` that parses back
//     to the original string. Round-trip succeeds.
//   * `< -> <=`: extends the escape predicate to also include U+0020.
//     Space is still emitted as `\u0020`, which decodes to the same
//     space character. Round-trip succeeds for any non-space control
//     character (and for U+0020 itself the encoding is just longer but
//     semantically equivalent).

#[test]
fn seal_and_sign_bundle_round_trips_album_id_with_below_0x20_control_character() {
    let owner = seal_test_identity(0x40);
    let recipient = seal_test_identity(0x50);

    // U+0001 (SOH) inside a JSON string MUST be escaped per RFC 8259 §7.
    // The original `< 0x20` guard escapes it as `\u0001`; the `false`,
    // `==`, and `>` mutants leave it raw, breaking JSON parsing on the
    // open path. SOH does not match any earlier arm, so the guard is
    // the sole code path that decides its fate.
    let album_id = "album-\u{0001}-soh";
    let bundle = seal_test_bundle(&recipient, album_id);

    let sealed =
        match seal_and_sign_bundle(&bundle, recipient.signing_public_key().as_bytes(), &owner) {
            Ok(value) => value,
            Err(error) => panic!("seal with control-char album_id failed: {error:?}"),
        };

    let context = BundleValidationContext {
        album_id: album_id.into(),
        min_epoch_id: 1,
        allow_legacy_empty_album_id: false,
        expected_owner_ed25519_pub: *owner.signing_public_key().as_bytes(),
    };

    let opened = match verify_and_open_bundle(&sealed, &recipient, &context) {
        Ok(value) => value,
        Err(error) => {
            panic!("control-char album_id must round-trip; open failed: {error:?}")
        }
    };

    // Parsed album_id must equal the original byte-for-byte. Any mutant
    // that drops the control-char escape produces invalid JSON and fails
    // the open step before reaching this assertion; we assert anyway so
    // the test is self-validating.
    assert_eq!(opened.album_id, album_id);
}
