using System.Collections.Concurrent;
using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Primitives;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;

namespace Mosaic.Backend.Middleware;

public sealed class IdempotencyMiddleware
{
    public const string HeaderName = "Idempotency-Key";
    // v1.0.2 s36: explicit length cap on Idempotency-Key. Previously silently
    // truncated to 255 chars, which could cause two distinct keys to collide
    // on the first 255 chars and erroneously share a replay record. Now we
    // reject with 400 so clients see misconfigured clients explicitly.
    public const int MaxKeyLength = 255;
    // v1.0.2 s20: cap on the request body that idempotency will buffer when
    // computing the request hash. Prevents an unauthenticated/authenticated
    // client from forcing the server to read an unbounded body into memory
    // before any downstream limit kicks in. 4 MiB comfortably covers the
    // largest controller payload (manifest create) with headroom.
    public const long MaxBodyBytes = 4L * 1024 * 1024;
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

        // v1.0.2 s36: reject over-length Idempotency-Key explicitly (was silently truncated).
        if (idempotencyKey.Length > MaxKeyLength)
        {
            await WriteProblemAsync(
                context,
                StatusCodes.Status400BadRequest,
                "Invalid Idempotency-Key",
                $"Idempotency-Key must be at most {MaxKeyLength} characters.");
            return;
        }

        // v1.0.2 s20: short-circuit oversize bodies before buffering.
        if (context.Request.ContentLength.HasValue && context.Request.ContentLength.Value > MaxBodyBytes)
        {
            await WriteProblemAsync(
                context,
                StatusCodes.Status413PayloadTooLarge,
                "Request body too large",
                $"Request body exceeds idempotency buffering limit of {MaxBodyBytes} bytes.");
            return;
        }

        var user = await currentUserService.GetOrCreateAsync(context);
        byte[] requestHash;
        try
        {
            requestHash = await ComputeRequestHashAsync(context.Request);
        }
        catch (PayloadTooLargeException)
        {
            await WriteProblemAsync(
                context,
                StatusCodes.Status413PayloadTooLarge,
                "Request body too large",
                $"Request body exceeds idempotency buffering limit of {MaxBodyBytes} bytes.");
            return;
        }
        var now = _timeProvider.GetUtcNow();
        var expiresBefore = now.Subtract(_ttl);

        if (string.Equals(db.Database.ProviderName, PostgreSqlProviderName, StringComparison.Ordinal))
        {
            await InvokeWithPostgreSqlAdvisoryLockAsync(context, db, user.Id, idempotencyKey, requestHash, now, expiresBefore);
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

                // Ordering invariant (v1.0.x s47-y3): the controller's domain
                // transaction (e.g. ManifestsController's BeginTransactionAsync
                // → INSERT manifest+shards → CommitAsync) has already been
                // committed by the time we get here — the response status code
                // is set, and the only thing left is to record the replay
                // cache entry and flush the response to the client. If this
                // IdempotencyRecord save fails on a transient backend error
                // (connection reset, deadlock victim), a client retry of the
                // same Idempotency-Key would see no replay record and re-run
                // the controller, creating a duplicate manifest row.
                //
                // To kill that race, we wrap the save in the provider's
                // execution strategy so transient PostgreSQL errors are
                // automatically retried before we give up. The downstream
                // controller transaction is NOT inside this scope (it has
                // already committed) so there is no nested-transaction hazard.
                // We also defer flushing the response to the client until the
                // record is durably persisted (line 171 below), so a client
                // that sees a 200/201 can rely on the replay cache being live.
                var record = new IdempotencyRecord
                {
                    UserId = userId,
                    IdempotencyKey = idempotencyKey,
                    RequestHash = requestHash,
                    ResponseStatus = context.Response.StatusCode,
                    ResponseBodyHash = responseBodyHash,
                    ResponseBody = responseBody,
                    ResponseHeadersSubset = headersSubset,
                    CreatedAt = now
                };
                var strategy = db.Database.CreateExecutionStrategy();
                await strategy.ExecuteAsync(async () =>
                {
                    if (db.Entry(record).State == EntityState.Detached)
                    {
                        db.IdempotencyRecords.Add(record);
                    }
                    await db.SaveChangesAsync(CancellationToken.None);
                });
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

        // v1.0.2 s36: do NOT silently truncate over-length keys here; the caller
        // checks `idempotencyKey.Length > MaxKeyLength` and returns 400.

        if (HttpMethods.IsPatch(request.Method)
            && request.Path.StartsWithSegments("/api/v1/files", StringComparison.OrdinalIgnoreCase))
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
        // v1.0.2 s20: bounded buffering. EnableBuffering with the explicit cap so
        // ASP.NET Core's request-body buffer also tops out at MaxBodyBytes, and
        // we explicitly verify after the copy in case ContentLength was missing
        // or lied (chunked transfer encoding).
        request.EnableBuffering(bufferThreshold: 64 * 1024, bufferLimit: MaxBodyBytes + 1);
        request.Body.Position = 0;
        await using var payload = new MemoryStream();
        // CopyToAsync with explicit bufferSize; we read at most MaxBodyBytes+1 bytes
        // so we can detect overflow without buffering an unbounded payload.
        var buffer = new byte[81920];
        long total = 0;
        while (true)
        {
            var read = await request.Body.ReadAsync(buffer.AsMemory(), request.HttpContext.RequestAborted);
            if (read == 0) break;
            total += read;
            if (total > MaxBodyBytes)
            {
                throw new PayloadTooLargeException();
            }
            await payload.WriteAsync(buffer.AsMemory(0, read), request.HttpContext.RequestAborted);
        }
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

    private static async Task WriteProblemAsync(HttpContext context, int statusCode, string title, string detail)
    {
        context.Response.StatusCode = statusCode;
        context.Response.ContentType = "application/problem+json";
        await context.Response.WriteAsJsonAsync(new
        {
            type = "about:blank",
            title,
            status = statusCode,
            detail
        }, context.RequestAborted);
    }

    private sealed class PayloadTooLargeException : Exception { }

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

    private async Task InvokeWithPostgreSqlAdvisoryLockAsync(
        HttpContext context,
        MosaicDbContext db,
        Guid userId,
        string idempotencyKey,
        byte[] requestHash,
        DateTimeOffset now,
        DateTimeOffset expiresBefore)
    {
        var lockKey = ComputeAdvisoryLockKey(userId, idempotencyKey);
        var connectionString = db.Database.GetConnectionString()
            ?? throw new InvalidOperationException("PostgreSQL idempotency advisory lock requires a database connection string.");
        PendingResponseCopy? pendingResponse = null;

        await using var lockConnection = new Npgsql.NpgsqlConnection(connectionString);
        await lockConnection.OpenAsync(context.RequestAborted);

        try
        {
            await ExecuteAdvisoryLockCommandAsync(lockConnection, "SELECT pg_advisory_lock(@key)", lockKey, context.RequestAborted);
            pendingResponse = await HandleSerializedAsync(
                context,
                db,
                userId,
                idempotencyKey,
                requestHash,
                now,
                expiresBefore,
                deferExecutedResponse: true);
        }
        finally
        {
            try
            {
                await ExecuteAdvisoryLockCommandAsync(lockConnection, "SELECT pg_advisory_unlock(@key)", lockKey, CancellationToken.None);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to release PostgreSQL idempotency advisory lock {LockKey}", lockKey);
            }
        }

        if (pendingResponse != null)
        {
            await pendingResponse.CopyToAsync(context.RequestAborted);
        }
    }

    private static async Task ExecuteAdvisoryLockCommandAsync(
        Npgsql.NpgsqlConnection connection,
        string commandText,
        long lockKey,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = commandText;
        command.Parameters.AddWithValue("key", lockKey);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    internal static long ComputeAdvisoryLockKey(Guid userId, string idempotencyKey)
    {
        var bytes = Encoding.UTF8.GetBytes($"{userId:N}:{idempotencyKey}");
        var hash = SHA256.HashData(bytes);
        return BinaryPrimitives.ReadInt64LittleEndian(hash);
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
