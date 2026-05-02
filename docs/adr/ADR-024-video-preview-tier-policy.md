# ADR-024: Video preview-tier policy (D9)

## Status

Accepted. Closes plan v2 decision D9. Governs A7 (Android video frame extractor), W-V1 (web video container inspect), and the manifest transcript encoding for video assets.

## Context

Mosaic's three-tier model (`SPEC-MediaTierLayoutPlanning.md`) defines tier 1 = thumbnail (≤ 256 px), tier 2 = preview (≤ 1024 px), tier 3 = original (as-is). For *images*, all three tiers carry distinct re-encoded variants of the same source.

For *videos*, the current web implementation (`apps/web/src/lib/upload/video-upload-handler.ts`) deliberately ships **only tier 1 (thumbnail) + tier 3 (original)** — no preview tier. The reasoning, per `files/reports/05-video-processing-web.md`, is that:

- generating a preview-quality video tier requires transcoding (CPU-intensive, browser-incompatible),
- preview-as-a-second-still-frame would duplicate tier 1 with no UX benefit,
- the gallery rendering layer uses tier 1 for grid display and falls back to streaming the original (tier 3) for full playback.

The Rust core completion programme adds A7 (Android video) and W-V1 (web video metadata via Rust). The manifest transcript (`canonical_manifest_transcript_bytes`, R-Cl1 + ADR-022) currently expects all three tiers to be present in `tieredShards`. Without an explicit policy:

- A7 might emit a tier 2 entry that duplicates tier 1, wasting bytes and a manifest field.
- A7 might omit tier 2 entirely without a documented manifest-transcript convention, causing transcript byte-equality tests to fail across video vs image manifests.
- The manifest reader (web galleries, share links) doesn't know whether tier 2 absence is "no preview generated" or "client bug."

The 3-reviewer pass (`files/reviews/R1-gpt55-workstreams.md`) flagged this as a missing decision (added as D9) with high impact on manifest transcript stability.

## Context-specific facts

- Web `Canvas.toBlob()` with `<video>` element extracts a single still frame; transcoding video would require WebCodecs `VideoEncoder` (Safari support immature) or a WASM codec (binary bloat per ADR-014 Outcome B).
- Android `MediaMetadataRetriever.getFrameAtTime(0)` extracts a Bitmap; `MediaCodec` could transcode but battery/thermal cost is significant for what is essentially a "play this video" use case where the original streams adequately.
- Backend stores opaque shards; whatever the client emits, the server simply persists.
- Gallery row display sizes are 200–220 px; tier 1 (thumbnail at 256 px) is sufficient.
- Full playback already requires range requests against the original tier 3 (per Tus / shard download).

## Decision

**Videos ship with tier 1 (thumbnail) and tier 3 (original); tier 2 (preview) is omitted.** The manifest transcript explicitly encodes "preview omitted" in a way that is deterministic and verifiable; readers handle the absence gracefully.

### Manifest transcript convention

The `tieredShards` array (per ADR-022) for a video asset contains:
- exactly one `(tier=1, shardIndex=0, ...)` entry — the JPEG/AVIF poster frame,
- zero `tier=2` entries,
- one or more `(tier=3, shardIndex=N, ...)` entries — the original video bytes (chunked across multiple **separate AEAD envelopes** in v1; *not* streaming AEAD per ADR-013).

**Two kinds of chunking (clarified).** Tier 3 of a video may have multiple `shardIndex` entries; each entry corresponds to **one independent v3 envelope** (`SGzk`/v0x03), and the original video file is partitioned into ≤ `single_shot_size_cap` segments. This is **traditional multi-shard chunking**, not the streaming AEAD of ADR-013. In v1, originals are bounded by `single_shot_size_cap` (per ADR-014's Q-final-4 budget; default ≈ 256 MiB on Android, 512 MiB on web) × maximum `shardIndex` count (default 16 → up to 4 GiB total). Originals exceeding this cap are rejected at upload time with `VideoTooLargeForV1`. v1.x activation of streaming AEAD per ADR-013 lifts the cap by setting `envelopeVersion = 4` on tier 3 entries; manifest readers in v1 reject `envelopeVersion = 4` per ADR-022 §"Rules" #13.

The canonical transcript (`canonical_manifest_transcript_bytes`, R-Cl1) sorts entries by `(tier, shardIndex)` and is byte-equal across web and Android for the same logical input. An asset with no `tier=2` entry is **valid**; readers MUST NOT reject manifests based on tier-2 absence. Validation is per-asset-type:

- `asset_type = Image` → all three tiers required.
- `asset_type = Video` → tier 1 and tier 3 required, tier 2 forbidden.
- `asset_type = LiveImage` (future) → policy TBD; not allocated by this ADR.

`asset_type` is encoded in:
- the `assetType` field of the manifest body (per ADR-022; client-asserted, server-stored as opaque),
- the encrypted `PhotoMeta` (the `encryptedMeta` field of the manifest), and
- the encrypted sidecar (`canonical_video_metadata_sidecar_bytes`'s `codec_fourcc` tag 10 acts as the video discriminator).

The server does not see asset type; **asset-type validation is client-side only**. A malicious manifest claiming `assetType = Image` while supplying tier 2 = poster-as-image and tier 3 = video bytes creates an upload-side decryption mismatch but no server-side anomaly; the receiving client (web gallery, share-link viewer) rejects with `VideoTierShapeRejected` when sidecar discriminator and `assetType` disagree. Q-final-1's negative-fixture test exercises this case explicitly.

If a *future* ADR adds a video preview tier (e.g. "low-bitrate transcoded preview for slow networks"), it would be allocated as a **new tier number** in `tieredShards.tier` (the *manifest* tier byte, a separate namespace from ADR-017's sidecar tag-number registry). Reusing `tier=2` is forbidden because it would change the meaning of existing video manifests in the wild.

### Renderer fallback

Web and Android galleries render videos as follows:
1. Show tier 1 (poster frame) immediately.
2. On user tap → start streaming tier 3 (range requests with chunked decryption per ADR-013 if shipped, single-shard decrypt otherwise).
3. If tier 1 is missing (corrupt, decrypt failure), show generic video placeholder; do not fall back to "decrypt entire original to extract frame" (defeats the purpose of having tier 1).

If a *future* ADR adds a video preview tier (e.g. "low-bitrate transcoded preview for slow networks"), it would be allocated as a `tier=4` (or a new tier number per `SPEC-CanonicalSidecarTags.md`'s tier byte allocation), **not** by reusing tier 2 — because reusing tier 2 would change the meaning of existing video manifests.

### Sidecar contents (R-M7)

The video sidecar (tags 10/11/12/13) carries: codec_fourcc, duration_ms, frame_rate_x100, video_orientation. These are sufficient for the renderer to display correct aspect ratio, duration badge, and orientation without decoding frames.

### Tier 1 frame selection

The poster frame is selected per platform. Frame timestamp policy: **5% of `duration_ms`, clamped to `[100ms, 5000ms]`** — a 1-second video uses 100ms; a 10-minute video uses 5s; a 1-hour video uses 5s. The clamp avoids silly edge cases where 5% would be sub-frame (very short videos) or far past any plausible "interesting" frame (very long videos).
- **Web:** `<video>` `currentTime = clamp(duration * 0.05, 0.1, 5.0)` → Canvas → JPEG/AVIF encode at the same quality as image tier 1.
- **Android:** `MediaMetadataRetriever.getFrameAtTime(clamped_us, OPTION_CLOSEST_SYNC)` → Bitmap → JPEG/AVIF encode.

If extraction fails (DRM video, corrupt header, codec unsupported), the upload flow falls back to a generic placeholder poster (a fixed bundled image) and emits `VideoPosterExtractionFailed` event (renamed from `LegacyUploadWithoutThumb`; the latter alias is reserved in R-Cl1's event enum but marked deprecated). The user still gets the video original uploaded; only the poster is degraded.

**DRM-video upload behavior.** If `MediaMetadataRetriever` reports DRM-protected content (Android `getFrameAtTime` returning null with system DRM error), the upload pipeline emits `VideoSourceUnreadable` and **rejects the upload** rather than uploading an undecryptable original. DRM-protected video is fundamentally incompatible with the zero-knowledge model: the user does not possess the playback keys, so the encrypted-on-our-side ciphertext would be unplayable on read. The user is shown "This video is DRM-protected and cannot be uploaded; export an unprotected copy first."

Cross-platform parity (Q-final-1) requires:
- Identical sidecar bytes for identical video input (codec_fourcc, duration_ms, frame_rate_x100, video_orientation match).
- Identical thumbhash for identical *poster JPEG bytes* (whichever platform produced them).
- *Not* byte-equal poster JPEG bytes (codec encoder divergence per ADR-014 Outcome B).

## Options Considered

### Tier 2 = duplicate of tier 1 (always present)

- Pros: manifest transcript shape is identical for image vs video.
- Cons: doubles the tier-1 bytes for every video for zero UX benefit; storage cost; bandwidth cost; encoder cycles; readers gain nothing.
- Conviction: 2/10.

### Tier 2 = mid-resolution transcoded preview

- Pros: faster slow-network playback start.
- Cons: requires transcoding (web: WebCodecs immature, WASM codec contradicts ADR-014; Android: `MediaCodec` transcode is battery-/thermal-expensive); modest UX benefit relative to existing range-request streaming; protocol surface expansion.
- Conviction: 4/10.

### Tier 2 = first-second sample of original (chunked tier 3 prefix)

- Pros: lets renderer start playback faster.
- Cons: requires the original to be *encoded* in a streamable way; fragile to codec choice; doesn't generalize across containers.
- Conviction: 3/10.

### Tier 2 omitted; manifest convention explicit (this decision)

- Pros: simplest correct shape; matches current web behavior; no encoder cycles wasted; renderer fallback is well-defined; future preview tier can be added with a new tier number without reuse risk.
- Cons: image and video manifests have different `tieredShards` arity; readers must branch on asset type.
- Conviction: 9/10.

## Consequences

- ADR-022 (manifest finalization) §"`tier` ∈ {1, 2, 3}" rule is refined: tier 2 is *required* for Image assets and *forbidden* for Video assets. Validation is client-side (per `asset_type` in `encryptedMeta`).
- A7 emits exactly one tier 1 entry and one or more tier 3 entries per video; never a tier 2.
- W-V1 + the existing `video-upload-handler.ts` already match this policy; W-A4 (manifest cutover) verifies via test that no production code path emits tier 2 for video.
- `canonical_manifest_transcript_bytes` (R-Cl1) does not change behavior; it sorts by `(tier, shardIndex)` regardless of which tiers are present.
- R-M7 (video sidecar) sidecar tags 10/11/12/13 carry the per-video metadata; renderers use these for duration badge / orientation.
- Q-final-1 cross-platform parity matrix asserts:
  - sidecar bytes byte-equal across web ↔ Android for identical video input,
  - manifest transcript bytes byte-equal for video assets,
  - thumbhash byte-equal for identical poster JPEG bytes,
  - manifests with tier 2 entries for video assets fail validation (negative test).
- A new error code `VideoTierShapeRejected` is allocated under R-C1 (returned when a manifest reader sees a tier 2 entry on a video asset).
- `LegacyUploadWithoutThumb` event (poster-extraction fallback) is allocated under R-Cl1's event enum.
- A future ADR may add a video preview tier (e.g. "tier 4 = network-friendly preview"); this ADR's policy guarantees tier 2 is permanently reserved for image previews and cannot be repurposed.

## Reversibility

Medium. The omission of tier 2 for video can be reversed in v1.x by adding a *new* tier number (not by repurposing tier 2). Repurposing tier 2 is forbidden because in-the-wild video manifests would silently break. The tier-1 frame selection algorithm (5% offset, fallback to bundled poster) is reversible. The decision to ship tier 1 + 3 only is high-conviction for v1 and not expected to reverse.
