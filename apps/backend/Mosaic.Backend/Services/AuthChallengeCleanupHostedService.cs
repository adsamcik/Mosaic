using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Mosaic.Backend.Data;

namespace Mosaic.Backend.Services;

/// <summary>
/// Background worker that purges expired <see cref="Mosaic.Backend.Data.Entities.AuthChallenge"/>
/// rows on a periodic schedule (v1.0.x s44-y1).
///
/// <para>
/// Challenge rows have a 60-second native TTL but linger in the table
/// indefinitely once expired. <see cref="AuthController.CleanupExpiredChallengesAsync"/>
/// provides opportunistic per-request cleanup; this hosted service is the
/// defense-in-depth backstop that guarantees forward progress even on idle
/// instances. Mirrors the <see cref="SessionCleanupHostedService"/> pattern:
/// periodic <see cref="PeriodicTimer"/>-driven sweep, isolated per-iteration
/// scope, and metrics-counted result.
/// </para>
/// </summary>
public sealed class AuthChallengeCleanupHostedService(
    IServiceScopeFactory scopeFactory,
    IOptions<AuthChallengeCleanupOptions> options,
    TimeProvider timeProvider,
    MosaicMetrics metrics,
    ILogger<AuthChallengeCleanupHostedService> logger) : BackgroundService
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

    /// <summary>
    /// Deletes expired auth-challenge rows and returns the number deleted.
    /// Exposed for unit tests; production callers should rely on the timer
    /// loop in <see cref="ExecuteAsync"/>.
    /// </summary>
    public async Task<int> ExecuteCleanupAsync(CancellationToken cancellationToken)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();

        var now = timeProvider.GetUtcNow().UtcDateTime;

        int deleted;
        if (db.Database.IsRelational())
        {
            deleted = await db.AuthChallenges
                .Where(c => c.ExpiresAt < now)
                .ExecuteDeleteAsync(cancellationToken);
        }
        else
        {
            var stale = await db.AuthChallenges
                .Where(c => c.ExpiresAt < now)
                .ToListAsync(cancellationToken);
            db.AuthChallenges.RemoveRange(stale);
            await db.SaveChangesAsync(cancellationToken);
            deleted = stale.Count;
        }

        if (deleted > 0)
        {
            metrics.RecordAuthChallengesCleaned(deleted);
        }
        return deleted;
    }

    private async Task ExecuteCleanupSafelyAsync(CancellationToken cancellationToken)
    {
        try
        {
            var deleted = await ExecuteCleanupAsync(cancellationToken);
            logger.LogInformation("Deleted {Count} expired auth challenges", deleted);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Auth challenge cleanup failed");
        }
    }
}
