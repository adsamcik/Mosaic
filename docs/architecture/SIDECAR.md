# Sidecar Beacon — architecture

> Living document for the Sidecar Beacon pairing flow. Updated as phases land.

## What it is

A device-to-device pairing channel for ZK-encrypted album access. Two clients
agree on a 6-digit pairing code (out-of-band) and use it to derive a shared
session key over a malicious server. The server's role is to *introduce* the
two clients and forward opaque bytes — it never sees the pairing code, the
session key, or the plaintext payload.

```
Device A ──┐                                ┌── Device B
           │  WS /api/sidecar/signal/{room} │
           ├────────► relay (ZK-blind) ◄────┤
           │                                │
           └── PAKE handshake (over relay) ─┘
                       │
                       ▼
              AEAD tunnel (over relay,
              then over WebRTC once paired)
```

## Threat model (server is adversarial)

* Server **MAY**: see source IPs, room ids, frame sizes, frame timing.
* Server **MUST NOT** be able to: enumerate pairing codes, decrypt frames,
  link rooms to user accounts, persist any pairing state.

The room id is `HKDF-SHA-256(ikm = pake_msg_1, info = "mosaic.sidecar.v1.room", L = 16)`
hex-encoded (32 chars). msg1 is high-entropy, so the room id leaks nothing
about the pairing code.

## Phase status

| Phase | Scope | Status |
|-------|-------|--------|
| P4-A  | PAKE handshake + AEAD tunnel (Rust + WASM + TS facade) | ✅ landed |
| P4-B  | WebSocket signaling relay (server) + client wrapper     | ✅ landed |
| P4-C  | WebRTC peer + framing + chunker + receive sink + pairSidecar() | ✅ landed |
| P4-D  | DownloadOutputMode integration + UI + /pair receive page | ✅ landed |
| P4-E  | QR pairing URL, streaming sender, tray badge, ZK telemetry, broadcast suppression, beta-rollout docs | ✅ landed |

## P4-B — signaling relay

### Server (`apps/backend/Mosaic.Backend/SidecarSignaling/`)

* `SidecarSignalingEndpoint` — minimal-API WebSocket handler at
  `WS /api/sidecar/signal/{roomId}`.
* `RoomManager` — `ConcurrentDictionary<string, Room>` + a hosted-service
  sweep that disposes rooms past their deadline.
* `Room` — at most 2 sockets, per-room frame-byte/frame-count budgets.
* `SidecarRateLimiter` — sliding-window per-IP cap on *room creation*.
* `SidecarSignalingOptions` — TTL, frame size, budgets, RL window.

Defaults (configurable under `SidecarSignaling:` in app settings):

| Setting | Default | Purpose |
|---------|---------|---------|
| `RoomTtl` | 120 s | hard wall-clock cutoff regardless of activity |
| `MaxFrameBytes` | 8 KiB | per-frame size cap (PAKE ~256 B, SDP ~3 KiB) |
| `MaxMessagesPerRoom` | 50 | total frames before forced close |
| `MaxBytesPerRoom` | 64 KiB | total bytes before forced close |
| `MaxRoomsPerIp` | 5 | room creations per IP per `RateLimitWindow` |
| `RateLimitWindow` | 1 min | sliding window for `MaxRoomsPerIp` |
| `SweepInterval` | 10 s | deadline-sweep cadence (defensive backstop) |

**Invariants enforced by tests**:

1. Server never inspects payload bytes — random binary frames round-trip
   verbatim across the relay (`ServerNeverInspectsPayload_RandomBytesRoundTrip`).
2. Hard TTL cutoff fires under continuous traffic (`TtlHardCutoff_ClosesActiveRoom`).
3. Third connection to a paired room is rejected with `1008` (`ThirdConnection_IsRejectedAsRoomFull`).
4. Per-room frame/size budgets close the room with cancellation propagated
   to both peers.
5. Per-IP rate limit cannot be bypassed by rapid open-close: every accepted
   creation records a timestamp; only timestamps older than the window age
   out, so reconnects don't reset the bucket.

The relay is **allowlisted** in `CombinedAuthMiddleware.PublicPaths` because
authentication would tie the sidecar to user identity (defeats the threat
model).

### Client (`apps/web/src/lib/sidecar/signaling.ts`)

* `deriveSidecarRoomId(msg1)` — HKDF-SHA-256 via `crypto.subtle`.
* `openSidecarSignalingChannel(roomId, opts)` — connects, validates frames,
  reconnects at most twice on transient drops with exponential backoff
  capped at 5 s.
* Binary-only: text frames trigger an immediate close with code `1003`.
* Frame caps mirror the server (8 KiB) — outbound `send()` rejects oversize
  frames synchronously without ever putting them on the wire.

### Out of scope (for now)

* No metrics export. The `/api/sidecar/health` endpoint reports only the
  current room count for liveness probes.
* No multi-instance coordination — rooms are per-process. A future phase
  may add Redis sticky sessions, but the relay itself is stateless enough
  that single-process is acceptable for the foreseeable feature set.


## P4-D — DownloadOutputMode integration + UI

### Surfaces

* `DownloadOutputMode = { kind: 'sidecar', peerHandle, fallback }` — new variant in `apps/web/src/workers/types.ts`. The `peerHandle` is created in the React tree where `pairSidecar()` resolved and passed (Comlink-proxied) into the coordinator worker.
* `apps/web/src/components/Download/DownloadModePicker.tsx` — adds a beta-gated "Send to my phone" option visible only when:
  - `featureFlags.sidecar === true` (env: `VITE_FEATURE_SIDECAR=1`)
  - `props.allowSidecar === true` (caller gates on `accessTier === FULL`)
  - `props.hideKeepOffline !== true` (visitor flow MUST NOT see this)
  - `'RTCPeerConnection' in window`
* `apps/web/src/components/Download/SidecarPairingModal.tsx` — initiator side: generates a 6-digit code via rejection sampling (no modulo bias), calls `pairSidecarInitiatorBegin()` to obtain `msg1` synchronously, renders the pairing URL `<origin>/pair#m=<base64url-msg1>&c=<6digits>` plus a QR code (via `qrcode-generator`), then awaits `prefix.resume()`, builds a `SidecarPeerHandle` from the resolved `{peer, tunnel}`, hands it to the consumer.
* `apps/web/src/components/Pair/SidecarReceivePage.tsx` — responder side, mounted at `/pair`. Reads the pairing code AND `msg1` from the URL fragment (`#m=<base64url-msg1>&c=<6digits>`) so the server never sees either; the responder needs `msg1` to derive the same room id. **A bare `/pair` URL without the fragment shows a "must scan QR" message** because the 6-digit code alone is insufficient to derive the room id.
* `apps/web/src/App.tsx` — `/pair` route is gated on `featureFlags.sidecar`; falls through to the standard auth UI when off (no leak via deep link).

### Coordinator integration

* The coordinator pushes finalized photo bytes through `peerHandle.send/endPhoto` after each photo's `transitionPhoto({kind:'done'})`. **OPFS staging is NOT replaced** — the primary still stages plaintext so a fallback finalizer can pick up if the peer drops.
* `peerHandle.onDisconnect` swaps `jobOutputModes` to the declared fallback (`'zip'`, `'perFile'`, or `'none'`). For `'none'`, the job is flagged sidecar-incomplete and the finalizer is a no-op.
* The sidecar finalizer cleanly closes the session via `peerHandle.close('success')` after all photos are transferred.

### Snapshot persistence

`outputMode` for ALL kinds is in-memory only on the coordinator (existing Phase 2 behavior). On worker restart, sidecar jobs surface via `listResumableJobs()` like any reconstructed job; the user must re-pair (the original `peerHandle` is unrecoverable). This naturally upholds the "sidecar outputMode MUST NOT be persisted" requirement.

### Wire format

Sender emits framed-then-AEAD-sealed messages (one PAKE-derived tunnel key seals each frame independently):
1. `fileStart{photoIdx, filename, size}` → `tunnel.send.seal()` → `peer.sendFrame()`
2. `fileChunk{photoIdx, payload}` (one per send call; chunker can be added later)
3. `fileEnd{photoIdx}` on `endPhoto`
4. `sessionEnd` on cooperative `close('success')`

Receiver reverses: `peer.onFrame` → `tunnel.recv.open()` → `decodeFrame()` → `sink.process()`.

### TURN configuration

ICE servers default to a single Google STUN. Operators can plug TURN via env:
* `VITE_SIDECAR_TURN_URL`
* `VITE_SIDECAR_TURN_USERNAME`
* `VITE_SIDECAR_TURN_CREDENTIAL`


### Two-phase initiator API (P4-E)

pairSidecar() blocks until the full handshake completes — the responder must
have already joined and PAKE / WebRTC must be done before the caller learns
`msg1`. That is too late for a pairing modal that needs to render a QR
*before* the responder joins.

pairSidecarInitiatorBegin(opts) splits the initiator handshake:

`	s
const prefix = await pairSidecarInitiatorBegin({ code, iceServers });
// prefix.msg1 is now available; render /pair#m=<b64url>&c=<code> + QR.
const result = await prefix.resume(); // resolves once the responder joins.
prefix.abort();                       // cancel before resume() if the user cancels.
`

pairSidecar({ role: 'initiator' }) is preserved as a thin wrapper
(egin → resume) for backwards compatibility. The responder API is unchanged.
### Known limitations / follow-ups

* ✅ **Resolved (P4-E):** QR rendering. `pairSidecarInitiatorBegin()` exposes `msg1` synchronously so the modal can render a real `/pair#m=...&c=...` URL + QR before the responder joins. Library: `qrcode-generator` (pure-JS, no canvas dependency, ~10 KB).
* ✅ **Resolved (P4-E):** Per-photo memory peak. `SidecarPeerHandle.sendStream` (optional method) is now preferred by the coordinator; the chunker pulls from the OPFS stream lazily, so memory peak is bounded by one upstream chunk worth of bytes (typically ≤ 64 KiB) regardless of photo size. The legacy buffered `send()` path is retained for handles that predate `sendStream` (and is verified by the existing coordinator test).
* ✅ **Resolved (P4-E):** Tray badge. `DownloadJobRow` renders a `Sidecar` badge when `job.outputModeKind === 'sidecar'` and a `Receiving` badge when `scopeKey` starts with `sidecar:`. `JobSummary.outputModeKind` is in-memory only (matches the existing in-memory `outputMode` policy).
* ⏳ **Open follow-up:** Broadcast suppression for sidecar jobs is documented as a TODO in `coordinator.worker.ts` rather than implemented. The broadcast logic is heavy and current behavior is not incorrect (other tabs simply see a regular job; they cannot revive the in-memory `peerHandle`, so attempts to interact with the sidecar surface degrade gracefully).

### ZK-safe logging

All new files (`SidecarPairingModal`, `SidecarReceivePage`, coordinator sidecar helpers) follow the existing logger conventions: never log the pairing code, full room id, file bytes, file sizes, or peer SDP/ICE candidate details. The `sessionId` exposed to the coordinator is a derived 6-char tag, not the room id.

## P4-E - telemetry, suppression, beta-rollout polish

### ZK-safe telemetry (`apps/web/src/lib/sidecar/telemetry.ts` + `SidecarTelemetryEndpoint.cs`)

Coarse counters only. The collector ONLY admits the public schema:

- `event` enum (7 values)
- `errCode` enum (6 values)
- `turnUsed` boolean
- `photoCountBucket` / `bytesBucket` / `throughputBucket` / `durationBucket` enums

Continuous numeric values (raw bytes, raw durations) are bucketed
client-side via `bucketBytes` / `bucketDuration` / `bucketThroughput`
/ `bucketPhotoCount` BEFORE they leave the module. The `sanitizeEvent()`
gate strips every property not in the schema, so smuggle vectors
(roomId, code, msg1, sessionId, raw byte counts) cannot leave the tab.

Two-flag gating: collector is a no-op unless BOTH `featureFlags.sidecar`
AND `featureFlags.sidecarTelemetry` are on. Telemetry is OFF by default
even when the feature itself is enabled, so devs can disable telemetry
independently.

Backend endpoint (`POST /api/sidecar/telemetry/v1`) re-validates the
schema strictly, rejects malformed JSON / oversized batches / unknown
bucket values, and emits one structured-log line per event with a
fixed message template. NO IPs, NO user ids, NO request timestamps
beyond the implicit log-line time.

### Cross-tab broadcast suppression

Sidecar jobs are per-tab (the `SidecarPeerHandle` is unreachable from
siblings). The coordinator's `broadcast()` early-returns when the
job's in-memory outputMode kind is `'sidecar'`, reducing noise on
tray subscribers. Once a sidecar job engages its fallback (zip /
perFile), broadcasting resumes naturally because the kind is no
longer `'sidecar'`.

This is a polish, not a leak: sibling tabs already filter cross-scope
messages via `scopeKey`, so a stray broadcast would be dropped on
the receive side anyway.

### Cross-device integration tests

`apps/web/src/lib/sidecar/__tests__/sidecar-cross-device.test.ts`
exercises the full sender + receiver pipeline in-process (mocked
WebRTC + signaling) for:

- 50 synthetic photos x 256 KiB - byte-equal verification per file
- PAKE confirm-mismatch -> `PairingError(WrongCode)`
- AbortSignal during handshake -> `PairingError(Aborted)` on both sides
- Three sequential sessions on the same code without state leaks

Larger sizes (5 MB / 1000 photos) and real-network scenarios are
covered by the manual `docs/sidecar-test-matrix.md` checklist run
by QA before flipping the flag from beta to GA.

### Known TS gaps (pre-existing, not P4-introduced)

After the P4-E TypeScript cleanup commit, `tsc --noEmit` from
`apps/web` reports 21 errors. ALL of them pre-date the sidecar work;
they are kept here as the running tally so the next agent can verify
they have not regressed.

Distribution at HEAD of `feat/sidecar-beacon`:

| File / area                                                   | Count | Nature |
|---------------------------------------------------------------|-------|--------|
| `libs/crypto/src/*.ts` (libsodium-wrappers types missing)   |  13   | Build dependency missing types in the workspace tsconfig path |
| `src/workers/__tests__/coordinator-schedule.test.ts`        |   3   | CborValue narrowing + an unused `readPhase` |
| `src/components/Download/__tests__/DownloadResumePrompt.test.tsx` | 1 | UseDownloadManagerResult missing two new fields |
| `src/components/Download/DownloadJobRow.tsx`                |   1   | i18next `TFunction` shape mismatch |
| `src/components/Gallery/__tests__/Gallery.test.tsx`         |   1   | DownloadOutputMode `schedule` not assignable |
| `src/lib/download-schedule.ts`                              |   1   | Unused `isWifiLike` helper |
| `src/workers/coordinator/__tests__/source-strategy.test.ts` |   1   | `ApiError` value used as a type |

P4 itself introduced 35 errors that have been fixed in commit
`fix(web): clean up P4-introduced TypeScript strict-mode gaps`. No
new errors are added by P4-E.

