using System.ComponentModel.DataAnnotations;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Extensions;
using Mosaic.Backend.Middleware;
using Mosaic.Backend.Models;
using Mosaic.Backend.Models.ShareLinks;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

/// <summary>
/// Controller for managing share links (CRUD by album owners)
/// </summary>
[ApiController]
public class ShareLinksController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly ICurrentUserService _currentUserService;
    private readonly IAuditLogService? _auditLog;
    private readonly TimeProvider _timeProvider;

    public ShareLinksController(
        MosaicDbContext db,
        ICurrentUserService currentUserService,
        IAuditLogService? auditLog = null,
        TimeProvider? timeProvider = null)
    {
        _db = db;
        _currentUserService = currentUserService;
        _auditLog = auditLog;
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    /// <summary>
    /// Create a new share link for an album (owner only)
    /// </summary>
    /// <param name="albumId">Album that owns the share link.</param>
    /// <param name="request">The client-addressed link ID, wrapped keys, and access policy.</param>
    /// <param name="idempotencyKey">Required identifier for this logical create. Reuse it only when retrying the same payload; an exact retry returns the original 201 response and a changed payload returns 409.</param>
    [HttpPost("api/v1/albums/{albumId}/share-links")]
    [ProducesResponseType<ShareLinkResponse>(StatusCodes.Status201Created)]
    public async Task<IActionResult> Create(
        Guid albumId,
        [FromBody] CreateShareLinkRequest request,
        [FromHeader(Name = IdempotencyMiddleware.HeaderName), BindRequired, MaxLength(IdempotencyMiddleware.MaxKeyLength)] string? idempotencyKey = null)
    {
        idempotencyKey ??= Request.Headers[IdempotencyMiddleware.HeaderName].FirstOrDefault();
        if (string.IsNullOrWhiteSpace(idempotencyKey))
        {
            return Problem(
                detail: $"{IdempotencyMiddleware.HeaderName} is required for share-link creation.",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Verify album ownership
        var albumNotFound = Problem(detail: "Album not found", statusCode: StatusCodes.Status404NotFound);
        var (album, ownerError) = await _db.RequireAlbumOwnerAsync(albumId, user.Id, albumNotFound);
        if (ownerError != null)
        {
            return ownerError;
        }

        // Validate request
        if (request.AccessTier < 1 || request.AccessTier > 3)
        {
            return Problem(
                detail: "accessTier must be 1, 2, or 3",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (request.LinkId == null || request.LinkId.Length != 16)
        {
            return Problem(
                detail: "linkId must be 16 bytes",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (request.WrappedKeys == null || request.WrappedKeys.Count == 0)
        {
            return Problem(
                detail: "wrappedKeys is required",
                statusCode: StatusCodes.Status400BadRequest);
        }

        foreach (var key in request.WrappedKeys)
        {
            if (key.Nonce == null || key.Nonce.Length != 24)
            {
                return Problem(
                    detail: "Each wrapped key must have a 24-byte nonce",
                    statusCode: StatusCodes.Status400BadRequest);
            }
            if (key.EncryptedKey == null || key.EncryptedKey.Length == 0)
            {
                return Problem(
                    detail: "Each wrapped key must have an encryptedKey",
                    statusCode: StatusCodes.Status400BadRequest);
            }
            if (key.Tier < 1 || key.Tier > 3)
            {
                return Problem(
                    detail: "Each wrapped key tier must be 1, 2, or 3",
                    statusCode: StatusCodes.Status400BadRequest);
            }
            if (key.Tier > request.AccessTier)
            {
                return Problem(
                    detail: "Each wrapped key tier must be less than or equal to accessTier",
                    statusCode: StatusCodes.Status400BadRequest);
            }
        }

        if (request.MaxUses.HasValue && request.MaxUses.Value <= 0)
        {
            return Problem(
                detail: "maxUses must be positive",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var createRequestHash = ComputeCreateRequestHash(albumId, request);
        var existingLink = await _db.ShareLinks
            .AsNoTracking()
            .FirstOrDefaultAsync(sl => sl.LinkId == request.LinkId);
        if (existingLink != null)
        {
            if (IsExactCreateReplay(existingLink, albumId, createRequestHash))
            {
                Response.Headers["Idempotency-Replayed"] = "true";
                return Created(
                    $"/api/v1/share-links/{existingLink.Id}",
                    ToCreateResponse(existingLink, request));
            }

            return Problem(
                detail: "A link with this ID already exists and is bound to a different create request.",
                statusCode: StatusCodes.Status409Conflict);
        }

        // Time-dependent validations apply only after an exact retry has had
        // the opportunity to recover the original response.
        if (album!.ExpiresAt.HasValue && album.ExpiresAt.Value <= _timeProvider.GetUtcNow())
        {
            return Gone(new { error = "Album has expired" });
        }

        if (request.ExpiresAt.HasValue && request.ExpiresAt.Value <= _timeProvider.GetUtcNow())
        {
            return Problem(
                detail: "expiresAt must be in the future",
                statusCode: StatusCodes.Status400BadRequest);
        }

        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
            var shareLink = new ShareLink
            {
                Id = Guid.CreateVersion7(),
                LinkId = request.LinkId,
                AlbumId = albumId,
                AccessTier = request.AccessTier,
                OwnerEncryptedSecret = request.OwnerEncryptedSecret,
                ExpiresAt = request.ExpiresAt,
                MaxUses = request.MaxUses,
                UseCount = 0,
                IsRevoked = false,
                CreateRequestHash = createRequestHash
            };
            _db.ShareLinks.Add(shareLink);

            foreach (var wrappedKey in request.WrappedKeys)
            {
                _db.LinkEpochKeys.Add(new LinkEpochKey
                {
                    Id = Guid.CreateVersion7(),
                    ShareLinkId = shareLink.Id,
                    EpochId = wrappedKey.EpochId,
                    Tier = wrappedKey.Tier,
                    WrappedNonce = wrappedKey.Nonce,
                    WrappedKey = wrappedKey.EncryptedKey
                });
            }

            await _db.SaveChangesAsync();
            await tx.CommitAsync();

            // D1 audit (batch 7): record share-link creation for incident
            // response. ZK-safe: we log the opaque link Guid (not the
            // secret) plus operational metadata only.
            if (_auditLog is not null)
            {
                await _auditLog.WriteAsync(
                    AuditEventTypes.ShareLinkCreated,
                    AuditOutcomes.Success,
                    HttpContext,
                    actorUserId: user.Id,
                    targetType: "share-link",
                    targetId: shareLink.Id.ToString(),
                    details: new
                    {
                        albumId,
                        accessTier = request.AccessTier,
                        hasExpiry = request.ExpiresAt.HasValue,
                        maxUses = request.MaxUses,
                    });
            }

            return Created(
                $"/api/v1/share-links/{shareLink.Id}",
                ToCreateResponse(shareLink, request));
        }
        catch (DbUpdateException ex) when (DatabaseConstraintErrors.IsUniqueViolation(ex))
        {
            // LinkId is the client-addressed identity. If another request won
            // after our pre-check, roll back every wrapped-key side effect and
            // recover only that winner's exact fingerprint.
            await tx.RollbackAsync();
            _db.ChangeTracker.Clear();

            var racedLink = await _db.ShareLinks
                .AsNoTracking()
                .FirstOrDefaultAsync(sl => sl.LinkId == request.LinkId);
            if (racedLink != null && IsExactCreateReplay(racedLink, albumId, createRequestHash))
            {
                Response.Headers["Idempotency-Replayed"] = "true";
                return Created(
                    $"/api/v1/share-links/{racedLink.Id}",
                    ToCreateResponse(racedLink, request));
            }

            if (racedLink != null)
            {
                return Problem(
                    detail: "A link with this ID already exists and is bound to a different create request.",
                    statusCode: StatusCodes.Status409Conflict);
            }

            throw;
        }
        catch
        {
            await tx.RollbackAsync();
            throw;
        }
    }

    private static bool IsExactCreateReplay(ShareLink shareLink, Guid albumId, byte[] requestHash)
    {
        return shareLink.AlbumId == albumId
            && shareLink.CreateRequestHash != null
            && shareLink.CreateRequestHash.Length == requestHash.Length
            && CryptographicOperations.FixedTimeEquals(shareLink.CreateRequestHash, requestHash);
    }

    private static byte[] ComputeCreateRequestHash(Guid albumId, CreateShareLinkRequest request)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData("Mosaic_ShareLink_Create_Request_v1"u8);
        hash.AppendData(albumId.ToByteArray());
        hash.AppendData(JsonSerializer.SerializeToUtf8Bytes(request));
        return hash.GetHashAndReset();
    }

    private static ShareLinkResponse ToCreateResponse(
        ShareLink shareLink,
        CreateShareLinkRequest request)
    {
        return new ShareLinkResponse
        {
            Id = shareLink.Id,
            // v1.0.x shares-01: frontend Zod schema requires standard
            // base64 with the +/= alphabet, not unpadded base64url.
            LinkId = Convert.ToBase64String(request.LinkId),
            AccessTier = request.AccessTier,
            ExpiresAt = request.ExpiresAt,
            MaxUses = request.MaxUses,
            UseCount = 0,
            IsRevoked = false,
            CreatedAt = shareLink.CreatedAt
        };
    }

    /// <summary>
    /// List all share links for an album (owner only)
    /// </summary>
    [HttpGet("api/v1/albums/{albumId}/share-links")]
    public async Task<IActionResult> List(Guid albumId, [FromQuery] int skip = 0, [FromQuery] int take = 50)
    {
        skip = Math.Max(0, skip);
        take = Math.Clamp(take, 1, 100);

        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Verify album ownership
        var albumNotFound = Problem(detail: "Album not found", statusCode: StatusCodes.Status404NotFound);
        var (_, ownerError) = await _db.RequireAlbumOwnerAsync(albumId, user.Id, albumNotFound);
        if (ownerError != null)
        {
            return ownerError;
        }

        var query = _db.ShareLinks
            .AsNoTracking()
            .Where(sl => sl.AlbumId == albumId);

        var totalCount = await query.CountAsync();
        var rows = await query
            .OrderByDescending(sl => sl.CreatedAtUnixMilliseconds)
            .ThenBy(sl => sl.Id)
            .Skip(skip)
            .Take(take)
            .Select(sl => new
            {
                sl.Id,
                sl.LinkId,
                sl.AccessTier,
                sl.ExpiresAt,
                sl.MaxUses,
                sl.UseCount,
                sl.IsRevoked,
                sl.CreatedAt
            })
            .ToListAsync();

        var links = rows
            .Select(sl => new ShareLinkResponse
            {
                Id = sl.Id,
                LinkId = Convert.ToBase64String(sl.LinkId),
                AccessTier = sl.AccessTier,
                ExpiresAt = sl.ExpiresAt,
                MaxUses = sl.MaxUses,
                UseCount = sl.UseCount,
                IsRevoked = sl.IsRevoked,
                CreatedAt = sl.CreatedAt
            })
            .ToList();

        Response.AddPaginationHeaders(skip, take, totalCount);
        return Ok(PagedResult.Create(links, skip, take, totalCount));
    }

    /// <summary>
    /// List active share links with owner-encrypted secrets (owner only, for epoch rotation)
    /// </summary>
    [HttpGet("api/v1/albums/{albumId}/share-links/with-secrets")]
    public async Task<IActionResult> ListWithSecrets(Guid albumId, [FromQuery] int skip = 0, [FromQuery] int take = 50)
    {
        skip = Math.Max(0, skip);
        take = Math.Clamp(take, 1, 100);

        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Verify album ownership
        var albumNotFound = Problem(detail: "Album not found", statusCode: StatusCodes.Status404NotFound);
        var (_, ownerError) = await _db.RequireAlbumOwnerAsync(albumId, user.Id, albumNotFound);
        if (ownerError != null)
        {
            return ownerError;
        }

        var nowUnixMilliseconds = _timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        var query = _db.ShareLinks
            .AsNoTracking()
            .Where(sl => sl.AlbumId == albumId &&
                         !sl.IsRevoked &&
                         sl.OwnerEncryptedSecret != null &&
                         (!sl.ExpiresAtUnixMilliseconds.HasValue ||
                          sl.ExpiresAtUnixMilliseconds.Value > nowUnixMilliseconds) &&
                         (!sl.MaxUses.HasValue || sl.UseCount < sl.MaxUses.Value));

        var totalCount = await query.CountAsync();
        var rows = await query
            .OrderByDescending(sl => sl.CreatedAtUnixMilliseconds)
            .ThenBy(sl => sl.Id)
            .Skip(skip)
            .Take(take)
            .Select(sl => new
            {
                sl.Id,
                sl.LinkId,
                sl.AccessTier,
                sl.IsRevoked,
                sl.OwnerEncryptedSecret
            })
            .ToListAsync();

        var page = rows
            .Select(sl => new ShareLinkWithSecretResponse
            {
                Id = sl.Id,
                LinkId = Convert.ToBase64String(sl.LinkId),
                AccessTier = sl.AccessTier,
                IsRevoked = sl.IsRevoked,
                OwnerEncryptedSecret = sl.OwnerEncryptedSecret
            })
            .ToList();

        Response.AddPaginationHeaders(skip, take, totalCount);
        return Ok(PagedResult.Create(page, skip, take, totalCount));
    }

    /// <summary>
    /// Revoke a share link (soft delete, owner only)
    /// </summary>
    [HttpDelete("api/v1/share-links/{id}")]
    public async Task<IActionResult> Revoke(Guid id)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        var shareLink = await _db.ShareLinks
            .Include(sl => sl.Album)
            .FirstOrDefaultAsync(sl => sl.Id == id);

        if (shareLink == null)
        {
            return Problem(
                detail: "Share link not found",
                statusCode: StatusCodes.Status404NotFound);
        }
        if (shareLink.Album.OwnerId != user.Id)
        {
            // D1 audit: record the denied attempt so a malicious
            // probe of "guess a link id then revoke" leaves a trace.
            if (_auditLog is not null)
            {
                await _auditLog.WriteAsync(
                    AuditEventTypes.ShareLinkRevoked,
                    AuditOutcomes.Denied,
                    HttpContext,
                    actorUserId: user.Id,
                    targetType: "share-link",
                    targetId: id.ToString());
            }
            return Problem(
                detail: "Not authorized to revoke this share link",
                statusCode: StatusCodes.Status403Forbidden);
        }

        shareLink.IsRevoked = true;
        await _db.SaveChangesAsync();

        // D1 audit (batch 7): record successful revocation. ZK-safe:
        // we log the opaque link Guid + album id only.
        if (_auditLog is not null)
        {
            await _auditLog.WriteAsync(
                AuditEventTypes.ShareLinkRevoked,
                AuditOutcomes.Success,
                HttpContext,
                actorUserId: user.Id,
                targetType: "share-link",
                targetId: shareLink.Id.ToString(),
                details: new { albumId = shareLink.AlbumId });
        }

        return NoContent();
    }

    /// <summary>
    /// Update expiration settings for a share link (owner only)
    /// </summary>
    [HttpPatch("api/v1/albums/{albumId:guid}/share-links/{linkId}/expiration")]
    [ProducesResponseType<ShareLinkResponse>(StatusCodes.Status200OK)]
    public async Task<IActionResult> UpdateLinkExpiration(Guid albumId, string linkId, [FromBody] UpdateLinkExpirationRequest request)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        // Verify album exists and user is owner
        var albumNotFound = Problem(detail: "Album not found", statusCode: StatusCodes.Status404NotFound);
        var (_, ownerError) = await _db.RequireAlbumOwnerAsync(albumId, user.Id, albumNotFound);
        if (ownerError != null)
        {
            return ownerError;
        }

        // Decode linkId from base64url
        var linkIdBytes = Base64UrlHelper.FromBase64Url(linkId);
        if (linkIdBytes == null)
        {
            return Problem(
                detail: "Invalid linkId format",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Find the share link
        var shareLink = await _db.ShareLinks
            .FirstOrDefaultAsync(sl => sl.AlbumId == albumId && sl.LinkId == linkIdBytes);

        if (shareLink == null)
        {
            return Problem(
                detail: "Share link not found",
                statusCode: StatusCodes.Status404NotFound);
        }

        if (shareLink.IsRevoked)
        {
            return Problem(
                detail: "Cannot update a revoked link",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Validate ExpiresAt if provided and not null
        if (request.ExpiresAt.HasValue && request.ExpiresAt.Value <= _timeProvider.GetUtcNow())
        {
            return Problem(
                detail: "expiresAt must be in the future",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Validate MaxUses if provided
        if (request.MaxUses.HasValue && request.MaxUses.Value <= 0)
        {
            return Problem(
                detail: "maxUses must be positive",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Update expiration settings
        shareLink.ExpiresAt = request.ExpiresAt;
        shareLink.MaxUses = request.MaxUses;

        await _db.SaveChangesAsync();

        return Ok(new ShareLinkResponse
        {
            Id = shareLink.Id,
            // v1.0.x shares-01: see Create() for rationale.
            LinkId = Convert.ToBase64String(shareLink.LinkId),
            AccessTier = shareLink.AccessTier,
            ExpiresAt = shareLink.ExpiresAt,
            MaxUses = shareLink.MaxUses,
            UseCount = shareLink.UseCount,
            IsRevoked = shareLink.IsRevoked,
            CreatedAt = shareLink.CreatedAt
        });
    }

    /// <summary>
    /// Add epoch keysto an existing share link (owner only, for epoch rotation)
    /// </summary>
    [HttpPost("api/v1/share-links/{id}/keys")]
    public async Task<IActionResult> AddEpochKeys(Guid id, [FromBody] AddEpochKeysRequest request)
    {
        var user = await _currentUserService.GetOrCreateAsync(HttpContext);

        var shareLink = await _db.ShareLinks
            .Include(sl => sl.Album)
            .Include(sl => sl.LinkEpochKeys)
            .AsSplitQuery()
            .FirstOrDefaultAsync(sl => sl.Id == id);

        if (shareLink == null)
        {
            return Problem(
                detail: "Share link not found",
                statusCode: StatusCodes.Status404NotFound);
        }
        if (shareLink.Album.OwnerId != user.Id)
        {
            return Problem(
                detail: "Not authorized to manage this share link",
                statusCode: StatusCodes.Status403Forbidden);
        }
        if (shareLink.IsRevoked)
        {
            return Problem(
                detail: "Cannot add keys to a revoked link",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // Validate request
        if (request.EpochKeys == null || request.EpochKeys.Count == 0)
        {
            return Problem(
                detail: "epochKeys is required",
                statusCode: StatusCodes.Status400BadRequest);
        }

        foreach (var key in request.EpochKeys)
        {
            if (key.Nonce == null || key.Nonce.Length != 24)
            {
                return Problem(
                    detail: "Each epoch key must have a 24-byte nonce",
                    statusCode: StatusCodes.Status400BadRequest);
            }
            if (key.EncryptedKey == null || key.EncryptedKey.Length == 0)
            {
                return Problem(
                    detail: "Each epoch key must have an encryptedKey",
                    statusCode: StatusCodes.Status400BadRequest);
            }
            if (key.Tier < 1 || key.Tier > 3)
            {
                return Problem(
                    detail: "Each epoch key tier must be 1, 2, or 3",
                    statusCode: StatusCodes.Status400BadRequest);
            }
            if (key.Tier > shareLink.AccessTier)
            {
                return Problem(
                    detail: "Each epoch key tier must be less than or equal to accessTier",
                    statusCode: StatusCodes.Status400BadRequest);
            }
        }

        // Check for existing epoch/tier combinations
        var existingKeys = shareLink.LinkEpochKeys
            .Select(k => (k.EpochId, k.Tier))
            .ToHashSet();

        // Use transaction to ensure atomicity of key updates
        await using var tx = await _db.Database.BeginTransactionAsync();
        try
        {
            var keysToAdd = new List<LinkEpochKey>();
            foreach (var key in request.EpochKeys)
            {
                if (existingKeys.Contains((key.EpochId, key.Tier)))
                {
                    // Update existing key
                    var existing = shareLink.LinkEpochKeys
                        .First(k => k.EpochId == key.EpochId && k.Tier == key.Tier);
                    existing.WrappedNonce = key.Nonce;
                    existing.WrappedKey = key.EncryptedKey;
                }
                else
                {
                    // Add new key
                    keysToAdd.Add(new LinkEpochKey
                    {
                        Id = Guid.CreateVersion7(),
                        ShareLinkId = shareLink.Id,
                        EpochId = key.EpochId,
                        Tier = key.Tier,
                        WrappedNonce = key.Nonce,
                        WrappedKey = key.EncryptedKey
                    });
                }
            }

            if (keysToAdd.Count > 0)
            {
                _db.LinkEpochKeys.AddRange(keysToAdd);
            }

            await _db.SaveChangesAsync();
            await tx.CommitAsync();

            return Ok(new { added = keysToAdd.Count, updated = request.EpochKeys.Count - keysToAdd.Count });
        }
        catch
        {
            await tx.RollbackAsync();
            throw;
        }
    }
    /// <summary>
    /// Returns HTTP 410 Gone with a JSON body
    /// </summary>
    private ObjectResult Gone(object value)
    {
        return StatusCode(StatusCodes.Status410Gone, value);
    }
}
