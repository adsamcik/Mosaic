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

        // Check quota (if no quota record exists, allow unlimited uploads)
        var quota = await db.UserQuotas.FindAsync(user.Id);
        if (quota != null && quota.UsedStorageBytes + context.UploadLength > quota.MaxStorageBytes)
        {
            context.FailRequest("Storage quota exceeded");
            return;
        }
    }

    public static async Task OnFileComplete(
        FileCompleteContext context,
        IServiceProvider services)
    {
        var httpContext = context.HttpContext;
        var authSub = (string)httpContext.Items["AuthSub"]!;
        var fileId = context.FileId!;
        
        // Get file size from the store
        long fileSize = 0;
        if (context.Store is ITusReadableStore readable)
        {
            var file = await readable.GetFileAsync(fileId, context.CancellationToken);
            if (file != null)
            {
                using var stream = await file.GetContentAsync(context.CancellationToken);
                fileSize = stream.Length;
            }
        }

        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();

        await using var tx = await db.Database.BeginTransactionAsync();

        var user = await db.Users.FirstOrDefaultAsync(u => u.AuthSub == authSub);

        // Create PENDING shard
        db.Shards.Add(new Shard
        {
            Id = Guid.Parse(fileId),
            UploaderId = user!.Id,
            StorageKey = $"blobs/{fileId}",
            SizeBytes = fileSize,
            Status = ShardStatus.PENDING,
            PendingExpiresAt = DateTime.UtcNow.AddHours(24)
        });

        // Update quota
        await db.Database.ExecuteSqlRawAsync(
            "UPDATE user_quotas SET used_storage_bytes = used_storage_bytes + {0}, updated_at = NOW() WHERE user_id = {1}",
            fileSize, user.Id);

        await db.SaveChangesAsync();
        await tx.CommitAsync();
    }
}
