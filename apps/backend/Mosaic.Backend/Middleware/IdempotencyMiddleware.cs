using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Primitives;
using Mosaic.Backend.Data;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Middleware;

public sealed class IdempotencyMiddleware
{
    public const string HeaderName = "Idempotency-Key";
    private static readonly TimeSpan DefaultTtl = TimeSpan.FromHours(24);
    private static readonly HashSet<string> CachedResponseHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "Content-Type",
        "Location",
        "Tus-Resumable",
        "Upload-Offset",
        "Upload-Length"
    };

    private readonly RequestDelegate _next;
    private readonly ILogger<IdempotencyMiddleware> _logger;
    private readonly TimeProvider _timeProvider;
    private readonly TimeSpan _ttl;

    public IdempotencyMiddleware(
        RequestDelegate next,
        ILogger<IdempotencyMiddleware> logger,
        IConfiguration configuration,
        TimeProvider timeProvider)
    {
        _next = next;
        _logger = logger;
        _timeProvider = timeProvider;
        _ttl = configuration.GetValue("Idempotency:RecordTtlHours", DefaultTtl.TotalHours) is var hours && hours > 0
            ? TimeSpan.FromHours(hours)
            : DefaultTtl;
    }

    public async Task InvokeAsync(HttpContext context, MosaicDbContext db, ICurrentUserService currentUserService)
    {
        if (!ShouldApply(context.Request, out var idempotencyKey))
        {
            await _next(context);
            return;
        }

        var user = await currentUserService.GetOrCreateAsync(context);
        var requestHash = await ComputeRequestHashAsync(context.Request);
        var now = _timeProvider.GetUtcNow();
        var expiresBefore = now.Subtract(_ttl);

        var existing = await db.IdempotencyRecords
            .FirstOrDefaultAsync(record =>
                record.UserId == user.Id &&
                record.IdempotencyKey == idempotencyKey);

        if (existing != null && existing.CreatedAt <= expiresBefore)
        {
            db.IdempotencyRecords.Remove(existing);
            await db.SaveChangesAsync(context.RequestAborted);
            existing = null;
        }

        if (existing != null)
        {
            if (!CryptographicOperations.FixedTimeEquals(existing.RequestHash, requestHash))
            {
                context.Response.StatusCode = StatusCodes.Status409Conflict;
                await context.Response.WriteAsJsonAsync(new
                {
                    error = "Idempotency-Key conflict",
                    detail = "The same Idempotency-Key was used with a different request payload."
                }, context.RequestAborted);
                return;
            }

            var actualResponseBodyHash = SHA256.HashData(existing.ResponseBody);
            if (!CryptographicOperations.FixedTimeEquals(existing.ResponseBodyHash, actualResponseBodyHash))
            {
                _logger.LogWarning("Idempotency record integrity check failed for user {UserId}", user.Id);
                db.IdempotencyRecords.Remove(existing);
                await db.SaveChangesAsync(context.RequestAborted);
                existing = null;
            }
        }

        if (existing != null)
        {
            context.Response.StatusCode = existing.ResponseStatus;
            foreach (var header in DeserializeHeaders(existing.ResponseHeadersSubset))
            {
                context.Response.Headers[header.Key] = new StringValues(header.Value.ToArray());
            }

            context.Response.Headers["Idempotency-Replayed"] = "true";
            await context.Response.Body.WriteAsync(existing.ResponseBody, context.RequestAborted);
            return;
        }

        var originalBody = context.Response.Body;
        await using var responseBuffer = new MemoryStream();
        context.Response.Body = responseBuffer;

        try
        {
            await _next(context);

            responseBuffer.Position = 0;
            var responseBody = responseBuffer.ToArray();
            var responseBodyHash = SHA256.HashData(responseBody);
            var headersSubset = SerializeHeaders(context.Response.Headers);

            db.IdempotencyRecords.Add(new()
            {
                UserId = user.Id,
                IdempotencyKey = idempotencyKey,
                RequestHash = requestHash,
                ResponseStatus = context.Response.StatusCode,
                ResponseBodyHash = responseBodyHash,
                ResponseBody = responseBody,
                ResponseHeadersSubset = headersSubset,
                CreatedAt = now
            });
            await db.SaveChangesAsync(context.RequestAborted);

            responseBuffer.Position = 0;
            await responseBuffer.CopyToAsync(originalBody, context.RequestAborted);
        }
        catch (DbUpdateException ex)
        {
            _logger.LogWarning(ex, "Failed to store idempotency record for user {UserId}", user.Id);
            responseBuffer.Position = 0;
            await responseBuffer.CopyToAsync(originalBody, context.RequestAborted);
        }
        finally
        {
            context.Response.Body = originalBody;
        }
    }

    private static bool ShouldApply(HttpRequest request, out string idempotencyKey)
    {
        idempotencyKey = request.Headers[HeaderName].FirstOrDefault() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(idempotencyKey))
        {
            return false;
        }

        if (idempotencyKey.Length > 255)
        {
            idempotencyKey = idempotencyKey[..255];
        }

        if (HttpMethods.IsPatch(request.Method)
            && request.Path.StartsWithSegments("/api/files", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return HttpMethods.IsPost(request.Method)
            || HttpMethods.IsPut(request.Method)
            || HttpMethods.IsPatch(request.Method)
            || HttpMethods.IsDelete(request.Method);
    }

    private static async Task<byte[]> ComputeRequestHashAsync(HttpRequest request)
    {
        request.EnableBuffering();
        request.Body.Position = 0;
        await using var payload = new MemoryStream();
        await request.Body.CopyToAsync(payload, request.HttpContext.RequestAborted);
        request.Body.Position = 0;

        using var sha = SHA256.Create();
        await AppendAsync(sha, request.Method);
        await AppendAsync(sha, request.Path.Value ?? string.Empty);
        await AppendAsync(sha, request.QueryString.Value ?? string.Empty);
        await AppendAsync(sha, request.ContentType ?? string.Empty);
        await AppendHeaderAsync(sha, request.Headers, "Tus-Resumable");
        await AppendHeaderAsync(sha, request.Headers, "Upload-Length");
        await AppendHeaderAsync(sha, request.Headers, "Upload-Metadata");
        sha.TransformBlock(payload.ToArray(), 0, (int)payload.Length, null, 0);
        sha.TransformFinalBlock([], 0, 0);
        return sha.Hash!;
    }

    private static Task AppendHeaderAsync(HashAlgorithm sha, IHeaderDictionary headers, string name)
        => AppendAsync(sha, $"{name}:{headers[name].ToString()}");

    private static Task AppendAsync(HashAlgorithm sha, string value)
    {
        var bytes = Encoding.UTF8.GetBytes(value);
        sha.TransformBlock(bytes, 0, bytes.Length, null, 0);
        sha.TransformBlock([0], 0, 1, null, 0);
        return Task.CompletedTask;
    }

    private static string SerializeHeaders(IHeaderDictionary headers)
    {
        var subset = headers
            .Where(header => CachedResponseHeaders.Contains(header.Key))
            .ToDictionary(
                header => header.Key,
                header => header.Value.ToArray(),
                StringComparer.OrdinalIgnoreCase);

        return JsonSerializer.Serialize(subset);
    }

    private static Dictionary<string, string[]> DeserializeHeaders(string json)
    {
        return JsonSerializer.Deserialize<Dictionary<string, string[]>>(json) ?? [];
    }
}
