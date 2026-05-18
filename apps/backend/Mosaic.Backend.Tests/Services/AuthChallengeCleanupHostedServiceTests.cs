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

public class AuthChallengeCleanupHostedServiceTests
{
    [Fact]
    public async Task ExecuteCleanupAsync_DeletesExpiredChallenges_KeepsActive()
    {
        using var db = TestDbContextFactory.Create();
        var now = new DateTimeOffset(2026, 6, 1, 12, 0, 0, TimeSpan.Zero);
        var timeProvider = new FakeTimeProvider(now);

        db.AuthChallenges.Add(MakeChallenge(now.AddMinutes(-5).UtcDateTime));
        db.AuthChallenges.Add(MakeChallenge(now.AddSeconds(-1).UtcDateTime));
        db.AuthChallenges.Add(MakeChallenge(now.AddSeconds(60).UtcDateTime));
        await db.SaveChangesAsync();

        var service = CreateService(db, timeProvider);
        var deleted = await service.ExecuteCleanupAsync(CancellationToken.None);

        Assert.Equal(2, deleted);
        Assert.Equal(1, await db.AuthChallenges.CountAsync());
    }

    [Fact]
    public async Task ExecuteCleanupAsync_NoEligibleRows_ReturnsZero()
    {
        using var db = TestDbContextFactory.Create();
        var now = new DateTimeOffset(2026, 6, 1, 12, 0, 0, TimeSpan.Zero);
        var timeProvider = new FakeTimeProvider(now);

        db.AuthChallenges.Add(MakeChallenge(now.AddMinutes(1).UtcDateTime));
        await db.SaveChangesAsync();

        var service = CreateService(db, timeProvider);
        var deleted = await service.ExecuteCleanupAsync(CancellationToken.None);

        Assert.Equal(0, deleted);
        Assert.Equal(1, await db.AuthChallenges.CountAsync());
    }

    [Fact]
    public async Task ExecuteCleanupAsync_EmptyTable_ReturnsZero()
    {
        using var db = TestDbContextFactory.Create();
        var timeProvider = new FakeTimeProvider(
            new DateTimeOffset(2026, 6, 1, 12, 0, 0, TimeSpan.Zero));

        var service = CreateService(db, timeProvider);
        Assert.Equal(0, await service.ExecuteCleanupAsync(CancellationToken.None));
    }

    [Fact]
    public async Task ExecuteCleanupAsync_RecordsMetricsCounter_WhenRowsDeleted()
    {
        using var db = TestDbContextFactory.Create();
        var now = new DateTimeOffset(2026, 6, 1, 12, 0, 0, TimeSpan.Zero);
        var timeProvider = new FakeTimeProvider(now);

        for (var i = 0; i < 4; i++)
        {
            db.AuthChallenges.Add(MakeChallenge(now.AddMinutes(-10).UtcDateTime));
        }
        await db.SaveChangesAsync();

        using var metrics = new MosaicMetrics();
        var before = metrics.AuthChallengesCleanedTotalValue;

        var service = CreateService(db, timeProvider, metrics);
        var deleted = await service.ExecuteCleanupAsync(CancellationToken.None);

        Assert.Equal(4, deleted);
        Assert.Equal(before + 4, metrics.AuthChallengesCleanedTotalValue);
    }

    private static AuthChallengeCleanupHostedService CreateService(
        MosaicDbContext db,
        TimeProvider timeProvider,
        MosaicMetrics? metrics = null)
    {
        var services = new ServiceCollection()
            .AddSingleton(db)
            .BuildServiceProvider();
        return new AuthChallengeCleanupHostedService(
            services.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new AuthChallengeCleanupOptions
            {
                CleanupInterval = TimeSpan.FromMinutes(30),
            }),
            timeProvider,
            metrics ?? new MosaicMetrics(),
            NullLogger<AuthChallengeCleanupHostedService>.Instance);
    }

    private static AuthChallenge MakeChallenge(DateTime expiresAt)
        => new()
        {
            Id = Guid.NewGuid(),
            Username = "user-" + Guid.NewGuid().ToString("N")[..8],
            Challenge = new byte[32],
            CreatedAt = expiresAt.AddMinutes(-1),
            ExpiresAt = expiresAt,
            IsUsed = false,
            IpAddress = "127.0.0.1",
        };
}
