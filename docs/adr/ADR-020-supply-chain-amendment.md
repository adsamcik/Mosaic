# ADR-020: Amendment to ADR-005 — supply-chain posture for media + transport crates

## Status

Accepted (amends [ADR-005](ADR-005-rust-crypto-dependencies.md))

## Context

ADR-005 ("Prefer audited pure-Rust crypto dependencies for the Rust core") established the supply-chain posture for Mosaic's Rust crypto crates: pinned audited pure-Rust crates for KDFs, AEAD, signatures, key wrapping, RNG, and constant-time comparisons; native bindings only as documented exceptions; `cargo deny`, `cargo audit`, and explicit dependency review as gates.

The Rust core completion programme (`plan.md` v2) materially expands the dependency surface beyond `mosaic-crypto`:

| Crate (or platform lib) | Used by | Class | New attack surface |
|---|---|---|---|
| Pure-Rust ISO-BMFF parser (custom or vetted, e.g. `mp4parse-rust` if pinned + audited) | `mosaic-media` (R-M1/M2 AVIF/HEIC, R-M6a MP4/MOV) | Adversarial-input parser | Bounded recursion, atom counts |
| Pure-Rust EBML / Matroska parser | `mosaic-media` (R-M6b WebM/Matroska) | Adversarial-input parser | Bounded recursion, varint length |
| `image-rs` (decoder for fuzz differential tests only) | `crates/mosaic-media/tests/` | Reference impl for differential testing | Test-only; never runtime |
| `libavif-sys` / `rav1e` / `aom-sys` *(only if R-ADR-014 selects Outcome A)* | `mosaic-media` codec impl | Native C/asm codec | Heap overflows, alloc bombs |
| `libwebp-sys` *(only if R-ADR-014 Outcome A)* | `mosaic-media` codec impl | Native C codec | Same |
| `okhttp3` (Android) | `apps/android-main` Lane A | HTTP client (JVM) | TLS, body-logging interceptor footgun |
| `tus-java-client` *or `tus-android` (selection in A5a)* | `apps/android-main` Lane A | Resumable upload client | Session storage; replay |
| `mp4parse` / `matroska` *(if a vetted Rust crate replaces in-tree parsers)* | `mosaic-media` | Adversarial-input parser | Same as in-tree |

ADR-005 alone is insufficient because: (1) it only covers crypto crates; (2) it does not require SBOM diff CI; (3) it does not address native C codec libraries; (4) it does not specify the Android JVM dependency posture; (5) it does not mandate a panic-firewall policy for parser crates; (6) it does not mandate fuzz-green-before-export gates for adversarial-input crates.

## Decision

This ADR **amends ADR-005** to extend its supply-chain posture to all dependencies introduced by the Rust core completion programme.

### Pure-Rust media + transport crates (Rust-side)

Same posture as ADR-005:

- pinned exact versions (`=x.y.z`) in `Cargo.toml`,
- `cargo deny` gates for advisories, licenses, registries, duplicates,
- `cargo audit` runs on every PR,
- `cargo vet` exemptions documented in `supply-chain/`,
- `unsafe_code = "forbid"` workspace-wide remains in force,
- mandatory `Debug` redaction for any DTO that may carry caller-input bytes (per `SPEC-CrossPlatformHardening.md`),
- panic-firewall: parser entry points `catch_unwind` and translate to `ClientErrorCode` per §0.9 of `plan.md`.

Adversarial-input parsers (R-M1, R-M2, R-M6) **must additionally** pass:

- **Fuzz-green gate (concrete machine-checkable definition).** The most recent **scheduled** `cargo fuzz` job for the crate's parser-entry corpus must:
  - run continuously for **a single uninterrupted ≥ 24h duration** against the merge-target HEAD (or a HEAD that is fast-forward-mergeable to merge-target),
  - report **zero new crashes, zero new OOMs, and zero new timeouts**,
  - have completed **within the last 7 days** of the merge moment (rolling window, not cumulative).

  The CI implementation is a nightly scheduled GitHub Actions workflow `cargo-fuzz-gate.yml` that runs each parser corpus on dedicated runners, checkpoints to S3-style artifact storage, and tags the resulting commit with `fuzz-gate-green-<crate>-<corpus>-<sha>` on success. Merging a PR that touches the parser crate verifies the tag exists and is dated within 7 days; absence blocks merge.

  This gate **explicitly is not** "all PRs run 24h fuzz before merging"; that is operationally infeasible. It **is** "the parser crate has a known-good 24h-green checkpoint within the last week, and the merge does not invalidate that checkpoint." A merge that materially changes parser entry signatures resets the clock; the next nightly run re-establishes the gate.

- numeric bounds documented in the SPEC for the crate (max depth, max atom count, max box size, max allocation),
- differential testing against `image-rs` or equivalent reference impl for AVIF/HEIC (test-only, not runtime).

### Native C/asm codec libraries (only if R-ADR-014 selects Outcome A)

Native codec dependencies (`libavif-sys`, `rav1e`, `aom-sys`, `libwebp-sys`) are gated by:

1. **R-ADR-014 selects Outcome A** (Rust codecs adopted) — otherwise these crates are not pulled in at all;
2. SBOM entry + license review entry in `supply-chain/`,
3. `cargo audit` advisory subscription,
4. fuzz harness in `mosaic-media/fuzz/` covering the codec entry points,
5. binary-size budget tracked in CI (≤ 8 MiB AVIF + WebP combined for the WASM bundle, ≤ 12 MiB combined for Android arm64 cdylib),
6. panic-firewall around every native call (`catch_unwind` + zeroization on panic),
7. memory-bound asserts: codec entry points reject inputs whose declared dimensions × bpp exceed `MAX_IMAGE_PIXELS` *before* the native call.

If Outcome B is selected (platform codecs), none of these dependencies are added; this section is dormant.

### Android JVM dependencies (`okhttp3`, Tus client)

JVM dependencies follow Android's standard supply-chain posture *plus* programme-specific guards:

1. pinned exact versions in `gradle.properties`,
2. Dependabot enabled with weekly cadence; advisory triage rule documented (`docs/SECURITY.md` § Dependabot triage),
3. `okhttp3` body-logging interceptor banned by static guard (`android-no-okhttp-body-logging`),
4. resumable Tus session storage pinned to Room (not file system, not `SharedPreferences`),
5. cert pinning posture set by ADR-019,
6. ProGuard / R8 rules verified to *not* obfuscate UniFFI generated symbols (confirmed during A2a/A2b),
7. APK SBOM diff in CI on every PR that touches `apps/android-main/build.gradle.kts`.

### SBOM diff CI gate (new)

Every PR that touches `Cargo.toml`, `Cargo.lock`, `apps/android-main/build.gradle.kts`, `apps/android-shell/build.gradle.kts`, or `apps/web/package.json` (or their lockfiles) runs:

1. **Web bundle SBOM diff** — emits added/removed/changed npm packages and added/removed WASM crate fingerprints; PR description must include a `## SBOM justification` section if the diff is non-empty (auto-detected by a check-bot regex, which fails the check if the section is missing).
2. **Android APK SBOM diff** — emits added/removed/changed JVM dependencies and added/removed native libs (cdylibs).
3. **Rust workspace SBOM diff** — emits added/removed/changed crates, with license, advisory status, and `cargo vet` exemption status.

**Tool selection (locked):**

- Rust workspace SBOM: `cargo cyclonedx` (CycloneDX format; CDX 1.5 schema). cargo-deny + cargo-audit + cargo-vet remain the gates; cyclonedx is the diff format only.
- Android APK SBOM: `cyclonedx-gradle-plugin` (CycloneDX 1.5).
- Web bundle SBOM: `npm sbom --sbom-format=cyclonedx` (npm ≥ 10) plus `wasm-bindgen --emit-sbom` for crate fingerprints.

A consistent CycloneDX schema across all three diffs lets `cyclonedx-cli diff` produce a uniform PR-comment artifact. PRs that fail SBOM diff review (missing justification, banned license appearing, advisory not triaged) block merge.

**`cargo vet` exemption review cadence.** Every quarter, the `supply-chain/exemptions.toml` file is reviewed; exemptions older than 12 months are forced through a fresh audit or removed. This is enforced by a nightly `cargo-vet-aging` CI job that fails on stale exemptions.

## Options Considered

### Apply ADR-005 unmodified to all new crates

- Pros: zero new ADR overhead.
- Cons: ADR-005 is crypto-scoped; does not cover parser fuzz gates, native C codec heap risk, JVM dep posture, or SBOM CI; supply-chain risk silently expands.
- Conviction: 2/10.

### One amendment ADR (this decision)

- Pros: single source of truth for the expanded supply chain; codifies fuzz-green-before-export gate; codifies SBOM diff CI; bounds Android JVM posture; conditionally activates native codec rules under R-ADR-014.
- Cons: more ADRs to read.
- Conviction: 9/10.

### Replace ADR-005 with a unified supply-chain ADR

- Pros: single document.
- Cons: rewrites a stable, accepted ADR; harder to track decision history.
- Conviction: 4/10.

## Consequences

- All new Rust crates (parsers, codec libraries) flow through the existing `cargo deny` + `cargo audit` + `cargo vet` pipeline plus this amendment's additional gates.
- R-M1, R-M2, R-M6 cannot expose any WASM/UniFFI symbol until their fuzz harness is green for ≥ 24h CI runtime — this is now a hard merge gate, not a Q-lane goal.
- R-ADR-014 outcome directly controls whether native C codec libraries enter the supply chain at all. Outcome B keeps the supply chain pure-Rust on the media side.
- Android `apps/android-main` adds a Dependabot policy file referencing this ADR; the existing 27 advisory triages (per `CHANGELOG.md`) extend to this programme's new transitive deps.
- CI pipeline gains three SBOM diff jobs that block merge on PRs touching dependency manifests.
- Boundary guard `android-no-okhttp-body-logging` is added under `tests/architecture/`.
- The Rust core completion programme will not pull in any new dependency that does not satisfy this amendment's gates; tickets are blocked until the gate is passable.

## Reversibility

Medium. The fuzz-green-before-export gate is permanent (cannot be downgraded without invalidating safety claims). The SBOM diff CI is operational and reversible at low cost. The native codec section is *conditional*: if R-ADR-014 selects Outcome B, the entire native-codec subsection becomes dormant; if R-ADR-014 later flips to Outcome A in v1.x, the subsection re-activates without amending this ADR.
