using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Models.Members;
using Mosaic.Backend.Models;
using Mosaic.Backend.Models.EpochKeys;
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
        if (accessError != null)
        {
            return accessError;
        }

        var query = _db.AlbumMembers
            .AsNoTracking()
            .Where(am => am.AlbumId == albumId);

        var totalCount = await query.CountAsync();

        var members = await query
            .OrderBy(am => am.JoinedAt)
            .ThenBy(am => am.UserId)
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

        Response.AddPaginationHeaders(skip, take, totalCount);
        return Ok(PagedResult.Create(members, skip, take, totalCount));
    }



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
        if (memberError != null)
        {
            return memberError;
        }

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
        if (ownerError != null)
        {
            return ownerError;
        }

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

    /// <summary>
    /// Atomically revoke a member AND rotate the album's epoch in a single
    /// transaction.
    ///
    /// Audit "epoch-rotation High": the historical two-step flow
    /// (DELETE /members/:userId then POST /epochs/:epochId/rotate) opens
    /// a TOCTOU window where, between the two API calls, a still-active
    /// member can upload new content under the OLD epoch — which the
    /// just-removed member can decrypt because they retained their copy
    /// of the old epoch keys. This endpoint commits both writes (member
    /// revocation + epoch bump + per-member sealed bundles + share-link
    /// re-wraps) in a single DbContext transaction so either both
    /// succeed or both roll back.
    ///
    /// Validation:
    ///   - Caller must be the album owner.
    ///   - The member-being-removed cannot be the owner.
    ///   - The supplied <c>EpochKeys</c> must NOT include the
    ///     member-being-removed (they shouldn't get the new key).
    ///   - <c>EpochKeys</c> must cover every OTHER active member; the
    ///     EpochKeyRotationService rejects any recipient that is not an
    ///     active member, but here we additionally confirm coverage so a
    ///     malformed owner client cannot silently lock out members.
    ///   - <c>epochId</c> must equal <c>album.CurrentEpochId + 1</c>.
    /// </summary>
    [HttpPost("{userId}/remove-and-rotate")]
    public async Task<IActionResult> RemoveAndRotate(
        Guid albumId,
        Guid userId,
        [FromBody] RemoveAndRotateRequest request,
        [FromServices] IEpochKeyRotationService rotationService)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        var (album, ownerError) = await _db.RequireAlbumOwnerAsync(albumId, user.Id);
        if (ownerError != null)
        {
            return ownerError;
        }

        if (userId == album!.OwnerId)
        {
            return Problem(
                detail: "Cannot remove album owner",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (request.EpochId != album.CurrentEpochId + 1)
        {
            return Problem(
                detail: $"epochId must equal current epoch + 1 (current={album.CurrentEpochId}, requested={request.EpochId})",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (request.EpochKeys.Any(k => k.RecipientId == userId))
        {
            return Problem(
                detail: "epochKeys must not include the member being removed",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var membership = await _db.AlbumMembers
            .FirstOrDefaultAsync(am => am.AlbumId == albumId && am.UserId == userId && am.RevokedAt == null);

        if (membership == null)
        {
            return NotFound();
        }

        // The set of active members the rotation MUST cover is "everyone
        // who is currently active, except the person being removed and
        // (per existing policy) the album owner who is implicit in their
        // own keys". Match exactly: any uncovered member would silently
        // lose access to new uploads after rotation.
        var activeMemberIds = await _db.AlbumMembers
            .Where(am => am.AlbumId == albumId
                         && am.RevokedAt == null
                         && am.UserId != userId)
            .Select(am => am.UserId)
            .ToHashSetAsync();

        var suppliedRecipients = request.EpochKeys.Select(k => k.RecipientId).ToHashSet();
        var missing = activeMemberIds.Where(id => !suppliedRecipients.Contains(id)).ToList();
        if (missing.Count > 0)
        {
            return Problem(
                detail: $"epochKeys is missing entries for {missing.Count} still-active member(s); rotation would lock them out",
                statusCode: StatusCodes.Status400BadRequest);
        }

        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
            membership.RevokedAt = DateTime.UtcNow;

            var rotateRequest = new RotateEpochRequest(
                EpochKeys: request.EpochKeys,
                ShareLinkKeys: request.ShareLinkKeys ?? Array.Empty<ShareLinkKeyUpdateRequest>());

            var staged = await rotationService.RotateInExistingTransactionAsync(
                album,
                request.EpochId,
                rotateRequest);

            if (!staged.Success)
            {
                await tx.RollbackAsync();
                return Problem(
                    detail: staged.ErrorDetail,
                    statusCode: staged.StatusCode ?? StatusCodes.Status400BadRequest);
            }

            await _db.SaveChangesAsync();
            await tx.CommitAsync();

            _logger.MemberRemoved(userId, albumId, user.Id);

            return Created($"/api/albums/{albumId}/epochs/{request.EpochId}", new
            {
                staged.AlbumId,
                staged.EpochId,
                staged.KeyCount,
                staged.ShareLinkKeysUpdated,
                RemovedUserId = userId
            });
        }
        catch
        {
            await tx.RollbackAsync();
            throw;
        }
    }

    /// <summary>
    /// Publish an owner-signed member roster (batch C2b-2 — closes audit
    /// <c>threat-model C-3 (server-controlled member roles)</c>).
    ///
    /// The owner signs the canonical roster transcript produced by
    /// <c>mosaic_domain::canonical_member_roster_transcript_bytes</c> with
    /// the per-epoch <c>ManifestSigningSecretKey</c>; the server stores
    /// the signature, signer-epoch, and version on the Album row. The
    /// visitor client recomputes the same transcript from the album's
    /// member list and verifies the signature against the album's
    /// published epoch signing pubkey before rendering role badges — a
    /// compromised or malicious server can no longer fabricate
    /// admin/editor labels.
    ///
    /// Server-side validation (the server is NOT the authority on
    /// signature validity, but performs structural and authorization
    /// checks):
    /// - Caller must be the album owner.
    /// - <c>RosterVersion</c> must be strictly greater than the current
    ///   stored version (monotonic — prevents rollback of role changes).
    /// - <c>Signature</c> must be a valid base64 string decoding to
    ///   exactly 64 bytes (Ed25519 signature length).
    /// - <c>SignerEpochId</c> must resolve to an existing album epoch.
    /// </summary>
    [HttpPost("roster")]
    public async Task<IActionResult> PublishSignedRoster(
        Guid albumId,
        [FromBody] PublishSignedRosterRequest request)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        var (album, ownerError) = await _db.RequireAlbumOwnerAsync(albumId, user.Id);
        if (ownerError != null)
        {
            return ownerError;
        }

        if (!TryDecodeBase64(request.Signature, out var signatureBytes) || signatureBytes.Length == 0)
        {
            return Problem(
                detail: "signature must be valid base64 and non-empty",
                statusCode: StatusCodes.Status400BadRequest);
        }
        if (signatureBytes.Length != 64)
        {
            return Problem(
                detail: "signature must be a 64-byte Ed25519 signature",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Reject stale rosters: rosterVersion must strictly increase. A
        // server that accepts a lower version could be coerced into
        // serving an old roster (rollback attack on role revocations).
        if (album!.MemberRosterVersion is long currentVersion
            && request.RosterVersion <= currentVersion)
        {
            return Problem(
                detail: $"rosterVersion must strictly increase (current={currentVersion}, requested={request.RosterVersion})",
                statusCode: StatusCodes.Status409Conflict);
        }

        // SignerEpochId must resolve to an actual album epoch. We accept
        // any historical or current epoch — visitors look up the matching
        // pubkey to verify, so a stale-but-still-signed roster from an
        // earlier epoch is allowed if it's the latest published version.
        var epochExists = await _db.EpochKeys
            .AnyAsync(ek => ek.AlbumId == albumId && ek.EpochId == request.SignerEpochId);
        if (!epochExists)
        {
            return Problem(
                detail: $"signerEpochId {request.SignerEpochId} does not exist for this album",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Reject duplicate member entries — a duplicate would create role
        // ambiguity under one signature. The signed transcript already
        // rejects duplicates client-side, but defense in depth surfaces
        // bad clients early with a clear 400.
        if (request.Members.Length != request.Members.Select(m => m.UserId).Distinct().Count())
        {
            return Problem(
                detail: "duplicate userId in roster members",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Reject unknown role bytes — only the wire-pinned set is valid.
        foreach (var member in request.Members)
        {
            if (member.RoleByte is not (1 or 2 or 3))
            {
                return Problem(
                    detail: $"invalid roleByte {member.RoleByte} for member {member.UserId} (expected 1=owner, 2=editor, 3=viewer)",
                    statusCode: StatusCodes.Status400BadRequest);
            }
        }

        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
            album.MemberRosterSignature = signatureBytes;
            album.MemberRosterSignerEpochId = request.SignerEpochId;
            album.MemberRosterVersion = request.RosterVersion;
            album.UpdatedAt = DateTime.UtcNow;

            await _db.SaveChangesAsync();
            await tx.CommitAsync();

            return Ok(new
            {
                albumId,
                rosterVersion = request.RosterVersion,
                signerEpochId = request.SignerEpochId,
                memberCount = request.Members.Length,
            });
        }
        catch
        {
            await tx.RollbackAsync();
            throw;
        }
    }

    private static bool TryDecodeBase64(string? value, out byte[] bytes)
    {
        if (string.IsNullOrEmpty(value))
        {
            bytes = [];
            return false;
        }
        try
        {
            bytes = Convert.FromBase64String(value);
            return true;
        }
        catch (FormatException)
        {
            bytes = [];
            return false;
        }
    }
}
