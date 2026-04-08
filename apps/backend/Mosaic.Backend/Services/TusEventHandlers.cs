using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using tusdotnet.Interfaces;
using tusdotnet.Models.Configuration;

namespace Mosaic.Backend.Services;

public static class TusEventHandlers
{
    public static async Task OnBeforeCreate(
        BeforeCreateContext context,
        IServiceProvider services)
    {
        var httpContext = context.HttpContext;
        var authSub = httpContext.Items["AuthSub"] as string;

        if (string.IsNullOrEmpty(authSub))
        {
            context.FailRequest("Unauthorized");
            return;
        }

        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();

        var user = await db.Users.FirstOrDefaultAsync(u => u.AuthSub == authSub);
        if (user == null)
        {
            context.FailRequest("User not found");
            return;
        }

        // Check if the target album has expired and user is a member
        if (context.Metadata.ContainsKey("albumId"))
        {
            var albumIdStr = context.Metadata["albumId"].GetString(Encoding.UTF8);
            if (Guid.TryParse(albumIdStr, out var albumId))
            {
                var album = await db.Albums.AsNoTracking().FirstOrDefaultAsync(a => a.Id == albumId);
                if (album != null && album.ExpiresAt.HasValue && album.ExpiresAt.Value <= DateTimeOffset.UtcNow)
                {
                    context.FailRequest("Album has expired");
                    return;
                }

                // Verify user is an active member of the album
                var isMember = await db.AlbumMembers
                    .AsNoTracking()
                    .AnyAsync(am => am.AlbumId == albumId && am.UserId == user.Id && am.RevokedAt == null);
                if (!isMember)
                {
                    context.FailRequest("Access denied");
                    return;
                }
            }
        }

        // Atomic quota reservation: prevents TOCTOU race condition with parallel uploads.
        // Uses conditional UPDATE so concurrent requests cannot all pass the check.
        var uploadLength = context.UploadLength;
        var useSqlite = db.Database.ProviderName?.Contains("Sqlite") == true;
        int rowsAffected;

        if (useSqlite)
        {
            rowsAffected = await db.Database.ExecuteSqlRawAsync(
                "UPDATE user_quotas SET used_storage_bytes = used_storage_bytes + {0}, updated_at = datetime('now') WHERE user_id = {1} AND used_storage_bytes + {0} <= max_storage_bytes",
                uploadLength, user.Id);
        }
        else
        {
            rowsAffected = await db.Database.ExecuteSqlRawAsync(
                "UPDATE user_quotas SET used_storage_bytes = used_storage_bytes + {0}, updated_at = NOW() WHERE user_id = {1} AND used_storage_bytes + {0} <= max_storage_bytes",
                uploadLength, user.Id);
        }

        // If no rows updated, either no quota row (unlimited) or quota exceeded
        if (rowsAffected == 0)
        {
            // Check if a quota row exists — if it does, the update failed due to the constraint
            var quotaExists = await db.UserQuotas.AnyAsync(q => q.UserId == user.Id);
            if (quotaExists)
            {
                context.FailRequest("Storage quota exceeded");
                return;
            }
            // No quota record = unlimited uploads, allow through
        }

        // Store reservation info so OnFileComplete can reconcile
        httpContext.Items["QuotaReservedBytes"] = uploadLength;
    }

    public static async Task OnFileComplete(
        FileCompleteContext context,
        IServiceProvider services)
    {
        var httpContext = context.HttpContext;
        var authSub = (string)httpContext.Items["AuthSub"]!;
        var fileId = context.FileId!;

        // Get file size and compute SHA256 from the store
        long fileSize = 0;
        string? sha256Hex = null;
        
        if (context.Store is ITusReadableStore readable)
        {
            var file = await readable.GetFileAsync(fileId, context.CancellationToken);
            if (file != null)
            {
                using var stream = await file.GetContentAsync(context.CancellationToken);
                fileSize = stream.Length;
                
                // Compute SHA256 for transport integrity verification
                stream.Position = 0;
                using var sha256 = SHA256.Create();
                var hashBytes = await sha256.ComputeHashAsync(stream, context.CancellationToken);
                sha256Hex = Convert.ToHexString(hashBytes).ToLowerInvariant();
            }
        }

        // Verify upload integrity against client-provided hash
        Dictionary<string, tusdotnet.Models.Metadata>? metadata = null;
        if (context.Store is ITusReadableStore readableForMeta)
        {
            var metaFile = await readableForMeta.GetFileAsync(fileId, context.CancellationToken);
            if (metaFile != null)
                metadata = await metaFile.GetMetadataAsync(context.CancellationToken);
        }

        if (metadata != null && metadata.ContainsKey("sha256"))
        {
            var clientHash = metadata["sha256"].GetString(Encoding.UTF8);
            if (!string.Equals(sha256Hex, clientHash, StringComparison.OrdinalIgnoreCase))
            {
                // Clean up: delete the corrupted file from the store
                if (context.Store is ITusTerminationStore terminationStore)
                {
                    await terminationStore.DeleteFileAsync(fileId, context.CancellationToken);
                }

                // Refund the reserved quota since the upload is rejected
                using var cleanupScope = services.CreateScope();
                var cleanupDb = cleanupScope.ServiceProvider.GetRequiredService<MosaicDbContext>();
                var cleanupUser = await cleanupDb.Users.FirstOrDefaultAsync(u => u.AuthSub == authSub);
                if (cleanupUser != null)
                {
                    var reservedBytes = httpContext.Items["QuotaReservedBytes"] as long? ?? fileSize;
                    var useSqliteCleanup = cleanupDb.Database.ProviderName?.Contains("Sqlite") == true;
                    if (useSqliteCleanup)
                    {
                        await cleanupDb.Database.ExecuteSqlRawAsync(
                            "UPDATE user_quotas SET used_storage_bytes = MAX(0, used_storage_bytes - {0}), updated_at = datetime('now') WHERE user_id = {1}",
                            reservedBytes, cleanupUser.Id);
                    }
                    else
                    {
                        await cleanupDb.Database.ExecuteSqlRawAsync(
                            "UPDATE user_quotas SET used_storage_bytes = GREATEST(0, used_storage_bytes - {0}), updated_at = NOW() WHERE user_id = {1}",
                            reservedBytes, cleanupUser.Id);
                    }
                }

                throw new Exception($"Integrity check failed: server SHA256 {sha256Hex} does not match client SHA256 {clientHash}");
            }
        }

        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var useSqlite = db.Database.ProviderName?.Contains("Sqlite") == true;

        await using var tx = await db.Database.BeginTransactionAsync();

        var user = await db.Users.FirstOrDefaultAsync(u => u.AuthSub == authSub);

        // Create PENDING shard with computed SHA256
        db.Shards.Add(new Shard
        {
            Id = Guid.Parse(fileId),
            UploaderId = user!.Id,
            StorageKey = fileId,
            SizeBytes = fileSize,
            Status = ShardStatus.PENDING,
            PendingExpiresAt = DateTime.UtcNow.AddHours(24),
            Sha256 = sha256Hex
        });

        // Reconcile quota: reservation was based on declared upload length,
        // adjust for actual file size difference
        var reservedSize = httpContext.Items["QuotaReservedBytes"] as long? ?? 0;
        var sizeDifference = fileSize - reservedSize;
        if (sizeDifference != 0)
        {
            if (useSqlite)
            {
                await db.Database.ExecuteSqlRawAsync(
                    "UPDATE user_quotas SET used_storage_bytes = MAX(0, used_storage_bytes + {0}), updated_at = datetime('now') WHERE user_id = {1}",
                    sizeDifference, user.Id);
            }
            else
            {
                await db.Database.ExecuteSqlRawAsync(
                    "UPDATE user_quotas SET used_storage_bytes = GREATEST(0, used_storage_bytes + {0}), updated_at = NOW() WHERE user_id = {1}",
                    sizeDifference, user.Id);
            }
        }

        await db.SaveChangesAsync();
        await tx.CommitAsync();
    }
}
