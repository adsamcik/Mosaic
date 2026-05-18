namespace Mosaic.Backend.Middleware;

/// <summary>
/// Tus 2.0 client rejection per the Tus 1.0 specification:
/// <see href="https://tus.io/protocols/resumable-upload#tus-resumable">tus-resumable §1.0</see>
/// — "If a Server does not support the requested version it MUST respond with
/// the <c>412 Precondition Failed</c> status."
/// </summary>
/// <remarks>
/// <para>
/// Mosaic uses tusdotnet 2.x which speaks only Tus 1.0.0. A future Tus 2.0 client will
/// (per the in-flight 2.0 draft) send <c>Tus-Resumable: 2.0.0</c>; without this gate
/// the request would fall through to <c>MapTus</c>, which silently treats the header
/// as opaque on some sub-routes (notably <c>OPTIONS</c>). This middleware
/// short-circuits with the spec-mandated 412 plus a <c>Tus-Version: 1.0.0</c>
/// advertisement so the client can downgrade.
/// </para>
/// <para>
/// The middleware is intentionally scoped to the Tus mount point (<c>/api/v1/files</c>)
/// — non-Tus routes that happen to carry a <c>Tus-Resumable</c> header (e.g. the
/// idempotency hash material) are unaffected.
/// </para>
/// </remarks>
public sealed class TusVersionMiddleware
{
    private const string TusMountPath = "/api/v1/files";
    private const string SupportedVersion = "1.0.0";

    private readonly RequestDelegate _next;

    public TusVersionMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        if (!context.Request.Path.StartsWithSegments(TusMountPath, StringComparison.OrdinalIgnoreCase))
        {
            await _next(context);
            return;
        }

        var tusResumable = context.Request.Headers["Tus-Resumable"].ToString();
        if (string.IsNullOrEmpty(tusResumable))
        {
            // No header: let tusdotnet handle protocol negotiation (e.g. OPTIONS discovery).
            await _next(context);
            return;
        }

        if (string.Equals(tusResumable, SupportedVersion, StringComparison.Ordinal))
        {
            await _next(context);
            return;
        }

        // Spec-mandated rejection. Must include Tus-Version listing the versions
        // we DO speak so the client can downgrade.
        context.Response.StatusCode = StatusCodes.Status412PreconditionFailed;
        context.Response.Headers["Tus-Version"] = SupportedVersion;
        context.Response.ContentType = "text/plain; charset=utf-8";
        await context.Response.WriteAsync(
            $"Unsupported Tus-Resumable version '{tusResumable}'. This server supports {SupportedVersion}.");
    }
}
