using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Logging;
using Mosaic.Backend.Middleware;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

/// <summary>
/// Request to create a new album with initial epoch key
/// </summary>
public class CreateAlbumRequest
{
    /// <summary>
    /// Initial epoch key bundle for the owner
    /// </summary>
    public required InitialEpochKeyRequest InitialEpochKey { get; set; }

    /// <summary>
    /// Base64-encoded encrypted album name (encrypted with epoch read key).
    /// Optional - if not provided, album name will not be stored.
    /// </summary>
    public string? EncryptedName { get; set; }

    /// <summary>
    /// Base64-encoded encrypted album description (encrypted with epoch read key).
    /// Optional - if not provided, album description will not be stored.
    /// </summary>
    public string? EncryptedDescription { get; set; }

    /// <summary>
    /// Optional expiration date for the album. Must be in the future if provided.
    /// </summary>
    public DateTimeOffset? ExpiresAt { get; set; }

    /// <summary>
    /// Number of days before expiration to warn members. Defaults to 7 if not provided.
    /// </summary>
    public int? ExpirationWarningDays { get; set; }
}

/// <summary>
/// Request to update album expiration settings
/// </summary>
public record UpdateExpirationRequest(DateTimeOffset? ExpiresAt, int? ExpirationWarningDays);

/// <summary>
/// Request to rename an album (update encrypted name)
/// </summary>
public record RenameAlbumRequest(string EncryptedName);

/// <summary>
/// Request to update album description
/// </summary>
public record UpdateDescriptionRequest(string? EncryptedDescription);

/// <summary>
/// Initial epoch key data for album creation
/// </summary>
public class InitialEpochKeyRequest
{
    /// <summary>
    /// Base64-encoded sealed box containing encrypted epoch key bundle
    /// </summary>
    public required byte[] EncryptedKeyBundle { get; set; }

    /// <summary>
    /// Base64-encoded Ed25519 signature from owner
    /// </summary>
    public required byte[] OwnerSignature { get; set; }

    /// <summary>
    /// Base64-encoded Ed25519 public key of sharer (owner for initial key)
    /// </summary>
    public required byte[] SharerPubkey { get; set; }

    /// <summary>
    /// Base64-encoded Ed25519 epoch signing public key
    /// </summary>
    public required byte[] SignPubkey { get; set; }
}

[ApiController]
[Route("api/albums")]
public class AlbumsController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IConfiguration _config;
    private readonly IQuotaSettingsService _quotaService;
    private readonly ICurrentUserService _currentUserService;
    private readonly ILogger<AlbumsController> _logger;

    public AlbumsController(
        MosaicDbContext db,
        IConfiguration config,
        IQuotaSettingsService quotaService,
        ICurrentUserService currentUserService,
        ILogger<AlbumsController> logger)
    {
        _db = db;
        _config = config;
        _quotaService = quotaService;
        _currentUserService = currentUserService;
        _logger = logger;
    }

    /// <summary>
    /// List all albums the user has access to
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> List()
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        var albums = await _db.AlbumMembers
            .Where(am => am.UserId == user.Id && am.RevokedAt == null)
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
            return BadRequest(new { error = "initialEpochKey is required" });
        }

        if (request.InitialEpochKey.EncryptedKeyBundle == null || request.InitialEpochKey.EncryptedKeyBundle.Length == 0)
        {
            return BadRequest(new { error = "encryptedKeyBundle is required" });
        }

        if (request.InitialEpochKey.OwnerSignature == null || request.InitialEpochKey.OwnerSignature.Length == 0)
        {
            return BadRequest(new { error = "ownerSignature is required" });
        }

        if (request.InitialEpochKey.SharerPubkey == null || request.InitialEpochKey.SharerPubkey.Length == 0)
        {
            return BadRequest(new { error = "sharerPubkey is required" });
        }

        if (request.InitialEpochKey.SignPubkey == null || request.InitialEpochKey.SignPubkey.Length == 0)
        {
            return BadRequest(new { error = "signPubkey is required" });
        }

        // Validate expiration if provided
        if (request.ExpiresAt.HasValue && request.ExpiresAt.Value <= DateTimeOffset.UtcNow)
        {
            return BadRequest(new { error = "expiresAt must be in the future" });
        }

        if (request.ExpirationWarningDays.HasValue && request.ExpirationWarningDays.Value < 0)
        {
            return BadRequest(new { error = "expirationWarningDays must be non-negative" });
        }

        // Check album count limit
        var quota = await _db.UserQuotas.FindAsync(user.Id);
        var maxAlbums = await _quotaService.GetEffectiveMaxAlbumsAsync(user.Id);
        var currentAlbumCount = quota?.CurrentAlbumCount ?? await _db.Albums.CountAsync(a => a.OwnerId == user.Id);

        if (currentAlbumCount >= maxAlbums)
        {
            _logger.AlbumCountLimitExceeded(user.Id, currentAlbumCount, maxAlbums);
            return BadRequest(new { error = "ALBUM_LIMIT_EXCEEDED", message = $"Maximum album limit ({maxAlbums}) reached" });
        }

        // Create album, member, and epoch key in single transaction
        await using var transaction = await _db.Database.BeginTransactionAsync();
        try
        {
            var album = new Album
            {
                Id = Guid.NewGuid(),
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
                Role = "owner"
            });

            // Create initial epoch key for owner
            _db.EpochKeys.Add(new EpochKey
            {
                Id = Guid.NewGuid(),
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
                album.EncryptedName,                album.EncryptedDescription,                album.ExpiresAt,
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

        var membership = await _db.AlbumMembers
            .Where(am => am.AlbumId == albumId && am.UserId == user.Id && am.RevokedAt == null)
            .FirstOrDefaultAsync();

        if (membership == null) return Forbid();

        var album = await _db.Albums.FindAsync(albumId);
        if (album == null) return NotFound();

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
            membership.Role
        });
    }

    /// <summary>
    /// Update album expiration settings (owner only)
    /// </summary>
    [HttpPatch("{albumId:guid}/expiration")]
    public async Task<IActionResult> UpdateExpiration(Guid albumId, [FromBody] UpdateExpirationRequest request)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        var album = await _db.Albums.FindAsync(albumId);
        if (album == null) return NotFound();

        // Only owner can update expiration
        if (album.OwnerId != user.Id) return Forbid();

        // Validate expiresAt if provided (null is allowed to remove expiration)
        if (request.ExpiresAt.HasValue && request.ExpiresAt.Value <= DateTimeOffset.UtcNow)
        {
            return BadRequest(new { error = "expiresAt must be in the future" });
        }

        if (request.ExpirationWarningDays.HasValue && request.ExpirationWarningDays.Value < 0)
        {
            return BadRequest(new { error = "expirationWarningDays must be non-negative" });
        }

        // Update expiration settings
        album.ExpiresAt = request.ExpiresAt;
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
        var hasAccess = await _db.AlbumMembers
            .AnyAsync(am => am.AlbumId == albumId && am.UserId == user.Id && am.RevokedAt == null);

        if (!hasAccess) return Forbid();

        var manifests = await _db.Manifests
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
                ShardIds = m.ManifestShards
                    .OrderBy(ms => ms.ChunkIndex)
                    .Select(ms => ms.ShardId)
            })
            .ToListAsync();

        var album = await _db.Albums.FindAsync(albumId);

        return Ok(new
        {
            Manifests = manifests,
            CurrentEpochId = album!.CurrentEpochId,
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

        var album = await _db.Albums.FindAsync(albumId);
        if (album == null) return NotFound();

        if (album.OwnerId != user.Id) return Forbid();

        _db.Albums.Remove(album);
        await _db.SaveChangesAsync();

        _logger.AlbumDeleted(albumId, user.Id);

        return NoContent();
    }

    /// <summary>
    /// Rename an album (update encrypted name). Members with edit access can rename.
    /// </summary>
    [HttpPatch("{albumId:guid}/name")]
    public async Task<IActionResult> Rename(Guid albumId, [FromBody] RenameAlbumRequest request)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Check membership - owner or editor can rename
        var membership = await _db.AlbumMembers
            .Where(am => am.AlbumId == albumId && am.UserId == user.Id && am.RevokedAt == null)
            .FirstOrDefaultAsync();

        if (membership == null)
        {
            return Forbid();
        }

        // Only owner and editors can rename
        if (membership.Role != "owner" && membership.Role != "editor")
        {
            return Forbid();
        }

        var album = await _db.Albums.FindAsync(albumId);
        if (album == null)
        {
            return NotFound();
        }

        // Validate encrypted name
        if (string.IsNullOrWhiteSpace(request.EncryptedName))
        {
            return BadRequest(new { error = "encryptedName is required" });
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
        var membership = await _db.AlbumMembers
            .Where(am => am.AlbumId == albumId && am.UserId == user.Id && am.RevokedAt == null)
            .FirstOrDefaultAsync();

        if (membership == null)
        {
            return Forbid();
        }

        // Only owner and editors can update description
        if (membership.Role != "owner" && membership.Role != "editor")
        {
            return Forbid();
        }

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
