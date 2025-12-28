using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Logging;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/admin/users")]
public class AdminUsersController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IQuotaSettingsService _quotaService;
    private readonly ILogger<AdminUsersController> _logger;

    public AdminUsersController(
        MosaicDbContext db,
        IQuotaSettingsService quotaService,
        ILogger<AdminUsersController> logger)
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

    public record UserWithQuotaResponse(
        Guid Id,
        string AuthSub,
        bool IsAdmin,
        DateTime CreatedAt,
        UserQuotaResponse Quota
    );

    public record UserQuotaResponse(
        long MaxStorageBytes,
        long UsedStorageBytes,
        int MaxAlbums,
        int CurrentAlbumCount,
        bool IsCustom
    );

    /// <summary>
    /// List all users with quota info
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> ListUsers()
    {
        var defaults = await _quotaService.GetDefaultsAsync();

        var users = await _db.Users
            .Include(u => u.Quota)
            .OrderBy(u => u.AuthSub)
            .ToListAsync();

        var result = users.Select(u => new UserWithQuotaResponse(
            u.Id,
            u.AuthSub,
            u.IsAdmin,
            u.CreatedAt,
            new UserQuotaResponse(
                u.Quota?.MaxStorageBytes ?? defaults.MaxStorageBytesPerUser,
                u.Quota?.UsedStorageBytes ?? 0,
                u.Quota?.MaxAlbums ?? defaults.MaxAlbumsPerUser,
                u.Quota?.CurrentAlbumCount ?? 0,
                u.Quota?.MaxAlbums.HasValue == true || (u.Quota?.MaxStorageBytes ?? 0) != defaults.MaxStorageBytesPerUser
            )
        ));

        return Ok(new { users = result });
    }

    /// <summary>
    /// Get specific user's quota details
    /// </summary>
    [HttpGet("{userId:guid}/quota")]
    public async Task<IActionResult> GetUserQuota(Guid userId)
    {
        var defaults = await _quotaService.GetDefaultsAsync();

        var user = await _db.Users
            .Include(u => u.Quota)
            .FirstOrDefaultAsync(u => u.Id == userId);

        if (user == null) return NotFound(new { error = "User not found" });

        return Ok(new UserQuotaResponse(
            user.Quota?.MaxStorageBytes ?? defaults.MaxStorageBytesPerUser,
            user.Quota?.UsedStorageBytes ?? 0,
            user.Quota?.MaxAlbums ?? defaults.MaxAlbumsPerUser,
            user.Quota?.CurrentAlbumCount ?? 0,
            user.Quota?.MaxAlbums.HasValue == true || (user.Quota?.MaxStorageBytes ?? 0) != defaults.MaxStorageBytesPerUser
        ));
    }

    public record UpdateUserQuotaRequest(
        long? MaxStorageBytes,
        int? MaxAlbums
    );

    /// <summary>
    /// Set custom quota for a user
    /// </summary>
    [HttpPut("{userId:guid}/quota")]
    public async Task<IActionResult> SetUserQuota(Guid userId, [FromBody] UpdateUserQuotaRequest request)
    {
        var admin = GetAdminUser();
        var defaults = await _quotaService.GetDefaultsAsync();

        var user = await _db.Users
            .Include(u => u.Quota)
            .FirstOrDefaultAsync(u => u.Id == userId);

        if (user == null) return NotFound(new { error = "User not found" });

        if (user.Quota == null)
        {
            user.Quota = new UserQuota
            {
                UserId = user.Id,
                MaxStorageBytes = request.MaxStorageBytes ?? defaults.MaxStorageBytesPerUser,
                MaxAlbums = request.MaxAlbums
            };
            _db.UserQuotas.Add(user.Quota);
        }
        else
        {
            if (request.MaxStorageBytes.HasValue)
                user.Quota.MaxStorageBytes = request.MaxStorageBytes.Value;
            user.Quota.MaxAlbums = request.MaxAlbums;
            user.Quota.UpdatedAt = DateTime.UtcNow;
        }

        await _db.SaveChangesAsync();

        _logger.AdminQuotaUpdated(userId, admin.Id);

        return Ok(new UserQuotaResponse(
            user.Quota.MaxStorageBytes,
            user.Quota.UsedStorageBytes,
            user.Quota.MaxAlbums ?? defaults.MaxAlbumsPerUser,
            user.Quota.CurrentAlbumCount,
            user.Quota.MaxAlbums.HasValue || user.Quota.MaxStorageBytes != defaults.MaxStorageBytesPerUser
        ));
    }

    /// <summary>
    /// Reset user quota to system defaults
    /// </summary>
    [HttpDelete("{userId:guid}/quota")]
    public async Task<IActionResult> ResetUserQuota(Guid userId)
    {
        var admin = GetAdminUser();
        var defaults = await _quotaService.GetDefaultsAsync();

        var quota = await _db.UserQuotas.FindAsync(userId);
        if (quota == null) return NotFound(new { error = "User quota not found" });

        // Reset to defaults but keep usage tracking
        quota.MaxStorageBytes = defaults.MaxStorageBytesPerUser;
        quota.MaxAlbums = null;
        quota.UpdatedAt = DateTime.UtcNow;

        await _db.SaveChangesAsync();

        _logger.AdminQuotaUpdated(userId, admin.Id);

        return NoContent();
    }

    /// <summary>
    /// Promote user to admin
    /// </summary>
    [HttpPost("{userId:guid}/promote")]
    public async Task<IActionResult> PromoteUser(Guid userId)
    {
        var admin = GetAdminUser();

        var user = await _db.Users.FindAsync(userId);
        if (user == null) return NotFound(new { error = "User not found" });

        if (user.IsAdmin)
            return BadRequest(new { error = "User is already an admin" });

        user.IsAdmin = true;
        await _db.SaveChangesAsync();

        _logger.AdminUserPromoted(userId, admin.Id);

        return NoContent();
    }

    /// <summary>
    /// Demote admin to regular user
    /// </summary>
    [HttpPost("{userId:guid}/demote")]
    public async Task<IActionResult> DemoteUser(Guid userId)
    {
        var admin = GetAdminUser();

        var user = await _db.Users.FindAsync(userId);
        if (user == null) return NotFound(new { error = "User not found" });

        if (!user.IsAdmin)
            return BadRequest(new { error = "User is not an admin" });

        // Prevent demoting the last admin
        var adminCount = await _db.Users.CountAsync(u => u.IsAdmin);
        if (adminCount <= 1)
            return BadRequest(new { error = "Cannot demote the last admin" });

        user.IsAdmin = false;
        await _db.SaveChangesAsync();

        _logger.AdminUserDemoted(userId, admin.Id);

        return NoContent();
    }
}
