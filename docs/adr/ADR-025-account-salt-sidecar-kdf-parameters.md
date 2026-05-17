# ADR-025: KDF parameters for LocalAuth account-salt and Sidecar signalling room

## Status

Accepted, locked at v1.

Both labels are part of the late-v1 protocol freeze surface
(`docs/IMPLEMENTATION_PLAN.md` §11 rows 13 and 14) and verified by parity
tests in `crates/mosaic-parity-tests/tests/cross_platform_parity.rs:433-456`.

## Context

Two protocol primitives derive opaque 16-byte identifiers from secret
material, and both were locked at the v1 freeze without an ADR capturing
their rationale:

1. **LocalAuth account-salt derivation** (`derive_account_salt`,
   `mosaic_crypto::ACCOUNT_SALT_HMAC_INFO = b"mosaic_account_salt"`).
   Inputs: 32-byte `user_salt`. Output: 16-byte deterministic salt
   returned by `/api/auth/init` so the client can repeat password
   derivation across devices without exposing whether a username is
   registered (anti-enumeration).

2. **Sidecar signalling room ID** (`derive_sidecar_room_id`,
   `mosaic_crypto::SIDECAR_ROOM_HKDF_INFO = b"mosaic.sidecar.v1.room"`).
   Inputs: pairing key bytes (`msg1`). Output: 16-byte deterministic
   room identifier two clients can derive independently to rendezvous on
   the sidecar relay without revealing identity material.

Both surfaces deviate from the workspace-canonical `mosaic:KIND:v1`
colon-namespaced label pattern used for L0/L1 derivation, manifest
signing, sidecar transcript, etc. (`crates/mosaic-crypto/tests/kdf_and_auth_label_lock.rs`).
At the late-v1 audit (commit `757fe0a`) reviewers asked for the
divergence to be locked rather than retrofitted; this ADR records why.

## Decision

The following parameters are frozen for v1:

| Derivation | Primitive | Key/IKM | Label | Salt | Output | Truncation |
|---|---|---|---|---|---|---|
| LocalAuth account-salt | HMAC-SHA-256 | 32-byte `user_salt` (HMAC key) | `mosaic_account_salt` (HMAC message) | n/a | 16 bytes | Take first 16 bytes of HMAC tag |
| Sidecar room ID | HKDF-SHA-256 | Pairing `msg1` bytes | `mosaic.sidecar.v1.room` (HKDF info) | empty | 16 bytes | HKDF-Expand directly to 16 bytes |

### Rationale per axis

#### Why HMAC-SHA-256 for the account-salt, not HKDF?

The account-salt derivation pre-dates the workspace's adoption of HKDF as
the canonical mixer. The web client at v1 freeze had already shipped
`derive_account_salt` as `HMAC-SHA-256(key=user_salt, msg="mosaic_account_salt")`
and the backend was returning derivations of that exact construction to
clients in production. Replacing it with HKDF would shift every
already-issued account-salt by 16 deterministic bytes, invalidating every
saved client unlock state for every existing user — a v1 freeze breaker.

HMAC is a sound choice for this specific shape (single-step, fixed
short-message, no chaining). HKDF would be a small purity win at the
cost of catastrophic ecosystem churn, so HMAC is retained.

#### Why HKDF-SHA-256 for the sidecar room, not HMAC?

The sidecar room derivation came in after the Rust-core canonical
amendment (ADR-005, ADR-020) and is therefore on the modern HKDF path
from day one. HKDF-Expand is the natural primitive for "stretch a
secret seed to a label-tagged 16-byte identifier" without the
keyed-MAC framing of HMAC, which would require either inventing a
synthetic "message" or threading both clients' identifiers in.

#### Why labels deviate from `mosaic:KIND:v1`?

The canonical namespace `mosaic:KIND:v1` (e.g. `mosaic:root-key:v1`,
`mosaic:tier:thumb:v1`) was retrofitted across the workspace **after**
both labels in this ADR were already shipping in clients:

- `mosaic_account_salt` (snake_case) was the original web-only LocalAuth
  derivation label; converting it to `mosaic:account-salt:v1` post-ship
  would mean every existing user's account-salt shifts.
- `mosaic.sidecar.v1.room` (dot-notation) followed the legacy
  STUN/TURN-style channel-naming convention before the colon
  namespace was canonicalised; the dotted form was already serialised
  into deployed pairing transcripts.

Both labels are recognised as pre-existing exceptions to ADR-026 (the
namespace policy lock). New v1.x labels MUST use `mosaic:KIND:v1`;
these two are grandfathered.

#### Why 16-byte truncation?

The account-salt is fed back into client-side Argon2id as the salt
parameter. 16 bytes is the canonical Argon2 salt length and matches
libsodium's `crypto_pwhash_argon2id_SALTBYTES`. Going longer would force
the client to truncate anyway; going shorter would underutilise the
Argon2 salt space.

The sidecar room ID is a public rendezvous identifier — its only
properties are unforgeability (against an attacker who doesn't hold
`msg1`) and collision resistance over the pairing set. 16 bytes gives
~64-bit second-preimage resistance against an attacker actively
brute-forcing pairings on a relay they control; well above the relay's
practical query budget for a ≤50-user deployment.

#### Why empty salt for the sidecar HKDF?

HKDF separates an extract step (which uses a salt as the HMAC key) from
an expand step (which uses an info label). For the sidecar room the
caller already controls the IKM directly (`msg1` is fresh per pairing
session), so an additional non-secret salt buys nothing: HKDF with empty
salt collapses to HKDF-Expand of a label, which is exactly the desired
"label-tagged identifier" semantics. Adding a non-empty salt would just
be ceremony.

## Consequences

- These two labels are locked. Any v1.x change to `ACCOUNT_SALT_HMAC_INFO`
  or `SIDECAR_ROOM_HKDF_INFO` is a wire-breaking change requiring a
  version bump, migration vectors, and lock-test updates.
- ADR-026 (label namespace policy) explicitly tolerates these two labels
  as pre-existing exceptions and locks the `mosaic:KIND:v1` pattern for
  everything else.
- Future maintainers reading `derive_account_salt` /
  `derive_sidecar_room_id` and wondering "why this primitive, why this
  label, why this truncation" can read this ADR instead of git-archaeology
  through commit `757fe0a` lineage.

## References

- `crates/mosaic-crypto/src/lib.rs:188-192` (constant definitions)
- `crates/mosaic-crypto/src/lib.rs:1046-1080` (derivations)
- `crates/mosaic-parity-tests/tests/cross_platform_parity.rs:430-457` (parity locks)
- `docs/IMPLEMENTATION_PLAN.md` §11 rows 13, 14
- ADR-026: KDF/AAD namespace policy
- Commit `757fe0a` (sixth-audit BLOCKER fix that froze the labels)
