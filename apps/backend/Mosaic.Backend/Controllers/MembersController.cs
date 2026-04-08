using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Extensions;
using Mosaic.Backend.Logging;
using Mosaic.Backend.Middleware;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/albums/{albumId}/members")]
public class MembersController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IConfiguration _config;
    private readonly ICurrentUserService _currentUserService;
    private readonly ILogger<MembersController> _logger;

    public MembersController(MosaicDbContext db, IConfiguration config, ICurrentUserService currentUserService, ILogger<MembersController> logger)
    {
        _db = db;
        _config = config;
        _currentUserService = currentUserService;
        _logger = logger;
    }

    /// <summary>
    /// List album members
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> List(Guid albumId, [FromQuery] int skip = 0, [FromQuery] int take = 50)
    {
        skip = Math.Max(0, skip);
        take = Math.Clamp(take, 1, 100);

        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Verify access
        var accessError = await _db.RequireAlbumMemberAsync(albumId, user.Id);
        if (accessError != null) return accessError;

        var members = await _db.AlbumMembers
            .AsNoTracking()
            .Where(am => am.AlbumId == albumId)
            .Skip(skip)
            .Take(take)
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
        [MaxLength(8192)] string EncryptedKeyBundle,
        [MaxLength(256)] string OwnerSignature,
        [MaxLength(128)] string SharerPubkey,
        [MaxLength(128)] string SignPubkey
    );

    /// <summary>
    /// Request to invite a member to an album with epoch keys
    /// </summary>
    public record InviteRequest(
        Guid RecipientId,
        [MaxLength(32)] string Role,
        [MaxLength(100)] EpochKeyCreate[] EpochKeys
    );

    /// <summary>
    /// Invite a member to the album with epoch keys
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> Invite(Guid albumId, [FromBody] InviteRequest request)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Validate role
        if (!AlbumRoles.IsValidForInvite(request.Role))
        {
            return Problem(
                detail: "Role must be 'viewer' or 'editor'",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Validate epoch keys are provided
        if (request.EpochKeys == null || request.EpochKeys.Length == 0)
        {
            return Problem(
                detail: "At least one epoch key is required",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Verify caller has permission to manage members
        var (_, memberError) = await _db.RequireAlbumMemberManagerAsync(albumId, user.Id);
        if (memberError != null) return memberError;

        // Check if recipient user exists
        var targetUser = await _db.Users.FindAsync(request.RecipientId);
        if (targetUser == null)
        {
            return Problem(
                detail: "User not found",
                statusCode: StatusCodes.Status404NotFound);
        }

        // Check if already a member
        var existing = await _db.AlbumMembers
            .FirstOrDefaultAsync(am => am.AlbumId == albumId && am.UserId == request.RecipientId);

        if (existing != null && existing.RevokedAt == null)
        {
            return Problem(
                detail: "User is already a member",
                statusCode: StatusCodes.Status409Conflict);
        }

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
                    Id = Guid.CreateVersion7(),
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

            _logger.MemberAdded(request.RecipientId, albumId, request.Role, user.Id);

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
            return Problem(
                detail: "Invalid base64 encoding in epoch key data",
                statusCode: StatusCodes.Status400BadRequest);
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
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Verify ownership
        var (album, ownerError) = await _db.RequireAlbumOwnerAsync(albumId, user.Id);
        if (ownerError != null) return ownerError;

        // Cannot remove owner
        if (userId == album!.OwnerId)
        {
            return Problem(
                detail: "Cannot remove album owner",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var membership = await _db.AlbumMembers
            .FirstOrDefaultAsync(am => am.AlbumId == albumId && am.UserId == userId && am.RevokedAt == null);

        if (membership == null)
        {
            return NotFound();
        }

        membership.RevokedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        _logger.MemberRemoved(userId, albumId, user.Id);

        return NoContent();
    }
}
