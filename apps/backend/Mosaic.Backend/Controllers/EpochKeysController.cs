using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Models.EpochKeys;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Extensions;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/albums/{albumId}/epoch-keys")]
public class EpochKeysController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly ICurrentUserService _currentUserService;
    private readonly IEpochKeyRotationService _epochKeyRotationService;

    public EpochKeysController(MosaicDbContext db, ICurrentUserService currentUserService, IEpochKeyRotationService epochKeyRotationService)
    {
        _db = db;
        _currentUserService = currentUserService;
        _epochKeyRotationService = epochKeyRotationService;
    }

    /// <summary>
    /// Get epoch keys for the current user in this album
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> List(Guid albumId)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Verify user has access to album
        var accessError = await _db.RequireAlbumMemberAsync(albumId, user.Id);
        if (accessError != null) return accessError;

        var keys = await _db.EpochKeys
            .AsNoTracking()
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


    /// <summary>
    /// Create a new epoch key for a recipient
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> Create(Guid albumId, [FromBody] CreateEpochKeyRequest request)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Verify album ownership or editor role
        var (member, memberError) = await _db.RequireAlbumEditorAsync(albumId, user.Id);
        if (memberError != null) return memberError;

        // Check recipient exists
        var recipient = await _db.Users.FindAsync(request.RecipientId);
        if (recipient == null)
        {
            return Problem(
                detail: "Recipient not found",
                statusCode: StatusCodes.Status404NotFound);
        }

        var (_, recipientMembershipError) = await _db.GetAlbumMemberAsync(
            albumId,
            request.RecipientId,
            Problem(
                detail: "Recipient must be an active album member",
                statusCode: StatusCodes.Status400BadRequest));

        if (recipientMembershipError != null)
        {
            return recipientMembershipError;
        }

        // Check for existing key (fast path - handles normal duplicates)
        var existingKey = await _db.EpochKeys
            .FirstOrDefaultAsync(ek =>
                ek.AlbumId == albumId &&
                ek.RecipientId == request.RecipientId &&
                ek.EpochId == request.EpochId);

        if (existingKey != null)
        {
            if (request.RecipientId == user.Id && member!.Role == AlbumRoles.Owner)
            {
                existingKey.EncryptedKeyBundle = request.EncryptedKeyBundle;
                existingKey.OwnerSignature = request.OwnerSignature;
                existingKey.SharerPubkey = request.SharerPubkey;
                existingKey.SignPubkey = request.SignPubkey;

                await _db.SaveChangesAsync();

                return Ok(new
                {
                    existingKey.Id,
                    existingKey.AlbumId,
                    existingKey.RecipientId,
                    existingKey.EpochId,
                    existingKey.CreatedAt
                });
            }

            return Problem(
                detail: "Epoch key already exists for this album/recipient/epoch",
                statusCode: StatusCodes.Status409Conflict);
        }

        var epochKey = new EpochKey
        {
            Id = Guid.CreateVersion7(),
            AlbumId = albumId,
            RecipientId = request.RecipientId,
            EpochId = request.EpochId,
            EncryptedKeyBundle = request.EncryptedKeyBundle,
            OwnerSignature = request.OwnerSignature,
            SharerPubkey = request.SharerPubkey,
            SignPubkey = request.SignPubkey
        };

        _db.EpochKeys.Add(epochKey);
        try
        {
            await _db.SaveChangesAsync();
        }
        catch (DbUpdateException)
        {
            // Handle race condition: another request created this key concurrently
            // The database unique constraint prevents duplicates even if the check above passed
            return Problem(
                detail: "Epoch key already exists for this album/recipient/epoch",
                statusCode: StatusCodes.Status409Conflict);
        }

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
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        var key = await _db.EpochKeys
            .AsNoTracking()
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
    /// Rotate to a new epoch (key rotation after member removal)
    /// </summary>
    [HttpPost("/api/albums/{albumId}/epochs/{epochId}/rotate")]
    public async Task<IActionResult> Rotate(Guid albumId, int epochId, [FromBody] RotateEpochRequest request)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Verify album ownership
        var (album, ownerError) = await _db.RequireAlbumOwnerAsync(albumId, user.Id);
        if (ownerError != null) return ownerError;

        // Validate epoch ID is greater than current
        if (epochId <= album!.CurrentEpochId)
        {
            return Problem(
                detail: $"New epoch ID must be greater than current ({album.CurrentEpochId})",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var result = await _epochKeyRotationService.RotateAsync(album, epochId, request);

        if (!result.Success)
        {
            return Problem(
                detail: result.ErrorDetail,
                statusCode: result.StatusCode);
        }

        return Created($"/api/albums/{albumId}/epochs/{epochId}", new
        {
            result.AlbumId,
            result.EpochId,
            result.KeyCount,
            result.ShareLinkKeysUpdated
        });
    }
}
