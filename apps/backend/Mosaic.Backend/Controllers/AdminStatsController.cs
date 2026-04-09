using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Models.Admin;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/admin/stats")]
public class AdminStatsController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IQuotaSettingsService _quotaService;

    public AdminStatsController(
        MosaicDbContext db,
        IQuotaSettingsService quotaService)
    {
        _db = db;
        _quotaService = quotaService;
    }




    /// <summary>
    /// Get system-wide usage statistics
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> GetStats()
    {
        var defaults = await _quotaService.GetDefaultsAsync();

        var totalUsers = await _db.Users.CountAsync();
        var totalAlbums = await _db.Albums.CountAsync();
        var totalPhotos = await _db.Manifests.CountAsync(m => !m.IsDeleted);
        var totalStorageBytes = await _db.UserQuotas.SumAsync(q => q.UsedStorageBytes);

        // Find users near quota (>= 80% used)
        var usersNearQuota = await _db.Users
            .AsNoTracking()
            .Include(u => u.Quota)
            .Where(u => u.Quota != null)
            .Select(u => new
            {
                u.Id,
                u.AuthSub,
                UsedBytes = u.Quota!.UsedStorageBytes,
                MaxBytes = u.Quota.MaxStorageBytes > 0 ? u.Quota.MaxStorageBytes : defaults.MaxStorageBytesPerUser
            })
            .Where(u => u.MaxBytes > 0 && (u.UsedBytes * 100 / u.MaxBytes) >= 80)
            .ToListAsync();

        var userWarnings = usersNearQuota.Select(u => new UserQuotaWarning(
            u.Id,
            u.AuthSub,
            (int)(u.UsedBytes * 100 / u.MaxBytes)
        )).OrderByDescending(w => w.UsagePercent).ToList();

        // Find albums near limit (>= 80% photos or size)
        var albumsNearLimit = await _db.Albums
            .AsNoTracking()
            .Include(a => a.Owner)
            .Include(a => a.Limits)
            .AsSplitQuery()
            .Where(a => a.Limits != null)
            .Select(a => new
            {
                a.Id,
                OwnerAuthSub = a.Owner.AuthSub,
                CurrentPhotos = a.Limits!.CurrentPhotoCount,
                MaxPhotos = a.Limits.MaxPhotos ?? defaults.MaxPhotosPerAlbum,
                CurrentSize = a.Limits.CurrentSizeBytes,
                MaxSize = a.Limits.MaxSizeBytes ?? defaults.MaxBytesPerAlbum
            })
            .Where(a =>
                (a.MaxPhotos > 0 && (a.CurrentPhotos * 100 / a.MaxPhotos) >= 80) ||
                (a.MaxSize > 0 && (a.CurrentSize * 100 / a.MaxSize) >= 80))
            .ToListAsync();

        var albumWarnings = albumsNearLimit.Select(a => new AlbumLimitWarning(
            a.Id,
            a.OwnerAuthSub,
            a.MaxPhotos > 0 ? (int)(a.CurrentPhotos * 100 / a.MaxPhotos) : 0,
            a.MaxSize > 0 ? (int)(a.CurrentSize * 100 / a.MaxSize) : 0
        )).OrderByDescending(w => Math.Max(w.PhotoUsagePercent, w.SizeUsagePercent)).ToList();

        return Ok(new SystemStatsResponse(
            totalUsers,
            totalAlbums,
            totalPhotos,
            totalStorageBytes,
            userWarnings,
            albumWarnings
        ));
    }
}
