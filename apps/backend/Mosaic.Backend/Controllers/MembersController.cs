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

    public record AddMemberRequest(Guid UserId, string Role);

    /// <summary>
    /// Add a member to the album
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> Add(Guid albumId, [FromBody] AddMemberRequest request)
    {
        var user = await GetOrCreateUser();

        // Verify ownership
        var membership = await _db.AlbumMembers
            .FirstOrDefaultAsync(am => am.AlbumId == albumId && am.UserId == user.Id && am.RevokedAt == null);

        if (membership == null) return Forbid();
        if (membership.Role != "owner" && membership.Role != "editor")
            return Forbid();

        // Check if user exists
        var targetUser = await _db.Users.FindAsync(request.UserId);
        if (targetUser == null) return NotFound("User not found");

        // Check if already a member
        var existing = await _db.AlbumMembers
            .FirstOrDefaultAsync(am => am.AlbumId == albumId && am.UserId == request.UserId);

        if (existing != null)
        {
            if (existing.RevokedAt == null)
                return Conflict("User is already a member");

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
                UserId = request.UserId,
                Role = request.Role,
                InvitedBy = user.Id
            });
        }

        await _db.SaveChangesAsync();

        return Created($"/api/albums/{albumId}/members/{request.UserId}", new
        {
            albumId,
            request.UserId,
            request.Role
        });
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
