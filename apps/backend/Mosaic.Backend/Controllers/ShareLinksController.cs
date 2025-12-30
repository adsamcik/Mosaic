using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

#region Request/Response DTOs

/// <summary>
/// Wrapped key for a specific epoch and tier
/// </summary>
public class WrappedKeyRequest
{
    public int EpochId { get; set; }
    public int Tier { get; set; }
    public required byte[] Nonce { get; set; }
    public required byte[] EncryptedKey { get; set; }
}

/// <summary>
/// Request to create a share link
/// </summary>
public class CreateShareLinkRequest
{
    public int AccessTier { get; set; }
    public DateTimeOffset? ExpiresAt { get; set; }
    public int? MaxUses { get; set; }
    public byte[]? OwnerEncryptedSecret { get; set; }
    public required byte[] LinkId { get; set; }
    public required List<WrappedKeyRequest> WrappedKeys { get; set; }
}

/// <summary>
/// Response for share link creation and listing
/// </summary>
public class ShareLinkResponse
{
    public Guid Id { get; set; }
    public required string LinkId { get; set; }
    public int AccessTier { get; set; }
    public DateTimeOffset? ExpiresAt { get; set; }
    public int? MaxUses { get; set; }
    public int UseCount { get; set; }
    public bool IsRevoked { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// Response for share link with owner-encrypted secret (for epoch rotation)
/// </summary>
public class ShareLinkWithSecretResponse
{
    public Guid Id { get; set; }
    public required string LinkId { get; set; }
    public int AccessTier { get; set; }
    public bool IsRevoked { get; set; }
    /// <summary>
    /// Owner-encrypted link secret (null if not stored)
    /// </summary>
    public byte[]? OwnerEncryptedSecret { get; set; }
}

/// <summary>
/// Response for anonymous link access
/// </summary>
public class LinkAccessResponse
{
    public Guid AlbumId { get; set; }
    public int AccessTier { get; set; }
    public int EpochCount { get; set; }
    /// <summary>
    /// Base64-encoded encrypted album name (can be decrypted with tier key)
    /// </summary>
    public string? EncryptedName { get; set; }
}

/// <summary>
/// Response for link epoch key
/// </summary>
public class LinkEpochKeyResponse
{
    public int EpochId { get; set; }
    public int Tier { get; set; }
    public required byte[] Nonce { get; set; }
    public required byte[] EncryptedKey { get; set; }
    public string? SignPubkey { get; set; }
}

/// <summary>
/// Response for photo metadata accessed via share link
/// </summary>
public class ShareLinkPhotoResponse
{
    public Guid Id { get; set; }
    public long VersionCreated { get; set; }
    public bool IsDeleted { get; set; }
    public required byte[] EncryptedMeta { get; set; }
    public required string Signature { get; set; }
    public required string SignerPubkey { get; set; }
    public required List<Guid> ShardIds { get; set; }
}

/// <summary>
/// Request to add epoch keys to an existing share link
/// </summary>
public class AddEpochKeysRequest
{
    public required List<EpochKeyDto> EpochKeys { get; set; }
}

/// <summary>
/// Request to update share link expiration settings
/// </summary>
public record UpdateLinkExpirationRequest(DateTimeOffset? ExpiresAt, int? MaxUses);

/// <summary>
/// Epoch key data for adding to a share link
/// </summary>
public class EpochKeyDto
{
    public int EpochId { get; set; }
    public int Tier { get; set; }
    public required byte[] Nonce { get; set; }
    public required byte[] EncryptedKey { get; set; }
}

#endregion

/// <summary>
/// Controller for managing share links for anonymous album access
/// </summary>
[ApiController]
public class ShareLinksController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IConfiguration _config;
    private readonly IStorageService _storage;
    private readonly ICurrentUserService _currentUserService;

    public ShareLinksController(
        MosaicDbContext db,
        IConfiguration config,
        IStorageService storage,
        ICurrentUserService currentUserService)
    {
        _db = db;
        _config = config;
        _storage = storage;
        _currentUserService = currentUserService;
    }

    /// <summary>
    /// Convert bytes to base64url string
    /// </summary>
    private static string ToBase64Url(byte[] bytes)
    {
        return Convert.ToBase64String(bytes)
            .Replace('+', '-')
            .Replace('/', '_')
            .TrimEnd('=');
    }

    /// <summary>
    /// Convert base64url string to bytes
    /// </summary>
    private static byte[]? FromBase64Url(string base64Url)
    {
        try
        {
            // Restore base64 padding
            var base64 = base64Url
                .Replace('-', '+')
                .Replace('_', '/');
            
            switch (base64.Length % 4)
            {
                case 2: base64 += "=="; break;
                case 3: base64 += "="; break;
            }
            
            return Convert.FromBase64String(base64);
        }
        catch
        {
            return null;
        }
    }

    #region Authenticated Endpoints

    /// <summary>
    /// Create a new share link for an album (owner only)
    /// </summary>
    [HttpPost("api/albums/{albumId}/share-links")]
    public async Task<IActionResult> Create(Guid albumId, [FromBody] CreateShareLinkRequest request)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Verify album ownership
        var album = await _db.Albums.FindAsync(albumId);
        if (album == null) return NotFound(new { error = "Album not found" });
        if (album.OwnerId != user.Id) return Forbid();

        // Validate request
        if (request.AccessTier < 1 || request.AccessTier > 3)
        {
            return BadRequest(new { error = "accessTier must be 1, 2, or 3" });
        }

        if (request.LinkId == null || request.LinkId.Length != 16)
        {
            return BadRequest(new { error = "linkId must be 16 bytes" });
        }

        if (request.WrappedKeys == null || request.WrappedKeys.Count == 0)
        {
            return BadRequest(new { error = "wrappedKeys is required" });
        }

        foreach (var key in request.WrappedKeys)
        {
            if (key.Nonce == null || key.Nonce.Length != 24)
            {
                return BadRequest(new { error = "Each wrapped key must have a 24-byte nonce" });
            }
            if (key.EncryptedKey == null || key.EncryptedKey.Length == 0)
            {
                return BadRequest(new { error = "Each wrapped key must have an encryptedKey" });
            }
            if (key.Tier < 1 || key.Tier > 3)
            {
                return BadRequest(new { error = "Each wrapped key tier must be 1, 2, or 3" });
            }
        }

        if (request.ExpiresAt.HasValue && request.ExpiresAt.Value <= DateTimeOffset.UtcNow)
        {
            return BadRequest(new { error = "expiresAt must be in the future" });
        }

        if (request.MaxUses.HasValue && request.MaxUses.Value <= 0)
        {
            return BadRequest(new { error = "maxUses must be positive" });
        }

        // Check if linkId already exists
        var existingLink = await _db.ShareLinks
            .AnyAsync(sl => sl.LinkId == request.LinkId);
        if (existingLink)
        {
            return Conflict(new { error = "A link with this ID already exists" });
        }

        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
            var shareLink = new ShareLink
            {
                Id = Guid.NewGuid(),
                LinkId = request.LinkId,
                AlbumId = albumId,
                AccessTier = request.AccessTier,
                OwnerEncryptedSecret = request.OwnerEncryptedSecret,
                ExpiresAt = request.ExpiresAt,
                MaxUses = request.MaxUses,
                UseCount = 0,
                IsRevoked = false
            };
            _db.ShareLinks.Add(shareLink);

            foreach (var wrappedKey in request.WrappedKeys)
            {
                _db.LinkEpochKeys.Add(new LinkEpochKey
                {
                    Id = Guid.NewGuid(),
                    ShareLinkId = shareLink.Id,
                    EpochId = wrappedKey.EpochId,
                    Tier = wrappedKey.Tier,
                    WrappedNonce = wrappedKey.Nonce,
                    WrappedKey = wrappedKey.EncryptedKey
                });
            }

            await _db.SaveChangesAsync();
            await tx.CommitAsync();

            return Created($"/api/share-links/{shareLink.Id}", new ShareLinkResponse
            {
                Id = shareLink.Id,
                LinkId = ToBase64Url(shareLink.LinkId),
                AccessTier = shareLink.AccessTier,
                ExpiresAt = shareLink.ExpiresAt,
                MaxUses = shareLink.MaxUses,
                UseCount = shareLink.UseCount,
                IsRevoked = shareLink.IsRevoked,
                CreatedAt = shareLink.CreatedAt
            });
        }
        catch
        {
            await tx.RollbackAsync();
            throw;
        }
    }

    /// <summary>
    /// List all share links for an album (owner only)
    /// </summary>
    [HttpGet("api/albums/{albumId}/share-links")]
    public async Task<IActionResult> List(Guid albumId)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Verify album ownership
        var album = await _db.Albums.FindAsync(albumId);
        if (album == null) return NotFound(new { error = "Album not found" });
        if (album.OwnerId != user.Id) return Forbid();

        // Note: SQLite doesn't support DateTimeOffset in ORDER BY, so we order client-side
        var shareLinks = await _db.ShareLinks
            .Where(sl => sl.AlbumId == albumId)
            .ToListAsync();

        var links = shareLinks
            .OrderByDescending(sl => sl.CreatedAt)
            .Select(sl => new ShareLinkResponse
            {
                Id = sl.Id,
                LinkId = ToBase64Url(sl.LinkId),
                AccessTier = sl.AccessTier,
                ExpiresAt = sl.ExpiresAt,
                MaxUses = sl.MaxUses,
                UseCount = sl.UseCount,
                IsRevoked = sl.IsRevoked,
                CreatedAt = sl.CreatedAt
            }).ToList();

        return Ok(links);
    }

    /// <summary>
    /// List active share links with owner-encrypted secrets (owner only, for epoch rotation)
    /// </summary>
    [HttpGet("api/albums/{albumId}/share-links/with-secrets")]
    public async Task<IActionResult> ListWithSecrets(Guid albumId)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Verify album ownership
        var album = await _db.Albums.FindAsync(albumId);
        if (album == null)
        {
            return NotFound(new { error = "Album not found" });
        }
        if (album.OwnerId != user.Id)
        {
            return Forbid();
        }

        // Only return active (non-revoked, non-expired) links with stored secrets
        // Note: For SQLite compatibility, we load all links for this album and filter client-side
        // since SQLite doesn't support DateTimeOffset comparisons in LINQ queries
        var now = DateTimeOffset.UtcNow;
        var allLinks = await _db.ShareLinks
            .Where(sl => sl.AlbumId == albumId &&
                         !sl.IsRevoked &&
                         sl.OwnerEncryptedSecret != null)
            .Select(sl => new
            {
                sl.Id,
                sl.LinkId,
                sl.AccessTier,
                sl.IsRevoked,
                sl.OwnerEncryptedSecret,
                sl.ExpiresAt,
                sl.MaxUses,
                sl.UseCount
            })
            .ToListAsync();

        // Filter for non-expired links client-side
        var links = allLinks
            .Where(sl => (!sl.ExpiresAt.HasValue || sl.ExpiresAt.Value > now) &&
                         (!sl.MaxUses.HasValue || sl.UseCount < sl.MaxUses.Value))
            .Select(sl => new ShareLinkWithSecretResponse
            {
                Id = sl.Id,
                LinkId = ToBase64Url(sl.LinkId),
                AccessTier = sl.AccessTier,
                IsRevoked = sl.IsRevoked,
                OwnerEncryptedSecret = sl.OwnerEncryptedSecret
            })
            .ToList();

        return Ok(links);
    }

    /// <summary>
    /// Revoke a share link (soft delete, owner only)
    /// </summary>
    [HttpDelete("api/share-links/{id}")]
    public async Task<IActionResult> Revoke(Guid id)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        var shareLink = await _db.ShareLinks
            .Include(sl => sl.Album)
            .FirstOrDefaultAsync(sl => sl.Id == id);

        if (shareLink == null)
        {
            return NotFound(new { error = "Share link not found" });
        }
        if (shareLink.Album.OwnerId != user.Id)
        {
            return Forbid();
        }

        shareLink.IsRevoked = true;
        await _db.SaveChangesAsync();

        return NoContent();
    }

    /// <summary>
    /// Update expiration settings for a share link (owner only)
    /// </summary>
    [HttpPatch("api/albums/{albumId:guid}/share-links/{linkId}/expiration")]
    public async Task<IActionResult> UpdateLinkExpiration(Guid albumId, string linkId, [FromBody] UpdateLinkExpirationRequest request)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Verify album exists and user is owner
        var album = await _db.Albums.FindAsync(albumId);
        if (album == null) return NotFound(new { error = "Album not found" });
        if (album.OwnerId != user.Id) return Forbid();

        // Decode linkId from base64url
        var linkIdBytes = FromBase64Url(linkId);
        if (linkIdBytes == null)
        {
            return BadRequest(new { error = "Invalid linkId format" });
        }

        // Find the share link
        var shareLink = await _db.ShareLinks
            .FirstOrDefaultAsync(sl => sl.AlbumId == albumId && sl.LinkId == linkIdBytes);

        if (shareLink == null)
        {
            return NotFound(new { error = "Share link not found" });
        }

        if (shareLink.IsRevoked)
        {
            return BadRequest(new { error = "Cannot update a revoked link" });
        }

        // Validate ExpiresAt if provided and not null
        if (request.ExpiresAt.HasValue && request.ExpiresAt.Value <= DateTimeOffset.UtcNow)
        {
            return BadRequest(new { error = "expiresAt must be in the future" });
        }

        // Validate MaxUses if provided
        if (request.MaxUses.HasValue && request.MaxUses.Value <= 0)
        {
            return BadRequest(new { error = "maxUses must be positive" });
        }

        // Update expiration settings
        shareLink.ExpiresAt = request.ExpiresAt;
        shareLink.MaxUses = request.MaxUses;

        await _db.SaveChangesAsync();

        return Ok(new ShareLinkResponse
        {
            Id = shareLink.Id,
            LinkId = ToBase64Url(shareLink.LinkId),
            AccessTier = shareLink.AccessTier,
            ExpiresAt = shareLink.ExpiresAt,
            MaxUses = shareLink.MaxUses,
            UseCount = shareLink.UseCount,
            IsRevoked = shareLink.IsRevoked,
            CreatedAt = shareLink.CreatedAt
        });
    }

    /// <summary>
    /// Add epoch keys to an existing share link (owner only, for epoch rotation)
    /// </summary>
    [HttpPost("api/share-links/{id}/keys")]
    public async Task<IActionResult> AddEpochKeys(Guid id, [FromBody] AddEpochKeysRequest request)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        var shareLink = await _db.ShareLinks
            .Include(sl => sl.Album)
            .Include(sl => sl.LinkEpochKeys)
            .AsSplitQuery()
            .FirstOrDefaultAsync(sl => sl.Id == id);

        if (shareLink == null)
        {
            return NotFound(new { error = "Share link not found" });
        }
        if (shareLink.Album.OwnerId != user.Id)
        {
            return Forbid();
        }
        if (shareLink.IsRevoked)
        {
            return BadRequest(new { error = "Cannot add keys to a revoked link" });
        }

        // Validate request
        if (request.EpochKeys == null || request.EpochKeys.Count == 0)
        {
            return BadRequest(new { error = "epochKeys is required" });
        }

        foreach (var key in request.EpochKeys)
        {
            if (key.Nonce == null || key.Nonce.Length != 24)
            {
                return BadRequest(new { error = "Each epoch key must have a 24-byte nonce" });
            }
            if (key.EncryptedKey == null || key.EncryptedKey.Length == 0)
            {
                return BadRequest(new { error = "Each epoch key must have an encryptedKey" });
            }
            if (key.Tier < 1 || key.Tier > 3)
            {
                return BadRequest(new { error = "Each epoch key tier must be 1, 2, or 3" });
            }
        }

        // Check for existing epoch/tier combinations
        var existingKeys = shareLink.LinkEpochKeys
            .Select(k => (k.EpochId, k.Tier))
            .ToHashSet();

        var keysToAdd = new List<LinkEpochKey>();
        foreach (var key in request.EpochKeys)
        {
            if (existingKeys.Contains((key.EpochId, key.Tier)))
            {
                // Update existing key
                var existing = shareLink.LinkEpochKeys
                    .First(k => k.EpochId == key.EpochId && k.Tier == key.Tier);
                existing.WrappedNonce = key.Nonce;
                existing.WrappedKey = key.EncryptedKey;
            }
            else
            {
                // Add new key
                keysToAdd.Add(new LinkEpochKey
                {
                    Id = Guid.NewGuid(),
                    ShareLinkId = shareLink.Id,
                    EpochId = key.EpochId,
                    Tier = key.Tier,
                    WrappedNonce = key.Nonce,
                    WrappedKey = key.EncryptedKey
                });
            }
        }

        if (keysToAdd.Count > 0)
        {
            _db.LinkEpochKeys.AddRange(keysToAdd);
        }

        await _db.SaveChangesAsync();

        return Ok(new { added = keysToAdd.Count, updated = request.EpochKeys.Count - keysToAdd.Count });
    }

    #endregion

    #region Anonymous Endpoints

    /// <summary>
    /// Validate and access a share link (anonymous)
    /// </summary>
    [HttpGet("api/s/{linkId}")]
    public async Task<IActionResult> Access(string linkId)
    {
        var linkIdBytes = FromBase64Url(linkId);
        if (linkIdBytes == null)
        {
            return BadRequest(new { error = "Invalid link ID format" });
        }

        var shareLink = await _db.ShareLinks
            .Include(sl => sl.Album)
            .Include(sl => sl.LinkEpochKeys)
            .AsSplitQuery()
            .FirstOrDefaultAsync(sl => sl.LinkId == linkIdBytes);

        if (shareLink == null)
        {
            return NotFound(new { error = "Link not found" });
        }

        // Check if revoked
        if (shareLink.IsRevoked)
        {
            return Gone(new { error = "This link has been revoked" });
        }

        // Check if expired
        if (shareLink.ExpiresAt.HasValue && shareLink.ExpiresAt.Value <= DateTimeOffset.UtcNow)
        {
            return Gone(new { error = "This link has expired" });
        }

        // Check max uses
        if (shareLink.MaxUses.HasValue && shareLink.UseCount >= shareLink.MaxUses.Value)
        {
            return Gone(new { error = "This link has reached its maximum uses" });
        }

        // Increment use count
        shareLink.UseCount++;
        await _db.SaveChangesAsync();

        return Ok(new LinkAccessResponse
        {
            AlbumId = shareLink.AlbumId,
            AccessTier = shareLink.AccessTier,
            EpochCount = shareLink.LinkEpochKeys.Select(k => k.EpochId).Distinct().Count(),
            EncryptedName = shareLink.Album.EncryptedName
        });
    }

    /// <summary>
    /// Get epoch keys for a share link (anonymous)
    /// </summary>
    [HttpGet("api/s/{linkId}/keys")]
    public async Task<IActionResult> GetKeys(string linkId)
    {
        var linkIdBytes = FromBase64Url(linkId);
        if (linkIdBytes == null)
        {
            return BadRequest(new { error = "Invalid link ID format" });
        }

        var shareLink = await _db.ShareLinks
            .Include(sl => sl.LinkEpochKeys)
            .FirstOrDefaultAsync(sl => sl.LinkId == linkIdBytes);

        if (shareLink == null)
        {
            return NotFound(new { error = "Link not found" });
        }

        // Validate link is still valid (but don't increment use count for key fetch)
        var validationResult = ValidateShareLink(shareLink);
        if (validationResult != null) return validationResult;

        // Get sign pubkeys from epoch keys table for each epoch
        var epochIds = shareLink.LinkEpochKeys.Select(k => k.EpochId).Distinct().ToList();
        var epochSignPubkeys = await _db.EpochKeys
            .Where(ek => ek.AlbumId == shareLink.AlbumId && epochIds.Contains(ek.EpochId))
            .GroupBy(ek => ek.EpochId)
            .Select(g => new { EpochId = g.Key, SignPubkey = g.First().SignPubkey })
            .ToDictionaryAsync(x => x.EpochId, x => x.SignPubkey);

        var keys = shareLink.LinkEpochKeys
            .OrderBy(k => k.EpochId)
            .ThenBy(k => k.Tier)
            .Select(k => new LinkEpochKeyResponse
            {
                EpochId = k.EpochId,
                Tier = k.Tier,
                Nonce = k.WrappedNonce,
                EncryptedKey = k.WrappedKey,
                SignPubkey = epochSignPubkeys.TryGetValue(k.EpochId, out var pk) 
                    ? Convert.ToBase64String(pk) 
                    : null
            })
            .ToList();

        return Ok(keys);
    }

    /// <summary>
    /// Get photo metadata for a share link (anonymous)
    /// </summary>
    [HttpGet("api/s/{linkId}/photos")]
    public async Task<IActionResult> GetPhotos(string linkId)
    {
        var linkIdBytes = FromBase64Url(linkId);
        if (linkIdBytes == null)
        {
            return BadRequest(new { error = "Invalid link ID format" });
        }

        var shareLink = await _db.ShareLinks
            .FirstOrDefaultAsync(sl => sl.LinkId == linkIdBytes);

        if (shareLink == null)
        {
            return NotFound(new { error = "Link not found" });
        }

        // Validate link is still valid (but don't increment use count for photo fetch)
        var validationResult = ValidateShareLink(shareLink);
        if (validationResult != null) return validationResult;

        // Get all non-deleted manifests for the album
        var manifests = await _db.Manifests
            .Where(m => m.AlbumId == shareLink.AlbumId && !m.IsDeleted)
            .Include(m => m.ManifestShards.OrderBy(ms => ms.ChunkIndex))
            .OrderBy(m => m.VersionCreated)
            .Select(m => new ShareLinkPhotoResponse
            {
                Id = m.Id,
                VersionCreated = m.VersionCreated,
                IsDeleted = m.IsDeleted,
                EncryptedMeta = m.EncryptedMeta,
                Signature = m.Signature,
                SignerPubkey = m.SignerPubkey,
                ShardIds = m.ManifestShards.OrderBy(ms => ms.ChunkIndex).Select(ms => ms.ShardId).ToList()
            })
            .ToListAsync();

        return Ok(manifests);
    }

    /// <summary>
    /// Download a shard via share link (anonymous)
    /// </summary>
    [HttpGet("api/s/{linkId}/shards/{shardId}")]
    public async Task<IActionResult> DownloadShard(string linkId, Guid shardId)
    {
        var linkIdBytes = FromBase64Url(linkId);
        if (linkIdBytes == null)
        {
            return BadRequest(new { error = "Invalid link ID format" });
        }

        var shareLink = await _db.ShareLinks
            .FirstOrDefaultAsync(sl => sl.LinkId == linkIdBytes);

        if (shareLink == null)
        {
            return NotFound(new { error = "Link not found" });
        }

        // Validate link is still valid (but don't increment use count for shard download)
        var validationResult = ValidateShareLink(shareLink);
        if (validationResult != null)
        {
            return validationResult;
        }

        // Get the shard
        var shard = await _db.Shards.FindAsync(shardId);
        if (shard == null)
        {
            return NotFound(new { error = "Shard not found" });
        }
        if (shard.Status != ShardStatus.ACTIVE)
        {
            return NotFound(new { error = "Shard not available" });
        }

        // Verify the shard belongs to the linked album
        var shardBelongsToAlbum = await _db.ManifestShards
            .Where(ms => ms.ShardId == shardId)
            .AnyAsync(ms => ms.Manifest.AlbumId == shareLink.AlbumId && !ms.Manifest.IsDeleted);

        if (!shardBelongsToAlbum)
        {
            return Forbid();
        }

        var stream = await _storage.OpenReadAsync(shard.StorageKey);
        return File(stream, "application/octet-stream");
    }

    /// <summary>
    /// Validate that a share link is still valid (not revoked, not expired, within max uses)
    /// </summary>
    private IActionResult? ValidateShareLink(ShareLink shareLink)
    {
        if (shareLink.IsRevoked)
        {
            return Gone(new { error = "This link has been revoked" });
        }

        if (shareLink.ExpiresAt.HasValue && shareLink.ExpiresAt.Value <= DateTimeOffset.UtcNow)
        {
            return Gone(new { error = "This link has expired" });
        }

        if (shareLink.MaxUses.HasValue && shareLink.UseCount >= shareLink.MaxUses.Value)
        {
            return Gone(new { error = "This link has reached its maximum uses" });
        }

        return null;
    }

    /// <summary>
    /// Returns HTTP 410 Gone with a JSON body
    /// </summary>
    private ObjectResult Gone(object value)
    {
        return StatusCode(StatusCodes.Status410Gone, value);
    }

    #endregion
}
