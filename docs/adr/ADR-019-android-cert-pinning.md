# ADR-019: Cert pinning posture for Android (D6)

## Status

Accepted. Decision: **public-key pin to a managed root + backup pin for self-hosted deployments; document the operator-controlled rotation procedure; do not pin in development builds.** Gates A4 (shared OkHttp client) and A5b (Tus client adapter).

## Context

Mosaic is self-hosted: each operator runs their own backend. Pinning posture is therefore not a single-server question (as it would be for a SaaS app) but a **policy** that the Android app exposes for operators to configure. The 3-reviewer pass (`files/reviews/R1-gpt55-workstreams.md`, `R3-opus47-coherence.md`) flagged that "optional pinning hook" is not a decided posture and asked for explicit production behavior.

Mosaic's threat model already assumes:
- the server is not trusted with plaintext (zero-knowledge),
- the network can be observed and tampered with (TLS protects the encrypted shards in transit, not the plaintext, since plaintext never leaves the client),
- the user trusts their chosen operator to a degree determined by the operator's deployment.

So the question for cert pinning is narrower than for a SaaS: **what protection does pinning add over TLS-only when the server is already untrusted with plaintext, and what is the cost of misconfiguration in a self-hosted scenario where pin rotation is fully on the operator?**

Pinning protects against:
1. CA compromise issuing a fraudulent cert for the operator's domain.
2. Network attacker downgrading the user to a CA-trusted MitM proxy.
3. Local TLS-interception tooling (corporate proxies, custom-CA installations) reading metadata about *which* shards are uploaded when (timing patterns, byte counts), even though shard contents stay encrypted.

It does **not** protect against:
1. The operator's own server being compromised (pinning trusts the operator's pin choice).
2. Replay/correlation by the operator (zero-knowledge already addresses this for content; pinning is irrelevant).

The cost of pinning in a self-hosted deployment:
1. Pin rotation requires app updates (or remote configuration) when the operator's cert expires. Self-hosted operators must understand this lifecycle.
2. Misconfigured pinning (e.g. pinning a leaf cert that rotates yearly) bricks the app.
3. Development / E2E tests must bypass pinning to use ephemeral test certs.

## Decision

Mosaic Android implements **public-key pinning to the operator-controlled cert chain, with a mandatory backup pin and an explicit operator-rotation procedure.** Pinning is **enabled in release builds** and **disabled in debug + internal-test builds**.

### Pinned values

The pin set carries **at least two pins** for the operator's domain:

1. **Primary pin** — the SPKI SHA-256 of the *intermediate or root CA* the operator currently uses. Pinning the intermediate (not the leaf) survives leaf rotation without an app update.
2. **Backup pin** — the SPKI SHA-256 of an *unrelated* CA the operator has pre-provisioned but not yet activated. If the primary CA is compromised or expires, the operator can flip to the backup with no app update.

Optionally, a third pin may be configured for a CA in escrow (cold-storage key not active in DNS).

The operator-shipped Mosaic Android build embeds these pins at compile time via a Gradle product flavor `operatorConfig`:

```kotlin
operatorConfig {
    primaryPin = "sha256/..."   // base64 of SPKI SHA-256
    backupPin = "sha256/..."
    escrowPin = "sha256/..."    // optional
    pinnedHostnames = listOf("mosaic.example.com")
}
```

The Mosaic-main reference build ships placeholder pins that fail-closed (pin set `["sha256/<unconfigured>"]`); installing the reference build without operator configuration produces a controlled startup error, not a silent pin bypass.

### Pinning implementation

OkHttp `CertificatePinner.Builder` builds the pinner from `operatorConfig` at app start. Failures yield a stable `ClientErrorCode = PinValidationFailed` and surface to the user as "Cannot reach Mosaic server (TLS pin mismatch). Contact your operator."

Pin failures **never** retry blindly; the upload state machine (R-Cl1) treats `PinValidationFailed` as a `NonRetryableFailure` and routes the user to a help screen.

### Build variants and pin behavior

| Variant | Pinning | Behavior |
|---|---|---|
| `release` | **Enabled** | Pins enforced; fail-closed. |
| `internalTest` | **Disabled** | Allows ephemeral test certs against staging backends. CI-only; not distributed to users. |
| `debug` | **Disabled** | Local development against `https://localhost`-style or self-signed certs. |
| `e2e` | **Disabled** | E2E test rig uses bundled test CA; pins disabled to avoid coupling test setup to per-operator pin sets. |

A `BuildConfig.PIN_ENFORCEMENT_ENABLED` boolean is derived from variant; static guard `android-pin-required-in-release` asserts:
1. `BuildConfig.PIN_ENFORCEMENT_ENABLED == true` for `release`.
2. `BuildConfig.PIN_ENFORCEMENT_ENABLED == false` for `debug`/`internalTest`/`e2e`.
3. `release` builds without configured pins (`primaryPin` is the placeholder) refuse to package.

### Operator rotation procedure (documented in `docs/DEPLOYMENT.md`)

1. **Plan rotation 90 days ahead of CA expiry.** Operators publish a new `operatorConfig.backupPin` in a build update at least 30 days before activating the new CA.
2. **Activate the new CA in DNS** when the build with the new backup pin has reached ≥95% of installed users (measured by operator-internal telemetry — *not* by Mosaic, per ADR-018).
3. **Promote backup → primary** in the *next* build update; introduce a fresh backup pin.
4. **Emergency rotation** (CA compromise): publish an emergency build with the escrow pin promoted to primary; fall back to the operator's emergency CA in DNS within hours, not days.

If an operator fails to rotate before the user's currently-installed build expires, users see `PinValidationFailed`. This is the intended fail-closed behavior.

### Test matrix (A4 + A5b acceptance)

A4 / A5b ship with tests for:
- pin-valid (happy path),
- pin-mismatch on primary, pin-match on backup (backup activates, app proceeds),
- pin-mismatch on primary, pin-mismatch on backup, pin-match on escrow (escrow activates, app surfaces a soft warning),
- pin-mismatch on all (`PinValidationFailed`, app refuses to proceed),
- pin-set rotation in-flight (build N has pins {A, B}, build N+1 has pins {B, C}, server flips A → B; rolling-upgrade users using either build keep working),
- expired-cert-but-pin-valid (pin enforces SPKI; cert chain validity is checked separately by OkHttp; expired cert fails before pin check anyway).

## Options Considered

### No pinning (TLS-only, system trust store)

- Pros: zero rotation burden; works out-of-the-box on every operator deployment.
- Cons: vulnerable to CA compromise; corporate MitM proxies trivially read upload metadata (timing, byte counts); does not match Mosaic's "private-by-default" posture.
- Conviction: 4/10.

### Pin the leaf cert

- Pros: tightest binding to current cert.
- Cons: leaf rotation (Let's Encrypt 60-90 day) requires app update on every rotation; brittle for self-hosted operators.
- Conviction: 1/10.

### Pin the operator's CA + backup (this decision)

- Pros: survives leaf rotation; survives one CA rotation without app update; documented operator procedure; fail-closed posture aligns with privacy expectations.
- Cons: operators must understand pinning lifecycle; first-time deployments need to commit to a CA.
- Conviction: 9/10.

### Network Security Config XML pinning

- Pros: native Android mechanism; less custom code.
- Cons: less control over rotation messaging and error mapping; harder to disable per build variant cleanly; test infrastructure works less well; backup pin support exists but UX on failure is OS-controlled.
- Conviction: 6/10.

### Pin via remote configuration (server-pushed pin set)

- Pros: rotation without app update.
- Cons: introduces a server-trusted channel that can compromise pinning itself ("trust on first use" with rolling updates); contradicts the threat model where the server is not trusted with privilege escalation; rejected.
- Conviction: 1/10.

## Consequences

- A4 (shared OkHttp client) wraps `CertificatePinner` configured from `operatorConfig`.
- A5b (Tus client) inherits A4's client; no separate pin config.
- Build flavors `release` / `internalTest` / `debug` / `e2e` each get explicit pin behavior; `BuildConfig.PIN_ENFORCEMENT_ENABLED` is asserted by the static guard.
- `ClientErrorCode = PinValidationFailed` is allocated under R-C1.
- `docs/DEPLOYMENT.md` adds an "Operator certificate rotation" section.
- Mosaic-main reference build refuses to package release artifacts without configured pins.
- ADR-018 telemetry guidance is honored: pin failures generate opaque error codes only, no server-side metadata about *which* pin failed.
- Q-final-3 E2E coverage adds two pin-rotation scenarios for the Android matrix.

## Reversibility

Medium. The decision to pin can be reversed in a future build by setting `PIN_ENFORCEMENT_ENABLED = false` for release; users would then fall back to system trust store. This is a degradation, not a protocol change. The operator procedure documentation can be updated freely. The specific pin algorithm (SPKI SHA-256) is OkHttp-native and would be expensive but not impossible to replace. The decision to *enable* pinning at all is high-conviction and not expected to reverse.
