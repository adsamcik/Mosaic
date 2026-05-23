# Mosaic Toolchain Lifecycle

> **Status:** Living document. Last reviewed for v1.0.2.
> **Owner:** Mosaic maintainers (see git blame).

This document captures the lifecycle policy for every primary build toolchain
Mosaic depends on. Its purpose is to make explicit which versions we run, why,
when we expect to roll them forward, and what the cost of falling behind is.
Without this, individual toolchain bumps drift into ad-hoc PRs and v1.x risks
sliding off a supported runtime mid-release-window.

The audience is repository maintainers and operators planning long-term
deployments (≤50 users, often air-gapped or self-hosted).

## Cadence reference table

| Toolchain | Pinned (v1.0.2) | Upstream cadence | Our floor policy | Our ceiling policy |
|---|---|---|---|---|
| **Rust (stable)** | `1.83.x` (latest stable at v1.0.2 freeze) | 6 weeks per release; 1-year LTS-equivalent through Ferrocene | Floor = stable - 2 (≈12 weeks behind tip) so a single CI runner update can keep up | Ceiling = current stable; no MSRV "back-compat" maze for ≤50-user audience |
| **Node.js** | `20.x` LTS ("Iron") | Even majors enter LTS in October; "Active LTS" 12 months, "Maintenance" 18 months | Floor = current Active LTS at release time | Ceiling = current Active LTS major; we do **not** test against odd majors (`21`, `23`, …) |
| **JDK (Android)** | `17` (Temurin) | Oracle/Adoptium 6-month feature, 4-year LTS | Floor = JDK 17 LTS; AGP currently requires 17 | Ceiling = JDK 21 once AGP officially supports it as stable on macOS/Linux/Windows CI matrix |
| **Android Gradle Plugin (AGP)** | `8.7.x` | Quarterly minor + monthly patch | Floor = AGP minor that matches the pinned Android Studio "stable" channel at release time | Ceiling = current AGP stable; we skip `-alpha` / `-beta` |
| **Kotlin** | `2.0.x` (K2 compiler) | ~3 month minor cadence; K2 is stable since 2.0.0 | Floor = the Kotlin version bundled with the floor AGP | Ceiling = current Kotlin stable; we do **not** track EAP / preview |
| **.NET (SDK + ASP.NET Core)** | `10.0.x` (preview in v1.0.2; GA targeted for v1.1) | Annual major in November; STS (18-month) vs LTS (36-month) alternating | Floor = whichever .NET line we shipped a tagged release on (no mid-release-line downgrade) | Ceiling = current `dotnet --list-sdks` highest LTS that ASP.NET Core minimal APIs support unchanged |
| **TypeScript** | `5.7.x` | ~3 months between minor releases | Floor = 5.5 (Vite 8 baseline) | Ceiling = current TS stable; no EAP |
| **Vite** | `8.x` | 6-12 month major cadence; >6 month overlap support | Floor = current Vite major; we do not chase RCs | Ceiling = current stable Vite major |

> The exact pinned patch versions live in the lockfiles
> (`Cargo.lock`, `package-lock.json`, `gradle/libs.versions.toml`,
> `global.json`). This document captures the *policy*, not the lock.

## Why "stable - 2" for Rust

The Rust release train runs every 6 weeks. A floor of "stable - 2" (≈12 weeks
behind tip) gives us:

- one full release-cycle buffer to absorb regressions in `cargo`, `rustc`,
  the `clippy` lint set, or `wasm-bindgen` integration;
- one cycle to update CI runner images, vendored toolchains, and downstream
  crates pinned with MSRV ranges;
- still keeps us inside the window where `cargo audit` advisories assume the
  current stable toolchain compiles affected crates.

We deliberately do **not** track nightly. Mosaic's crypto crate
(`mosaic-crypto`) declares `#![forbid(unsafe_code)]` and uses only the stable
subset of `std::sync::OnceLock`, so nightly-only features are not on the
roadmap.

## Why JDK 17 (not 21) today

AGP 8.7 officially supports JDK 17 and 21 as toolchain JDKs, but the Android
Gradle Plugin still recommends 17 as the default and several of our transitive
Gradle plugins (Spotless, KSP) have advisory floors at 17. JDK 21 is the
target for the next AGP-major bump (AGP 8.9 / 9.x), at which point
`apps/android-main/build.gradle.kts` and CI runners will move together.

We do not "support" JDK 11 in any deployment surface: it is end-of-life for
Android tooling.

## How and when to bump

A toolchain bump is treated as a **protocol-adjacent** change (even though
none of these are wire-visible) because a broken bump on `main` halts every
contributor. The bump procedure:

1. Open an issue describing the new pinned version and the reason
   (security advisory, blocker fix, feature dependency).
2. Update the lockfile / version manifest in a single commit (commits go
   directly to `main` per project policy).
3. Run the full CI matrix (`test-all` VS Code task; or
   `./scripts/run-tests.ps1 -Suite all`).
4. If the bump crosses a `floor` boundary listed above, also update this
   document in the same commit and mention the policy change in the next
   `CHANGELOG.md` entry.

## Drift signals

The following signals indicate it is time to revisit this table:

- `cargo +stable build` warns about a deprecated edition flag → the pinned
  Rust stable is approaching end-of-life for our edition set.
- Node.js "Maintenance LTS" timestamp is within 6 months of current date →
  schedule next Node major bump now, not at deadline.
- AGP "deprecated in next major" warnings appear in `./gradlew assemble`
  output → schedule AGP minor catch-up.
- A security advisory references a `MosaicVersion: ≥ X.Y.Z` requiring a
  toolchain feature absent from our floor → emergency bump (out-of-cycle).

## See also

- `docs/DEPENDENCY_POLICY.md` — per-package dependency rules (separate from
  toolchain).
- `docs/DEPS_GOVERNANCE.md` — single-maintainer / niche dependency tracking.
- `docs/RELEASE.md` — release cadence and protocol freeze policy.
