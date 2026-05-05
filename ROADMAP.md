# Mosaic — Programme Roadmap

> **Status:** Active development towards v1. All commits go directly to `main`.
> **Last refresh:** 2026-05-05 (HEAD commit hash recorded post-commit).
> **Source of truth for completion state:** SQL todos table + `docs/IMPLEMENTATION_PLAN.md` §12.1 ticket ledger.
> **Programme tally:** 106 done / 74 pending / 0 blocked (180 total).

---

## 1. Executive Summary

The Rust core migration is substantively complete for the **crypto, state-machine, and media-strip** axes. The remaining work splits into three distinct programmes:

| Programme | Lane | Pending | Critical path |
|-----------|------|---------|---------------|
| **FFI surface completion** | P-U / P-W | 9 | P-W2 (now unblocked post-R-M1.1) → P-W6 / P-U6 regen → snapshot lock |
| **Web client cutover** | W-* | 14 | W-S1 → W-S2/S3 → W-S4 → W-A series → W-A6 E2E |
| **Android client implementation** | A-* | 30 | A1 (INTERNET) → A2-A4 (foundation) → A6/A7 (media) → A8/A9 (workers) → A13 (reducer) → A15-A17 (service+permission flip) → A18 (E2E) |
| **Backend** | B-* | 5 | B1+B2 → B3 → B4 → B5 |
| **Quality / freeze** | Q-final-* | 4 | Q-final-1 (parity) + Q-final-3 (E2E matrix) + Q-final-4 (perf budgets) → Q-final-5 (re-freeze) |
| **v2 / deferred** | r-c6-3-v2, r-c8 | 2 | Out of v1 scope |
| **Review follow-ups** | wave5-*, wave6-*, wave7-* | 5 | Small docs/tests; bundle into ledger sweeps |

**Already locked / frozen for v1:**
- Cryptographic invariants (XChaCha20-Poly1305 envelopes, Argon2id KDF, HKDF labels, Ed25519/X25519 contexts, manifest transcript, AAD domain separation) — see `IMPLEMENTATION_PLAN.md` §11 Late-v1 Irreversibility Register.
- ADR-006 FFI handle architecture; raw-secret guards in producer + consumer.
- Sidecar tag registry (1-15) with R-M5.2.2's 64 KiB cap.
- All 5 R-C5.5 raw-secret migrations closed.
- Architecture-guard allowlist classifier vocabulary (SPEC-FfiSecretClassifiers v1).
- Telemetry counter ring buffer (ADR-018).

---

## 2. Lane Definitions

```text
┌──────────────────────────────────────────────────────────────┐
│  R-* (Rust core)                                             │
│  ├── R-C*  Crypto + envelope                                 │
│  ├── R-Cl* Client core (state machines, DTOs, snapshots)     │
│  ├── R-M*  Media (strip, inspect, sidecar)                   │
│  └── R-ADR-*  Architecture decisions                         │
│                                                              │
│  P-* (Wrappers)                                              │
│  ├── P-U*  UniFFI surface (Android/iOS bindings)             │
│  └── P-W*  WASM surface (web bindings)                       │
│                                                              │
│  W-* (Web client)                                            │
│  ├── W-S*  Crypto worker handle-API surface migration        │
│  ├── W-I*  Image inspect / strip migration                   │
│  ├── W-V*  Video container migration                         │
│  ├── W-A*  Adapter port + manifest cutover + rollout         │
│  └── W-pre-* / W-post-*  Pre / post cutover hygiene          │
│                                                              │
│  A-* (Android client)                                        │
│  ├── A-pre-* / A1-A4  Foundation (INTERNET, OkHttp, Room)    │
│  ├── A5-A9  Workers (Tus, encryption, upload)                │
│  ├── A10-A12  Network clients (manifest, sync)               │
│  ├── A13a-c  Reducer + persistence + retry scheduling        │
│  ├── A14-A17  UX (picker, FG service, audit, permission)     │
│  └── A18a-g  E2E coverage matrix                             │
│                                                              │
│  B-* (Backend) — language/runtime to be confirmed            │
│                                                              │
│  Q-final-*  Cross-platform parity, perf, re-freeze           │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Done — By Lane (106 tickets)

### 3.1 ADRs (12 done)

`R-ADR-012` INTERNET trust boundary · `R-ADR-013` Streaming AEAD · `R-ADR-014` Codec choice + parity · `R-ADR-015` Album story (deferred) · `R-ADR-016` Web encrypted local cache (deferred) · `R-ADR-017` Sidecar tag registry · `R-ADR-018` Telemetry / kill-switch · `R-ADR-019` Cert pinning posture · `R-ADR-020` Supply-chain amendment · `R-ADR-021` Legacy raw-key sunset · `R-ADR-022` Manifest finalization · `R-ADR-023` Persisted snapshot schema · `R-ADR-024` Video preview-tier policy.

### 3.2 Rust core — Crypto (R-C*) (10 done)

`R-C1` Error codes + lock test · `R-C1.1` Cross-platform parity · `R-C2` `verify_shard_integrity` · `R-C3` Tier-key handle utilities · `R-C3.1` Telemetry counter ring buffer (ADR-018) · `R-C5.1` API-shape lock-test infrastructure · `R-C5.2` UniFFI/WASM type symmetry · `R-C5.3` Lock-test infrastructure hardening · `R-C5.4` UniFFI parser hardening (async/path/skip_typescript) · `R-C6` ADR-006 compositional violation closure (binary-confirmed F-1 attack chain).

### 3.3 Rust core — Client state machines (R-Cl*) (4 done)

`R-Cl1` Upload state-machine DTO finalization · `R-Cl1.1` Upload+AlbumSync correctness follow-up · `R-Cl1.2` ManifestCommitUnknown retry trap + AlbumSync exhaustion + legacy snapshot migration · `R-Cl2` Sync state-machine DTO finalization · `R-Cl3` Snapshot schema versioning · `R-Cl4` Platform-neutral port contract SPEC.

### 3.4 Rust core — Media (R-M*) (10 done)

`R-M1` AVIF strip + bounded ISO-BMFF parser · `R-M1.1` iloc offset rewrite (real-world decode-preservation) · `R-M2` HEIC strip · `R-M3` EXIF GPS extraction (hostile parser) · `R-M4` Device timestamp + Make/Model + subseconds + timezone · `R-M5` Sidecar tag registry SPEC + lock test · `R-M5.1` Sidecar registry correctness pass · `R-M5.2` Sidecar registry follow-up fixes · `R-M5.2.1` Tag 6 Forbidden + ForbiddenTag variant · `R-M5.2.2` `MAX_SIDECAR_TOTAL_BYTES` 64 KiB pre-v1 freeze · `R-M6` Video container inspection (MP4/MOV/WebM/Matroska) · `R-M6.1` stco/co64 chunk-offset rewrite for video strip · `R-M7` Video sidecar canonical bytes (tags 10-15 Active).

### 3.5 R-C5.5 audit + 5 raw-secret migrations (8 done)

`R-C5.5` Architecture-guard allowlist audit (36 entries: 31 SAFE, 5 MIGRATE) · `R-C5.5.1` Mechanical rationale-quality CI guard · 5 migrations: `link_secret_for_url`→`link_url_token` (BEARER-TOKEN-PERMITTED) · `derive_link_keys_from_raw_secret` (CORPUS-DRIVER-ONLY) · `verify_and_open_bundle_with_recipient_seed` (CORPUS-DRIVER-ONLY) · `LinkKeysFfiResult.wrapping_key`→handle · `OpenedBundleFfiResult.epoch_seed`→handle · plus `derive_identity_from_raw_seed` bonus · plus `cross-client-vectors` Cargo feature + Gradle invariant.

### 3.6 P-W7 ADR-006 cutover epic (8 done)

`P-W7` umbrella · `P-W7.1` `verify_and_open_bundle` → handle-based · `P-W7.2` tier/content raw-key exports removed · `P-W7.3` `wrap_key`/`unwrap_key` → handle-based account wrap · `P-W7.4` `seal_and_sign_bundle` raw seeds → handle-based · `P-W7.5` `derive_db_session_key_from_account` removed · `P-W7.6` link-share raw-key exports → handle-based · `P-W7.6.1` link-share test mock cleanup · `P-W7.7` `web-raw-input-ffi.{ps1,sh}` consumer-side guard · `P-W7.8` `:db:` HKDF label §13-frozen annotation.

### 3.7 Wrappers (P-U / P-W) (6 done)

`P-U3` UniFFI upload+sync reducers + manifest transcript · `P-U4` UniFFI ClientErrorCode + lock-test · `P-W1` WASM shard-tier surface.

### 3.8 Cohesion bookkeeping (G0.*) (4 done)

`G0.5` Pre-lock audit doc reconciliation · `G0.6` KDF/auth byte-pinning lock tests + §13/§15 refresh · `G0.7` Restore §11 register + un-consolidate lock tests + `#[deprecated]` · plus 2 ledger sweeps (`d7bc035`, `6356b1a`).

### 3.9 Web (W-*) (3 done)

`W-A7` Documentation (Rust-core boundary, OPFS) · `W-pre-2` OPFS snapshot encryption compat note · `M0` Web/Android metadata stripping parity (JPEG/PNG/WebP via WASM).

### 3.10 Android repair (R-C7) (1 done)

`R-C7` Android bridge regression repair + CI 3-month invisibility window closure.

### 3.11 Quality (Q-final-*) (1 done)

`Q-final-2` iOS-readiness stub adapter + SPEC-IosReadinessAdapter.

---

## 4. Pending — Critical Path & Dispatch Order

### 4.1 Wave 8 (next dispatch — 4 parallel agents on disjoint scope)

| Agent | Scope | Files | Effort |
|---|---|---|---|
| **`fix-r-c4`** | R-C4 streaming AEAD redesign + envelope v0x04 | `crates/mosaic-crypto/`, `crates/mosaic-domain/`, ADR-013 implementation | **L** (heaviest crypto change since R-C6) |
| **`fix-r-c5`** | R-C5 strip parity hardening (99% line+branch coverage; mutation 100% on classifier predicates; fuzz corpus) | `crates/mosaic-media/` strip path tests | M |
| **`fix-p-w2`** | P-W2 WASM media inspect/strip/sidecar (now unblocked post-R-M1.1 + R-M6.1) | `crates/mosaic-wasm/`, `apps/web/src/generated/mosaic-wasm/`, `apps/web/src/workers/types.ts` | M |
| **`fix-p-w4`** | P-W4 WASM upload+sync reducers (mirror P-U3 for WASM) | `crates/mosaic-wasm/` only | M |

### 4.2 Wave 9 (after R-C4/R-C5/P-W2/P-W4)

| Ticket | Description | Blocks | Effort |
|---|---|---|---|
| **`P-U5` / `P-W5`** | UniFFI/WASM streaming AEAD (conditional on R-C4) | — | S |
| **`P-U1`** | UniFFI strip + media inspect (mirror P-W2 for UniFFI; depends on R-M1-7) | A6, A7 | M |
| **`P-U2`** | UniFFI video container inspect | A7 | S |
| **`P-U6` / `P-W6`** | UniFFI/WASM regen + snapshot lock | Many downstream | M |
| **`A-CanonicalDimensions`** | Android+Web tier-dim parity test | Foundation work | S |
| **`A-pre-1`** | Android pre-INTERNET migration shim | A1 | S |
| **`A1`** | Android INTERNET ADR-012 invariant test update | A4, A17 | S |
| **`A2a`** | Android Room queue + staging schema | A3, A5b, A8, A16 | M |
| **`B1`** | Backend idempotency-key support | B3, B4, B5 | M |
| **`B2`** | Backend tieredShards acceptance | B3, B4, B5 | M |
| **`W-pre-1`** | Web TS upload-queue legacy drain + dual-run | W-A6 | M |

### 4.3 Wave 10+ (Web cutover chain; W-S then W-I then W-A)

```text
                     ┌─ P-W1 (✅) ──┬─ W-S1 (handle API surface)
WASM regen chain ────┤              │
                     ├─ P-W6        ├─ W-S2 (download cutover; needs R-C3 ✅)
                     │              ├─ W-S3 (encrypt cutover)
                     └─ P-W4 ──┐    └─ W-S4 (boundary guard sweep + module deletion)
                               │
                               ├─ W-A1 (port implementations; needs R-Cl4 ✅)
                               ├─ W-A2 (RustUploadAdapter; needs R-Cl1 ✅, R-Cl3 ✅)
                               ├─ W-A3 (RustSyncAdapter; needs R-Cl2 ✅, R-Cl3 ✅)
                               └─ P-W2 ──┐
                                          ├─ W-I1 (image inspect wired)
                                          ├─ W-I2 (PNG/WebP/AVIF/HEIC strip migration)
                                          ├─ W-V1 (video inspect wired; needs P-W3)
                                          │
                                          └─ P-W3 (video container inspect; needs R-M6 ✅)
            
                     ┌─ B1 ─┬─ B3 ─┬─ B4 ─┬─ B5 (manifest finalization shape; needs R-ADR-022 ✅)
Backend chain ───────┤      │      │      │
                     └─ B2 ─┘      │      │
                                   │      │
                                   └──────┴─ W-A4 (manifest cutover; needs B5)

W-A5 (rollout; needs W-A2/A3/A4) → W-A6 (Playwright E2E; needs W-A5 + W-pre-1) → Q-final-1 / Q-final-3
W-I3 (JPEG flip; needs Q-final-1 + W-I2)
```

### 4.4 Wave 11+ (Android implementation chain)

```text
A1 (INTERNET) ─┬─ A4 (OkHttp) ─┬─ A5a (Tus spike) ─ A5b (Tus adapter; needs A2a)
               │                ├─ A11 (sync fetcher) ─ A12 (sync confirmation loop)
               │                └─ A10 (manifest commit; needs P-U3 ✅, B5)
               │
               └─ A17 (permission flip; needs A15 + A16)
                  │
                  ├─ A18a … A18f (E2E scenarios) ─ A18g (real-device matrix)
                  │
                  └─ Q-final-3 → Q-final-4 → Q-final-5 (final freeze)

A2a (Room queue) ─┬─ A3 (StagingManager) ─ A14 (Photo Picker)
                  ├─ A8 (encrypt worker; needs A2b, A6, A7, P-U3 ✅)
                  │   │
                  │   └─ A2b (Room snapshot schema; needs P-U6, R-Cl1/2/3 ✅)
                  │
                  └─ A16 (privacy audit; needs A13c, A4)

A6 (media tier gen; needs P-U1, R-ADR-014 ✅, R-ADR-020 ✅)
A7 (VideoFrameExtractor; needs P-U2, R-M6 ✅)

A13a (reducer; needs A2b, P-U3 ✅) ─ A13b (effect persist) ─ A13c (retry sched)
                                                              │
                                                              └─ A15 (FG service)
                                                              └─ A16 (privacy audit)

A9 (upload worker; needs A2b, A5b, A8)
```

### 4.5 Wave Final (Quality gates + freeze re-declaration)

```text
A18g + W-A6 ──┬─ Q-final-1 (cross-platform parity harness)
              ├─ Q-final-3 (E2E coverage matrix)
              └─ Q-final-4 (performance budgets)
                  │
                  └─ Q-final-5 (final freeze re-declaration; reissue SPEC-LateV1ProtocolFreeze with empty open list)
```

---

## 5. Pending Tickets — Reference

### 5.1 Crypto remediation (heavy)

| ID | Title | Depends on | Notes |
|---|---|---|---|
| **R-C4** | Streaming AEAD redesign + envelope v0x04 | R-ADR-013 ✅ | New `version=0x04`, `stream_salt`, authenticated chunk framing. **IRREVERSIBLE.** |
| **R-C5** | Strip parity hardening JPEG/PNG/WebP | none | 99% line+branch; mutation 100% on classifiers; fuzz corpus. |

### 5.2 Wrappers (P-U / P-W)

| ID | Title | Depends on | Effort |
|---|---|---|---|
| **P-U1** | UniFFI: strip + media inspect | R-M1-5 ✅, R-M7 ✅ | M |
| **P-U2** | UniFFI: video container inspect | R-M6 ✅ | S |
| **P-U5** | UniFFI: streaming AEAD (conditional) | R-C4 | S |
| **P-U6** | UniFFI regen + snapshot lock | P-U1-4 | M |
| **P-W2** | WASM: media inspect/strip/sidecar (now unblocked post-R-M1.1) | R-C5, R-M1-5/7 (R-M1/M2 ✅, R-M3-5/7 ✅) | M |
| **P-W3** | WASM: video container inspect | R-M6 ✅ | S |
| **P-W4** | WASM: upload + sync reducers (mirror P-U3) | R-Cl1-3 ✅ | M |
| **P-W5** | WASM: streaming AEAD (conditional on R-C4 ship) | R-C4 | S |
| **P-W6** | WASM regen + snapshot lock | P-W1-4 | M |

### 5.3 Web client (W-*)

| ID | Title | Depends on | Effort |
|---|---|---|---|
| **W-S1** | Crypto worker handle-API surface | P-W1 ✅, P-W6 | M |
| **W-S2** | photo/album/shared download cutover | R-C3 ✅, W-S1 | M |
| **W-S3** | upload encrypt-path cutover | W-S1 | M |
| **W-S4** | boundary-guard sweep + retired TS module deletion | W-S2, W-S3 | S |
| **W-I1** | Image inspection wired to Rust | P-W2, P-W6 | S |
| **W-I2** | Metadata strip migration (PNG/WebP/AVIF/HEIC) | P-W2 | S |
| **W-I3** | JPEG strip parity flip | Q-final-1, W-I2 | S |
| **W-V1** | Video container inspect wired | P-W3 | S |
| **W-A1** | Port implementations (PrepareMedia, EncryptShard, etc.) | P-W4, R-Cl4 ✅ | M |
| **W-A2** | RustUploadAdapter | R-Cl1 ✅, R-Cl3 ✅, W-A1 | M |
| **W-A3** | RustSyncAdapter | R-Cl2 ✅, R-Cl3 ✅, W-A1 | M |
| **W-A4** | Manifest finalization cutover | B5, W-A2 | M |
| **W-A5** | Feature flag + staged rollout | W-A2, W-A3, W-A4 | M |
| **W-A6** | E2E coverage (Playwright) | W-A5, W-pre-1 | M |
| **W-pre-1** | TS upload-queue legacy drain + dual-run | none | M |

### 5.4 Backend (B-*) — language/runtime to be confirmed

| ID | Title | Depends on | Effort |
|---|---|---|---|
| **B1** | Idempotency-key support on POST /api/manifests + Tus | none | M |
| **B2** | tieredShards acceptance for all album types | none | M |
| **B3** | Manifest version semantics + sync response shape | B1, B2 | M |
| **B4** | Integration test corpus | B1, B2, B3 | M |
| **B5** | ADR-022 manifest finalization shape locked | B1-4, R-ADR-022 ✅ | S |

### 5.5 Android (A-*) — 30 tickets in dependency chain

See §4.4 for the dependency graph. Highlights:

| ID | Title | Depends on | Effort |
|---|---|---|---|
| **A-CanonicalDimensions** | Android+Web tier dimensions locked-in test | R-M5 ✅ | S |
| **A-pre-1** | Pre-INTERNET migration shim | none | S |
| **A1** | INTERNET ADR-012 + invariant test update | R-ADR-012 ✅ | S |
| **A2a / A2b** | Room queue + snapshot schema | A2b: P-U6, R-Cl1-3 ✅ | M |
| **A3** | AppPrivateStagingManager | A2a | S |
| **A4** | Shared OkHttp client (TLS 1.2+, cert pinning per ADR-019 ✅) | A1, R-ADR-019 ✅ | M |
| **A5a / A5b** | Tus library spike + client adapter | A4, A2a | M |
| **A6** | Media tier generator | P-U1, R-ADR-014 ✅, R-ADR-020 ✅ | M |
| **A7** | VideoFrameExtractor + thumbhash (30s timeout) | P-U2, R-M6 ✅ | M |
| **A8** | ShardEncryptionWorker | A2b, A3, A6, A7, P-U3 ✅ | M |
| **A9** | ShardUploadWorker | A2b, A5b, A8 | M |
| **A10** | ManifestCommitClient | A4, B5, P-U3 ✅ | S |
| **A11** | AlbumSyncFetcher | A4 | S |
| **A12** | SyncConfirmationLoop | A11 | S |
| **A13a/b/c** | Reducer + persistence + retry scheduling | A2b, P-U3 ✅ | L |
| **A14** | Photo Picker → staging adapter | A3 | S |
| **A15** | Foreground service + notification | A13c | S |
| **A16** | Privacy audit automation (regex over Room + logcat) | A13c, A2a, A4 | M |
| **A17** | Manifest invariants regression + permission flip | A1, A15, A16 | S |
| **A18a-f** | E2E scenarios (happy path, process death/resume, network failure, manifest-unknown, cleanup, deletion) | A17 | M each |
| **A18g** | Real-device matrix (Snapdragon, Tensor, MediaTek; API 26/30/34) | A18a-f | L |

### 5.6 Quality / freeze (Q-final-*)

| ID | Title | Depends on |
|---|---|---|
| **Q-final-1** | Cross-platform parity harness (envelope, manifest, sidecar, thumbhash, tier-dim) | A18g, W-A6 |
| **Q-final-3** | E2E coverage matrix (Playwright + instrumented + UI Automator + 3 device classes) | A18g, W-A6 |
| **Q-final-4** | Performance budgets (encrypt throughput, cold-start, 4 GB heap, web tab memory, Tus resume) | A18g, W-A5 |
| **Q-final-5** | Final freeze re-declaration (reissue SPEC-LateV1ProtocolFreeze with empty open list) | Q-final-1, Q-final-3, Q-final-4 |

### 5.7 Deferred to v2

| ID | Title | Reason |
|---|---|---|
| **r-c6-3-v2** | Migrate empty-AAD wraps to AAD-bound (5 callsites) | Wire-format break; LinkShareRecord + L2 account-key wraps are persistent and unversioned. Defense-in-depth, not active F-1 attack vector. |
| **r-c8-rust-owned-share-link-urls** | Rust-owned `mint_share_link_url` | New SPEC + 3 SDK migration + web hook rewrite. R-C5.5 Migration #1 deferred this in favor of Option B rename. |

### 5.8 Review follow-ups (Wave 5/6/7) — small bundles

| ID | Title | Severity |
|---|---|---|
| **wave5-1-bisect-pair-note** | Annotate R-Cl2/R-C3.1 bisect pair (`253998e` + `1f3f1a9`) in §12.1 | Info |
| **wave5-4-gps-error-code** | `validate_gps_field` returns `LengthTooLarge` for out-of-range lat/lon | Info |
| **wave6-doc-sweep** | Stale AVIF/HEIC "pending" wording in `apps/web/README.md` + `SPEC-IosReadinessAdapter.md` + `apps/ios-stub/README.md` | Info |
| **wave7-1-iloc-cm-tests** | iloc construction_method 1/2/≥3 regression tests | Medium |
| **wave7-2-manifest-error** | `manifest_transcript_bytes_uniffi` error escape hatch | Medium |
| **r-m5-3-ui-flow-through** | Privacy-class UI surface integration when R-M5.3 lands | Info |

---

## 6. Frozen-for-v1 Surfaces (Late-v1 Irreversibility Register)

Recorded at `docs/IMPLEMENTATION_PLAN.md` §11. Summary:

| Surface | Frozen value(s) | Lock test |
|---------|-----------------|-----------|
| AEAD AAD labels | `mosaic:l3-epoch-seed:v1`, `mosaic:l3-identity-seed:v1`, `mosaic:account-wrapped-data:v1`, `mosaic:l2-account-key:v1`, `mosaic:l3-link-tier-key:v1` | `kdf_and_auth_label_lock.rs` per-label tests |
| Shard envelope wire format | Magic `SGzk`; version `0x03`; 64-byte header; reserved zero | `late_v1_protocol_freeze_lock.rs::shard_envelope_*` |
| `ShardTier` discriminants | thumb=1, preview=2, full=3 | `late_v1_protocol_freeze_lock.rs::shard_tier_byte_discriminants_locked` |
| Manifest transcript context | `Mosaic_Manifest_v1` | `manifest_transcript_serializes_to_fixed_binary_vector` |
| Metadata sidecar context | `Mosaic_Metadata_v1` | `metadata_sidecar_serializes_to_fixed_canonical_golden_bytes` |
| KDF labels (7) | `mosaic:root-key:v1`, `mosaic:auth-signing:v1`, `mosaic:tier:thumb/preview/full/content:v1`, `mosaic:db-session-key:v1` | Per-label tests in `kdf_and_auth_label_lock.rs` |
| Auth & bundle contexts | `Mosaic_Auth_Challenge_v1`, `Mosaic_EpochBundle_v1` | `auth_challenge_context_label_is_frozen`, `bundle_sign_context_label_is_frozen` |
| Sidecar total byte cap | `MAX_SIDECAR_TOTAL_BYTES = 65_536` (64 KiB) | `max_sidecar_total_bytes_is_frozen` + `worst_case_active_tag_sidecar_fits_within_cap` |
| Forbidden tag dispatch | Tag 6 → `MetadataSidecarError::ForbiddenTag` (not `ReservedTagNotPromoted`) | `lock_test_for_every_forbidden_tag` |

After Q-final-5, this register is the v1 contract.

---

## 7. Architecture Guards

Located in `tests/architecture/`:

| Guard | Purpose | Classifier protocol |
|---|---|---|
| `no-raw-secret-ffi-export.{ps1,sh}` | Producer-side: no FFI export returns raw secret material | Per `SPEC-FfiSecretClassifiers.md`: SAFE / BEARER-TOKEN-PERMITTED / CORPUS-DRIVER-ONLY / MIGRATION-PENDING |
| `web-raw-input-ffi.{ps1,sh}` | Consumer-side: web TS doesn't accept raw secret bytes from JS | Same classifier set |
| `rust-boundaries.ps1` | Cross-crate boundary discipline | — |

Mechanical enforcement (R-C5.5.1): rationale must be ≥40 chars; banned phrases (case-insensitive): "reviewed existing api", "internal use", "not a secret", "todo", "trust me", "fixme", "tbd". Unknown classifier prefix fails the script.

Negative-test fixture protocol: every regex extension must ship a fixture proving the new pattern catches what the old missed.

---

## 8. Programme Scope NOT in v1

Out of v1 (per ADR-015, ADR-016, design memo):

- Rich album story / content document shapes (ADR-015 deferral)
- Web encrypted local cache (ADR-016 deferral)
- Streaming AEAD if R-C4 doesn't ship before freeze (P-U5/P-W5 conditional)
- iOS implementation (Q-final-2 stub only; full iOS chain ~20 tickets)
- v2 protocol breaks: empty-AAD wrap migrations (r-c6-3-v2), Rust-owned URL assembly (r-c8)

---

## 9. Glossary

- **ADR-006 F-1 attack chain**: compositional violation where account-handle wrap/unwrap exposed L3 epoch/identity seeds across crypto domains. Closed by R-C6 (commit `88c443e`); binary-confirmed via probe test in `crates/mosaic-client/tests/adr006_compositional_attack_blocked.rs`.
- **Late-v1 freeze**: the protocol surfaces locked at v1 ship; changing post-freeze requires a v2 protocol break with snapshot version bump + migration handlers.
- **R-C5.5 audit**: 36-entry architecture-guard allowlist audit (commit `2d17c47`); produced 5 migration tickets all closed by Wave 4-7.
- **`cross-client-vectors` Cargo feature**: gates corpus-only UniFFI exports out of production builds; Gradle invariant in `apps/android-main/build.gradle.kts` fail-fasts on mixed test+production task graphs.
- **Bisect hazard pair**: `253998e` (R-Cl2) + `1f3f1a9` (R-C3.1) are a logical commit pair; `253998e` does not compile in isolation. Future bisects must skip or treat atomically.

---

## 10. References

- `docs/IMPLEMENTATION_PLAN.md` — programme plan, §11 Irreversibility Register, §12.1 Ticket Ledger
- `docs/specs/SPEC-FfiSecretClassifiers.md` — classifier vocabulary (v1 locked)
- `docs/specs/SPEC-AeadDomainSeparation.md` — AAD label registry (R-C6)
- `docs/specs/SPEC-CanonicalSidecarTags.md` — sidecar registry
- `docs/specs/SPEC-RustEncryptedMetadataSidecar.md` — metadata sidecar wire format
- `docs/specs/SPEC-ClientCoreStateMachines.md` — upload + sync reducers
- `docs/specs/SPEC-MetadataStripParity.md` — strip parity contract (web ↔ Rust; Android per `m0-1-android-parity` follow-up)
- `docs/specs/SPEC-LateV1ProtocolFreeze.md` — v1 freeze surfaces
- `docs/specs/SPEC-OpfsSnapshotCompat.md` — OPFS snapshot version compat (R-C6 v3→v4 cutover)
- `docs/specs/SPEC-IosReadinessAdapter.md` — iOS readiness contract (Q-final-2)
- `docs/specs/SPEC-R-C5.5-MigrationDesign.md` — design memo for the 3 design-dependent R-C5.5 migrations
- `docs/adr/ADR-006-ffi-api-secret-handles.md` — handle architecture
- `docs/adr/ADR-013-streaming-shard-aead.md` — streaming AEAD design (R-C4 implements)
- `docs/adr/ADR-017-sidecar-tag-registry-policy.md` — tag registry rules
- `docs/adr/ADR-018-telemetry-kill-switch.md` — telemetry counter ring buffer (R-C3.1 implements)
- `docs/adr/ADR-022-manifest-finalization-shape.md` — manifest shape (B5 implements backend side)
