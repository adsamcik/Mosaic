//! Client-core ADR-018 counter-only telemetry.
//!
//! # Privacy Invariants
//!
//! ## Compile-time enforcement
//! Counter names must be `&'static str` (i.e., compile-time string literals
//! or static-lifetime constants). This prevents runtime-built strings
//! constructed via `format!()`, `String::from()`, etc., which is the
//! most common accidental privacy leak.
//!
//! ## Discipline-based enforcement
//! Compile-time `&'static str` does NOT prevent intentional misuse:
//! a malicious or careless contributor could declare `const USER_42: &str
//! = "user_42";` and pass it as a counter name. The privacy guarantee
//! requires reviewer discipline plus the documented counter naming convention
//! (see SPEC-ClientCoreStateMachines.md §"Telemetry counter names").
//!
//! ## Privacy classes by counter category
//! - State-machine inflection counters (e.g.,
//!   `manifest_commit_unknown_retry_rejected`): public protocol-level events;
//!   aggregable; no identifier.
//! - User actions (e.g., `share_link_minted`): aggregable count of operations,
//!   not the identifiers operated upon.
//! - Forbidden patterns: counters whose names embed user IDs, asset IDs,
//!   IP addresses, or any other PII. Reviewers must reject PRs that introduce
//!   such patterns.

use std::collections::{HashMap, VecDeque};

/// Compile-time-known ADR-018 counter names.
///
/// These names are intentionally static, snake_case strings. Because
/// [`TelemetryRingBuffer::increment`] accepts only `&'static str`, callers
/// cannot pass runtime-formatted identifiers. Reviewers must still reject
/// static names that embed correlatable identifiers or other PII.
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

    /// Increments a counter.
    ///
    /// If the buffer is at capacity and `name` is new, the
    /// least-recently-incremented counter is evicted.
    ///
    /// # Privacy invariant
    ///
    /// Counter names must be `&'static str`. This is a compile-time-enforced
    /// invariant for runtime-built strings: values constructed via
    /// `format!()`, `String::from()`, or other heap/runtime mechanisms cannot
    /// be passed because their lifetime is shorter than `'static`.
    ///
    /// ```compile_fail,E0716
    /// use mosaic_client::telemetry::TelemetryRingBuffer;
    ///
    /// let mut buf = TelemetryRingBuffer::new(8);
    /// let id = 42;
    /// buf.increment(&format!("user_{}", id));
    /// ```
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
