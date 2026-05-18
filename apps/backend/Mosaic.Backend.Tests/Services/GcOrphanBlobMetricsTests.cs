using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;
using Mosaic.Backend.Tests.Helpers;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using Xunit;

namespace Mosaic.Backend.Tests.Services;

/// <summary>
/// Regression tests for the v1.0.1 s20 metric: orphan-blob storage delete
/// failures must now increment <see cref="MosaicMetrics.OrphanBlobDeleteFailuresValue"/>
/// instead of only emitting a warning log. Operators alert on the counter;
/// the log line is kept for diagnostic context.
/// </summary>
public sealed class GcOrphanBlobMetricsTests
{
    [Fact]
    public async Task CleanTrashedShards_StorageDeleteFailure_IncrementsCounter()
    {
        using var db = TestDbContextFactory.Create();
        var storage = Substitute.For<IStorageService>();
        // Every delete fails — simulates an unreachable storage backend.
        storage.DeleteAsync(Arg.Any<string>()).ThrowsAsync(new IOException("disk offline"));

        using var metrics = new MosaicMetrics();

        var services = new ServiceCollection();
        services.AddSingleton(db);
        services.AddSingleton(storage);
        services.AddSingleton<TimeProvider>(TimeProvider.System);
        services.AddSingleton(metrics);
        services.AddSingleton<Microsoft.Extensions.Logging.ILoggerFactory>(Microsoft.Extensions.Logging.Abstractions.NullLoggerFactory.Instance);
        services.AddLogging();
        services.AddSingleton<Microsoft.Extensions.Logging.ILogger<AlbumExpirationService>>(
            NullLogger<AlbumExpirationService>.Instance);
        services.AddScoped<IAlbumExpirationService, AlbumExpirationService>();
        var provider = services.BuildServiceProvider();

        var service = new GarbageCollectionService(
            provider,
            NullLogger<GarbageCollectionService>.Instance,
            timeProvider: TimeProvider.System,
            metrics: metrics);

        // Seed three TRASHED shards old enough to be eligible for deletion
        // (cutoff is now - 7 days).
        var trashedAt = DateTime.UtcNow.AddDays(-30);
        for (var i = 0; i < 3; i++)
        {
            db.Shards.Add(new Shard
            {
                Id = Guid.NewGuid(),
                StorageKey = $"key-{i}",
                Status = ShardStatus.TRASHED,
                StatusUpdatedAt = trashedAt,
                SizeBytes = 1024,
                Sha256 = new string('a', 64),
            });
        }
        await db.SaveChangesAsync();

        // Act
        var deleted = await service.CleanTrashedShardsAsync();

        // Assert: storage refused every delete, so no shard rows were
        // removed but the failure counter must have been bumped for each.
        Assert.Equal(0, deleted);
        Assert.Equal(3, metrics.OrphanBlobDeleteFailuresValue);
    }
}
