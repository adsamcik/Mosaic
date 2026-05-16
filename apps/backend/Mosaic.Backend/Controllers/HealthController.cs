using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;

namespace Mosaic.Backend.Controllers;

/// <summary>
/// Liveness + readiness probes (batch 7 — D3, audit observability D-3).
///
/// <list type="bullet">
/// <item>
///   <c>GET /health/live</c> — liveness: returns 200 as long as the
///   process is responsive. Does NOT touch the database. Used by
///   orchestrators (Docker / k8s) to decide whether to restart the
///   container. If this returns non-200 the process is hung and should
///   be killed.
/// </item>
/// <item>
///   <c>GET /health/ready</c> — readiness: checks downstream
///   dependencies (currently: database connectivity). Returns 503
///   while the process is alive but cannot serve traffic correctly.
///   Orchestrators stop routing requests to a non-ready instance
///   without restarting it.
/// </item>
/// <item>
///   <c>GET /health</c> — legacy combined probe. Behaves as
///   <c>/health/ready</c> (DB-checked) and is retained for backward
///   compatibility with existing Dockerfiles and external monitors.
/// </item>
/// </list>
/// </summary>
[ApiController]
[Route("health")]
public class HealthController : ControllerBase
{
    private readonly MosaicDbContext _db;

    public HealthController(MosaicDbContext db) => _db = db;

    /// <summary>
    /// Legacy combined health probe. Equivalent to <see cref="Ready"/>.
    /// Kept stable so existing container health checks keep working.
    /// </summary>
    [HttpGet]
    public Task<IActionResult> Get() => Ready();

    /// <summary>
    /// Liveness probe. No downstream dependencies — returns 200 as
    /// long as the request loop is responsive. Restart-on-fail signal.
    /// </summary>
    [HttpGet("live")]
    public IActionResult Live()
    {
        return Ok(new { status = "alive", timestamp = DateTime.UtcNow });
    }

    /// <summary>
    /// Readiness probe. Verifies the database is reachable. Returns
    /// 503 with a stable JSON body when downstream is broken so an
    /// orchestrator can stop routing traffic without restarting the
    /// process (a restart would not fix a downed database).
    /// </summary>
    [HttpGet("ready")]
    public async Task<IActionResult> Ready()
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
