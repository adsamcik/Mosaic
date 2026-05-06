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
| P4-C  | UI (initiator/responder screens + visitor handoff)      | ⏳ next |
| P4-D  | WebRTC data-channel upgrade post-pairing                | ⏳ later |

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
