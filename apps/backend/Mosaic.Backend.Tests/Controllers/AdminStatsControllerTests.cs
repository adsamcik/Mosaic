using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Models.Admin;
using Mosaic.Backend.Services;
using Xunit;

namespace Mosaic.Backend.Tests.Controllers;

/// <summary>
/// v1.0.2 regression tests for `v102-s19-admin-stats-pagination`.
///
/// Before the fix, AdminStatsController.GetStats() returned every
/// `UsersNearQuota` and `AlbumsNearLimit` row without bound. The fix adds
/// `nearLimitSkip` / `nearLimitTake` query parameters with a default of 100
/// and a hard server-side cap of 500.
/// </summary>
public class AdminStatsControllerTests
{
    private MosaicDbContext CreateDb()
    {
        var options = new DbContextOptionsBuilder<MosaicDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .ConfigureWarnings(b =>
                b.Ignore(Microsoft.EntityFrameworkCore.Diagnostics.CoreEventId.RowLimitingOperationWithoutOrderByWarning))
            .Options;
        return new MosaicDbContext(options);
    }

    private IQuotaSettingsService CreateQuotaService(MosaicDbContext db)
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Quota:DefaultMaxBytes"] = "10737418240",
                ["Quota:DefaultMaxAlbums"] = "100",
                ["Quota:DefaultMaxPhotosPerAlbum"] = "10000",
                ["Quota:DefaultMaxBytesPerAlbum"] = "5368709120"
            })
            .Build();
        var cache = new MemoryCache(new MemoryCacheOptions());
        return new QuotaSettingsService(db, config, cache, NullLogger<QuotaSettingsService>.Instance);
    }

    private AdminStatsController CreateController(MosaicDbContext db)
    {
        return new AdminStatsController(db, CreateQuotaService(db));
    }

    private static async Task SeedUsersAtQuota(MosaicDbContext db, int count, long maxBytes = 1000)
    {
        for (var i = 0; i < count; i++)
        {
            var u = new User { Id = Guid.NewGuid(), AuthSub = $"u{i}@t.local", IdentityPubkey = "" };
            db.Users.Add(u);
            // 90% used → matches the `>= 80%` warning predicate.
            db.UserQuotas.Add(new UserQuota
            {
                UserId = u.Id,
                MaxStorageBytes = maxBytes,
                UsedStorageBytes = (long)(maxBytes * 0.90),
            });
        }
        await db.SaveChangesAsync();
    }

    [Fact]
    public async Task GetStats_CapsUsersNearQuota_AtDefault100()
    {
        var db = CreateDb();
        await SeedUsersAtQuota(db, count: 150);

        var controller = CreateController(db);
        var result = await controller.GetStats();

        var ok = Assert.IsType<OkObjectResult>(result);
        var stats = Assert.IsType<SystemStatsResponse>(ok.Value);
        Assert.Equal(150, stats.TotalUsers);
        Assert.Equal(100, stats.UsersNearQuota.Count);
    }

    [Fact]
    public async Task GetStats_HonoursExplicitNearLimitTake()
    {
        var db = CreateDb();
        await SeedUsersAtQuota(db, count: 20);

        var controller = CreateController(db);
        var result = await controller.GetStats(nearLimitSkip: 0, nearLimitTake: 5);

        var ok = Assert.IsType<OkObjectResult>(result);
        var stats = Assert.IsType<SystemStatsResponse>(ok.Value);
        Assert.Equal(5, stats.UsersNearQuota.Count);
    }

    [Fact]
    public async Task GetStats_ClampsNearLimitTake_AtHardCap500()
    {
        var db = CreateDb();
        await SeedUsersAtQuota(db, count: 600);

        var controller = CreateController(db);
        // Caller asks for 10_000 — must be clamped to 500 server-side.
        var result = await controller.GetStats(nearLimitSkip: 0, nearLimitTake: 10_000);

        var ok = Assert.IsType<OkObjectResult>(result);
        var stats = Assert.IsType<SystemStatsResponse>(ok.Value);
        Assert.Equal(500, stats.UsersNearQuota.Count);
    }

    [Fact]
    public async Task GetStats_ClampsNegativeSkipAndZeroTake()
    {
        var db = CreateDb();
        await SeedUsersAtQuota(db, count: 30);

        var controller = CreateController(db);
        // Negative skip → clamped to 0. take=0 → clamped to 1.
        var result = await controller.GetStats(nearLimitSkip: -50, nearLimitTake: 0);

        var ok = Assert.IsType<OkObjectResult>(result);
        var stats = Assert.IsType<SystemStatsResponse>(ok.Value);
        Assert.Equal(1, stats.UsersNearQuota.Count);
    }

    [Fact]
    public async Task GetStats_NearLimitSkipAdvancesThroughResults()
    {
        var db = CreateDb();
        await SeedUsersAtQuota(db, count: 30);

        var controller = CreateController(db);

        var firstPageResult = await controller.GetStats(nearLimitSkip: 0, nearLimitTake: 10);
        var firstPage = Assert.IsType<SystemStatsResponse>(Assert.IsType<OkObjectResult>(firstPageResult).Value);

        var secondPageResult = await controller.GetStats(nearLimitSkip: 10, nearLimitTake: 10);
        var secondPage = Assert.IsType<SystemStatsResponse>(Assert.IsType<OkObjectResult>(secondPageResult).Value);

        Assert.Equal(10, firstPage.UsersNearQuota.Count);
        Assert.Equal(10, secondPage.UsersNearQuota.Count);

        var firstIds = firstPage.UsersNearQuota.Select(w => w.UserId).ToHashSet();
        var secondIds = secondPage.UsersNearQuota.Select(w => w.UserId).ToHashSet();
        Assert.Empty(firstIds.Intersect(secondIds));
    }

    [Fact]
    public async Task GetStats_DoesNotIncludeUsersBelow80Percent()
    {
        var db = CreateDb();
        // 70% used → below the warning threshold.
        var u = new User { Id = Guid.NewGuid(), AuthSub = "ok@t.local", IdentityPubkey = "" };
        db.Users.Add(u);
        db.UserQuotas.Add(new UserQuota
        {
            UserId = u.Id,
            MaxStorageBytes = 1000,
            UsedStorageBytes = 700,
        });
        await db.SaveChangesAsync();

        var controller = CreateController(db);
        var result = await controller.GetStats();

        var ok = Assert.IsType<OkObjectResult>(result);
        var stats = Assert.IsType<SystemStatsResponse>(ok.Value);
        Assert.Empty(stats.UsersNearQuota);
    }
}
