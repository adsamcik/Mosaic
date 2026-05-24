using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Models.Admin;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/v1/admin/stats")]
[ApiExplorerSettings(IgnoreApi = true)]
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
    /// Get system-wide usage statistics.
    ///
    /// v1.0.2 hardening — the `UsersNearQuota` and `AlbumsNearLimit` warning
    /// lists are bounded server-side. Without a cap, an installation with
    /// many users / albums in the >= 80% usage band would force the server
    /// to materialise an unbounded list (and the admin client to render it).
    /// Callers can request more results by raising `nearLimitTake` up to
    /// `MaxNearLimitTake`, and page using `nearLimitSkip`.
    /// </summary>
    /// <param name="nearLimitSkip">Number of warning rows to skip (default 0,
    /// clamped to 0..<see cref="MaxNearLimitSkip"/>). v1.0.2 review-MED hardening
    /// (`v102-admin-stats-skip-unbounded`): without an upper cap, an attacker
    /// (or a buggy admin client) could request `nearLimitSkip=2_000_000_000`
    /// and force PostgreSQL to scan/skip an unbounded range of warning rows
    /// despite the per-page `nearLimitTake` cap.</param>
    /// <param name="nearLimitTake">Number of warning rows to return per
    /// category (default 100, clamped to 1..500).</param>
    [HttpGet]
    public async Task<IActionResult> GetStats(
        [FromQuery] int nearLimitSkip = 0,
        [FromQuery] int nearLimitTake = DefaultNearLimitTake)
    {
        nearLimitSkip = Math.Clamp(nearLimitSkip, 0, MaxNearLimitSkip);
        nearLimitTake = Math.Clamp(nearLimitTake, 1, MaxNearLimitTake);

        var defaults = await _quotaService.GetDefaultsAsync();

        var totalUsers = await _db.Users.CountAsync();
        var totalAlbums = await _db.Albums.CountAsync();
        var totalPhotos = await _db.Manifests.CountAsync(m => !m.IsDeleted);
        var totalStorageBytes = await _db.UserQuotas.SumAsync(q => q.UsedStorageBytes);

        // Find users near quota (>= 80% used). Order + Skip + Take at the
        // database so we never materialise more than `nearLimitTake` rows.
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
            .OrderByDescending(u => u.UsedBytes * 100 / u.MaxBytes)
            .Skip(nearLimitSkip)
            .Take(nearLimitTake)
            .ToListAsync();

        var userWarnings = usersNearQuota.Select(u => new UserQuotaWarning(
            u.Id,
            u.AuthSub,
            (int)(u.UsedBytes * 100 / u.MaxBytes)
        )).ToList();

        // Find albums near limit (>= 80% photos or size). Same cap applies.
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
            .OrderByDescending(a =>
                (a.MaxPhotos > 0 ? (a.CurrentPhotos * 100 / a.MaxPhotos) : 0) +
                (a.MaxSize > 0 ? (a.CurrentSize * 100 / a.MaxSize) : 0))
            .Skip(nearLimitSkip)
            .Take(nearLimitTake)
            .ToListAsync();

        var albumWarnings = albumsNearLimit.Select(a => new AlbumLimitWarning(
            a.Id,
            a.OwnerAuthSub,
            a.MaxPhotos > 0 ? (int)(a.CurrentPhotos * 100 / a.MaxPhotos) : 0,
            a.MaxSize > 0 ? (int)(a.CurrentSize * 100 / a.MaxSize) : 0
        )).ToList();

        return Ok(new SystemStatsResponse(
            totalUsers,
            totalAlbums,
            totalPhotos,
            totalStorageBytes,
            userWarnings,
            albumWarnings
        ));
    }

    /// <summary>
    /// Default number of near-limit warnings returned per category.
    /// </summary>
    private const int DefaultNearLimitTake = 100;

    /// <summary>
    /// Hard server-side cap on near-limit warnings per category. Prevents an
    /// unbounded admin request from materialising every quota-warning row.
    /// </summary>
    private const int MaxNearLimitTake = 500;

    /// <summary>
    /// Hard server-side cap on `nearLimitSkip`. v1.0.2 review-MED
    /// (`v102-admin-stats-skip-unbounded`): pairs with `MaxNearLimitTake` so
    /// that the worst-case rows the server is willing to walk per request is
    /// bounded (10_000 + 500 = 10_500 rows), defeating skip-amplification DoS.
    /// Mosaic's ≤50-user / small-fleet target means real callers never need
    /// to page past this; an admin who does should narrow the query first.
    /// </summary>
    private const int MaxNearLimitSkip = 10_000;
}
