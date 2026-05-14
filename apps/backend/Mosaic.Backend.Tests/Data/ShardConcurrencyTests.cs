using Microsoft.EntityFrameworkCore;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Xunit;

namespace Mosaic.Backend.Tests.Persistence;

public class ShardConcurrencyTests
{
    [Fact]
    public async Task SaveChanges_ThrowsConcurrencyException_WhenShardRowVersionIsStale()
    {
        var databaseName = Guid.NewGuid().ToString();
        var options = new DbContextOptionsBuilder<MosaicDbContext>()
            .UseInMemoryDatabase(databaseName)
            .Options;

        var shardId = Guid.NewGuid();
        await using (var setupDb = new MosaicDbContext(options))
        {
            setupDb.Shards.Add(new Shard
            {
                Id = shardId,
                StorageKey = "concurrency-test-shard",
                SizeBytes = 1,
                Status = ShardStatus.ACTIVE,
                RowVersion = 0
            });
            await setupDb.SaveChangesAsync();
        }

        await using var firstDb = new MosaicDbContext(options);
        await using var secondDb = new MosaicDbContext(options);
        var firstShard = await firstDb.Shards.SingleAsync(s => s.Id == shardId);
        var secondShard = await secondDb.Shards.SingleAsync(s => s.Id == shardId);

        secondShard.SizeBytes = 2;
        secondShard.RowVersion = 1;
        await secondDb.SaveChangesAsync();

        firstShard.SizeBytes = 3;

        await Assert.ThrowsAsync<DbUpdateConcurrencyException>(() => firstDb.SaveChangesAsync());
    }
}
