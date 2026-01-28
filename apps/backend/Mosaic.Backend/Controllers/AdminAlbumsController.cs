using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/admin/albums")]
public class AdminAlbumsController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IQuotaSettingsService _quotaService;
    private readonly ILogger<AdminAlbumsController> _logger;

    public AdminAlbumsController(
        MosaicDbContext db,
        IQuotaSettingsService quotaService,
        ILogger<AdminAlbumsController> logger)
    {
        _db = db;
        _quotaService = quotaService;
        _logger = logger;
    }

    private User GetAdminUser()
    {
        return HttpContext.Items["AdminUser"] as User
            ?? throw new UnauthorizedAccessException("Admin user not found in context");
    }

    public record AlbumWithLimitsResponse(
        Guid Id,
        Guid OwnerId,
        string OwnerAuthSub,
        DateTime CreatedAt,
        AlbumLimitsResponse Limits
    );

    public record AlbumLimitsResponse(
        int MaxPhotos,
        int CurrentPhotoCount,
        long MaxSizeBytes,
        long CurrentSizeBytes,
        bool IsCustom
    );

    /// <summary>
    /// List all albums with limit info
    /// </summary>
    /// <param name="skip">Number of records to skip (default: 0)</param>
    /// <param name="take">Number of records to take (default: 50, max: 100)</param>
    [HttpGet]
    public async Task<IActionResult> ListAlbums([FromQuery] int skip = 0, [FromQuery] int take = 50)
    {
        // Validate pagination parameters
        skip = Math.Max(0, skip);
        take = Math.Clamp(take, 1, 100);

        var defaults = await _quotaService.GetDefaultsAsync();

        // Get total count for pagination metadata
        var totalCount = await _db.Albums.CountAsync();

        var albums = await _db.Albums
            .AsNoTracking()
            .Include(a => a.Owner)
            .Include(a => a.Limits)
            .AsSplitQuery()
            .OrderByDescending(a => a.CreatedAt)
            .Skip(skip)
            .Take(take)
            .ToListAsync();

        var result = albums.Select(a => new AlbumWithLimitsResponse(
            a.Id,
            a.OwnerId,
            a.Owner.AuthSub,
            a.CreatedAt,
            new AlbumLimitsResponse(
                a.Limits?.MaxPhotos ?? defaults.MaxPhotosPerAlbum,
                a.Limits?.CurrentPhotoCount ?? 0,
                a.Limits?.MaxSizeBytes ?? defaults.MaxBytesPerAlbum,
                a.Limits?.CurrentSizeBytes ?? 0,
                a.Limits?.MaxPhotos.HasValue == true || a.Limits?.MaxSizeBytes.HasValue == true
            )
        ));

        return Ok(new 
        { 
            albums = result,
            pagination = new
            {
                skip,
                take,
                totalCount,
                hasMore = skip + take < totalCount
            }
        });
    }

    /// <summary>
    /// Get specific album's limit details
    /// </summary>
    [HttpGet("{albumId:guid}/limits")]
    public async Task<IActionResult> GetAlbumLimits(Guid albumId)
    {
        var defaults = await _quotaService.GetDefaultsAsync();

        var album = await _db.Albums
            .Include(a => a.Limits)
            .FirstOrDefaultAsync(a => a.Id == albumId);

        if (album == null)
        {
            return Problem(
                detail: "Album not found",
                statusCode: StatusCodes.Status404NotFound);
        }

        return Ok(new AlbumLimitsResponse(
            album.Limits?.MaxPhotos ?? defaults.MaxPhotosPerAlbum,
            album.Limits?.CurrentPhotoCount ?? 0,
            album.Limits?.MaxSizeBytes ?? defaults.MaxBytesPerAlbum,
            album.Limits?.CurrentSizeBytes ?? 0,
            album.Limits?.MaxPhotos.HasValue == true || album.Limits?.MaxSizeBytes.HasValue == true
        ));
    }

    public record UpdateAlbumLimitsRequest(
        int? MaxPhotos,
        long? MaxSizeBytes
    );

    /// <summary>
    /// Set custom limits for an album
    /// </summary>
    [HttpPut("{albumId:guid}/limits")]
    public async Task<IActionResult> SetAlbumLimits(Guid albumId, [FromBody] UpdateAlbumLimitsRequest request)
    {
        var admin = GetAdminUser();
        var defaults = await _quotaService.GetDefaultsAsync();

        var album = await _db.Albums
            .Include(a => a.Limits)
            .FirstOrDefaultAsync(a => a.Id == albumId);

        if (album == null)
        {
            return Problem(
                detail: "Album not found",
                statusCode: StatusCodes.Status404NotFound);
        }

        if (album.Limits == null)
        {
            album.Limits = new AlbumLimits
            {
                AlbumId = album.Id,
                MaxPhotos = request.MaxPhotos,
                MaxSizeBytes = request.MaxSizeBytes
            };
            _db.AlbumLimits.Add(album.Limits);
        }
        else
        {
            album.Limits.MaxPhotos = request.MaxPhotos;
            album.Limits.MaxSizeBytes = request.MaxSizeBytes;
            album.Limits.UpdatedAt = DateTime.UtcNow;
        }

        await _db.SaveChangesAsync();

        _logger.LogInformation(
            "Admin {AdminId} updated limits for album {AlbumId}: MaxPhotos={MaxPhotos}, MaxSize={MaxSize}",
            admin.Id, albumId, request.MaxPhotos, request.MaxSizeBytes);

        return Ok(new AlbumLimitsResponse(
            album.Limits.MaxPhotos ?? defaults.MaxPhotosPerAlbum,
            album.Limits.CurrentPhotoCount,
            album.Limits.MaxSizeBytes ?? defaults.MaxBytesPerAlbum,
            album.Limits.CurrentSizeBytes,
            album.Limits.MaxPhotos.HasValue || album.Limits.MaxSizeBytes.HasValue
        ));
    }

    /// <summary>
    /// Reset album limits to system defaults
    /// </summary>
    [HttpDelete("{albumId:guid}/limits")]
    public async Task<IActionResult> ResetAlbumLimits(Guid albumId)
    {
        var admin = GetAdminUser();

        var limits = await _db.AlbumLimits.FindAsync(albumId);
        if (limits == null)
        {
            return Problem(
                detail: "Album limits not found",
                statusCode: StatusCodes.Status404NotFound);
        }

        // Reset to defaults but keep usage tracking
        limits.MaxPhotos = null;
        limits.MaxSizeBytes = null;
        limits.UpdatedAt = DateTime.UtcNow;

        await _db.SaveChangesAsync();

        _logger.LogInformation("Admin {AdminId} reset limits for album {AlbumId} to defaults", admin.Id, albumId);

        return NoContent();
    }
}
