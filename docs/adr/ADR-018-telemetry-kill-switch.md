# ADR-018: Telemetry / kill-switch design

## Status

Accepted. Governs every telemetry, diagnostic, error-reporting, and remote-flag surface introduced by the Rust core completion programme. Required by W-A5 (web feature flag + staged rollout) and A-Lane (Android upload pipeline).

## Context

The Rust core completion programme introduces several surfaces that need *some* form of remote signal:

- **W-A5** stages the `RustUploadAdapter` rollout per cohort and needs a kill-switch in case a regression escapes G3/G3.5.
- **A4 / A10 / A11** want to know when a network call fails so the upload state machine can report failure modes.
- **R-Cl1's `LegacyRawKeyDecryptFallback`** (per ADR-021) emits a code when a legacy ciphertext is decrypted, which is the input to the sunset gate.
- **Q-final-4** wants performance budgets that the team can monitor.

The 3-reviewer pass (`files/reviews/R3-opus47-coherence.md`) flagged that:

- Mosaic's threat model (ADR-002) explicitly forbids new server-driven channels that could violate zero-knowledge.
- "Opaque error codes only" was stated as principle but no ADR codified it.
- A kill-switch driven by the server creates exactly the kind of trust-on-first-use channel the threat model rejects.
- Telemetry is repeatedly mentioned but has no documented sampling, retention, or PII boundary.

This ADR is the single source of truth for these decisions.

## Decision

Mosaic adopts **opaque-error-codes-only telemetry**, **operator-collected (not Mosaic-collected) usage signals**, and **client-local kill-switches with no server-driven flag channel**.

### Telemetry posture (web + Android)

#### What is *never* collected

- User content (plaintext or encrypted),
- file names, captions, EXIF, GPS, device metadata,
- account / identity / session / handle identifiers,
- album IDs, photo IDs, manifest IDs, shard IDs,
- IP addresses (server-visible by definition; not augmented),
- precise timestamps tied to user actions (only coarse buckets),
- crash payloads with body bytes, headers, URLs, or stack-frame variable values,
- third-party analytics SDK signals.

#### What is collected (locally first)

A **stable, append-only, opaque error code** plus minimal context:

```rust
struct DiagnosticEvent {
    code: ClientErrorCode,           // u16, append-only registry (R-C1)
    phase: u8,                        // upload/sync state-machine phase
    retry_count: u8,
    elapsed_bucket_ms: u32,           // bucketed: <100, <500, <1500, <5000, <30000, ≥30000
    client_version: u32,              // build number
    schema_version: u16,              // snapshot schema in use
    correlation_id: Uuid,             // session-local UUID; not persisted across sessions
}
```

These events are collected **locally only** by default. They live in a bounded ring buffer (last 1000 events on web; last 5000 on Android in Room) and are wiped on logout.

#### What ships to operators (opt-in only)

If the user explicitly opts into "Anonymous diagnostics" in Settings:

- The local ring buffer is aggregated weekly into `(code, phase, count_in_period)` tuples *plus* an aggregate `decrypt_op_total` counter (see "Counter set" below).
- Aggregates are uploaded to the operator's `POST /api/diagnostics` endpoint (one request per week per user; client schedules with reducer-supplied jitter to avoid synchronized peaks).
- Aggregates are encrypted as a **libsodium sealed box** (`crypto_box_seal`, X25519 + XChaCha20-Poly1305) to the **operator diagnostic public key** — a long-term X25519 public key (32 bytes) compiled into the client at build time via `operatorConfig.diagnosticPublicKey` (sibling to the cert pins per ADR-019). The corresponding private key is held by the operator's diagnostics service; it is **separate from the operator's TLS cert chain and from any user account key**, and is rotated by operator-controlled build updates following the same lifecycle as the cert pins. No key in the user's L0–L3 hierarchy is reused.
- No correlation_id, no per-event timestamps. Operators see weekly counts only.

If `operatorConfig.diagnosticPublicKey` is absent from the build (operator opted out of collecting diagnostics), the client opt-in toggle is hidden in Settings; users cannot opt in to a non-existent endpoint. Mosaic-main reference build ships a placeholder key that fails-closed (sealed box opens to garbage server-side; logged as deployment misconfiguration).

This is the *only* path by which any client-side signal reaches a server.

#### Counter set (locally first; only `count_in_period` aggregates uploaded under opt-in)

```rust
struct DiagnosticEvent {
    code: ClientErrorCode,           // u16, append-only registry (R-C1)
    phase: u8,                        // upload/sync state-machine phase
    retry_count: u8,
    elapsed_bucket_ms: u32,           // bucketed: <100, <500, <1500, <5000, <30000, ≥30000
    schema_version: u16,              // snapshot schema in use
    correlation_id: Uuid,             // session-local UUID; not persisted across sessions
}

struct DiagnosticCounters {
    // Per-event counts (kept in ring buffer; aggregated weekly under opt-in).
    events: Vec<DiagnosticEvent>,
    // Aggregate counters (denominators for ratio metrics like ADR-021's sunset gate).
    decrypt_op_total: u64,            // every successful or failed shard/album-content/sidecar decrypt
    encrypt_op_total: u64,            // every successful or failed encrypt
    upload_job_started_total: u64,
    upload_job_completed_total: u64,
    sync_page_applied_total: u64,
}
```

Note: `client_version` is **not** included in `DiagnosticEvent` to avoid fingerprinting risk for small-cohort builds. Aggregate uploads carry one `client_version` *per upload* (in the request envelope, not per-event) so operators can correlate observed rates with build cohorts; this is unavoidable since the operator must know which builds reported which counts. Operators are documented to bucket reports by `(client_version, week)` only; per-user retention is forbidden by the operator playbook.

The aggregate counters (`decrypt_op_total` etc.) are the **denominators** that make ratio gates (e.g. ADR-021's "≤ 0.01% of all decrypt operations") measurable; without them the rate is undefined.

#### Operator-side responsibilities

Operators collecting opted-in diagnostics MUST:
1. Document retention (recommended: ≤ 90 days).
2. Document aggregation and reporting practices.
3. Not correlate diagnostic events with other server-side logs in ways that defeat the privacy posture.
4. Not require diagnostics for service access.

### Kill-switch design (no server-driven channel)

#### What is forbidden

- A server endpoint that pushes a "disable feature X" flag to the client.
- A server response that includes a hidden field interpreted as a feature toggle.
- Any "remote configuration" service.

These are forbidden because they create a channel through which a compromised or coerced server could disable security-critical features (like encryption) or steer the client into vulnerable code paths.

#### What is allowed (client-local kill-switches)

- A **local feature flag store** in IndexedDB / Room, set by the user's "Settings → Advanced" panel, which exposes a "Use legacy adapter" toggle so power-users can self-rollback without an app update.
- A **build-time flag** (`BuildConfig.ENABLE_RUST_UPLOAD_ADAPTER`) per release variant, controllable by operator at build time.
- A **build-time date-parameterized cohort dial** in the W-A5 / A-Lane rollout. The build embeds `cohortDialSchedule = [(date_2026_06_01, 5), (date_2026_06_15, 25), (date_2026_07_01, 100)]` (percentage by date). On launch, the client computes its cohort once per session as `(percentile = stable_local_hash(install_id) % 100)` and admits Rust adapter iff the current date's percentage threshold has been reached. **A single build can therefore stage 5% → 25% → 100% deterministically over time without operator-pushed flags or app updates.** Operators ship the full schedule at build time.
- A **disable-on-error fail-closed**: if `RustUploadAdapter` raises a non-retryable internal-state error **5 times in one session** (specific N — chosen to balance flaky-network noise vs prompt fail-closed), the client locally reverts to the legacy adapter for the rest of the session (web only; Android has no legacy adapter). The fail-closed event is recorded in the local ring buffer; under opt-in, the operator sees it the following week.

#### What if a critical bug needs urgent rollback?

The operator pushes an **app update**: that is the channel. There is no faster path. Operators must plan release cadence with this in mind.

For self-hosted operators with bounded user bases, two mitigations are operationally available:
1. The build-time date-parameterized cohort dial above lets a single in-the-wild build automatically *fail forward* on a date — operators can roll back by shipping a build whose schedule's later dates revert to 0%.
2. The user-controlled "Use legacy adapter" toggle lets affected power-users self-rollback during the operator's rebuild-and-redistribute window.

For SaaS-style mass deployments, this is the same trade-off Signal and similar privacy-respecting clients accept: rollback is bounded by app-store cadence.

### Performance metrics (Q-final-4)

Performance budgets are monitored via:

- **CI-time budgets** on representative fixtures (Q-final-4's matrix). These run pre-merge; regressions block merge.
- **Local runtime budgets** in development builds: a Rust panic / `tracing::warn!` fires if a budget is exceeded, with no payload other than the exceeded budget name.
- **No production runtime budgets** that report to a server. Production users' performance experience is monitored only through opted-in diagnostics aggregates.

### Crash reporting

- **Default off.** Production builds do not auto-upload crashes.
- **Opt-in.** Same pathway as diagnostics aggregates: weekly upload of `(crash_signature, count)` to `POST /api/diagnostics/crashes` if the user opts in.
- **No stack traces with variable values.** Crash signatures are pre-redacted (file + line + class hash + ClientErrorCode if reachable).
- **No ANR auto-reporting.** Android ANRs go to logcat (per `android-no-direct-log` posture, only the redacted-logger wrapper) and to the local diagnostic ring buffer; not to the operator without opt-in.

## Options Considered

### Standard analytics SDK (Firebase, Sentry, etc.)

- Pros: rich tooling; off-the-shelf.
- Cons: introduces a third-party data-handling vector contradicting Mosaic's privacy posture; SDKs are notorious for over-collection; cannot be reasonably audited; rejected.
- Conviction: 1/10.

### Operator-server-pushed remote configuration

- Pros: instant kill-switch; no app update needed.
- Cons: creates a server-trusted channel that violates the threat model; if the server is compromised, attacker can disable encryption per-user; rejected.
- Conviction: 1/10.

### No telemetry at all

- Pros: maximum privacy.
- Cons: programme cannot measure ADR-021 sunset gate; rollout regressions (W-A5) detected only by user complaints; performance regressions invisible.
- Conviction: 4/10.

### Local-only opaque codes + opt-in operator aggregates + no remote kill-switch (this decision)

- Pros: zero new server-trust channels; user opt-in is meaningful (default off, simple toggle, clear scope); operators get the signals they need to operate; performance budgets enforced at CI; legacy fallback sunset measurable.
- Cons: rolling out fixes requires app updates (app store cadence); operators must build aggregation infrastructure if they want signals.
- Conviction: 9/10.

## Consequences

- A new endpoint `POST /api/diagnostics` is allowed (reference implementation in backend); operator-controlled retention.
- ClientErrorCode (R-C1) is the canonical input to telemetry; new variants imply telemetry implications and must be reviewed.
- The local diagnostic ring buffer (web IDB / Android Room) is wiped on logout; persists across app restarts within a session.
- W-A5 / A-Lane do not implement a server-driven kill-switch; they implement local fail-closed and cohort gates.
- Static guards reject any client code that:
  - reads server response fields named `feature_*`, `flag_*`, `enabled_*`, etc., into client-state branching,
  - constructs `OkHttpClient`s with logging interceptors that capture body bytes,
  - serializes any sensitive class to a diagnostic event.
- `docs/SECURITY.md` adds a "Telemetry posture" section.
- Q-final-4 performance budgets are enforced at CI; local runtime asserts are dev-build-only.
- The "Operator network privacy" section of `docs/DEPLOYMENT.md` documents how operators handle opted-in diagnostic uploads.
- ADR-021 sunset gate's "≤ 0.01% rate" measurement is operator-collected aggregates, in line with this ADR.

## Reversibility

The telemetry posture is reversible by ADR amendment. The kill-switch design is harder to reverse: introducing a server-driven channel post-v1 would require redoing the threat-model review and would likely require a major version bump. The opt-in default cannot be flipped without significant user re-consent overhead.
