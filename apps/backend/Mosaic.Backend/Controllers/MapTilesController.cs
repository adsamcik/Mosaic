using System.Net;
using System.Net.Http.Headers;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Authorization;

namespace Mosaic.Backend.Controllers;

/// <summary>
/// Server-side proxy for OpenStreetMap raster tiles.
///
/// The web client renders Leaflet maps for photo geolocation. Audit
/// "privacy hygiene C-1": pointing the Leaflet tile layer directly at
/// <c>https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png</c> sends one
/// HTTP request per visible tile to OSM (or any on-path TLS observer)
/// carrying:
///   - the user's IP,
///   - User-Agent,
///   - <c>(z, x, y)</c> coordinates that map directly to where the user
///     is *currently looking*, which for a photo gallery is
///     functionally "where the user's photos were taken".
/// For a zero-knowledge product whose whole purpose is hiding metadata
/// this is the single largest contradiction in the codebase.
///
/// This controller proxies tile fetches through the backend so:
///   - OSM only sees the backend's IP / UA, not the user's;
///   - the request log on the backend can be redacted (only the route
///     template <c>/api/v1/tiles/&lt;redacted&gt;</c> reaches the access
///     log because <c>nginx.conf</c> already does that mapping);
///   - the backend can aggressively cache tiles to amortize the
///     bandwidth cost.
///
/// Operators may override the upstream by setting the configuration key
/// <c>MapTiles:Upstream</c> (e.g. point to a self-hosted
/// <c>tileserver-gl</c>). Default is OSM.
///
/// This endpoint is authentication-required (members can see maps;
/// anonymous share-link visitors do not get the map view today). If
/// that policy changes, this controller will need a separate
/// <c>/api/v1/s/&#123;linkId&#125;/tiles/...</c> sibling — anonymous
/// users must NOT reach this controller because their tile fetches
/// would correlate with their share-link surface.
/// </summary>
[ApiController]
[Route("api/v1/tiles")]
[Authorize]
public sealed class MapTilesController : ControllerBase
{
    private static readonly HttpClient HttpClient = CreateHttpClient();
    private readonly IConfiguration _config;
    private readonly ILogger<MapTilesController> _logger;

    public MapTilesController(IConfiguration config, ILogger<MapTilesController> logger)
    {
        _config = config;
        _logger = logger;
    }

    /// <summary>
    /// Proxy a single OSM raster tile. <c>s</c> is the OSM subdomain
    /// shard letter and is constrained to a single ASCII character to
    /// rule out request smuggling via the route template.
    /// </summary>
    [HttpGet("{z:int}/{x:int}/{y:int}.png")]
    public async Task<IActionResult> GetTile(int z, int x, int y, CancellationToken ct)
    {
        if (z < 0 || z > 20 || x < 0 || y < 0)
        {
            return BadRequest("Invalid tile coordinates");
        }

        var upstream = _config["MapTiles:Upstream"]
            ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

        var url = upstream
            .Replace("{z}", z.ToString())
            .Replace("{x}", x.ToString())
            .Replace("{y}", y.ToString());

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            // Send a polite UA per the OSM tile usage policy.
            // https://operations.osmfoundation.org/policies/tiles/
            request.Headers.UserAgent.ParseAdd("Mosaic-Tile-Proxy/1.0 (self-hosted; contact: see deployment)");

            using var upstreamResponse = await HttpClient.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                ct);

            if (!upstreamResponse.IsSuccessStatusCode)
            {
                _logger.LogWarning(
                    "Upstream tile fetch failed: {Status}",
                    upstreamResponse.StatusCode);
                return StatusCode((int)upstreamResponse.StatusCode);
            }

            var contentType = upstreamResponse.Content.Headers.ContentType?.MediaType
                ?? "image/png";

            Response.Headers.CacheControl = "public, max-age=86400, immutable";
            Response.Headers["X-Mosaic-Tile-Source"] = "proxy";

            var stream = await upstreamResponse.Content.ReadAsStreamAsync(ct);
            return File(stream, contentType);
        }
        catch (OperationCanceledException)
        {
            return new EmptyResult();
        }
        catch (HttpRequestException ex)
        {
            _logger.LogWarning(ex, "Tile fetch HttpRequestException");
            return StatusCode((int)HttpStatusCode.BadGateway);
        }
    }

    private static HttpClient CreateHttpClient()
    {
        var client = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(10),
        };
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("image/png"));
        return client;
    }
}
