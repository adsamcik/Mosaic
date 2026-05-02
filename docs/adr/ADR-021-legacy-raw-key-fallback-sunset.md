# ADR-021: Legacy raw-key shard fallback sunset (D5)

## Status

Accepted. Closes plan v2 decision D5. Governs the lifetime and sunset of `decrypt_shard_with_legacy_raw_key_handle` introduced in R-C3.

## Context

Pre-tier-key Mosaic ciphertexts (uploaded before the tier-key era was canonicalized in `SPEC-RustEpochTierKeys.md`) used the **epoch seed directly as the AEAD key** rather than tier-derived keys. The current TypeScript shard decrypt path (`apps/web/src/workers/crypto.worker.ts`) implements a fallback: try tier keys first, then fall back to the raw epoch seed.

The Rust core completion programme's R-C3 ticket migrates this fallback into Rust **without exposing raw seeds across FFI**: the legacy decrypt happens inside the secret registry (`decrypt_shard_with_legacy_raw_key_handle(handle, envelope)`), pulling the seed *internally* and emitting telemetry code `LegacyRawKeyDecryptFallback` whenever it succeeds. This satisfies the no-raw-secret-FFI invariant (ADR-006) while preserving backward compatibility for legacy data.

The 3-reviewer pass (`files/reviews/R3-opus47-coherence.md`) flagged that the fallback's lifetime is itself a decision: keeping it forever creates a permanent downgrade path that an attacker could probe; sunsetting it requires a migration window with telemetry-driven evidence that no production data still depends on it.

This ADR commits to the sunset path.

## Decision

The legacy raw-key shard fallback is **retained for v1** and **scheduled for sunset** in v1.x according to the telemetry-gated procedure below.

### Sunset gate (telemetry-driven)

The fallback is removed from production code only when **all** of the following are true. The gate metrics are computed against ADR-018's `DiagnosticCounters` aggregate fields (`decrypt_op_total` denominator + `LegacyRawKeyDecryptFallback` event count numerator); both are operator-collected under user opt-in.

1. **Rate gate.** Across all opt-in clients running build `≥ tier_key_canonical_build`, the global ratio `sum(LegacyRawKeyDecryptFallback events) / sum(decrypt_op_total)` is **≤ 0.01% for ≥ 90 consecutive days**, computed over weekly aggregate windows.
2. **Zero-rate streak gate.** Across all opt-in clients running build `≥ tier_key_canonical_build`, **30 consecutive days of zero `LegacyRawKeyDecryptFallback` events**. This gate uses no album-creation-timestamp PII (which ADR-018 forbids); instead it uses the client build version (already present in the aggregate envelope per ADR-018) as the cutover proxy: a client running `≥ tier_key_canonical_build` cannot have created any *new* legacy ciphertexts, so persistent fallback events from such builds indicate residual *old* data that has not been re-secured.
3. **Re-encryption pass complete.** Affected users have received in-app prompts to "Re-secure old albums" (silent client-side migration; runs in the background under the existing upload state machine, no user wait).
4. **Dual-build evidence.** Internal-test build with the fallback removed has run for ≥ 30 days against representative sample data without `ShardIntegrityFailed` regressions.

The numeric `tier_key_canonical_build` constant is fixed by the v1.x sunset ADR (not this one); it identifies the first release in which all upload paths use tier keys exclusively.

When all gates pass:

- A v1.x ADR ("Sunset legacy raw-key shard fallback — telemetry evidence") records the cutover.
- `decrypt_shard_with_legacy_raw_key_handle` is removed from `mosaic-crypto`, the Rust ClientErrorCode `LegacyRawKeyDecryptFallback` is **retired** (not removed from the table — codes are append-only — but documented as inactive), and the corresponding telemetry counter is removed.
- WASM and UniFFI exports for the fallback are dropped; boundary guards reject any reintroduction.

### Self-selection bias (acknowledged operational risk)

Only opted-in users contribute to the rate. Privacy-conscious users (the most likely to opt out) overlap with users likely to *re-secure old albums proactively*; resulting telemetry skews the rate downward. Two operator-side mitigations are documented in `docs/SECURITY.md`:

1. Operators are instructed to apply a **conservative correction factor** (multiply observed rate by an opt-in-share scaling, default ×3) before evaluating gate #1.
2. The 30-consecutive-days-zero-events gate (#2) is harder to satisfy than the rate gate; a single fallback event from any opted-in client resets the streak. This conservatively bounds the false-pass rate.

If neither mitigation is operationally feasible, operators are documented to extend the retention period rather than rely on a noisy signal — gate #4's hard-cutoff fallback applies.

### User-warning mechanism for residual legacy data

Before any sunset:

- Affected users (those whose accounts still own legacy ciphertexts after the re-encryption pass) receive a **persistent in-app banner** ≥ 90 days before the planned sunset.
- The banner explicitly names which albums contain unmigrated legacy shards (where decryption-on-render produced a fallback event in the past 90 days).
- Users can trigger an immediate re-encryption sweep from the banner.
- Operators are documented to coordinate banner cadence with their user base; for self-hosted deployments, the operator may extend the retention window indefinitely if the user base requires it.

### Telemetry posture (per ADR-018)

The fallback emits `LegacyRawKeyDecryptFallback` as a stable opaque error code via the local-only telemetry channel. The signal is:
- **Frequency only.** Counts of fallback events per session, not per shard.
- **No content metadata.** No album_id, no shard_id, no timestamps tied to user-identifying data.
- **No server delivery without explicit opt-in.** Per ADR-018, telemetry stays local unless the user opts into anonymous diagnostics.
- **Aggregated reporting.** When a user opts in, the operator receives only `(client_version, fallback_count_per_session)` aggregated weekly.

This means the sunset gate's "≤ 0.01% rate" measurement is operator-side, not Mosaic-protocol-side, and operators are responsible for collecting the telemetry from opted-in users.

### Behavior during the v1 retention period

- Every successful fallback emits the telemetry code.
- The fallback **never** runs as a first attempt: tier-key decrypt is always tried first; fallback is invoked only on tier-key failure.
- The fallback is **read-only**: it can decrypt legacy shards but never re-encrypts using raw seeds. New shards are always tier-key-encrypted.
- The fallback is **logged** at DEBUG level (Rust `tracing::debug!` if telemetry is enabled, never at INFO/WARN/ERROR). Production builds with telemetry disabled keep the fallback silent except for the protocol error code.
- Backup re-encryption (gate #3) is implemented as an opportunistic background task: when a legacy shard is decrypted for any reason (display, share, download), the client also schedules a re-encryption job that uploads the same plaintext under tier keys, then archives the legacy shard reference.
- The fallback **cannot** be exercised remotely: it is triggered only by encrypted bytes already on disk that fail tier-key decrypt; an attacker without the epoch seed cannot synthesize a legacy ciphertext.

### Hard cutoff

If the telemetry gates do not all pass within **3 years** of v1 ship date, a separate ADR will decide either to extend the retention period (with documented justification) or to force-sunset the fallback (with the consequence that some legacy shards become permanently inaccessible — users who never re-secured their old albums lose access to those shards specifically).

## Options Considered

### Keep the fallback forever

- Pros: zero operational burden; legacy data always accessible.
- Cons: permanent downgrade path increases attack surface; tier-key invariant has a permanent exception; auditability suffers.
- Conviction: 3/10.

### Remove the fallback at G6 (this programme)

- Pros: cleanest cutoff; matches programme's "single source of truth" ethic.
- Cons: legacy data instantly inaccessible to users who haven't re-secured old albums; UX disaster; bricks share links pointing at legacy ciphertexts.
- Conviction: 2/10.

### Telemetry-gated sunset with re-encryption migration (this decision)

- Pros: legacy data preserved during migration window; telemetry provides quantitative evidence for the sunset; users keep working without manual intervention; 3-year hard cutoff bounds the long tail.
- Cons: fallback code lives in `mosaic-crypto` for an extended period; some operational burden (telemetry collection, re-encryption job scheduling).
- Conviction: 9/10.

### Force-migration via a "re-secure now" required prompt

- Pros: bounds the migration window tightly.
- Cons: user-hostile; risks data loss if migration fails; share-link recipients can't be migrated this way.
- Conviction: 4/10.

## Consequences

- R-C3 implements `decrypt_shard_with_legacy_raw_key_handle` per the rules above.
- R-C1 allocates `ClientErrorCode = LegacyRawKeyDecryptFallback` (numeric value frozen, append-only).
- ADR-018 telemetry channel includes the `LegacyRawKeyDecryptFallback` counter; no PII; aggregated reporting only.
- W-S2 (web download cutover) wires the fallback into the photo / album / shared-album download flow, transparently.
- A-Lane upload pipeline does **not** call the fallback: Android only encrypts new (tier-keyed) shards. The fallback is read-only.
- A future v1.x ticket implements the re-encryption background job per gate #3.
- A future v1.x ADR records the sunset evidence and removes the fallback from production code.
- The `no-raw-secret-ffi-export` CI guard explicitly allowlists *only* the inside-registry path; any new raw-key API attempt fails CI.
- Operators self-hosting Mosaic are documented in `docs/SECURITY.md` to understand the legacy-fallback retention period.

## Reversibility

High during the retention window: the sunset can be delayed or accelerated by ADR amendment based on observed telemetry. Once the v1.x sunset ADR fires and the fallback is removed, reintroducing it would require a new ADR justifying the regression and is not expected to happen.
