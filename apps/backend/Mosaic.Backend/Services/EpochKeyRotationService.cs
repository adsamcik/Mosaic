using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;

namespace Mosaic.Backend.Services;

/// <summary>
/// Result of an epoch key rotation operation.
/// </summary>
public sealed class EpochRotationResult
{
    public bool Success { get; init; }
    public int? StatusCode { get; init; }
    public string? ErrorDetail { get; init; }
    public Guid AlbumId { get; init; }
    public int EpochId { get; init; }
    public int KeyCount { get; init; }
    public int ShareLinkKeysUpdated { get; init; }
}

/// <summary>
/// Handles the business logic for epoch key rotation after member removal.
/// </summary>
public interface IEpochKeyRotationService
{
    /// <summary>
    /// Rotates to a new epoch, creating epoch keys for all members and updating share link keys.
    /// Runs inside a transaction for atomicity.
    /// </summary>
    Task<EpochRotationResult> RotateAsync(
        Album album,
        int epochId,
        EpochKeysController.RotateEpochRequest request);
}

public class EpochKeyRotationService : IEpochKeyRotationService
{
    private readonly MosaicDbContext _db;

    public EpochKeyRotationService(MosaicDbContext db)
    {
        _db = db;
    }

    public async Task<EpochRotationResult> RotateAsync(
        Album album,
        int epochId,
        EpochKeysController.RotateEpochRequest request)
    {
        var albumId = album.Id;

        // Batch load data to avoid N+1 queries
        var activeMembers = await _db.AlbumMembers
            .Where(am => am.AlbumId == albumId && am.RevokedAt == null)
            .Select(am => am.UserId)
            .ToHashSetAsync();

        var existingKeys = await _db.EpochKeys
            .Where(ek => ek.AlbumId == albumId && ek.EpochId == epochId)
            .Select(ek => ek.RecipientId)
            .ToHashSetAsync();

        // Batch load share links if needed
        Dictionary<Guid, ShareLink>? shareLinksByLinkId = null;
        if (request.ShareLinkKeys is { Length: > 0 })
        {
            var shareLinkIds = request.ShareLinkKeys.Select(sl => sl.ShareLinkId).ToList();
            shareLinksByLinkId = await _db.ShareLinks
                .Include(sl => sl.LinkEpochKeys)
                .Where(sl => shareLinkIds.Contains(sl.Id) && sl.AlbumId == albumId)
                .AsSplitQuery()
                .ToDictionaryAsync(sl => sl.Id);
        }

        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
            album.CurrentEpochId = epochId;
            album.UpdatedAt = DateTime.UtcNow;

            var memberKeysError = ValidateMemberKeys(request.EpochKeys, activeMembers, existingKeys);
            if (memberKeysError != null)
                return memberKeysError;

            AddMemberKeys(albumId, epochId, request.EpochKeys);

            var (shareLinkKeysUpdated, shareLinkError) =
                ValidateAndAddShareLinkKeys(epochId, request.ShareLinkKeys, shareLinksByLinkId);
            if (shareLinkError != null)
                return shareLinkError;

            await _db.SaveChangesAsync();
            await tx.CommitAsync();

            return new EpochRotationResult
            {
                Success = true,
                AlbumId = albumId,
                EpochId = epochId,
                KeyCount = request.EpochKeys.Length,
                ShareLinkKeysUpdated = shareLinkKeysUpdated
            };
        }
        catch (DbUpdateException ex) when (
            ex.InnerException?.Message.Contains("unique", StringComparison.OrdinalIgnoreCase) == true ||
            ex.InnerException?.Message.Contains("duplicate", StringComparison.OrdinalIgnoreCase) == true)
        {
            await tx.RollbackAsync();
            return new EpochRotationResult
            {
                Success = false,
                StatusCode = StatusCodes.Status409Conflict,
                ErrorDetail = "Epoch keys already exist for this epoch. Another request may have created them concurrently."
            };
        }
        catch (DbUpdateConcurrencyException)
        {
            await tx.RollbackAsync();
            return new EpochRotationResult
            {
                Success = false,
                StatusCode = StatusCodes.Status409Conflict,
                ErrorDetail = "Album was modified by another request. Please retry."
            };
        }
        catch
        {
            await tx.RollbackAsync();
            throw;
        }
    }

    private static EpochRotationResult? ValidateMemberKeys(
        EpochKeysController.CreateEpochKeyRequest[] epochKeys,
        HashSet<Guid> activeMembers,
        HashSet<Guid> existingKeys)
    {
        foreach (var keyRequest in epochKeys)
        {
            if (!activeMembers.Contains(keyRequest.RecipientId))
            {
                return new EpochRotationResult
                {
                    Success = false,
                    StatusCode = StatusCodes.Status400BadRequest,
                    ErrorDetail = $"Recipient {keyRequest.RecipientId} is not a member of this album"
                };
            }

            if (existingKeys.Contains(keyRequest.RecipientId))
            {
                return new EpochRotationResult
                {
                    Success = false,
                    StatusCode = StatusCodes.Status409Conflict,
                    ErrorDetail = $"Epoch key already exists for recipient {keyRequest.RecipientId}"
                };
            }
        }

        return null;
    }

    private void AddMemberKeys(Guid albumId, int epochId, EpochKeysController.CreateEpochKeyRequest[] epochKeys)
    {
        foreach (var keyRequest in epochKeys)
        {
            _db.EpochKeys.Add(new EpochKey
            {
                Id = Guid.CreateVersion7(),
                AlbumId = albumId,
                RecipientId = keyRequest.RecipientId,
                EpochId = epochId,
                EncryptedKeyBundle = keyRequest.EncryptedKeyBundle,
                OwnerSignature = keyRequest.OwnerSignature,
                SharerPubkey = keyRequest.SharerPubkey,
                SignPubkey = keyRequest.SignPubkey
            });
        }
    }

    private (int Updated, EpochRotationResult? Error) ValidateAndAddShareLinkKeys(
        int epochId,
        EpochKeysController.ShareLinkKeyUpdateRequest[]? shareLinkKeys,
        Dictionary<Guid, ShareLink>? shareLinksByLinkId)
    {
        if (shareLinkKeys is not { Length: > 0 } || shareLinksByLinkId == null)
            return (0, null);

        var updated = 0;
        foreach (var linkUpdate in shareLinkKeys)
        {
            if (!shareLinksByLinkId.TryGetValue(linkUpdate.ShareLinkId, out var shareLink))
            {
                return (0, new EpochRotationResult
                {
                    Success = false,
                    StatusCode = StatusCodes.Status400BadRequest,
                    ErrorDetail = $"Share link {linkUpdate.ShareLinkId} not found or doesn't belong to this album"
                });
            }

            if (shareLink.IsRevoked)
                continue;

            foreach (var wrappedKey in linkUpdate.WrappedKeys)
            {
                if (wrappedKey.Nonce == null || wrappedKey.Nonce.Length != 24)
                {
                    return (0, new EpochRotationResult
                    {
                        Success = false,
                        StatusCode = StatusCodes.Status400BadRequest,
                        ErrorDetail = "Each wrapped key must have a 24-byte nonce"
                    });
                }

                if (wrappedKey.EncryptedKey == null || wrappedKey.EncryptedKey.Length == 0)
                {
                    return (0, new EpochRotationResult
                    {
                        Success = false,
                        StatusCode = StatusCodes.Status400BadRequest,
                        ErrorDetail = "Each wrapped key must have an encryptedKey"
                    });
                }

                if (wrappedKey.Tier < 1 || wrappedKey.Tier > shareLink.AccessTier)
                {
                    return (0, new EpochRotationResult
                    {
                        Success = false,
                        StatusCode = StatusCodes.Status400BadRequest,
                        ErrorDetail = $"Wrapped key tier must be between 1 and {shareLink.AccessTier}"
                    });
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

            updated++;
        }

        return (updated, null);
    }
}
