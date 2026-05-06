using System.Collections.Concurrent;
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
    private static readonly ConcurrentDictionary<string, InProcessLockState> InProcessLocks = new();
    private const string PostgreSqlProviderName = "Npgsql.EntityFrameworkCore.PostgreSQL";

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

        if (string.Equals(db.Database.ProviderName, PostgreSqlProviderName, StringComparison.Ordinal))
        {
            await using var transaction = await db.Database.BeginTransactionAsync(context.RequestAborted);
            await AcquirePostgreSqlAdvisoryLockAsync(db, user.Id, idempotencyKey, context.RequestAborted);
            var pendingResponse = await HandleSerializedAsync(context, db, user.Id, idempotencyKey, requestHash, now, expiresBefore, deferExecutedResponse: true);
            await transaction.CommitAsync(CancellationToken.None);
            if (pendingResponse != null)
            {
                await pendingResponse.CopyToAsync(context.RequestAborted);
            }
            return;
        }

        await using var inProcessLock = await AcquireInProcessLockAsync($"{user.Id:N}:{idempotencyKey}", context.RequestAborted);
        try
        {
            await HandleSerializedAsync(context, db, user.Id, idempotencyKey, requestHash, now, expiresBefore, deferExecutedResponse: false);
        }
        finally
        {
            inProcessLock.Release();
        }
    }

    private async Task<PendingResponseCopy?> HandleSerializedAsync(
        HttpContext context,
        MosaicDbContext db,
        Guid userId,
        string idempotencyKey,
        byte[] requestHash,
        DateTimeOffset now,
        DateTimeOffset expiresBefore,
        bool deferExecutedResponse)
    {
        var existing = await db.IdempotencyRecords
            .FirstOrDefaultAsync(record =>
                record.UserId == userId &&
                record.IdempotencyKey == idempotencyKey,
                context.RequestAborted);

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
                return null;
            }

            var actualResponseBodyHash = SHA256.HashData(existing.ResponseBody);
            if (!CryptographicOperations.FixedTimeEquals(existing.ResponseBodyHash, actualResponseBodyHash))
            {
                _logger.LogWarning("Idempotency record integrity check failed for user {UserId}", userId);
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
            return null;
        }

        var originalBody = context.Response.Body;
        await using var responseBuffer = new MemoryStream();
        context.Response.Body = responseBuffer;

        try
        {
            await _next(context);

            responseBuffer.Position = 0;
            var responseBody = responseBuffer.ToArray();
            if (context.Response.StatusCode < StatusCodes.Status500InternalServerError)
            {
                var responseBodyHash = SHA256.HashData(responseBody);
                var headersSubset = SerializeHeaders(context.Response.Headers);

                db.IdempotencyRecords.Add(new()
                {
                    UserId = userId,
                    IdempotencyKey = idempotencyKey,
                    RequestHash = requestHash,
                    ResponseStatus = context.Response.StatusCode,
                    ResponseBodyHash = responseBodyHash,
                    ResponseBody = responseBody,
                    ResponseHeadersSubset = headersSubset,
                    CreatedAt = now
                });
                await db.SaveChangesAsync(CancellationToken.None);
            }

            context.Response.Body = originalBody;
            if (deferExecutedResponse)
            {
                return new PendingResponseCopy(originalBody, responseBody);
            }

            await originalBody.WriteAsync(responseBody, context.RequestAborted);
            return null;
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

    private static Task AcquirePostgreSqlAdvisoryLockAsync(
        MosaicDbContext db,
        Guid userId,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        var lockKey = ComputeAdvisoryLockKey(userId, idempotencyKey);
        return db.Database.ExecuteSqlRawAsync(
            "SELECT pg_advisory_xact_lock({0})",
            [lockKey],
            cancellationToken);
    }

    private static long ComputeAdvisoryLockKey(Guid userId, string idempotencyKey)
    {
        var bytes = Encoding.UTF8.GetBytes($"{userId:N}:{idempotencyKey}");
        var hash = SHA256.HashData(bytes);
        return BitConverter.ToInt64(hash, 0);
    }

    private static async Task<InProcessLockLease> AcquireInProcessLockAsync(string key, CancellationToken cancellationToken)
    {
        while (true)
        {
            var state = InProcessLocks.GetOrAdd(key, static _ => new InProcessLockState());
            if (!state.TryAddReference())
            {
                continue;
            }

            try
            {
                await state.Semaphore.WaitAsync(cancellationToken);
                return new InProcessLockLease(key, state);
            }
            catch
            {
                ReleaseInProcessLock(key, state, releaseSemaphore: false);
                throw;
            }
        }
    }

    private static void ReleaseInProcessLock(string key, InProcessLockState state, bool releaseSemaphore)
    {
        if (releaseSemaphore)
        {
            state.Semaphore.Release();
        }

        if (state.ReleaseReference())
        {
            InProcessLocks.TryRemove(new KeyValuePair<string, InProcessLockState>(key, state));
            state.Semaphore.Dispose();
        }
    }

    private sealed class PendingResponseCopy(Stream destination, byte[] body)
    {
        public async Task CopyToAsync(CancellationToken cancellationToken)
        {
            await destination.WriteAsync(body, cancellationToken);
        }
    }

    private sealed class InProcessLockState
    {
        public SemaphoreSlim Semaphore { get; } = new(1, 1);

        private int _referenceCount;
        private bool _retired;

        public bool TryAddReference()
        {
            lock (this)
            {
                if (_retired)
                {
                    return false;
                }

                _referenceCount++;
                return true;
            }
        }

        public bool ReleaseReference()
        {
            lock (this)
            {
                _referenceCount--;
                if (_referenceCount != 0)
                {
                    return false;
                }

                _retired = true;
                return true;
            }
        }
    }

    private sealed class InProcessLockLease(string key, InProcessLockState state) : IAsyncDisposable
    {
        private int _released;

        public void Release()
        {
            if (Interlocked.Exchange(ref _released, 1) == 0)
            {
                ReleaseInProcessLock(key, state, releaseSemaphore: true);
            }
        }

        public ValueTask DisposeAsync()
        {
            Release();
            return ValueTask.CompletedTask;
        }
    }
}
