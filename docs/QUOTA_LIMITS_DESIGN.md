# Quota and Limits Feature Design

## Overview

This feature enables service administrators to configure and enforce storage limits at both user and album levels. All limits are dynamically configurable via an admin API without requiring server restart.

## Requirements

### User-Level Quotas
1. **Total storage limit** - Maximum bytes a user can store across all albums
2. **Maximum albums** - Maximum number of albums a user can own
3. **Per-user overrides** - Ability to set custom limits for specific users

### Album-Level Limits
1. **Maximum album size** - Maximum total bytes in a single album
2. **Maximum photo count** - Maximum number of photos (manifests) in an album
3. **Per-album overrides** - Ability to set custom limits for specific albums

### Admin Features
1. **Dynamic configuration** - Change limits without server restart
2. **Default limits** - System-wide defaults for new users/albums
3. **Usage visibility** - View current usage vs limits
4. **Bulk operations** - Apply limit changes to all users/albums

---

## Database Design

### New Tables

#### `system_settings`
Stores dynamic system-wide configuration.

```sql
CREATE TABLE system_settings (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id)
);

-- Example entries:
-- key: 'quota.defaults'
-- value: {
--   "maxStorageBytesPerUser": 10737418240,
--   "maxAlbumsPerUser": 100,
--   "maxPhotosPerAlbum": 10000,
--   "maxBytesPerAlbum": 5368709120
-- }
```

#### `album_limits` (new table)
Per-album limit overrides and usage tracking.

```sql
CREATE TABLE album_limits (
    album_id UUID PRIMARY KEY REFERENCES albums(id) ON DELETE CASCADE,
    max_photos INT,           -- NULL = use system default
    max_size_bytes BIGINT,    -- NULL = use system default
    current_photo_count INT NOT NULL DEFAULT 0,
    current_size_bytes BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Modified Tables

#### `user_quotas` (extend existing)
Add new columns for album count limit and current count.

```sql
ALTER TABLE user_quotas ADD COLUMN max_albums INT;         -- NULL = use system default
ALTER TABLE user_quotas ADD COLUMN current_album_count INT NOT NULL DEFAULT 0;
```

---

## Entity Changes

### New Entities

```csharp
// Data/Entities/SystemSetting.cs
public class SystemSetting
{
    public required string Key { get; set; }
    public required string Value { get; set; }  // JSON string
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public Guid? UpdatedBy { get; set; }
    
    // Navigation
    public User? UpdatedByUser { get; set; }
}

// Data/Entities/AlbumLimits.cs
public class AlbumLimits
{
    public Guid AlbumId { get; set; }
    public int? MaxPhotos { get; set; }
    public long? MaxSizeBytes { get; set; }
    public int CurrentPhotoCount { get; set; }
    public long CurrentSizeBytes { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    
    // Navigation
    public Album Album { get; set; } = null!;
}
```

### Modified Entities

```csharp
// Data/Entities/UserQuota.cs - add new properties
public class UserQuota
{
    // ... existing properties ...
    public int? MaxAlbums { get; set; }
    public int CurrentAlbumCount { get; set; }
}

// Data/Entities/Album.cs - add navigation
public class Album
{
    // ... existing properties ...
    public AlbumLimits? Limits { get; set; }
}

// Data/Entities/User.cs - add IsAdmin flag
public class User
{
    // ... existing properties ...
    public bool IsAdmin { get; set; }
}
```

---

## Configuration Model

### Quota Defaults (appsettings.json)

```json
{
  "Quota": {
    "DefaultMaxBytes": 10737418240,
    "DefaultMaxAlbums": 100,
    "DefaultMaxPhotosPerAlbum": 10000,
    "DefaultMaxBytesPerAlbum": 5368709120,
    "EnforceOnUpload": true,
    "EnforceOnManifestCreate": true
  }
}
```

### Dynamic Settings Service

```csharp
public interface IQuotaSettingsService
{
    Task<QuotaDefaults> GetDefaultsAsync();
    Task SetDefaultsAsync(QuotaDefaults defaults, Guid updatedBy);
    Task<long> GetEffectiveMaxStorageBytesAsync(Guid userId);
    Task<int> GetEffectiveMaxAlbumsAsync(Guid userId);
    Task<int> GetEffectiveMaxPhotosAsync(Guid albumId);
    Task<long> GetEffectiveMaxAlbumSizeAsync(Guid albumId);
}

public record QuotaDefaults(
    long MaxStorageBytesPerUser,
    int MaxAlbumsPerUser,
    int MaxPhotosPerAlbum,
    long MaxBytesPerAlbum
);
```

---

## API Design

### Admin Endpoints

All admin endpoints require `IsAdmin = true` on the authenticated user.

#### System Settings

```http
GET /api/admin/settings/quota
Response: {
  "maxStorageBytesPerUser": 10737418240,
  "maxAlbumsPerUser": 100,
  "maxPhotosPerAlbum": 10000,
  "maxBytesPerAlbum": 5368709120
}

PUT /api/admin/settings/quota
Request: {
  "maxStorageBytesPerUser": 10737418240,
  "maxAlbumsPerUser": 100,
  "maxPhotosPerAlbum": 10000,
  "maxBytesPerAlbum": 5368709120
}
```

#### User Quota Management

```http
GET /api/admin/users
Response: {
  "users": [
    {
      "id": "uuid",
      "authSub": "user@example.com",
      "isAdmin": false,
      "quota": {
        "maxStorageBytes": 10737418240,
        "usedStorageBytes": 1234567890,
        "maxAlbums": 100,
        "currentAlbumCount": 5,
        "isCustom": false
      }
    }
  ]
}

GET /api/admin/users/{userId}/quota
PUT /api/admin/users/{userId}/quota
Request: {
  "maxStorageBytes": 21474836480,  // null = use system default
  "maxAlbums": 200                  // null = use system default
}

DELETE /api/admin/users/{userId}/quota
// Resets to system defaults

POST /api/admin/users/{userId}/promote
// Promotes user to admin

POST /api/admin/users/{userId}/demote
// Demotes admin to regular user
```

#### Album Limit Management

```http
GET /api/admin/albums
Response: {
  "albums": [
    {
      "id": "uuid",
      "ownerId": "uuid",
      "ownerAuthSub": "user@example.com",
      "limits": {
        "maxPhotos": 10000,
        "currentPhotoCount": 500,
        "maxSizeBytes": 5368709120,
        "currentSizeBytes": 1234567890,
        "isCustom": false
      }
    }
  ]
}

GET /api/admin/albums/{albumId}/limits
PUT /api/admin/albums/{albumId}/limits
Request: {
  "maxPhotos": 20000,      // null = use system default
  "maxSizeBytes": 10737418240
}

DELETE /api/admin/albums/{albumId}/limits
// Resets to system defaults
```

#### Usage Statistics

```http
GET /api/admin/stats
Response: {
  "totalUsers": 42,
  "totalAlbums": 150,
  "totalPhotos": 12500,
  "totalStorageBytes": 123456789012,
  "usersNearQuota": [
    { "userId": "uuid", "authSub": "user@example.com", "usagePercent": 95 }
  ],
  "albumsNearLimit": [
    { "albumId": "uuid", "ownerAuthSub": "user@example.com", "photoUsagePercent": 90 }
  ]
}
```

---

## Enforcement Points

### 1. Upload (TusEventHandlers.OnBeforeCreate)

```csharp
// Existing user quota check (already implemented)
if (quota.UsedStorageBytes + context.UploadLength > effectiveMaxBytes)
{
    context.FailRequest("Storage quota exceeded");
    return;
}
```

### 2. Album Creation (AlbumsController.Create)

```csharp
// New check
var quota = await _db.UserQuotas.FindAsync(user.Id);
var maxAlbums = await _quotaService.GetEffectiveMaxAlbumsAsync(user.Id);

if (quota.CurrentAlbumCount >= maxAlbums)
{
    return BadRequest(new { error = "Album limit exceeded" });
}

// After creation, increment count
quota.CurrentAlbumCount++;
```

### 3. Manifest Creation (ManifestsController.Create)

```csharp
// New checks
var limits = await _db.AlbumLimits.FindAsync(album.Id);
var maxPhotos = await _quotaService.GetEffectiveMaxPhotosAsync(album.Id);
var maxSize = await _quotaService.GetEffectiveMaxAlbumSizeAsync(album.Id);

var shardsTotalSize = shards.Sum(s => s.SizeBytes);

if (limits?.CurrentPhotoCount >= maxPhotos)
{
    return BadRequest(new { error = "Album photo limit exceeded" });
}

if (limits?.CurrentSizeBytes + shardsTotalSize > maxSize)
{
    return BadRequest(new { error = "Album size limit exceeded" });
}

// After creation, update limits
limits.CurrentPhotoCount++;
limits.CurrentSizeBytes += shardsTotalSize;
```

### 4. Manifest Deletion

```csharp
// Decrement limits on delete
limits.CurrentPhotoCount--;
limits.CurrentSizeBytes -= manifestShardsTotalSize;
```

---

## Authorization

### Admin Middleware

```csharp
public class AdminAuthMiddleware
{
    public async Task Invoke(HttpContext context, MosaicDbContext db)
    {
        if (!context.Request.Path.StartsWithSegments("/api/admin"))
        {
            await _next(context);
            return;
        }

        var authSub = context.Items["AuthSub"] as string;
        if (string.IsNullOrEmpty(authSub))
        {
            context.Response.StatusCode = 401;
            return;
        }

        var user = await db.Users.FirstOrDefaultAsync(u => u.AuthSub == authSub);
        if (user?.IsAdmin != true)
        {
            context.Response.StatusCode = 403;
            return;
        }

        context.Items["AdminUser"] = user;
        await _next(context);
    }
}
```

---

## Frontend Integration

### Admin Panel Route

```
/admin/settings     - System-wide quota defaults
/admin/users        - User list with quota info
/admin/users/:id    - Per-user quota management
/admin/albums       - Album list with limit info
/admin/albums/:id   - Per-album limit management
/admin/stats        - Usage dashboard
```

### Components

1. **QuotaSettingsForm** - Edit system-wide defaults
2. **UserQuotaEditor** - Edit per-user limits
3. **AlbumLimitsEditor** - Edit per-album limits
4. **UsageProgressBar** - Visual quota/limit usage
5. **AdminDashboard** - Overview with alerts for users/albums near limits

### API Client Extensions

```typescript
// lib/api-client.ts additions
interface AdminApi {
  getQuotaDefaults(): Promise<QuotaDefaults>;
  setQuotaDefaults(defaults: QuotaDefaults): Promise<void>;
  getUsers(): Promise<UserWithQuota[]>;
  getUserQuota(userId: string): Promise<UserQuota>;
  setUserQuota(userId: string, quota: UserQuotaUpdate): Promise<void>;
  resetUserQuota(userId: string): Promise<void>;
  getAlbums(): Promise<AlbumWithLimits[]>;
  getAlbumLimits(albumId: string): Promise<AlbumLimits>;
  setAlbumLimits(albumId: string, limits: AlbumLimitsUpdate): Promise<void>;
  resetAlbumLimits(albumId: string): Promise<void>;
  getStats(): Promise<SystemStats>;
  promoteUser(userId: string): Promise<void>;
  demoteUser(userId: string): Promise<void>;
}
```

---

## Migration Strategy

### Phase 1: Database Schema
1. Add `IsAdmin` column to users table
2. Create `system_settings` table
3. Create `album_limits` table
4. Add columns to `user_quotas` table

### Phase 2: Backfill Data
1. Calculate and populate `current_album_count` for all users
2. Calculate and populate `current_photo_count` and `current_size_bytes` for all albums
3. Insert default quota settings into `system_settings`
4. Promote first user (or specified user) to admin

### Phase 3: Enforcement
1. Add enforcement checks to controllers
2. Add admin middleware
3. Deploy admin API endpoints

### Phase 4: Frontend
1. Add admin routes (visible only to admins)
2. Implement admin components
3. Add quota warnings to user-facing UI

---

## Configuration Reference

### Environment Variables

```bash
# Initial admin user (set during first run)
MOSAIC_INITIAL_ADMIN=admin@example.com

# Override defaults without database (fallback)
MOSAIC_QUOTA_MAX_STORAGE_BYTES=10737418240
MOSAIC_QUOTA_MAX_ALBUMS=100
MOSAIC_QUOTA_MAX_PHOTOS_PER_ALBUM=10000
MOSAIC_QUOTA_MAX_BYTES_PER_ALBUM=5368709120
```

### Size Constants

| Value | Bytes | Human Readable |
|-------|-------|----------------|
| 1 GB  | 1073741824 | `1_073_741_824` |
| 5 GB  | 5368709120 | `5_368_709_120` |
| 10 GB | 10737418240 | `10_737_418_240` |
| 50 GB | 53687091200 | `53_687_091_200` |
| 100 GB | 107374182400 | `107_374_182_400` |

---

## Error Codes

| Code | HTTP Status | Message |
|------|-------------|---------|
| `QUOTA_EXCEEDED` | 400 | User storage quota exceeded |
| `ALBUM_LIMIT_EXCEEDED` | 400 | Maximum albums limit exceeded |
| `ALBUM_SIZE_EXCEEDED` | 400 | Album size limit exceeded |
| `ALBUM_PHOTOS_EXCEEDED` | 400 | Album photo count limit exceeded |
| `ADMIN_REQUIRED` | 403 | Admin privileges required |
| `CANNOT_DEMOTE_LAST_ADMIN` | 400 | Cannot demote the last admin |

---

## Security Considerations

1. **Admin verification** - All admin endpoints verify `IsAdmin` flag
2. **Audit logging** - Log all admin actions with user ID and timestamp
3. **Rate limiting** - Consider rate limiting admin endpoints
4. **Last admin protection** - Prevent demoting the last admin user
5. **Quota bypass prevention** - Enforce limits at all entry points

---

## Testing Requirements

### Unit Tests
- [ ] QuotaSettingsService - get/set defaults
- [ ] Effective limit calculations with fallbacks
- [ ] Enforcement in TusEventHandlers
- [ ] Enforcement in AlbumsController
- [ ] Enforcement in ManifestsController
- [ ] Admin middleware authorization

### Integration Tests
- [ ] Full upload flow with quota check
- [ ] Album creation with limit check
- [ ] Manifest creation with album limit check
- [ ] Admin settings persistence
- [ ] Per-user/album override precedence

### E2E Tests
- [ ] Admin can view and modify quota defaults
- [ ] Admin can set per-user quota overrides
- [ ] User sees appropriate error when quota exceeded
- [ ] Admin dashboard shows correct statistics

---

## Implementation Checklist

### Backend
- [ ] Migration: Add `is_admin` to users
- [ ] Migration: Create `system_settings` table
- [ ] Migration: Create `album_limits` table
- [ ] Migration: Add columns to `user_quotas`
- [ ] Entity: `SystemSetting`
- [ ] Entity: `AlbumLimits`
- [ ] Entity: Extend `UserQuota`
- [ ] Entity: Extend `User` with `IsAdmin`
- [ ] Service: `IQuotaSettingsService` implementation
- [ ] Middleware: `AdminAuthMiddleware`
- [ ] Controller: `AdminSettingsController`
- [ ] Controller: `AdminUsersController`
- [ ] Controller: `AdminAlbumsController`
- [ ] Controller: `AdminStatsController`
- [ ] Modify: `TusEventHandlers` for enhanced quota check
- [ ] Modify: `AlbumsController` for album count limit
- [ ] Modify: `ManifestsController` for photo/size limits
- [ ] Tests: All new functionality

### Frontend
- [ ] Routes: Admin routes with guard
- [ ] Component: `AdminLayout`
- [ ] Component: `QuotaSettingsForm`
- [ ] Component: `UserQuotaEditor`
- [ ] Component: `AlbumLimitsEditor`
- [ ] Component: `UsageProgressBar`
- [ ] Component: `AdminDashboard`
- [ ] API Client: Admin endpoints
- [ ] Hook: `useAdminAuth`
- [ ] Tests: All new components
