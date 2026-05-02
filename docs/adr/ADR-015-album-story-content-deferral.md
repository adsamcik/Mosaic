# ADR-015: Defer album story/content document shape decisions to v1.x

## Status

Accepted

## Context

The Mosaic v1 freeze gate (`docs/specs/SPEC-LateV1ProtocolFreeze.md` §"Explicitly open until Bands 5/6 and Android upload finish") lists the **album story/content document shape** as an unresolved surface:

> Album story/content document shape. `album content` API currently stores one encrypted opaque document with nonce/version. The internal encrypted block schema and any server-visible concurrency fields remain open for Band 5/6 story/content work.

The Rust core completion programme (`plan.md` v2) is scoped to closing the explicitly-open items that block encryption, media handling, and the upload pipeline. Reopening the album-content document schema during this programme would expand scope across Lane W (web rich-text editor, story sections, content blocks), Lane B (backend story/content endpoints), and Lane Q (cross-platform story rendering) without unblocking any of the freeze items the programme already commits to closing.

The current behaviour is operational: `GET/PUT /api/albums/{albumId}/content` round-trips one encrypted opaque blob per album with a 24-byte nonce, deterministic three-way merge (`SPEC-SyncConflictResolution.md`) for conflict resolution, and an opaque `version` counter for optimistic concurrency. End-users can edit album content; the data is end-to-end encrypted; sync resolves conflicts deterministically.

The remaining open work is internal: the encrypted *block* schema (story sections, embedded media references, rich-text variants, future formats) and any additional server-visible concurrency or partial-update fields. Those decisions are coupled to UX work in `SPEC-AlbumContent-StoryBlocks.md`, `SPEC-BlockBasedContentSystem.md`, `SPEC-BlockEditorUX.md`, `SPEC-SectionBasedStoryStructure.md`, and `SPEC-AnimationSystem.md` — all of which are independent of the encryption / media / upload programme.

## Decision

The album story/content document shape is **formally deferred to v1.x.** The Rust core completion programme will not modify:

- the encrypted block schema inside the album content document,
- the `GET/PUT /api/albums/{albumId}/content` request or response shape,
- the optimistic-concurrency `version` field semantics,
- the deterministic three-way merge in `SPEC-SyncConflictResolution.md`.

The programme **may** write through this surface as an opaque blob (web encrypted local cache, Android sync application) and **must** preserve byte-equality for round-tripped content. Tests added in this programme that touch album content must consume it as opaque bytes only.

A future ADR-NNN ("Album story/content document schema for v1.x") will reopen the schema decision after the encryption/media/upload programme reaches G6 and after the dependent Band 5/6 story SPECs are ready to land.

## Options Considered

### Reopen the schema in this programme

- Pros: closes one more freeze-open item in the v1 freeze re-declaration.
- Cons: pulls in 4+ orthogonal SPECs (story blocks, block editor UX, section structure, animation); blocks Q-final-5 on UX work; expands Lane B scope; risks late-stage protocol churn during the programme's most critical phase (R-Cl1/R-Cl2 reducer finalization).
- Conviction: 2/10.

### Defer to v1.x via ADR (this decision)

- Pros: keeps programme scope tight; preserves the operational surface already shipped; allows Q-final-5 to honestly empty the freeze open list (annotated *deferred-via-ADR-015* rather than silently unresolved); unblocks Bands 5/6 to evolve independently.
- Cons: programme cannot claim "all freeze items closed in v1"; v1.x must still address the schema before any non-additive change to the album-content surface.
- Conviction: 9/10.

### Silently leave the freeze open list unresolved

- Pros: zero ADR overhead.
- Cons: violates §0.12 reversibility ethic; G6 would be a paper freeze; future contributors read empty open list as "nothing left."
- Conviction: 1/10.

## Consequences

- `SPEC-LateV1ProtocolFreeze.md` Q-final-5 reissue annotates album story/content shape as **deferred via ADR-015**, with a v1.x reopen pointer.
- The album-content API JSON shape, encrypted blob format, nonce length, and `version` field semantics are **frozen** at the wire level for the duration of this programme; only opaque blob bytes may change.
- `SPEC-AlbumContent-StoryBlocks.md`, `SPEC-BlockBasedContentSystem.md`, `SPEC-BlockEditorUX.md`, `SPEC-SectionBasedStoryStructure.md`, and `SPEC-AnimationSystem.md` remain explicitly out of programme scope.
- Web encrypted local cache (deferred separately in ADR-016) and Android sync application both treat album-content payloads as opaque bytes; integration tests assert byte-equal round-trip.
- Any new `album content` byte-format change after G6 requires a follow-up ADR plus a manifest/protocol-version migration plan.

## Reversibility

High. ADR-015 only freezes the schema for the duration of this programme. After G6, a v1.x ADR may evolve the encrypted block schema, story sections, and concurrency semantics without invalidating any decision in this programme. The deferral does not commit to a specific schema; it commits to *not changing* the schema right now.
