using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Extensions;
using Mosaic.Backend.Models.ShareLinks;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

/// <summary>
/// Controller for managing share links (CRUD by album owners)
/// </summary>
[ApiController]
public class ShareLinksController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly ICurrentUserService _currentUserService;

    public ShareLinksController(
        MosaicDbContext db,
        ICurrentUserService currentUserService)
    {
        _db = db;
        _currentUserService = currentUserService;
    }

    /// <summary>
    /// Create a new share link for an album (owner only)
    /// </summary>
    [HttpPost("api/albums/{albumId}/share-links")]
    public async Task<IActionResult> Create(Guid albumId, [FromBody] CreateShareLinkRequest request)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Verify album ownership
        var albumNotFound = Problem(detail: "Album not found", statusCode: StatusCodes.Status404NotFound);
        var (album, ownerError) = await _db.RequireAlbumOwnerAsync(albumId, user.Id, albumNotFound);
        if (ownerError != null) return ownerError;

        // Reject creating share links for expired albums
        if (album!.ExpiresAt.HasValue && album.ExpiresAt.Value <= DateTimeOffset.UtcNow)
        {
            return Gone(new { error = "Album has expired" });
        }

        // Validate request
        if (request.AccessTier < 1 || request.AccessTier > 3)
        {
            return Problem(
                detail: "accessTier must be 1, 2, or 3",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (request.LinkId == null || request.LinkId.Length != 16)
        {
            return Problem(
                detail: "linkId must be 16 bytes",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (request.WrappedKeys == null || request.WrappedKeys.Count == 0)
        {
            return Problem(
                detail: "wrappedKeys is required",
                statusCode: StatusCodes.Status400BadRequest);
        }

        foreach (var key in request.WrappedKeys)
        {
            if (key.Nonce == null || key.Nonce.Length != 24)
            {
                return Problem(
                    detail: "Each wrapped key must have a 24-byte nonce",
                    statusCode: StatusCodes.Status400BadRequest);
            }
            if (key.EncryptedKey == null || key.EncryptedKey.Length == 0)
            {
                return Problem(
                    detail: "Each wrapped key must have an encryptedKey",
                    statusCode: StatusCodes.Status400BadRequest);
            }
            if (key.Tier < 1 || key.Tier > 3)
            {
                return Problem(
                    detail: "Each wrapped key tier must be 1, 2, or 3",
                    statusCode: StatusCodes.Status400BadRequest);
            }
        }

        if (request.ExpiresAt.HasValue && request.ExpiresAt.Value <= DateTimeOffset.UtcNow)
        {
            return Problem(
                detail: "expiresAt must be in the future",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (request.MaxUses.HasValue && request.MaxUses.Value <= 0)
        {
            return Problem(
                detail: "maxUses must be positive",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Check if linkId already exists
        var existingLink = await _db.ShareLinks
            .AnyAsync(sl => sl.LinkId == request.LinkId);
        if (existingLink)
        {
            return Problem(
                detail: "A link with this ID already exists",
                statusCode: StatusCodes.Status409Conflict);
        }

        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
            var shareLink = new ShareLink
            {
                Id = Guid.CreateVersion7(),
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
                    Id = Guid.CreateVersion7(),
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
                LinkId = Base64UrlHelper.ToBase64Url(shareLink.LinkId),
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
        var albumNotFound = Problem(detail: "Album not found", statusCode: StatusCodes.Status404NotFound);
        var (_, ownerError) = await _db.RequireAlbumOwnerAsync(albumId, user.Id, albumNotFound);
        if (ownerError != null) return ownerError;

        // Note: SQLite doesn't support DateTimeOffset in ORDER BY, so we order client-side
        var shareLinks = await _db.ShareLinks
            .AsNoTracking()
            .Where(sl => sl.AlbumId == albumId)
            .ToListAsync();

        var links = shareLinks
            .OrderByDescending(sl => sl.CreatedAt)
            .Select(sl => new ShareLinkResponse
            {
                Id = sl.Id,
                LinkId = Base64UrlHelper.ToBase64Url(sl.LinkId),
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
        var albumNotFound = Problem(detail: "Album not found", statusCode: StatusCodes.Status404NotFound);
        var (_, ownerError) = await _db.RequireAlbumOwnerAsync(albumId, user.Id, albumNotFound);
        if (ownerError != null) return ownerError;

        // Only return active (non-revoked, non-expired) links with stored secrets
        // Note: For SQLite compatibility, we load all links for this album and filter client-side
        // since SQLite doesn't support DateTimeOffset comparisons in LINQ queries
        var now = DateTimeOffset.UtcNow;
        var allLinks = await _db.ShareLinks
            .AsNoTracking()
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
                LinkId = Base64UrlHelper.ToBase64Url(sl.LinkId),
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
            return Problem(
                detail: "Share link not found",
                statusCode: StatusCodes.Status404NotFound);
        }
        if (shareLink.Album.OwnerId != user.Id)
        {
            return Problem(
                detail: "Share link not found",
                statusCode: StatusCodes.Status404NotFound);
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
        var albumNotFound = Problem(detail: "Album not found", statusCode: StatusCodes.Status404NotFound);
        var (_, ownerError) = await _db.RequireAlbumOwnerAsync(albumId, user.Id, albumNotFound);
        if (ownerError != null) return ownerError;

        // Decode linkId from base64url
        var linkIdBytes = Base64UrlHelper.FromBase64Url(linkId);
        if (linkIdBytes == null)
        {
            return Problem(
                detail: "Invalid linkId format",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Find the share link
        var shareLink = await _db.ShareLinks
            .FirstOrDefaultAsync(sl => sl.AlbumId == albumId && sl.LinkId == linkIdBytes);

        if (shareLink == null)
        {
            return Problem(
                detail: "Share link not found",
                statusCode: StatusCodes.Status404NotFound);
        }

        if (shareLink.IsRevoked)
        {
            return Problem(
                detail: "Cannot update a revoked link",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Validate ExpiresAt if provided and not null
        if (request.ExpiresAt.HasValue && request.ExpiresAt.Value <= DateTimeOffset.UtcNow)
        {
            return Problem(
                detail: "expiresAt must be in the future",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Validate MaxUses if provided
        if (request.MaxUses.HasValue && request.MaxUses.Value <= 0)
        {
            return Problem(
                detail: "maxUses must be positive",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Update expiration settings
        shareLink.ExpiresAt = request.ExpiresAt;
        shareLink.MaxUses = request.MaxUses;

        await _db.SaveChangesAsync();

        return Ok(new ShareLinkResponse
        {
            Id = shareLink.Id,
            LinkId = Base64UrlHelper.ToBase64Url(shareLink.LinkId),
            AccessTier = shareLink.AccessTier,
            ExpiresAt = shareLink.ExpiresAt,
            MaxUses = shareLink.MaxUses,
            UseCount = shareLink.UseCount,
            IsRevoked = shareLink.IsRevoked,
            CreatedAt = shareLink.CreatedAt
        });
    }

    /// <summary>
    /// Add epoch keysto an existing share link (owner only, for epoch rotation)
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
            return Problem(
                detail: "Share link not found",
                statusCode: StatusCodes.Status404NotFound);
        }
        if (shareLink.Album.OwnerId != user.Id)
        {
            return Problem(
                detail: "Share link not found",
                statusCode: StatusCodes.Status404NotFound);
        }
        if (shareLink.IsRevoked)
        {
            return Problem(
                detail: "Cannot add keys to a revoked link",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Validate request
        if (request.EpochKeys == null || request.EpochKeys.Count == 0)
        {
            return Problem(
                detail: "epochKeys is required",
                statusCode: StatusCodes.Status400BadRequest);
        }

        foreach (var key in request.EpochKeys)
        {
            if (key.Nonce == null || key.Nonce.Length != 24)
            {
                return Problem(
                    detail: "Each epoch key must have a 24-byte nonce",
                    statusCode: StatusCodes.Status400BadRequest);
            }
            if (key.EncryptedKey == null || key.EncryptedKey.Length == 0)
            {
                return Problem(
                    detail: "Each epoch key must have an encryptedKey",
                    statusCode: StatusCodes.Status400BadRequest);
            }
            if (key.Tier < 1 || key.Tier > 3)
            {
                return Problem(
                    detail: "Each epoch key tier must be 1, 2, or 3",
                    statusCode: StatusCodes.Status400BadRequest);
            }
        }

        // Check for existing epoch/tier combinations
        var existingKeys = shareLink.LinkEpochKeys
            .Select(k => (k.EpochId, k.Tier))
            .ToHashSet();

        // Use transaction to ensure atomicity of key updates
        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
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
                        Id = Guid.CreateVersion7(),
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
            await tx.CommitAsync();

            return Ok(new { added = keysToAdd.Count, updated = request.EpochKeys.Count - keysToAdd.Count });
        }
        catch
        {
            await tx.RollbackAsync();
            throw;
        }
    }
    /// <summary>
    /// Returns HTTP 410 Gone with a JSON body
    /// </summary>
    private ObjectResult Gone(object value)
    {
        return StatusCode(StatusCodes.Status410Gone, value);
    }
}