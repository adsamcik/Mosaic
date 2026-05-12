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

public class IdempotencyRecordCleanupHostedServiceTests
{
    [Fact]
    public async Task ExecuteCleanupAsync_DeletesRecordsOlderThanRetention_AndKeepsFreshRecords()
    {
        using var db = TestDbContextFactory.Create();
        var now = new DateTimeOffset(2026, 4, 29, 12, 0, 0, TimeSpan.Zero);
        var timeProvider = new FakeTimeProvider(now);
        var builder = new TestDataBuilder(db);
        var user = await builder.CreateUserAsync("idempotency-cleanup-user");
        var oldRecord = CreateRecord(user.Id, "old-key", now.AddHours(-25));
        var freshRecord = CreateRecord(user.Id, "fresh-key", now.AddHours(-23));
        db.IdempotencyRecords.AddRange(oldRecord, freshRecord);
        await db.SaveChangesAsync();

        var services = new ServiceCollection()
            .AddSingleton(db)
            .BuildServiceProvider();
        var service = new IdempotencyRecordCleanupHostedService(
            services.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new IdempotencyOptions
            {
                RetentionPeriod = TimeSpan.FromHours(24),
                CleanupInterval = TimeSpan.FromHours(1)
            }),
            timeProvider,
            NullLogger<IdempotencyRecordCleanupHostedService>.Instance);

        var deleted = await service.ExecuteCleanupAsync(CancellationToken.None);

        Assert.Equal(1, deleted);
        var remainingKeys = await db.IdempotencyRecords
            .Select(record => record.IdempotencyKey)
            .ToListAsync();
        Assert.Equal(["fresh-key"], remainingKeys);
    }

    private static IdempotencyRecord CreateRecord(Guid userId, string key, DateTimeOffset createdAt)
        => new()
        {
            UserId = userId,
            IdempotencyKey = key,
            RequestHash = new byte[32],
            ResponseStatus = 200,
            ResponseBodyHash = new byte[32],
            ResponseBody = [],
            ResponseHeadersSubset = "{}",
            CreatedAt = createdAt
        };

}
