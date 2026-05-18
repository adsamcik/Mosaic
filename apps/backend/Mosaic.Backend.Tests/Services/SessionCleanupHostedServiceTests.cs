using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;
using Mosaic.Backend.Tests.Helpers;
using Xunit;

namespace Mosaic.Backend.Tests.Services;

public class SessionCleanupHostedServiceTests
{
    [Fact]
    public async Task ExecuteCleanupAsync_DeletesRevokedSessionsBeyondRetention_AndKeepsRecentlyRevoked()
    {
        using var db = TestDbContextFactory.Create();
        var now = new DateTimeOffset(2026, 6, 1, 12, 0, 0, TimeSpan.Zero);
        var timeProvider = new FakeTimeProvider(now);
        var builder = new TestDataBuilder(db);
        var user = await builder.CreateUserAsync("session-cleanup-user");

        // Revoked 31 days ago -> purged.
        var oldRevoked = CreateSession(user.Id,
            createdAt: now.AddDays(-60).UtcDateTime,
            expiresAt: now.AddDays(60).UtcDateTime,
            revokedAt: now.AddDays(-31).UtcDateTime);
        // Revoked 29 days ago -> retained.
        var freshRevoked = CreateSession(user.Id,
            createdAt: now.AddDays(-60).UtcDateTime,
            expiresAt: now.AddDays(60).UtcDateTime,
            revokedAt: now.AddDays(-29).UtcDateTime);
        // Active, far from expiration -> retained.
        var active = CreateSession(user.Id,
            createdAt: now.AddDays(-1).UtcDateTime,
            expiresAt: now.AddDays(30).UtcDateTime,
            revokedAt: null);

        db.Sessions.AddRange(oldRevoked, freshRevoked, active);
        await db.SaveChangesAsync();

        var service = CreateService(db, timeProvider);
        var deleted = await service.ExecuteCleanupAsync(CancellationToken.None);

        Assert.Equal(1, deleted);
        var remaining = await db.Sessions.Select(s => s.Id).ToListAsync();
        Assert.Equal(2, remaining.Count);
        Assert.DoesNotContain(oldRevoked.Id, remaining);
    }

    [Fact]
    public async Task ExecuteCleanupAsync_DeletesSessionsExpiredBeyondGracePeriod()
    {
        using var db = TestDbContextFactory.Create();
        var now = new DateTimeOffset(2026, 6, 1, 12, 0, 0, TimeSpan.Zero);
        var timeProvider = new FakeTimeProvider(now);
        var builder = new TestDataBuilder(db);
        var user = await builder.CreateUserAsync("session-expired-user");

        // Expired 8 days ago -> purged.
        var expiredOld = CreateSession(user.Id,
            createdAt: now.AddDays(-30).UtcDateTime,
            expiresAt: now.AddDays(-8).UtcDateTime,
            revokedAt: null);
        // Expired 6 days ago -> retained (within 7-day grace).
        var expiredFresh = CreateSession(user.Id,
            createdAt: now.AddDays(-30).UtcDateTime,
            expiresAt: now.AddDays(-6).UtcDateTime,
            revokedAt: null);

        db.Sessions.AddRange(expiredOld, expiredFresh);
        await db.SaveChangesAsync();

        var service = CreateService(db, timeProvider);
        var deleted = await service.ExecuteCleanupAsync(CancellationToken.None);

        Assert.Equal(1, deleted);
        var remaining = await db.Sessions.Select(s => s.Id).ToListAsync();
        Assert.Equal([expiredFresh.Id], remaining);
    }

    [Fact]
    public async Task ExecuteCleanupAsync_NoEligibleRows_ReturnsZero()
    {
        using var db = TestDbContextFactory.Create();
        var now = new DateTimeOffset(2026, 6, 1, 12, 0, 0, TimeSpan.Zero);
        var timeProvider = new FakeTimeProvider(now);
        var builder = new TestDataBuilder(db);
        var user = await builder.CreateUserAsync("session-no-purge-user");

        db.Sessions.Add(CreateSession(user.Id,
            createdAt: now.AddDays(-1).UtcDateTime,
            expiresAt: now.AddDays(30).UtcDateTime,
            revokedAt: null));
        await db.SaveChangesAsync();

        var service = CreateService(db, timeProvider);
        var deleted = await service.ExecuteCleanupAsync(CancellationToken.None);

        Assert.Equal(0, deleted);
        Assert.Equal(1, await db.Sessions.CountAsync());
    }

    [Fact]
    public async Task ExecuteCleanupAsync_RecordsMetricsCounter_WhenRowsDeleted()
    {
        using var db = TestDbContextFactory.Create();
        var now = new DateTimeOffset(2026, 6, 1, 12, 0, 0, TimeSpan.Zero);
        var timeProvider = new FakeTimeProvider(now);
        var builder = new TestDataBuilder(db);
        var user = await builder.CreateUserAsync("session-metrics-user");

        for (var i = 0; i < 3; i++)
        {
            db.Sessions.Add(CreateSession(user.Id,
                createdAt: now.AddDays(-100).UtcDateTime,
                expiresAt: now.AddDays(-50).UtcDateTime,
                revokedAt: now.AddDays(-40).UtcDateTime));
        }
        await db.SaveChangesAsync();

        using var metrics = new MosaicMetrics();
        var beforeSessions = metrics.SessionsCleanedTotalValue;

        var service = CreateService(db, timeProvider, metrics);
        var deleted = await service.ExecuteCleanupAsync(CancellationToken.None);

        Assert.Equal(3, deleted);
        Assert.Equal(beforeSessions + 3, metrics.SessionsCleanedTotalValue);
    }

    private static SessionCleanupHostedService CreateService(
        MosaicDbContext db,
        TimeProvider timeProvider,
        MosaicMetrics? metrics = null)
    {
        var services = new ServiceCollection()
            .AddSingleton(db)
            .BuildServiceProvider();
        return new SessionCleanupHostedService(
            services.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new SessionCleanupOptions
            {
                RevokedRetentionPeriod = TimeSpan.FromDays(30),
                ExpiredRetentionPeriod = TimeSpan.FromDays(7),
                CleanupInterval = TimeSpan.FromHours(6)
            }),
            timeProvider,
            metrics ?? new MosaicMetrics(),
            NullLogger<SessionCleanupHostedService>.Instance);
    }

    private static Session CreateSession(
        Guid userId,
        DateTime createdAt,
        DateTime expiresAt,
        DateTime? revokedAt)
        => new()
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            TokenHash = new byte[32],
            CreatedAt = createdAt,
            LastSeenAt = createdAt,
            ExpiresAt = expiresAt,
            RevokedAt = revokedAt,
            UserAgent = "test-agent",
            IpAddress = "127.0.0.1",
            DeviceName = "test-device"
        };
}
