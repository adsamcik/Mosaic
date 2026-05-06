# SPEC-R-C5.5-MigrationDesign

> **Status**: Design proposal pending review.
> **Author**: research-r-c5-5-design-memo (Opus 4.7 1M).
> **Source**: R-C5.5 audit checkpoint (commit `2d17c47`).
> **Sister tickets**: r-c5-5-migrate-link-secret-for-url, r-c5-5-migrate-derive-link-keys-from-raw-secret, r-c5-5-migrate-verify-and-open-bundle-with-recipient-seed
> **Related**: ADR-006, R-C6 (`88c443e`), R-C6.3 (`e3cd3e8`), P-W7.1 (`e334a66`), P-W7.6 (`f89f86b`)

## 1. Executive Summary

The R-C5.5 audit flagged five raw-secret FFI exports for migration. Two
(`LinkKeysFfiResult.wrapping_key`, `OpenedBundleFfiResult.epoch_seed`) have
unambiguous handle-based replacements and are being executed in parallel under
`r-c5-5-migrate-bundle`. The remaining three need design choices because each
one is ambiguous in a different way: one is a *bearer token by design*, one is
an *input* parameter (the function itself is the dangerous surface), and one is
*already superseded* by a handle-based variant whose only remaining callers are
cross-client corpus tests.

The recommended decisions are: (1) For `link_secret_for_url`, **keep the field
in its current location but rename it `link_url_token` and add a Rust-owned
`mint_share_link_url` helper** so the URL fragment is assembled inside Rust for
the common case; the raw bytes are still permitted to cross FFI for the share
flow because they ARE the URL fragment that the user copies and pastes. (2) For
`derive_link_keys_from_raw_secret`, **leave the function as a `#[cfg(test)]`-
gated cross-client corpus driver** (matching `derive_identity_from_raw_seed`'s
posture) and add a production-grade alternative `redeem_link_url(token_bytes)
→ LinkTierHandleId` that *consumes* the token into a handle in one step, with
no intermediate raw-key exposure. (3) For
`verify_and_open_bundle_with_recipient_seed`, the audit confirms it is a legacy
corpus-only path with zero production consumers — **gate it behind a
`cross-client-vectors` Cargo feature** so it is excluded from the default
`mosaic-uniffi` build, then update the architecture allowlist to recognise the
feature gate (rather than deleting outright, which would break Slice 0C round-
trip tests).

These three migrations have a clean dependency ordering: #3 ships first
(mechanical feature-gate, no API churn for production callers), #1 ships second
(adds new helper, deprecates field name), #2 ships last (depends on #1's
`mint_share_link_url` to define the input format for the new
`redeem_link_url`). All three are v1-safe additive changes if executed in this
order; only the `derive_link_keys_from_raw_secret` rename in #2 is a UniFFI
breaking change, and the impact is bounded to one Android adapter file plus
golden-file regeneration.

## 2. Migration #1: `link_secret_for_url`

### Current state

`link_secret_for_url` is a **struct field**, not a top-level function. It
appears on three result types:

- `mosaic_wasm::CreateLinkShareHandleResult.link_secret_for_url`
  (`crates/mosaic-wasm/src/lib.rs:576-585`).
- `mosaic_uniffi`/`mosaic_client::CreateLinkShareHandleResult.link_secret_for_url`
  (`crates/mosaic-client/src/lib.rs:702-711`).
- Debug impls already redact to `_len` only
  (`crates/mosaic-wasm/src/lib.rs:587-599`,
  `crates/mosaic-client/src/lib.rs:713-725`).

The bytes are produced by `crypto_generate_link_secret()` and stored in the
Rust-side `LinkShareRecord` registry as `Zeroizing<Vec<u8>>`
(`crates/mosaic-client/src/lib.rs:2108-2126, 2139-2166`). The struct field
returns a clone so the caller can build the share URL.

The single production consumer is `apps/web/src/hooks/useShareLinks.ts:238-261`,
which extracts `created.linkSecretForUrl` and passes it to a TS helper that
base64url-encodes it into the URL fragment, then to `wrapWithAccountKey` for
local persistence (`apps/web/tests/use-share-links.test.ts:117-267`).

### Why this is unusual

Unlike a wrapping key, this byte string is **a bearer token by design**. The
secrecy property is "anyone with the URL has access" — exactly the same
threat model as a Bitwarden Send link or a Dropbox share link. Putting it
behind an opaque handle does not improve security because the user copies the
URL into a chat app within seconds; the bytes are designed to be externally
serialised. The audit flag is therefore a **naming/contract problem**, not a
key-leakage problem: the word "secret" in the name suggests the bytes are L1/
L2/L3 key material, when in fact they are a URL fragment seed.

### Options

#### Option A: Rust-owned URL assembly (`mint_share_link_url`)

Add a top-level FFI export `mint_share_link_url(link_share_handle, base_url) →
String` that consumes the handle and emits the full share URL inside Rust. The
`link_secret_for_url` field is removed from `CreateLinkShareHandleResult`.

- **Pros**: Strongest possible secret hygiene; raw bytes never cross FFI.
- **Cons**: Forces Rust to know about URL formats (base URL, path, fragment
  encoding) and adds a serialisation contract to the v1-frozen protocol.
  Web app currently controls URL shape via TS helpers (`encodeLinkSecret`);
  moving this to Rust requires a new SPEC for share-link URL canonicalisation.
  Locale/UTM/preview-routing concerns are application-layer, not crypto.
- **Implementation effort**: **L** (new SPEC, three SDKs, web hook rewrite,
  golden-file URL parity tests).

#### Option B: Rename to `link_url_token` (acknowledge bearer-token semantics)

Rename the field to `link_url_token` (or `share_link_token_bytes`) and update
the doc comment to make the bearer-token classification explicit. The bytes
keep crossing FFI, but the architecture-guard allowlist gets a permanent
classification: "this field is a designed-bearer URL fragment, not a wrapping
key." Update the allowlist comment to reference this SPEC.

- **Pros**: Zero functional change; eliminates the misleading "secret" name
  that triggered the audit; cheap to ship; preserves v1 wire-format.
- **Cons**: The bytes still cross FFI. The architecture guard needs a
  permanent allowlist entry (not a `MIGRATION-PENDING` placeholder); some
  reviewers may view this as "papering over" the audit finding.
- **Implementation effort**: **S** (rename, update Debug, update allowlist
  comment to `BEARER-TOKEN: link URL fragment seed`, regenerate UniFFI/WASM
  goldens, update single web call site).

#### Option C: Token handle (`LinkUrlTokenHandle`) + `consume_token_to_url_fragment`

Wrap the token in a handle, expose a separate `token_handle_to_url_fragment(h:
LinkUrlTokenHandle) → String` consumer. Forces all callers to take a handle,
call the consumer, then drop the handle.

- **Pros**: Symmetric with the rest of the handle API.
- **Cons**: Pure ceremony — the consumer immediately produces the same bytes
  as a string, so the "handle" exists for ~one tick. Adds two new FFI exports
  and a registry slot for negligible security gain. The result string is
  itself the shareable artifact; once produced it is just as exposed.
- **Implementation effort**: **M**.

### Recommendation

**Hybrid: Option B (rename) ships in this migration; Option A becomes a
follow-up SPEC.**

The rename is the correct response to the audit finding. The name
`link_secret_for_url` confuses reviewers because "secret" connotes wrap-key
material; "token" correctly classifies the bytes as a bearer credential. After
renaming and a permanent allowlist entry, the architecture guard is no longer
flagging a *security risk*; it is flagging a *legitimately exposed bearer
token*, identical to how OAuth refresh tokens or password-reset URL parameters
are handled.

A future `mint_share_link_url` (Option A) is desirable as a defence-in-depth
measure but requires a separate SPEC for share-link URL canonicalisation
(base URL, fragment encoding, locale path) and is **out of scope** for R-C5.5.
Track it as a follow-up: `r-c8-rust-owned-share-link-urls`.

### Consumer impact

| Surface | Change |
|---|---|
| `crates/mosaic-client/src/lib.rs:702-756, 2108-2166` | Field rename + zeroizing intact. |
| `crates/mosaic-wasm/src/lib.rs:572-599, 1233, 2059-2120, 3166, 4221` | Field rename + Debug redaction stays. |
| `apps/web/src/workers/rust-crypto-core.ts:538-547, 585-592` | TS field rename. |
| `apps/web/src/workers/crypto.worker.ts:1809-1863` | TS field rename. |
| `apps/web/src/workers/types.ts:1070-1090` | Interface rename. |
| `apps/web/src/hooks/useShareLinks.ts:240, 260` | TS field rename + comment update. |
| `apps/web/tests/use-share-links.test.ts:117-267`, `apps/web/src/workers/__tests__/link-share-handle-roundtrip.test.ts:8-85` | Test field rename. |
| Generated WASM bindings (`apps/web/src/generated/mosaic-wasm/*`) | Re-run `wasm-pack`. |
| `crates/mosaic-uniffi/tests/golden/uniffi_api.txt`, `crates/mosaic-wasm/tests/golden/mosaic_wasm.d.ts:108,627,632,792` | Golden regen. |
| `tests/architecture/no-raw-secret-ffi-export.{sh,ps1}:56-60` | Convert `MIGRATION-PENDING` to `BEARER-TOKEN-PERMITTED` with SPEC link. |

### Wire-format / protocol implications

**v1-safe additive (no protocol break).** The bytes themselves are unchanged
(32-byte URL fragment seed, same base64url encoding, same KDF input). Only the
struct field name in generated bindings changes. URL fragments produced before
and after the rename are bit-identical and continue to redeem on the new code.

### Implementation effort: **S** (1-2 days, mostly mechanical).

## 3. Migration #2: `derive_link_keys_from_raw_secret`

### Current state

UniFFI-only function, `crates/mosaic-uniffi/src/lib.rs:2173-2202`:

```rust
#[uniffi::export]
pub fn derive_link_keys_from_raw_secret(link_secret: Vec<u8>) -> LinkKeysFfiResult {
    let mut secret_buf = link_secret;
    let result = match mosaic_crypto::derive_link_keys(&secret_buf) { ... };
    secret_buf.zeroize();
    result
}
```

Returns `LinkKeysFfiResult { code, link_id, wrapping_key }`. The
`wrapping_key` field is the *other* MIGRATE entry already being handled by
`r-c5-5-migrate-bundle` (replacement: handle-based variant).

Live callers:
- `apps/android-main/.../bridge/AndroidRustLinkKeysApi.kt:24` — adapter, only
  invoked by `AndroidRustLinkKeysApiRoundTripTest.kt:32,45,56` (test-only).
- `apps/android-shell/.../CrossClientVectorTest.kt:335` — corpus driver test.

Doc comment (lines 2176-2178): *"Used by the cross-client `link_keys.json`
corpus driver. Production code should use the higher-level link-sharing
helpers, not this raw-input surface."*

The web platform never uses this function — there is no
`deriveLinkKeysFromRawSecret` in `apps/web`. The web import path is
`importLinkShareHandle(link_secret_for_url) → LinkTierHandleResult`
(`crates/mosaic-wasm/src/lib.rs:2077`,
`apps/web/src/workers/rust-crypto-core.ts:554-561`), which already takes the
URL token and returns a handle in one step — never exposing the wrapping key.
This is the production "redeem URL" path on web.

The Android shell has no production redeem flow yet (Android is upload/
import-only in v1), so the function exists *only* for cross-client parity
testing.

### Options

#### Option A: Replace `Vec<u8>` parameter with `LinkUrlTokenHandle`

Convert the function to take a handle instead of raw bytes:
`derive_link_keys_from_token_handle(token: LinkUrlTokenHandleId) →
LinkKeysFfiResult`.

- **Pros**: Aligns with handle-style API.
- **Cons**: The function's *purpose* is to be a corpus driver — the test
  fixture supplies raw bytes from `link_keys.json` to verify Rust derives
  the same `link_id`/`wrapping_key` as TS. Wrapping the input in a handle
  defeats the test's purpose (you'd need a separate "load raw token into
  handle" helper, which itself is a raw-secret FFI surface). Also the
  `wrapping_key` *output* is the bigger problem, and it is already being
  fixed by the in-flight `r-c5-5-migrate-bundle`.
- **Effort**: **M** (new handle type, registry plumbing).

#### Option B: Pull derivation inside Rust (`redeem_share_link_url`)

Expose only `redeem_share_link_url(url: String) → LinkTierHandleId` and delete
`derive_link_keys_from_raw_secret`. Rust parses the URL, extracts the
fragment, derives keys, registers the handle.

- **Pros**: Zero raw-secret crossings on the redeem path.
- **Cons**: Already exists on web as `importLinkShareHandle` (which takes the
  fragment bytes, not the URL — the URL parsing is a thin TS layer). Deleting
  the corpus driver means cross-client parity for `link_keys.json` is no
  longer enforced; any divergence in `derive_link_keys` between Rust and TS
  would go undetected.
- **Effort**: **L** (URL parser SPEC, delete corpus driver, rewrite golden
  vectors).

#### Option C: Keep as `#[cfg(test-fixtures)]`-gated corpus driver

Match the posture of `derive_identity_from_raw_seed`
(`crates/mosaic-uniffi/src/lib.rs:2204-2254`) which has the same
"corpus-driver-only" docstring. Gate `derive_link_keys_from_raw_secret`
behind a Cargo feature `cross-client-vectors` (default-off in production
UniFFI builds; default-on in `mosaic-uniffi.tests` and the Android
cross-client test target). Document the bearer-input contract; the
`wrapping_key` *output* is already handled by `r-c5-5-migrate-bundle`.

- **Pros**: Preserves cross-client parity testing; removes the surface from
  the production UniFFI ABI; complements the in-flight bundle migration.
  Symmetric with how `derive_identity_from_raw_seed` is treated post-R-C5.5
  (it's also a corpus-only export).
- **Cons**: Requires a new Cargo feature in `mosaic-uniffi`; Android test
  targets must opt-in; the architecture-guard allowlist needs a
  `CORPUS-DRIVER-ONLY: gated by feature='cross-client-vectors'` entry.
- **Effort**: **S-M** (feature flag, Android Gradle wiring, allowlist update).

### Recommendation

**Option C: feature-gate as `cross-client-vectors`-only.**

Rationale: this function's *only* purpose is cross-client parity testing — it
has no production consumers on either web or Android. The parity coverage is
load-bearing for ADR-006 compositional-attack defence (`docs/adr/ADR-006-ffi-
api-secret-handles.md:34-60`), because if Rust's `derive_link_keys` diverged
silently from TS, a link redeemed on web would produce different
`link_id`/`wrapping_key` than the same link on Android, breaking shares.
Keeping the function *and* taking it out of the production ABI is the correct
balance.

The output-side concern (`wrapping_key` in `LinkKeysFfiResult`) is already
being addressed by the in-flight `r-c5-5-migrate-bundle` agent. After both
land, the function will be (a) feature-gated out of production builds and
(b) returning a handle instead of raw bytes when invoked under the test
feature. Both gates close the audit finding.

### Consumer impact

| Surface | Change |
|---|---|
| `crates/mosaic-uniffi/Cargo.toml` | Add feature `cross-client-vectors`. |
| `crates/mosaic-uniffi/src/lib.rs:2183` | `#[cfg(feature = "cross-client-vectors")]` gate. |
| `apps/android-shell/build.gradle.kts` | Add feature to test classifier; production classifier excludes it. |
| `apps/android-main/.../AndroidRustLinkKeysApi.kt:24` | Move from `main` to `androidTest` source set, OR delete if test-only. |
| `apps/android-main/.../AndroidRustLinkKeysApiRoundTripTest.kt` | No change (already test code; consumes feature-gated symbol). |
| `tests/architecture/no-raw-secret-ffi-export.{sh,ps1}:63,67` | Replace `MIGRATION-PENDING` with `CORPUS-DRIVER-ONLY: feature=cross-client-vectors`. |
| Golden API snapshot `crates/mosaic-uniffi/tests/golden/uniffi_api.txt:289` | Regenerated with feature off → entry removed; separate `uniffi_api.cross-client-vectors.txt` snapshot tracks the gated surface. |

### Wire-format / protocol implications

**v1-safe.** Function disappears from production UniFFI bindings; no
production caller exists (verified), so no protocol/contract break. The
algorithm is unchanged, only the symbol's visibility changes.

### Implementation effort: **S-M** (3-4 days; gradle wiring is the slow part).

## 4. Migration #3: `verify_and_open_bundle_with_recipient_seed`

### Current state

UniFFI-only function, `crates/mosaic-uniffi/src/lib.rs:2386-2469`. Doc comment
explicitly classifies it as legacy corpus-only:

> *"Used exclusively by the cross-client `sealed_bundle.json` corpus driver.
> Production code should use the handle-based
> `verify_and_open_bundle_with_identity_handle`."*

The handle-based replacement is a first-class production export:
- WASM: `verify_and_import_epoch_bundle` (`crates/mosaic-wasm/src/lib.rs:2145-
  2156, 2987-2998`), exposed to JS as `verifyAndImportEpochBundle`.
- Client: `verify_and_import_epoch_bundle_with_identity_handle`
  (`crates/mosaic-client/src/lib.rs:2478`).
- Web: in active use via `apps/web/src/workers/rust-crypto-core.ts:652-675`
  and `apps/web/src/workers/crypto.worker.ts:1172-1177`.
- Tests: `crates/mosaic-wasm/tests/bundle_facade.rs:98-354` and
  `crates/mosaic-client/tests/epoch_bundle_handles.rs:82-109` cover the
  handle-based path comprehensively.

Live callers of the legacy function (verified via grep across `apps/`,
`crates/`, `tests/`):

| Caller | Path | Production? |
|---|---|---|
| `AndroidRustSealedBundleApi.verifyAndOpenBundleWithRecipientSeed` | `apps/android-main/.../bridge/AndroidRustSealedBundleApi.kt:25` | **No** — adapter explicitly states *"Only Slice 0C round-trip tests are permitted to reference this class"* (lines 14-17). |
| `AndroidRustSealedBundleApiRoundTripTest` | `apps/android-main/.../bridge/AndroidRustSealedBundleApiRoundTripTest.kt:26-198` | Test-only (8 sites). |
| `CrossClientVectorTest` | `apps/android-shell/.../CrossClientVectorTest.kt:697` | Test-only. |

There are **zero production callers** in `apps/web/`, `apps/android-main/`
(production source set), or in any `crates/` non-test target.

### Options

#### Option A: Confirm legacy + DELETE

Remove the function outright; delete the Android adapter; rewrite Slice 0C
round-trip tests to use `verify_and_open_bundle_with_identity_handle` (which
exists at `crates/mosaic-client/src/lib.rs` per the audit comments).

- **Pros**: Cleanest possible outcome; one less raw-secret surface forever.
- **Cons**: Slice 0C round-trip tests intentionally exercise the
  *cross-client* sealed-bundle parity vector with raw inputs to detect
  divergence between Rust and TS sealed-bundle implementations. Deleting the
  raw-input test path means cross-client parity for sealed bundles is no
  longer mechanically enforced; we rely on the handle path being equivalent
  by inspection.
- **Effort**: **M** (rewrite 8 test sites, delete adapter, regenerate
  goldens).

#### Option B: Migrate to handle-based variant

Replace the body to take an identity handle instead of a raw seed, returning
an opaque `EpochKeyHandleId` instead of a raw `epoch_seed`. Effectively
duplicates `verify_and_import_epoch_bundle` for UniFFI parity.

- **Pros**: Maximum surface reduction.
- **Cons**: Duplicates an existing function under a different name; raises
  the question "why two functions?". The corpus-driver tests legitimately
  *need* to feed raw seeds because the test vector corpus is raw.
- **Effort**: **M-L**.

#### Option C: Feature-gate as `cross-client-vectors`-only (mirror Migration #2)

Apply the same feature gate as `derive_link_keys_from_raw_secret`. The
function survives behind the test feature; production UniFFI builds do not
expose it.

- **Pros**: Preserves Slice 0C cross-client parity testing; removes from
  production ABI; uniform treatment with Migration #2; minimal churn.
- **Cons**: Requires the `cross-client-vectors` feature to land first (or
  in the same change).
- **Effort**: **S** (one `#[cfg(...)]` gate, allowlist update, Android
  Gradle test classifier change shared with Migration #2).

### Recommendation

**Option C: feature-gate behind `cross-client-vectors`** — the same gate as
Migration #2.

Rationale: the audit finding is "raw seed crosses FFI in production builds."
Feature-gating closes that finding (production builds no longer contain the
symbol) while preserving the legitimate test-only use case (cross-client
parity for `sealed_bundle.json` corpus). The handle-based replacement
(`verify_and_import_epoch_bundle`) already covers all production code paths.

Option A (delete) is tempting but loses the parity check; if Rust's
`SealedBundle` decoding silently diverged from TS, only the raw-input corpus
test would catch it. Option B duplicates a function for marginal benefit.

### Consumer impact

| Surface | Change |
|---|---|
| `crates/mosaic-uniffi/src/lib.rs:2386` | `#[cfg(feature = "cross-client-vectors")]` gate. |
| `apps/android-main/.../bridge/AndroidRustSealedBundleApi.kt` | Move from `main` to `androidTest` source set; the docstring already says "test-only." |
| `apps/android-main/.../bridge/AndroidRustSealedBundleApiRoundTripTest.kt` (8 sites) | No code change; lives in test source set already. |
| `apps/android-shell/.../CrossClientVectorTest.kt:697` | No change. |
| `tests/architecture/no-raw-secret-ffi-export.{sh,ps1}:64,68` | `MIGRATION-PENDING` → `CORPUS-DRIVER-ONLY: feature=cross-client-vectors`. |
| `crates/mosaic-uniffi/tests/golden/uniffi_api.txt:294` | Regenerated → entry removed; appears in `uniffi_api.cross-client-vectors.txt`. |

### Wire-format / protocol implications

**v1-safe.** The sealed-bundle on-the-wire format is unchanged; only the
symbol's *visibility* in the production UniFFI surface changes. Production
code already uses `verify_and_import_epoch_bundle_with_identity_handle`.

### Implementation effort: **S** (1-2 days, can share infrastructure with
Migration #2).

## 5. Cross-Migration Interactions

### Constraint: Migration #1 enables Migration #2's naming

If Migration #1 renames `link_secret_for_url → link_url_token`, then
Migration #2's hypothetical Option A (`derive_link_keys_from_token_handle`)
would naturally be named `derive_link_keys_from_url_token`. This is mostly
cosmetic — the recommended path (Option C feature-gate) does not depend on
the rename — but if the orchestrator prefers handle-input for Migration #2 in
a future revision, the type name `LinkUrlToken*` will already exist.

### AAD prerequisites

ADR-006's compositional-attack defence (`docs/adr/ADR-006-ffi-api-secret-
handles.md:34-60`) introduced per-domain AAD strings. The link-sharing
flow already has AAD coverage (per `SPEC-AeadDomainSeparation.md:36`: "in the
account/epoch/identity/link handle families"). **No new AAD constants are
required for any of the three migrations.** The reasoning:

- Migration #1 changes a struct field name; the underlying ciphertext domain
  for tier-key wraps under the link wrapping key is unchanged.
- Migration #2 feature-gates a function whose semantics (HKDF derivation of
  `link_id`/`wrapping_key` from a 32-byte secret) are not AEAD-bound; AAD
  does not apply.
- Migration #3 feature-gates a function that consumes the existing
  `mosaic:l3-epoch-seed:v1` AAD-bound sealed bundle; the AAD constant
  already exists.

### Conflict check with `r-c5-5-migrate-bundle` (in flight)

The in-flight `r-c5-5-migrate-bundle` agent is migrating
`LinkKeysFfiResult.wrapping_key` and `OpenedBundleFfiResult.epoch_seed` to
handle-based outputs. Conflict analysis:

- **Migration #1** touches `CreateLinkShareHandleResult` (different type).
  No file overlap with `LinkKeysFfiResult` or `OpenedBundleFfiResult`. ✅
- **Migration #2** touches `derive_link_keys_from_raw_secret` which
  *returns* `LinkKeysFfiResult`. The in-flight agent is rewriting that
  return type. **Conflict surface**: both will edit
  `crates/mosaic-uniffi/src/lib.rs` near line 2183-2202. Resolution: this
  migration ships **after** `r-c5-5-migrate-bundle` so the feature gate
  wraps the post-migration function shape. ⚠️
- **Migration #3** touches `verify_and_open_bundle_with_recipient_seed`
  which returns `OpenedBundleFfiResult`. Same conflict pattern as #2.
  Resolution: ship **after** `r-c5-5-migrate-bundle`. ⚠️

### Conflict check with R-C5.5.1 (`tests/architecture/`)

R-C5.5.1 is editing `tests/architecture/`. All three migrations also need to
edit the allowlist files (`no-raw-secret-ffi-export.{sh,ps1}`). **Coordinate
via the orchestrator**: either (a) R-C5.5.1 lands first and these migrations
diff against the post-R-C5.5.1 allowlist shape, or (b) these migrations
provide allowlist diffs that R-C5.5.1 incorporates.

### Conflict check with R-C7-3 (`apps/web` + uniffi tests)

R-C7-3 edits `apps/web` and uniffi tests. Migration #1's web-side rename
touches `apps/web/src/hooks/useShareLinks.ts`, `apps/web/src/workers/`, and
test files. **Likely conflict surface**. Recommendation: Migration #1 ships
after R-C7-3 lands, or the orchestrator sequences them.

## 6. Recommended Dispatch Order

```
Step 1: r-c5-5-migrate-bundle       (in flight)        — must finish first
Step 2: R-C7-3                      (in flight)        — must finish first
Step 3: R-C5.5.1                    (in flight)        — should finish first
Step 4: Migration #3 (verify_and_open_bundle...)        — ships first of the three
Step 5: Migration #2 (derive_link_keys...)              — ships second
Step 6: Migration #1 (link_secret_for_url rename)       — ships last
```

### Why this order

1. **Migration #3 first**: Smallest blast radius. Pure feature-gate +
   Gradle source-set move. Establishes the `cross-client-vectors` Cargo
   feature pattern that #2 will reuse. No semantic change, no rename, no
   web-side churn.

2. **Migration #2 second**: Reuses the `cross-client-vectors` feature from
   #3. Depends on `r-c5-5-migrate-bundle` having finalised the
   `LinkKeysFfiResult` shape. No web-side churn (function has no web
   caller).

3. **Migration #1 last**: Largest blast radius (touches every web file
   that consumes the field, plus generated WASM bindings, plus golden
   files). Pure rename — semantically null but mechanically broad. Easiest
   to do last when the rest of the FFI surface is stable.

### Parallel-safety considerations

- Migrations #2 and #3 share the `cross-client-vectors` feature
  infrastructure. Land them in a single PR or strictly sequence them; do
  not dispatch in parallel (Cargo feature edits collide).
- Migration #1 is parallelisable with #2/#3 *only if* `r-c5-5-migrate-
  bundle` has merged. The field rename is in `CreateLinkShareHandleResult`,
  disjoint from #2's `LinkKeysFfiResult` and #3's `OpenedBundleFfiResult`.

## 7. Test Strategy

### Per-migration regression tests

#### Migration #1 (rename)

- **Compile-time**: TypeScript strict mode catches every consumer that
  references the old field name.
- **Golden file**: `crates/mosaic-uniffi/tests/golden/uniffi_api.txt`
  diff confirms the new name, no other surface change.
- **Runtime parity**: Existing test
  `apps/web/src/workers/__tests__/link-share-handle-roundtrip.test.ts:8-85`
  re-runs with renamed field — bytes still flow through to
  `importLinkShareHandle` and produce the same `link_id`.
- **New test**: `tests/architecture/bearer-token-allowlist.rs` (or extend
  `no-raw-secret-ffi-export.sh`) asserts that `link_url_token` has the
  `BEARER-TOKEN-PERMITTED` classifier and not `MIGRATION-PENDING`.

#### Migration #2 (feature-gate)

- **Production build (default features)**: New test
  `crates/mosaic-uniffi/tests/api_shape_lock.rs` asserts the symbol
  `derive_link_keys_from_raw_secret` is **absent** when built with default
  features. (Mirror existing `api_shape_lock.rs` at
  `crates/mosaic-wasm/tests/api_shape_lock.rs:257-258`.)
- **Test build (`--features cross-client-vectors`)**: Existing
  `AndroidRustLinkKeysApiRoundTripTest.kt:32,45,56` continues to pass.
- **ADR-006 compositional attack test**: Add
  `crates/mosaic-uniffi/tests/compositional_link_keys.rs` that verifies a
  link secret derived for one album cannot decrypt a wrapped tier from a
  different album (existing AAD domain separation; this just confirms the
  feature-gate did not regress the property).

#### Migration #3 (feature-gate)

- **Production build**: API-shape-lock test asserts
  `verify_and_open_bundle_with_recipient_seed` is **absent**.
- **Test build**: `AndroidRustSealedBundleApiRoundTripTest.kt` (8 sites)
  continues to pass.
- **ADR-006 compositional attack test**: Reuse existing
  `crates/mosaic-wasm/tests/bundle_facade.rs:296` ("opened_bad_pubkey")
  pattern, ensuring a sealed bundle for sharer A cannot be opened with
  expected_owner B. This is already covered for the handle-based path; add
  parity coverage for the feature-gated raw-seed path.

### Cross-migration parity tests

- **Cross-client vector parity**: After all three migrations land, run
  `apps/android-shell/.../CrossClientVectorTest.kt` end-to-end against
  `link_keys.json` and `sealed_bundle.json` fixtures, asserting Rust
  outputs match TS outputs byte-for-byte. This is the load-bearing
  reason to *not* delete the corpus drivers.

- **Architecture-guard regression**: After all three migrations,
  `tests/architecture/no-raw-secret-ffi-export.sh` should report:
  - 0 `MIGRATION-PENDING` entries for these three items.
  - 1 `BEARER-TOKEN-PERMITTED` entry (link URL token).
  - 2 `CORPUS-DRIVER-ONLY` entries (the two feature-gated functions).

## 8. Open Questions

1. **Naming for the renamed field (Migration #1)**: prefer
   `link_url_token`, `share_link_token`, `share_link_token_bytes`, or
   `share_url_fragment_seed`? The first is shortest; the last is most
   descriptive. **Recommendation**: `link_url_token`.

2. **Cargo feature name**: `cross-client-vectors`, `corpus-vectors`, or
   `test-fixtures`? The first is most descriptive of intent. Naming
   should be coordinated with the in-flight `r-c5-5-migrate-bundle`
   agent in case it introduces a similar gate. **Recommendation**:
   `cross-client-vectors`.

3. **Should `derive_identity_from_raw_seed`
   (`crates/mosaic-uniffi/src/lib.rs:2204-2254`) be feature-gated by the
   same flag in this work?** It has the identical "corpus-driver-only"
   docstring and posture. It is *not* in the R-C5.5 MIGRATE list (audit
   classified it differently — likely because the seed input is wiped
   immediately and no secret-equivalent output crosses FFI), but for
   architectural consistency, gating it under the same flag would be
   clean. **Out of R-C5.5 scope**, but flag for follow-up.

4. **Slice 0C test source-set move**: Migration #3's plan moves
   `AndroidRustSealedBundleApi.kt` from `src/main/kotlin` to
   `src/test/kotlin` (or `androidTest`). Does the existing Slice 0C
   test runner consume this class as a *production* dependency, or is
   the test-source-set move safe? **Needs Android module owner
   confirmation.**

5. **Follow-up SPEC scheduling**: Should `r-c8-rust-owned-share-link-
   urls` (Option A from Migration #1, deferred) be scheduled now, or
   reactively if Migration #1 Option B receives security review pushback?

6. **Architecture-guard classifier vocabulary**: The current allowlist
   uses `MIGRATION-PENDING`. Introducing `BEARER-TOKEN-PERMITTED` and
   `CORPUS-DRIVER-ONLY` adds two new classifiers. Should the
   classifier set be defined in a separate SPEC (e.g.,
   `SPEC-FfiSecretClassifiers.md`)? **Recommendation**: yes; small
   meta-SPEC, ~1 page, locks the vocabulary.
