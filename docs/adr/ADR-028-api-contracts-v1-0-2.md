# ADR-028: Recent backend API contract decisions (v1.0.2)

## Status

Accepted. Captures five backend / front-end API-contract decisions that landed
during v1.0.1 → v1.0.2 hardening without their own dedicated ADRs. Logged here
so the audit trail is complete and so future maintainers can find the
rationale next to the API surface.

## Context

After the v1 protocol freeze (`docs/SPEC-LateV1ProtocolFreeze.md`) and the
v1.0.1 path-prefix shift to `/api/v1/*` (see `CHANGELOG.md`), v1.0.2 introduced
several non-protocol but contract-shaped decisions on the client/server
boundary. None individually warrants its own ADR; collectively they need a
single, citable rationale doc so reviewers and downstream clients understand
why the shapes are what they are.

The five decisions are:

1. `PagedResult<T>` envelope shape for list endpoints.
2. RFC 7807 `application/problem+json` (`ProblemDetails`) for error responses.
3. Auth cookie `Path=/` scope.
4. Safari 17.4+ as the new minimum supported Safari version.
5. Client-side `crossOriginIsolated` runtime guard.

## Decision

### 1. `PagedResult<T>` envelope for list endpoints

All list-style endpoints (`/api/v1/albums`, `/api/v1/albums/{id}/manifests`,
`/api/v1/admin/users`, etc.) return a uniform envelope:

```json
{
  "items": [ /* T[] */ ],
  "total": 1234,
  "page": 0,
  "pageSize": 50
}
```

**Rationale:**
- A single shape lets the frontend type one generic
  (`apps/web/src/lib/api.ts::PagedResult<T>`) and reuse pagination UI across
  unrelated screens.
- `total` is computed server-side (single SQL `COUNT(*)`) rather than relying
  on the client to assemble it from observed pages — zero-knowledge invariant
  is unaffected because counts of *encrypted* rows are operational metadata
  already exposed to the server.
- `page` is zero-based to match `Skip = page * pageSize` semantics in the EF
  Core query layer and avoid off-by-one bugs.
- `items` (not `data`, not `results`) was chosen for grep-ability against the
  existing OpenAPI surface.

**Bound by:** `apps/backend/Mosaic.Backend/Models/PagedResult.cs`,
`apps/web/src/lib/api.ts`, `docs/openapi.json`.

### 2. RFC 7807 ProblemDetails for error responses

All non-success backend responses use the standard
`application/problem+json` shape with at minimum `type`, `title`, `status`,
and (where useful) `detail` and `traceId`. No bespoke `{ error: "..." }`
shapes survive in v1.0.2.

**Rationale:**
- RFC 7807 is the IETF standard; reusing it removes a per-endpoint contract
  question.
- ASP.NET Core minimal APIs ship a first-class `ProblemDetails` integration
  (`TypedResults.Problem(...)`) so the backend cost is zero.
- The frontend has one error-parse path
  (`apps/web/src/lib/api.ts::parseProblemDetails`) rather than per-endpoint
  ad-hoc parsing.
- The `traceId` field carries the W3C trace-context id when telemetry is
  enabled, allowing operator-side correlation without ever exposing user
  content.

**Bound by:** `apps/backend/Mosaic.Backend/Program.cs` (problem-details middleware),
`apps/web/src/lib/api.ts`.

### 3. Auth cookie `Path=/` scope

The session cookie set by the reverse-proxy auth integration (Authelia +
backend session) uses `Path=/` rather than a sub-scope such as `Path=/api/`.

**Rationale:**
- The frontend SPA at `/` and the API at `/api/v1/*` share the same origin in
  production and dev. A narrower `Path=/api/` would not be sent on
  `fetch('/api/...')` calls initiated by JS loaded from `/`, breaking auth.
- `Path=/` does not weaken security: same-origin policy already prevents
  cross-origin script access; `Secure; HttpOnly; SameSite=Lax` continue to
  protect the cookie body. `SameSite=Lax` (not `Strict`) is required so that
  the reverse-proxy redirect dance back from Authelia carries the cookie.
- Documented here because `Path` is one of the cookie attributes most
  commonly "tightened" by well-meaning hardening reviews — this ADR is the
  citation that explains why such a tightening would break auth.

**Bound by:** `apps/backend/Mosaic.Backend/Program.cs` (cookie configuration),
`docs/AUTHELIA.md`.

### 4. Safari 17.4+ minimum

The web app's minimum supported Safari is **17.4** (March 2024), up from the
earlier 16.4 floor recorded in `.github/copilot-instructions.md` §"Browser
Support".

**Rationale:**
- Safari 17.4 ships the WebCrypto `Ed25519`, `X25519` primitives, the iOS
  16.4 OPFS bug-fixes consolidated, and the `Iterator.from` helper used by
  the virtualised gallery. v1.0.2 startup relies on each of these without a
  polyfill.
- The user-population of Mosaic deployments (≤50 users) makes a 12-month
  trailing Safari floor proportionate; an enterprise-scale floor would
  typically demand 24 months.
- Older Safari is gracefully rejected at boot with a single-screen
  unsupported-browser notice rather than a partial-functionality fallback —
  same UX as the existing crossOriginIsolated guard (see #5).

**Bound by:** `apps/web/src/lib/browser-support.ts`,
`.github/copilot-instructions.md` §"Browser Support" (kept in sync), and
the boot-time `unsupportedBrowser` route.

### 5. `crossOriginIsolated` runtime guard

Before initialising libsodium-WASM, SQLite-WASM, or any worker, the app
checks `globalThis.crossOriginIsolated === true`. If the check fails the
boot path renders a dedicated "headers misconfigured" screen and refuses to
load further.

**Rationale:**
- SQLite-WASM with OPFS and the crypto worker rely on `SharedArrayBuffer`,
  which is only enabled in cross-origin-isolated documents (COOP =
  `same-origin`, COEP = `require-corp`). A misconfigured reverse proxy that
  strips one of these headers would otherwise produce mysterious
  "database initialisation failed" errors deep inside the WASM stack.
- Failing **at boot** with a clear message is the only way to make the
  failure mode operator-debuggable. Letting init proceed and crash later
  was attempted in v0.x and produced unactionable bug reports.
- The guard is a defence-in-depth check, not a security boundary; the
  underlying COOP/COEP headers are what actually enforce isolation.

**Bound by:** `apps/web/src/main.tsx` (boot guard),
`apps/web/vite.config.ts` (dev-server COOP/COEP),
`docs/DEPLOYMENT.md` §"Required headers".

## Consequences

- Frontend list-screen code is identically shaped across albums, manifests,
  and admin users; refactoring one screen no longer drifts the contract for
  the others.
- Operator dashboards that scrape backend logs can correlate user-visible
  errors against `traceId` without parsing free-text.
- A narrower auth-cookie path attempt during a future "tightening" review
  will be caught by this ADR before it ships.
- Safari ≤17.3 users see a clear unsupported notice rather than a broken
  app; ≤50-user deployment scale makes this proportionate.
- Operator misconfigurations that strip COOP/COEP headers fail loudly at
  boot rather than silently inside WASM init.

## Reversibility

- (1) `PagedResult<T>` shape: changing field names (`items` → `data`) is a
  wire-visible break; adding new optional fields is compatible.
- (2) ProblemDetails: standardised IETF shape — changing away from it would
  break every frontend error path.
- (3) Cookie `Path`: narrowing the path would immediately break authenticated
  fetches and is wire-visible.
- (4) Safari floor: raising the floor is wire-visible (rejects more
  browsers); lowering it requires re-validating each browser-API dependency.
- (5) `crossOriginIsolated` guard: purely a frontend boot-time decision; the
  underlying COOP/COEP requirement is structural and not reversible without
  removing SQLite-WASM-OPFS and the crypto worker.

## References

- `apps/backend/Mosaic.Backend/Models/PagedResult.cs`
- `apps/backend/Mosaic.Backend/Program.cs`
- `apps/web/src/lib/api.ts`
- `apps/web/src/lib/browser-support.ts`
- `apps/web/src/main.tsx`
- `apps/web/vite.config.ts`
- `docs/AUTHELIA.md`
- `docs/DEPLOYMENT.md`
- `docs/openapi.json`
- `CHANGELOG.md` (`/api/v1/*` prefix shift in v1.0.1)
