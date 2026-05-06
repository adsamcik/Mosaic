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

/// Streaming shard envelope magic bytes for v0x04.
pub const STREAMING_SHARD_ENVELOPE_MAGIC: [u8; 4] = *b"SGzk";

/// Streaming shard envelope version byte.
pub const SHARD_ENVELOPE_VERSION_V04: u8 = 0x04;

/// Byte length of the v0x04 streaming shard envelope header.
pub const STREAMING_SHARD_ENVELOPE_HEADER_LEN: usize = 64;

/// v0x04 streaming AEAD frame plaintext size: 64 KiB.
pub const STREAMING_SHARD_FRAME_SIZE: usize = 64 * 1024;

/// Byte length of the v0x04 per-stream public salt.
pub const STREAMING_SHARD_SALT_LEN: usize = 16;

const STREAMING_SHARD_RESERVED_OFFSET: usize = 30;
const STREAMING_SHARD_RESERVED_LEN: usize = 34;

/// Current pre-release Mosaic protocol version used by Rust client-core fixtures.
pub const PROTOCOL_VERSION: &str = "mosaic-v1";

/// Domain separation context for manifest signing transcripts.
pub const MANIFEST_SIGN_CONTEXT: &[u8] = b"Mosaic_Manifest_v1";

/// Current manifest signing transcript format version.
pub const MANIFEST_TRANSCRIPT_VERSION: u8 = 1;

/// Domain separation context for client-local canonical metadata sidecar bytes.
pub const METADATA_SIDECAR_CONTEXT: &[u8] = b"Mosaic_Metadata_v1";

/// Current canonical metadata sidecar format version.
pub const METADATA_SIDECAR_VERSION: u8 = 1;

/// Maximum total encoded byte length of a canonical metadata sidecar.
///
/// Locked at 64 KiB for v1: this is approximately 50-100× the worst-case
/// legitimate sidecar, which provides ample headroom for future active tags
/// while constraining the DoS allocation surface to a tight bound. Tightening
/// after v1 freeze would be a protocol-visible breaking change (some valid v1
/// sidecars would be retroactively rejected on decode), so the value is locked
/// at 64 KiB before v1 ships.
///
/// Original R-M5.2.1 value was 1_500_000 (1.5 MB); tightened in R-M5.2.2.
// Maintenance protocol:
// - The cap is locked AT v1 freeze. Tightening or relaxing it after v1
//   would be a protocol-visible breaking change.
// - If a future Active tag would push the worst-case legitimate sidecar
//   above this cap, EITHER the new tag must be designed to fit within the
//   cap, OR the cap must be relaxed and the change documented as a v2
//   protocol breaking change with corresponding migration handlers.
pub const MAX_SIDECAR_TOTAL_BYTES: usize = 65_536;

/// Client-local plaintext sensitivity class for a sidecar tag.
///
/// All sidecar TLV plaintext is encrypted before server transit. This class is
/// for client-side redaction, logging, and platform handling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarTagPrivacyClass {
    SensitiveLocation,
    SensitiveTimestamp,
    DeviceFingerprint,
    UserContent,
    RenderingOnly,
    ContainerTechnical,
}

/// Governance status for a sidecar tag number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarTagStatus {
    Active,
    ReservedNumberPending,
    /// Permanently forbidden by ADR-017 §"Registry rules" item 5.
    /// Encoder MUST reject this tag.
    Forbidden,
}

/// One entry in the canonical sidecar tag registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SidecarTagRegistryEntry {
    tag_number: u16,
    tag_name: &'static str,
    status: SidecarTagStatus,
    privacy_class: SidecarTagPrivacyClass,
}
impl SidecarTagRegistryEntry {
    #[must_use]
    pub const fn new(
        tag_number: u16,
        tag_name: &'static str,
        status: SidecarTagStatus,
        privacy_class: SidecarTagPrivacyClass,
    ) -> Self {
        Self {
            tag_number,
            tag_name,
            status,
            privacy_class,
        }
    }
    #[must_use]
    pub const fn tag_number(self) -> u16 {
        self.tag_number
    }
    #[must_use]
    pub const fn tag_name(self) -> &'static str {
        self.tag_name
    }
    #[must_use]
    pub const fn status(self) -> SidecarTagStatus {
        self.status
    }
    #[must_use]
    pub const fn privacy_class(self) -> SidecarTagPrivacyClass {
        self.privacy_class
    }
}

/// Known metadata sidecar TLV field tags.
///
/// Every new `pub const` in this module must be appended to
/// [`KNOWN_FIELD_TAGS`] and to `crates/mosaic-domain/tests/sidecar_tag_table.rs`
/// in the same change. The lock test verifies both lists stay complete.
pub mod metadata_field_tags {
    use super::{SidecarTagPrivacyClass, SidecarTagRegistryEntry, SidecarTagStatus};
    pub const ORIENTATION: u16 = 1;
    pub const ORIGINAL_DIMENSIONS: u16 = 2;
    pub const DEVICE_TIMESTAMP_MS: u16 = 3;
    pub const MIME_OVERRIDE: u16 = 4;
    pub const CAMERA_MAKE: u16 = 5;
    // Tag 6 is permanently reserved for the forbidden filename payload class.
    // Do not expose a friendly public constant; production callers must not
    // accidentally encode filenames into sidecar plaintext.
    pub const CAMERA_MODEL: u16 = 7;
    pub const SUBSECONDS_MS: u16 = 8;
    pub const GPS: u16 = 9;
    pub const CODEC_FOURCC: u16 = 10;
    pub const DURATION_MS: u16 = 11;
    pub const FRAME_RATE_X100: u16 = 12;
    pub const VIDEO_ORIENTATION: u16 = 13;
    pub const VIDEO_DIMENSIONS: u16 = 14;
    pub const VIDEO_CONTAINER_FORMAT: u16 = 15;
    pub const KNOWN_FIELD_TAGS: &[SidecarTagRegistryEntry] = &[
        SidecarTagRegistryEntry::new(
            ORIENTATION,
            "orientation",
            SidecarTagStatus::Active,
            SidecarTagPrivacyClass::RenderingOnly,
        ),
        SidecarTagRegistryEntry::new(
            ORIGINAL_DIMENSIONS,
            "original_dimensions",
            SidecarTagStatus::Active,
            SidecarTagPrivacyClass::RenderingOnly,
        ),
        SidecarTagRegistryEntry::new(
            DEVICE_TIMESTAMP_MS,
            "device_timestamp_ms",
            SidecarTagStatus::Active,
            SidecarTagPrivacyClass::SensitiveTimestamp,
        ),
        SidecarTagRegistryEntry::new(
            MIME_OVERRIDE,
            "mime_override",
            SidecarTagStatus::Active,
            SidecarTagPrivacyClass::ContainerTechnical,
        ),
        SidecarTagRegistryEntry::new(
            CAMERA_MAKE,
            "camera_make",
            SidecarTagStatus::Active,
            SidecarTagPrivacyClass::DeviceFingerprint,
        ),
        SidecarTagRegistryEntry::new(
            6,
            "filename",
            SidecarTagStatus::Forbidden,
            SidecarTagPrivacyClass::UserContent,
        ),
        SidecarTagRegistryEntry::new(
            CAMERA_MODEL,
            "camera_model",
            SidecarTagStatus::Active,
            SidecarTagPrivacyClass::DeviceFingerprint,
        ),
        SidecarTagRegistryEntry::new(
            SUBSECONDS_MS,
            "subseconds_ms",
            SidecarTagStatus::Active,
            SidecarTagPrivacyClass::SensitiveTimestamp,
        ),
        SidecarTagRegistryEntry::new(
            GPS,
            "gps",
            SidecarTagStatus::Active,
            SidecarTagPrivacyClass::SensitiveLocation,
        ),
        SidecarTagRegistryEntry::new(
            CODEC_FOURCC,
            "codec_fourcc",
            SidecarTagStatus::Active,
            SidecarTagPrivacyClass::ContainerTechnical,
        ),
        SidecarTagRegistryEntry::new(
            DURATION_MS,
            "duration_ms",
            SidecarTagStatus::Active,
            SidecarTagPrivacyClass::ContainerTechnical,
        ),
        SidecarTagRegistryEntry::new(
            FRAME_RATE_X100,
            "frame_rate_x100",
            SidecarTagStatus::Active,
            SidecarTagPrivacyClass::ContainerTechnical,
        ),
        SidecarTagRegistryEntry::new(
            VIDEO_ORIENTATION,
            "video_orientation",
            SidecarTagStatus::Active,
            SidecarTagPrivacyClass::RenderingOnly,
        ),
        SidecarTagRegistryEntry::new(
            VIDEO_DIMENSIONS,
            "video_dimensions",
            SidecarTagStatus::Active,
            SidecarTagPrivacyClass::RenderingOnly,
        ),
        SidecarTagRegistryEntry::new(
            VIDEO_CONTAINER_FORMAT,
            "video_container_format",
            SidecarTagStatus::Active,
            SidecarTagPrivacyClass::ContainerTechnical,
        ),
    ];
    #[must_use]
    pub fn registry_entry(tag: u16) -> Option<SidecarTagRegistryEntry> {
        KNOWN_FIELD_TAGS
            .iter()
            .copied()
            .find(|entry| entry.tag_number() == tag)
    }
    #[must_use]
    pub fn status(tag: u16) -> Option<SidecarTagStatus> {
        registry_entry(tag).map(SidecarTagRegistryEntry::status)
    }
    #[must_use]
    pub fn privacy_class(tag: u16) -> Option<SidecarTagPrivacyClass> {
        registry_entry(tag).map(SidecarTagRegistryEntry::privacy_class)
    }
}

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

/// Manifest transcript construction errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestTranscriptError {
    /// Encrypted metadata envelope bytes must not be empty.
    EmptyEncryptedMeta,
    /// A manifest must link at least one encrypted shard.
    EmptyShardList,
    /// A length field cannot be represented by the current transcript format.
    LengthTooLarge { field: &'static str, actual: usize },
    /// Canonical shard indices must be exactly sequential after sorting.
    NonSequentialShardIndex { expected: u32, actual: u32 },
}

/// Metadata sidecar construction errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MetadataSidecarError {
    /// A length field cannot be represented by the current sidecar format.
    LengthTooLarge { field: &'static str, actual: usize },
    /// Field tags are one-based; zero is reserved and rejected.
    ZeroFieldTag,
    /// A present field must contain a value. Omit absent metadata instead.
    EmptyFieldValue { tag: u16 },
    /// Canonical sidecar fields must not repeat tags.
    DuplicateFieldTag { tag: u16 },
    /// Canonical sidecar fields must be supplied in strictly ascending tag order.
    UnsortedFieldTag { previous: u16, actual: u16 },
    /// The tag number is known but its byte layout has not been promoted.
    ReservedTagNotPromoted { tag: u16 },
    /// The tag number is permanently forbidden by policy.
    ForbiddenTag { tag: u16 },
    /// A GPS active sidecar field used latitude or longitude outside protocol bounds.
    InvalidGpsValue { latitude_e7: i32, longitude_e7: i32 },
    /// The tag number is outside the append-only sidecar registry.
    UnknownTag { tag: u16 },
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

/// One client-local plaintext metadata sidecar TLV field.
///
/// The value bytes are canonical plaintext metadata input. They must be sealed
/// by a later encryption slice before anything is bound into a manifest
/// transcript or sent to the backend.
pub struct MetadataSidecarField<'a> {
    tag: u16,
    value: &'a [u8],
}

impl<'a> MetadataSidecarField<'a> {
    /// Creates a metadata sidecar field from already-canonical value bytes.
    #[must_use]
    pub const fn new(tag: u16, value: &'a [u8]) -> Self {
        Self { tag, value }
    }

    /// Returns the TLV field tag.
    #[must_use]
    pub const fn tag(&self) -> u16 {
        self.tag
    }

    /// Returns the canonical field value bytes.
    #[must_use]
    pub const fn value(&self) -> &[u8] {
        self.value
    }
}

#[cfg(any(test, feature = "cross-client-vectors"))]
pub struct RawMetadataSidecarField<'a> {
    tag: u16,
    value: &'a [u8],
}
#[cfg(any(test, feature = "cross-client-vectors"))]
impl<'a> RawMetadataSidecarField<'a> {
    #[must_use]
    pub const fn new_for_test(tag: u16, value: &'a [u8]) -> Self {
        Self { tag, value }
    }
    #[must_use]
    pub const fn tag(&self) -> u16 {
        self.tag
    }
    #[must_use]
    pub const fn value(&self) -> &[u8] {
        self.value
    }
}

/// Client-local plaintext metadata sidecar inputs.
///
/// Canonical sidecar bytes are deterministic plaintext inputs for a later
/// encryption step. Production manifest construction must pass the encrypted
/// sidecar envelope bytes to [`ManifestTranscript::new`], never these plaintext
/// canonical bytes.
pub struct MetadataSidecar<'a> {
    album_id: [u8; 16],
    photo_id: [u8; 16],
    epoch_id: u32,
    fields: &'a [MetadataSidecarField<'a>],
}

impl<'a> MetadataSidecar<'a> {
    /// Creates metadata sidecar inputs.
    #[must_use]
    pub const fn new(
        album_id: [u8; 16],
        photo_id: [u8; 16],
        epoch_id: u32,
        fields: &'a [MetadataSidecarField<'a>],
    ) -> Self {
        Self {
            album_id,
            photo_id,
            epoch_id,
            fields,
        }
    }

    /// Returns the 16-byte album UUID bytes.
    #[must_use]
    pub const fn album_id(&self) -> &[u8; 16] {
        &self.album_id
    }

    /// Returns the 16-byte photo UUID bytes.
    #[must_use]
    pub const fn photo_id(&self) -> &[u8; 16] {
        &self.photo_id
    }

    /// Returns the epoch ID.
    #[must_use]
    pub const fn epoch_id(&self) -> u32 {
        self.epoch_id
    }

    /// Returns the metadata fields in caller-supplied order.
    #[must_use]
    pub const fn fields(&self) -> &[MetadataSidecarField<'a>] {
        self.fields
    }
}

/// Encrypted/opaque metadata envelope bytes for manifest transcript binding.
///
/// This type intentionally separates encrypted sidecar envelopes from plaintext
/// bytes returned by [`canonical_metadata_sidecar_bytes`]. Construct it only
/// after the metadata sidecar has been encrypted by the client crypto layer.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct EncryptedMetadataEnvelope<'a> {
    bytes: &'a [u8],
}

impl<'a> EncryptedMetadataEnvelope<'a> {
    /// Wraps already-encrypted/opaque metadata sidecar envelope bytes.
    #[must_use]
    pub const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes }
    }

    /// Returns encrypted/opaque metadata sidecar envelope bytes.
    #[must_use]
    pub const fn bytes(&self) -> &'a [u8] {
        self.bytes
    }
}

/// Server-visible shard reference bound into the manifest signing transcript.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ManifestShardRef {
    chunk_index: u32,
    shard_id: [u8; 16],
    tier: ShardTier,
    sha256: [u8; 32],
}

impl ManifestShardRef {
    /// Creates a manifest shard reference from already-canonical field values.
    #[must_use]
    pub const fn new(
        chunk_index: u32,
        shard_id: [u8; 16],
        tier: ShardTier,
        sha256: [u8; 32],
    ) -> Self {
        Self {
            chunk_index,
            shard_id,
            tier,
            sha256,
        }
    }

    /// Returns the shard chunk index.
    #[must_use]
    pub const fn chunk_index(&self) -> u32 {
        self.chunk_index
    }

    /// Returns the 16-byte shard UUID bytes.
    #[must_use]
    pub const fn shard_id(&self) -> &[u8; 16] {
        &self.shard_id
    }

    /// Returns the shard tier.
    #[must_use]
    pub const fn tier(&self) -> ShardTier {
        self.tier
    }

    /// Returns the encrypted shard SHA-256 bytes.
    #[must_use]
    pub const fn sha256(&self) -> &[u8; 32] {
        &self.sha256
    }
}

/// Manifest signing transcript inputs.
///
/// `encrypted_meta` is an encrypted/opaque metadata sidecar envelope. Plaintext
/// bytes returned by [`canonical_metadata_sidecar_bytes`] do not type-check here.
pub struct ManifestTranscript<'a> {
    album_id: [u8; 16],
    epoch_id: u32,
    encrypted_meta: EncryptedMetadataEnvelope<'a>,
    shards: &'a [ManifestShardRef],
}

impl<'a> ManifestTranscript<'a> {
    /// Creates manifest transcript inputs.
    ///
    /// The `encrypted_meta` argument must already wrap encrypted/opaque sidecar
    /// envelope bytes so manifest signing never binds plaintext metadata.
    #[must_use]
    pub const fn new(
        album_id: [u8; 16],
        epoch_id: u32,
        encrypted_meta: EncryptedMetadataEnvelope<'a>,
        shards: &'a [ManifestShardRef],
    ) -> Self {
        Self {
            album_id,
            epoch_id,
            encrypted_meta,
            shards,
        }
    }

    /// Returns the 16-byte album UUID bytes.
    #[must_use]
    pub const fn album_id(&self) -> &[u8; 16] {
        &self.album_id
    }

    /// Returns the epoch ID.
    #[must_use]
    pub const fn epoch_id(&self) -> u32 {
        self.epoch_id
    }

    /// Returns encrypted metadata envelope bytes.
    #[must_use]
    pub const fn encrypted_meta(&self) -> &[u8] {
        self.encrypted_meta.bytes()
    }

    /// Returns server-visible shard references.
    #[must_use]
    pub const fn shards(&self) -> &[ManifestShardRef] {
        self.shards
    }
}

/// Builds deterministic client-local canonical metadata sidecar bytes.
///
/// The returned bytes are plaintext metadata inputs and must be encrypted before
/// they are included as `encrypted_meta` in a manifest transcript or sent to the
/// backend. Empty field lists are valid and encode as `field_count = 0`.
///
/// # Errors
/// Returns [`MetadataSidecarError::LengthTooLarge`] when the field count or any
/// field value length cannot fit in `u32`, [`MetadataSidecarError::ZeroFieldTag`]
/// for tag zero, [`MetadataSidecarError::ReservedTagNotPromoted`],
/// [`MetadataSidecarError::ForbiddenTag`], or [`MetadataSidecarError::UnknownTag`]
/// when the registry does not allow encoding a tag,
/// [`MetadataSidecarError::EmptyFieldValue`] for present fields without values,
/// [`MetadataSidecarError::DuplicateFieldTag`] for repeated tags, or
/// [`MetadataSidecarError::UnsortedFieldTag`] when fields are not supplied in
/// strictly ascending tag order.
pub fn canonical_metadata_sidecar_bytes(
    sidecar: &MetadataSidecar<'_>,
) -> Result<Vec<u8>, MetadataSidecarError> {
    canonical_metadata_sidecar_bytes_inner(sidecar, true)
}
fn canonical_metadata_sidecar_bytes_inner(
    sidecar: &MetadataSidecar<'_>,
    enforce_active_tags: bool,
) -> Result<Vec<u8>, MetadataSidecarError> {
    let field_count = checked_metadata_sidecar_len("fields", sidecar.fields().len())?;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(METADATA_SIDECAR_CONTEXT);
    bytes.push(METADATA_SIDECAR_VERSION);
    bytes.extend_from_slice(sidecar.album_id());
    bytes.extend_from_slice(sidecar.photo_id());
    bytes.extend_from_slice(&sidecar.epoch_id().to_le_bytes());
    bytes.extend_from_slice(&field_count.to_le_bytes());
    let mut previous_tag = None;
    for field in sidecar.fields() {
        if field.tag() == 0 {
            return Err(MetadataSidecarError::ZeroFieldTag);
        }
        if let Some(previous) = previous_tag {
            if field.tag() <= previous {
                if field.tag() == previous {
                    return Err(MetadataSidecarError::DuplicateFieldTag { tag: field.tag() });
                }
                return Err(MetadataSidecarError::UnsortedFieldTag {
                    previous,
                    actual: field.tag(),
                });
            }
        }
        if enforce_active_tags {
            match metadata_field_tags::status(field.tag()) {
                Some(SidecarTagStatus::Active) => {}
                Some(SidecarTagStatus::ReservedNumberPending) => {
                    return Err(MetadataSidecarError::ReservedTagNotPromoted { tag: field.tag() });
                }
                Some(SidecarTagStatus::Forbidden) => {
                    return Err(MetadataSidecarError::ForbiddenTag { tag: field.tag() });
                }
                None => return Err(MetadataSidecarError::UnknownTag { tag: field.tag() }),
            }
        }
        if field.value().is_empty() {
            return Err(MetadataSidecarError::EmptyFieldValue { tag: field.tag() });
        }
        if enforce_active_tags {
            validate_active_sidecar_field(field)?;
        }
        let value_len = checked_metadata_sidecar_len("field_value", field.value().len())?;
        let projected_len = bytes
            .len()
            .checked_add(2)
            .and_then(|len| len.checked_add(4))
            .and_then(|len| len.checked_add(field.value().len()))
            .ok_or(MetadataSidecarError::LengthTooLarge {
                field: "sidecar_total_bytes",
                actual: usize::MAX,
            })?;
        if projected_len > MAX_SIDECAR_TOTAL_BYTES {
            return Err(MetadataSidecarError::LengthTooLarge {
                field: "sidecar_total_bytes",
                actual: projected_len,
            });
        }
        bytes.extend_from_slice(&field.tag().to_le_bytes());
        bytes.extend_from_slice(&value_len.to_le_bytes());
        bytes.extend_from_slice(field.value());
        previous_tag = Some(field.tag());
    }
    Ok(bytes)
}
#[cfg(any(test, feature = "cross-client-vectors"))]
pub fn canonical_metadata_sidecar_bytes_from_raw_fields_for_test(
    album_id: [u8; 16],
    photo_id: [u8; 16],
    epoch_id: u32,
    fields: &[RawMetadataSidecarField<'_>],
) -> Result<Vec<u8>, MetadataSidecarError> {
    let fields: Vec<MetadataSidecarField<'_>> = fields
        .iter()
        .map(|field| MetadataSidecarField::new(field.tag(), field.value()))
        .collect();
    canonical_metadata_sidecar_bytes_inner(
        &MetadataSidecar::new(album_id, photo_id, epoch_id, &fields),
        false,
    )
}

fn validate_active_sidecar_field(
    field: &MetadataSidecarField<'_>,
) -> Result<(), MetadataSidecarError> {
    use metadata_field_tags::{
        CAMERA_MAKE, CAMERA_MODEL, DEVICE_TIMESTAMP_MS, GPS, MIME_OVERRIDE, ORIENTATION,
        ORIGINAL_DIMENSIONS, SUBSECONDS_MS,
    };

    match field.tag() {
        ORIENTATION => validate_orientation_field(field.value()),
        ORIGINAL_DIMENSIONS => validate_dimensions_field(field.value()),
        DEVICE_TIMESTAMP_MS => validate_exact_len(field.tag(), field.value(), 8),
        MIME_OVERRIDE => validate_utf8_field(field.tag(), field.value()),
        CAMERA_MAKE | CAMERA_MODEL => validate_capped_utf8_field(field.tag(), field.value(), 64),
        SUBSECONDS_MS => validate_subseconds_field(field.value()),
        GPS => validate_gps_field(field.value()),
        _ => Ok(()),
    }
}

fn validate_exact_len(_tag: u16, value: &[u8], len: usize) -> Result<(), MetadataSidecarError> {
    if value.len() == len {
        Ok(())
    } else {
        Err(MetadataSidecarError::LengthTooLarge {
            field: "sidecar_field_value",
            actual: value.len(),
        })
    }
}

fn validate_utf8_field(_tag: u16, value: &[u8]) -> Result<(), MetadataSidecarError> {
    if std::str::from_utf8(value).is_ok() {
        Ok(())
    } else {
        Err(MetadataSidecarError::LengthTooLarge {
            field: "sidecar_field_value",
            actual: value.len(),
        })
    }
}

fn validate_capped_utf8_field(
    tag: u16,
    value: &[u8],
    max_len: usize,
) -> Result<(), MetadataSidecarError> {
    if value.len() > max_len {
        return Err(MetadataSidecarError::LengthTooLarge {
            field: "sidecar_field_value_bytes",
            actual: value.len(),
        });
    }
    validate_utf8_field(tag, value)
}

fn validate_orientation_field(value: &[u8]) -> Result<(), MetadataSidecarError> {
    if value.len() != 2 {
        return Err(MetadataSidecarError::LengthTooLarge {
            field: "sidecar_field_value",
            actual: value.len(),
        });
    }
    let orientation = u16::from_le_bytes([value[0], value[1]]);
    if (1..=8).contains(&orientation) {
        Ok(())
    } else {
        Err(MetadataSidecarError::LengthTooLarge {
            field: "sidecar_field_value",
            actual: value.len(),
        })
    }
}

fn validate_dimensions_field(value: &[u8]) -> Result<(), MetadataSidecarError> {
    if value.len() != 8 {
        return Err(MetadataSidecarError::LengthTooLarge {
            field: "sidecar_field_value",
            actual: value.len(),
        });
    }
    let width = u32::from_le_bytes([value[0], value[1], value[2], value[3]]);
    let height = u32::from_le_bytes([value[4], value[5], value[6], value[7]]);
    if width != 0 && height != 0 {
        Ok(())
    } else {
        Err(MetadataSidecarError::LengthTooLarge {
            field: "sidecar_field_value",
            actual: value.len(),
        })
    }
}

fn validate_subseconds_field(value: &[u8]) -> Result<(), MetadataSidecarError> {
    if value.len() != 4 {
        return Err(MetadataSidecarError::LengthTooLarge {
            field: "sidecar_field_value",
            actual: value.len(),
        });
    }
    let millis = u32::from_le_bytes([value[0], value[1], value[2], value[3]]);
    if millis <= 999 {
        Ok(())
    } else {
        Err(MetadataSidecarError::LengthTooLarge {
            field: "sidecar_field_value",
            actual: value.len(),
        })
    }
}

fn validate_gps_field(value: &[u8]) -> Result<(), MetadataSidecarError> {
    if value.len() != 14 {
        return Err(MetadataSidecarError::LengthTooLarge {
            field: "sidecar_field_value",
            actual: value.len(),
        });
    }
    let lat = i32::from_le_bytes([value[0], value[1], value[2], value[3]]);
    let lon = i32::from_le_bytes([value[4], value[5], value[6], value[7]]);
    if (-90_000_000..=90_000_000).contains(&lat) && (-180_000_000..=180_000_000).contains(&lon) {
        Ok(())
    } else {
        Err(MetadataSidecarError::InvalidGpsValue {
            latitude_e7: lat,
            longitude_e7: lon,
        })
    }
}

fn checked_metadata_sidecar_len(
    field: &'static str,
    actual: usize,
) -> Result<u32, MetadataSidecarError> {
    u32::try_from(actual).map_err(|_| MetadataSidecarError::LengthTooLarge { field, actual })
}

/// Builds deterministic binary bytes for future manifest signing.
///
/// The transcript binds album, epoch, encrypted metadata, shard order, shard
/// IDs, tiers, and encrypted shard hashes without exposing plaintext metadata.
///
/// # Errors
/// Returns [`ManifestTranscriptError::EmptyEncryptedMeta`] when no encrypted
/// metadata envelope bytes are supplied, [`ManifestTranscriptError::EmptyShardList`]
/// when no shards are linked, [`ManifestTranscriptError::LengthTooLarge`] when a
/// transcript length cannot fit in `u32`, or
/// [`ManifestTranscriptError::NonSequentialShardIndex`] when sorted shard
/// indices are not exactly sequential from zero.
pub fn canonical_manifest_transcript_bytes(
    transcript: &ManifestTranscript<'_>,
) -> Result<Vec<u8>, ManifestTranscriptError> {
    if transcript.encrypted_meta().is_empty() {
        return Err(ManifestTranscriptError::EmptyEncryptedMeta);
    }
    if transcript.shards().is_empty() {
        return Err(ManifestTranscriptError::EmptyShardList);
    }

    let encrypted_meta_len = u32::try_from(transcript.encrypted_meta().len()).map_err(|_| {
        ManifestTranscriptError::LengthTooLarge {
            field: "encrypted_meta",
            actual: transcript.encrypted_meta().len(),
        }
    })?;
    let shard_count = u32::try_from(transcript.shards().len()).map_err(|_| {
        ManifestTranscriptError::LengthTooLarge {
            field: "shards",
            actual: transcript.shards().len(),
        }
    })?;

    let mut shards = transcript.shards().to_vec();
    shards.sort_by_key(ManifestShardRef::chunk_index);

    let mut bytes = Vec::new();
    bytes.extend_from_slice(MANIFEST_SIGN_CONTEXT);
    bytes.push(MANIFEST_TRANSCRIPT_VERSION);
    bytes.extend_from_slice(transcript.album_id());
    bytes.extend_from_slice(&transcript.epoch_id().to_le_bytes());
    bytes.extend_from_slice(&encrypted_meta_len.to_le_bytes());
    bytes.extend_from_slice(transcript.encrypted_meta());
    bytes.extend_from_slice(&shard_count.to_le_bytes());

    for (expected, shard) in (0_u32..).zip(shards.iter()) {
        if shard.chunk_index() != expected {
            return Err(ManifestTranscriptError::NonSequentialShardIndex {
                expected,
                actual: shard.chunk_index(),
            });
        }

        bytes.extend_from_slice(&shard.chunk_index().to_le_bytes());
        bytes.push(shard.tier().to_byte());
        bytes.extend_from_slice(shard.shard_id());
        bytes.extend_from_slice(shard.sha256());
    }

    Ok(bytes)
}

/// Deterministic public vectors shared by native Rust and platform wrappers.
pub mod golden_vectors {
    use super::{
        EncryptedMetadataEnvelope, ManifestShardRef, ManifestTranscript, ManifestTranscriptError,
        ShardEnvelopeHeader, ShardTier, canonical_manifest_transcript_bytes,
    };

    /// Fixed epoch ID used by the envelope header vector.
    pub const ENVELOPE_EPOCH_ID: u32 = 0x0102_0304;
    /// Fixed shard index used by the envelope header vector.
    pub const ENVELOPE_SHARD_INDEX: u32 = 0x0506_0708;
    /// Fixed public envelope nonce used by the header vector.
    pub const ENVELOPE_NONCE: [u8; 24] = [
        0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e,
        0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27,
    ];

    const MANIFEST_ALBUM_ID: [u8; 16] = [
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
        0x0f,
    ];
    const MANIFEST_EPOCH_ID: u32 = 7;
    const MANIFEST_ENCRYPTED_META: [u8; 3] = [0xaa, 0xbb, 0xcc];

    /// Returns the deterministic serialized envelope header vector.
    #[must_use]
    pub fn envelope_header_bytes() -> [u8; super::SHARD_ENVELOPE_HEADER_LEN] {
        ShardEnvelopeHeader::new(
            ENVELOPE_EPOCH_ID,
            ENVELOPE_SHARD_INDEX,
            ENVELOPE_NONCE,
            ShardTier::Preview,
        )
        .to_bytes()
    }

    /// Returns deterministic canonical manifest transcript bytes.
    ///
    /// The encrypted metadata bytes are fixed ciphertext-like test bytes and do
    /// not contain plaintext photo metadata.
    ///
    /// # Errors
    /// Returns transcript construction errors if the fixed vector stops
    /// satisfying the canonical manifest transcript rules.
    pub fn manifest_transcript_bytes() -> Result<Vec<u8>, ManifestTranscriptError> {
        let shards = [
            shard_ref(1, ShardTier::Original, 0x20, 0x22),
            shard_ref(0, ShardTier::Thumbnail, 0x10, 0x11),
        ];
        let transcript = ManifestTranscript::new(
            MANIFEST_ALBUM_ID,
            MANIFEST_EPOCH_ID,
            EncryptedMetadataEnvelope::new(&MANIFEST_ENCRYPTED_META),
            &shards,
        );

        canonical_manifest_transcript_bytes(&transcript)
    }

    fn shard_ref(
        chunk_index: u32,
        tier: ShardTier,
        first_id_byte: u8,
        hash_byte: u8,
    ) -> ManifestShardRef {
        let mut shard_id = [0_u8; 16];
        for (offset, byte) in shard_id.iter_mut().enumerate() {
            *byte = first_id_byte + offset as u8;
        }

        ManifestShardRef::new(chunk_index, shard_id, tier, [hash_byte; 32])
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

/// Parsed v0x04 streaming shard envelope header.
///
/// Layout (64 bytes): magic `SGzk` (4), version `0x04` (1), tier (1),
/// stream_salt (16), frame_count u32 LE (4), final_frame_size u32 LE (4),
/// reserved zero bytes (34).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamingShardEnvelopeHeader {
    tier: ShardTier,
    stream_salt: [u8; STREAMING_SHARD_SALT_LEN],
    frame_count: u32,
    final_frame_size: u32,
}

impl StreamingShardEnvelopeHeader {
    /// Creates a v0x04 streaming header from validated field values.
    ///
    /// # Errors
    /// Returns [`MosaicDomainError::InvalidHeaderLength`] for zero frames,
    /// empty final frames, or final-frame sizes above 64 KiB.
    pub const fn new(
        tier: ShardTier,
        stream_salt: [u8; STREAMING_SHARD_SALT_LEN],
        frame_count: u32,
        final_frame_size: u32,
    ) -> Result<Self, MosaicDomainError> {
        if frame_count == 0 {
            return Err(MosaicDomainError::InvalidHeaderLength { actual: 0 });
        }
        if final_frame_size == 0 {
            return Err(MosaicDomainError::InvalidHeaderLength { actual: 0 });
        }
        if final_frame_size as usize > STREAMING_SHARD_FRAME_SIZE {
            return Err(MosaicDomainError::InvalidHeaderLength {
                actual: final_frame_size as usize,
            });
        }
        Ok(Self {
            tier,
            stream_salt,
            frame_count,
            final_frame_size,
        })
    }

    /// Parses and validates a raw v0x04 streaming envelope header.
    pub fn parse(bytes: &[u8]) -> Result<Self, MosaicDomainError> {
        if bytes.len() != STREAMING_SHARD_ENVELOPE_HEADER_LEN {
            return Err(MosaicDomainError::InvalidHeaderLength {
                actual: bytes.len(),
            });
        }
        if bytes[0..4] != STREAMING_SHARD_ENVELOPE_MAGIC {
            return Err(MosaicDomainError::InvalidMagic);
        }
        if bytes[4] != SHARD_ENVELOPE_VERSION_V04 {
            return Err(MosaicDomainError::UnsupportedVersion { version: bytes[4] });
        }
        for (relative_offset, value) in bytes[STREAMING_SHARD_RESERVED_OFFSET
            ..STREAMING_SHARD_RESERVED_OFFSET + STREAMING_SHARD_RESERVED_LEN]
            .iter()
            .enumerate()
        {
            if *value != 0 {
                return Err(MosaicDomainError::NonZeroReservedByte {
                    offset: STREAMING_SHARD_RESERVED_OFFSET + relative_offset,
                });
            }
        }
        let tier = ShardTier::try_from(bytes[5])?;
        let mut stream_salt = [0_u8; STREAMING_SHARD_SALT_LEN];
        stream_salt.copy_from_slice(&bytes[6..22]);
        let frame_count = u32::from_le_bytes([bytes[22], bytes[23], bytes[24], bytes[25]]);
        let final_frame_size = u32::from_le_bytes([bytes[26], bytes[27], bytes[28], bytes[29]]);
        Self::new(tier, stream_salt, frame_count, final_frame_size)
    }

    /// Serializes the header to its exact 64-byte wire representation.
    #[must_use]
    pub fn to_bytes(&self) -> [u8; STREAMING_SHARD_ENVELOPE_HEADER_LEN] {
        let mut bytes = [0_u8; STREAMING_SHARD_ENVELOPE_HEADER_LEN];
        bytes[0..4].copy_from_slice(&STREAMING_SHARD_ENVELOPE_MAGIC);
        bytes[4] = SHARD_ENVELOPE_VERSION_V04;
        bytes[5] = self.tier.to_byte();
        bytes[6..22].copy_from_slice(&self.stream_salt);
        bytes[22..26].copy_from_slice(&self.frame_count.to_le_bytes());
        bytes[26..30].copy_from_slice(&self.final_frame_size.to_le_bytes());
        bytes
    }

    /// Returns the shard tier.
    #[must_use]
    pub const fn tier(&self) -> ShardTier {
        self.tier
    }

    /// Returns the per-stream salt.
    #[must_use]
    pub const fn stream_salt(&self) -> &[u8; STREAMING_SHARD_SALT_LEN] {
        &self.stream_salt
    }

    /// Returns the declared frame count.
    #[must_use]
    pub const fn frame_count(&self) -> u32 {
        self.frame_count
    }

    /// Returns the declared final-frame plaintext size.
    #[must_use]
    pub const fn final_frame_size(&self) -> u32 {
        self.final_frame_size
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

    #[test]
    fn exposes_crate_name_for_wrapper_diagnostics() {
        assert_eq!(super::crate_name(), "mosaic-domain");
    }

    #[test]
    fn metadata_sidecar_len_helper_rejects_values_above_u32() {
        if usize::BITS > 32 {
            let actual = u32::MAX as usize + 1;
            let error = match super::checked_metadata_sidecar_len("field_value", actual) {
                Ok(_) => panic!("length above u32 should fail"),
                Err(error) => error,
            };

            assert_eq!(
                error,
                super::MetadataSidecarError::LengthTooLarge {
                    field: "field_value",
                    actual
                }
            );
        }
    }
}
