# Dependency Governance — single-maintainer & niche packages

> **Status:** Active source policy; the prior v1.0.2 label was an internal
> workstream marker, not a release claim. See
> [RELEASE_STATE.md](RELEASE_STATE.md).
> **Owner:** Mosaic maintainers.
> **Companion to:** `docs/DEPENDENCY_POLICY.md` (general policy),
> `docs/TOOLCHAIN_LIFECYCLE.md` (build toolchain).

`DEPENDENCY_POLICY.md` documents *what* dependencies we ship and the rules they
follow. This document documents *which* dependencies need extra care because
they are maintained by a single individual, by a tiny team, or otherwise sit
outside the well-trodden supply-chain mainstream. Those packages need:

1. a documented fallback if upstream goes dormant or hostile;
2. a `cargo vet` (or equivalent) pinned audit so that an unannounced
   maintainer change cannot silently land malicious code in our build;
3. a named maintainer-of-the-maintainer inside this repo who watches the
   upstream and brings concerns to a PR if upstream changes.

If a package is in this list and you are bumping it, **first** confirm the
`cargo vet` / lockfile pin still resolves to a maintainer you recognise.

## Tracked packages

| Package | Ecosystem | Why tracked | Pin / audit mechanism | Fallback plan |
|---|---|---|---|---|
| `libsodium-wrappers-sumo` | npm | Single-maintainer (`@jedisct1`) wrapper around upstream libsodium; the entire web crypto surface depends on it. | `package-lock.json` exact version pin; SRI hash recorded; `cargo vet` not applicable (npm); manual audit on bump. | Switch web crypto to `mosaic-wasm` (Rust → WASM) primitive surface (already shipped for Slice 8); this is the long-term direction anyway. |
| `fts5-sql-bundle` (SQLite-WASM with FTS5) | npm | Niche bundle, maintained by a small team; required for client-side full-text search over plaintext metadata. | `package-lock.json` exact version pin; integrity hash; build verified against a golden FTS5 query corpus in `apps/web/src/lib/__tests__/`. | Drop FTS5 client-side and degrade search to `LIKE`-style filtering over decrypted in-memory rows (already the fallback path for sub-100-photo libraries). |
| `tus-js-client` / `TusDotNetClient` | npm / NuGet | Resumable-upload protocol; small maintainer team, but the protocol is stable and well-specified (RFC draft). | Lockfile pins on both client and server; protocol compliance tested in `tests/integration/`. | Re-implement the subset of TUS we use directly (resumable PATCH with offset header) — ~200 LoC; spec is short. |
| `comlink` | npm | Worker-RPC layer; widely used but effectively single-maintainer (Surma). | `package-lock.json` exact pin; usage is a thin facade (`apps/web/src/lib/worker-bridge.ts`). | Replace with a hand-rolled `postMessage` + promise-id RPC (≈80 LoC); already the fallback shape in places where comlink causes serialization issues. |
| `zustand-mutative` | npm | Tiny adapter package; couples `zustand` to `mutative` for immutable store updates. | `package-lock.json` exact pin. | Drop the adapter and use `zustand`'s built-in `set((draft) => …)` shape directly. |
| `supercluster` | npm | Single-maintainer clustering library for the map view. | `package-lock.json` exact pin. | Fall back to non-clustered marker rendering for libraries < 5000 photos (matches current viewport); for larger, defer the map feature until replaced. |
| `argon2` (Rust crate, via `mosaic-crypto`) | crates.io | Pure-Rust Argon2id implementation; small maintainer set, but actively reviewed by the RustCrypto org. | `cargo vet` audited entry; lockfile pinned; cross-platform parity vectors in `tests/vectors/`. | RustCrypto has additional Argon2 implementations under the same umbrella; switch is a one-line `Cargo.toml` change if the current crate goes dormant. |
| `blake2`, `chacha20poly1305`, `x25519-dalek`, `ed25519-dalek` | crates.io | RustCrypto family; not single-maintainer but a small expert community. | `cargo vet` audited entries; lockfile pinned; cross-platform parity vectors. | No single-package fallback — the RustCrypto org is the substrate. Migration off this family is an ADR-005 amendment. |
| `uniffi` (Mozilla) | crates.io / Gradle | Multi-language FFI generator; Mozilla-maintained but a small specialist team. | `cargo vet`; lockfile pin; UniFFI v9 contract pinned via the cross-client vectors corpus (`tests/vectors/`). | No drop-in alternative; falling back means hand-writing JNI + Kotlin + Swift bindings. Treat as essential infrastructure — bumps require the full cross-client vector matrix to pass. |
| `leaflet` | npm | Single-maintainer (`mourner`); long-established, low-change, but the bus factor is real. | `package-lock.json` exact pin. | Switch the map component to an alternative (maplibre-gl-js) — bigger lift, defer until needed. |

## How to add a new tracked dependency

When a new direct dependency is added to the workspace, decide whether it
qualifies for this list. A dependency belongs here if **any** of:

- it has a single named maintainer on the published metadata for the last 12 months;
- the GitHub repository has < 5 active committers in the last year;
- removing it would block a core user-facing feature (upload, crypto, search, map);
- it implements a non-standardised protocol where we cannot fall back to a spec
  and re-implement.

A package that fails all four criteria does **not** need a row here — the
general `DEPENDENCY_POLICY.md` covers it.

### Add-row checklist

1. Add a row with: package name, ecosystem, why tracked, current pin
   mechanism, and a concrete fallback plan (not "we'd fork it" — name what
   we'd switch to or implement).
2. Confirm `cargo vet` (Rust) or `package-lock.json` integrity (npm) is in
   place. If not, run the audit and commit the audit record.
3. Add the fallback path to `docs/DEPENDENCY_POLICY.md` if the fallback
   itself implies new direct dependencies.

## How to remove a row

A row is removed only when:

- the dependency itself is removed from the workspace; or
- the upstream maintainer set expands such that the package no longer meets
  any of the "tracked" criteria above (e.g. a project moves from a
  single-maintainer fork to a multi-org foundation).

We **do not** remove rows just because a fallback was exercised — the
fallback is the row's whole reason for existing.

## Quarterly review

Every quarter (or before any release tagged `v1.x.0`), maintainers walk this
table and confirm:

- the pin still resolves to the documented maintainer;
- the fallback plan is still credible (named alternative still exists and is
  itself maintained);
- no upstream advisory has been issued against the pinned version.

Mark the review in the commit message: `docs(deps-governance): quarterly
review, all entries verified`.

## See also

- `docs/DEPENDENCY_POLICY.md`
- `docs/TOOLCHAIN_LIFECYCLE.md`
- `docs/SECURITY.md` §"Dependabot triage"
- ADR-005 — Rust crypto dependencies
- ADR-020 — Supply chain amendment
