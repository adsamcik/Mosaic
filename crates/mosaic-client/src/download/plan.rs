use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use mosaic_domain::ShardTier;

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PhotoId(String);

impl PhotoId {
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn fallback_filename(&self) -> String {
        let prefix: String = self.0.chars().take(8).collect();
        format!("photo-{prefix}.jpg")
    }
}

impl fmt::Display for PhotoId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ShardId([u8; 16]);

impl ShardId {
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

pub type ShardSha256 = [u8; 32];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadShardInput {
    pub shard_id: ShardId,
    pub epoch_id: u32,
    pub tier: ShardTier,
    pub expected_hash: ShardSha256,
    pub declared_size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadPlanInput {
    pub photo_id: PhotoId,
    pub filename: String,
    pub shards: Vec<DownloadShardInput>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadPlanEntry {
    pub photo_id: PhotoId,
    pub epoch_id: u32,
    pub tier: ShardTier,
    pub shard_ids: Vec<ShardId>,
    pub expected_hashes: Vec<ShardSha256>,
    pub filename: String,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DownloadPlan {
    pub entries: Vec<DownloadPlanEntry>,
}

impl DownloadPlan {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadPlanError {
    DisallowedTier { photo_id: PhotoId, tier: ShardTier },
    MultiEpochPhoto { photo_id: PhotoId, epochs: Vec<u32> },
    PhotoHasNoShards { photo_id: PhotoId },
    SizeOverflow { photo_id: PhotoId },
}

#[derive(Debug, Clone, Default)]
pub struct DownloadPlanBuilder {
    photos: Vec<DownloadPlanInput>,
}

impl DownloadPlanBuilder {
    #[must_use]
    pub fn new() -> Self {
        Self { photos: Vec::new() }
    }

    #[must_use]
    pub fn with_photo(mut self, photo: DownloadPlanInput) -> Self {
        self.photos.push(photo);
        self
    }

    pub fn build(self) -> Result<DownloadPlan, DownloadPlanError> {
        let mut used_names: BTreeMap<String, u32> = BTreeMap::new();
        let mut entries = Vec::with_capacity(self.photos.len());
        for photo in self.photos {
            if photo.shards.is_empty() {
                return Err(DownloadPlanError::PhotoHasNoShards {
                    photo_id: photo.photo_id,
                });
            }
            let mut epochs = BTreeSet::new();
            let mut shard_ids = Vec::with_capacity(photo.shards.len());
            let mut expected_hashes = Vec::with_capacity(photo.shards.len());
            let mut total_bytes = 0_u64;
            for shard in &photo.shards {
                if shard.tier != ShardTier::Original {
                    return Err(DownloadPlanError::DisallowedTier {
                        photo_id: photo.photo_id.clone(),
                        tier: shard.tier,
                    });
                }
                epochs.insert(shard.epoch_id);
                shard_ids.push(shard.shard_id);
                expected_hashes.push(shard.expected_hash);
                total_bytes = total_bytes
                    .checked_add(shard.declared_size)
                    .ok_or_else(|| DownloadPlanError::SizeOverflow {
                        photo_id: photo.photo_id.clone(),
                    })?;
            }
            if epochs.len() > 1 {
                return Err(DownloadPlanError::MultiEpochPhoto {
                    photo_id: photo.photo_id,
                    epochs: epochs.into_iter().collect(),
                });
            }
            let Some(epoch_id) = epochs.into_iter().next() else {
                return Err(DownloadPlanError::PhotoHasNoShards {
                    photo_id: photo.photo_id,
                });
            };
            let sanitized = sanitize_download_filename(&photo.filename, &photo.photo_id);
            let filename = deduplicate_filename(sanitized, &mut used_names);
            entries.push(DownloadPlanEntry {
                photo_id: photo.photo_id,
                epoch_id,
                tier: ShardTier::Original,
                shard_ids,
                expected_hashes,
                filename,
                total_bytes,
            });
        }
        Ok(DownloadPlan { entries })
    }
}

#[must_use]
pub fn sanitize_download_filename(input: &str, photo_id: &PhotoId) -> String {
    let mut sanitized = String::with_capacity(input.len());
    for ch in input.chars() {
        if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || ch <= '\u{1f}' {
            sanitized.push('_');
        } else {
            sanitized.push(ch);
        }
    }
    let trimmed = sanitized.trim().trim_end_matches(['.', ' ']).to_owned();
    let candidate = if trimmed.is_empty() {
        photo_id.fallback_filename()
    } else {
        trimmed
    };
    disambiguate_windows_reserved_name(candidate)
}

fn disambiguate_windows_reserved_name(filename: String) -> String {
    let dot_index = filename.rfind('.');
    let stem = dot_index.map_or(filename.as_str(), |index| &filename[..index]);
    let upper = stem.to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.as_bytes()[3].is_ascii_digit()
            && upper.as_bytes()[3] != b'0');
    if !reserved {
        return filename;
    }
    match dot_index {
        Some(index) => format!("{}_{}", &filename[..index], &filename[index..]).replace("_.", "_."),
        None => format!("{filename}_"),
    }
}

fn deduplicate_filename(filename: String, used_names: &mut BTreeMap<String, u32>) -> String {
    let count = used_names.get(&filename).copied().unwrap_or(0);
    used_names.insert(filename.clone(), count.saturating_add(1));
    if count == 0 {
        return filename;
    }
    let suffix = count + 1;
    match filename.rfind('.') {
        Some(dot_index) => format!(
            "{} ({suffix}){}",
            &filename[..dot_index],
            &filename[dot_index..]
        ),
        None => format!("{filename} ({suffix})"),
    }
}
