# ADR-016: Defer web encrypted local cache (OPFS) strategy to v1.x

## Status

Accepted

## Context

The Mosaic v1 freeze gate (`docs/specs/SPEC-LateV1ProtocolFreeze.md` §"Explicitly open until Bands 5/6 and Android upload finish") lists the **web encrypted local cache strategy** as an unresolved surface:

> Web encrypted local cache strategy. `db.worker.ts` still owns OPFS snapshot encryption via TypeScript compatibility code; this is not resolved by Android upload and remains open until a separate storage decision.

Slice 8 of the web Rust crypto cutover (`SPEC-WebRustCryptoCutover.md`, commit `aaa6d65`) migrated the OPFS DB worker's encryption call sites from raw libsodium to the Rust handle facade (`encryptAlbumContent` / `decryptAlbumContent`). The encryption *boundary* is now Rust-handle-based. What remains open is the higher-level **strategy** for the encrypted local cache itself: SQLite-WASM + OPFS today, but several alternatives are on the table for v1.x — SQLCipher-style integrated cipher, append-only log + periodic snapshot, IndexedDB + per-row envelope encryption, or migration to a dedicated cache abstraction independent of OPFS.

The Rust core completion programme is scoped to closing the freeze-open items that block encryption, media handling, and the upload pipeline. The OPFS strategy decision is independent of all five programme surfaces:

- it does not gate Slice 5 shard AEAD migration (W-S1..S4),
- it does not gate Lane R-Media,
- it does not gate Lane R-Client state machines,
- it does not gate Lane W upload/sync adapters (W-A1..A6) — those persist `UploadJobSnapshot` / `AlbumSyncSnapshot` to IDB, not OPFS, per W-A2/W-A3 design,
- it does not gate Lane A.

Reopening it inside this programme would couple Slice 5 / Slice 8 boundary work to a storage-architecture decision that needs its own performance/durability/quota benchmarks across browsers (Chromium, Firefox, Safari) and operating systems.

## Decision

The web encrypted local cache strategy is **formally deferred to v1.x.** The Rust core completion programme will not modify:

- the choice of SQLite-WASM + OPFS as the local cache technology,
- the file layout of the OPFS-backed database,
- the snapshot/page encryption granularity in `db.worker.ts`,
- the relationship between OPFS snapshots and the FTS5 search index,
- any planned migration to alternative cache architectures.

The programme **may** consume the existing OPFS DB worker through its current API (encrypt/decrypt entire snapshots) and **must** preserve the Rust-handle-based encryption boundary established by Slice 8. New work that needs durable local storage (e.g. `UploadJobSnapshot`, `AlbumSyncSnapshot` — W-A2/W-A3) must use IndexedDB as the persistence layer, not OPFS, to keep the OPFS strategy decision narrowly scoped to album content + photo metadata + FTS5 cache.

A new boundary guard (W-pre-2 in the plan) flags any new OPFS-strategy code introduced during this programme; violations fail CI.

A future ADR-NNN ("Web encrypted local cache strategy for v1.x") will reopen the decision after the encryption/media/upload programme reaches G6.

## Options Considered

### Reopen the OPFS strategy in this programme

- Pros: closes one more freeze-open item in the v1 freeze re-declaration; allows storage-architecture refactor in the same release.
- Cons: pulls in cross-browser performance benchmarks, FTS5-on-encrypted-pages design, OPFS quota and persistence behavior research, and SQLite WAL/journal interaction analysis; blocks Q-final-5 on storage work that has zero overlap with the programme's five surfaces; risks late churn in `db.worker.ts`.
- Conviction: 2/10.

### Defer to v1.x via ADR (this decision)

- Pros: keeps programme scope tight; preserves the Slice 8 cutover already shipped; lets Q-final-5 honestly annotate the freeze item *deferred-via-ADR-016*; allows independent benchmarking pre-v1.x.
- Cons: web encrypted local cache cannot evolve during this programme; some architectural debt persists into v1.x.
- Conviction: 9/10.

### Defer but allow opportunistic small fixes

- Pros: avoids hard freeze on db.worker.ts.
- Cons: erodes the deferral; "small fix" definition drifts; boundary guard becomes unenforceable.
- Conviction: 3/10.

## Consequences

- `SPEC-LateV1ProtocolFreeze.md` Q-final-5 reissue annotates the OPFS strategy as **deferred via ADR-016**, with a v1.x reopen pointer.
- `apps/web/src/workers/db.worker.ts` is treated as a stable surface for the programme: encrypt/decrypt boundaries calls into the Rust handle facade are preserved exactly as Slice 8 left them; no schema, page-size, encryption-granularity, or FTS5-coupling changes.
- W-pre-2 introduces a boundary guard that fails CI on new code patterns suggesting an OPFS-strategy change (regex over `db.worker.ts` plus a directory-scoped boundary test).
- New durable client state introduced during the programme (`UploadJobSnapshot`, `AlbumSyncSnapshot`, IDB upload-queue) lives in IndexedDB, not OPFS, with its own schema-version + migration discipline (R-Cl3, R-ADR-023).
- Any change to `db.worker.ts` after G6 requires a follow-up ADR plus a migration plan covering browser quota, OPFS persistence guarantees, and FTS5 reindexing.

## Reversibility

High. ADR-016 only freezes the OPFS strategy for the duration of this programme. The Slice 8 cutover already established the Rust-handle encryption boundary; future v1.x work can change the storage technology *underneath* that boundary without invalidating any cryptographic decision. The deferral does not commit to OPFS as a long-term choice; it commits to *not changing* the storage architecture during this programme.
