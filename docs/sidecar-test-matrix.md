# Sidecar Beacon — manual cross-platform test matrix

> Filled in by QA before flipping the `VITE_FEATURE_SIDECAR` flag from
> beta to GA. Every row must show **PASS** for both directions before
> a tier is considered shippable.

## How to use this doc

1. Build the web app with the beta flag on:
   ```
   VITE_FEATURE_SIDECAR=1 VITE_FEATURE_SIDECAR_TELEMETRY=1 npm --workspace apps/web run build
   ```
2. Deploy (or `npm --workspace apps/web run preview`).
3. Walk through every row in the matrix. For each row:
   - Open the gallery on the **primary** device, pick an album, choose
     "Send to my phone" in the download mode picker.
   - Scan the QR with the **secondary** device's camera (or open the
     `/pair#m=...&c=...` URL directly).
   - Run the listed scenario; record observations in the cells.
4. Any **FAIL** must be filed as a P0 issue blocking GA.

## Browser × network matrix

| Primary (desktop)  | Secondary (mobile)   | Network                   | Pair OK? | TURN used? | Throughput | Issues |
|--------------------|----------------------|---------------------------|----------|------------|------------|--------|
| Chrome 130+        | Chrome Android 130+  | Same Wi-Fi                |          |            |            |        |
| Chrome 130+        | Chrome Android 130+  | LTE (phone) + Wi-Fi (pc)  |          |            |            |        |
| Chrome 130+        | Chrome Android 130+  | Symmetric NAT both sides  |          |            |            |        |
| Firefox 130+       | Chrome Android 130+  | Same Wi-Fi                |          |            |            |        |
| Firefox 130+       | Firefox Android 130+ | Same Wi-Fi                |          |            |            |        |
| Edge 130+          | Edge Android 130+    | Same Wi-Fi                |          |            |            |        |
| Chrome 130+ (Mac)  | Safari iOS 17+       | Same Wi-Fi                |  N/A     |  N/A       |  N/A       | iOS Safari is OUT OF SCOPE for the beta — RTCDataChannel reliability gaps not yet validated. Document in release notes. |
| Chrome 130+ (Mac)  | Chrome iOS 130+      | Same Wi-Fi                |          |            |            | Chrome iOS uses WebKit; track separately from Chromium-on-Android |
| Chrome desktop     | Chrome Android       | Phone in airplane mode → re-enable mid-session | | | | Tests fallback engagement |
| Chrome desktop     | Chrome Android       | Corporate proxy (HTTPS)   |          |            |            |        |

> "TURN used?" — open chrome://webrtc-internals on the desktop side
> after the data channel opens; check whether `iceTransport.type` is
> `relay` (TURN) or `host`/`srflx` (peer-to-peer). Tick the column
> based on the actual transport that was negotiated.

> "Throughput" — record the album bytes / wall-clock seconds observed
> for the medium-album scenario. Bucket the result as one of
> `<1 MB/s` / `1–10 MB/s` / `>=10 MB/s`.

## Per-row scenarios to run

For each row in the matrix above, execute these scenarios in order. Each
scenario is independently passable; record any PASS/FAIL per scenario.

### S1. Small album (5 photos, ~25 MB total)
- [ ] Pair completes in < 10 s.
- [ ] All 5 photos arrive on the secondary; SHA-256 of each matches the
      original on the primary.
- [ ] Both tabs show "Done" in the tray.
- [ ] No "sidecar may be incomplete" warning.

### S2. Medium album (50 photos, ~250 MB total)
- [ ] Pair + transfer complete uninterrupted.
- [ ] Throughput observed ≥ 1 MB/s on Wi-Fi (or ≥ 200 KB/s on LTE).
- [ ] Memory peak on the desktop tab stays under ~150 MB across the
      transfer (the sender is stream-chunked; verify via
      DevTools → Memory).

### S3. Large album (1000 photos, several GB)
- [ ] Pair + transfer complete uninterrupted.
- [ ] Throughput remains within one bucket of S2 (no degradation).
- [ ] Tab close on either side mid-transfer triggers fallback as
      configured (zip / perFile / none) on the originating side; the
      secondary surfaces a clean "session ended" message.

### S4. Tab-close on the primary mid-transfer
- [ ] Originating side honours its declared `fallback`:
      - `zip` → resumes finalisation over OPFS-staged bytes
      - `perFile` → same, per-file finalizer
      - `none` → tray shows "sidecar may be incomplete"
- [ ] Secondary device shows clean disconnect notification.

### S5. Tab-close on the secondary mid-transfer
- [ ] Primary observes peer disconnect within ~5 s (ICE timeout).
- [ ] Fallback engages on the primary as configured.
- [ ] No data corruption: any partial files on secondary are cleaned
      up by the receive sink's `abort()` path.

### S6. Wi-Fi disconnect on the phone for ~30 s
- [ ] If reconnect is fast (< ICE timeout), the data channel resumes
      and the transfer continues. (Today's wiring relies on default
      ICE keepalives; document if it actually does.)
- [ ] If ICE times out, both sides see the disconnect and the
      primary's fallback engages.

### S7. Phone backgrounds the receive tab
- [ ] On Android, a background tab keeps the sidecar peer alive long
      enough to finish a small album. (Service-worker scope check.)
- [ ] If the OS suspends the tab, the secondary surfaces "tab
      suspended; transfer paused".

### S8. Wrong code typed on the secondary
- [ ] Secondary surfaces a "code did not match" error within 30 s.
- [ ] Primary's modal does NOT auto-advance — user can correct the
      code and try again.

### S9. Code expiry (90 s TTL on the room)
- [ ] If the secondary takes > 90 s to scan / type the code, the
      relay closes the room; the secondary shows "session expired,
      please ask for a new code" and the primary's modal must allow
      re-issuing without a full reload.

## Accessibility checks (per row)

- [ ] Modal traps focus; ESC dismisses; Tab order is sensible.
- [ ] Screen-reader announces "pairing code 123 456" once the modal
      opens; QR alt-text reads the code in plain language.
- [ ] Color contrast on the QR background ≥ 4.5:1.
- [ ] Receive page on the phone has a touch-target ≥ 44 px for the
      "I have the code" button.
- [ ] Translations: en + cs both render without overflow.

## Telemetry sanity (after the matrix run)

If `VITE_FEATURE_SIDECAR_TELEMETRY=1` was on for the run:

- [ ] Operator log pipeline shows `sidecar.telemetry` lines for each
      pair attempt with the expected event names.
- [ ] No log line contains a roomId, code, msg1 prefix, sessionId,
      raw byte count, or precise duration.
- [ ] The operator-side aggregation (counts of pair-completed vs
      pair-failed) is internally consistent with the runs in this
      matrix.

## Sign-off

| Role | Name | Date |
|------|------|------|
| QA lead              |  |  |
| Web release engineer |  |  |
| Backend on-call      |  |  |