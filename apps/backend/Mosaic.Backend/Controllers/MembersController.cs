using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/albums/{albumId}/members")]
public class MembersController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IConfiguration _config;

    public MembersController(MosaicDbContext db, IConfiguration config)
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
    /// List album members
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> List(Guid albumId)
    {
        var user = await GetOrCreateUser();

        // Verify access
        var hasAccess = await _db.AlbumMembers
            .AnyAsync(am => am.AlbumId == albumId && am.UserId == user.Id && am.RevokedAt == null);

        if (!hasAccess) return Forbid();

        var members = await _db.AlbumMembers
            .Where(am => am.AlbumId == albumId)
            .Select(am => new
            {
                am.UserId,
                am.Role,
                am.JoinedAt,
                am.RevokedAt,
                am.InvitedBy
            })
            .ToListAsync();

        return Ok(members);
    }

    /// <summary>
    /// DTO for creating an epoch key during invite
    /// </summary>
    public record EpochKeyCreate(
        int EpochId,
        string EncryptedKeyBundle,
        string OwnerSignature,
        string SharerPubkey,
        string SignPubkey
    );

    /// <summary>
    /// Request to invite a member to an album with epoch keys
    /// </summary>
    public record InviteRequest(
        Guid RecipientId,
        string Role,
        EpochKeyCreate[] EpochKeys
    );

    /// <summary>
    /// Invite a member to the album with epoch keys
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> Invite(Guid albumId, [FromBody] InviteRequest request)
    {
        var user = await GetOrCreateUser();

        // Validate role
        if (request.Role != "viewer" && request.Role != "editor")
            return BadRequest("Role must be 'viewer' or 'editor'");

        // Validate epoch keys are provided
        if (request.EpochKeys == null || request.EpochKeys.Length == 0)
            return BadRequest("At least one epoch key is required");

        // Verify caller has permission to invite
        var membership = await _db.AlbumMembers
            .FirstOrDefaultAsync(am => am.AlbumId == albumId && am.UserId == user.Id && am.RevokedAt == null);

        if (membership == null) return Forbid();
        if (membership.Role != "owner" && membership.Role != "editor")
            return Forbid();

        // Check if recipient user exists
        var targetUser = await _db.Users.FindAsync(request.RecipientId);
        if (targetUser == null) return NotFound("User not found");

        // Check if already a member
        var existing = await _db.AlbumMembers
            .FirstOrDefaultAsync(am => am.AlbumId == albumId && am.UserId == request.RecipientId);

        if (existing != null && existing.RevokedAt == null)
            return Conflict("User is already a member");

        // Use transaction for atomicity
        await using var transaction = await _db.Database.BeginTransactionAsync();
        try
        {
            if (existing != null)
            {
                // Reactivate membership
                existing.RevokedAt = null;
                existing.Role = request.Role;
                existing.InvitedBy = user.Id;
                existing.JoinedAt = DateTime.UtcNow;
            }
            else
            {
                _db.AlbumMembers.Add(new AlbumMember
                {
                    AlbumId = albumId,
                    UserId = request.RecipientId,
                    Role = request.Role,
                    InvitedBy = user.Id
                });
            }

            // Insert all epoch keys for the new member
            foreach (var epochKey in request.EpochKeys)
            {
                _db.EpochKeys.Add(new EpochKey
                {
                    Id = Guid.NewGuid(),
                    AlbumId = albumId,
                    RecipientId = request.RecipientId,
                    EpochId = epochKey.EpochId,
                    EncryptedKeyBundle = Convert.FromBase64String(epochKey.EncryptedKeyBundle),
                    OwnerSignature = Convert.FromBase64String(epochKey.OwnerSignature),
                    SharerPubkey = Convert.FromBase64String(epochKey.SharerPubkey),
                    SignPubkey = Convert.FromBase64String(epochKey.SignPubkey),
                    CreatedAt = DateTime.UtcNow
                });
            }

            await _db.SaveChangesAsync();
            await transaction.CommitAsync();

            return Created($"/api/albums/{albumId}/members/{request.RecipientId}", new
            {
                albumId,
                userId = request.RecipientId,
                request.Role,
                epochKeysCount = request.EpochKeys.Length
            });
        }
        catch (FormatException)
        {
            await transaction.RollbackAsync();
            return BadRequest("Invalid base64 encoding in epoch key data");
        }
        catch
        {
            await transaction.RollbackAsync();
            throw;
        }
    }

    /// <summary>
    /// Remove a member from the album
    /// </summary>
    [HttpDelete("{userId}")]
    public async Task<IActionResult> Remove(Guid albumId, Guid userId)
    {
        var user = await GetOrCreateUser();

        // Verify ownership
        var album = await _db.Albums.FindAsync(albumId);
        if (album == null) return NotFound();
        if (album.OwnerId != user.Id) return Forbid();

        // Cannot remove owner
        if (userId == album.OwnerId) return BadRequest("Cannot remove album owner");

        var membership = await _db.AlbumMembers
            .FirstOrDefaultAsync(am => am.AlbumId == albumId && am.UserId == userId && am.RevokedAt == null);

        if (membership == null) return NotFound();

        membership.RevokedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        return NoContent();
    }
}
