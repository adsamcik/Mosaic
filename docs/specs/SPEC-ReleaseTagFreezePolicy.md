# SPEC: Release Tag Freeze Policy

## Status

**Active.** This document is the canonical policy for protocol-surface freeze decisions.

## Motivation

Mosaic's zero-knowledge protocol surfaces need an objective freeze point with a durable audit trail. A SPEC-declared freeze can describe intent, but it is subjective: it depends on who edited the document, which commit they named, and whether downstream consumers can discover that declaration from normal release metadata.

A release-tag-driven policy makes the freeze observable in the version-control namespace. It preserves pre-release iteration freedom, gives testers clear candidate builds, and lets future maintainers audit protocol drift with standard Git commands.

## Policy statement

Protocol surfaces enumerated in [`IMPLEMENTATION_PLAN.md` §11](../IMPLEMENTATION_PLAN.md#11-late-v1-irreversibility-register) become irreversibly locked at the moment a release tag (`v[major].[minor].[patch]` or `v[major].[minor].[patch]-rc.[n]`) is cut for a build that is distributed to any user, including internal alpha, public beta, or GA builds.

The tag's tree is the protocol version. Any user who runs that build receives the protocol bytes, labels, schemas, and compatibility contract present in that exact tree.

## Pre-tag freedom

Until a release tag is cut for a distributed build, any commit on `main` is fair game for protocol-surface changes. Wire formats, AAD labels, snapshot schemas, canonical dimensions, idempotency semantics, and other §11 surfaces may still change before the tag.

Lock tests still byte-pin the current design before the tag, but their pre-tag meaning is "this is what we plan to ship," not "this is irreversible."

## Tag to freeze mapping

| Tag type | Freeze effect | Allowed future change class |
| --- | --- | --- |
| `vX.Y.Z-rc.N` | Locks a release-candidate protocol tree for distributed testing. The last RC's protocol bytes must equal the final `vX.Y.Z` tag's bytes. | RC-to-RC changes are allowed only before final release and must be visible as a new RC tag. |
| `vX.Y.Z` | Locks the final protocol tree for that release. | Patch/minor/major rules below apply after the tag. |
| Patch (`vX.Y.(Z+1)`) | Bugfix-only release. Frozen §11 surfaces must not change. | No wire-format, schema, label, discriminant, or canonical-byte drift. |
| Minor (`vX.(Y+1).0`) | Additive-compatible release. Existing tagged protocol surfaces remain accepted. | New optional/additive surfaces only, with compatibility tests for prior tags. |
| Major (`v(X+1).0.0`) | Protocol-breaking release boundary. | Breaking changes require migration tooling and audit rows that cite both old and new tags. |

A post-tag change that breaks a `vX` protocol surface must be released as `v(X+1).0.0` at minimum.

## Migration obligation

Any post-tag change to a frozen surface requires all of the following before distribution:

1. A version bump consistent with the tag mapping above.
2. A new ADR that names the frozen source tag, the replacement target tag, and the exact surface being changed.
3. Migration tooling for `vX` to `v(X+1)` if any existing user may have data produced by the earlier tag.
4. A new §11 register row citing both tags and describing the compatibility or migration contract.
5. Positive and negative vectors proving old data is either migrated safely or rejected without silent misinterpretation.

## Lock-test role

Byte-pin and architecture lock tests guard intent before a release tag: they define the protocol tree Mosaic plans to ship. From the moment a tag is cut for a distributed build, the same tests enforce the `v[X+0]+` contract for that tag. A test update after a tag is therefore either an additive compatibility proof or evidence of a versioned protocol break.

## Audit trail

The Git namespace is the audit trail. For any released protocol version, `git diff vX.Y.Z..main` shows protocol-relevant changes since the freeze point. Release candidates can be compared the same way, for example `git diff v1.0.0-rc.2..v1.0.0` to prove that the final tag did not drift from the last RC.

## v1 status

v1 is tagged when the project owner runs:

```powershell
git tag v1.0.0
git push --tags
```

Until then, all §11 protocol surfaces are candidates. They are locked by tests as planned ship bytes, but they do not become irreversible v1 surfaces until the `v1.0.0` tag is cut for distribution.
