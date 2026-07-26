# `Idempotency-Key` header

Status: documented current-source behavior, frozen by tests. The historical
`v1.0.x` label was internal workstream lineage, not a release identifier. See
[../RELEASE_STATE.md](../RELEASE_STATE.md).

Mosaic requires `Idempotency-Key` on album and share-link creation and
supports it optionally on manifest finalization. These are the only actions on
which this middleware and header provide replay caching. Supplying the header on
another action returns HTTP 400 so a client cannot accidentally assume protection
that the domain transaction does not have.

## Scope

| Action | Header contract |
|---|---|
| `POST /api/v1/albums` | Required |
| `POST /api/v1/albums/{albumId}/share-links` | Required |
| `POST /api/v1/manifests/{manifestId}/finalize` | Optional; recommended for transport replay |
| Tus `PATCH /api/v1/files/*` | Bypassed; Tus offsets and checksums are the retry contract |
| Every other action | Unsupported; a non-empty key returns HTTP 400 |

A missing or whitespace-only key on either required create action returns HTTP
400 before the controller runs. Finalization remains intrinsically retry-safe by
client-selected manifest ID even when the optional cache key is absent.

## Client contract

| Aspect | Contract |
|---|---|
| Header name | `Idempotency-Key` |
| Format | Non-whitespace HTTP header text. Use a stable, domain-prefixed key derived from the public request identity. |
| Max length | 255 characters. Longer values are rejected with HTTP 400; they are never truncated. |
| Scope | Authenticated user plus exact key. Route is not part of record identity, so use prefixes such as `album:` and `share:`. |
| TTL | 24 hours (configurable via `Idempotency:RecordTtlHours`). After expiry the key can be reused with a different request body. |

Recommended stable forms are `album:<base64url-sha256-of-initial-signing-key>`
and `share:<linkId>`. Generate the public identity once and reuse its key across
transport or process retries; a separate logical resource must use a new identity.

### Replay semantics

When the server has already executed a request with this `(userId, key)` pair
within the TTL window, the second request gets the cached response replayed
**without re-running the controller**:

1. The cached HTTP status code is returned.
2. The allowlisted cached response headers are restored, including `Content-Type`
   and `Location` for the supported JSON create/finalize actions.
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

Request equality is a SHA-256 hash over method, path, query string, content
type, selected protocol headers, and the raw body bytes. JSON is not
canonicalized: byte-level whitespace changes are a different request and return
HTTP 409 when the key is reused.

### Non-cached responses

- `5xx` server errors are **not cached**. Retrying the same key after a
  transient 500 will re-execute the controller — this is the whole point of
  the header.
- Request bodies above 4 MiB are rejected with HTTP 413 before controller
  execution; the middleware never buffers an unbounded request.

### What it is not

- It is **not** an alternative to authentication; replay records are scoped to
  the authenticated user.
- It is **not** a general-purpose distributed mutex. Concurrent requests with the same key
  are serialised behind a per-`(userId, key)` PostgreSQL advisory lock (or an
  in-process lock when running against SQLite in tests). Two simultaneous
  POSTs with the same key will serialise; only the first executes, the
  second replays.
- It is **not** transactional rollback. The cache row is written after the domain
  transaction. Album creation, share-link creation, and finalization therefore
  also persist intrinsic request fingerprints in their domain transaction so a
  missing cache row cannot allocate a duplicate resource.

## Operator notes

- Records are stored in `idempotency_records`; `CreatedAt` drives TTL expiry.
  Expired rows are pruned lazily when the key is used again.
- The `Idempotency:RecordTtlHours` configuration value tunes the window;
  shorter TTLs reduce table growth at the cost of breaking long-deferred
  retries.
- PostgreSQL advisory locks serialize concurrent uses of one `(userId, key)`;
  SQLite test environments use the equivalent in-process lock.

## Future v1.x evolution

The current shape is documented because clients in the wild now depend on
the replayed-response semantics described above. Any breaking change
(e.g. requiring a UUID, changing the replay header name, changing the
status of conflicts) ships as a SPEC update + version bump, never as a
silent middleware tweak.
