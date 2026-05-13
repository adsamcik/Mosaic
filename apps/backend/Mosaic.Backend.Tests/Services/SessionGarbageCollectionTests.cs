using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;
using Mosaic.Backend.Tests.Helpers;
using Xunit;

namespace Mosaic.Backend.Tests.Services;

public class SessionGarbageCollectionTests
{
    [Fact]
    public async Task CleanExpiredSessionsAsync_DeletesOnlyExpiredSessions_AndReturnsDeletedCount()
    {
        using var db = TestDbContextFactory.Create();
        var now = new DateTimeOffset(2026, 5, 1, 12, 0, 0, TimeSpan.Zero);
        var user = await new TestDataBuilder(db).CreateUserAsync("session-gc-user");
        var expiredSessions = Enumerable.Range(0, 5)
            .Select(index => CreateSession(user.Id, $"expired-{index}", now.UtcDateTime.AddHours(-1)))
            .ToList();
        var futureSessions = Enumerable.Range(0, 5)
            .Select(index => CreateSession(user.Id, $"future-{index}", now.UtcDateTime.AddHours(1)))
            .ToList();
        db.Sessions.AddRange(expiredSessions);
        db.Sessions.AddRange(futureSessions);
        await db.SaveChangesAsync();
        var service = CreateService(db, new FakeTimeProvider(now));

        var deleted = await service.CleanExpiredSessionsAsync(CancellationToken.None);

        Assert.Equal(5, deleted);
        Assert.Empty(await db.Sessions.Where(session => session.ExpiresAt <= now.UtcDateTime).ToListAsync());
        var remainingSessions = await db.Sessions.OrderBy(session => session.DeviceName).ToListAsync();
        Assert.Equal(5, remainingSessions.Count);
        Assert.All(remainingSessions, session => Assert.StartsWith("future-", session.DeviceName));
    }

    private static GarbageCollectionService CreateService(MosaicDbContext db, TimeProvider timeProvider)
    {
        var services = new ServiceCollection();
        services.AddSingleton(db);
        services.AddSingleton<IStorageService>(new MockStorageService());
        services.AddSingleton(timeProvider);
        services.AddSingleton<ILogger<AlbumExpirationService>>(NullLogger<AlbumExpirationService>.Instance);
        services.AddScoped<IAlbumExpirationService, AlbumExpirationService>();
        var provider = services.BuildServiceProvider();

        return new GarbageCollectionService(
            provider,
            NullLogger<GarbageCollectionService>.Instance,
            timeProvider);
    }

    private static Session CreateSession(Guid userId, string deviceName, DateTime expiresAt)
        => new()
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            TokenHash = TestDataBuilder.GenerateRandomBytes(32),
            CreatedAt = DateTime.UtcNow.AddDays(-1),
            LastSeenAt = DateTime.UtcNow.AddHours(-2),
            ExpiresAt = expiresAt,
            DeviceName = deviceName
        };
}
