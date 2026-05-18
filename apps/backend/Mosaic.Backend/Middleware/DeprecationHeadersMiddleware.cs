using System.Globalization;

namespace Mosaic.Backend.Middleware;

/// <summary>
/// Marks a controller action (or controller class) as deprecated for the purposes
/// of RFC 8594 — emits <c>Deprecation:</c> and <c>Sunset:</c> response headers, plus
/// an optional <c>Link: rel="successor-version"</c> pointing at the replacement.
/// </summary>
/// <remarks>
/// <para>
/// No routes are deprecated today; the infrastructure exists so that future
/// deprecation is mechanical:
/// </para>
/// <example>
/// <code>
/// [DeprecatedRoute(
///     DeprecationDate = "2026-12-01",
///     SunsetDate      = "2027-01-01",
///     Link            = "https://docs.mosaic.example/api/v2/albums")]
/// [HttpGet("/api/v1/albums-legacy")]
/// public IActionResult ListAlbumsLegacy() { ... }
/// </code>
/// </example>
/// <para>
/// Dates MUST be ISO-8601 calendar dates (<c>YYYY-MM-DD</c>) interpreted as
/// midnight UTC. They are converted to RFC 7231 IMF-fixdate strings (per
/// RFC 8594 §2 / §3) when emitted on the wire. Invalid dates fail fast at
/// startup the first time the attribute is reflected on a matched endpoint.
/// </para>
/// </remarks>
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class, AllowMultiple = false, Inherited = true)]
public sealed class DeprecatedRouteAttribute : Attribute
{
    /// <summary>ISO-8601 date (<c>YYYY-MM-DD</c>, UTC) when the route became deprecated.</summary>
    public string? DeprecationDate { get; init; }

    /// <summary>ISO-8601 date (<c>YYYY-MM-DD</c>, UTC) when the route will be removed. Required.</summary>
    public required string SunsetDate { get; init; }

    /// <summary>Optional absolute URL of the successor (used as <c>Link; rel="successor-version"</c>).</summary>
    public string? Link { get; init; }
}

/// <summary>
/// Emits RFC 8594 <c>Deprecation</c>, <c>Sunset</c>, and successor-version <c>Link</c> headers
/// when the matched endpoint carries a <see cref="DeprecatedRouteAttribute"/>.
/// </summary>
/// <remarks>
/// Must run after routing (i.e. after the implicit <c>UseRouting</c>) so that
/// <c>HttpContext.GetEndpoint()</c> returns the matched endpoint. Headers are
/// attached via <c>Response.OnStarting</c> so they survive controller-set status
/// codes, including error responses produced by the controller.
/// </remarks>
public sealed class DeprecationHeadersMiddleware
{
    private readonly RequestDelegate _next;

    public DeprecationHeadersMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public Task InvokeAsync(HttpContext context)
    {
        var endpoint = context.GetEndpoint();
        var attr = endpoint?.Metadata.GetMetadata<DeprecatedRouteAttribute>();
        if (attr is not null)
        {
            var sunsetHttpDate = ToHttpDate(attr.SunsetDate, nameof(DeprecatedRouteAttribute.SunsetDate));
            string? deprecationHttpDate = attr.DeprecationDate is null
                ? null
                : ToHttpDate(attr.DeprecationDate, nameof(DeprecatedRouteAttribute.DeprecationDate));

            // RFC 8594 §2: Sunset is an HTTP-date.
            context.Response.Headers["Sunset"] = sunsetHttpDate;

            // RFC 8594 §3: Deprecation is either the literal "true" or an HTTP-date
            // identifying when the resource became deprecated. We prefer the date
            // when available so clients can distinguish past vs upcoming deprecation.
            context.Response.Headers["Deprecation"] = deprecationHttpDate ?? "true";

            if (!string.IsNullOrWhiteSpace(attr.Link))
            {
                // RFC 8288 Link header pointing at the successor resource.
                context.Response.Headers.Append("Link", $"<{attr.Link}>; rel=\"successor-version\"");
            }
        }

        return _next(context);
    }

    /// <summary>
    /// Converts an ISO-8601 calendar date (interpreted as midnight UTC) to an
    /// RFC 7231 IMF-fixdate string. Throws <see cref="InvalidOperationException"/>
    /// if the input cannot be parsed — the misconfiguration surfaces on the first
    /// request to the deprecated route rather than silently emitting garbage.
    /// </summary>
    private static string ToHttpDate(string isoDate, string fieldName)
    {
        if (!DateTime.TryParseExact(
                isoDate,
                "yyyy-MM-dd",
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out var parsed))
        {
            throw new InvalidOperationException(
                $"DeprecatedRouteAttribute.{fieldName} must be an ISO-8601 date (YYYY-MM-DD); got '{isoDate}'.");
        }

        // "R" -> RFC 1123 / RFC 7231 IMF-fixdate (e.g. "Fri, 01 Jan 2027 00:00:00 GMT").
        return parsed.ToString("R", CultureInfo.InvariantCulture);
    }
}
