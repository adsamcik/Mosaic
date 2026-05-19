# Audit — Anonymous-Type Projections vs Frontend Zod Schemas

- **Date:** 2026-05-19
- **HEAD:** `373c5999` (branch `main`)
- **Trigger:** sync-500 regression (`dce5f502`) — `AlbumsController.Sync` shipped an
  anonymous projection that silently dropped `createdAt` / `updatedAt`. The frontend
  `ManifestRecordSchema` (Zod) required them. `ApiClient` masked the real failure as a
  synthetic `ApiError(500, "Invalid response shape")`, cascading into album-content,
  photo-upload-persistence, format-conversion, album-management and album-rename flows
  that all run a post-mutation sync. This audit sweeps the rest of the controller
  surface for the same class of contract drift.

## Summary

- **N = 14** anonymous projections returned as HTTP response bodies were inventoried.
  - (Additional internal LINQ projections — `Join`, `GroupBy`, intermediate `Select(... => new { ... })`
    that are remapped to a typed record before `Ok(...)` — are listed in §"Out of scope"
    but were excluded from the match table because they never reach the wire.)
- **MATCH (M = 13)** — anonymous payload is a superset of the Zod schema's required
  fields (extra fields harmlessly stripped by Zod's default strip mode).
- **MISMATCH (K = 1)** — `GET /api/v1/manifests/{id}` returns a payload whose `id`
  field is renamed to `manifestId`, and whose `shards` array elements are missing four
  fields that `ManifestShardProjectionSchema` requires. Filed as
  `audit-projections-fix-getmanifest` (pending).

No fixes were applied in this commit because the one mismatch requires a multi-field
shape change rather than a single-field addition (audit rule: "Only commit a fix if
it's a one-line obvious field addition").

## Findings table

Routes are listed under their controller. "Schema" cites the Zod schema in
`apps/web/src/lib/api-schemas.ts`. "Zod required ⊆ payload" means every required (or
non-`nullish`-defaulted) field on the Zod schema is present in the backend payload
with a name that matches after standard camelCase serialization.

| # | Endpoint | Backend file:line | Zod schema | Required ⊆ payload? | Notes / extras |
|---|----------|-------------------|------------|---------------------|----------------|
| 1 | `GET /albums` | `AlbumsController.cs:74` | `AlbumListSchema` (`AlbumSchema` items) | ✅ MATCH | `role` is extra (stripped); `updatedAt` is `nullish` so omission is legal. |
| 2 | `GET /albums/{id}` | `AlbumsController.cs:291` | `AlbumSchema` | ✅ MATCH | Same as above. |
| 3 | `PATCH /albums/{id}/expiration` | `AlbumsController.cs:371` | `AlbumSchema` | ✅ MATCH | Explicitly carries `updatedAt`; doc-comment cites the same lesson as sync-500. |
| 4 | `GET /albums/{id}/sync` | `AlbumsController.cs:560` | `SyncResponseSchema` | ✅ MATCH (post `dce5f502`) | `manifests[]` items conform to `ManifestRecordSchema` including `createdAt` / `updatedAt`; extra `albumId`, `manifestId`, `manifestUrl`, `expectedSha256` are stripped. |
| 5 | `GET /albums/{id}/epoch-keys` | `EpochKeysController.cs:50` | `EpochKeyRecordListSchema` | ✅ MATCH | All 8 required fields present. |
| 6 | `POST /albums/{id}/epoch-keys` (upsert path) | `EpochKeysController.cs:121` | `CreateEpochKeyResponseSchema` | ✅ MATCH | All 5 fields present. |
| 7 | `GET /albums/{id}/members` | `MembersController.cs:68` | `AlbumMemberListSchema` (`AlbumMemberSchema`) | ✅ MATCH | `role` is a `string` column (`"owner"`/`"editor"`/`"viewer"`) — matches the Zod literal union. Extra `revokedAt` stripped; `user` is `optional` on Zod and intentionally absent. |
| 8 | `POST /albums/{id}/member-roster` | `MembersController.cs:556` | _(no Zod schema)_ | N/A | Frontend treats response as `void`; not validated. |
| 9 | `GET /users/me` (LocalAuth & ProxyAuth) | `UsersController.cs:95` / `:114` | `UserSchema` | ✅ MATCH | ProxyAuth deliberately omits `authSub` (Zod marks it `.optional()`). KDF fields all carry values; `wrappedIdentitySeed` was added to fix bundle-seal-222 — see `restoreSession()`. Extra `quota` field stripped. |
| 10 | `PUT /users/me` | `UsersController.cs:205` / `:215` | `UserSchema` | ✅ MATCH (relies on Zod defaults) | KDF fields are absent in the response, but the Zod schema defines `.default()` for each so the parse fills them in. Worth tightening — see §Recommendation. |
| 11 | `GET /users/{userId}` | `UsersController.cs:397` | `UserPublicSchema` | ✅ MATCH | `{id, identityPubkey}`. |
| 12 | `GET /users/by-pubkey/{pubkey}` | `UsersController.cs:419` | `UserPublicSchema` | ✅ MATCH | Same shape. |
| 13 | `POST /share-links/{id}/keys` | `ShareLinksController.cs:573` | `AddShareLinkEpochKeysResponseSchema` | ✅ MATCH | `{added, updated}` — both required, both present. |
| 14 | `GET /manifests/{id}` | `ManifestsController.cs:690` | `ManifestRecordSchema` | ❌ **MISMATCH** | Two defects — see §Detailed findings. |

### Health probes (separately verified)

| Endpoint | Backend file:line | Zod schema | Status |
|----------|-------------------|------------|--------|
| `GET /health` (alias `GET /health/ready`) | `HealthController.cs:69` | `HealthResponseSchema` | ✅ MATCH (`status="healthy"`) |
| `GET /health/live` | `HealthController.cs:54` | _(not parsed by frontend)_ | Returns `status="alive"` which is _not_ in the Zod literal union, but `api.ts` only fetches `/health`, so this never reaches the schema. |

### Out of scope (internal LINQ — not response payloads)

These anonymous types are projection scaffolding that gets re-mapped to a typed
record/result before `Ok(...)`. They are not part of the wire contract:

- `AdminStatsController.cs:47, :70` — projects into `UserQuotaWarning` / `AlbumLimitWarning` / `SystemStatsResponse` (typed records).
- `AuthController.cs:674, :686` — DB query scaffolding; the returned shape is the second
  anonymous projection (line `:686`), which has no Zod schema (the sessions UI consumes
  `Promise<unknown[]>`).
- `ManifestsController.cs:555–557` — `GroupJoin` join keys.
- `ShareLinkAccessController.cs:240` — `GroupBy` projection (epoch-id roll-up).
- `ShareLinksController.cs:284` — re-mapped to `ShareLinkWithSecretResponse` typed record at `:309`.
- `UsersController.cs:90` (`quotaResponse`) — composed into the `/users/me` response; counted under #9 above.
- `UsersController.cs:353` — re-mapped to `ShareLinkSummary` typed record at `:367`.

### Non-Zod response shapes (legitimately unvalidated)

These return anonymous objects but the frontend either does not parse them or treats
them as opaque. No drift risk for the audit.

| Endpoint | File:line | Notes |
|----------|-----------|-------|
| `GET /api/v1/auth/config` | `AuthController.cs:106` | `{localAuthEnabled, proxyAuthEnabled}`. |
| `POST /api/v1/auth/register` | `AuthController.cs:595` | Returns `Created(...)`. |
| `POST /api/v1/auth/logout` | `AuthController.cs:613, :645` | `{message}` only. |
| `GET /api/v1/auth/sessions` | `AuthController.cs:686` | Frontend consumes as untyped list (no Zod schema). |
| `DELETE /api/v1/auth/sessions/{id}` | `AuthController.cs:727` | `{message}`. |
| `POST /api/v1/auth/sessions/revoke-others` | `AuthController.cs:759` | `{revokedCount}`. |
| `POST /api/v1/dev-auth/...` | `DevAuthController.cs:233` | Dev-only. |
| `Gone(new { ... })` payloads | `ShareLinkAccessController.cs` (multiple) | Error bodies; not parsed against a success schema. |

## Detailed findings

### ❌ `GET /api/v1/manifests/{id}` — backend payload does not satisfy `ManifestRecordSchema`

**Backend** (`apps/backend/Mosaic.Backend/Controllers/ManifestsController.cs:690`):

```csharp
return Ok(new
{
    ProtocolVersion = manifest.ProtocolVersion,
    ManifestId = manifest.Id,                 // ← serialized as "manifestId"
    manifest.AlbumId,
    manifest.AssetType,
    manifest.MetadataVersion,
    manifest.CreatedAt,
    manifest.VersionCreated,
    manifest.IsDeleted,
    manifest.EncryptedMeta,
    manifest.EncryptedMetaSidecar,
    manifest.Signature,
    manifest.SignerPubkey,
    manifest.ExpiresAt,
    ShardIds = manifest.ManifestShards.Select(ms => ms.ShardId),
    Shards   = manifest.ManifestShards.Select(ms => new { ms.ShardId, ms.Tier }),    // ← only 2 of 6 required fields
    TieredShards = manifest.ManifestShards
        .OrderBy(ms => ms.Tier)
        .ThenBy(ms => ms.ShardIndex)
        .Select(ms => new { ms.Tier, ms.ShardIndex, ms.ShardId,
                            ms.Sha256, ms.ContentLength, ms.EnvelopeVersion }),
    manifest.UpdatedAt
});
```

**Frontend** (`apps/web/src/lib/api-schemas.ts:267`):

```ts
export const ManifestShardProjectionSchema = z.object({
  shardId: UuidSchema,
  tier: AccessTierSchema,
  shardIndex: z.number().int().nonnegative(),
  sha256: Sha256HexSchema,
  contentLength: z.number().int().nonnegative(),
  envelopeVersion: z.number().int().positive(),
});

export const ManifestRecordSchema = z.object({
  id: UuidSchema,                        // ← required
  albumId: UuidSchema,
  versionCreated: z.number()...,
  isDeleted: z.boolean(),
  encryptedMeta: Base64Schema,
  signature: Base64Schema,
  signerPubkey: Base64Schema,
  shardIds: z.array(z.string()),
  shards: z.array(ManifestShardProjectionSchema).default([]),  // ← items need 6 fields
  ...
});
```

**Caller:** `apps/web/src/lib/api.ts:891` parses the response with
`ManifestRecordSchema`. Hot consumers are
`apps/web/src/hooks/usePhotoActions.ts:120` and `:194`.

**Two defects:**

1. **`id` is missing.** The projection field is named `ManifestId`, which JSON-serializes
   to `manifestId`. `ManifestRecordSchema.id` is required and is _not_ a `.nullish()`
   field, so the Zod parse should fail with `Required at "id"`. Note `Shards.shardId` is
   present, but that doesn't satisfy the top-level `id` requirement.
2. **`shards[].*` is incomplete.** Each element only carries `{shardId, tier}`, but the
   Zod schema's element shape requires `shardIndex`, `sha256`, `contentLength`,
   `envelopeVersion`. The companion `tieredShards` array (which the backend ships under
   a different name) is the correctly-shaped projection. The Zod `.default([])` on the
   outer array does _not_ help here: defaults apply only when the property is
   `undefined`, not when an array of malformed items is present.

**Why this hasn't surfaced as a 500-on-every-page-load:** the `usePhotoActions` callers
fetch a manifest as part of edit/delete flows; if the parse fails, the user sees an
`ApiError(500, "Invalid response shape")` only at the moment they invoke that flow.
Unlike `Sync`, this isn't on the post-mutation hot path. The bug is latent.

**Trivial diff** (filed as `audit-projections-fix-getmanifest`):

```csharp
return Ok(new
{
    ProtocolVersion = manifest.ProtocolVersion,
    Id = manifest.Id,                  // RENAMED from ManifestId
    ManifestId = manifest.Id,          // KEPT for backwards compatibility with any non-Zod caller
    manifest.AlbumId,
    ...
    Shards = manifest.ManifestShards.Select(ms => new {
        ms.ShardId, ms.Tier, ms.ShardIndex,
        Sha256 = ms.Sha256.ToLower(),
        ms.ContentLength, ms.EnvelopeVersion
    }),
    // tieredShards can be removed once no caller references it
    ...
});
```

(Pattern verified: this is exactly the shape that `AlbumsController.Sync` ships for
`manifests[].shards[]` at `AlbumsController.cs:525–535`. The two endpoints describing
"the same kind of object" should match.)

## Recommendation — convert anonymous projections to typed C# records

The pattern that bit `Sync` (and still bites `GetManifest`) is structural, not
incidental:

- Anonymous-type projections are **unnamed and unimported**. The frontend's Zod schema
  is the closest thing to a contract source-of-truth, but nothing on the backend side
  references it. A refactor that drops a field in the projection compiles cleanly and
  ships silently.
- The frontend's `ApiClient` translates a Zod-validation failure into
  `ApiError(500, "Invalid response shape")`, which is **indistinguishable from a real
  server 500** in dashboards and Sentry-style telemetry. Operators see an
  HTTP-500-like signal and look at server logs, where nothing is wrong.

**Concrete recommendation, in priority order:**

1. **Replace the `Sync` and `GetManifest` projections with typed records** — e.g.

   ```csharp
   public sealed record AlbumSyncManifest(
       Guid Id, Guid AlbumId, long VersionCreated, bool IsDeleted,
       byte[] EncryptedMeta, byte[] Signature, byte[] SignerPubkey,
       byte[]? TombstoneSignature, int? TombstoneSignerEpochId,
       long? ManifestSeq, DateTime CreatedAt, DateTime? UpdatedAt,
       IReadOnlyList<Guid> ShardIds,
       IReadOnlyList<ManifestShardWire> Shards);

   public sealed record ManifestShardWire(
       Guid ShardId, int Tier, int ShardIndex,
       string Sha256, long ContentLength, int EnvelopeVersion);

   public sealed record AlbumSyncResponse(
       Guid AlbumId, long CurrentVersion, Guid? ManifestId, string? ManifestUrl,
       string ExpectedSha256, IReadOnlyList<AlbumSyncManifest> Manifests,
       int CurrentEpochId, long AlbumVersion, bool HasMore);
   ```

   Decorate the controller with `[ProducesResponseType<AlbumSyncResponse>(StatusCodes.Status200OK)]`
   so the OpenAPI schema (consumed by Scalar at `/scalar`) also reflects the contract.

2. **Add a single integration test** that round-trips a known-good
   `AlbumSyncResponse` through `System.Text.Json` and asserts the deserialised JSON
   parses cleanly under the equivalent Zod schema. The crypto-bypass-inventory work
   already runs Node from xUnit (`tests/integration/`) — the same harness can host a
   Zod-via-Node pinning test that fails CI on the next regression of this class.

3. **Stop surfacing Zod failures as `ApiError(500, ...)`.** That's the root cause of
   why `Sync` shipped broken — operators couldn't tell the difference between a real
   server bug and a contract drift. A distinct error type
   (`ApiError(_, 'Schema mismatch: …')` with the Zod issue path) would have produced a
   one-glance fix.

4. **Strengthen `PUT /users/me` (#10)** — it relies on Zod schema defaults to compensate
   for missing KDF fields in the response. The endpoint should echo the full user
   record like `GET /users/me` does, so a Zod default-removal can't silently change
   client behaviour. Filed as the soft recommendation here; not a current bug.

## Filed sub-todos

- `audit-projections-fix-getmanifest` — fix `GET /api/v1/manifests/{id}` to ship `id`
  at the top level and to include `shardIndex`, `sha256`, `contentLength`,
  `envelopeVersion` inside `shards[]`. Trivial diff above. See ManifestsController.cs:690.

## Changelog

| Date       | Action  | Notes |
|------------|---------|-------|
| 2026-05-19 | Audited | 14 anonymous projections inventoried; 13 MATCH, 1 MISMATCH (`GET /manifests/{id}`). |
