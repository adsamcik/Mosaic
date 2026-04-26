using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Extensions;
using Mosaic.Backend.Models.ShareLinks;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

/// <summary>
/// Controller for anonymous/public share link access endpoints
/// </summary>
[ApiController]
public class ShareLinkAccessController : ControllerBase
{
    private static readonly TimeSpan GrantLifetime = TimeSpan.FromMinutes(5);
    private const int MaxGrantValidationCandidates = 8;

    private readonly MosaicDbContext _db;
    private readonly IStorageService _storage;

    public ShareLinkAccessController(
        MosaicDbContext db,
        IConfiguration config,
        IStorageService storage)
    {
        _db = db;
        _storage = storage;
        _ = config;
    }

    private static byte[] HashGrantToken(string token)
    {
        return SHA256.HashData(Encoding.UTF8.GetBytes(token));
    }

    private async Task<string> CreateGrantTokenAsync(ShareLink shareLink, CancellationToken cancellationToken)
    {
        var rawToken = Base64UrlHelper.ToBase64Url(RandomNumberGenerator.GetBytes(32));
        _db.ShareLinkGrants.Add(new ShareLinkGrant
        {
            Id = Guid.CreateVersion7(),
            ShareLinkId = shareLink.Id,
            TokenHash = HashGrantToken(rawToken),
            GrantedUseCount = shareLink.UseCount,
            ExpiresAt = DateTimeOffset.UtcNow.Add(GrantLifetime)
        });

        var staleGrants = await _db.ShareLinkGrants
            .Where(g => g.ShareLinkId == shareLink.Id && g.GrantedUseCount < shareLink.UseCount)
            .ToListAsync(cancellationToken);
        if (staleGrants.Count > 0)
        {
            _db.ShareLinkGrants.RemoveRange(staleGrants);
        }

        return rawToken;
    }

    private async Task<bool> IsGrantValidAsync(ShareLink shareLink, string? token, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return false;
        }

        var tokenHash = HashGrantToken(token);
        var now = DateTimeOffset.UtcNow;

        var grants = await _db.ShareLinkGrants
            .AsNoTracking()
            .Where(
                grant => grant.ShareLinkId == shareLink.Id
                    && grant.GrantedUseCount == shareLink.UseCount
                    && grant.ExpiresAt > now)
            .OrderByDescending(grant => grant.CreatedAt)
            .Take(MaxGrantValidationCandidates)
            .ToListAsync(cancellationToken);

        var isValid = false;
        foreach (var grant in grants)
        {
            isValid |= CryptographicOperations.FixedTimeEquals(grant.TokenHash, tokenHash);
        }

        return isValid;
    }

    /// <summary>
    /// Validate and access a share link (anonymous)
    /// </summary>
    [HttpGet("api/s/{linkId}")]
    public async Task<IActionResult> Access(string linkId)
    {
        var linkIdBytes = Base64UrlHelper.FromBase64Url(linkId);
        if (linkIdBytes == null)
        {
            return Problem(
                detail: "Invalid link ID format",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var shareLink = await _db.ShareLinks
            .AsNoTracking()
            .Include(sl => sl.Album)
            .Include(sl => sl.LinkEpochKeys)
            .AsSplitQuery()
            .FirstOrDefaultAsync(sl => sl.LinkId == linkIdBytes);

        if (shareLink == null)
        {
            return Problem(
                detail: "Link not found",
                statusCode: StatusCodes.Status404NotFound);
        }

        // Check if revoked
        if (shareLink.IsRevoked)
        {
            return Gone(new { error = "This link has been revoked" });
        }

        // Check if album has expired
        if (shareLink.Album.ExpiresAt.HasValue && shareLink.Album.ExpiresAt.Value <= DateTimeOffset.UtcNow)
        {
            return Gone(new { error = "Album has expired" });
        }

        // Check if expired
        if (shareLink.ExpiresAt.HasValue && shareLink.ExpiresAt.Value <= DateTimeOffset.UtcNow)
        {
            return Gone(new { error = "This link has expired" });
        }

        string? grantToken = null;

        await using var tx = await _db.Database.BeginTransactionAsync();
        ShareLink trackedLink;

        if (_db.UsesLiteProvider())
        {
            trackedLink = await _db.ShareLinks.FirstAsync(sl => sl.Id == shareLink.Id);
        }
        else
        {
            trackedLink = await _db.ShareLinks
                .FromSqlRaw("SELECT * FROM share_links WHERE id = {0} FOR UPDATE", shareLink.Id)
                .FirstAsync();
        }

        if (trackedLink.IsRevoked)
        {
            return Gone(new { error = "This link has been revoked" });
        }
        if (trackedLink.MaxUses.HasValue && trackedLink.UseCount >= trackedLink.MaxUses.Value)
        {
            return Gone(new { error = "This link has reached its maximum uses" });
        }

        trackedLink.UseCount++;
        if (trackedLink.MaxUses.HasValue)
        {
            grantToken = await CreateGrantTokenAsync(trackedLink, HttpContext.RequestAborted);
        }

        await _db.SaveChangesAsync(HttpContext.RequestAborted);
        await tx.CommitAsync(HttpContext.RequestAborted);

        shareLink.UseCount = trackedLink.UseCount;

        return Ok(new LinkAccessResponse
        {
            AlbumId = shareLink.AlbumId,
            AccessTier = shareLink.AccessTier,
            EpochCount = shareLink.LinkEpochKeys.Select(k => k.EpochId).Distinct().Count(),
            EncryptedName = shareLink.Album.EncryptedName,
            GrantToken = grantToken
        });
    }

    /// <summary>
    /// Get epoch keys for a share link (anonymous)
    /// </summary>
    [HttpGet("api/s/{linkId}/keys")]
    public async Task<IActionResult> GetKeys(string linkId)
    {
        var linkIdBytes = Base64UrlHelper.FromBase64Url(linkId);
        if (linkIdBytes == null)
        {
            return Problem(
                detail: "Invalid link ID format",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var shareLink = await _db.ShareLinks
            .Include(sl => sl.Album)
            .Include(sl => sl.LinkEpochKeys)
            .AsSplitQuery()
            .FirstOrDefaultAsync(sl => sl.LinkId == linkIdBytes);

        if (shareLink == null)
        {
            return Problem(
                detail: "Link not found",
                statusCode: StatusCodes.Status404NotFound);
        }

        var validationResult = ValidateShareLink(shareLink);
        if (validationResult != null)
        {
            return validationResult;
        }

        // Require a valid access grant when the link has a MaxUses limit.
        if (shareLink.MaxUses.HasValue)
        {
            var grantToken = Request.Headers["X-Share-Grant"].FirstOrDefault();
            if (!await IsGrantValidAsync(shareLink, grantToken, HttpContext.RequestAborted))
            {
                return Problem(
                    detail: "Valid access grant required for limited-use links. Call GET /api/s/{linkId} first to obtain a grant token, then pass it via the X-Share-Grant header.",
                    statusCode: StatusCodes.Status401Unauthorized);
            }
        }

        // Get sign pubkeys from epoch keys table for each epoch
        var epochIds = shareLink.LinkEpochKeys.Select(k => k.EpochId).Distinct().ToList();
        var epochSignPubkeys = await _db.EpochKeys
            .AsNoTracking()
            .Where(ek => ek.AlbumId == shareLink.AlbumId && epochIds.Contains(ek.EpochId))
            .GroupBy(ek => ek.EpochId)
            .Select(g => new { EpochId = g.Key, SignPubkey = g.First().SignPubkey })
            .ToDictionaryAsync(x => x.EpochId, x => x.SignPubkey);

        var keys = shareLink.LinkEpochKeys
            .Where(k => k.Tier <= shareLink.AccessTier)
            .OrderBy(k => k.EpochId)
            .ThenBy(k => k.Tier)
            .Select(k => new LinkEpochKeyResponse
            {
                EpochId = k.EpochId,
                Tier = k.Tier,
                Nonce = k.WrappedNonce,
                EncryptedKey = k.WrappedKey,
                SignPubkey = epochSignPubkeys.TryGetValue(k.EpochId, out var pk)
                    ? Convert.ToBase64String(pk)
                    : null
            })
            .ToList();

        return Ok(keys);
    }

    /// <summary>
    /// Get photo metadata for a share link (anonymous)
    /// </summary>
    [HttpGet("api/s/{linkId}/photos")]
    public async Task<IActionResult> GetPhotos(string linkId, [FromQuery] int skip = 0, [FromQuery] int take = 50)
    {
        skip = Math.Max(0, skip);
        take = Math.Clamp(take, 1, 100);

        var linkIdBytes = Base64UrlHelper.FromBase64Url(linkId);
        if (linkIdBytes == null)
        {
            return Problem(
                detail: "Invalid link ID format",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var shareLink = await _db.ShareLinks
            .AsNoTracking()
            .Include(sl => sl.Album)
            .FirstOrDefaultAsync(sl => sl.LinkId == linkIdBytes);

        if (shareLink == null)
        {
            return Problem(
                detail: "Link not found",
                statusCode: StatusCodes.Status404NotFound);
        }

        var validationResult = ValidateShareLink(shareLink);
        if (validationResult != null)
        {
            return validationResult;
        }

        // Require a valid access grant when the link has a MaxUses limit.
        if (shareLink.MaxUses.HasValue)
        {
            var grantToken = Request.Headers["X-Share-Grant"].FirstOrDefault();
            if (!await IsGrantValidAsync(shareLink, grantToken, HttpContext.RequestAborted))
            {
                return Problem(
                    detail: "Valid access grant required for limited-use links. Call GET /api/s/{linkId} first to obtain a grant token, then pass it via the X-Share-Grant header.",
                    statusCode: StatusCodes.Status401Unauthorized);
            }
        }

        // Get non-deleted manifests for the album with pagination
        var manifests = await _db.Manifests
            .AsNoTracking()
            .Where(m => m.AlbumId == shareLink.AlbumId && !m.IsDeleted)
            .Include(m => m.ManifestShards.OrderBy(ms => ms.ChunkIndex))
            .OrderBy(m => m.VersionCreated)
            .Skip(skip)
            .Take(take)
            .Select(m => new ShareLinkPhotoResponse
            {
                Id = m.Id,
                VersionCreated = m.VersionCreated,
                IsDeleted = m.IsDeleted,
                EncryptedMeta = m.EncryptedMeta,
                Signature = m.Signature,
                SignerPubkey = m.SignerPubkey,
                ShardIds = m.ManifestShards
                    .Where(ms => ms.Tier <= shareLink.AccessTier)
                    .OrderBy(ms => ms.ChunkIndex)
                    .Select(ms => ms.ShardId)
                    .ToList()
            })
            .ToListAsync();

        return Ok(manifests);
    }

    /// <summary>
    /// Download a shard via share link (anonymous)
    /// </summary>
    [HttpGet("api/s/{linkId}/shards/{shardId}")]
    public async Task<IActionResult> DownloadShard(string linkId, Guid shardId)
    {
        var linkIdBytes = Base64UrlHelper.FromBase64Url(linkId);
        if (linkIdBytes == null)
        {
            return Problem(
                detail: "Invalid link ID format",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var shareLink = await _db.ShareLinks
            .AsNoTracking()
            .Include(sl => sl.Album)
            .FirstOrDefaultAsync(sl => sl.LinkId == linkIdBytes);

        if (shareLink == null)
        {
            return Problem(
                detail: "Link not found",
                statusCode: StatusCodes.Status404NotFound);
        }

        var validationResult = ValidateShareLink(shareLink);
        if (validationResult != null)
        {
            return validationResult;
        }

        // Require a valid access grant when the link has a MaxUses limit.
        if (shareLink.MaxUses.HasValue)
        {
            var grantToken = Request.Headers["X-Share-Grant"].FirstOrDefault();
            if (!await IsGrantValidAsync(shareLink, grantToken, HttpContext.RequestAborted))
            {
                return Problem(
                    detail: "Valid access grant required for limited-use links. Call GET /api/s/{linkId} first to obtain a grant token, then pass it via the X-Share-Grant header.",
                    statusCode: StatusCodes.Status401Unauthorized);
            }
        }

        // Get the shard
        var shard = await _db.Shards.FindAsync(shardId);
        if (shard == null)
        {
            return Problem(
                detail: "Shard not found",
                statusCode: StatusCodes.Status404NotFound);
        }
        if (shard.Status != ShardStatus.ACTIVE)
        {
            return Problem(
                detail: "Shard not available",
                statusCode: StatusCodes.Status404NotFound);
        }

        // Verify the shard belongs to the linked album
        var shardBelongsToAlbum = await _db.ManifestShards
            .Where(ms => ms.ShardId == shardId)
            .AnyAsync(ms =>
                ms.Manifest.AlbumId == shareLink.AlbumId
                && !ms.Manifest.IsDeleted
                && ms.Tier <= shareLink.AccessTier);

        if (!shardBelongsToAlbum)
        {
            return Forbid();
        }

        // Add SHA256 for client-side integrity verification
        if (!string.IsNullOrEmpty(shard.Sha256))
        {
            Response.Headers["X-Content-SHA256"] = shard.Sha256;
        }

        var stream = await _storage.OpenReadAsync(shard.StorageKey);
        return File(stream, "application/octet-stream");
    }

    /// <summary>
    /// Validates that a share link is still usable: not revoked, album not expired, link not expired.
    /// MaxUses enforcement is handled exclusively at the Access() gate (which issues the grant token);
    /// checking it here would block the last legitimate caller whose Access() incremented the counter.
    /// </summary>
    private IActionResult? ValidateShareLink(ShareLink shareLink)
    {
        if (shareLink.IsRevoked)
        {
            return Gone(new { error = "This link has been revoked" });
        }

        // Check album expiry - the Album navigation property must be loaded
        if (shareLink.Album != null &&
            shareLink.Album.ExpiresAt.HasValue &&
            shareLink.Album.ExpiresAt.Value <= DateTimeOffset.UtcNow)
        {
            return Gone(new { error = "Album has expired" });
        }

        if (shareLink.ExpiresAt.HasValue && shareLink.ExpiresAt.Value <= DateTimeOffset.UtcNow)
        {
            return Gone(new { error = "This link has expired" });
        }

        return null;
    }

    /// <summary>
    /// Returns HTTP 410 Gone with a JSON body
    /// </summary>
    private ObjectResult Gone(object value)
    {
        return StatusCode(StatusCodes.Status410Gone, value);
    }
}
