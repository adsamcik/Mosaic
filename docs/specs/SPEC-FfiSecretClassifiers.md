# SPEC-FfiSecretClassifiers

> **Status**: v1.
> **Source**: R-C5.5 audit (commit `2d17c47`); locked here.
> **Sister SPECs**: SPEC-R-C5.5-MigrationDesign.md, SPEC-AeadDomainSeparation.md, ADR-006.

## 1. Purpose

The architecture-guard scripts at `tests/architecture/no-raw-secret-ffi-export.{ps1,sh}` and `tests/architecture/web-raw-input-ffi.{ps1,sh}` enforce that any FFI symbol matching the secret-shaped-name pattern, or returning bytes-typed values from a domain-noun-name function, must either be forbidden (script fails) or carry an explicit allowlist entry with a classifier and a rationale.

This SPEC locks the classifier vocabulary to a closed set, defines the threat-model semantic each classifier asserts, and defines the rationale standard per classifier.

## 2. Classifier Set (Closed, v1-Locked)

The complete classifier vocabulary is:

| Classifier | Semantic | Cardinality |
|---|---|---|
| `SAFE` | Symbol returns or accepts data that is publicly observable, encrypted, signed, or handle-scoped and poses no compositional attack risk. | Many |
| `BEARER-TOKEN-PERMITTED` | Symbol returns or accepts a bearer credential by design. The threat model is bearer-token: anyone with the bytes has access. The bytes are intended to be externally serialized into a user-shareable URL or similar artifact. | Few (≤3 expected at v1) |
| `CORPUS-DRIVER-ONLY` | Symbol exists only for cross-client parity testing and is feature-gated out of production builds via Cargo `cross-client-vectors` feature. The Gradle invariant in `apps/android-main/build.gradle.kts` forbids scheduling test and production tasks in the same invocation. | Few (≤5 expected at v1) |
| `MIGRATION-PENDING` | Symbol is a tracked migration target with a sibling ticket. Time-limited classifier; it must resolve to one of the above before v1 freeze. | Zero at v1 freeze |

No other classifier is permitted. Any new classifier requires an amendment to this SPEC and synchronized mechanical enforcement in both PowerShell and Bash architecture guards.

## 3. Rationale Standard Per Classifier

Every allowlist rationale must satisfy the R-C5.5.1 mechanical quality floor, then the classifier-specific standard below:

### `SAFE`

The rationale must:

1. State the specific bytes returned or accepted.
2. Explain why an attacker gains no plaintext, signing, wrapping, bearer-token, or compositional advantage from those bytes.

Example: `SAFE: Returns 32-byte X25519 public key; no plaintext advantage to attacker.`

### `BEARER-TOKEN-PERMITTED`

The rationale must:

1. State the bearer-token semantic explicitly.
2. Describe the threat model, including that anyone with the URL or serialized artifact has access.
3. Reference the SPEC defining the URL or token format when applicable.

Example: `BEARER-TOKEN-PERMITTED: 32-byte share-link URL fragment seed designed to be base64url-encoded and embedded in a user-shareable URL. Bearer-token semantics: anyone with the URL has access. See SPEC-R-C5.5-MigrationDesign.md §2 Option B.`

This classifier is not a generic "secret allowed" escape hatch. It applies only when the product contract is that the byte string is the shareable credential.

### `CORPUS-DRIVER-ONLY`

The rationale must:

1. State the Cargo feature gate, currently `feature='cross-client-vectors'`.
2. Reference the Gradle invariant in `apps/android-main/build.gradle.kts` that forbids scheduling test and production tasks in the same invocation.
3. Point at the API-shape or production-binding test that proves production bindings do not expose the symbol.
4. Name the corpus test or corpus file that consumes the raw input.

Example: `CORPUS-DRIVER-ONLY: Gated by feature='cross-client-vectors'; production builds do not expose this symbol. Gradle invariant in apps/android-main/build.gradle.kts forbids scheduling test and production tasks in same invocation. Verified by crates/mosaic-uniffi/tests/api_shape_lock.rs::production_uniffi_bindings_do_not_expose_corpus_drivers. The raw-secret input is consumed by the cross-client link_keys.json corpus parity test.`

### `MIGRATION-PENDING`

The rationale must:

1. Reference the migration ticket ID.
2. State the expected migration outcome and when it is expected to land.
3. Avoid claiming the current symbol is safe; the classifier means the allowlist entry is temporarily tolerated because removal or reclassification is actively tracked.

`MIGRATION-PENDING` must not survive to v1 freeze.

## 4. Mechanical Enforcement

R-C5.5.1 added allowlist-rationale quality checks to the architecture guards:

- rationale length must be at least 40 characters;
- the seven banned phrases `reviewed existing api`, `internal use`, `not a secret`, `todo`, `trust me`, `fixme`, and `tbd` are rejected case-insensitively;
- every allowlist rationale must start with an explicit classifier prefix from §2;
- negative fixtures prove the length, banned-phrase, missing-classifier, and unknown-classifier checks execute in both `.ps1` and `.sh` variants.

Any allowlist entry's rationale comment that fails the R-C5.5.1 mechanical check is rejected at script execution. Adding a new classifier requires extending the R-C5.5.1 classifier check in all four guard scripts (`no-raw-secret-ffi-export.{ps1,sh}` and `web-raw-input-ffi.{ps1,sh}`) and adding a negative fixture for the rejected old vocabulary.

The v1 guard behavior requires an explicit leading `UPPER-CASE-CLASSIFIER:` classifier on every allowlist rationale. It must be one of the four classifiers in §2; absent classifiers are rejected instead of falling back to `SAFE`.

## 5. Lifecycle

Classifier changes are security-relevant architecture changes:

- `MIGRATION-PENDING` → any other classifier requires the migration ticket to land and the replacement rationale to reference the landing commit hash or SPEC section that proves the new posture.
- `SAFE` → any other classifier requires evidence that the threat model changed, such as a newly discovered bearer-token, raw-input, raw-output, or compositional-attack vector.
- `CORPUS-DRIVER-ONLY` → `MIGRATION-PENDING` requires the `cross-client-vectors` feature wiring to be removed or bypassed; once production exclusion is gone, the Gradle invariant no longer justifies the classifier.
- Any classifier → `MIGRATION-PENDING` is allowed only as a conservative downgrade to track in-progress remediation. It must include a ticket ID and cannot survive v1 freeze.
- Adding a new classifier requires a `SPEC-FfiSecretClassifiers` amendment, synchronized script enforcement, and an audit note explaining why the existing four classifiers are insufficient.

## 6. Historical Reference: Wave 4 Migrations

| R-C5.5 / Wave 4 item | Final classification | Landing reference | Notes |
|---|---|---|---|
| `CreateLinkShareHandleResult.link_secret_for_url` renamed to `link_url_token` | `BEARER-TOKEN-PERMITTED` | `8558261` | 32-byte share-link URL fragment seed; bearer-token semantics are explicit. |
| `derive_link_keys_from_raw_secret` | `CORPUS-DRIVER-ONLY` | `6701059` | Feature-gated corpus driver for `link_keys.json`; production bindings exclude it. |
| `derive_identity_from_raw_seed` | `CORPUS-DRIVER-ONLY` | `1b66b19` | Consistency migration for the identity corpus driver; not one of the original three design-dependent R-C5.5 items but part of the final classifier vocabulary. |
| `verify_and_open_bundle_with_recipient_seed` | `CORPUS-DRIVER-ONLY` | `1b66b19` | Feature-gated corpus driver for `sealed_bundle.json`; production callers use handle-based bundle import. |
| `LinkKeysFfiResult.wrapping_key` | Removed from allowlist | `cbec1a6` | Migrated to handle-based output; no classifier remains. |
| `OpenedBundleFfiResult.epoch_seed` | Removed from allowlist | `cbec1a6` | Migrated to handle-based output; no classifier remains. |

The design rationale for these outcomes is recorded in `SPEC-R-C5.5-MigrationDesign.md` (commit `5356d20`), with the original audit checkpoint at `2d17c47`.

## 7. Open Questions / Future Extensions

- `r-c8-rust-owned-share-link-urls` may reduce the number of `BEARER-TOKEN-PERMITTED` raw-byte crossings by moving share URL assembly into Rust. Until that lands, `link_url_token` remains a deliberately serialized bearer credential.
- v1 freeze must verify that no `MIGRATION-PENDING` allowlist entries remain.
- Any future mobile, desktop, or CLI FFI guard should import this same vocabulary rather than minting a platform-local classifier set.
