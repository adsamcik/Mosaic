using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;

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
}

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

    public AlbumsController(MosaicDbContext db, IConfiguration config)
    {
        _db = db;
        _config = config;
    }

    private async Task<User> GetOrCreateUser()
    {
        var authSub = HttpContext.Items["AuthSub"] as string
            ?? throw new UnauthorizedAccessException();

        var user = await _db.Users.FirstOrDefaultAsync(u => u.AuthSub == authSub);
        if (user == null)
        {
            user = new User
            {
                Id = Guid.NewGuid(),
                AuthSub = authSub,
                IdentityPubkey = ""  // Set on first key upload
            };
            _db.Users.Add(user);

            // Create quota
            _db.UserQuotas.Add(new UserQuota
            {
                UserId = user.Id,
                MaxStorageBytes = _config.GetValue<long>("Quota:DefaultMaxBytes")
            });

            await _db.SaveChangesAsync();
        }
        return user;
    }

    /// <summary>
    /// List all albums the user has access to
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> List()
    {
        var user = await GetOrCreateUser();

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
        var user = await GetOrCreateUser();

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
                EncryptedName = request.EncryptedName
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

            await _db.SaveChangesAsync();
            await transaction.CommitAsync();

            return Created($"/api/albums/{album.Id}", new
            {
                album.Id,
                album.OwnerId,
                album.CurrentEpochId,
                album.CurrentVersion,
                album.CreatedAt,
                album.EncryptedName
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
        var user = await GetOrCreateUser();

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
            membership.Role
        });
    }

    /// <summary>
    /// Sync album changes since a version
    /// </summary>
    [HttpGet("{albumId}/sync")]
    public async Task<IActionResult> Sync(Guid albumId, [FromQuery] long since)
    {
        var user = await GetOrCreateUser();

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
        var user = await GetOrCreateUser();

        var album = await _db.Albums.FindAsync(albumId);
        if (album == null) return NotFound();

        if (album.OwnerId != user.Id) return Forbid();

        _db.Albums.Remove(album);
        await _db.SaveChangesAsync();

        return NoContent();
    }
}
