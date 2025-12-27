using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;

namespace Mosaic.Backend.Controllers;

[ApiController]
[Route("health")]
public class HealthController : ControllerBase
{
    private readonly MosaicDbContext _db;

    public HealthController(MosaicDbContext db) => _db = db;

    [HttpGet]
    public async Task<IActionResult> Get()
    {
        try
        {
            await _db.Database.ExecuteSqlRawAsync("SELECT 1");
            return Ok(new { status = "healthy", timestamp = DateTime.UtcNow });
        }
        catch
        {
            return StatusCode(503, new { status = "unhealthy" });
        }
    }
}
