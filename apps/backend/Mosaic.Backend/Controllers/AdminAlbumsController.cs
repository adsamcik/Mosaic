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
    [HttpGet]
    public async Task<IActionResult> ListAlbums()
    {
        var defaults = await _quotaService.GetDefaultsAsync();

        var albums = await _db.Albums
            .Include(a => a.Owner)
            .Include(a => a.Limits)
            .OrderByDescending(a => a.CreatedAt)
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

        return Ok(new { albums = result });
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
            return NotFound(new { error = "Album not found" });
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
            return NotFound(new { error = "Album not found" });
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
            return NotFound(new { error = "Album limits not found" });
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
