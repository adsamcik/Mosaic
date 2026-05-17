# Dependency Policy

Status: active v1.0.x. Updated when a CVE-fast-path, version-bump, or
review-cadence rule actually changes.

This document captures the deliberate dependency-management posture used
across the Mosaic Rust workspace, the .NET backend, the web frontend, and
the Android app. It exists so a future maintainer reading
`Cargo.toml`, `package.json`, `*.csproj`, or `libs.versions.toml` knows
which constraints are intentional and which are accidental — and how to
patch a CVE without violating the freeze.

## Philosophy

Mosaic prefers a **slow, audited, exact-pinned** dependency tree over a
fast, lockfile-resolved, range-pinned one. Reasons:

1. **Reproducibility.** A rebuild years from now must produce identical
   artifacts. Floating ranges (`^1.2.3`, `>=2`) break that.
2. **Cryptographic supply chain.** The Rust crypto crates and the WASM
   payload are reproducibility-critical. Any unaudited transitive change
   could compromise the zero-knowledge boundary.
3. **Small operator surface.** ≤50 self-hosted users do not benefit from
   bleeding-edge dependency churn; they benefit from a build that keeps
   working across operator inattention windows.
4. **Late-v1 protocol freeze.** Several wire formats are byte-frozen by
   lock tests (`docs/RELEASE.md` §Frozen surfaces). Dependencies that
   could observably alter those bytes (serialization libs, hash impls)
   must move only with a SPEC update.

## Pinning rules per ecosystem

| Ecosystem | Pinning style | Lockfile committed | Notes |
|---|---|---|---|
| Cargo (Rust workspace) | Exact `=X.Y.Z` for security-critical crates; default semver for utility crates. `cargo deny` + `cargo vet` + `cargo audit` gated in CI. | `Cargo.lock` — yes | `cargo update` is **not** part of routine flow. Run it only as part of a deliberate version-bump or CVE-fast-path; commit the resulting lockfile churn in its own commit. |
| npm (web, crypto lib) | Exact `X.Y.Z` (no `^`/`~`) on top-level deps. `package-lock.json` is the source of truth. | `package-lock.json` — yes | `npm install <name>` to add; never blanket `npm update`. CI runs `npm audit --omit=dev` (see CI workflow) for advisory visibility. |
| NuGet (.NET backend) | Exact `Version="X.Y.Z"` in each `*.csproj`. | `packages.lock.json` per project — yes | `dotnet add package` for additions only. CVE-driven bumps are explicit and reviewed. |
| Gradle (Android) | Versions live in `gradle/libs.versions.toml` (catalog). Direct version literals in `build.gradle.kts` are a smell — file an item to migrate. | `gradle/verification-metadata.xml` — yes | Single-source bumps: edit the catalog, not the build script. |

## CVE fast-path

When a security advisory affects a dependency that Mosaic actually uses:

1. **Triage** within one business day. Confirm the path is reachable (not
   in `dev-dependencies` only, not a transitive feature we don't enable).
2. **Patch in place.** Apply the smallest possible bump that closes the
   CVE — patch version if possible, minor only if no patch release exists.
3. **One commit per CVE.** Conventional commit format:
   `fix(deps): bump <pkg> <from> → <to> to patch CVE-YYYY-NNNN`.
   Include the CVE link in the body.
4. **Verify.** Run the relevant test suite for the layer that owns the
   dependency. For crypto-adjacent crates, also run the parity arch
   guards.
5. **Commit the lockfile churn.** `Cargo.lock` / `package-lock.json` /
   `packages.lock.json` updates go in the same commit so reviewers see
   the actual transitive impact.

The fast-path **bypasses** the monthly review cadence but never bypasses
the architecture guards, the lock tests, or the CI gate.

## Routine review cadence

Once per month, a maintainer:

1. Runs `cargo audit`, `cargo outdated`, `npm audit`, `dotnet list package
   --outdated`, and `gradle dependencyUpdates`.
2. Files a tracking item per outdated dep that is **not** a CVE: title
   `chore(deps): consider bump <pkg> <from> → <to>`. These get scheduled
   alongside the next minor release, not landed ad-hoc.
3. Re-affirms or revises any exemptions in `deny.toml`,
   `supply-chain/audits.toml`, and `supply-chain/config.toml`.

The monthly pass deliberately does **not** mass-bump dependencies; that
behaviour is what produces the lockfile churn / rebuild-breakage cycle
this policy avoids.

## What this policy forbids

- Blind `cargo update` or `npm update` outside a planned bump window.
- Adding `^` or `~` ranges to top-level dependencies to "make CVE patches
  automatic". They don't; they make rebuilds non-reproducible.
- Bumping a dependency to pick up an unrelated feature mid-release. File a
  separate item.
- Disabling `cargo deny`, `cargo audit`, or the npm audit CI gate to land
  a "must-ship" dep. The gate is part of the contract.
- Suppressing audit findings without recording an exemption (and a date)
  in the appropriate config file.

## Supply-chain gates

The CI pipeline enforces this policy through:

- `.github/workflows/tests.yml` → cargo `audit` + `deny` + `vet`.
- `.github/workflows/tests.yml` → `npm audit --omit=dev --audit-level=high`
  (see v1.0.1 s15 commit landing this gate).
- `tests/architecture/dotnet-no-crypto-bypass.ps1`,
  `tests/architecture/android-rust-core-protocol-completeness.sh`,
  `tests/architecture/web-rust-core-protocol-completeness.ps1` —
  cryptographic-parity guards that fail if a dependency reintroduces a
  bypass path.

## Owner

Project maintainer (`adsamcik`). For security-sensitive bumps, route
through the SECURITY.md disclosure path before publishing the commit.
