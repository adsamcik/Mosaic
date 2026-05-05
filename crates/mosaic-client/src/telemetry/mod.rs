use std::collections::{HashMap, VecDeque};

/// Compile-time-known ADR-018 counter names.
///
/// These names are intentionally static, snake_case strings. Callers cannot
/// pass runtime-formatted identifiers, network strings, UUIDs, asset IDs,
/// album IDs, account IDs, encrypted bytes, or any other correlatable payload
/// through [`TelemetryRingBuffer::increment`], because it accepts only
/// `&'static str`.
pub mod counters {
    /// Generic RetryableFailure was rejected while recovering an unknown
    /// manifest commit outcome.
    pub const MANIFEST_COMMIT_UNKNOWN_RETRY_REJECTED: &str =
        "manifest_commit_unknown_retry_rejected";

    /// AlbumSync exhausted retry budget while preserving the originating error
    /// code rather than replacing it with a default retry-budget code.
    pub const ALBUM_SYNC_EXHAUSTION_WITH_ORIGINATING_CODE: &str =
        "album_sync_exhaustion_with_originating_code";

    /// Legacy upload snapshot retry target migrated from RetryWaiting back to
    /// ManifestCommitUnknown.
    pub const LEGACY_RETRY_WAITING_MANIFEST_COMMIT_UNKNOWN_MIGRATED: &str =
        "legacy_retry_waiting_manifest_commit_unknown_migrated";

    /// Duplicate effect acknowledgement was dropped without mutating state.
    pub const EFFECT_ACK_DEDUP_DROP: &str = "effect_ack_dedup_drop";
}

/// Telemetry serialization failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TelemetryError {
    /// CBOR serialization failed.
    SerializationFailed,
}

/// Bounded ring buffer for client-side counter metrics.
///
/// Per ADR-018: counters are aggregable, not user-correlatable. No payloads,
/// only counter increment events.
#[derive(Debug, Clone)]
pub struct TelemetryRingBuffer {
    counters: HashMap<String, u64>,
    recency: VecDeque<String>,
    capacity: usize,
    enabled: bool,
}

impl TelemetryRingBuffer {
    /// Default maximum number of distinct counter names retained locally.
    pub const DEFAULT_CAPACITY: usize = 256;

    /// Create an enabled telemetry ring buffer with the given distinct-counter
    /// capacity.
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        Self {
            counters: HashMap::new(),
            recency: VecDeque::new(),
            capacity,
            enabled: true,
        }
    }

    /// Increment a counter. If buffer is at capacity and `name` is new, the
    /// least-recently-incremented counter is evicted.
    pub fn increment(&mut self, name: &'static str) {
        if !self.enabled || self.capacity == 0 {
            return;
        }

        let existing = if let Some(value) = self.counters.get_mut(name) {
            *value = value.saturating_add(1);
            true
        } else {
            false
        };
        if existing {
            self.mark_recent(name);
            return;
        }

        if self.counters.len() >= self.capacity {
            self.evict_lru();
        }
        if self.counters.len() < self.capacity {
            self.counters.insert(name.to_owned(), 1);
            self.recency.push_back(name.to_owned());
        }
    }

    /// Return a deterministic name-sorted snapshot of retained counters.
    #[must_use]
    pub fn snapshot(&self) -> Vec<(String, u64)> {
        if !self.enabled {
            return Vec::new();
        }

        let mut snapshot = self
            .counters
            .iter()
            .map(|(name, count)| (name.clone(), *count))
            .collect::<Vec<_>>();
        snapshot.sort_unstable_by(|(left, _), (right, _)| left.cmp(right));
        snapshot
    }

    /// Reset all counters to zero (for kill-switch / opt-out).
    pub fn reset(&mut self) {
        self.counters.clear();
        self.recency.clear();
    }

    /// Serialize counters as CBOR for the diagnostic ring buffer per ADR-018.
    ///
    /// R-C3.1 stops at the local CBOR payload. Operator upload wrapping remains
    /// the platform adapter's responsibility because ADR-018 requires an
    /// operator-configured X25519 diagnostic public key outside this crate.
    pub fn to_diagnostic_payload(&self) -> Result<Vec<u8>, TelemetryError> {
        let mut payload = Vec::new();
        ciborium::ser::into_writer(&self.snapshot(), &mut payload)
            .map_err(|_| TelemetryError::SerializationFailed)?;
        Ok(payload)
    }

    /// Enable or disable telemetry collection at runtime.
    pub fn set_enabled(&mut self, enabled: bool) {
        if !enabled {
            self.reset();
        }
        self.enabled = enabled;
    }

    /// Return whether telemetry collection is enabled.
    #[must_use]
    pub const fn is_enabled(&self) -> bool {
        self.enabled
    }

    fn mark_recent(&mut self, name: &'static str) {
        self.recency.retain(|existing| existing != name);
        self.recency.push_back(name.to_owned());
    }

    fn evict_lru(&mut self) {
        while let Some(name) = self.recency.pop_front() {
            if self.counters.remove(&name).is_some() {
                return;
            }
        }
    }
}

impl Default for TelemetryRingBuffer {
    fn default() -> Self {
        Self::new(Self::DEFAULT_CAPACITY)
    }
}
