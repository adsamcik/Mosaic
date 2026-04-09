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
    private static readonly Lazy<byte[]> FallbackGrantSigningKey = new(() => RandomNumberGenerator.GetBytes(32));

    private readonly MosaicDbContext _db;
    private readonly IStorageService _storage;
    private readonly byte[] _grantSigningKey;

    public ShareLinkAccessController(
        MosaicDbContext db,
        IConfiguration config,
        IStorageService storage)
    {
        _db = db;
        _storage = storage;

        // Initialize a stable signing key for grant tokens.
        // Prefer ShareLinks:GrantSigningKey when explicitly configured.
        // Otherwise derive a dedicated key from Auth:ServerSecret so tokens survive across
        // controller instances and across app instances that share the same auth secret.
        var keyConfig = config["ShareLinks:GrantSigningKey"];
        if (!string.IsNullOrWhiteSpace(keyConfig))
        {
            try
            {
                _grantSigningKey = Convert.FromBase64String(keyConfig);
            }
            catch
            {
                _grantSigningKey = FallbackGrantSigningKey.Value;
            }
        }
        else
        {
            var serverSecretBase64 = config["Auth:ServerSecret"];
            if (!string.IsNullOrWhiteSpace(serverSecretBase64))
            {
                try
                {
                    var serverSecret = Convert.FromBase64String(serverSecretBase64);
                    using var hmac = new HMACSHA256(serverSecret);
                    _grantSigningKey = hmac.ComputeHash(Encoding.UTF8.GetBytes("share-link-grant"));
                }
                catch
                {
                    _grantSigningKey = FallbackGrantSigningKey.Value;
                }
            }
            else
            {
                _grantSigningKey = FallbackGrantSigningKey.Value;
            }
        }
    }

    /// <summary>
    /// Generates an HMAC-based grant token for the given link ID.
    /// The token is tied to a 2-hour time window so it expires naturally.
    /// </summary>
    private string GenerateGrantToken(byte[] linkId)
    {
        // 2-hour window: floor(unixSeconds / 7200)
        var windowEpoch = DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 7200;
        var message = Encoding.UTF8.GetBytes($"{Convert.ToHexString(linkId)}:{windowEpoch}");
        using var hmac = new HMACSHA256(_grantSigningKey);
        return Base64UrlHelper.ToBase64Url(hmac.ComputeHash(message));
    }

    /// <summary>
    /// Validates a grant token for the given link ID.
    /// Accepts tokens from the current 2-hour window and the immediately preceding one
    /// to avoid clock-boundary edge cases.
    /// </summary>
    private bool IsGrantValid(byte[] linkId, string? token)
    {
        if (string.IsNullOrEmpty(token)) return false;

        var currentWindow = DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 7200;
        var linkHex = Convert.ToHexString(linkId);

        for (var offset = 0; offset <= 1; offset++)
        {
            var message = Encoding.UTF8.GetBytes($"{linkHex}:{currentWindow - offset}");
            using var hmac = new HMACSHA256(_grantSigningKey);
            var expected = Base64UrlHelper.ToBase64Url(hmac.ComputeHash(message));
            if (CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(expected),
                Encoding.UTF8.GetBytes(token)))
            {
                return true;
            }
        }
        return false;
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

        bool updateSucceeded;

        if (_db.SupportsBulkOperations())
        {
            // Use atomic update to prevent race conditions on MaxUses (PostgreSQL/SQLite)
            var updated = await _db.ShareLinks
                .Where(sl => sl.LinkId == linkIdBytes &&
                             !sl.IsRevoked &&
                             (!sl.MaxUses.HasValue || sl.UseCount < sl.MaxUses.Value))
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.UseCount, x => x.UseCount + 1));

            updateSucceeded = updated > 0;
        }
        else
        {
            // Fallback for InMemory provider (tests only)
            if (shareLink.MaxUses.HasValue && shareLink.UseCount >= shareLink.MaxUses.Value)
            {
                updateSucceeded = false;
            }
            else
            {
                shareLink.UseCount++;
                await _db.SaveChangesAsync();
                updateSucceeded = true;
            }
        }

        if (!updateSucceeded)
        {
            // Re-fetch to determine specific reason (link was modified between initial fetch and update)
            var link = await _db.ShareLinks.AsNoTracking().FirstOrDefaultAsync(sl => sl.LinkId == linkIdBytes);
            if (link == null)
            {
                return Problem(
                    detail: "Link not found",
                    statusCode: StatusCodes.Status404NotFound);
            }
            if (link.IsRevoked)
            {
                return Gone(new { error = "This link has been revoked" });
            }
            return Gone(new { error = "This link has reached its maximum uses" });
        }

        return Ok(new LinkAccessResponse
        {
            AlbumId = shareLink.AlbumId,
            AccessTier = shareLink.AccessTier,
            EpochCount = shareLink.LinkEpochKeys.Select(k => k.EpochId).Distinct().Count(),
            EncryptedName = shareLink.Album.EncryptedName,
            GrantToken = GenerateGrantToken(shareLink.LinkId)
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
            if (!IsGrantValid(shareLink.LinkId, grantToken))
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
            if (!IsGrantValid(shareLink.LinkId, grantToken))
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
                ShardIds = m.ManifestShards.OrderBy(ms => ms.ChunkIndex).Select(ms => ms.ShardId).ToList()
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
            if (!IsGrantValid(shareLink.LinkId, grantToken))
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
            .AnyAsync(ms => ms.Manifest.AlbumId == shareLink.AlbumId && !ms.Manifest.IsDeleted);

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