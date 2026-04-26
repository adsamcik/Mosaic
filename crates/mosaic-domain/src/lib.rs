//! Shared domain constants and types for the Mosaic Rust client core.

#![forbid(unsafe_code)]

/// Current shard envelope magic bytes.
pub const SHARD_ENVELOPE_MAGIC: [u8; 4] = *b"SGzk";

/// Current shard envelope version byte.
pub const SHARD_ENVELOPE_VERSION: u8 = 0x03;

/// Byte length of the current shard envelope header.
pub const SHARD_ENVELOPE_HEADER_LEN: usize = 64;

const SHARD_ENVELOPE_NONCE_LEN: usize = 24;
const SHARD_ENVELOPE_RESERVED_OFFSET: usize = 38;
const SHARD_ENVELOPE_RESERVED_LEN: usize = 26;

/// Current pre-release Mosaic protocol version used by Rust client-core fixtures.
pub const PROTOCOL_VERSION: &str = "mosaic-v1";

/// Domain-level parse and validation errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MosaicDomainError {
    /// Header byte length does not match the fixed protocol header length.
    InvalidHeaderLength { actual: usize },
    /// Header magic does not match the shard envelope format.
    InvalidMagic,
    /// Header version is not supported by this client core.
    UnsupportedVersion { version: u8 },
    /// Header tier byte is not one of the known shard tiers.
    InvalidTier { value: u8 },
    /// Header reserved byte was non-zero and must be rejected before decrypting.
    NonZeroReservedByte { offset: usize },
}

/// Supported shard tiers for the current MVP envelope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ShardTier {
    Thumbnail = 1,
    Preview = 2,
    Original = 3,
}

impl ShardTier {
    /// Returns the protocol byte for this tier.
    #[must_use]
    pub const fn to_byte(self) -> u8 {
        match self {
            Self::Thumbnail => 1,
            Self::Preview => 2,
            Self::Original => 3,
        }
    }
}

impl TryFrom<u8> for ShardTier {
    type Error = MosaicDomainError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Thumbnail),
            2 => Ok(Self::Preview),
            3 => Ok(Self::Original),
            _ => Err(MosaicDomainError::InvalidTier { value }),
        }
    }
}

/// Parsed shard envelope header.
///
/// The raw 64 bytes returned by [`ShardEnvelopeHeader::to_bytes`] are the AAD
/// for encryption/decryption. Decryptors must use the original transmitted
/// bytes after validation instead of reconstructing AAD from parsed fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShardEnvelopeHeader {
    epoch_id: u32,
    shard_index: u32,
    nonce: [u8; SHARD_ENVELOPE_NONCE_LEN],
    tier: ShardTier,
}

impl ShardEnvelopeHeader {
    /// Creates a header from already-validated field values.
    #[must_use]
    pub const fn new(
        epoch_id: u32,
        shard_index: u32,
        nonce: [u8; SHARD_ENVELOPE_NONCE_LEN],
        tier: ShardTier,
    ) -> Self {
        Self {
            epoch_id,
            shard_index,
            nonce,
            tier,
        }
    }

    /// Parses a raw shard envelope header and rejects malformed bytes.
    pub fn parse(bytes: &[u8]) -> Result<Self, MosaicDomainError> {
        if bytes.len() != SHARD_ENVELOPE_HEADER_LEN {
            return Err(MosaicDomainError::InvalidHeaderLength {
                actual: bytes.len(),
            });
        }

        if bytes[0..4] != SHARD_ENVELOPE_MAGIC {
            return Err(MosaicDomainError::InvalidMagic);
        }

        if bytes[4] != SHARD_ENVELOPE_VERSION {
            return Err(MosaicDomainError::UnsupportedVersion { version: bytes[4] });
        }

        for (relative_offset, value) in bytes[SHARD_ENVELOPE_RESERVED_OFFSET
            ..SHARD_ENVELOPE_RESERVED_OFFSET + SHARD_ENVELOPE_RESERVED_LEN]
            .iter()
            .enumerate()
        {
            if *value != 0 {
                return Err(MosaicDomainError::NonZeroReservedByte {
                    offset: SHARD_ENVELOPE_RESERVED_OFFSET + relative_offset,
                });
            }
        }

        let mut nonce = [0_u8; SHARD_ENVELOPE_NONCE_LEN];
        nonce.copy_from_slice(&bytes[13..37]);

        Ok(Self {
            epoch_id: u32::from_le_bytes([bytes[5], bytes[6], bytes[7], bytes[8]]),
            shard_index: u32::from_le_bytes([bytes[9], bytes[10], bytes[11], bytes[12]]),
            nonce,
            tier: ShardTier::try_from(bytes[37])?,
        })
    }

    /// Serializes the header to the exact protocol byte representation.
    #[must_use]
    pub fn to_bytes(&self) -> [u8; SHARD_ENVELOPE_HEADER_LEN] {
        let mut bytes = [0_u8; SHARD_ENVELOPE_HEADER_LEN];
        bytes[0..4].copy_from_slice(&SHARD_ENVELOPE_MAGIC);
        bytes[4] = SHARD_ENVELOPE_VERSION;
        bytes[5..9].copy_from_slice(&self.epoch_id.to_le_bytes());
        bytes[9..13].copy_from_slice(&self.shard_index.to_le_bytes());
        bytes[13..37].copy_from_slice(&self.nonce);
        bytes[37] = self.tier.to_byte();
        bytes
    }

    /// Returns the epoch ID field.
    #[must_use]
    pub const fn epoch_id(&self) -> u32 {
        self.epoch_id
    }

    /// Returns the shard index field.
    #[must_use]
    pub const fn shard_index(&self) -> u32 {
        self.shard_index
    }

    /// Returns the nonce field.
    #[must_use]
    pub const fn nonce(&self) -> &[u8; SHARD_ENVELOPE_NONCE_LEN] {
        &self.nonce
    }

    /// Returns the shard tier.
    #[must_use]
    pub const fn tier(&self) -> ShardTier {
        self.tier
    }
}

/// Returns the crate name for smoke tests and FFI wrapper diagnostics.
#[must_use]
pub const fn crate_name() -> &'static str {
    "mosaic-domain"
}

#[cfg(test)]
mod tests {
    #[test]
    fn exposes_protocol_version() {
        assert_eq!(super::PROTOCOL_VERSION, "mosaic-v1");
    }
}
