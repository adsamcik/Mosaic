
## TL;DR

Sidecar Beacon is feasible as a Chromium-desktop-to-Chromium-mobile beta feature in v1.1, but only under a *strict* set of constraints: (a) authenticated mode only — no visitor share-link sidecar in v1; (b) a small server-mediated WebSocket signaling relay that never sees keys or plaintext; (c) an application-layer authenticated-encryption tunnel (XChaCha20-Poly1305 keyed by a short-lived pairing-derived shared secret) layered *on top of* WebRTC's mandatory DTLS-SRTP, so a malicious TURN relay or a future DTLS bug cannot read photo bytes; (d) a 6-digit numeric pairing code displayed on the primary and entered on the secondary, mixed into the tunnel key via SPAKE2 or PAKE-style key derivation. The right architecture is **direct WebRTC `RTCDataChannel` carrying plaintext photo bytes** between the primary and secondary, with the existing `SourceStrategy` reused unchanged on the primary and a new `{ kind: 'sidecar', peerHandle }` `DownloadOutputMode` on the primary that pipes finalized per-file bytes into the data channel. The "encrypted-shard relay" variant (option B) is *more* ZK-pure but blocked by the fact that the secondary would need the same epoch keys as the primary, which is exactly what cross-device key sync currently doesn't ship — so we'd be solving a much harder cryptographic problem to avoid a cleartext byte stream that DTLS-SRTP plus app-layer AEAD already protects. Verdict: **conditional-go for v1.1 behind a beta flag, authenticated-only, Chromium-only**, with a hard no-go for v1 and explicit deferral of LAN-HTTP and serverless-QR signaling to v2.

## Investigation environment

- Worktree/branch: `C:\Users\adam-\GitHub\Mosaic-spike-sidecar`, `spike/p4-sidecar`.
- Method: code trace of the live download architecture (PRs #11–14), review of `SYNTHESIS.md` §3.4 (sidecar origin), and public-spec/MDN review for WebRTC, DTLS-SRTP, mDNS-in-browser, and Private Network Access.
- No implementation, no new TypeScript or Rust code, no protocol bytes on the wire. Pseudo-code blocks below are illustrative only.
- Inspiration scanned (not vendored): Snapdrop / PairDrop (browser WebRTC LAN file transfer, server-mediated discovery), KDE Connect (native LAN, mDNS, native crypto — not portable to PWA).
- Threat-model framing assumes the existing ADR-002 zero-knowledge backend boundary and the streaming-shard AEAD per ADR-013.

## Findings — Sections 1 through 8

### 1. Threat model

The existing Mosaic invariant is: *the server never sees plaintext photo bytes or content-decryption keys*. The crypto boundary is between the user's browser session and the user's own keyring. Sidecar Beacon adds a *new* boundary: **plaintext photo bytes leave one user-controlled device and arrive on another user-controlled device**. This is not a relaxation of the server-side ZK invariant (the backend still sees only ciphertext shards plus an opaque WebSocket signaling envelope), but it does introduce four new threats:

**T1 — Wrong peer.** A user types a pairing code and connects to an attacker's device on the same Wi-Fi (e.g. evil twin AP, or a hostile LAN). Without an authenticated key agreement bound to a human-verifiable secret, the user has no way to know the connected peer is their phone. Mitigation: the pairing code MUST drive a PAKE-style key agreement (SPAKE2, CPace, or — if we want pure-WebCrypto — a DH where both sides hash the code into the transcript), so a wrong peer cannot complete the handshake even if they intercept the signaling envelope. The MDN-level reminder here is that DTLS-SRTP fingerprints exchanged over a malicious signaling server *are not authenticated* unless something out-of-band (the pairing code) binds them. See WebRTC Security Architecture, RFC 8827 §4.2 and the "self-signed certificate without out-of-band auth" discussion.

**T2 — Network adversary on shared Wi-Fi.** WebRTC mandates DTLS-SRTP on every `RTCPeerConnection` (RFC 8827, MDN: *"All data transferred using WebRTC is encrypted"* — `developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Protocols`). DTLS keys are negotiated with self-signed certs whose SHA-256 fingerprints are exchanged via signaling. So a passive Wi-Fi sniffer cannot read data-channel bytes. *However*, the signaling server can MITM the fingerprint exchange — substituting its own offer/answer — and the browsers cannot detect this. **App-layer authenticated encryption keyed by the pairing code is therefore not optional.** Recommended floor: every payload chunk is sealed with `XChaCha20-Poly1305(K_session, nonce, plaintext)` where `K_session = HKDF(pake_shared_secret, "mosaic.sidecar.v1.session", info)`. DTLS gives us length confidentiality and keeps the relay honest; AEAD gives us cryptographic agency over our own threat model.

**T3 — Malicious second device.** The user authorizes the secondary device. By definition it is trusted to receive plaintext. What it then does (re-share, screenshot, upload elsewhere) is outside Mosaic's threat model — the same way the primary device is trusted not to keylog itself. *But* there is a softer threat: a phone left unattended at a coffee shop receives a sidecar URL the user thought they sent only to their own phone. Mitigation: the pairing code is single-use and short-lived (e.g. 90 seconds), and the tunnel is bound to the specific transmission session. A pairing does not survive tab close on either side.

**T4 — TURN-relay observer.** If symmetric NAT prevents a direct connection, WebRTC falls back to a TURN relay, which sees DTLS-encrypted bytes only. With app-layer AEAD on top, even a hostile TURN operator cannot read photos. This is critical because we expect to need TURN in ~10–25% of real-world WebRTC sessions on consumer networks.

**Pairing UX recommendation.** Order of preference: (1) 6-digit numeric code typed in (works on every Mosaic-supported browser, no APIs required); (2) QR code containing a longer entropy token (camera permission + getUserMedia required, fine on Chromium Android, harder on desktop without a webcam); (3) NFC/proximity-out-of-band — *rejected for v1.1*, Web NFC is Chromium-Android only, no production track record, and not worth the surface for a beta. The 6-digit code MUST be displayed on the primary (the device the user has line-of-sight to) and entered on the secondary; this matches Bluetooth pairing and Apple Continuity precedent.

**Security floor (recommended).** DTLS-SRTP (free from WebRTC) + XChaCha20-Poly1305 app-layer AEAD over each chunk + PAKE-bound session key from the pairing code + 90-second code TTL + single-use pairing + tunnel destruction on tab close.

### 2. Architecture options

#### Option A — Direct WebRTC `RTCDataChannel`, primary-fetches-decrypts-sends-plaintext

The primary tab runs the existing coordinator unchanged: `SourceStrategy.fetchShards` → `pool.decryptShard` → finalized per-file plaintext bytes. A new `DownloadOutputMode = { kind: 'sidecar', peerHandle }` opens an `RTCDataChannel` and writes each finalized photo as a framed message: `[u32 photo_idx][u16 filename_len][filename_utf8][u64 size][bytes...]`. Backpressure via `bufferedAmount` + `bufferedamountlow`.

- **Network topology:** general-Internet WebRTC. STUN required; TURN required for symmetric-NAT cases. NOT LAN-only — works across cellular if the secondary is off-Wi-Fi (with caveats about phone bandwidth).
- **Signaling:** server-mediated WebSocket relay on the existing Mosaic backend. SDP offer/answer + ICE candidates flow through it. Server never sees keys (PAKE handshake messages are tunneled as opaque blobs).
- **Browser support:** Chrome desktop ✅, Edge desktop ✅, Firefox desktop ✅, Safari 14+ desktop ✅, Chrome Android ✅, Firefox Android ✅, Safari iOS 14.3+ ✅. (Per MDN `RTCDataChannel`: widely available across all major browsers; per caniuse "rtcpeerconnection": 98%+ global.) For Mosaic with iOS out of scope (synthesis §0.1) this is generous.
- **Performance ceiling:** consumer hardware typically achieves 50–500 Mbps over `RTCDataChannel` on LAN, capped by WAN bandwidth otherwise. Per-message cap is ~256 KiB on Chromium without `maxMessageSize` negotiation; we frame photos into chunks. For a 50-photo album of 5 MB originals (250 MB total) on a 100 Mbps LAN, ~25–40 seconds of transfer time — comparable to a USB 2.0 cable.
- **ZK preservation:** server sees ciphertext shards (unchanged) and opaque signaling blobs. Server does not see plaintext, photo bytes, or pairing code. *Between peers*, plaintext flows. This is a deliberate, scoped relaxation.
- **UX complexity:** medium — pairing UI, QR/code entry, beta-flag gating.

#### Option B — Encrypted-shard relay, secondary decrypts

Primary fetches encrypted shards from the server and forwards the **encrypted** bytes over the data channel. Secondary runs a stripped-down decryption pipeline using a key shared out-of-band.

- **Network topology:** identical to Option A.
- **Signaling:** identical to Option A.
- **ZK preservation:** *strictly stronger* — no plaintext on the wire between peers, even at app-layer.
- **Critical blocker:** the secondary needs **the user's epoch keys** (or, for share-link visitors, the tier-3 link decryption key). For authenticated mode, this means cross-device key sync — exactly the problem ADR-021 (legacy raw key fallback sunset) and the epoch-tier key designs (`SPEC-RustEpochTierKeys.md`) carefully avoid solving in v1. Shipping sidecar via Option B implicitly ships cross-device keyring sync, which is a much bigger Pandora's box (account recovery, key rotation, device revocation, multi-device snapshot reconciliation).
- **UX complexity:** very high — pairing must transfer keying material, not just establish a tunnel.
- **Performance ceiling:** identical to Option A but with worse battery on the secondary (it now does AEAD decrypt for every shard).
- **Verdict:** philosophically attractive, practically blocked. Not viable for v1.1. Reconsider only if cross-device key sync ships independently for other reasons.

#### Option C — Local HTTP server in the primary, secondary fetches over LAN

Primary spins up a local HTTPS server (somehow); secondary navigates to `https://primary.local:8443/sidecar/<token>` with an auth token QR-encoded.

- **Network topology:** strictly LAN.
- **Signaling:** mDNS / `.local` discovery + QR-coded auth token.
- **Browser support reality:** **blocked on the web platform.** Browsers cannot bind TCP listening sockets — there is no `ServerSocket` API. The Direct Sockets API is origin-trial-only, Isolated-Web-App-only on Chromium (`chromestatus.com/feature/6206011179286528`), and not exposed to general-purpose PWAs. WebTransport is *outbound-only* from the browser. Even if we could listen, mixed-content rules forbid `https://app.mosaic.example` fetching `http://192.168.1.5:8443/...`; Private Network Access (`wicg.github.io/private-network-access/`) further restricts cross-origin LAN requests with preflight requirements in current Chromium. The only LAN HTTP path that works today requires a *native helper app* on the primary, which is out of scope for a PWA.
- **Verdict:** not implementable as a pure PWA. Note this finding loudly. Could become viable in a Tauri/Electron native shell or with Direct Sockets stable, but neither is on Mosaic's roadmap.

#### Option C′ — WebTransport server-relay (mentioned for completeness)

WebTransport (HTTP/3-based) has a server-relay variant where both peers connect outbound to a server that bridges streams. This collapses to a server-mediated relay, not P2P, and the server sees ciphertext-of-AEAD bytes. Worse latency, more server cost, no benefit over Option A given DTLS+AEAD covers the same threat. Rejected.

#### Comparison matrix

| Aspect | A: WebRTC plaintext + AEAD | B: Encrypted-shard relay | C: LAN HTTP |
|---|---|---|---|
| Implementable in PWA today | Yes | Yes | **No** |
| Server signaling required | Yes (WSS relay) | Yes (WSS relay) | mDNS only |
| NAT traversal | STUN/TURN | STUN/TURN | n/a (LAN) |
| Cross-device key sync required | No | **Yes** (blocker) | No |
| ZK preserved server-side | Yes | Yes | Yes |
| ZK preserved peer-to-peer | App-layer AEAD only | Cryptographic | n/a |
| Browser support | Chromium + FF + Safari | Same | n/a |
| UX complexity | Medium | Very high | Low (if it worked) |

**Recommended option: A.**

### 3. Mosaic-specific integration

The current download architecture (PRs #11–14) is well-positioned to absorb sidecar:

**SourceStrategy reuse, unchanged.** `apps/web/src/workers/coordinator/source-strategy.ts` already factors `'authenticated' | 'share-link'`. The primary continues to use whichever strategy matches its login state. Sidecar is not a new `SourceStrategyKind` — it is not a *source*, it is a new *output sink*.

**New DownloadOutputMode variant.** `apps/web/src/workers/types.ts:1293` currently has `{ kind: 'zip' | 'keepOffline' | 'perFile' }`. Sidecar adds a fourth:

```ts
| { readonly kind: 'sidecar';
    readonly peerHandle: SidecarPeerHandle;
    readonly fallback: 'zip' | 'perFile' | 'none'; }
```

`SidecarPeerHandle` is opaque to the coordinator; it is implemented by a new `apps/web/src/lib/sidecar/` module that owns the `RTCPeerConnection`, the AEAD tunnel, and the framing protocol. The coordinator sees only a `RemoteByteSink`-shaped interface (`apps/web/src/workers/types.ts:1303`), the same abstraction used by ZIP and per-file sinks. This is the seam the existing architecture was designed for.

**Crypto reuse.** The existing streaming shard AEAD (ADR-013) runs unchanged on the primary. The sidecar tunnel adds *one additional AEAD pass* on the primary's outbound side and one open on the secondary's inbound side — not on the photo bytes themselves but on each framed chunk. This is independent of, and orthogonal to, the photo-content AEAD. The scope-key abstraction (`apps/web/src/lib/scope-key.ts`, referenced from source-strategy.ts:53) gets a new prefix `sidecar:<32-hex>` for tray filtering on the secondary.

**Ambient mirror / cache.** The primary's cache amortization (synthesis §3.2) still applies — cache hits save fetch-and-decrypt work *on the primary*. No change.

**Decrypt cache.** Per-shard decrypt cache on the primary is unchanged. The secondary does not decrypt; it has no decrypt cache.

**Snapshot schema.** Sidecar should be **ephemeral per session**. Persistence on the secondary would mean storing an unauthenticated-tier output: the secondary, by design, has no Mosaic account context. We do not want a half-resumable sidecar that survives tab close, because the pairing code is gone and re-pairing is the correct UX. ADR-023 (persisted snapshot schema) is therefore not extended for sidecar in v1.1. The primary's job snapshot, however, *is* persisted (the primary's own download is resumable; if the secondary disconnects, the primary can fall back to its declared `fallback` output).

**Receive-only client on the secondary?** Two options: (i) the secondary opens the same `apps/web` Mosaic PWA at a special route `/sidecar/receive?code=xxxxxx`, gets a stripped-down receive-only UI, and writes via the existing per-file save target factory (`RemotePerFileSaveSink`, types.ts:1310). (ii) a separate minimal HTML bundle. Option (i) is strongly preferred: code reuse, single deployable, no separate build, the secondary's `RemotePerFileSaveSink` already abstracts ZIP/perFile/showSaveFilePicker.

**Visitor flow integration?** **No, in v1.1.** Share-link sidecar would mean a visitor's phone receives plaintext photos that the visitor's desktop fetched. The trust model becomes "two devices, both anonymous" — there is no account, no registered device list, no cross-device pairing trust anchor. In principle the pairing code is still sufficient (it's the same PAKE protocol), but the UX is much worse: visitors have no expectation that "open Mosaic on phone" works without a share link. Adding sidecar to the visitor surface bloats it. Authenticated-only in v1.1; revisit visitor sidecar in v2 if telemetry shows demand.

### 4. Signaling

**Smallest viable shape.** A single WebSocket endpoint on the existing Mosaic backend, e.g. `/api/sidecar/signal/:roomId`. The room ID is derived from the pairing code commitment (HKDF of code, not the code itself, so the server cannot enumerate codes). Two clients in the same room get their messages relayed verbatim. Server holds no state beyond the room → socket map and a TTL (~120 s). It never reads message contents. Total backend complexity: ~150 LOC of Rust/Axum WebSocket plumbing, no new tables, no new persistence.

**Why not serverless QR signaling?** Pure SDP-over-QR is technically possible (Opus paper "QR-tunneled WebRTC"; some open demos exist), but: (1) ICE candidates trickle in over time — a single QR captures the offer, but trickle ICE needs a back-channel; (2) the answer must travel back from secondary to primary, requiring a *second* QR scan in reverse, requiring the primary to have a camera (desktops typically don't); (3) typical SDP+ICE blobs are 2–4 KiB which exceeds QR-code capacity for reliable phone scanning at typical PWA modal sizes. UX cost is two-way scanning + camera-on-desktop assumption + ICE-trickle-via-clipboard. Verdict: not worth the savings in operational simplicity. The signaling relay is small and ZK-clean.

**mDNS / local discovery without native code.** Browsers do not expose mDNS to JavaScript. They *do* use mDNS internally to anonymize host candidates (`.local` ICE candidates per `draft-ietf-mmusic-mdns-ice-candidates`, shipped in Chrome 76+ and Firefox 68+), but JS cannot enumerate peers via mDNS. There is no `navigator.discovery.local()` API and no concrete proposal on the web platform. Verdict: not feasible without native code; would require a Tauri/Electron shell.

**Server-mediated relay with PAKE-bound transcript.** The signaling server sees:

```
ws -> {type: "pake.msg1", room, blob}
ws -> {type: "pake.msg2", room, blob}
ws -> {type: "sdp.offer", room, sealed_blob}    // ← already AEAD'd by PAKE-derived key
ws -> {type: "sdp.answer", room, sealed_blob}
ws -> {type: "ice", room, sealed_blob}
```

After PAKE message 2, every signaling payload is sealed by the PAKE-derived session key, including the SDP offer/answer (so the DTLS fingerprints are integrity-protected against a malicious server). This costs us nothing — sealing happens on the client.

### 5. UX flow

```
┌──────────── Desktop (primary) ────────────┐    ┌──────── Phone (secondary) ────────┐
│                                           │    │                                   │
│ 1. Album page → "Download" → Mode picker  │    │                                   │
│    [ZIP] [Folder] [Keep offline]          │    │                                   │
│    [↗ Send to my phone]  ← new, beta      │    │                                   │
│                                           │    │                                   │
│ 2. Click → modal:                         │    │                                   │
│    "Open Mosaic on the receiving device   │    │ 3. Open phone, navigate to        │
│     and enter this code:                  │    │    mosaic.app/pair                │
│         4 7 2 9 1 3                       │    │    (or scan QR)                   │
│     [QR code]                             │    │                                   │
│     Code expires in 1:24"                 │    │ 4. Enter 472913 →                 │
│                                           │    │    "Pair with desktop?            │
│ 5. PAKE handshake completes →             │←→→ │     'My Macbook' wants to send    │
│    "Connected. Starting transfer..."      │    │     50 photos (250 MB).           │
│                                           │    │     [Accept] [Cancel]"            │
│ 6. Coordinator runs as normal             │    │                                   │
│    SourceStrategy.fetchShards →           │    │ 7. Tray on phone shows progress;  │
│    decryptShard → sidecar sink.           │ ─→ │    each photo finalizes via       │
│    Local tray on desktop also shows       │    │    showSaveFilePicker / OPFS /    │
│    progress.                              │    │    Android Downloads.             │
│                                           │    │                                   │
└───────────────────────────────────────────┘    └───────────────────────────────────┘
```

**Failure modes.**

- **Connection drops mid-transfer.** Both sides surface "Connection lost; the desktop will keep your album" — the primary falls back to its declared `fallback` mode (default: keep-offline, so user can reopen the album later and re-send). The phone shows partial files saved so far with a warning.
- **Phone leaves Wi-Fi.** Same as connection drop. WebRTC ICE restarts may bridge brief flaps; longer outages trigger fallback.
- **User closes desktop tab.** Pairing ends. Phone gets a clean disconnect. Whatever the phone has already received is on disk; the rest is lost (no resume — the primary owned the source strategy and the keys).
- **User closes phone tab.** Primary detects disconnect, falls back to declared output mode. No data leaks because the phone tab's state is gone.
- **Code mistyped.** PAKE fails silently (correctly — we cannot reveal whether the room exists vs. the code is wrong). UI shows "Pairing failed; check the code or generate a new one."
- **Code expired.** Primary regenerates a new code; the WebSocket room is rotated.

### 6. Implementation effort estimate

**M1 — Signaling relay (S, ~1 week).** Backend WebSocket endpoint, room TTL, no persistence, ZK-preserving by construction. Tests: room collision, TTL, oversize message rejection.

**M2 — PAKE handshake + AEAD tunnel (M, ~3 weeks).** Pure-WebCrypto SPAKE2 or CPace implementation (or vetted JS lib if license-clean), HKDF, XChaCha20-Poly1305 sealing. Cross-platform Rust/TS test vectors — reuse `SPEC-CrossPlatformCryptoVectors.md` discipline. Risk: PAKE in pure JS is not widely battle-tested; consider implementing in the existing Rust client-core and exposing via WASM, which aligns with ADR-003 (Rust crypto canonical).

**M3 — Sidecar peer module + DataChannel framing (M, ~3 weeks).** `apps/web/src/lib/sidecar/`: `RTCPeerConnection` lifecycle, framing protocol, backpressure. Receive-side per-file save sink wiring.

**M4 — DownloadOutputMode wiring + UI (S, ~2 weeks).** New `{ kind: 'sidecar' }` variant, mode picker entry behind beta flag, pairing modal with QR + 6-digit code, secondary-side `/pair` route + receive UI.

**M5 — Integration tests + manual cross-device matrix (M, ~3 weeks).** Chromium desktop ↔ Chromium Android, behind-NAT cases, TURN fallback, code expiry, abort paths, resume-after-fallback.

**M6 — Beta release + telemetry (S, ~1 week).** Behind a feature flag. Anonymous telemetry on session success rate, TURN-relay rate, transfer throughput, abort reasons. Strict ZK-safe telemetry per existing patterns.

**Total: ~3 months calendar (M-large), one engineer, including buffer.**

**Risk register (top 5).**

| # | Risk | Mitigation |
|---|---|---|
| 1 | PAKE implementation flaws (pure JS) → silent downgrade to unauthenticated tunnel. | Implement in Rust core, generate cross-platform test vectors, third-party crypto review before beta exit. |
| 2 | Real-world TURN relay rate higher than expected (>40%) → operational cost of running TURN servers. | Use coturn on the existing Mosaic infra; meter; hard-cap per-account TURN bandwidth. Fall back to "use ZIP" guidance if TURN unavailable. |
| 3 | Chromium Android `RTCDataChannel` perf cliff or background-tab eviction. | Manual testing on real devices early in M5; document worst-case throughput. Backgrounding the receive tab WILL be a real issue — plan UX around "keep phone screen on during transfer". |
| 4 | Pairing-code phishing in screenshots / shared screens. | 90 s TTL, single-use, only works for the one in-flight transfer. Document "do not screenshare during pairing." |
| 5 | Beta scope creep: user asks for visitor sidecar, multi-receiver fan-out, resume-across-pairings. | Hard-line scope: authenticated only, single receiver, single-session. v2 problems. |

### 7. Recommendation

**Conditional-go for v1.1, behind a beta flag, authenticated-only, Chromium-only.** Hard no-go for v1. Defer LAN-HTTP and serverless-QR signaling permanently to v2 (or to a future native shell).

**Concrete decision criteria for entering v1.1 implementation.**

- ✅ Phase 3 download architecture has shipped and is stable (we are on top of the new SourceStrategy + DownloadOutputMode seam, which is the right place for sidecar to plug in).
- ✅ Telemetry shows ≥5% of authenticated downloads are large (>500 MB) and a non-trivial fraction of users browse Mosaic on a phone after triggering a desktop download — this is the actual demand signal.
- ❓ We have a Rust-implemented PAKE primitive (or a vetted external dep) ready to reuse — *go check before committing*.
- ❓ A Principal-level crypto reviewer is available for the PAKE+AEAD design before beta — *not optional*.

**Minimum-viable v1.1 scope.**

1. Authenticated mode only.
2. Chromium-desktop primary, Chromium-mobile secondary.
3. 6-digit numeric pairing code only (no QR in v1.1; defer to v1.2 if telemetry shows code-typing friction).
4. Single album per session.
5. No resume across pairings; if the tunnel drops, fall back to the primary's declared output (default: keep-offline).
6. Telemetry on success rate, TURN rate, throughput, abort reason.
7. Behind a `feature.sidecar` flag, default off, internal-dogfood for one release.

**What evidence would change the decision.**

- *Toward go in v1*: a sudden ZK-Direct-Sockets or browser-native LAN discovery API stabilizing — would unlock Option C and remove the need for a TURN budget.
- *Toward no-go entirely*: a vendor breaking change to `RTCDataChannel` semantics (e.g. forced relay), or a major DTLS-SRTP CVE that we cannot mitigate at app-layer alone, or telemetry from Phase 3 showing that mobile users are <2% of download starts.
- *Toward visitor sidecar in v2*: telemetry showing visitors frequently abandon downloads on mobile after starting on desktop (i.e., a measurable cross-device handoff need outside the authenticated population).

### 8. Open questions

- Does the existing Rust client-core already expose a PAKE primitive (or could we adopt one via the same dependency-vetting bar as ADR-005)? If not, the M2 budget grows.
- What is the realistic TURN budget on Mosaic infrastructure? coturn at 1 Mbps × 25% relay rate × N concurrent users — does this fit current operating costs?
- Is there an existing browser-known issue with `bufferedamountlow` event reliability on Chromium Android that would force us to poll `bufferedAmount` instead? (Worth a 1-day prototype before M3.)
- Should the secondary's receive UI integrate with the persistent download tray (synthesis §3.3) — i.e. become a first-class tray entry — or live as a one-off receive-mode page? (Recommend: tray entry on the secondary, scoped under `sidecar:<hex>` scope key.)
- Does the visitor flow ever justify sidecar later? Specifically, do share-link visitors on desktop actually want to hand the download to a phone, or is "open the share link directly on phone" sufficient? Phase-3 telemetry on visitor-mobile session counts will answer this.
- Out-of-band: should the pairing code derive from a longer entropy source (e.g. 8 digits + 1 check digit)? 6 digits is 1-in-1M — adequate against online guessing because the rate is bounded by signaling-server PAKE attempts and a 90 s TTL, but a check digit improves typo UX.
- iOS Safari is "out of scope" per synthesis §0.1, but Safari 14+ does support `RTCDataChannel`. If iOS-Safari support is ever revisited, what's the marginal cost to extend sidecar there? Likely low; flag this as a freebie.
- Does the new `DownloadOutputMode = { kind: 'sidecar' }` need any change to the persisted snapshot schema (ADR-023)? Recommendation: explicitly **no** — sidecar jobs are ephemeral and not persisted; the snapshot writer must skip them.
