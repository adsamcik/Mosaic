# Feature Design: Link Expiration & Album Expiration

## Overview

This document describes the design for two related expiration features:

1. **Link Expiration (Enhancement)** - Improve the existing share link expiration UI and add ability to extend/modify expiration
2. **Album Expiration (New)** - Allow owners to set an expiration date on albums, after which the album and all its contents are automatically deleted

## Current State

### Share Links
- ✅ `ExpiresAt` field exists on `ShareLink` entity (nullable `DateTimeOffset`)
- ✅ Backend validates expiration and returns `410 Gone` for expired links
- ✅ Frontend `ShareLinkDialog` has expiry toggle and days input (1-365 days)
- ❌ No ability to modify expiration after link creation
- ❌ No way to extend or remove expiration

### Albums
- ❌ No `ExpiresAt` field on `Album` entity
- ❌ No expiration logic or cleanup

---

## Design: Album Expiration

### Use Cases

1. **Temporary Event Albums**: Create an album for a wedding, share with guests, auto-delete after 30 days
2. **Trial/Demo Albums**: Allow users to try the system with auto-cleanup
3. **GDPR Compliance**: Ensure data is deleted after a defined retention period
4. **Storage Management**: Encourage cleanup of old albums

### Data Model Changes

#### Album Entity Update

```csharp
// apps/backend/Mosaic.Backend/Data/Entities/Album.cs
public class Album
{
    // ... existing fields ...
    
    /// <summary>
    /// Optional expiration date. When set, the album and all its contents
    /// will be automatically deleted after this date.
    /// Null means the album never expires.
    /// </summary>
    public DateTimeOffset? ExpiresAt { get; set; }
    
    /// <summary>
    /// Number of days before expiration to send warning notifications.
    /// Default is 7 days. Only applies if ExpiresAt is set.
    /// </summary>
    public int ExpirationWarningDays { get; set; } = 7;
}
```

#### Migration

```csharp
// V{timestamp}__AddAlbumExpiration.sql
ALTER TABLE albums ADD COLUMN expires_at TIMESTAMPTZ NULL;
ALTER TABLE albums ADD COLUMN expiration_warning_days INTEGER NOT NULL DEFAULT 7;
CREATE INDEX idx_albums_expires_at ON albums(expires_at) WHERE expires_at IS NOT NULL;
```

### API Changes

#### Create Album Request

```typescript
// libs/crypto/src/types.ts
interface CreateAlbumRequest {
  encryptedName?: string;
  expiresAt?: string;  // ISO 8601 date string, optional
  expirationWarningDays?: number;  // Default: 7
}
```

#### Update Album Expiration Endpoint

```http
PATCH /api/albums/{albumId}/expiration
Authorization: Required (owner only)
Content-Type: application/json

{
  "expiresAt": "2025-06-28T00:00:00Z",  // null to remove expiration
  "expirationWarningDays": 7
}
```

Response:
```json
{
  "id": "album-uuid",
  "expiresAt": "2025-06-28T00:00:00Z",
  "expirationWarningDays": 7
}
```

#### Album Response Update

```typescript
interface AlbumResponse {
  id: string;
  ownerId: string;
  currentEpochId: number;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
  encryptedName?: string;
  expiresAt?: string;  // NEW
  expirationWarningDays?: number;  // NEW
}
```

### Backend Implementation

#### 1. GarbageCollectionService Enhancement

Add a new cleanup task to delete expired albums:

```csharp
// In GarbageCollectionService.ExecuteAsync
protected override async Task ExecuteAsync(CancellationToken stoppingToken)
{
    await Task.Delay(TimeSpan.FromMinutes(1), stoppingToken);

    while (!stoppingToken.IsCancellationRequested)
    {
        try
        {
            await CleanExpiredPendingShards();
            await CleanTrashedShards();
            await CleanExpiredAlbums();  // NEW
            await CleanExpiredShareLinks();  // NEW
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "GC cycle failed");
        }

        await Task.Delay(TimeSpan.FromHours(1), stoppingToken);
    }
}

private async Task CleanExpiredAlbums()
{
    using var scope = _services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
    var storage = scope.ServiceProvider.GetRequiredService<IStorageService>();

    var expiredAlbums = await db.Albums
        .Where(a => a.ExpiresAt != null && a.ExpiresAt <= DateTimeOffset.UtcNow)
        .Take(10)  // Process in small batches
        .ToListAsync();

    foreach (var album in expiredAlbums)
    {
        try
        {
            // Delete all shards from storage
            var shards = await db.Shards
                .Where(s => s.Photo.AlbumId == album.Id)
                .ToListAsync();

            foreach (var shard in shards)
            {
                await storage.DeleteAsync(shard.StoragePath);
            }

            // Delete album (cascades to members, manifests, epoch keys, photos, shards)
            db.Albums.Remove(album);
            await db.SaveChangesAsync();

            _logger.LogInformation("Deleted expired album {AlbumId}", album.Id);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to delete expired album {AlbumId}", album.Id);
        }
    }
}

private async Task CleanExpiredShareLinks()
{
    using var scope = _services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();

    // Permanently delete share links that have been expired for 30+ days
    var cutoff = DateTimeOffset.UtcNow.AddDays(-30);
    
    var expiredLinks = await db.ShareLinks
        .Where(sl => sl.ExpiresAt != null && sl.ExpiresAt <= cutoff)
        .Take(100)
        .ToListAsync();

    if (expiredLinks.Any())
    {
        db.ShareLinks.RemoveRange(expiredLinks);
        await db.SaveChangesAsync();
        _logger.LogInformation("Deleted {Count} long-expired share links", expiredLinks.Count);
    }
}
```

#### 2. AlbumsController Updates

```csharp
// PATCH /api/albums/{albumId}/expiration
[HttpPatch("{albumId:guid}/expiration")]
public async Task<IActionResult> UpdateExpiration(Guid albumId, UpdateExpirationRequest request)
{
    var userId = GetCurrentUserId();
    
    var album = await _db.Albums.FindAsync(albumId);
    if (album == null) return NotFound();
    if (album.OwnerId != userId) return Forbid();
    
    // Validate expiration date if set
    if (request.ExpiresAt.HasValue && request.ExpiresAt.Value <= DateTimeOffset.UtcNow)
    {
        return BadRequest(new { error = "Expiration date must be in the future" });
    }
    
    album.ExpiresAt = request.ExpiresAt;
    album.ExpirationWarningDays = request.ExpirationWarningDays ?? 7;
    album.UpdatedAt = DateTime.UtcNow;
    
    await _db.SaveChangesAsync();
    
    return Ok(new
    {
        id = album.Id,
        expiresAt = album.ExpiresAt,
        expirationWarningDays = album.ExpirationWarningDays
    });
}

public record UpdateExpirationRequest(
    DateTimeOffset? ExpiresAt,
    int? ExpirationWarningDays);
```

### Frontend Implementation

#### 1. Album Settings Component

Create a new settings section in album details:

```tsx
// apps/admin/src/components/AlbumExpirationSettings.tsx
interface Props {
  album: Album;
  onUpdate: () => void;
}

export function AlbumExpirationSettings({ album, onUpdate }: Props) {
  const [enabled, setEnabled] = useState(!!album.expiresAt);
  const [expiryDate, setExpiryDate] = useState<Date | null>(
    album.expiresAt ? new Date(album.expiresAt) : null
  );
  const [warningDays, setWarningDays] = useState(album.expirationWarningDays ?? 7);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateAlbumExpiration(album.id, {
        expiresAt: enabled ? expiryDate?.toISOString() : null,
        expirationWarningDays: warningDays
      });
      onUpdate();
    } finally {
      setSaving(false);
    }
  };

  const daysRemaining = expiryDate 
    ? Math.ceil((expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null;

  return (
    <div className="expiration-settings">
      <h3>Album Expiration</h3>
      <p className="text-muted">
        When enabled, this album and all its photos will be permanently deleted 
        after the expiration date.
      </p>
      
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Enable album expiration
      </label>
      
      {enabled && (
        <>
          <label className="form-label">
            Expiration Date
            <input
              type="date"
              value={expiryDate?.toISOString().split('T')[0] ?? ''}
              min={new Date().toISOString().split('T')[0]}
              onChange={(e) => setExpiryDate(new Date(e.target.value))}
            />
          </label>
          
          {daysRemaining !== null && daysRemaining <= 7 && (
            <div className="warning-banner">
              ⚠️ This album will be deleted in {daysRemaining} day(s)
            </div>
          )}
          
          <label className="form-label">
            Warning notification (days before)
            <input
              type="number"
              min={1}
              max={30}
              value={warningDays}
              onChange={(e) => setWarningDays(parseInt(e.target.value, 10))}
            />
          </label>
        </>
      )}
      
      <button onClick={handleSave} disabled={saving}>
        {saving ? 'Saving...' : 'Save Expiration Settings'}
      </button>
    </div>
  );
}
```

#### 2. Album List Expiration Indicator

Show expiration status in album list:

```tsx
// In AlbumCard component
{album.expiresAt && (
  <div className="expiration-badge">
    {formatExpirationBadge(album.expiresAt)}
  </div>
)}

function formatExpirationBadge(expiresAt: string): string {
  const days = Math.ceil(
    (new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );
  
  if (days <= 0) return 'Expired';
  if (days === 1) return 'Expires tomorrow';
  if (days <= 7) return `Expires in ${days} days`;
  if (days <= 30) return `Expires in ${Math.ceil(days / 7)} weeks`;
  return `Expires ${new Date(expiresAt).toLocaleDateString()}`;
}
```

---

## Design: Share Link Expiration Enhancements

### Current Limitations

1. Expiration can only be set at creation time
2. Cannot extend or remove expiration
3. No way to see all expiring links across albums
4. No confirmation when creating never-expiring links

### API Changes

#### Update Share Link Expiration

```http
PATCH /api/albums/{albumId}/share-links/{linkId}/expiration
Authorization: Required (owner only)
Content-Type: application/json

{
  "expiresAt": "2025-06-28T00:00:00Z",  // null to remove expiration
  "maxUses": 100  // optional, can also update this
}
```

### Frontend Enhancements

#### 1. Edit Expiration in ShareLinkList

Add an "Edit" action to each share link:

```tsx
// In ShareLinkList.tsx
<button onClick={() => onEditExpiration(link)}>
  Edit Expiration
</button>

// Modal for editing
<EditLinkExpirationDialog
  link={selectedLink}
  onSave={handleUpdateExpiration}
  onClose={() => setSelectedLink(null)}
/>
```

#### 2. Expiration Warning on Never-Expire Links

```tsx
// In ShareLinkDialog.tsx
{!expiryEnabled && (
  <div className="warning-banner">
    ⚠️ This link will never expire. Anyone with the link can access 
    the album indefinitely. Consider setting an expiration date.
  </div>
)}
```

#### 3. Quick Expiration Presets

```tsx
const EXPIRY_PRESETS = [
  { label: '1 hour', hours: 1 },
  { label: '24 hours', hours: 24 },
  { label: '7 days', hours: 24 * 7 },
  { label: '30 days', hours: 24 * 30 },
  { label: '1 year', hours: 24 * 365 },
  { label: 'Never', hours: null },
];

// In ShareLinkDialog
<div className="expiry-presets">
  {EXPIRY_PRESETS.map(preset => (
    <button
      key={preset.label}
      onClick={() => handlePresetSelect(preset.hours)}
      className={isSelected(preset) ? 'selected' : ''}
    >
      {preset.label}
    </button>
  ))}
</div>
```

---

## Security Considerations

### Album Expiration

1. **Owner-only**: Only album owners can set/modify expiration
2. **No extension by members**: Members cannot extend expiration
3. **Immediate enforcement**: Expired albums become inaccessible immediately
4. **Cascade deletion**: All related data (photos, shards, keys, manifests) are deleted
5. **Audit log**: Consider logging expiration deletions for accountability

### Share Link Expiration

1. **Owner-only modification**: Only album owners can modify link expiration
2. **Cannot make already-accessible links more dangerous**: Extending expiration is safe
3. **Revocation takes precedence**: A revoked link stays revoked regardless of expiration

### Warning System

1. **Owner notification**: Warn owners X days before album deletion
2. **Member notification**: Consider notifying members before deletion
3. **Cannot bypass**: No way to recover after automatic deletion

---

## Implementation Plan

### Phase 1: Backend Album Expiration
- [ ] Add `ExpiresAt` and `ExpirationWarningDays` to Album entity
- [ ] Create database migration
- [ ] Update `CreateAlbum` to accept expiration params
- [ ] Add `PATCH /api/albums/{id}/expiration` endpoint
- [ ] Update `GarbageCollectionService` to delete expired albums
- [ ] Add unit tests for all new functionality

### Phase 2: Frontend Album Expiration
- [ ] Create `AlbumExpirationSettings` component
- [ ] Add expiration badge to album list
- [ ] Update `CreateAlbumDialog` with expiration options
- [ ] Add expiration warning banner
- [ ] Add tests for new components

### Phase 3: Share Link Enhancements
- [ ] Add `PATCH /api/albums/{albumId}/share-links/{linkId}/expiration` endpoint
- [ ] Create `EditLinkExpirationDialog` component
- [ ] Add expiry presets to `ShareLinkDialog`
- [ ] Add warning for never-expiring links
- [ ] Add cleanup job for long-expired links
- [ ] Add tests

### Phase 4: Notifications (Optional Future Work)
- [ ] Add notification system for expiration warnings
- [ ] Email notifications before album deletion
- [ ] In-app notification banner

---

## Database Diagram Update

```
┌─────────────────────────────────────────┐
│                 albums                   │
├─────────────────────────────────────────┤
│ id                  uuid PK             │
│ owner_id            uuid FK → users     │
│ current_epoch_id    int                 │
│ current_version     bigint              │
│ created_at          timestamptz         │
│ updated_at          timestamptz         │
│ encrypted_name      text                │
│ expires_at          timestamptz  [NEW]  │  ← Nullable
│ expiration_warning_days  int     [NEW]  │  ← Default 7
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│              share_links                 │
├─────────────────────────────────────────┤
│ id                  uuid PK             │
│ link_id             bytea UNIQUE        │
│ album_id            uuid FK → albums    │
│ access_tier         int                 │
│ owner_encrypted_secret  bytea           │
│ expires_at          timestamptz         │  ← Already exists
│ max_uses            int                 │
│ use_count           int                 │
│ is_revoked          bool                │
│ created_at          timestamptz         │
└─────────────────────────────────────────┘
```

---

## API Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/albums` | Create album (now accepts `expiresAt`) |
| PATCH | `/api/albums/{id}/expiration` | **NEW** Update album expiration |
| GET | `/api/albums/{id}` | Get album (now returns `expiresAt`) |
| PATCH | `/api/albums/{albumId}/share-links/{linkId}/expiration` | **NEW** Update link expiration |

---

## Open Questions

1. **Notification channel**: How should we notify users of impending expiration? Email? In-app only?
2. **Grace period**: Should there be a grace period after expiration where data is recoverable?
3. **Minimum expiration**: Should we enforce a minimum expiration period (e.g., 1 day)?
4. **Shared album expiration**: Can members see the expiration date? Should they be warned?
5. **Audit logging**: Should we log automatic deletions to a separate audit table?

---

## Test Cases

### Album Expiration

1. Create album with expiration date → album has correct expiration
2. Update album expiration → expiration changes
3. Remove album expiration (set to null) → album no longer expires
4. Set past expiration date → rejected with error
5. Non-owner tries to set expiration → 403 Forbidden
6. GC job deletes expired albums → album and all content removed
7. Access expired album → appropriate error response
8. Album expires while user viewing → graceful handling

### Share Link Expiration

1. Update link expiration → expiration changes
2. Extend link expiration → link accessible longer
3. Remove link expiration → link never expires
4. Access link after expiration → 410 Gone
5. Non-owner tries to modify → 403 Forbidden
6. Expired link count → not incremented after expiration
