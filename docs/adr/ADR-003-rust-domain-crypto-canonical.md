# ADR-003: Make Rust domain and crypto contracts canonical

## Status

Accepted

## Context

Current Mosaic crypto and protocol behavior is implemented primarily in TypeScript. Android support needs the same behavior without duplicating key derivation, envelope parsing, manifest signing, upload lifecycle rules, and sync/decrypt verification in Kotlin.

Mosaic is unreleased, so the Rust implementation may intentionally define a clean v1 protocol where doing so improves security, testability, or maintainability.

## Decision

Rust domain and crypto crates will become canonical for:

- account unlock and key derivation contracts,
- KDF profile validation and downgrade rejection,
- domain-separation labels,
- canonical byte encoding of security-critical transcripts,
- envelope build/parse/encrypt/decrypt/verify,
- manifest canonicalization, signing, and verification,
- upload and sync state machines,
- FFI secret-boundary enforcement,
- golden-vector generation and verification.

The TypeScript implementation remains available during migration only as a reference oracle and rollback path. After Android uploads decrypt on web and web uploads decrypt on Android through Rust-backed paths, TypeScript production crypto can be removed in a dedicated cleanup phase.

## Options Considered

### Preserve TypeScript as permanent canonical implementation

- Pros: avoids immediate rewrite.
- Cons: Android must chase browser-specific behavior; protocol drift likely; no single cross-client vector runner.
- Conviction: 2/10.

### Make Rust crypto canonical but leave manifests/state machines per frontend

- Pros: reduces duplicate primitive handling.
- Cons: manifest serialization and lifecycle transitions remain security-sensitive duplicate logic.
- Conviction: 6/10.

### Make Rust domain, crypto, and client state machines canonical

- Pros: one implementation owns the full security-critical path; vectors cover native, WASM, and Android wrappers.
- Cons: requires more careful FFI and build tooling.
- Conviction: 9/10.

## Consequences

- Security-critical transcripts use canonical binary encoding owned by `mosaic-domain`, not ad hoc JSON.
- Golden vectors become the coordination mechanism between Rust, WASM, Android, backend API tests, and the temporary TypeScript reference.
- Breaking protocol changes are allowed pre-release but must update vector schemas and dependent worktrees.
- Platform code may request high-level operations but must not assemble cryptographic transcripts itself.

## Reversibility

Phased. Before Rust-backed web and Android interoperability is proven, the web app can keep its current TypeScript crypto path. After the cutover, reverting to TypeScript would be a deliberate architecture reversal and would require a new ADR.
