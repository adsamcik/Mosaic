/**
 * api-schemas tests (M2)
 *
 * Verifies that the runtime schemas backing apiRequest catch the kinds of
 * tampering / drift that prompted the M2 finding:
 *   - missing required fields
 *   - wrong-type fields (a UUID string replaced by a number, etc.)
 *   - extra fields on responses (silently stripped, *not* rejected — see
 *     api-schemas.ts header for the "permissive" rationale)
 */

import { describe, expect, it } from 'vitest';
import {
  AdminUserResponseSchema,
  AlbumSchema,
  EpochKeyRecordSchema,
  HealthResponseSchema,
  ShareLinkResponseSchema,
  SyncResponseSchema,
  UserSchema,
} from '../api-schemas';

const VALID_UUID = '0190a0d4-cffe-7a55-9b8a-94e4ad9c4e51';
const VALID_UUID_2 = '0190a0d5-1234-7a55-9b8a-94e4ad9c4e52';
const VALID_DATETIME = '2024-12-25T23:59:59Z';
const VALID_BASE64 = 'YWJjZGVmZ2hpamtsbW5vcA==';

// ---------------------------------------------------------------------------
// UserSchema — primary positive / negative / extra-field battery
// ---------------------------------------------------------------------------
describe('UserSchema', () => {
  const validUser = {
    id: VALID_UUID,
    authSub: 'oidc-subject-123',
    identityPubkey: VALID_BASE64,
    createdAt: VALID_DATETIME,
    isAdmin: false,
  };

  it('parses a valid User payload', () => {
    const parsed = UserSchema.parse(validUser);
    expect(parsed).toEqual(validUser);
  });

  it('parses a minimal User (only required fields)', () => {
    const minimal = {
      id: VALID_UUID,
      authSub: 'oidc-subject-123',
      createdAt: VALID_DATETIME,
    };
    const parsed = UserSchema.parse(minimal);
    expect(parsed.id).toBe(VALID_UUID);
    expect(parsed.authSub).toBe('oidc-subject-123');
  });

  it('rejects when a required field is missing', () => {
    const missingId = { authSub: 'x', createdAt: VALID_DATETIME };
    const result = UserSchema.safeParse(missingId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('id'))).toBe(true);
    }
  });

  it('rejects when a UUID field is a number instead of string', () => {
    const wrongType = {
      ...validUser,
      id: 42,
    };
    const result = UserSchema.safeParse(wrongType);
    expect(result.success).toBe(false);
  });

  it('rejects when a UUID field is a non-UUID string', () => {
    const wrongFormat = {
      ...validUser,
      id: 'not-a-uuid',
    };
    const result = UserSchema.safeParse(wrongFormat);
    expect(result.success).toBe(false);
  });

  it('rejects when isAdmin is a string instead of boolean (impersonation guard)', () => {
    const stringAdmin = { ...validUser, isAdmin: 'true' };
    const result = UserSchema.safeParse(stringAdmin);
    expect(result.success).toBe(false);
  });

  it('strips unknown fields silently (default permissive mode)', () => {
    const withExtras = {
      ...validUser,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      maliciousFlag: 'pwned',
      anotherExtra: 12345,
    } as Record<string, unknown>;
    const parsed = UserSchema.parse(withExtras);
    expect(parsed).not.toHaveProperty('maliciousFlag');
    expect(parsed).not.toHaveProperty('anotherExtra');
    expect(parsed.id).toBe(VALID_UUID);
  });

  it('rejects an invalid datetime', () => {
    const badDate = { ...validUser, createdAt: 'yesterday' };
    const result = UserSchema.safeParse(badDate);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AlbumSchema — exercises nullable-optional and timestamp combos
// ---------------------------------------------------------------------------
describe('AlbumSchema', () => {
  const validAlbum = {
    id: VALID_UUID,
    ownerId: VALID_UUID_2,
    currentVersion: 3,
    currentEpochId: 1,
    createdAt: VALID_DATETIME,
    expiresAt: null,
    expirationWarningDays: 7,
  };

  it('parses a valid Album', () => {
    const parsed = AlbumSchema.parse(validAlbum);
    expect(parsed.id).toBe(VALID_UUID);
    expect(parsed.expiresAt).toBeNull();
  });

  it('accepts an Album with an explicit expiresAt timestamp', () => {
    const withExpiration = {
      ...validAlbum,
      expiresAt: '2025-06-30T12:00:00+02:00',
    };
    const parsed = AlbumSchema.parse(withExpiration);
    expect(parsed.expiresAt).toBe('2025-06-30T12:00:00+02:00');
  });

  it('rejects when ownerId is not a UUID', () => {
    const bad = { ...validAlbum, ownerId: 'admin' };
    expect(AlbumSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects when currentVersion is a string', () => {
    const bad = { ...validAlbum, currentVersion: '3' };
    expect(AlbumSchema.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EpochKeyRecordSchema — base64 fields are the most likely tamper surface
// ---------------------------------------------------------------------------
describe('EpochKeyRecordSchema', () => {
  const valid = {
    id: VALID_UUID,
    albumId: VALID_UUID_2,
    epochId: 1,
    encryptedKeyBundle: VALID_BASE64,
    ownerSignature: VALID_BASE64,
    sharerPubkey: VALID_BASE64,
    signPubkey: VALID_BASE64,
    createdAt: VALID_DATETIME,
  };

  it('parses a valid record', () => {
    expect(EpochKeyRecordSchema.parse(valid)).toEqual(valid);
  });

  it('rejects when a base64 field contains illegal characters', () => {
    const bad = { ...valid, sharerPubkey: 'not base64 — has spaces!!' };
    expect(EpochKeyRecordSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects when epochId is null', () => {
    const bad = { ...valid, epochId: null };
    expect(EpochKeyRecordSchema.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ShareLinkResponseSchema — accessTier is a small numeric enum, easy to
// tamper with by sending a string ("3") or out-of-range value (4).
// ---------------------------------------------------------------------------
describe('ShareLinkResponseSchema', () => {
  const valid = {
    id: VALID_UUID,
    linkId: VALID_BASE64,
    accessTier: 2,
    useCount: 0,
    isRevoked: false,
    createdAt: VALID_DATETIME,
  };

  it('parses a valid ShareLinkResponse', () => {
    expect(ShareLinkResponseSchema.parse(valid)).toMatchObject(valid);
  });

  it('rejects accessTier outside 1..3', () => {
    const bad = { ...valid, accessTier: 4 };
    expect(ShareLinkResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects accessTier sent as a string', () => {
    const bad = { ...valid, accessTier: '2' };
    expect(ShareLinkResponseSchema.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SyncResponseSchema — nested array of ManifestRecord, exercises
// recursive composition.
// ---------------------------------------------------------------------------
describe('SyncResponseSchema', () => {
  const valid = {
    manifests: [
      {
        id: VALID_UUID,
        albumId: VALID_UUID_2,
        versionCreated: 1,
        isDeleted: false,
        encryptedMeta: VALID_BASE64,
        signature: VALID_BASE64,
        signerPubkey: VALID_BASE64,
        shardIds: ['shard-a', 'shard-b'],
        createdAt: VALID_DATETIME,
      },
    ],
    currentEpochId: 1,
    albumVersion: 1,
    hasMore: false,
  };

  it('parses a valid SyncResponse', () => {
    const parsed = SyncResponseSchema.parse(valid);
    expect(parsed.manifests).toHaveLength(1);
    expect(parsed.hasMore).toBe(false);
  });

  it('rejects when a nested manifest has a wrong-typed field', () => {
    const bad = JSON.parse(JSON.stringify(valid)) as typeof valid;
    (bad.manifests[0] as unknown as Record<string, unknown>).isDeleted =
      'false';
    expect(SyncResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects when shardIds is not an array', () => {
    const bad = JSON.parse(JSON.stringify(valid)) as typeof valid;
    (bad.manifests[0] as unknown as Record<string, unknown>).shardIds =
      'shard-a';
    expect(SyncResponseSchema.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HealthResponseSchema — small but its enum-like fields are common
// tamper targets in service-discovery scenarios.
// ---------------------------------------------------------------------------
describe('HealthResponseSchema', () => {
  it('parses healthy response', () => {
    const parsed = HealthResponseSchema.parse({
      status: 'healthy',
      timestamp: VALID_DATETIME,
    });
    expect(parsed.status).toBe('healthy');
  });

  it('rejects an unknown status value', () => {
    const result = HealthResponseSchema.safeParse({
      status: 'flapping',
      timestamp: VALID_DATETIME,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AdminUserResponseSchema — the M2 motivating example (impersonation
// via injected `isAdmin: true`).
// ---------------------------------------------------------------------------
describe('AdminUserResponseSchema', () => {
  const valid = {
    id: VALID_UUID,
    authSub: 'oidc:42',
    isAdmin: false,
    createdAt: VALID_DATETIME,
    albumCount: 3,
    totalStorageBytes: 1024,
    quota: {
      currentStorageBytes: 0,
      currentAlbumCount: 0,
    },
  };

  it('parses a valid admin user response', () => {
    expect(AdminUserResponseSchema.parse(valid)).toMatchObject(valid);
  });

  it('rejects when isAdmin is missing entirely', () => {
    const bad = { ...valid } as Record<string, unknown>;
    delete bad['isAdmin'];
    expect(AdminUserResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects when quota is replaced by a number', () => {
    const bad = { ...valid, quota: 0 };
    expect(AdminUserResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('strips an injected unknown field on the quota sub-object', () => {
    const withExtras = {
      ...valid,
      quota: {
        ...valid.quota,
        bypassQuota: true,
      },
    };
    const parsed = AdminUserResponseSchema.parse(withExtras);
    expect(parsed.quota).not.toHaveProperty('bypassQuota');
    expect(parsed.quota.currentStorageBytes).toBe(0);
  });
});
