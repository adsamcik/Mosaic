using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Extensions;
using tusdotnet.Interfaces;
using tusdotnet.Models;
using tusdotnet.Models.Configuration;

namespace Mosaic.Backend.Services;

public static class TusEventHandlers
{
    private const string ReservedBytesItemKey = "QuotaReservedBytes";
    private const string ReservationUserIdItemKey = "TusReservationUserId";
    private const string ReservationAlbumIdItemKey = "TusReservationAlbumId";
    private static readonly TimeSpan ReservationLifetime = TimeSpan.FromHours(24);

    public static async Task OnBeforeCreate(
        BeforeCreateContext context,
        IServiceProvider services)
    {
        if (context.UploadLength < 0)
        {
            context.FailRequest("Deferred upload length is not supported");
            return;
        }

        var httpContext = context.HttpContext;
        var authSub = httpContext.Items["AuthSub"] as string;

        if (string.IsNullOrEmpty(authSub))
        {
            context.FailRequest("Unauthorized");
            return;
        }

        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var timeProvider = scope.ServiceProvider.GetService<TimeProvider>() ?? TimeProvider.System;

        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.AuthSub == authSub);
        if (user == null)
        {
            context.FailRequest("User not found");
            return;
        }

        var albumId = TryGetAlbumId(context.Metadata);
        if (albumId.HasValue)
        {
            var accessError = await ValidateAlbumAccessAsync(db, albumId.Value, user.Id, timeProvider);
            if (accessError != null)
            {
                context.FailRequest(accessError);
                return;
            }
        }

        var quotaReserved = await AdjustQuotaAsync(db, user.Id, context.UploadLength, enforceLimit: true);
        if (!quotaReserved)
        {
            context.FailRequest("Storage quota exceeded");
            return;
        }

        httpContext.Items[ReservedBytesItemKey] = context.UploadLength;
        httpContext.Items[ReservationUserIdItemKey] = user.Id;
        if (albumId.HasValue)
        {
            httpContext.Items[ReservationAlbumIdItemKey] = albumId.Value;
        }
    }

    public static async Task OnCreateComplete(
        CreateCompleteContext context,
        IServiceProvider services)
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var timeProvider = scope.ServiceProvider.GetService<TimeProvider>() ?? TimeProvider.System;
        var httpContext = context.HttpContext;

        var authSub = httpContext.Items["AuthSub"] as string;
        if (string.IsNullOrEmpty(authSub))
        {
            throw new InvalidOperationException("Missing authenticated user for upload reservation.");
        }

        var userId = httpContext.Items[ReservationUserIdItemKey] as Guid?
            ?? await db.Users
                .AsNoTracking()
                .Where(u => u.AuthSub == authSub)
                .Select(u => (Guid?)u.Id)
                .FirstOrDefaultAsync();

        if (!userId.HasValue)
        {
            throw new InvalidOperationException("Authenticated user not found for upload reservation.");
        }

        var reservation = await db.TusUploadReservations.FindAsync(context.FileId);
        if (reservation == null)
        {
            reservation = new TusUploadReservation
            {
                FileId = context.FileId!,
                UserId = userId.Value
            };
            db.TusUploadReservations.Add(reservation);
        }

        reservation.AlbumId = httpContext.Items[ReservationAlbumIdItemKey] as Guid?
            ?? TryGetAlbumId(context.Metadata);
        reservation.ReservedBytes = httpContext.Items[ReservedBytesItemKey] as long? ?? context.UploadLength;
        reservation.UploadLength = context.UploadLength;
        reservation.ExpiresAt = timeProvider.GetUtcNow().UtcDateTime.Add(ReservationLifetime);
        reservation.CreatedAt = timeProvider.GetUtcNow().UtcDateTime;

        await db.SaveChangesAsync();
    }

    public static async Task OnAuthorize(
        AuthorizeContext context,
        IServiceProvider services)
    {
        if (context.Intent is IntentType.CreateFile or IntentType.GetOptions)
        {
            return;
        }

        var authSub = context.HttpContext.Items["AuthSub"] as string;
        if (string.IsNullOrEmpty(authSub))
        {
            context.FailRequest("Unauthorized");
            return;
        }

        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var timeProvider = scope.ServiceProvider.GetService<TimeProvider>() ?? TimeProvider.System;

        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.AuthSub == authSub);
        if (user == null)
        {
            context.FailRequest("Unauthorized");
            return;
        }

        if (string.IsNullOrWhiteSpace(context.FileId))
        {
            context.FailRequest("Unauthorized");
            return;
        }

        var reservation = await db.TusUploadReservations
            .AsNoTracking()
            .FirstOrDefaultAsync(r => r.FileId == context.FileId);

        if (reservation == null)
        {
            if (context.Intent == IntentType.GetFileInfo
                && Guid.TryParse(context.FileId, out var shardId)
                && await db.Shards.AsNoTracking().AnyAsync(s => s.Id == shardId && s.UploaderId == user.Id))
            {
                return;
            }

            context.FailRequest("Unauthorized");
            return;
        }

        if (reservation.UserId != user.Id)
        {
            context.FailRequest("Unauthorized");
            return;
        }
    }

    public static async Task OnDeleteComplete(
        DeleteCompleteContext context,
        IServiceProvider services)
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();

        var reservation = await db.TusUploadReservations.FindAsync(context.FileId);
        if (reservation == null)
        {
            return;
        }

        await AdjustQuotaAsync(db, reservation.UserId, -reservation.ReservedBytes, enforceLimit: false);
        db.TusUploadReservations.Remove(reservation);
        await db.SaveChangesAsync();
    }

    public static async Task OnFileComplete(
        FileCompleteContext context,
        IServiceProvider services)
    {
        var fileId = context.FileId!;

        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var timeProvider = scope.ServiceProvider.GetService<TimeProvider>() ?? TimeProvider.System;

        var reservation = await db.TusUploadReservations.FirstOrDefaultAsync(r => r.FileId == fileId);
        if (reservation == null)
        {
            throw new InvalidOperationException($"Upload reservation missing for tus file {fileId}.");
        }

        var (fileSize, sha256Hex, metadata) = await ReadUploadAsync(context.Store, fileId, context.CancellationToken);

        if (metadata != null && metadata.TryGetValue("sha256", out var hashMetadata))
        {
            var clientHash = hashMetadata.GetString(Encoding.UTF8);
            if (!Sha256Matches(sha256Hex, clientHash))
            {
                await CleanupFailedUploadAsync(context.Store, fileId, reservation, services, context.CancellationToken);
                throw new InvalidOperationException(
                    $"Integrity check failed: server SHA256 {sha256Hex} does not match client SHA256 {clientHash}");
            }
        }

        var accessError = reservation.AlbumId.HasValue
            ? await ValidateAlbumAccessAsync(db, reservation.AlbumId.Value, reservation.UserId, timeProvider)
            : null;
        if (accessError != null)
        {
            await CleanupFailedUploadAsync(context.Store, fileId, reservation, services, context.CancellationToken);
            throw new InvalidOperationException(accessError);
        }

        await using var tx = await db.Database.BeginTransactionAsync();
        try
        {
            db.Shards.Add(new Shard
            {
                Id = Guid.Parse(fileId),
                UploaderId = reservation.UserId,
                StorageKey = fileId,
                SizeBytes = fileSize,
                Status = ShardStatus.PENDING,
                PendingExpiresAt = timeProvider.GetUtcNow().UtcDateTime.AddHours(24),
                Sha256 = sha256Hex
            });

            var sizeDifference = fileSize - reservation.ReservedBytes;
            var quotaAdjusted = await AdjustQuotaAsync(
                db,
                reservation.UserId,
                sizeDifference,
                enforceLimit: sizeDifference > 0);

            if (!quotaAdjusted)
            {
                throw new InvalidOperationException("Storage quota exceeded");
            }

            db.TusUploadReservations.Remove(reservation);
            await db.SaveChangesAsync(context.CancellationToken);
            await tx.CommitAsync(context.CancellationToken);
        }
        catch
        {
            await tx.RollbackAsync(context.CancellationToken);
            await CleanupFailedUploadAsync(context.Store, fileId, reservation, services, context.CancellationToken);
            throw;
        }
    }

    public static async Task<int> CleanupExpiredReservations(
        IServiceProvider services,
        CancellationToken cancellationToken = default)
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var configuration = scope.ServiceProvider.GetRequiredService<IConfiguration>();
        var timeProvider = scope.ServiceProvider.GetService<TimeProvider>() ?? TimeProvider.System;
        var logger = scope.ServiceProvider.GetService<ILoggerFactory>()?.CreateLogger(typeof(TusEventHandlers).FullName!);

        var tusStore = new tusdotnet.Stores.TusDiskStore(configuration["Storage:Path"] ?? "./data/blobs");
        var deletedCount = 0;

        while (!cancellationToken.IsCancellationRequested)
        {
            var expiredReservations = await db.TusUploadReservations
                .Where(r => r.ExpiresAt <= timeProvider.GetUtcNow().UtcDateTime)
                .OrderBy(r => r.ExpiresAt)
                .Take(100)
                .ToListAsync(cancellationToken);

            if (expiredReservations.Count == 0)
            {
                break;
            }

            foreach (var reservation in expiredReservations)
            {
                if (tusStore is ITusTerminationStore terminationStore)
                {
                    try
                    {
                        await terminationStore.DeleteFileAsync(reservation.FileId, cancellationToken);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        logger?.LogWarning(
                            ex,
                            "Failed to delete expired Tus upload file {FileId}; releasing reservation anyway",
                            reservation.FileId);
                    }
                }

                await AdjustQuotaAsync(db, reservation.UserId, -reservation.ReservedBytes, enforceLimit: false);
                db.TusUploadReservations.Remove(reservation);
                deletedCount++;
            }

            await db.SaveChangesAsync(cancellationToken);
        }

        return deletedCount;
    }

    private static async Task<(long FileSize, string? Sha256Hex, Dictionary<string, tusdotnet.Models.Metadata>? Metadata)> ReadUploadAsync(
        ITusStore store,
        string fileId,
        CancellationToken cancellationToken)
    {
        long fileSize = 0;
        string? sha256Hex = null;
        Dictionary<string, tusdotnet.Models.Metadata>? metadata = null;

        if (store is ITusReadableStore readable)
        {
            var file = await readable.GetFileAsync(fileId, cancellationToken);
            if (file != null)
            {
                using var stream = await file.GetContentAsync(cancellationToken);
                fileSize = stream.Length;
                stream.Position = 0;
                sha256Hex = Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken)).ToLowerInvariant();
                metadata = await file.GetMetadataAsync(cancellationToken);
            }
        }

        return (fileSize, sha256Hex, metadata);
    }

    private static bool Sha256Matches(string? serverSha256Hex, string clientHash)
    {
        var clientSha256Hex = NormalizeSha256Hash(clientHash);
        return serverSha256Hex != null
            && clientSha256Hex != null
            && string.Equals(serverSha256Hex, clientSha256Hex, StringComparison.OrdinalIgnoreCase);
    }

    private static string? NormalizeSha256Hash(string hash)
    {
        var trimmed = hash.Trim();
        if (trimmed.Length == 64 && IsHex(trimmed))
        {
            return trimmed.ToLowerInvariant();
        }

        var normalizedBase64 = trimmed.Replace('-', '+').Replace('_', '/');
        var remainder = normalizedBase64.Length % 4;
        if (remainder == 1)
        {
            return null;
        }

        if (remainder != 0)
        {
            normalizedBase64 = normalizedBase64.PadRight(normalizedBase64.Length + 4 - remainder, '=');
        }

        try
        {
            var bytes = Convert.FromBase64String(normalizedBase64);
            return bytes.Length == SHA256.HashSizeInBytes
                ? Convert.ToHexString(bytes).ToLowerInvariant()
                : null;
        }
        catch (FormatException)
        {
            return null;
        }
    }

    private static bool IsHex(string value)
    {
        foreach (var c in value)
        {
            var isHex = c is >= '0' and <= '9'
                or >= 'a' and <= 'f'
                or >= 'A' and <= 'F';
            if (!isHex)
            {
                return false;
            }
        }

        return true;
    }

    private static async Task CleanupFailedUploadAsync(
        ITusStore store,
        string fileId,
        TusUploadReservation reservation,
        IServiceProvider services,
        CancellationToken cancellationToken)
    {
        if (store is ITusTerminationStore terminationStore)
        {
            await terminationStore.DeleteFileAsync(fileId, cancellationToken);
        }

        using var cleanupScope = services.CreateScope();
        var cleanupDb = cleanupScope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var trackedReservation = await cleanupDb.TusUploadReservations.FindAsync([fileId], cancellationToken);
        if (trackedReservation == null)
        {
            return;
        }

        await AdjustQuotaAsync(cleanupDb, trackedReservation.UserId, -trackedReservation.ReservedBytes, enforceLimit: false);
        cleanupDb.TusUploadReservations.Remove(trackedReservation);
        await cleanupDb.SaveChangesAsync(cancellationToken);
    }

    private static Guid? TryGetAlbumId(Dictionary<string, tusdotnet.Models.Metadata>? metadata)
    {
        if (metadata == null || !metadata.TryGetValue("albumId", out var albumMetadata))
        {
            return null;
        }

        var albumIdStr = albumMetadata.GetString(Encoding.UTF8);
        return Guid.TryParse(albumIdStr, out var albumId) ? albumId : null;
    }

    private static async Task<string?> ValidateAlbumAccessAsync(MosaicDbContext db, Guid albumId, Guid userId, TimeProvider timeProvider)
    {
        var album = await db.Albums.AsNoTracking().FirstOrDefaultAsync(a => a.Id == albumId);
        if (album == null)
        {
            return "Album not found";
        }

        if (album.ExpiresAt.HasValue && album.ExpiresAt.Value <= timeProvider.GetUtcNow())
        {
            return "Album has expired";
        }

        var isMember = await db.AlbumMembers
            .AsNoTracking()
            .AnyAsync(am => am.AlbumId == albumId && am.UserId == userId && am.RevokedAt == null);
        if (!isMember)
        {
            return "Access denied";
        }

        return null;
    }

    private static async Task<bool> AdjustQuotaAsync(
        MosaicDbContext db,
        Guid userId,
        long deltaBytes,
        bool enforceLimit)
    {
        if (deltaBytes == 0)
        {
            return true;
        }

        int rowsAffected;
        if (deltaBytes > 0)
        {
            if (db.UsesLiteProvider())
            {
                rowsAffected = await db.Database.ExecuteSqlRawAsync(
                    "UPDATE user_quotas SET used_storage_bytes = used_storage_bytes + {0}, updated_at = datetime('now') WHERE user_id = {1} AND used_storage_bytes + {0} <= max_storage_bytes",
                    deltaBytes,
                    userId);
            }
            else
            {
                rowsAffected = await db.Database.ExecuteSqlRawAsync(
                    "UPDATE user_quotas SET used_storage_bytes = used_storage_bytes + {0}, updated_at = NOW() WHERE user_id = {1} AND used_storage_bytes + {0} <= max_storage_bytes",
                    deltaBytes,
                    userId);
            }

            if (!enforceLimit)
            {
                return rowsAffected > 0 || !await db.UserQuotas.AnyAsync(q => q.UserId == userId);
            }

            if (rowsAffected == 0)
            {
                var quotaExists = await db.UserQuotas.AnyAsync(q => q.UserId == userId);
                return !quotaExists;
            }

            return true;
        }

        if (db.UsesLiteProvider())
        {
            rowsAffected = await db.Database.ExecuteSqlRawAsync(
                "UPDATE user_quotas SET used_storage_bytes = MAX(0, used_storage_bytes + {0}), updated_at = datetime('now') WHERE user_id = {1}",
                deltaBytes,
                userId);
        }
        else
        {
            rowsAffected = await db.Database.ExecuteSqlRawAsync(
                "UPDATE user_quotas SET used_storage_bytes = GREATEST(0, used_storage_bytes + {0}), updated_at = NOW() WHERE user_id = {1}",
                deltaBytes,
                userId);
        }

        return rowsAffected > 0 || !await db.UserQuotas.AnyAsync(q => q.UserId == userId);
    }
}
