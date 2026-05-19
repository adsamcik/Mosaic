using Microsoft.AspNetCore.Mvc;
using Mosaic.Backend.Data;
using Mosaic.Backend.Models.Admin;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("api/v1/admin/settings")]
[ApiExplorerSettings(IgnoreApi = true)]
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

        // Positivity bounds are declared via [Range] on UpdateQuotaDefaultsRequest
        // (v1.0.1 s36). In the ASP.NET pipeline [ApiController] auto-translates
        // DataAnnotation failures to 400 before the action runs; this explicit
        // TryValidateModel call preserves the same contract when the controller
        // is invoked directly (unit tests).
        if (!TryValidateModel(request))
        {
            return ValidationProblem(ModelState);
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
