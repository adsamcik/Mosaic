# `Idempotency-Key` header

Status: documented, behavior frozen for v1.0.x.

Mosaic's backend honours an optional `Idempotency-Key` request header on
state-mutating HTTP methods to make safe client retries possible without
duplicating side-effects (e.g. creating two albums, finalising the same
manifest twice). This document describes the wire contract so clients and
operators can rely on it.

## Scope

The middleware (`apps/backend/Mosaic.Backend/Middleware/IdempotencyMiddleware.cs`,
registered in `Program.cs`) applies to:

- **Methods**: `POST`, `PUT`, `DELETE`.
- **Exclusion**: requests to `PATCH /api/v1/files/*` (the Tus upload `PATCH`
  endpoint) are intentionally **not** covered — Tus has its own resumability
  contract via `Upload-Offset` / `Upload-Checksum`, and layering idempotency
  on top would double-buffer multi-gigabyte bodies.
- **Trigger**: the request carries a non-empty `Idempotency-Key` header.
  Requests without the header pass through untouched (no implicit replay
  protection — opt-in only).

## Client contract

| Aspect | Contract |
|---|---|
| Header name | `Idempotency-Key` |
| Format | Free-form ASCII string. Recommend UUIDv4 or any 16+ byte CSPRNG token. |
| Max length | 255 characters; values longer than 255 are truncated server-side. |
| Scope | Scoped to the authenticated user. The same key from two different users does **not** collide. |
| TTL | 24 hours (configurable via `Idempotency:RecordTtlHours`). After expiry the key can be reused with a different request body. |

### Replay semantics

When the server has already executed a request with this `(userId, key)` pair
within the TTL window, the second request gets the cached response replayed
**without re-running the controller**:

1. The cached HTTP status code is returned.
2. The cached `Content-Type`, `Location`, `Tus-Resumable`, `Upload-Offset`,
   and `Upload-Length` headers are restored (other response headers are
   dropped to avoid leaking stale timing metadata).
3. The cached response body is streamed back byte-for-byte.
4. An additional `Idempotency-Replayed: true` response header is emitted so
   clients can distinguish "first execution" from "cache hit" if they care
   (e.g. for telemetry).

### Conflicting reuse — HTTP 409

Reusing the same `(userId, key)` with a **different request payload** is
treated as a client bug and returns:

```http
HTTP/1.1 409 Conflict
Content-Type: application/json

{
  "error": "Idempotency-Key conflict",
  "detail": "The same Idempotency-Key was used with a different request payload."
}
```

Request equality is determined by a SHA-256 hash over the request body and
selected headers; cosmetic differences (whitespace in JSON, different header
order) still hash identically only if the canonical request bytes match.

### Non-cached responses

- `5xx` server errors are **not cached**. Retrying the same key after a
  transient 500 will re-execute the controller — this is the whole point of
  the header.
- Bodies above the buffering ceiling are not cached (current TTL store sits
  in PostgreSQL; large blob responses bypass).

### What it is not

- It is **not** an alternative to authentication; the header is scoped per
  authenticated user and ignored on anonymous routes.
- It is **not** a distributed mutex. Concurrent requests with the same key
  are serialised behind a per-`(userId, key)` PostgreSQL advisory lock (or an
  in-process lock when running against SQLite in tests). Two simultaneous
  POSTs with the same key will serialise; only the first executes, the
  second replays.
- It is **not** transactional rollback. If the controller succeeds and the
  reply is later observed missing client-side, the **next** request with the
  same key replays the recorded response — your write already happened.

## Operator notes

- Records are stored in the `idempotency_records` table; `CreatedAt` drives
  TTL expiry. A future maintenance pass may garbage-collect expired rows;
  in v1.0.x rows are pruned lazily on access.
- The `Idempotency:RecordTtlHours` configuration value tunes the window;
  shorter TTLs reduce table growth at the cost of breaking long-deferred
  retries.
- No upper bound on records is enforced in v1.0.x — for the ≤50-user
  deployment target the table stays small (single-digit MB).

## Future v1.x evolution

The current shape is documented because clients in the wild now depend on
the replayed-response semantics described above. Any breaking change
(e.g. requiring a UUID, changing the replay header name, changing the
status of conflicts) ships as a SPEC update + version bump, never as a
silent middleware tweak.
