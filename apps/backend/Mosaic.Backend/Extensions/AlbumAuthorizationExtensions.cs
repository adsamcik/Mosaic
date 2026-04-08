using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;

namespace Mosaic.Backend.Extensions;

/// <summary>
/// Extension methods on <see cref="MosaicDbContext"/> for common album authorization checks.
/// Each method returns a tuple of (entity, error) — callers check for a non-null error and return it.
/// </summary>
public static class AlbumAuthorizationExtensions
{
    private static async Task<(AlbumMember? Member, IActionResult? Error)> RequireAlbumRoleAsync(
        this MosaicDbContext db,
        Guid albumId,
        Guid userId,
        Func<string, bool> canAccess,
        IActionResult? notMemberResult = null)
    {
        var (member, error) = await db.GetAlbumMemberAsync(albumId, userId, notMemberResult);
        if (error != null)
        {
            return (null, error);
        }

        return canAccess(member!.Role) ? (member, null) : (null, new ForbidResult());
    }

    /// <summary>
    /// Loads the album and verifies the user is the owner.
    /// Returns (album, null) on success.
    /// Returns (null, NotFound/Forbid) on failure.
    /// </summary>
    /// <param name="notFoundResult">
    /// Override the default <see cref="NotFoundResult"/> when the album doesn't exist.
    /// Use this when the caller needs a ProblemDetails response instead.
    /// </param>
    public static async Task<(Album? Album, IActionResult? Error)> RequireAlbumOwnerAsync(
        this MosaicDbContext db, Guid albumId, Guid userId, IActionResult? notFoundResult = null)
    {
        var album = await db.Albums.FindAsync(albumId);
        if (album == null)
            return (null, notFoundResult ?? new NotFoundResult());
        if (album.OwnerId != userId)
            return (null, new ForbidResult());
        return (album, null);
    }

    /// <summary>
    /// Checks whether the user has any active membership in the album (any role).
    /// Returns null on success (access granted), or <see cref="ForbidResult"/> if not a member.
    /// </summary>
    public static async Task<IActionResult?> RequireAlbumMemberAsync(
        this MosaicDbContext db, Guid albumId, Guid userId)
    {
        var hasAccess = await db.AlbumMembers
            .AnyAsync(am => am.AlbumId == albumId && am.UserId == userId && am.RevokedAt == null);
        return hasAccess ? null : new ForbidResult();
    }

    /// <summary>
    /// Loads the active membership record for the user in the album.
    /// Returns (member, null) on success.
    /// Returns (null, Forbid) if no active membership exists.
    /// </summary>
    /// <param name="notMemberResult">
    /// Override the default <see cref="ForbidResult"/> when no membership is found.
    /// </param>
    public static async Task<(AlbumMember? Member, IActionResult? Error)> GetAlbumMemberAsync(
        this MosaicDbContext db, Guid albumId, Guid userId, IActionResult? notMemberResult = null)
    {
        var member = await db.AlbumMembers
            .AsNoTracking()
            .FirstOrDefaultAsync(am => am.AlbumId == albumId && am.UserId == userId && am.RevokedAt == null);
        if (member == null)
            return (null, notMemberResult ?? new ForbidResult());
        return (member, null);
    }

    /// <summary>
    /// Loads the active membership and verifies the user has editor or owner role
    /// (i.e. <see cref="AlbumRoles.CanUpload"/>).
    /// Returns (member, null) on success.
    /// Returns (null, Forbid) if not a member or insufficient role.
    /// </summary>
    /// <param name="notMemberResult">
    /// Override the default <see cref="ForbidResult"/> when no membership is found.
    /// </param>
    public static Task<(AlbumMember? Member, IActionResult? Error)> RequireAlbumEditorAsync(
        this MosaicDbContext db, Guid albumId, Guid userId, IActionResult? notMemberResult = null)
        => db.RequireAlbumRoleAsync(albumId, userId, AlbumRoles.CanUpload, notMemberResult);

    /// <summary>
    /// Loads the active membership and verifies the user can manage album members
    /// (i.e. <see cref="AlbumRoles.CanManageMembers"/>).
    /// Returns (member, null) on success.
    /// Returns (null, Forbid) if not a member or insufficient role.
    /// </summary>
    /// <param name="notMemberResult">
    /// Override the default <see cref="ForbidResult"/> when no membership is found.
    /// </param>
    public static Task<(AlbumMember? Member, IActionResult? Error)> RequireAlbumMemberManagerAsync(
        this MosaicDbContext db, Guid albumId, Guid userId, IActionResult? notMemberResult = null)
        => db.RequireAlbumRoleAsync(albumId, userId, AlbumRoles.CanManageMembers, notMemberResult);
}
