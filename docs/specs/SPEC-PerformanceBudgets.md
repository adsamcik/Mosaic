# SPEC: Performance Budgets

## Status

**Q-final-4 status: hard budgets declared for v1.** This spec records the v1 performance budget targets for encryption throughput, cold start, memory, and Tus resume. The local invocation script is `scripts/run-perf-budgets.ps1`.

## Budget table

| Area | Budget | Measurement scope | Gate status |
| --- | --- | --- | --- |
| Per-shard XChaCha20-Poly1305 encrypt | >= 200 MB/s | `mosaic-crypto` single-shot shard encryption on x86_64 reference hardware | Declared; bench harness not present on this branch. |
| Streaming encrypt (R-C4 v0x04) | >= 150 MB/s | End-to-end streaming encrypt including per-frame nonce/key derivation | Declared; bench harness not present on this branch. |
| Web cold start | < 2 s | Page load to existing gallery interactive | Declared for Playwright/perf-lab evidence. |
| Android cold start | < 3 s | App icon tap to gallery interactive | Declared for instrumented/device-lab evidence. |
| Android heap | <= 4 GB | Upload/sync flows on mid-tier target devices | Declared; aligns with Android device targeting. |
| Web tab memory | < 500 MB | Active upload of 5 photos | Declared for browser memory sampling. |
| Sidecar tag table resident memory | < 100 KB | Active sidecar tag table | Enforced by R-M5.2.2 cap (`MAX_SIDECAR_TOTAL_BYTES = 65_536`). |
| Tus initiate handshake | < 500 ms p95 | Create/initiate upload handshake | Declared for API/perf-lab evidence. |
| Tus resume after disconnect | < 2 s | Detect disconnect, re-issue HEAD, and resume PATCH | Declared for API/E2E perf-lab evidence. |

## Encryption throughput budgets

### Single-shot shard encryption

- Package: `mosaic-crypto`.
- Target: >= 200 MB/s on x86_64 reference hardware.
- Intended harness path: `crates/mosaic-crypto/benches/throughput.rs`.
- Measurement includes envelope assembly and XChaCha20-Poly1305 encryption for representative shard sizes.

### Streaming R-C4 v0x04 encryption

- Package: `mosaic-crypto`.
- Target: >= 150 MB/s on x86_64 reference hardware.
- Measurement includes 64 KiB frame processing, deterministic per-frame nonce derivation, per-frame AAD construction, and final envelope production.

### Bench harness status

No `crates/*/benches/` or `crates/mosaic-crypto/benches/throughput.rs` harness exists on freeze commit `be7c6da07fbe036beea114c785072c878bd4646d`. Q-final-4 therefore ships the hard budget declaration and a local script with dry-run support. Auto-CI failure on throughput regression is deferred until the bench harness lands in a dedicated performance-bench ticket.

## Cold-start budgets

| Platform | Budget | Start point | End point | Evidence |
| --- | --- | --- | --- | --- |
| Web | < 2 s | Browser navigation/page load | Existing gallery is interactive | Browser perf trace or Playwright metric capture. |
| Android | < 3 s | App icon tap | Gallery is interactive | Android instrumented startup metric/device-lab trace. |

Cold-start evidence must avoid logging plaintext filenames, metadata, keys, or decrypted content.

## Memory budgets

| Platform/component | Budget | Required proof |
| --- | --- | --- |
| Android heap | <= 4 GB | Upload/sync scenarios stay inside the mid-tier target heap. |
| Web tab upload memory | < 500 MB | Active upload of 5 photos remains below the cap. |
| Sidecar tag table | < 100 KB resident | R-M5.2.2 sidecar cap keeps complete canonical sidecar buffers at 64 KiB and the active tag table below budget. |

## Tus resume budgets

| Operation | Budget | Required proof |
| --- | --- | --- |
| Initiate handshake | < 500 ms p95 | Measure upload initiation from client request to accepted upload resource. |
| Resume after disconnect | < 2 s | Measure disconnect detection, HEAD revalidation, and resumed PATCH issue. |

Tus metrics must treat shard bytes as opaque encrypted blobs and must not inspect media plaintext.

## CI integration status

The target CI gate is a perf-budget job in `.github/workflows/tests.yml` that:

1. installs the pinned Rust toolchain;
2. runs `cargo bench -p mosaic-crypto --bench throughput -- --noplot` or an equivalent non-interactive command;
3. compares measured throughput against the budgets above;
4. fails if regression exceeds 10% from the checked-in/reference baseline or if absolute throughput falls below the hard floor.

This repository currently lacks the benchmark harness and baseline artifacts required for an honest automated gate. `.github/workflows/tests.yml` is therefore unchanged for Q-final-4. Enabling CI without a real harness would create a false quality signal.

## Local invocation

Use dry-run mode to verify wiring without requiring a bench harness:

```powershell
pwsh scripts/run-perf-budgets.ps1 --dry-run
```

When `crates/mosaic-crypto/benches/throughput.rs` exists, the same script will run `cargo bench -p mosaic-crypto --bench throughput -- --noplot` in non-dry-run mode and can become the single CI entry point.

## Release blocker rule

After v1 freeze, changes that reduce encryption throughput below the hard floors, exceed cold-start/memory/Tus budgets, or remove budget evidence are release blockers until the regression is measured, explained, and fixed or explicitly accepted by a v2 performance ADR.
