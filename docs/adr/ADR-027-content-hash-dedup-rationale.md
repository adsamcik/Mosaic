# ADR-027: SHA-256 plaintext content-hash dedup, client-computed, per-photo

## Status

Accepted, active.

The mechanism itself is described in `docs/specs/SPEC-UploadContentHash.md`;
this ADR captures the *rationale* (what, why, trade-offs) that the SPEC
deliberately omits.

## Context

Mosaic deduplicates re-uploads of the same source photo so that a user
re-running an import (or two devices uploading the same library) does
not double-bill quota or duplicate encrypted blobs. The dedup signal
must be:

1. **Computable client-side** without needing the server to see
   plaintext (zero-knowledge invariant).
2. **Stable across encryption parameters** — re-encrypting the same
   plaintext with a fresh nonce produces a fresh ciphertext, so dedup
   cannot key on ciphertext.
3. **Stable across re-encodes of the encrypted carrier** — repacking
   the envelope (e.g. v3 → streaming v4) must not break dedup if the
   underlying plaintext is unchanged.
4. **Per-photo, not per-tier** — dedup of a single tier (e.g. only
   thumbnails matching) is meaningless because the operator-charged
   resource is the *original*, not the derived tiers.

The chosen primitive at v1 is **`SHA-256(plaintext_original_bytes)`**,
computed on the client immediately after decode-and-stripping, sent to
the backend as `content_hash` on manifest finalisation, and stored
per-photo in the manifest row. The server treats it as opaque
identifier bytes and uses it as a uniqueness key per `(userId,
content_hash)` for dedup decisions.

## Decision

### What

Each photo manifest carries a single 32-byte field `content_hash` whose
bytes are `SHA-256(canonicalised_original_plaintext)`. "Canonicalised
original plaintext" means: the original bytes the user picked, after
the deterministic exif/metadata strip the codec layer applies (per
ADR-014, ADR-017). No tier-specific bytes, no encryption material, no
post-strip image dimensions, no filename, no mtime.

### Why SHA-256 specifically?

- **Already in the workspace.** The Rust core (`mosaic_crypto::Sha256Hasher`)
  already supplies streaming SHA-256 for shard-integrity. Reusing the
  same primitive avoids adding a second hash dependency to the audited
  crypto crate set (ADR-005, ADR-020).
- **Collision resistance budget.** A 50-user deployment with a
  generous 10⁷ photos has 5×10⁸ hash values. The birthday bound for
  accidental collision in 256 bits is ~2¹²⁸; we are comfortably
  ten-plus orders of magnitude under the regime where collision risk
  is even measurable.
- **Adversarial collision is not in scope.** An attacker producing two
  distinct plaintexts with the same SHA-256 could only force two of
  *their own* photos to share a dedup key in *their own* account —
  there is no cross-account confused-deputy path here (dedup is
  keyed `(userId, content_hash)`). SHA-256's current cryptanalytic
  status (no published collision attack within practical reach) is
  more than sufficient.
- **Not BLAKE3 / BLAKE2.** They are faster but pull a second hash
  family into the WASM and UniFFI surface area for no security gain on
  this specific use case. The performance delta is irrelevant — hashing
  happens once per upload alongside encoding, which is two orders of
  magnitude slower.

### Why plaintext-not-ciphertext?

Ciphertext is non-deterministic by design — every encryption uses a
fresh 24-byte nonce (zero-knowledge invariant), so the same plaintext
encrypts to different ciphertexts. Hashing ciphertext would never
match. Hashing plaintext gives stable dedup but inherently leaks
"this account is uploading a photo whose plaintext SHA-256 is X" to
the backend, which **is** a privacy trade-off:

- A backend observer learns `(userId, sha256)` pairs. Cross-user
  collision visibility ("two users hold the same photo") is preventable
  by not exposing dedup matches across users — the v1 implementation
  scopes uniqueness per-user and does **not** return "another user
  already has this hash" to the client. The server still *learns* the
  cross-user collision internally; we accept that as the cost of dedup.
- An attacker who already knows the plaintext (e.g. a well-known
  public photo) can confirm a user uploaded it. This is a known
  weakness of plaintext-fingerprint dedup schemes (Dropbox, iCloud,
  every commercial dedup product) and is documented in the zero-knowledge
  threat model: server learns which *known* photos a user holds, but
  not the bytes of unknown photos.

Alternatives considered and rejected:

- **Per-user-keyed HMAC over plaintext.** Eliminates cross-account
  collision leak but adds a key-management surface and breaks the
  "two devices for the same user can independently compute the dedup
  key" property only if both devices share the HMAC key — which they
  already do (it would be derived from L2). Marginal privacy win,
  meaningful complexity cost. Re-visit in v1.x if a threat model
  update demands it.
- **Convergent encryption.** Real solution to cross-account dedup
  privacy but moves the cryptographic substrate substantially and is
  out of scope for v1 (would require a new ADR + parity vectors).

### Why per-photo, not per-tier?

- **Operator-charged resource is the original.** Quota is measured in
  bytes of the original blob; deduping thumbnails saves negligible
  bytes and would require a second hash field.
- **Tier derivation is deterministic from the original.** Once two
  manifests agree on `content_hash` (original), the tier blobs are
  byte-equivalent up to encryption nonce, so deduping at the original
  level transitively dedups the tier set without needing additional
  hash fields.
- **Future re-encode flexibility.** If v1.x adds a third preview tier
  (e.g. AVIF alongside AV1), the per-photo `content_hash` does not
  need to change; per-tier hashes would balloon the manifest schema.

## Consequences

- Backend stores per-photo `content_hash` as opaque 32-byte column with
  a unique index on `(user_id, content_hash)` — duplicates on
  manifest finalisation return the existing photo's manifest_id rather
  than allocating a new row (idempotency for dedup).
- A user uploading the same photo twice from two devices sees the
  second upload report "already exists" and skip blob upload (saves
  bandwidth + storage).
- The plaintext-hash leak is part of the documented zero-knowledge
  trade-off in `docs/SECURITY.md` and `RELEASE_NOTES_v1.0.0.md`'s
  non-goals section.
- Convergent-encryption-style cross-account dedup is **not** a v1
  feature; the implementation cannot accidentally expose cross-user
  duplicate matches because the API endpoint scopes lookup by
  authenticated user.

## References

- `docs/specs/SPEC-UploadContentHash.md` (the wire shape)
- `crates/mosaic-crypto/src/lib.rs` — `Sha256Hasher` (the primitive)
- ADR-005: pure-Rust crypto dependencies
- ADR-014: codec-choice parity strictness (defines canonical plaintext)
- ADR-017: sidecar tag registry policy (defines stripping)
- `docs/SECURITY.md` — zero-knowledge trade-offs
