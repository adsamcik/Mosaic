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

public class AdminUsersControllerTests
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

    private AdminUsersController CreateController(MosaicDbContext db, User adminUser)
    {
        var quotaService = CreateQuotaService(db);
        var controller = new AdminUsersController(db, quotaService, NullLogger<AdminUsersController>.Instance);
        var httpContext = new DefaultHttpContext();
        httpContext.Items["AdminUser"] = adminUser;
        controller.ControllerContext = new ControllerContext { HttpContext = httpContext };
        return controller;
    }

    [Fact]
    public async Task ListUsers_ReturnsAllUsers()
    {
        var db = CreateDb();
        var admin = new User { Id = Guid.NewGuid(), AuthSub = "admin@test.com", IdentityPubkey = "", IsAdmin = true };
        var user1 = new User { Id = Guid.NewGuid(), AuthSub = "user1@test.com", IdentityPubkey = "" };
        var user2 = new User { Id = Guid.NewGuid(), AuthSub = "user2@test.com", IdentityPubkey = "" };
        db.Users.AddRange(admin, user1, user2);
        db.UserQuotas.Add(new UserQuota { UserId = user1.Id, MaxStorageBytes = 1000, UsedStorageBytes = 500 });
        await db.SaveChangesAsync();

        var controller = CreateController(db, admin);
        var result = await controller.ListUsers();

        var okResult = Assert.IsType<OkObjectResult>(result);
        var data = okResult.Value;
        var usersProperty = data!.GetType().GetProperty("users");
        var users = (usersProperty!.GetValue(data) as IEnumerable<object>)!.ToList();
        Assert.Equal(3, users.Count);
    }

    [Fact]
    public async Task GetUserQuota_ReturnsQuotaDetails()
    {
        var db = CreateDb();
        var admin = new User { Id = Guid.NewGuid(), AuthSub = "admin@test.com", IdentityPubkey = "", IsAdmin = true };
        var user = new User { Id = Guid.NewGuid(), AuthSub = "user@test.com", IdentityPubkey = "" };
        db.Users.AddRange(admin, user);
        db.UserQuotas.Add(new UserQuota { UserId = user.Id, MaxStorageBytes = 5000, UsedStorageBytes = 1000, MaxAlbums = 50 });
        await db.SaveChangesAsync();

        var controller = CreateController(db, admin);
        var result = await controller.GetUserQuota(user.Id);

        var okResult = Assert.IsType<OkObjectResult>(result);
        var quota = Assert.IsType<UserQuotaResponse>(okResult.Value);
        Assert.Equal(5000, quota.MaxStorageBytes);
        Assert.Equal(1000, quota.UsedStorageBytes);
        Assert.Equal(50, quota.MaxAlbums);
        Assert.True(quota.IsCustom);
    }

    [Fact]
    public async Task GetUserQuota_ReturnsNotFound_WhenUserNotExists()
    {
        var db = CreateDb();
        var admin = new User { Id = Guid.NewGuid(), AuthSub = "admin@test.com", IdentityPubkey = "", IsAdmin = true };
        db.Users.Add(admin);
        await db.SaveChangesAsync();

        var controller = CreateController(db, admin);
        var result = await controller.GetUserQuota(Guid.NewGuid());

        ProblemDetailsAssertions.AssertNotFound(result);
    }

    [Fact]
    public async Task SetUserQuota_UpdatesExistingQuota()
    {
        var db = CreateDb();
        var admin = new User { Id = Guid.NewGuid(), AuthSub = "admin@test.com", IdentityPubkey = "", IsAdmin = true };
        var user = new User { Id = Guid.NewGuid(), AuthSub = "user@test.com", IdentityPubkey = "" };
        db.Users.AddRange(admin, user);
        db.UserQuotas.Add(new UserQuota { UserId = user.Id, MaxStorageBytes = 1000 });
        await db.SaveChangesAsync();

        var controller = CreateController(db, admin);
        var request = new UpdateUserQuotaRequest(MaxStorageBytes: 9999, MaxAlbums: 25);
        var result = await controller.SetUserQuota(user.Id, request);

        var okResult = Assert.IsType<OkObjectResult>(result);
        var quota = Assert.IsType<UserQuotaResponse>(okResult.Value);
        Assert.Equal(9999, quota.MaxStorageBytes);
        Assert.Equal(25, quota.MaxAlbums);
    }

    [Fact]
    public async Task ResetUserQuota_ResetsToDefaults()
    {
        var db = CreateDb();
        var admin = new User { Id = Guid.NewGuid(), AuthSub = "admin@test.com", IdentityPubkey = "", IsAdmin = true };
        var user = new User { Id = Guid.NewGuid(), AuthSub = "user@test.com", IdentityPubkey = "" };
        db.Users.AddRange(admin, user);
        db.UserQuotas.Add(new UserQuota { UserId = user.Id, MaxStorageBytes = 5000, MaxAlbums = 50 });
        await db.SaveChangesAsync();

        var controller = CreateController(db, admin);
        var result = await controller.ResetUserQuota(user.Id);

        Assert.IsType<NoContentResult>(result);
        var quota = await db.UserQuotas.FindAsync(user.Id);
        Assert.Equal(10737418240, quota!.MaxStorageBytes);
        Assert.Null(quota.MaxAlbums);
    }

    [Fact]
    public async Task PromoteUser_SetsIsAdminTrue()
    {
        var db = CreateDb();
        var admin = new User { Id = Guid.NewGuid(), AuthSub = "admin@test.com", IdentityPubkey = "", IsAdmin = true };
        var user = new User { Id = Guid.NewGuid(), AuthSub = "user@test.com", IdentityPubkey = "", IsAdmin = false };
        db.Users.AddRange(admin, user);
        await db.SaveChangesAsync();

        var controller = CreateController(db, admin);
        var result = await controller.PromoteUser(user.Id);

        Assert.IsType<NoContentResult>(result);
        var updatedUser = await db.Users.FindAsync(user.Id);
        Assert.True(updatedUser!.IsAdmin);
    }

    [Fact]
    public async Task PromoteUser_ReturnsBadRequest_WhenAlreadyAdmin()
    {
        var db = CreateDb();
        var admin = new User { Id = Guid.NewGuid(), AuthSub = "admin@test.com", IdentityPubkey = "", IsAdmin = true };
        db.Users.Add(admin);
        await db.SaveChangesAsync();

        var controller = CreateController(db, admin);
        var result = await controller.PromoteUser(admin.Id);

        ProblemDetailsAssertions.AssertBadRequest(result);
    }

    [Fact]
    public async Task DemoteUser_SetsIsAdminFalse()
    {
        var db = CreateDb();
        var admin1 = new User { Id = Guid.NewGuid(), AuthSub = "admin1@test.com", IdentityPubkey = "", IsAdmin = true };
        var admin2 = new User { Id = Guid.NewGuid(), AuthSub = "admin2@test.com", IdentityPubkey = "", IsAdmin = true };
        db.Users.AddRange(admin1, admin2);
        await db.SaveChangesAsync();

        var controller = CreateController(db, admin1);
        var result = await controller.DemoteUser(admin2.Id);

        Assert.IsType<NoContentResult>(result);
        var updatedUser = await db.Users.FindAsync(admin2.Id);
        Assert.False(updatedUser!.IsAdmin);
    }

    [Fact]
    public async Task DemoteUser_ReturnsBadRequest_WhenLastAdmin()
    {
        var db = CreateDb();
        var admin = new User { Id = Guid.NewGuid(), AuthSub = "admin@test.com", IdentityPubkey = "", IsAdmin = true };
        db.Users.Add(admin);
        await db.SaveChangesAsync();

        var controller = CreateController(db, admin);
        var result = await controller.DemoteUser(admin.Id);

        var badRequest = ProblemDetailsAssertions.AssertBadRequest(result);
        Assert.Contains("last admin", ProblemDetailsAssertions.GetDetail(badRequest)?.ToLower() ?? "");
    }
}
