//! Streaming AEAD primitives for tier-3 originals over the size threshold.
//!
//! Implements the v3 envelope **streaming variant** (`reserved[0] == 1`) that
//! lets a decoder process tier-3 ciphertext chunk-by-chunk so a 200 MiB RAW
//! shot never materializes whole-photo plaintext at once.
//!
//! Envelope layout for variant 1:
//! ```text
//! offset 0   .. 4   magic       "SGzk"
//! offset 4   .. 5   version     0x03
//! offset 5   .. 9   epoch_id    u32 LE
//! offset 9   .. 13  shard_index u32 LE
//! offset 13  .. 37  nonce       24 bytes (only first 19 used as StreamBE32 seed)
//! offset 37  .. 38  tier        u8
//! offset 38  .. 39  reserved[0] = 1  (envelope variant: streaming-chunks)
//! offset 39  .. 43  reserved[1..5] = chunk_size_bytes  (u32 LE, plaintext bytes per non-final chunk)
//! offset 43  .. 64  reserved[5..26] = 0
//! ```
//!
//! Each chunk's ciphertext on the wire is `chunk_size_bytes + 16` bytes for
//! non-final chunks and `(remainder + 16)` bytes for the final chunk. The
//! AAD applied to every chunk is the full 64-byte envelope header.
//!
//! Forward-compatibility: variant `0` (monolithic) envelopes go through the
//! pre-existing [`crate::decrypt_shard`] path. This module is only invoked
//! when the caller has already inspected the envelope variant byte.

use chacha20poly1305::{
    XChaCha20Poly1305,
    aead::{KeyInit, Payload, generic_array::GenericArray, stream::DecryptorBE32},
};
use mosaic_domain::{SHARD_ENVELOPE_HEADER_LEN, ShardTier};
use zeroize::Zeroizing;

use crate::{MosaicCryptoError, SecretKey};

/// Envelope variant byte identifying the streaming-chunks layout.
pub const STREAMING_ENVELOPE_VARIANT: u8 = 1;

/// Authentication tag length appended after each chunk's ciphertext.
pub const STREAMING_CHUNK_TAG_BYTES: usize = 16;

/// Minimum allowed plaintext chunk size: 64 KiB.
///
/// Floor exists so an attacker-supplied envelope cannot force a tiny chunk
/// size that would explode per-chunk overhead. Matches the per-photo memory
/// budget of < 4 MiB while still amortizing AEAD setup cost.
pub const MIN_STREAMING_CHUNK_BYTES: u32 = 64 * 1024;

/// Maximum allowed plaintext chunk size: 4 MiB.
///
/// Ceiling exists to keep peak per-photo plaintext memory under the mobile
/// 64 MiB browser cap (with margin) regardless of envelope contents.
pub const MAX_STREAMING_CHUNK_BYTES: u32 = 4 * 1024 * 1024;

/// Streaming-AEAD seed nonce length (XChaCha20Poly1305 nonce 24 - StreamBE32 5 = 19).
const STREAM_SEED_NONCE_LEN: usize = 19;

/// Header reserved field offset (mirrors `mosaic-domain` private constant).
const RESERVED_OFFSET: usize = 38;

/// Streaming-AEAD shard decryptor.
///
/// Construct via [`open_streaming_shard`]. Caller must call
/// [`StreamingShardDecryptor::process_chunk`] for each non-final chunk
/// in order, then exactly one [`StreamingShardDecryptor::finish_chunk`]
/// for the final (tag-bearing) chunk. Calling `process_chunk` after
/// `finish_chunk` returns [`MosaicCryptoError::InvalidEnvelope`].
pub struct StreamingShardDecryptor {
    /// `None` once the final chunk has been consumed.
    decryptor: Option<DecryptorBE32<XChaCha20Poly1305>>,
    /// Full 64-byte envelope header, applied as AAD to every chunk.
    header_bytes: [u8; SHARD_ENVELOPE_HEADER_LEN],
    chunk_size_bytes: u32,
}

impl StreamingShardDecryptor {
    /// Plaintext chunk size declared in the envelope header.
    #[must_use]
    pub const fn chunk_size_bytes(&self) -> u32 {
        self.chunk_size_bytes
    }

    /// Decrypt a non-final chunk.
    ///
    /// # Errors
    /// - [`MosaicCryptoError::InvalidEnvelope`] if `finish_chunk` was already called.
    /// - [`MosaicCryptoError::AuthenticationFailed`] if the AEAD tag does not
    ///   verify (wrong key, tampered chunk, or chunks supplied out of order).
    pub fn process_chunk(
        &mut self,
        chunk_ciphertext: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, MosaicCryptoError> {
        let Some(decryptor) = self.decryptor.as_mut() else {
            return Err(MosaicCryptoError::InvalidEnvelope);
        };
        let plaintext = decryptor
            .decrypt_next(Payload {
                msg: chunk_ciphertext,
                aad: &self.header_bytes,
            })
            .map_err(|_| MosaicCryptoError::AuthenticationFailed)?;
        Ok(Zeroizing::new(plaintext))
    }

    /// Decrypt the final chunk and finalize the stream.
    ///
    /// # Errors
    /// - [`MosaicCryptoError::InvalidEnvelope`] if `finish_chunk` was already called.
    /// - [`MosaicCryptoError::AuthenticationFailed`] if the AEAD tag does not verify.
    pub fn finish_chunk(
        &mut self,
        last_chunk_ciphertext: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, MosaicCryptoError> {
        let Some(decryptor) = self.decryptor.take() else {
            return Err(MosaicCryptoError::InvalidEnvelope);
        };
        let plaintext = decryptor
            .decrypt_last(Payload {
                msg: last_chunk_ciphertext,
                aad: &self.header_bytes,
            })
            .map_err(|_| MosaicCryptoError::AuthenticationFailed)?;
        Ok(Zeroizing::new(plaintext))
    }

    /// Returns `true` once `finish_chunk` has been invoked.
    #[must_use]
    pub const fn is_finished(&self) -> bool {
        self.decryptor.is_none()
    }
}

/// Open a streaming decryptor from a 64-byte envelope header.
///
/// # Errors
/// - [`MosaicCryptoError::InvalidEnvelope`] if magic, version, tier, variant
///   byte, chunk size, or trailing reserved bytes do not match the streaming
///   variant contract.
/// - [`MosaicCryptoError::InvalidKeyLength`] if `key` is not 32 bytes.
pub fn open_streaming_shard(
    envelope_header: &[u8; SHARD_ENVELOPE_HEADER_LEN],
    key: &SecretKey,
) -> Result<StreamingShardDecryptor, MosaicCryptoError> {
    // Magic + version: same as monolithic.
    if envelope_header[0..4] != *b"SGzk" {
        return Err(MosaicCryptoError::InvalidEnvelope);
    }
    if envelope_header[4] != 0x03 {
        return Err(MosaicCryptoError::InvalidEnvelope);
    }

    // Tier byte must decode (tier value space is shared with monolithic).
    if ShardTier::try_from(envelope_header[37]).is_err() {
        return Err(MosaicCryptoError::InvalidEnvelope);
    }

    // Variant byte at reserved[0] must mark streaming.
    if envelope_header[RESERVED_OFFSET] != STREAMING_ENVELOPE_VARIANT {
        return Err(MosaicCryptoError::InvalidEnvelope);
    }

    // Chunk size (LE u32) at reserved[1..5]; reject zero/out-of-range.
    let chunk_size_bytes = u32::from_le_bytes([
        envelope_header[RESERVED_OFFSET + 1],
        envelope_header[RESERVED_OFFSET + 2],
        envelope_header[RESERVED_OFFSET + 3],
        envelope_header[RESERVED_OFFSET + 4],
    ]);
    if !(MIN_STREAMING_CHUNK_BYTES..=MAX_STREAMING_CHUNK_BYTES).contains(&chunk_size_bytes) {
        return Err(MosaicCryptoError::InvalidEnvelope);
    }

    // Remaining reserved bytes (offsets 43..64) MUST be zero — defense in
    // depth so a future variant 1.x sub-flag cannot be silently accepted.
    for &byte in &envelope_header[RESERVED_OFFSET + 5..SHARD_ENVELOPE_HEADER_LEN] {
        if byte != 0 {
            return Err(MosaicCryptoError::InvalidEnvelope);
        }
    }

    let cipher = XChaCha20Poly1305::new_from_slice(key.as_bytes()).map_err(|_| {
        MosaicCryptoError::InvalidKeyLength {
            actual: key.as_bytes().len(),
        }
    })?;

    let seed_nonce = GenericArray::from_slice(&envelope_header[13..13 + STREAM_SEED_NONCE_LEN]);
    let decryptor = DecryptorBE32::from_aead(cipher, seed_nonce);

    Ok(StreamingShardDecryptor {
        decryptor: Some(decryptor),
        header_bytes: *envelope_header,
        chunk_size_bytes,
    })
}

/// Encode a complete streaming-AEAD shard envelope.
///
/// **Test-only helper.** The production encoder is out of scope for the
/// streaming-AEAD landing; this primitive exists so mosaic-crypto and
/// mosaic-wasm tests can produce known-good fixtures without copy-pasting
/// AEAD setup. Not currently routed through any FFI surface.
///
/// # Errors
/// - [`MosaicCryptoError::InvalidEnvelope`] if `chunk_size_bytes` is outside
///   `[MIN_STREAMING_CHUNK_BYTES, MAX_STREAMING_CHUNK_BYTES]`.
/// - [`MosaicCryptoError::InvalidInputLength`] if the plaintext is empty.
/// - [`MosaicCryptoError::AuthenticationFailed`] if the AEAD layer reports
///   an unexpected error.
pub fn encrypt_streaming_shard(
    plaintext: &[u8],
    key: &SecretKey,
    epoch_id: u32,
    shard_index: u32,
    tier: ShardTier,
    nonce: [u8; 24],
    chunk_size_bytes: u32,
) -> Result<Vec<u8>, MosaicCryptoError> {
    if plaintext.is_empty() {
        return Err(MosaicCryptoError::InvalidInputLength { actual: 0 });
    }
    if !(MIN_STREAMING_CHUNK_BYTES..=MAX_STREAMING_CHUNK_BYTES).contains(&chunk_size_bytes) {
        return Err(MosaicCryptoError::InvalidEnvelope);
    }

    let mut header = [0_u8; SHARD_ENVELOPE_HEADER_LEN];
    header[0..4].copy_from_slice(b"SGzk");
    header[4] = 0x03;
    header[5..9].copy_from_slice(&epoch_id.to_le_bytes());
    header[9..13].copy_from_slice(&shard_index.to_le_bytes());
    header[13..37].copy_from_slice(&nonce);
    header[37] = tier.to_byte();
    header[RESERVED_OFFSET] = STREAMING_ENVELOPE_VARIANT;
    header[RESERVED_OFFSET + 1..RESERVED_OFFSET + 5]
        .copy_from_slice(&chunk_size_bytes.to_le_bytes());
    // remaining bytes already zero.

    let cipher = XChaCha20Poly1305::new_from_slice(key.as_bytes()).map_err(|_| {
        MosaicCryptoError::InvalidKeyLength {
            actual: key.as_bytes().len(),
        }
    })?;
    let seed_nonce = GenericArray::from_slice(&header[13..13 + STREAM_SEED_NONCE_LEN]);
    let mut encryptor =
        chacha20poly1305::aead::stream::EncryptorBE32::from_aead(cipher, seed_nonce);

    let chunk_size = chunk_size_bytes as usize;
    let mut envelope = Vec::with_capacity(
        SHARD_ENVELOPE_HEADER_LEN + plaintext.len() + STREAMING_CHUNK_TAG_BYTES * 4,
    );
    envelope.extend_from_slice(&header);

    let mut offset = 0;
    while offset + chunk_size < plaintext.len() {
        let chunk = &plaintext[offset..offset + chunk_size];
        let ct = encryptor
            .encrypt_next(Payload {
                msg: chunk,
                aad: &header,
            })
            .map_err(|_| MosaicCryptoError::AuthenticationFailed)?;
        envelope.extend_from_slice(&ct);
        offset += chunk_size;
    }
    let last_chunk = &plaintext[offset..];
    let ct = encryptor
        .encrypt_last(Payload {
            msg: last_chunk,
            aad: &header,
        })
        .map_err(|_| MosaicCryptoError::AuthenticationFailed)?;
    envelope.extend_from_slice(&ct);

    Ok(envelope)
}
