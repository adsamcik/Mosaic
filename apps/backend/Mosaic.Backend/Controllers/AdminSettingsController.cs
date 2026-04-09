using Microsoft.AspNetCore.Mvc;
using Mosaic.Backend.Data;
using Mosaic.Backend.Models.Admin;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/admin/settings")]
public class AdminSettingsController : ControllerBase
{
    private readonly MosaicDbContext _db;
    private readonly IQuotaSettingsService _quotaService;
    private readonly ILogger<AdminSettingsController> _logger;

    public AdminSettingsController(
        MosaicDbContext db,
        IQuotaSettingsService quotaService,
        ILogger<AdminSettingsController> logger)
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

    /// <summary>
    /// Get system-wide quota defaults
    /// </summary>
    [HttpGet("quota")]
    public async Task<IActionResult> GetQuotaDefaults()
    {
        var defaults = await _quotaService.GetDefaultsAsync();
        return Ok(defaults);
    }


    /// <summary>
    /// Update system-wide quota defaults
    /// </summary>
    [HttpPut("quota")]
    public async Task<IActionResult> SetQuotaDefaults([FromBody] UpdateQuotaDefaultsRequest request)
    {
        var admin = GetAdminUser();

        if (request.MaxStorageBytesPerUser <= 0)
        {
            return Problem(
                detail: "MaxStorageBytesPerUser must be positive",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (request.MaxAlbumsPerUser <= 0)
        {
            return Problem(
                detail: "MaxAlbumsPerUser must be positive",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (request.MaxPhotosPerAlbum <= 0)
        {
            return Problem(
                detail: "MaxPhotosPerAlbum must be positive",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (request.MaxBytesPerAlbum <= 0)
        {
            return Problem(
                detail: "MaxBytesPerAlbum must be positive",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var defaults = new QuotaDefaults(
            request.MaxStorageBytesPerUser,
            request.MaxAlbumsPerUser,
            request.MaxPhotosPerAlbum,
            request.MaxBytesPerAlbum
        );

        var result = await _quotaService.SetDefaultsAsync(defaults, admin.Id);
        return Ok(result);
    }
}
