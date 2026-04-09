using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Models.Admin;
using Mosaic.Backend.Models.Admin;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;
using Xunit;
using Mosaic.Backend.Tests.TestHelpers;


namespace Mosaic.Backend.Tests.Controllers;

public class AdminSettingsControllerTests
{
    private MosaicDbContext CreateDb()
    {
        var options = new DbContextOptionsBuilder<MosaicDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
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

    private AdminSettingsController CreateController(MosaicDbContext db, User adminUser)
    {
        var quotaService = CreateQuotaService(db);
        var controller = new AdminSettingsController(db, quotaService, NullLogger<AdminSettingsController>.Instance);
        var httpContext = new DefaultHttpContext();
        httpContext.Items["AdminUser"] = adminUser;
        controller.ControllerContext = new ControllerContext { HttpContext = httpContext };
        return controller;
    }

    [Fact]
    public async Task GetQuotaDefaults_ReturnsDefaults()
    {
        var db = CreateDb();
        var admin = new User { Id = Guid.NewGuid(), AuthSub = "admin@test.com", IdentityPubkey = "", IsAdmin = true };
        db.Users.Add(admin);
        await db.SaveChangesAsync();

        var controller = CreateController(db, admin);
        var result = await controller.GetQuotaDefaults();

        var okResult = Assert.IsType<OkObjectResult>(result);
        var defaults = Assert.IsType<QuotaDefaults>(okResult.Value);
        Assert.Equal(10737418240, defaults.MaxStorageBytesPerUser);
        Assert.Equal(100, defaults.MaxAlbumsPerUser);
        Assert.Equal(10000, defaults.MaxPhotosPerAlbum);
        Assert.Equal(5368709120, defaults.MaxBytesPerAlbum);
    }

    [Fact]
    public async Task SetQuotaDefaults_UpdatesDefaults()
    {
        var db = CreateDb();
        var admin = new User { Id = Guid.NewGuid(), AuthSub = "admin@test.com", IdentityPubkey = "", IsAdmin = true };
        db.Users.Add(admin);
        await db.SaveChangesAsync();

        var controller = CreateController(db, admin);
        var request = new UpdateQuotaDefaultsRequest(
            MaxStorageBytesPerUser: 5000,
            MaxAlbumsPerUser: 50,
            MaxPhotosPerAlbum: 500,
            MaxBytesPerAlbum: 2500
        );
        var result = await controller.SetQuotaDefaults(request);

        var okResult = Assert.IsType<OkObjectResult>(result);
        var defaults = Assert.IsType<QuotaDefaults>(okResult.Value);
        Assert.Equal(5000, defaults.MaxStorageBytesPerUser);
        Assert.Equal(50, defaults.MaxAlbumsPerUser);

        // Verify persisted to DB
        var setting = await db.SystemSettings.FindAsync("quota.defaults");
        Assert.NotNull(setting);
    }

    [Fact]
    public async Task SetQuotaDefaults_ReturnsBadRequest_WhenInvalidValues()
    {
        var db = CreateDb();
        var admin = new User { Id = Guid.NewGuid(), AuthSub = "admin@test.com", IdentityPubkey = "", IsAdmin = true };
        db.Users.Add(admin);
        await db.SaveChangesAsync();

        var controller = CreateController(db, admin);
        var request = new UpdateQuotaDefaultsRequest(
            MaxStorageBytesPerUser: -1,
            MaxAlbumsPerUser: 50,
            MaxPhotosPerAlbum: 500,
            MaxBytesPerAlbum: 2500
        );
        var result = await controller.SetQuotaDefaults(request);

        ProblemDetailsAssertions.AssertBadRequest(result);
    }
}
