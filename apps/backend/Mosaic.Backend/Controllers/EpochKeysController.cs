using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
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

    public EpochKeysController(MosaicDbContext db, ICurrentUserService currentUserService)
    {
        _db = db;
        _currentUserService = currentUserService;
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

    public record CreateEpochKeyRequest(
        Guid RecipientId,
        int EpochId,
        [MaxLength(4096)] byte[] EncryptedKeyBundle,
        [MaxLength(128)] byte[] OwnerSignature,
        [MaxLength(64)] byte[] SharerPubkey,
        [MaxLength(64)] byte[] SignPubkey
    );

    /// <summary>
    /// Create a new epoch key for a recipient
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> Create(Guid albumId, [FromBody] CreateEpochKeyRequest request)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Verify album ownership or editor role
        var (membership, memberError) = await _db.RequireAlbumEditorAsync(albumId, user.Id);
        if (memberError != null) return memberError;

        // Check recipient exists
        var recipient = await _db.Users.FindAsync(request.RecipientId);
        if (recipient == null)
        {
            return Problem(
                detail: "Recipient not found",
                statusCode: StatusCodes.Status404NotFound);
        }

        // Check for existing key (fast path - handles normal duplicates)
        var existingKey = await _db.EpochKeys
            .AnyAsync(ek =>
                ek.AlbumId == albumId &&
                ek.RecipientId == request.RecipientId &&
                ek.EpochId == request.EpochId);

        if (existingKey)
        {
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

        // Batch load data to avoid N+1 queries
        var requestedRecipientIds = request.EpochKeys.Select(k => k.RecipientId).ToHashSet();
        
        // Load all active members for this album in one query
        var activeMembers = await _db.AlbumMembers
            .Where(am => am.AlbumId == albumId && am.RevokedAt == null)
            .Select(am => am.UserId)
            .ToHashSetAsync();

        // Load all existing epoch keys for this album/epoch in one query
        var existingKeys = await _db.EpochKeys
            .Where(ek => ek.AlbumId == albumId && ek.EpochId == epochId)
            .Select(ek => ek.RecipientId)
            .ToHashSetAsync();

        // Batch load share links if needed
        Dictionary<Guid, ShareLink>? shareLinksByLinkId = null;
        if (request.ShareLinkKeys != null && request.ShareLinkKeys.Length > 0)
        {
            var shareLinkIds = request.ShareLinkKeys.Select(sl => sl.ShareLinkId).ToList();
            shareLinksByLinkId = await _db.ShareLinks
                .Include(sl => sl.LinkEpochKeys)
                .Where(sl => shareLinkIds.Contains(sl.Id) && sl.AlbumId == albumId)
                .AsSplitQuery()
                .ToDictionaryAsync(sl => sl.Id);
        }

        // Use a transaction for atomicity
        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
            // Increment album's CurrentEpochId
            album.CurrentEpochId = epochId;
            album.UpdatedAt = DateTime.UtcNow;

            // Validate and create epoch keys for all provided members
            foreach (var keyRequest in request.EpochKeys)
            {
                // Check recipient is a member (using pre-loaded data)
                if (!activeMembers.Contains(keyRequest.RecipientId))
                {
                    await tx.RollbackAsync();
                    return Problem(
                        detail: $"Recipient {keyRequest.RecipientId} is not a member of this album",
                        statusCode: StatusCodes.Status400BadRequest);
                }

                // Check for existing key (using pre-loaded data)
                if (existingKeys.Contains(keyRequest.RecipientId))
                {
                    await tx.RollbackAsync();
                    return Problem(
                        detail: $"Epoch key already exists for recipient {keyRequest.RecipientId}",
                        statusCode: StatusCodes.Status409Conflict);
                }

                var epochKey = new EpochKey
                {
                    Id = Guid.CreateVersion7(),
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
            if (request.ShareLinkKeys != null && request.ShareLinkKeys.Length > 0 && shareLinksByLinkId != null)
            {
                foreach (var linkUpdate in request.ShareLinkKeys)
                {
                    // Verify share link exists (using pre-loaded data)
                    if (!shareLinksByLinkId.TryGetValue(linkUpdate.ShareLinkId, out var shareLink))
                    {
                        await tx.RollbackAsync();
                        return Problem(
                            detail: $"Share link {linkUpdate.ShareLinkId} not found or doesn't belong to this album",
                            statusCode: StatusCodes.Status400BadRequest);
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
                            return Problem(
                                detail: "Each wrapped key must have a 24-byte nonce",
                                statusCode: StatusCodes.Status400BadRequest);
                        }
                        if (wrappedKey.EncryptedKey == null || wrappedKey.EncryptedKey.Length == 0)
                        {
                            await tx.RollbackAsync();
                            return Problem(
                                detail: "Each wrapped key must have an encryptedKey",
                                statusCode: StatusCodes.Status400BadRequest);
                        }
                        if (wrappedKey.Tier < 1 || wrappedKey.Tier > shareLink.AccessTier)
                        {
                            await tx.RollbackAsync();
                            return Problem(
                                detail: $"Wrapped key tier must be between 1 and {shareLink.AccessTier}",
                                statusCode: StatusCodes.Status400BadRequest);
                        }

                        _db.LinkEpochKeys.Add(new LinkEpochKey
                        {
                            Id = Guid.CreateVersion7(),
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
        catch (DbUpdateException ex) when (ex.InnerException?.Message.Contains("unique", StringComparison.OrdinalIgnoreCase) == true ||
                                            ex.InnerException?.Message.Contains("duplicate", StringComparison.OrdinalIgnoreCase) == true)
        {
            // Handle race condition: another request created keys for this epoch concurrently
            await tx.RollbackAsync();
            return Problem(
                detail: "Epoch keys already exist for this epoch. Another request may have created them concurrently.",
                statusCode: StatusCodes.Status409Conflict);
        }
        catch (DbUpdateConcurrencyException)
        {
            // Handle optimistic concurrency violations
            await tx.RollbackAsync();
            return Problem(
                detail: "Album was modified by another request. Please retry.",
                statusCode: StatusCodes.Status409Conflict);
        }
        catch
        {
            await tx.RollbackAsync();
            throw;
        }
    }
}
