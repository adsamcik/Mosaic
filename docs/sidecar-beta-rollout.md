# Sidecar Beacon — beta-flag rollout

> Operational runbook for the **Sidecar Beacon "Send to my phone"** beta.
> Audience: web release engineers + backend on-call.

## TL;DR

* Feature flag: `VITE_FEATURE_SIDECAR=1` at **build time** (web).
* Telemetry kill-switch: `VITE_FEATURE_SIDECAR_TELEMETRY=1` at build time.
* No backend toggle is required — the signaling endpoint and telemetry
  endpoint are always mounted, but the web UI does not surface the entry
  unless the flag is on. The endpoints are individually rate-limited and
  ZK-blind; leaving them mounted in production is safe.
* Rollback: rebuild and redeploy with `VITE_FEATURE_SIDECAR=0` (or unset).
  No DB migration to undo. No persisted state to drain.

## Enabling the flag

### Web (Vite build)

Set both flags before the production build:

```
VITE_FEATURE_SIDECAR=1
VITE_FEATURE_SIDECAR_TELEMETRY=1
```

In a Docker/CI build pipeline, pass them via build-args:

```
docker build --build-arg VITE_FEATURE_SIDECAR=1 \
             --build-arg VITE_FEATURE_SIDECAR_TELEMETRY=1 \
             -t mosaic-web:beta .
```

For a local dev preview:

```
echo "VITE_FEATURE_SIDECAR=1" >> apps/web/.env.local
echo "VITE_FEATURE_SIDECAR_TELEMETRY=1" >> apps/web/.env.local
npm --workspace apps/web run dev
```

### Backend

No flag — the endpoints are unconditionally mapped:

* `WS  /api/sidecar/signal/{roomId}` — signaling relay
* `POST /api/sidecar/telemetry/v1`  — telemetry sink

Both refuse traffic from clients that haven't opened the modal (the
client-side flag gates UI exposure).

## TURN server configuration

The peer-to-peer data channel will fail to establish on roughly 10–20%
of real-world network paths (symmetric NAT, corporate firewalls). A
TURN server is REQUIRED for those paths.

### Client-side env

```
VITE_SIDECAR_TURN_URL=turns:turn.example.com:5349
VITE_SIDECAR_TURN_USERNAME=mosaic-beta
VITE_SIDECAR_TURN_CREDENTIAL=<short-lived-token>
```

The credential SHOULD be a short-lived HMAC token issued per-session by
the backend (RFC 7635 / TURN REST). For the beta we accept a static
credential while the issuance pathway is being built — log a P1 issue
to track migration before GA.

### Server-side hosting

* `coturn` is the reference implementation. Tested config: 4 vCPU,
  4 GB RAM, 100 Mbps egress sustains ~50 concurrent relayed sessions.
* Place the TURN server on a separate hostname / IP from the API so it
  can be scaled independently.
* Open UDP/3478, UDP/49152-65535, TCP/5349. TLS-only TURN (TURNS) on
  TCP/5349 is mandatory — fall-through TURN exposes the relay to MITM.
* TURN logs MUST NOT include user identifiers. A line per allocation
  with byte counters is enough.

## Telemetry interpretation

The collector emits structured logs of the form

```
sidecar.telemetry event=<name> errCode=<code> turnUsed=<bool>
                  photoCount=<bucket> bytes=<bucket>
                  throughput=<bucket> duration=<bucket>
```

Counter rollups the operator should track:

| Counter                                | What "good" looks like      | Investigate when                     |
|----------------------------------------|-----------------------------|---------------------------------------|
| `pair-completed` / `pair-initiated`    | ≥ 0.85                      | < 0.7 sustained over 24 h            |
| `session-completed` / `pair-completed` | ≥ 0.95                      | < 0.85; check the errCode mix         |
| `turnUsed=true` rate                   | ≤ 0.25                      | > 0.5 — TURN is doing too much work; check NAT-traversal regressions |
| `errCode=WrongCode` share              | < 0.05                      | spike ⇒ UX regression in the modal; recheck code-entry affordances |
| `errCode=IceFailed` share              | < 0.05                      | spike ⇒ TURN outage or transit issue  |
| `errCode=SignalingTimeout` share       | < 0.02                      | spike ⇒ relay overload / network event |
| `bytesBucket=xlarge` share             | trend, not a target          | sudden drop — look for regression in the chunker or backpressure path |

The collector buckets continuous values to coarse enums BEFORE they
leave the browser. We do this on purpose: per-session bytes, raw
durations, and identifiers would defeat the threat model. There is
deliberately no way to recover an individual user's transfer profile
from the rollup; if you need finer-grained data, you need either user
consent or a synthetic load test.

## Rollback procedure

Decision criteria for a rollback:

* `pair-completed / pair-initiated` < 0.5 over a 1 h window
* `errCode=IceFailed` > 0.3 of pair attempts over a 1 h window
* Any backend incident attributed to the signaling relay's CPU/memory
* Security disclosure or CVE in the WebRTC stack we depend on

Procedure:

1. Rebuild the web app with `VITE_FEATURE_SIDECAR=0` (or unset) and
   `VITE_FEATURE_SIDECAR_TELEMETRY=0`.
2. Deploy the new bundle. Existing tabs will keep using the old bundle
   until refresh — this is intentional; in-flight sessions complete.
3. The signaling and telemetry endpoints stay mounted. They get no
   traffic from the new bundle, but old tabs may continue to use them
   until refresh. Watch the per-IP rate limiter for any change in
   traffic shape.
4. (Optional) gate the backend endpoints behind `if env=production
   then 503` if the rollback is for a backend-side issue. Code change
   only, no DB migration.

There is **no persisted sidecar state**. No DB rows. No OPFS records.
The only side effect of the feature is a small in-memory map per
running coordinator worker, scoped to the tab's lifetime.

## User-facing communication template

For the release notes when you flip the flag on:

> **Send albums to your phone (beta)**
>
> You can now download an album directly to a second device — phone,
> tablet, or another computer — without uploading it twice. Open an
> album, choose **Download** → **Send to my phone**, scan the QR code
> with the receiving device, and the photos transfer over a private,
> end-to-end encrypted channel. The Mosaic server never sees your
> photos during the transfer.
>
> Beta caveats:
> - Available on Chrome, Firefox, and Edge (desktop + Android). iOS
>   Safari is not yet supported.
> - Pairing requires both devices to be online for the duration of the
>   handshake (~5 s). The transfer itself works over any network.
> - If the receiving device drops off mid-transfer, the sending tab
>   will fall back to a local download so you don't lose progress.
>
> Bug reports → [issue tracker URL].

## Known limitations (beta)

* iOS Safari is **out of scope** — RTCDataChannel reliability is not
  yet validated; the modal simply does not show the entry on iOS.
* Mobile browsers in foreground only — the secondary device must keep
  the receive tab in the foreground for the duration of the transfer.
  Backgrounding the tab on Android is allowed only for short albums
  (< 60 s wall-clock).
* Single concurrent session per primary tab. Opening two pair modals
  in the same tab is not blocked but is not supported either.
* The pre-shared 6-digit code is generated client-side via rejection
  sampling against `crypto.getRandomValues` — no modulo bias, but the
  entropy is intentionally low (~20 bits). PAKE protects against
  online enumeration; rate limiting on the relay protects against
  offline enumeration of `msg1` candidates.
* TURN relay credentials are static during the beta; rotate manually.