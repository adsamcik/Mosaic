//! Cross-client golden-vector loader for Mosaic Slice 0B.
//!
//! Loads the JSON corpus under `tests/vectors/*.json`, validates it against the
//! schema (via strongly-typed `serde` deserialization), and exposes per-operation
//! parsers so the Rust differential test crate can drive the workspace
//! `mosaic-crypto` and `mosaic-domain` APIs and compare bytes against the
//! captured TS-reference outputs.
//!
//! The schema for every vector is the union of:
//!
//! * the operation-agnostic envelope defined by
//!   [`tests/vectors/golden-vector.schema.json`](../../../tests/vectors/golden-vector.schema.json);
//! * the per-operation `inputs` and `expected` maps, decoded by the
//!   [`vectors`] sub-modules below.
//!
//! Loaders intentionally fail fast: any unexpected field, missing key, or
//! malformed hex string is a hard error so a drifted corpus surfaces as a
//! red test rather than a silent skip.

#![forbid(unsafe_code)]

extern crate alloc;

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use core::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Errors surfaced while loading or parsing a golden-vector JSON file.
#[derive(Debug)]
pub enum VectorLoadError {
    /// Filesystem read failed for the requested path.
    Io { path: PathBuf, error: io::Error },
    /// JSON deserialization failed (schema mismatch).
    Json {
        path: PathBuf,
        error: serde_json::Error,
    },
    /// A hex-encoded field could not be decoded.
    Hex { path: PathBuf, field: &'static str },
    /// Required envelope invariant violated (e.g. wrong schema version).
    Invariant { path: PathBuf, message: String },
}

impl fmt::Display for VectorLoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { path, error } => {
                write!(f, "failed to read {}: {error}", path.display())
            }
            Self::Json { path, error } => {
                write!(f, "failed to deserialize {}: {error}", path.display())
            }
            Self::Hex { path, field } => {
                write!(f, "invalid hex in field `{field}` of {}", path.display())
            }
            Self::Invariant { path, message } => {
                write!(f, "invariant violation in {}: {message}", path.display())
            }
        }
    }
}

impl std::error::Error for VectorLoadError {}

/// Compact representation of the operation-agnostic vector envelope.
///
/// The full JSON document is kept as a `serde_json::Value` for the per-operation
/// parsers, but the envelope fields are pulled out eagerly so vector listing
/// and routing do not have to re-parse the document.
#[derive(Debug, Clone)]
pub struct ParsedVector {
    /// Path the vector was loaded from (absolute or repo-relative).
    pub path: PathBuf,
    /// Operation identifier, e.g. `link.derive-keys.v1`.
    pub operation: String,
    /// Protocol version stamp (`mosaic-v1`).
    pub protocol_version: String,
    /// Description string shown in test diagnostics.
    pub description: String,
    /// True if the Rust core is the byte-canonical reference for this vector.
    pub rust_canonical: bool,
    /// Raw JSON document for downstream per-operation parsers.
    pub document: serde_json::Value,
}

#[derive(Deserialize)]
struct EnvelopeView {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    operation: String,
    #[serde(rename = "protocolVersion")]
    protocol_version: String,
    description: String,
    #[serde(default)]
    rust_canonical: bool,
}

/// Loads and parses a single vector JSON file from disk.
///
/// # Errors
/// Returns [`VectorLoadError`] on I/O failure, JSON parse errors, or schema
/// invariant violations such as a wrong `schemaVersion`.
pub fn load_vector(path: &Path) -> Result<ParsedVector, VectorLoadError> {
    let bytes = fs::read(path).map_err(|error| VectorLoadError::Io {
        path: path.to_path_buf(),
        error,
    })?;
    let document: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|error| VectorLoadError::Json {
            path: path.to_path_buf(),
            error,
        })?;
    let envelope: EnvelopeView =
        serde_json::from_value(document.clone()).map_err(|error| VectorLoadError::Json {
            path: path.to_path_buf(),
            error,
        })?;
    if envelope.schema_version != 1 {
        return Err(VectorLoadError::Invariant {
            path: path.to_path_buf(),
            message: format!("unsupported schemaVersion {}", envelope.schema_version),
        });
    }
    if envelope.protocol_version != "mosaic-v1" {
        return Err(VectorLoadError::Invariant {
            path: path.to_path_buf(),
            message: format!("unexpected protocolVersion {}", envelope.protocol_version),
        });
    }

    Ok(ParsedVector {
        path: path.to_path_buf(),
        operation: envelope.operation,
        protocol_version: envelope.protocol_version,
        description: envelope.description,
        rust_canonical: envelope.rust_canonical,
        document,
    })
}

/// Loads every `*.json` corpus file under `tests/vectors/` (non-recursive).
///
/// The example fixture in `tests/vectors/examples/` is intentionally excluded
/// because it is a shape-only schema example, not a cryptographic vector.
///
/// # Errors
/// Returns [`VectorLoadError`] for any individual vector that fails to parse.
pub fn load_all(corpus_dir: &Path) -> Result<Vec<ParsedVector>, VectorLoadError> {
    let mut entries: Vec<PathBuf> = Vec::new();
    let read_dir = fs::read_dir(corpus_dir).map_err(|error| VectorLoadError::Io {
        path: corpus_dir.to_path_buf(),
        error,
    })?;
    for entry in read_dir {
        let entry = entry.map_err(|error| VectorLoadError::Io {
            path: corpus_dir.to_path_buf(),
            error,
        })?;
        let path = entry.path();
        if path.is_file() && path.extension().is_some_and(|ext| ext == "json") {
            // Skip the schema and the format example.
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or_default();
            if name == "golden-vector.schema.json" || name.starts_with('_') || name.starts_with('.')
            {
                continue;
            }
            entries.push(path);
        }
    }
    entries.sort();

    entries
        .into_iter()
        .map(|p| load_vector(&p))
        .collect::<Result<Vec<_>, _>>()
}

/// Resolves the workspace root by walking up from the running test binary.
///
/// Cargo runs each test binary with `CARGO_MANIFEST_DIR` pointing at the crate
/// folder; the corpus lives two levels up (`crates/mosaic-vectors/../..`).
#[must_use]
pub fn default_corpus_dir() -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let mut path = PathBuf::from(manifest_dir);
    path.pop(); // -> crates/
    path.pop(); // -> repo root
    path.push("tests");
    path.push("vectors");
    path
}

/// Per-operation parsers and Rust-side runners.
pub mod vectors {
    use super::{ParsedVector, VectorLoadError};
    use serde::Deserialize;

    /// Decode a lowercase-hex string into bytes.
    pub fn decode_hex(
        value: &str,
        field: &'static str,
        path: &std::path::Path,
    ) -> Result<alloc::vec::Vec<u8>, VectorLoadError> {
        if value.len() % 2 != 0 {
            return Err(VectorLoadError::Hex {
                path: path.to_path_buf(),
                field,
            });
        }
        let mut out = alloc::vec::Vec::with_capacity(value.len() / 2);
        let mut iter = value.as_bytes().chunks_exact(2);
        for chunk in iter.by_ref() {
            let high = decode_nibble(chunk[0]).ok_or(VectorLoadError::Hex {
                path: path.to_path_buf(),
                field,
            })?;
            let low = decode_nibble(chunk[1]).ok_or(VectorLoadError::Hex {
                path: path.to_path_buf(),
                field,
            })?;
            out.push((high << 4) | low);
        }
        Ok(out)
    }

    fn decode_nibble(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }

    fn extract<T: for<'de> Deserialize<'de>>(
        document: &serde_json::Value,
        field: &str,
        path: &std::path::Path,
    ) -> Result<T, VectorLoadError> {
        let raw = document
            .get(field)
            .cloned()
            .ok_or_else(|| VectorLoadError::Invariant {
                path: path.to_path_buf(),
                message: alloc::format!("missing top-level field `{field}`"),
            })?;
        serde_json::from_value(raw).map_err(|error| VectorLoadError::Json {
            path: path.to_path_buf(),
            error,
        })
    }

    /// `link.derive-keys.v1` parsed inputs/outputs.
    pub struct LinkKeysVector {
        pub link_secret: alloc::vec::Vec<u8>,
        pub expected_link_id: alloc::vec::Vec<u8>,
        pub expected_wrapping_key: alloc::vec::Vec<u8>,
    }

    #[derive(Deserialize)]
    struct LinkKeysInputs {
        #[serde(rename = "linkSecretHex")]
        link_secret_hex: alloc::string::String,
    }
    #[derive(Deserialize)]
    struct LinkKeysExpected {
        #[serde(rename = "linkIdHex")]
        link_id_hex: alloc::string::String,
        #[serde(rename = "wrappingKeyHex")]
        wrapping_key_hex: alloc::string::String,
    }

    impl LinkKeysVector {
        /// # Errors
        /// Returns [`VectorLoadError`] on missing fields or invalid hex.
        pub fn from(parsed: &ParsedVector) -> Result<Self, VectorLoadError> {
            let inputs: LinkKeysInputs = extract(&parsed.document, "inputs", &parsed.path)?;
            let expected: LinkKeysExpected = extract(&parsed.document, "expected", &parsed.path)?;
            Ok(Self {
                link_secret: decode_hex(&inputs.link_secret_hex, "linkSecretHex", &parsed.path)?,
                expected_link_id: decode_hex(&expected.link_id_hex, "linkIdHex", &parsed.path)?,
                expected_wrapping_key: decode_hex(
                    &expected.wrapping_key_hex,
                    "wrappingKeyHex",
                    &parsed.path,
                )?,
            })
        }
    }

    /// `link.wrap-tier-key.v1` parsed inputs/outputs.
    pub struct TierKeyWrapVector {
        pub link_secret: alloc::vec::Vec<u8>,
        pub tier_key: alloc::vec::Vec<u8>,
        pub tier_byte: u8,
        pub wrap_nonce: alloc::vec::Vec<u8>,
        pub expected_wrap_nonce: alloc::vec::Vec<u8>,
        pub expected_encrypted_key: alloc::vec::Vec<u8>,
        pub expected_unwrapped_key: alloc::vec::Vec<u8>,
    }

    #[derive(Deserialize)]
    struct TierKeyWrapInputs {
        #[serde(rename = "linkSecretHex")]
        link_secret_hex: alloc::string::String,
        #[serde(rename = "tierKeyHex")]
        tier_key_hex: alloc::string::String,
        #[serde(rename = "tierByte")]
        tier_byte: u8,
        #[serde(rename = "nonceHex")]
        nonce_hex: alloc::string::String,
    }
    #[derive(Deserialize)]
    struct TierKeyWrapExpected {
        tier: u8,
        #[serde(rename = "nonceHex")]
        nonce_hex: alloc::string::String,
        #[serde(rename = "encryptedKeyHex")]
        encrypted_key_hex: alloc::string::String,
        #[serde(rename = "unwrappedKeyHex")]
        unwrapped_key_hex: alloc::string::String,
    }

    impl TierKeyWrapVector {
        /// # Errors
        /// Returns [`VectorLoadError`] on missing fields, invalid hex, or
        /// inconsistent tier bytes.
        pub fn from(parsed: &ParsedVector) -> Result<Self, VectorLoadError> {
            let inputs: TierKeyWrapInputs = extract(&parsed.document, "inputs", &parsed.path)?;
            let expected: TierKeyWrapExpected =
                extract(&parsed.document, "expected", &parsed.path)?;
            if inputs.tier_byte != expected.tier {
                return Err(VectorLoadError::Invariant {
                    path: parsed.path.clone(),
                    message: alloc::format!(
                        "inputs.tierByte {} != expected.tier {}",
                        inputs.tier_byte,
                        expected.tier
                    ),
                });
            }
            Ok(Self {
                link_secret: decode_hex(&inputs.link_secret_hex, "linkSecretHex", &parsed.path)?,
                tier_key: decode_hex(&inputs.tier_key_hex, "tierKeyHex", &parsed.path)?,
                tier_byte: inputs.tier_byte,
                wrap_nonce: decode_hex(&inputs.nonce_hex, "inputs.nonceHex", &parsed.path)?,
                expected_wrap_nonce: decode_hex(
                    &expected.nonce_hex,
                    "expected.nonceHex",
                    &parsed.path,
                )?,
                expected_encrypted_key: decode_hex(
                    &expected.encrypted_key_hex,
                    "encryptedKeyHex",
                    &parsed.path,
                )?,
                expected_unwrapped_key: decode_hex(
                    &expected.unwrapped_key_hex,
                    "unwrappedKeyHex",
                    &parsed.path,
                )?,
            })
        }
    }

    /// `identity.derive-from-seed.v1` parsed inputs/outputs.
    pub struct IdentityVector {
        pub identity_seed: alloc::vec::Vec<u8>,
        pub identity_message: alloc::vec::Vec<u8>,
        pub expected_signing_pubkey: alloc::vec::Vec<u8>,
        pub expected_encryption_pubkey: alloc::vec::Vec<u8>,
        pub expected_signature: alloc::vec::Vec<u8>,
    }

    #[derive(Deserialize)]
    struct IdentityInputs {
        #[serde(rename = "identitySeedHex")]
        seed_hex: alloc::string::String,
        #[serde(rename = "identityMessageHex")]
        message_hex: alloc::string::String,
    }
    #[derive(Deserialize)]
    struct IdentityExpected {
        #[serde(rename = "signingPubkeyHex")]
        signing_pubkey_hex: alloc::string::String,
        #[serde(rename = "encryptionPubkeyHex")]
        encryption_pubkey_hex: alloc::string::String,
        #[serde(rename = "signatureHex")]
        signature_hex: alloc::string::String,
    }

    impl IdentityVector {
        /// # Errors
        /// Returns [`VectorLoadError`] on missing fields or invalid hex.
        pub fn from(parsed: &ParsedVector) -> Result<Self, VectorLoadError> {
            let inputs: IdentityInputs = extract(&parsed.document, "inputs", &parsed.path)?;
            let expected: IdentityExpected = extract(&parsed.document, "expected", &parsed.path)?;
            Ok(Self {
                identity_seed: decode_hex(&inputs.seed_hex, "identitySeedHex", &parsed.path)?,
                identity_message: decode_hex(
                    &inputs.message_hex,
                    "identityMessageHex",
                    &parsed.path,
                )?,
                expected_signing_pubkey: decode_hex(
                    &expected.signing_pubkey_hex,
                    "signingPubkeyHex",
                    &parsed.path,
                )?,
                expected_encryption_pubkey: decode_hex(
                    &expected.encryption_pubkey_hex,
                    "encryptionPubkeyHex",
                    &parsed.path,
                )?,
                expected_signature: decode_hex(
                    &expected.signature_hex,
                    "signatureHex",
                    &parsed.path,
                )?,
            })
        }
    }

    /// `content.encrypt.v1` parsed inputs/outputs.
    pub struct ContentEncryptVector {
        pub content_key: alloc::vec::Vec<u8>,
        pub epoch_id: u32,
        pub nonce: alloc::vec::Vec<u8>,
        pub plaintext: alloc::vec::Vec<u8>,
        pub expected_ciphertext: alloc::vec::Vec<u8>,
        pub expected_decrypted: alloc::vec::Vec<u8>,
    }

    #[derive(Deserialize)]
    struct ContentInputs {
        #[serde(rename = "contentKeyHex")]
        content_key_hex: alloc::string::String,
        #[serde(rename = "epochId")]
        epoch_id: u32,
        #[serde(rename = "nonceHex")]
        nonce_hex: alloc::string::String,
        #[serde(rename = "plaintextHex")]
        plaintext_hex: alloc::string::String,
    }
    #[derive(Deserialize)]
    struct ContentExpected {
        #[serde(rename = "ciphertextHex")]
        ciphertext_hex: alloc::string::String,
        #[serde(rename = "decryptedHex")]
        decrypted_hex: alloc::string::String,
    }

    impl ContentEncryptVector {
        /// # Errors
        /// Returns [`VectorLoadError`] on missing fields or invalid hex.
        pub fn from(parsed: &ParsedVector) -> Result<Self, VectorLoadError> {
            let inputs: ContentInputs = extract(&parsed.document, "inputs", &parsed.path)?;
            let expected: ContentExpected = extract(&parsed.document, "expected", &parsed.path)?;
            Ok(Self {
                content_key: decode_hex(&inputs.content_key_hex, "contentKeyHex", &parsed.path)?,
                epoch_id: inputs.epoch_id,
                nonce: decode_hex(&inputs.nonce_hex, "inputs.nonceHex", &parsed.path)?,
                plaintext: decode_hex(&inputs.plaintext_hex, "plaintextHex", &parsed.path)?,
                expected_ciphertext: decode_hex(
                    &expected.ciphertext_hex,
                    "ciphertextHex",
                    &parsed.path,
                )?,
                expected_decrypted: decode_hex(
                    &expected.decrypted_hex,
                    "decryptedHex",
                    &parsed.path,
                )?,
            })
        }
    }

    /// One per-tier slice of `envelope.shard.encrypt-decrypt.v1`.
    pub struct ShardTierVector {
        pub tier: u8,
        pub shard_index: u32,
        pub tier_key: alloc::vec::Vec<u8>,
        pub nonce: alloc::vec::Vec<u8>,
        pub plaintext: alloc::vec::Vec<u8>,
        pub expected_envelope: alloc::vec::Vec<u8>,
        pub expected_sha256: alloc::string::String,
    }

    /// `envelope.shard.encrypt-decrypt.v1` parsed inputs/outputs.
    pub struct ShardEnvelopeVector {
        pub epoch_id: u32,
        pub tiers: alloc::vec::Vec<ShardTierVector>,
    }

    #[derive(Deserialize)]
    struct ShardTierInput {
        tier: u8,
        #[serde(rename = "shardIndex")]
        shard_index: u32,
        #[serde(rename = "tierKeyHex")]
        tier_key_hex: alloc::string::String,
        #[serde(rename = "nonceHex")]
        nonce_hex: alloc::string::String,
        #[serde(rename = "plaintextHex")]
        plaintext_hex: alloc::string::String,
    }
    #[derive(Deserialize)]
    struct ShardEnvelopeInputs {
        #[serde(rename = "epochId")]
        epoch_id: u32,
        tiers: alloc::vec::Vec<ShardTierInput>,
    }
    #[derive(Deserialize)]
    struct ShardTierExpected {
        tier: u8,
        #[serde(rename = "envelopeHex")]
        envelope_hex: alloc::string::String,
        sha256: alloc::string::String,
    }
    #[derive(Deserialize)]
    struct ShardEnvelopeExpected {
        tiers: alloc::vec::Vec<ShardTierExpected>,
    }

    impl ShardEnvelopeVector {
        /// # Errors
        /// Returns [`VectorLoadError`] on missing fields, invalid hex, or
        /// mismatched tier alignment between inputs and expected outputs.
        pub fn from(parsed: &ParsedVector) -> Result<Self, VectorLoadError> {
            let inputs: ShardEnvelopeInputs = extract(&parsed.document, "inputs", &parsed.path)?;
            let expected: ShardEnvelopeExpected =
                extract(&parsed.document, "expected", &parsed.path)?;
            if inputs.tiers.len() != expected.tiers.len() {
                return Err(VectorLoadError::Invariant {
                    path: parsed.path.clone(),
                    message: alloc::format!(
                        "inputs.tiers ({}) != expected.tiers ({})",
                        inputs.tiers.len(),
                        expected.tiers.len()
                    ),
                });
            }
            let mut tiers = alloc::vec::Vec::with_capacity(inputs.tiers.len());
            for (input, expected) in inputs.tiers.into_iter().zip(expected.tiers) {
                if input.tier != expected.tier {
                    return Err(VectorLoadError::Invariant {
                        path: parsed.path.clone(),
                        message: alloc::format!(
                            "inputs.tier {} != expected.tier {}",
                            input.tier,
                            expected.tier
                        ),
                    });
                }
                tiers.push(ShardTierVector {
                    tier: input.tier,
                    shard_index: input.shard_index,
                    tier_key: decode_hex(&input.tier_key_hex, "tierKeyHex", &parsed.path)?,
                    nonce: decode_hex(&input.nonce_hex, "tier.nonceHex", &parsed.path)?,
                    plaintext: decode_hex(&input.plaintext_hex, "plaintextHex", &parsed.path)?,
                    expected_envelope: decode_hex(
                        &expected.envelope_hex,
                        "envelopeHex",
                        &parsed.path,
                    )?,
                    expected_sha256: expected.sha256,
                });
            }
            Ok(Self {
                epoch_id: inputs.epoch_id,
                tiers,
            })
        }
    }

    /// `auth.challenge.sign-verify.v1` parsed inputs/outputs.
    pub struct AuthChallengeVector {
        pub auth_signing_seed: alloc::vec::Vec<u8>,
        pub auth_public_key: alloc::vec::Vec<u8>,
        pub username: alloc::string::String,
        pub challenge: alloc::vec::Vec<u8>,
        pub timestamp_ms: u64,
        pub expected_transcript_no_ts: alloc::vec::Vec<u8>,
        pub expected_transcript_with_ts: alloc::vec::Vec<u8>,
        pub expected_signature_no_ts: alloc::vec::Vec<u8>,
        pub expected_signature_with_ts: alloc::vec::Vec<u8>,
    }

    #[derive(Deserialize)]
    struct AuthInputs {
        #[serde(rename = "authSigningSeedHex")]
        auth_signing_seed_hex: alloc::string::String,
        #[serde(rename = "authPublicKeyHex")]
        auth_public_key_hex: alloc::string::String,
        username: alloc::string::String,
        #[serde(rename = "challengeHex")]
        challenge_hex: alloc::string::String,
        #[serde(rename = "timestampMs")]
        timestamp_ms: u64,
    }
    #[derive(Deserialize)]
    struct AuthExpected {
        #[serde(rename = "transcriptNoTimestampHex")]
        transcript_no_ts_hex: alloc::string::String,
        #[serde(rename = "transcriptWithTimestampHex")]
        transcript_with_ts_hex: alloc::string::String,
        #[serde(rename = "signatureNoTimestampHex")]
        signature_no_ts_hex: alloc::string::String,
        #[serde(rename = "signatureWithTimestampHex")]
        signature_with_ts_hex: alloc::string::String,
    }

    impl AuthChallengeVector {
        /// # Errors
        /// Returns [`VectorLoadError`] on missing fields or invalid hex.
        pub fn from(parsed: &ParsedVector) -> Result<Self, VectorLoadError> {
            let inputs: AuthInputs = extract(&parsed.document, "inputs", &parsed.path)?;
            let expected: AuthExpected = extract(&parsed.document, "expected", &parsed.path)?;
            Ok(Self {
                auth_signing_seed: decode_hex(
                    &inputs.auth_signing_seed_hex,
                    "authSigningSeedHex",
                    &parsed.path,
                )?,
                auth_public_key: decode_hex(
                    &inputs.auth_public_key_hex,
                    "authPublicKeyHex",
                    &parsed.path,
                )?,
                username: inputs.username,
                challenge: decode_hex(&inputs.challenge_hex, "challengeHex", &parsed.path)?,
                timestamp_ms: inputs.timestamp_ms,
                expected_transcript_no_ts: decode_hex(
                    &expected.transcript_no_ts_hex,
                    "transcriptNoTimestampHex",
                    &parsed.path,
                )?,
                expected_transcript_with_ts: decode_hex(
                    &expected.transcript_with_ts_hex,
                    "transcriptWithTimestampHex",
                    &parsed.path,
                )?,
                expected_signature_no_ts: decode_hex(
                    &expected.signature_no_ts_hex,
                    "signatureNoTimestampHex",
                    &parsed.path,
                )?,
                expected_signature_with_ts: decode_hex(
                    &expected.signature_with_ts_hex,
                    "signatureWithTimestampHex",
                    &parsed.path,
                )?,
            })
        }
    }

    /// `auth.keypair.derive.v1` parsed inputs/outputs (TS-canonical; Rust diverges).
    pub struct AuthKeypairVector {
        pub l0_master_key: alloc::vec::Vec<u8>,
        pub expected_auth_seed: alloc::vec::Vec<u8>,
        pub expected_auth_public_key: alloc::vec::Vec<u8>,
    }

    #[derive(Deserialize)]
    struct AuthKeypairInputs {
        #[serde(rename = "l0MasterKeyHex")]
        l0_hex: alloc::string::String,
    }
    #[derive(Deserialize)]
    struct AuthKeypairExpected {
        #[serde(rename = "authSigningSeedHex")]
        auth_seed_hex: alloc::string::String,
        #[serde(rename = "authPublicKeyHex")]
        auth_pub_hex: alloc::string::String,
    }

    impl AuthKeypairVector {
        /// # Errors
        /// Returns [`VectorLoadError`] on missing fields or invalid hex.
        pub fn from(parsed: &ParsedVector) -> Result<Self, VectorLoadError> {
            let inputs: AuthKeypairInputs = extract(&parsed.document, "inputs", &parsed.path)?;
            let expected: AuthKeypairExpected =
                extract(&parsed.document, "expected", &parsed.path)?;
            Ok(Self {
                l0_master_key: decode_hex(&inputs.l0_hex, "l0MasterKeyHex", &parsed.path)?,
                expected_auth_seed: decode_hex(
                    &expected.auth_seed_hex,
                    "authSigningSeedHex",
                    &parsed.path,
                )?,
                expected_auth_public_key: decode_hex(
                    &expected.auth_pub_hex,
                    "authPublicKeyHex",
                    &parsed.path,
                )?,
            })
        }
    }

    /// `account.unlock.unwrap.v1` parsed inputs/outputs (TS-canonical; Rust diverges).
    pub struct AccountUnlockVector {
        pub user_salt: alloc::vec::Vec<u8>,
        pub account_salt: alloc::vec::Vec<u8>,
        pub l0_master_key: alloc::vec::Vec<u8>,
        pub wrapped_account_key: alloc::vec::Vec<u8>,
        pub expected_l1_root_key: alloc::vec::Vec<u8>,
        pub expected_account_key: alloc::vec::Vec<u8>,
    }

    #[derive(Deserialize)]
    struct AccountUnlockInputs {
        #[serde(rename = "userSaltHex")]
        user_salt_hex: alloc::string::String,
        #[serde(rename = "accountSaltHex")]
        account_salt_hex: alloc::string::String,
        #[serde(rename = "l0MasterKeyHex")]
        l0_hex: alloc::string::String,
        #[serde(rename = "wrappedAccountKeyHex")]
        wrapped_hex: alloc::string::String,
    }
    #[derive(Deserialize)]
    struct AccountUnlockExpected {
        #[serde(rename = "l1RootKeyHex")]
        l1_hex: alloc::string::String,
        #[serde(rename = "accountKeyHex")]
        account_key_hex: alloc::string::String,
    }

    impl AccountUnlockVector {
        /// # Errors
        /// Returns [`VectorLoadError`] on missing fields or invalid hex.
        pub fn from(parsed: &ParsedVector) -> Result<Self, VectorLoadError> {
            let inputs: AccountUnlockInputs = extract(&parsed.document, "inputs", &parsed.path)?;
            let expected: AccountUnlockExpected =
                extract(&parsed.document, "expected", &parsed.path)?;
            Ok(Self {
                user_salt: decode_hex(&inputs.user_salt_hex, "userSaltHex", &parsed.path)?,
                account_salt: decode_hex(&inputs.account_salt_hex, "accountSaltHex", &parsed.path)?,
                l0_master_key: decode_hex(&inputs.l0_hex, "l0MasterKeyHex", &parsed.path)?,
                wrapped_account_key: decode_hex(
                    &inputs.wrapped_hex,
                    "wrappedAccountKeyHex",
                    &parsed.path,
                )?,
                expected_l1_root_key: decode_hex(&expected.l1_hex, "l1RootKeyHex", &parsed.path)?,
                expected_account_key: decode_hex(
                    &expected.account_key_hex,
                    "accountKeyHex",
                    &parsed.path,
                )?,
            })
        }
    }

    /// `epoch.derive-tier-keys.v1` parsed inputs/outputs (TS-canonical; Rust diverges).
    pub struct EpochDeriveVector {
        pub epoch_seed: alloc::vec::Vec<u8>,
        pub expected_thumb_key_sha256: alloc::vec::Vec<u8>,
        pub expected_preview_key_sha256: alloc::vec::Vec<u8>,
        pub expected_full_key_sha256: alloc::vec::Vec<u8>,
        pub expected_content_key_sha256: alloc::vec::Vec<u8>,
    }

    #[derive(Deserialize)]
    struct EpochDeriveInputs {
        #[serde(rename = "epochSeedHex")]
        seed_hex: alloc::string::String,
    }
    #[derive(Deserialize)]
    struct EpochDeriveExpected {
        #[serde(rename = "thumbKeySha256")]
        thumb_sha: alloc::string::String,
        #[serde(rename = "previewKeySha256")]
        preview_sha: alloc::string::String,
        #[serde(rename = "fullKeySha256")]
        full_sha: alloc::string::String,
        #[serde(rename = "contentKeySha256")]
        content_sha: alloc::string::String,
    }

    impl EpochDeriveVector {
        /// # Errors
        /// Returns [`VectorLoadError`] on missing fields or invalid hex.
        pub fn from(parsed: &ParsedVector) -> Result<Self, VectorLoadError> {
            let inputs: EpochDeriveInputs = extract(&parsed.document, "inputs", &parsed.path)?;
            let expected: EpochDeriveExpected =
                extract(&parsed.document, "expected", &parsed.path)?;
            Ok(Self {
                epoch_seed: decode_hex(&inputs.seed_hex, "epochSeedHex", &parsed.path)?,
                expected_thumb_key_sha256: decode_hex(
                    &expected.thumb_sha,
                    "thumbKeySha256",
                    &parsed.path,
                )?,
                expected_preview_key_sha256: decode_hex(
                    &expected.preview_sha,
                    "previewKeySha256",
                    &parsed.path,
                )?,
                expected_full_key_sha256: decode_hex(
                    &expected.full_sha,
                    "fullKeySha256",
                    &parsed.path,
                )?,
                expected_content_key_sha256: decode_hex(
                    &expected.content_sha,
                    "contentKeySha256",
                    &parsed.path,
                )?,
            })
        }
    }

    /// `sharing.bundle.open.v1` parsed inputs/outputs.
    pub struct SealedBundleVector {
        pub sealed: alloc::vec::Vec<u8>,
        pub signature: alloc::vec::Vec<u8>,
        pub sharer_pubkey: alloc::vec::Vec<u8>,
        pub recipient_identity_seed: alloc::vec::Vec<u8>,
        pub expected_owner_ed25519_pub: alloc::vec::Vec<u8>,
        pub validation_album_id: alloc::string::String,
        pub validation_min_epoch_id: u32,
        pub validation_allow_legacy_empty_album_id: bool,
        pub expected_bundle_version: u32,
        pub expected_bundle_album_id: alloc::string::String,
        pub expected_bundle_epoch_id: u32,
        pub expected_recipient_pubkey: alloc::vec::Vec<u8>,
        pub expected_epoch_seed: alloc::vec::Vec<u8>,
        pub expected_sign_public_key: alloc::vec::Vec<u8>,
    }

    #[derive(Deserialize)]
    struct SealedBundleValidation {
        #[serde(rename = "albumId")]
        album_id: alloc::string::String,
        #[serde(rename = "minEpochId")]
        min_epoch_id: u32,
        #[serde(rename = "allowLegacyEmptyAlbumId")]
        allow_legacy_empty_album_id: bool,
    }
    #[derive(Deserialize)]
    struct SealedBundleInputs {
        #[serde(rename = "sealedHex")]
        sealed_hex: alloc::string::String,
        #[serde(rename = "signatureHex")]
        signature_hex: alloc::string::String,
        #[serde(rename = "sharerPubkeyHex")]
        sharer_pubkey_hex: alloc::string::String,
        #[serde(rename = "recipientIdentitySeedHex")]
        recipient_seed_hex: alloc::string::String,
        #[serde(rename = "expectedOwnerEd25519PubHex")]
        expected_owner_hex: alloc::string::String,
        validation: SealedBundleValidation,
    }
    #[derive(Deserialize)]
    struct SealedBundleExpected {
        #[serde(rename = "bundleVersion")]
        bundle_version: u32,
        #[serde(rename = "bundleAlbumId")]
        bundle_album_id: alloc::string::String,
        #[serde(rename = "bundleEpochId")]
        bundle_epoch_id: u32,
        #[serde(rename = "bundleRecipientPubkeyHex")]
        bundle_recipient_hex: alloc::string::String,
        #[serde(rename = "bundleEpochSeedHex")]
        bundle_epoch_seed_hex: alloc::string::String,
        #[serde(rename = "bundleSignPublicKeyHex")]
        bundle_sign_pubkey_hex: alloc::string::String,
    }

    impl SealedBundleVector {
        /// # Errors
        /// Returns [`VectorLoadError`] on missing fields or invalid hex.
        pub fn from(parsed: &ParsedVector) -> Result<Self, VectorLoadError> {
            let inputs: SealedBundleInputs = extract(&parsed.document, "inputs", &parsed.path)?;
            let expected: SealedBundleExpected =
                extract(&parsed.document, "expected", &parsed.path)?;
            Ok(Self {
                sealed: decode_hex(&inputs.sealed_hex, "sealedHex", &parsed.path)?,
                signature: decode_hex(&inputs.signature_hex, "signatureHex", &parsed.path)?,
                sharer_pubkey: decode_hex(
                    &inputs.sharer_pubkey_hex,
                    "sharerPubkeyHex",
                    &parsed.path,
                )?,
                recipient_identity_seed: decode_hex(
                    &inputs.recipient_seed_hex,
                    "recipientIdentitySeedHex",
                    &parsed.path,
                )?,
                expected_owner_ed25519_pub: decode_hex(
                    &inputs.expected_owner_hex,
                    "expectedOwnerEd25519PubHex",
                    &parsed.path,
                )?,
                validation_album_id: inputs.validation.album_id,
                validation_min_epoch_id: inputs.validation.min_epoch_id,
                validation_allow_legacy_empty_album_id: inputs
                    .validation
                    .allow_legacy_empty_album_id,
                expected_bundle_version: expected.bundle_version,
                expected_bundle_album_id: expected.bundle_album_id,
                expected_bundle_epoch_id: expected.bundle_epoch_id,
                expected_recipient_pubkey: decode_hex(
                    &expected.bundle_recipient_hex,
                    "bundleRecipientPubkeyHex",
                    &parsed.path,
                )?,
                expected_epoch_seed: decode_hex(
                    &expected.bundle_epoch_seed_hex,
                    "bundleEpochSeedHex",
                    &parsed.path,
                )?,
                expected_sign_public_key: decode_hex(
                    &expected.bundle_sign_pubkey_hex,
                    "bundleSignPublicKeyHex",
                    &parsed.path,
                )?,
            })
        }
    }

    /// One shard descriptor inside `manifest.transcript.canonical-bytes.v1`.
    pub struct ManifestShardEntry {
        pub chunk_index: u32,
        pub tier: u8,
        pub shard_id: alloc::vec::Vec<u8>,
        pub sha256: alloc::vec::Vec<u8>,
    }

    /// `manifest.transcript.canonical-bytes.v1` parsed inputs/outputs.
    pub struct ManifestTranscriptVector {
        pub album_id: alloc::vec::Vec<u8>,
        pub epoch_id: u32,
        pub encrypted_meta: alloc::vec::Vec<u8>,
        pub shards: alloc::vec::Vec<ManifestShardEntry>,
        pub expected_transcript: alloc::vec::Vec<u8>,
    }

    #[derive(Deserialize)]
    struct ManifestShardInput {
        #[serde(rename = "chunkIndex")]
        chunk_index: u32,
        tier: u8,
        #[serde(rename = "shardIdHex")]
        shard_id_hex: alloc::string::String,
        #[serde(rename = "sha256Hex")]
        sha256_hex: alloc::string::String,
    }
    #[derive(Deserialize)]
    struct ManifestInputs {
        #[serde(rename = "albumIdHex")]
        album_id_hex: alloc::string::String,
        #[serde(rename = "epochId")]
        epoch_id: u32,
        #[serde(rename = "encryptedMetaHex")]
        encrypted_meta_hex: alloc::string::String,
        shards: alloc::vec::Vec<ManifestShardInput>,
    }
    #[derive(Deserialize)]
    struct ManifestExpected {
        #[serde(rename = "transcriptHex")]
        transcript_hex: alloc::string::String,
    }

    impl ManifestTranscriptVector {
        /// # Errors
        /// Returns [`VectorLoadError`] on missing fields or invalid hex.
        pub fn from(parsed: &ParsedVector) -> Result<Self, VectorLoadError> {
            let inputs: ManifestInputs = extract(&parsed.document, "inputs", &parsed.path)?;
            let expected: ManifestExpected = extract(&parsed.document, "expected", &parsed.path)?;
            let mut shards = alloc::vec::Vec::with_capacity(inputs.shards.len());
            for shard in inputs.shards {
                shards.push(ManifestShardEntry {
                    chunk_index: shard.chunk_index,
                    tier: shard.tier,
                    shard_id: decode_hex(&shard.shard_id_hex, "shardIdHex", &parsed.path)?,
                    sha256: decode_hex(&shard.sha256_hex, "sha256Hex", &parsed.path)?,
                });
            }
            Ok(Self {
                album_id: decode_hex(&inputs.album_id_hex, "albumIdHex", &parsed.path)?,
                epoch_id: inputs.epoch_id,
                encrypted_meta: decode_hex(
                    &inputs.encrypted_meta_hex,
                    "encryptedMetaHex",
                    &parsed.path,
                )?,
                shards,
                expected_transcript: decode_hex(
                    &expected.transcript_hex,
                    "transcriptHex",
                    &parsed.path,
                )?,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_corpus_dir_resolves_to_repo_tests_vectors() {
        let dir = default_corpus_dir();
        assert!(dir.ends_with("tests/vectors") || dir.ends_with("tests\\vectors"));
    }
}
