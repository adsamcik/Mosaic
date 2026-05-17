# ADR-026: `mosaic:KIND:v1` is the canonical KDF / AAD label namespace

## Status

Accepted, locked at v1.

Lock surface: `crates/mosaic-crypto/tests/kdf_and_auth_label_lock.rs`
plus `crates/mosaic-domain/tests/late_v1_protocol_freeze_lock.rs` per
`docs/RELEASE.md` §Frozen surfaces.

## Context

The Mosaic v1 cryptographic substrate uses string labels in three
distinct places:

1. **HKDF info parameters** (key separation) — e.g. expanding L1 root
   key out of L0 master.
2. **AEAD AAD prefixes** and **signing transcript context strings** —
   e.g. binding manifests, sidecar bodies, auth challenges.
3. **Sealed-bundle context strings** — binding identity-signed bundles
   to a domain.

Across `IMPLEMENTATION_PLAN.md` §11, the dominant pattern is the
colon-namespaced form `mosaic:KIND:v1`:

- `mosaic:root-key:v1` (row 1, L0 → L1)
- `mosaic:auth-signing:v1` (row 6, identity signing)
- `mosaic:tier:thumb:v1`, `mosaic:tier:preview:v1`, `mosaic:tier:full:v1`,
  `mosaic:tier:content:v1` (row 7, per-tier shard keys)
- `mosaic:db-session-key:v1`
- Plus several v1.x-reserved variants

Two pre-existing labels deviate from this shape (per ADR-025):

- `mosaic_account_salt` — snake_case, no colons, no version segment
- `mosaic.sidecar.v1.room` — dot-notation, version mid-string

Without an ADR locking the canonical pattern, any new v1.x label landed
by a future maintainer could reasonably choose any of the three forms
and the namespace would fragment further. That would make future
mass-grep audits (e.g. "list every cross-domain separator in the
workspace") much harder, and would weaken cryptographic-domain
separation reasoning ("if every label has the same shape, two labels
collide iff their KIND segments are equal").

## Decision

### Canonical pattern (mandatory for all new labels)

Every **new** KDF info string, AEAD AAD prefix constant, signing
transcript context, or sealed-bundle domain context introduced in
v1.x or beyond MUST follow the form:

```
mosaic:KIND:v1
```

where:

- `mosaic` is the literal lowercase product prefix.
- `KIND` is a hyphen-separated lowercase identifier describing what is
  being keyed/bound — e.g. `root-key`, `auth-signing`, `tier:thumb`,
  `db-session-key`. Multi-segment KINDs use additional colons (e.g.
  `tier:thumb` not `tier-thumb`) where the project already has prior
  art.
- `v1` is the literal version segment matching the protocol freeze
  level. Bumping to `v2` indicates a breaking change and requires a
  new ADR + lock-test entry.

ASCII-only. No whitespace. Case-sensitive. No null bytes.

### Pre-existing exceptions (grandfathered, frozen)

The following two labels predate this ADR, are already encoded in
shipped client wire formats, and would invalidate every existing user
state if rewritten. They are frozen as v1 exceptions:

| Label | Form | Used in |
|---|---|---|
| `mosaic_account_salt` | snake_case, no version | `derive_account_salt` (LocalAuth) |
| `mosaic.sidecar.v1.room` | dotted, version mid-string | `derive_sidecar_room_id` (sidecar pairing) |

Rationale per axis is captured in ADR-025. **No further exceptions
will be granted in v1.x.** A v2 protocol freeze may unify them.

### Enforcement

- The `kdf_and_auth_label_lock.rs` test enumerates every label and
  verifies its bytes. A new label must add an entry to the lock or the
  test fails — making the namespace choice a code-review event rather
  than an implicit lockfile change.
- A future linter could grep `crates/mosaic-crypto/src/` for byte string
  literals matching `b"mosaic` and flag non-canonical forms; that lint
  is out of scope for this ADR but is the natural enforcement path if
  drift recurs.

## Consequences

- Cryptographic-domain separation reasoning is now syntactic: any two
  labels of canonical form collide iff their `KIND` segments are equal,
  which a maintainer can check by eye.
- Future audits can grep `mosaic:` to enumerate every key-domain in the
  workspace and cross-reference against the spec inventory.
- The two grandfathered labels carry an inline `// ADR-026 exception`
  comment in `crates/mosaic-crypto/src/lib.rs` (added when this ADR
  lands or in a follow-up housekeeping commit) so the deviation is
  visible at the source.
- Any v1.x maintainer who reaches for a non-canonical form (because the
  underlying primitive feels "different") is forced to either justify
  a new ADR-026 exception (and convince reviewers) or align with the
  canonical pattern.

## References

- ADR-005: Audited pure-Rust crypto dependencies (provides the HKDF
  primitive this ADR scopes).
- ADR-025: KDF parameters for the two grandfathered labels.
- `docs/IMPLEMENTATION_PLAN.md` §11 (label inventory).
- `crates/mosaic-crypto/tests/kdf_and_auth_label_lock.rs` (lock test).
- `docs/RELEASE.md` §Frozen surfaces.
