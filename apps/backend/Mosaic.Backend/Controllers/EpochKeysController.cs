using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/albums/{albumId}/epoch-keys")]
public class EpochKeysController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IConfiguration _config;

    public EpochKeysController(MosaicDbContext db, IConfiguration config)
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
                IdentityPubkey = ""
            };
            _db.Users.Add(user);
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
    /// Get epoch keys for the current user in this album
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> List(Guid albumId)
    {
        var user = await GetOrCreateUser();

        // Verify user has access to album
        var hasAccess = await _db.AlbumMembers
            .AnyAsync(am => am.AlbumId == albumId && am.UserId == user.Id && am.RevokedAt == null);

        if (!hasAccess)
        {
            return Forbid();
        }

        var keys = await _db.EpochKeys
            .Where(ek => ek.AlbumId == albumId && ek.RecipientId == user.Id)
            .Select(ek => new
            {
                ek.Id,
                ek.AlbumId,
                ek.EpochId,
                ek.EncryptedKeyBundle,
                ek.OwnerSignature,
                ek.SharerPubkey,
                ek.SignPubkey,
                ek.CreatedAt
            })
            .ToListAsync();

        return Ok(keys);
    }

    public record CreateEpochKeyRequest(
        Guid RecipientId,
        int EpochId,
        byte[] EncryptedKeyBundle,
        byte[] OwnerSignature,
        byte[] SharerPubkey,
        byte[] SignPubkey
    );

    /// <summary>
    /// Create a new epoch key for a recipient
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> Create(Guid albumId, [FromBody] CreateEpochKeyRequest request)
    {
        var user = await GetOrCreateUser();

        // Verify album ownership or editor role
        var membership = await _db.AlbumMembers
            .FirstOrDefaultAsync(am =>
                am.AlbumId == albumId &&
                am.UserId == user.Id &&
                am.RevokedAt == null);

        if (membership == null)
        {
            return Forbid();
        }

        if (membership.Role != "owner" && membership.Role != "editor")
        {
            return Forbid();
        }

        // Check recipient exists
        var recipient = await _db.Users.FindAsync(request.RecipientId);
        if (recipient == null)
        {
            return NotFound("Recipient not found");
        }

        // Check for existing key
        var existing = await _db.EpochKeys
            .FirstOrDefaultAsync(ek =>
                ek.AlbumId == albumId &&
                ek.RecipientId == request.RecipientId &&
                ek.EpochId == request.EpochId);

        if (existing != null)
        {
            return Conflict("Epoch key already exists for this album/recipient/epoch");
        }

        var epochKey = new EpochKey
        {
            Id = Guid.NewGuid(),
            AlbumId = albumId,
            RecipientId = request.RecipientId,
            EpochId = request.EpochId,
            EncryptedKeyBundle = request.EncryptedKeyBundle,
            OwnerSignature = request.OwnerSignature,
            SharerPubkey = request.SharerPubkey,
            SignPubkey = request.SignPubkey
        };

        _db.EpochKeys.Add(epochKey);
        await _db.SaveChangesAsync();

        return Created($"/api/albums/{albumId}/epoch-keys/{epochKey.Id}", new
        {
            epochKey.Id,
            epochKey.AlbumId,
            epochKey.RecipientId,
            epochKey.EpochId,
            epochKey.CreatedAt
        });
    }

    /// <summary>
    /// Get a specific epoch key
    /// </summary>
    [HttpGet("{keyId}")]
    public async Task<IActionResult> Get(Guid albumId, Guid keyId)
    {
        var user = await GetOrCreateUser();

        var key = await _db.EpochKeys
            .FirstOrDefaultAsync(ek => ek.Id == keyId && ek.AlbumId == albumId);
        if (key == null)
        {
            return NotFound();
        }

        // Only recipient can view
        if (key.RecipientId != user.Id)
        {
            return Forbid();
        }

        return Ok(new
        {
            key.Id,
            key.AlbumId,
            key.EpochId,
            key.EncryptedKeyBundle,
            key.OwnerSignature,
            key.SharerPubkey,
            key.SignPubkey,
            key.CreatedAt
        });
    }

    /// <summary>
    /// Wrapped key for a share link at a specific tier
    /// </summary>
    public record ShareLinkWrappedKeyRequest(
        int Tier,
        byte[] Nonce,
        byte[] EncryptedKey
    );

    /// <summary>
    /// Updated wrapped keys for a single share link
    /// </summary>
    public record ShareLinkKeyUpdateRequest(
        Guid ShareLinkId,
        ShareLinkWrappedKeyRequest[] WrappedKeys
    );

    public record RotateEpochRequest(
        CreateEpochKeyRequest[] EpochKeys,
        ShareLinkKeyUpdateRequest[]? ShareLinkKeys = null
    );

    /// <summary>
    /// Rotate to a new epoch (key rotation after member removal)
    /// </summary>
    [HttpPost("/api/albums/{albumId}/epochs/{epochId}/rotate")]
    public async Task<IActionResult> Rotate(Guid albumId, int epochId, [FromBody] RotateEpochRequest request)
    {
        var user = await GetOrCreateUser();

        // Verify album ownership
        var album = await _db.Albums.FindAsync(albumId);
        if (album == null)
        {
            return NotFound();
        }

        if (album.OwnerId != user.Id)
        {
            return Forbid();
        }

        // Validate epoch ID is greater than current
        if (epochId <= album.CurrentEpochId)
        {
            return BadRequest($"New epoch ID must be greater than current ({album.CurrentEpochId})");
        }

        // Use a transaction for atomicity
        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
            // Increment album's CurrentEpochId
            album.CurrentEpochId = epochId;
            album.UpdatedAt = DateTime.UtcNow;

            // Create epoch keys for all provided members
            foreach (var keyRequest in request.EpochKeys)
            {
                // Check recipient exists and is a member
                var isMember = await _db.AlbumMembers
                    .AnyAsync(am => am.AlbumId == albumId &&
                                   am.UserId == keyRequest.RecipientId &&
                                   am.RevokedAt == null);

                if (!isMember)
                {
                    await tx.RollbackAsync();
                    return BadRequest($"Recipient {keyRequest.RecipientId} is not a member of this album");
                }

                // Check for existing key
                var existing = await _db.EpochKeys
                    .FirstOrDefaultAsync(ek =>
                        ek.AlbumId == albumId &&
                        ek.RecipientId == keyRequest.RecipientId &&
                        ek.EpochId == epochId);

                if (existing != null)
                {
                    await tx.RollbackAsync();
                    return Conflict($"Epoch key already exists for recipient {keyRequest.RecipientId}");
                }

                var epochKey = new EpochKey
                {
                    Id = Guid.NewGuid(),
                    AlbumId = albumId,
                    RecipientId = keyRequest.RecipientId,
                    EpochId = epochId,
                    EncryptedKeyBundle = keyRequest.EncryptedKeyBundle,
                    OwnerSignature = keyRequest.OwnerSignature,
                    SharerPubkey = keyRequest.SharerPubkey,
                    SignPubkey = keyRequest.SignPubkey
                };

                _db.EpochKeys.Add(epochKey);
            }

            // Update share link wrapped keys if provided
            var shareLinkKeysUpdated = 0;
            if (request.ShareLinkKeys != null && request.ShareLinkKeys.Length > 0)
            {
                foreach (var linkUpdate in request.ShareLinkKeys)
                {
                    // Verify share link exists and belongs to this album
                    var shareLink = await _db.ShareLinks
                        .Include(sl => sl.LinkEpochKeys)
                        .FirstOrDefaultAsync(sl => sl.Id == linkUpdate.ShareLinkId && sl.AlbumId == albumId);

                    if (shareLink == null)
                    {
                        await tx.RollbackAsync();
                        return BadRequest($"Share link {linkUpdate.ShareLinkId} not found or doesn't belong to this album");
                    }

                    // Verify link is not revoked
                    if (shareLink.IsRevoked)
                    {
                        continue; // Skip revoked links
                    }

                    // Add new wrapped keys for the new epoch
                    foreach (var wrappedKey in linkUpdate.WrappedKeys)
                    {
                        if (wrappedKey.Nonce == null || wrappedKey.Nonce.Length != 24)
                        {
                            await tx.RollbackAsync();
                            return BadRequest("Each wrapped key must have a 24-byte nonce");
                        }
                        if (wrappedKey.EncryptedKey == null || wrappedKey.EncryptedKey.Length == 0)
                        {
                            await tx.RollbackAsync();
                            return BadRequest("Each wrapped key must have an encryptedKey");
                        }
                        if (wrappedKey.Tier < 1 || wrappedKey.Tier > shareLink.AccessTier)
                        {
                            await tx.RollbackAsync();
                            return BadRequest($"Wrapped key tier must be between 1 and {shareLink.AccessTier}");
                        }

                        _db.LinkEpochKeys.Add(new LinkEpochKey
                        {
                            Id = Guid.NewGuid(),
                            ShareLinkId = shareLink.Id,
                            EpochId = epochId,
                            Tier = wrappedKey.Tier,
                            WrappedNonce = wrappedKey.Nonce,
                            WrappedKey = wrappedKey.EncryptedKey
                        });
                    }
                    shareLinkKeysUpdated++;
                }
            }

            await _db.SaveChangesAsync();
            await tx.CommitAsync();

            return Created($"/api/albums/{albumId}/epochs/{epochId}", new
            {
                AlbumId = albumId,
                EpochId = epochId,
                KeyCount = request.EpochKeys.Length,
                ShareLinkKeysUpdated = shareLinkKeysUpdated
            });
        }
        catch
        {
            await tx.RollbackAsync();
            throw;
        }
    }
}
