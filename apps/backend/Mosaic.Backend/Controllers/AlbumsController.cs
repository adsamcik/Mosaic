using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Extensions;
using Mosaic.Backend.Logging;
using Mosaic.Backend.Middleware;
using Mosaic.Backend.Services;

using Mosaic.Backend.Models.Albums;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/albums")]
public class AlbumsController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IQuotaSettingsService _quotaService;
    private readonly ICurrentUserService _currentUserService;
    private readonly ILogger<AlbumsController> _logger;

    public AlbumsController(
        MosaicDbContext db,
        IQuotaSettingsService quotaService,
        ICurrentUserService currentUserService,
        ILogger<AlbumsController> logger)
    {
        _db = db;
        _quotaService = quotaService;
        _currentUserService = currentUserService;
        _logger = logger;

    }

    /// <summary>
    /// List all albums the user has access to
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] int skip = 0, [FromQuery] int take = 50)
    {
        skip = Math.Max(0, skip);
        take = Math.Clamp(take, 1, 100);

        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        var query = _db.AlbumMembers
            .AsNoTracking()
            .Where(am => am.UserId == user.Id && am.RevokedAt == null);

        var totalCount = await query.CountAsync();

        var albums = await query
            .OrderBy(am => am.Album.CreatedAt)
            .ThenBy(am => am.AlbumId)
            .Skip(skip)
            .Take(take)
            .Select(am => new
            {
                am.Album.Id,
                am.Album.OwnerId,
                am.Album.CurrentEpochId,
                am.Album.CurrentVersion,
                am.Album.CreatedAt,
                am.Album.EncryptedName,
                am.Album.EncryptedDescription,
                am.Album.ExpiresAt,
                am.Album.ExpirationWarningDays,
                am.Role
            })
            .ToListAsync();

        Response.AddPaginationHeaders(skip, take, totalCount);
        return Ok(albums);
    }

    /// <summary>
    /// Create a new album
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateAlbumRequest request)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Validate request
        if (request.InitialEpochKey == null)
        {
            return Problem(
                detail: "initialEpochKey is required",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (request.InitialEpochKey.EncryptedKeyBundle == null || request.InitialEpochKey.EncryptedKeyBundle.Length == 0)
        {
            return Problem(
                detail: "encryptedKeyBundle is required",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (request.InitialEpochKey.OwnerSignature == null || request.InitialEpochKey.OwnerSignature.Length == 0)
        {
            return Problem(
                detail: "ownerSignature is required",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (request.InitialEpochKey.SharerPubkey == null || request.InitialEpochKey.SharerPubkey.Length == 0)
        {
            return Problem(
                detail: "sharerPubkey is required",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (request.InitialEpochKey.SignPubkey == null || request.InitialEpochKey.SignPubkey.Length == 0)
        {
            return Problem(
                detail: "signPubkey is required",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Validate expiration if provided
        if (request.ExpiresAt.HasValue && request.ExpiresAt.Value <= DateTimeOffset.UtcNow)
        {
            return Problem(
                detail: "expiresAt must be in the future",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (request.ExpirationWarningDays.HasValue && request.ExpirationWarningDays.Value < 0)
        {
            return Problem(
                detail: "expirationWarningDays must be non-negative",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Create album, member, and epoch key in single transaction
        await using var transaction = await _db.Database.BeginTransactionAsync();
        try
        {
            // Check album count limit inside transaction with row locking to prevent race conditions
            var maxAlbums = await _quotaService.GetEffectiveMaxAlbumsAsync(user.Id);
            UserQuota? quota;
            if (_db.UsesLiteProvider())
            {
                quota = await _db.UserQuotas.FindAsync(user.Id);
            }
            else
            {
                quota = await _db.UserQuotas
                    .FromSqlRaw("SELECT * FROM user_quotas WHERE user_id = {0} FOR UPDATE", user.Id)
                    .FirstOrDefaultAsync();
            }
            var currentAlbumCount = quota?.CurrentAlbumCount ?? await _db.Albums.CountAsync(a => a.OwnerId == user.Id);

            if (currentAlbumCount >= maxAlbums)
            {
                _logger.AlbumCountLimitExceeded(user.Id, currentAlbumCount, maxAlbums);
                return Problem(
                    detail: $"ALBUM_LIMIT_EXCEEDED: Maximum album limit ({maxAlbums}) reached",
                    statusCode: StatusCodes.Status400BadRequest);
            }

            var album = new Album
            {
                Id = Guid.CreateVersion7(),
                OwnerId = user.Id,
                CurrentEpochId = 1,
                CurrentVersion = 1,
                EncryptedName = request.EncryptedName,
                EncryptedDescription = request.EncryptedDescription,
                ExpiresAt = request.ExpiresAt,
                ExpirationWarningDays = request.ExpirationWarningDays ?? 7
            };
            _db.Albums.Add(album);

            // Add owner as member
            _db.AlbumMembers.Add(new AlbumMember
            {
                AlbumId = album.Id,
                UserId = user.Id,
                Role = AlbumRoles.Owner
            });

            // Create initial epoch key for owner
            _db.EpochKeys.Add(new EpochKey
            {
                Id = Guid.CreateVersion7(),
                AlbumId = album.Id,
                RecipientId = user.Id,
                EpochId = 1,
                EncryptedKeyBundle = request.InitialEpochKey.EncryptedKeyBundle,
                OwnerSignature = request.InitialEpochKey.OwnerSignature,
                SharerPubkey = request.InitialEpochKey.SharerPubkey,
                SignPubkey = request.InitialEpochKey.SignPubkey
            });

            // Create album limits tracking
            _db.AlbumLimits.Add(new AlbumLimits
            {
                AlbumId = album.Id,
                CurrentPhotoCount = 0,
                CurrentSizeBytes = 0
            });

            // Update user's album count
            if (quota != null)
            {
                quota.CurrentAlbumCount++;
                quota.UpdatedAt = DateTime.UtcNow;
            }

            await _db.SaveChangesAsync();
            await transaction.CommitAsync();

            _logger.AlbumCreated(album.Id, user.Id);

            return Created($"/api/albums/{album.Id}", new
            {
                album.Id,
                album.OwnerId,
                album.CurrentEpochId,
                album.CurrentVersion,
                album.CreatedAt,
                album.EncryptedName,
                album.EncryptedDescription,
                album.ExpiresAt,
                album.ExpirationWarningDays
            });
        }
        catch
        {
            await transaction.RollbackAsync();
            throw;
        }
    }

    /// <summary>
    /// Get a single album
    /// </summary>
    [HttpGet("{albumId}")]
    public async Task<IActionResult> Get(Guid albumId)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        var (membership, memberError) = await _db.GetAlbumMemberAsync(albumId, user.Id);
        if (memberError != null) return memberError;

        var album = await _db.Albums.FindAsync(albumId);
        if (album == null)
        {
            return NotFound();
        }

        return Ok(new
        {
            album.Id,
            album.OwnerId,
            album.CurrentEpochId,
            album.CurrentVersion,
            album.CreatedAt,
            album.EncryptedName,
            album.EncryptedDescription,
            album.ExpiresAt,
            album.ExpirationWarningDays,
            membership!.Role
        });
    }

    /// <summary>
    /// Update album expiration settings (owner only)
    /// </summary>
    [HttpPatch("{albumId:guid}/expiration")]
    public async Task<IActionResult> UpdateExpiration(Guid albumId, [FromBody] UpdateExpirationRequest request)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        var (album, ownerError) = await _db.RequireAlbumOwnerAsync(albumId, user.Id);
        if (ownerError != null) return ownerError;

        // Validate expiresAt if provided (null is allowed to remove expiration)
        if (request.ExpiresAt.HasValue && request.ExpiresAt.Value <= DateTimeOffset.UtcNow)
        {
            return Problem(
                detail: "expiresAt must be in the future",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (request.ExpirationWarningDays.HasValue && request.ExpirationWarningDays.Value < 0)
        {
            return Problem(
                detail: "expirationWarningDays must be non-negative",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Update expiration settings
        album!.ExpiresAt = request.ExpiresAt;
        if (request.ExpirationWarningDays.HasValue)
        {
            album.ExpirationWarningDays = request.ExpirationWarningDays.Value;
        }
        album.UpdatedAt = DateTime.UtcNow;

        await _db.SaveChangesAsync();

        _logger.LogInformation(
            "Album expiration updated. AlbumId: {AlbumId}, ExpiresAt: {ExpiresAt}, UpdatedBy: {UserId}, CorrelationId: {CorrelationId}",
            albumId,
            album.ExpiresAt,
            user.Id,
            HttpContext.GetCorrelationId());

        return Ok(new
        {
            album.ExpiresAt,
            album.ExpirationWarningDays
        });
    }

    /// <summary>
    /// Sync album changes since a version
    /// </summary>
    [HttpGet("{albumId}/sync")]
    public async Task<IActionResult> Sync(Guid albumId, [FromQuery] long since)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Verify access
        var accessError = await _db.RequireAlbumMemberAsync(albumId, user.Id);
        if (accessError != null) return accessError;

        // Fetch album first to ensure it exists
        var album = await _db.Albums.FindAsync(albumId);
        if (album == null)
        {
            _logger.LogWarning("Sync requested for non-existent album {AlbumId}", albumId);
            return NotFound();
        }

        // Reject sync for expired albums
        if (album.ExpiresAt.HasValue && album.ExpiresAt.Value <= DateTimeOffset.UtcNow)
        {
            return StatusCode(StatusCodes.Status410Gone);
        }

        var manifests = await _db.Manifests
            .IgnoreQueryFilters()
            .AsNoTracking()
            .Where(m => m.AlbumId == albumId && m.VersionCreated > since)
            .OrderBy(m => m.VersionCreated)
            .Take(100)
            .Select(m => new
            {
                m.Id,
                m.AlbumId,
                m.VersionCreated,
                m.IsDeleted,
                m.EncryptedMeta,
                m.Signature,
                m.SignerPubkey,
                // Legacy format for backward compatibility
                ShardIds = m.ManifestShards
                    .OrderBy(ms => ms.ChunkIndex)
                    .Select(ms => ms.ShardId),
                // New format with tier info
                Shards = m.ManifestShards
                    .OrderBy(ms => ms.ChunkIndex)
                    .Select(ms => new { ms.ShardId, ms.Tier })
            })
            .ToListAsync();

        return Ok(new
        {
            Manifests = manifests,
            CurrentEpochId = album.CurrentEpochId,
            AlbumVersion = album.CurrentVersion,
            HasMore = manifests.Count == 100
        });
    }

    /// <summary>
    /// Delete an album (owner only)
    /// </summary>
    [HttpDelete("{albumId}")]
    public async Task<IActionResult> Delete(Guid albumId)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        var (album, ownerError) = await _db.RequireAlbumOwnerAsync(albumId, user.Id);
        if (ownerError != null) return ownerError;

        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
            var manifestIds = await _db.Manifests
                .IgnoreQueryFilters()
                .Where(m => m.AlbumId == albumId)
                .Select(m => m.Id)
                .ToListAsync();

            await ShardReferenceCleanup.DetachManifestShardsAsync(_db, manifestIds, DateTime.UtcNow);

            // Album count is reclaimed immediately. Storage is reclaimed when GC removes detached shards.
            var quota = await _db.UserQuotas.FindAsync(user.Id);
            if (quota != null)
            {
                quota.CurrentAlbumCount = Math.Max(0, quota.CurrentAlbumCount - 1);
                quota.UpdatedAt = DateTime.UtcNow;
            }

            _db.Albums.Remove(album!);
            await _db.SaveChangesAsync();
            await tx.CommitAsync();

            _logger.AlbumDeleted(albumId, user.Id);

            return NoContent();
        }
        catch
        {
            await tx.RollbackAsync();
            throw;
        }
    }

    /// <summary>
    /// Rename an album (update encrypted name). Members with edit access can rename.
    /// </summary>
    [HttpPatch("{albumId:guid}/name")]
    public async Task<IActionResult> Rename(Guid albumId, [FromBody] RenameAlbumRequest request)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Check membership - owner or editor can rename
        var (membership, memberError) = await _db.RequireAlbumEditorAsync(albumId, user.Id);
        if (memberError != null) return memberError;

        var album = await _db.Albums.FindAsync(albumId);
        if (album == null)
        {
            return NotFound();
        }

        // Validate encrypted name
        if (string.IsNullOrWhiteSpace(request.EncryptedName))
        {
            return Problem(
                detail: "encryptedName is required",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Update encrypted name
        album.EncryptedName = request.EncryptedName;
        album.UpdatedAt = DateTime.UtcNow;

        await _db.SaveChangesAsync();

        _logger.LogInformation(
            "Album renamed. AlbumId: {AlbumId}, RenamedBy: {UserId}, CorrelationId: {CorrelationId}",
            albumId,
            user.Id,
            HttpContext.GetCorrelationId());

        return Ok(new
        {
            album.Id,
            album.EncryptedName,
            album.UpdatedAt
        });
    }

    /// <summary>
    /// Update album description. Members with edit access can update.
    /// </summary>
    [HttpPatch("{albumId:guid}/description")]
    public async Task<IActionResult> UpdateDescription(Guid albumId, [FromBody] UpdateDescriptionRequest request)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Check membership - owner or editor can update description
        var (membership, memberError) = await _db.RequireAlbumEditorAsync(albumId, user.Id);
        if (memberError != null) return memberError;

        var album = await _db.Albums.FindAsync(albumId);
        if (album == null)
        {
            return NotFound();
        }

        // Update encrypted description (null is allowed to clear description)
        album.EncryptedDescription = request.EncryptedDescription;
        album.UpdatedAt = DateTime.UtcNow;

        await _db.SaveChangesAsync();

        _logger.LogInformation(
            "Album description updated. AlbumId: {AlbumId}, UpdatedBy: {UserId}, CorrelationId: {CorrelationId}",
            albumId,
            user.Id,
            HttpContext.GetCorrelationId());

        return Ok(new
        {
            album.Id,
            album.EncryptedDescription,
            album.UpdatedAt
        });
    }
}
