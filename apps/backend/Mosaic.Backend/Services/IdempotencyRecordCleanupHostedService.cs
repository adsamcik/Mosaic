using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Mosaic.Backend.Data;

namespace Mosaic.Backend.Services;

public sealed class IdempotencyRecordCleanupHostedService(
    IServiceScopeFactory scopeFactory,
    IOptions<IdempotencyOptions> options,
    TimeProvider timeProvider,
    ILogger<IdempotencyRecordCleanupHostedService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(options.Value.EffectiveCleanupInterval, timeProvider);

        await ExecuteCleanupSafelyAsync(stoppingToken);

        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            await ExecuteCleanupSafelyAsync(stoppingToken);
        }
    }

    public async Task<int> ExecuteCleanupAsync(CancellationToken cancellationToken)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();
        var cutoff = timeProvider.GetUtcNow().Subtract(options.Value.EffectiveRetentionPeriod);

        if (db.Database.IsRelational())
        {
            return await db.IdempotencyRecords
                .Where(record => record.CreatedAt < cutoff)
                .ExecuteDeleteAsync(cancellationToken);
        }

        var expiredRecords = await db.IdempotencyRecords
            .Where(record => record.CreatedAt < cutoff)
            .ToListAsync(cancellationToken);
        db.IdempotencyRecords.RemoveRange(expiredRecords);
        await db.SaveChangesAsync(cancellationToken);
        return expiredRecords.Count;
    }

    private async Task ExecuteCleanupSafelyAsync(CancellationToken cancellationToken)
    {
        try
        {
            var deleted = await ExecuteCleanupAsync(cancellationToken);
            logger.LogInformation("Deleted {Count} expired idempotency records", deleted);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Idempotency record cleanup failed");
        }
    }
}
