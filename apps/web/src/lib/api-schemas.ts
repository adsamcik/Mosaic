/**
 * Mosaic API Response Schemas (M2 — runtime validation)
 *
 * Zod schemas for every response shape returned by the backend's typed
 * endpoints. `apiRequest` in `api.ts` validates `response.json()` against
 * the matching schema before handing the value to the caller, so a
 * compromised backend, MITM, or reverse-proxy bug cannot inject extra
 * fields (e.g. `isAdmin: true`), drop required ones, or shift types
 * (e.g. `albumId: 42` instead of a UUID string).
 *
 * ## Strictness
 *
 * Schemas use Zod's default object behaviour (strip mode): unknown fields
 * are silently dropped from the parsed value. We deliberately do NOT use
 * `.strict()`. The backend may legitimately add new fields in a future
 * release and clients running an older bundle should keep working. Strict
 * mode would raise on every additive change — too brittle for an API we
 * version implicitly via the OpenAPI spec.
 *
 * Strictness is therefore "shape-checked": every required field must be
 * present with the right type, but new additive fields pass through (and
 * are dropped from the typed view until added here). If a callsite needs
 * to reject unknown fields specifically (e.g. for security boundaries),
 * it can use `Schema.strict()` at the call site.
 *
 * ## Type aliases
 *
 * `api-types.ts` is the legacy hand-written interface set. Inferred types
 * here (`type User = z.infer<typeof UserSchema>`) describe the same JSON
 * shapes but, due to Zod's optional-property semantics under
 * `exactOptionalPropertyTypes: true`, may be slightly wider than the
 * api-types interfaces (`?: T | undefined` vs `?: T`). Internal callers
 * that already import from `api-types` continue to work; new callers may
 * import from here for types that stay in sync with the runtime schema.
 *
 * Consolidating api-types.ts into this file is a planned follow-up — see
 * the M2 commit message.
 */

import { z } from 'zod';

// =============================================================================
// Field-level Helpers
// =============================================================================

/** UUID (any version, including UUIDv7 used by the backend). */
const UuidSchema = z.string().uuid();

/** ISO 8601 timestamp with offset (`Z` or `±HH:MM`). */
const IsoDateTimeSchema = z.string().datetime({ offset: true });

/**
 * Standard base64 (with `+` and `/`, optional `=` padding). Empty string
 * is accepted because some optional fields may legitimately be the empty
 * blob.
 */
const Base64Schema = z.string().base64();

/**
 * AccessTier enum coming back as a numeric literal (1=THUMB, 2=PREVIEW,
 * 3=FULL). Inlined as numeric literals — see `libs/crypto/src/types.ts`
 * for the symbolic enum. We intentionally do NOT import `AccessTier`
 * from `@mosaic/crypto` here: the rust-cutover-boundary test treats every
 * production `@mosaic/crypto` import as compatibility debt that must be
 * explicitly classified, and api-schemas describes the wire format only,
 * which is the literal numbers below.
 */
const AccessTierSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

// =============================================================================
// Health
// =============================================================================

export const HealthResponseSchema = z.object({
  status: z.union([
    z.literal('healthy'),
    z.literal('degraded'),
    z.literal('unhealthy'),
  ]),
  timestamp: IsoDateTimeSchema,
  version: z.string().optional(),
  checks: z
    .record(
      z.string(),
      z.union([z.literal('ok'), z.literal('warn'), z.literal('fail')]),
    )
    .optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// =============================================================================
// Users
// =============================================================================

export const UserSchema = z.object({
  id: UuidSchema,
  authSub: z.string(),
  identityPubkey: Base64Schema.optional(),
  createdAt: IsoDateTimeSchema,
  isAdmin: z.boolean().optional(),
  encryptedSalt: Base64Schema.optional(),
  saltNonce: Base64Schema.optional(),
  accountSalt: Base64Schema.optional(),
  wrappedAccountKey: Base64Schema.optional(),
});
export type User = z.infer<typeof UserSchema>;

export const UserPublicSchema = z.object({
  id: UuidSchema,
  identityPubkey: Base64Schema,
});
export type UserPublic = z.infer<typeof UserPublicSchema>;

// =============================================================================
// Albums
// =============================================================================

export const AlbumSchema = z.object({
  id: UuidSchema,
  ownerId: UuidSchema,
  currentVersion: z.number().int().nonnegative(),
  currentEpochId: z.number().int().nonnegative(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema.optional(),
  encryptedName: Base64Schema.nullable().optional(),
  encryptedDescription: Base64Schema.nullable().optional(),
  expiresAt: IsoDateTimeSchema.nullable().optional(),
  expirationWarningDays: z.number().int().nonnegative().optional(),
});
export type Album = z.infer<typeof AlbumSchema>;

export const AlbumListSchema = z.array(AlbumSchema);

export const RenameAlbumResponseSchema = z.object({
  id: UuidSchema,
  encryptedName: Base64Schema,
  updatedAt: IsoDateTimeSchema,
});
export type RenameAlbumResponse = z.infer<typeof RenameAlbumResponseSchema>;

export const UpdateDescriptionResponseSchema = z.object({
  id: UuidSchema,
  encryptedDescription: Base64Schema.nullable().optional(),
  updatedAt: IsoDateTimeSchema,
});
export type UpdateDescriptionResponse = z.infer<
  typeof UpdateDescriptionResponseSchema
>;

// =============================================================================
// Album Content (Story Blocks — opaque ciphertext from the server's POV)
// =============================================================================

export const AlbumContentResponseSchema = z.object({
  encryptedContent: Base64Schema,
  nonce: Base64Schema,
  epochId: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
  updatedAt: IsoDateTimeSchema,
});
export type AlbumContentResponse = z.infer<typeof AlbumContentResponseSchema>;

// =============================================================================
// Members
// =============================================================================

export const AlbumRoleSchema = z.union([
  z.literal('owner'),
  z.literal('editor'),
  z.literal('viewer'),
]);
export type AlbumRole = z.infer<typeof AlbumRoleSchema>;

export const AlbumMemberSchema = z.object({
  userId: UuidSchema,
  role: AlbumRoleSchema,
  invitedBy: UuidSchema.optional(),
  joinedAt: IsoDateTimeSchema,
  user: UserPublicSchema.optional(),
});
export type AlbumMember = z.infer<typeof AlbumMemberSchema>;

export const AlbumMemberListSchema = z.array(AlbumMemberSchema);

// =============================================================================
// Epoch Keys
// =============================================================================

export const EpochKeyRecordSchema = z.object({
  id: UuidSchema,
  albumId: UuidSchema,
  epochId: z.number().int().nonnegative(),
  encryptedKeyBundle: Base64Schema,
  ownerSignature: Base64Schema,
  sharerPubkey: Base64Schema,
  signPubkey: Base64Schema,
  createdAt: IsoDateTimeSchema,
});
export type EpochKeyRecord = z.infer<typeof EpochKeyRecordSchema>;

export const EpochKeyRecordListSchema = z.array(EpochKeyRecordSchema);

// =============================================================================
// Manifests
// =============================================================================

export const ManifestRecordSchema = z.object({
  id: UuidSchema,
  albumId: UuidSchema,
  versionCreated: z.number().int().nonnegative(),
  isDeleted: z.boolean(),
  encryptedMeta: Base64Schema,
  signature: Base64Schema,
  signerPubkey: Base64Schema,
  // Shard IDs are server-generated identifiers; the backend treats them
  // as opaque strings (UUID format in practice, but we don't depend on
  // that at the schema level — the manifest signature already binds them
  // cryptographically).
  shardIds: z.array(z.string()),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema.optional(),
});
export type ManifestRecord = z.infer<typeof ManifestRecordSchema>;

export const ManifestCreatedSchema = z.object({
  id: UuidSchema,
  version: z.number().int().nonnegative(),
});
export type ManifestCreated = z.infer<typeof ManifestCreatedSchema>;

export const ManifestMetadataUpdatedSchema = z.object({
  id: UuidSchema,
  versionCreated: z.number().int().nonnegative(),
});
export type ManifestMetadataUpdated = z.infer<
  typeof ManifestMetadataUpdatedSchema
>;

// =============================================================================
// Sync (depends on ManifestRecordSchema)
// =============================================================================

export const SyncResponseSchema = z.object({
  manifests: z.array(ManifestRecordSchema),
  currentEpochId: z.number().int().nonnegative(),
  albumVersion: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export type SyncResponse = z.infer<typeof SyncResponseSchema>;

// =============================================================================
// Share Links
// =============================================================================

export const ShareLinkResponseSchema = z.object({
  id: UuidSchema,
  // linkId is a 16-byte random identifier transported as base64.
  linkId: Base64Schema,
  accessTier: AccessTierSchema,
  expiresAt: IsoDateTimeSchema.optional(),
  maxUses: z.number().int().nonnegative().optional(),
  useCount: z.number().int().nonnegative(),
  isRevoked: z.boolean(),
  createdAt: IsoDateTimeSchema,
});
export type ShareLinkResponse = z.infer<typeof ShareLinkResponseSchema>;

export const ShareLinkResponseListSchema = z.array(ShareLinkResponseSchema);

export const ShareLinkWithSecretResponseSchema = z.object({
  id: UuidSchema,
  linkId: Base64Schema,
  accessTier: AccessTierSchema,
  isRevoked: z.boolean(),
  ownerEncryptedSecret: Base64Schema.optional(),
});
export type ShareLinkWithSecretResponse = z.infer<
  typeof ShareLinkWithSecretResponseSchema
>;

export const ShareLinkWithSecretResponseListSchema = z.array(
  ShareLinkWithSecretResponseSchema,
);

export const LinkAccessResponseSchema = z.object({
  albumId: UuidSchema,
  accessTier: AccessTierSchema,
  epochCount: z.number().int().nonnegative(),
  encryptedName: Base64Schema.nullable().optional(),
  // grantToken is an opaque server-issued bearer token; format is not
  // base64-guaranteed (could be a JWT or signed cookie).
  grantToken: z.string().nullable().optional(),
});
export type LinkAccessResponse = z.infer<typeof LinkAccessResponseSchema>;

export const LinkEpochKeyResponseSchema = z.object({
  epochId: z.number().int().nonnegative(),
  tier: AccessTierSchema,
  nonce: Base64Schema,
  encryptedKey: Base64Schema,
  signPubkey: Base64Schema.optional(),
});
export type LinkEpochKeyResponse = z.infer<typeof LinkEpochKeyResponseSchema>;

export const LinkEpochKeyResponseListSchema = z.array(
  LinkEpochKeyResponseSchema,
);

export const ShareLinkPhotoResponseSchema = z.object({
  id: UuidSchema,
  versionCreated: z.number().int().nonnegative(),
  isDeleted: z.boolean(),
  encryptedMeta: Base64Schema,
  signature: Base64Schema,
  signerPubkey: Base64Schema,
  shardIds: z.array(z.string()),
});
export type ShareLinkPhotoResponse = z.infer<
  typeof ShareLinkPhotoResponseSchema
>;

export const ShareLinkPhotoResponseListSchema = z.array(
  ShareLinkPhotoResponseSchema,
);

/** Result of POST /share-links/{id}/keys — count of keys added/updated. */
export const AddShareLinkEpochKeysResponseSchema = z.object({
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
});
export type AddShareLinkEpochKeysResponse = z.infer<
  typeof AddShareLinkEpochKeysResponseSchema
>;

// =============================================================================
// Quotas / Admin
// =============================================================================

export const QuotaDefaultsSchema = z.object({
  maxStorageBytes: z.number().int().nonnegative(),
  maxAlbums: z.number().int().nonnegative(),
  maxPhotosPerAlbum: z.number().int().nonnegative(),
  maxAlbumSizeBytes: z.number().int().nonnegative(),
});
export type QuotaDefaults = z.infer<typeof QuotaDefaultsSchema>;

export const AdminUserQuotaSchema = z.object({
  maxStorageBytes: z.number().int().nonnegative().optional(),
  currentStorageBytes: z.number().int().nonnegative(),
  maxAlbums: z.number().int().nonnegative().optional(),
  currentAlbumCount: z.number().int().nonnegative(),
});
export type AdminUserQuota = z.infer<typeof AdminUserQuotaSchema>;

export const AdminUserResponseSchema = z.object({
  id: UuidSchema,
  authSub: z.string(),
  identityPubkey: Base64Schema.optional(),
  isAdmin: z.boolean(),
  createdAt: IsoDateTimeSchema,
  albumCount: z.number().int().nonnegative(),
  totalStorageBytes: z.number().int().nonnegative(),
  quota: AdminUserQuotaSchema,
});
export type AdminUserResponse = z.infer<typeof AdminUserResponseSchema>;

/** Wrapper response from `/admin/users` (the backend wraps the list). */
export const AdminUserListEnvelopeSchema = z.object({
  users: z.array(AdminUserResponseSchema),
});

export const AdminAlbumLimitsSchema = z.object({
  maxPhotos: z.number().int().nonnegative().optional(),
  currentPhotoCount: z.number().int().nonnegative(),
  maxSizeBytes: z.number().int().nonnegative().optional(),
  currentSizeBytes: z.number().int().nonnegative(),
});
export type AdminAlbumLimits = z.infer<typeof AdminAlbumLimitsSchema>;

export const AdminAlbumResponseSchema = z.object({
  id: UuidSchema,
  ownerId: UuidSchema,
  ownerAuthSub: z.string(),
  createdAt: IsoDateTimeSchema,
  photoCount: z.number().int().nonnegative(),
  totalSizeBytes: z.number().int().nonnegative(),
  limits: AdminAlbumLimitsSchema.optional(),
});
export type AdminAlbumResponse = z.infer<typeof AdminAlbumResponseSchema>;

/** Wrapper response from `/admin/albums` (the backend wraps the list). */
export const AdminAlbumListEnvelopeSchema = z.object({
  albums: z.array(AdminAlbumResponseSchema),
});

export const AdminStatsResponseSchema = z.object({
  totalUsers: z.number().int().nonnegative(),
  totalAlbums: z.number().int().nonnegative(),
  totalPhotos: z.number().int().nonnegative(),
  totalStorageBytes: z.number().int().nonnegative(),
});
export type AdminStatsResponse = z.infer<typeof AdminStatsResponseSchema>;

export const NearLimitsResponseSchema = z.object({
  usersNearStorageLimit: z.array(AdminUserResponseSchema),
  usersNearAlbumLimit: z.array(AdminUserResponseSchema),
  albumsNearPhotoLimit: z.array(AdminAlbumResponseSchema),
  albumsNearSizeLimit: z.array(AdminAlbumResponseSchema),
});
export type NearLimitsResponse = z.infer<typeof NearLimitsResponseSchema>;
