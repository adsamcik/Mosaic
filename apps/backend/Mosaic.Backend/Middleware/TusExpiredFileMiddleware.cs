using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Localization;
using Mosaic.Backend.Localization;

namespace Mosaic.Backend.Middleware;

/// <summary>
/// Translates the bare-404 that tusdotnet emits when a client tries to resume
/// (HEAD/PATCH) or read (GET) an upload whose file no longer exists into a
/// localized RFC 7807 ProblemDetails response (v1.0.x s44-y5).
///
/// <para>
/// Background: uploads are stored by tusdotnet's <c>TusDiskStore</c>, which
/// returns a flat 404 when the requested file id is not on disk. The most
/// common cause in production is that the GC sweep — or an operator running
/// a manual cleanup — purged the half-finished upload directory after its
/// retention window. Without this middleware the client sees an opaque 404
/// indistinguishable from "you typed the wrong URL", which masks the fact
/// that the correct recovery is "restart the upload from offset 0", not
/// "retry the resume".
/// </para>
///
/// <para>
/// The middleware buffers the response from the downstream Tus pipeline. If
/// the path is <c>/api/v1/files/{fileId}</c>, the method is one of HEAD /
/// PATCH / GET (the Tus operations that target an existing file), and the
/// downstream returned 404, we replace the empty body with a localized
/// ProblemDetails carrying <c>type=upload-session-expired</c>. POST (upload
/// creation) is left alone — a 404 there is a genuine route mismatch. All
/// non-404 responses pass through verbatim, including the response body
/// stream, so the hot upload path is untouched.
/// </para>
/// </summary>
public sealed class TusExpiredFileMiddleware
{
    private const string TusMountPath = "/api/v1/files/";
    private const string ProblemTypeUri = "https://docs.mosaic.app/errors/upload-session-expired";

    private readonly RequestDelegate _next;

    public TusExpiredFileMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(
        HttpContext context,
        IStringLocalizer<ProblemDetailsMessages> localizer)
    {
        if (!ShouldIntercept(context.Request))
        {
            await _next(context);
            return;
        }

        var originalBody = context.Response.Body;
        await using var captured = new MemoryStream();
        context.Response.Body = captured;

        try
        {
            await _next(context);
        }
        catch
        {
            context.Response.Body = originalBody;
            throw;
        }

        if (context.Response.StatusCode != StatusCodes.Status404NotFound)
        {
            captured.Position = 0;
            context.Response.Body = originalBody;
            // Forward the buffered bytes (if any). For 200/204 Tus responses
            // these will typically be empty, but we must not drop any payload
            // the downstream wrote.
            if (captured.Length > 0)
            {
                await captured.CopyToAsync(originalBody, context.RequestAborted);
            }
            return;
        }

        // 404 → rewrite to ProblemDetails. The captured downstream body is
        // discarded; tusdotnet's text/plain "File not found" message would
        // only confuse the client.
        context.Response.Body = originalBody;
        context.Response.StatusCode = StatusCodes.Status404NotFound;
        context.Response.ContentType = "application/problem+json";
        // Clear any Content-Length tusdotnet set for its discarded body.
        context.Response.Headers.ContentLength = null;

        var problem = new ProblemDetails
        {
            Type = ProblemTypeUri,
            Status = StatusCodes.Status404NotFound,
            Title = localizer["Upload session expired"],
            Detail = localizer["The upload session for this file has expired or was garbage-collected. Start a new upload."],
            Instance = context.Request.Path,
        };
        problem.Extensions["correlationId"] = context.GetCorrelationId() ?? context.TraceIdentifier;

        await JsonSerializer.SerializeAsync(
            context.Response.Body,
            problem,
            new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            },
            context.RequestAborted);
    }

    private static bool ShouldIntercept(HttpRequest request)
    {
        if (!request.Path.HasValue) return false;
        if (!request.Path.Value!.StartsWith(TusMountPath, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        // Path must include a non-empty file id segment (i.e. NOT the bare
        // mount point used by POST upload creation).
        if (request.Path.Value!.Length <= TusMountPath.Length) return false;

        return HttpMethods.IsHead(request.Method)
            || HttpMethods.IsPatch(request.Method)
            || HttpMethods.IsGet(request.Method);
    }
}
