using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Mosaic.Backend.Data;

namespace Mosaic.Backend.Services;

/// <summary>
/// Background worker that purges stale <see cref="Mosaic.Backend.Data.Entities.Session"/>
/// rows on a periodic schedule (v1.0.x s40).
///
/// <para>
/// Revoked sessions retain forensic telemetry (<c>IpAddress</c>, <c>UserAgent</c>,
/// <c>DeviceName</c>) past the revocation event. Without this cleanup the table
/// accumulates dead rows containing personally identifiable network metadata
/// indefinitely. This service mirrors the
/// <see cref="IdempotencyRecordCleanupHostedService"/> pattern: periodic
/// <see cref="PeriodicTimer"/>-driven sweep, isolated per-iteration scope, and
/// metrics-counted result.
/// </para>
///
/// <para>Purge predicates (OR):</para>
/// <list type="bullet">
/// <item><c>RevokedAt IS NOT NULL AND RevokedAt &lt; now - revokedRetention</c>
///   (default: 30 days)</item>
/// <item><c>ExpiresAt &lt; now - expiredRetention</c> (default: 7 days past
///   absolute expiration)</item>
/// </list>
/// </summary>
public sealed class SessionCleanupHostedService(
    IServiceScopeFactory scopeFactory,
    IOptions<SessionCleanupOptions> options,
    TimeProvider timeProvider,
    MosaicMetrics metrics,
    ILogger<SessionCleanupHostedService> logger) : BackgroundService
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
    /// Deletes stale session rows and returns the number deleted. Exposed for
    /// unit tests; production callers should rely on the timer loop in
    /// <see cref="ExecuteAsync"/>.
    /// </summary>
    public async Task<int> ExecuteCleanupAsync(CancellationToken cancellationToken)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MosaicDbContext>();

        var now = timeProvider.GetUtcNow().UtcDateTime;
        var revokedCutoff = now - options.Value.EffectiveRevokedRetentionPeriod;
        var expiredCutoff = now - options.Value.EffectiveExpiredRetentionPeriod;

        int deleted;
        if (db.Database.IsRelational())
        {
            deleted = await db.Sessions
                .Where(s => (s.RevokedAt != null && s.RevokedAt < revokedCutoff)
                    || s.ExpiresAt < expiredCutoff)
                .ExecuteDeleteAsync(cancellationToken);
        }
        else
        {
            var stale = await db.Sessions
                .Where(s => (s.RevokedAt != null && s.RevokedAt < revokedCutoff)
                    || s.ExpiresAt < expiredCutoff)
                .ToListAsync(cancellationToken);
            db.Sessions.RemoveRange(stale);
            await db.SaveChangesAsync(cancellationToken);
            deleted = stale.Count;
        }

        if (deleted > 0)
        {
            metrics.RecordSessionsCleaned(deleted);
        }
        return deleted;
    }

    private async Task ExecuteCleanupSafelyAsync(CancellationToken cancellationToken)
    {
        try
        {
            var deleted = await ExecuteCleanupAsync(cancellationToken);
            logger.LogInformation("Deleted {Count} stale (revoked or expired) sessions", deleted);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Session cleanup failed");
        }
    }
}
