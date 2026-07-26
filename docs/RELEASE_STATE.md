# Release State and Evidence

This page is the authoritative interpretation of Mosaic release and maturity
claims. Historical plans, source comments, changelog entries, and draft release
notes do not establish that an artifact was released or is supported.

## Current source status

The current `main` source is a **production-readiness candidate**, not a
production release. Use it only as a closed developer preview with disposable
or independently backed-up data until every stable-release gate and the
remaining independent assurance work have passed.

The supported-surface candidate is limited to the web frontend and backend
Docker images. Other surfaces have narrower status:

| Surface | Current status | Stable artifact |
|---|---|---|
| Web frontend + backend | Production-readiness candidate | None from an untagged checkout |
| LocalAuth | Candidate; must pass the tagged release-assurance workflow | None from an untagged checkout |
| ProxyAuth | Deployment-specific candidate; requires a real trusted-proxy boundary test | None from an untagged checkout |
| Android | Developer-preview foundation | Never attached to a stable release |
| Sidecar Beacon | Experimental/beta and disabled by default | Not part of the stable supported surface |

## Current contract guardrails

Release evidence cannot widen the implemented API surface. The current
candidate has these explicit boundaries:

- Album expiration and share-link expiration are supported, server-clock
  enforced lifecycle/access controls.
- Per-photo expiration is unsupported and deferred. Its former handlers are
  non-routable, v2 finalize rejects non-null `expiresAt`, and there is no
  automatic per-photo expiration sweep. Legacy persisted/exported values do
  not imply a supported producer route.
- Manifest create, metadata update, and tombstone producers use
  reserve → sign → client-addressed mutate. Their positive ordered sequence is
  signature-bound and the matching reservation is consumed atomically.
- Clients must keep replay checkpoints per manifest in separate encrypted
  security state; a single album-wide receive watermark cannot reject a
  distinct manifest delivered out of order.
- `Idempotency-Key` is mandatory for album and share-link creation, optional
  for client-addressed manifest finalization, and rejected on unsupported
  scopes. Tus PATCH uses its offset contract.
- [`docs/openapi.json`](openapi.json) is the generated, CI drift-gated HTTP
  schema. Historical ADR/spec examples do not override it.

These clarifications do not change maturity: stable publication remains blocked
until every external evidence record below is present, current, and valid.

## Fail-closed readiness manifest

[`.github/release-readiness.json`](../.github/release-readiness.json) is the
machine-enforced readiness record. It currently sets
`stable_publication_enabled` to `false` and contains no external evidence, so
the publish workflow rejects every stable tag before assurance or image build.
Documentation changes alone cannot enable publication.

Eight evidence classes are required:

- `independent-cryptographic-review`
- `production-backup-restore-drill`
- `upgrade-and-rollback-drill`
- `named-hardware-performance-budgets`
- `firefox-webkit-opfs-durability-matrix`
- `real-proxyauth-boundary-test`
- `production-audit-persistence-test`
- `repository-governance-controls`

For every class, the manifest must contain a `passed` record with a publicly
retrievable HTTPS artifact, its verified lowercase SHA-256 digest, the same
full 40-character `assessed_source_commit`, and a non-expired
timezone-aware `valid_until`. Governance evidence must prove required
reviews/checks and branch/tag creation controls for the candidate.

The tagged approval commit must be the assessed source commit's sole child and
may modify only `.github/release-readiness.json`. This feasible two-commit
binding avoids asking a commit to contain its own hash while proving that no
source, workflow, test, build, or documentation changed after assessment. The
workflow downloads and hashes every evidence artifact and retains the verified
bundle on the GitHub Release.

## What version text means

- A Git tag is the only source-level release identity. At the
  `17e35d34e2b3beed8931aad44bb782568dbec38a` audit baseline, the repository
  contains historical tags through `v0.2.0`; it does not contain a `v1.0.0`
  tag.
- `docs/RELEASE_NOTES_v1.0.0.md`, `ROADMAP.md`, and
  `docs/IMPLEMENTATION_PLAN.md` are historical planning/design records. Their
  v1 labels describe intended protocol or workstream milestones, not a shipped
  stable product.
- `v1.0.1`/`v1.0.2` labels in old specifications, feature logs, and source
  comments are internal planning lineage unless the same version is proven by
  the immutable release record below.
- Protocol version numbers such as shard envelope `0x03`/`0x04`, snapshot
  schema `1`, or strings ending in `:v1` are wire-format identifiers. They are
  not product-release claims.

## What proves a stable release

A stable web/backend release exists only when all of the following identify
the same assessed source, evidence-only approval commit, and exact SemVer:

1. The tagged tree has a valid, enabled readiness manifest containing all eight
   passed, downloaded, digest-verified, source-bound, unexpired external
   evidence records.
2. An annotated `vX.Y.Z` Git tag identifies the single-parent evidence-only
   approval commit reachable from `main`.
3. `Publish Mosaic Artifacts` succeeds at that exact tag commit. Its reusable
   `Stable Release Assurance` gate must pass without a bypass.
4. The GitHub Release records the immutable backend and frontend OCI digests.
5. Both digests carry matching OCI source revision/version labels, registry
   SBOM/provenance, retained SPDX SBOM artifacts, and verifiable GitHub build
   provenance; the GitHub Release also retains the verified external-evidence
   bundle and its digest.
6. The clean-consumer job pulls those exact digests and passes label, health,
   registration, album creation, upload, reload-persistence, and logout checks
   before the one-time exact-version tags are created.

Exact-version image tags are immutable by policy. There is no supported
`latest`, moving major/minor tag, stable Android artifact, or manual stable
publication path.

Example verification, using values copied from the GitHub Release:

```bash
git merge-base --is-ancestor <tag-commit> origin/main
docker buildx imagetools inspect ghcr.io/adsamcik/mosaic-backend@sha256:<digest>
docker buildx imagetools inspect ghcr.io/adsamcik/mosaic-frontend@sha256:<digest>
gh attestation verify oci://ghcr.io/adsamcik/mosaic-backend@sha256:<digest> --repo adsamcik/Mosaic
gh attestation verify oci://ghcr.io/adsamcik/mosaic-frontend@sha256:<digest> --repo adsamcik/Mosaic
```

If any tag, digest, workflow run, attestation, or evidence artifact is missing
or disagrees, treat the artifact as an unsupported preview.

## Records versus guarantees

The current operational contract lives in `README.md`, `docs/DEPLOYMENT.md`,
`docs/DOCKER.md`, `docs/RELEASE.md`, and
`docs/operations/BACKUP.md`. ADRs and specs define design constraints.
Roadmaps, implementation plans, audit reports, feature histories, and draft
release notes are retained for traceability but are non-authoritative for
current maturity, deployment, and artifact availability.
