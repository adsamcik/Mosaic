using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Models;
using Mosaic.Backend.Models.ShareLinks;
using Mosaic.Backend.Tests.Helpers;
using Mosaic.Backend.Tests.TestHelpers;
using Xunit;

namespace Mosaic.Backend.Tests.Controllers;

/// <summary>
/// Tests for <c>GET /api/v1/users/me/share-links</c> (v1.0.x s40).
/// </summary>
public class UsersControllerShareLinksTests
{
    private const string TestAuthSub = "share-link-owner";

    private static UsersController CreateController(Mosaic.Backend.Data.MosaicDbContext db, string authSub = TestAuthSub)
    {
        var config = TestConfiguration.Create();
        return new UsersController(db, config, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(authSub)
            }
        };
    }

    [Fact]
    public async Task ListMyShareLinks_ReturnsOnlyLinksOnOwnedAlbums()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);

        var me = await builder.CreateUserAsync(TestAuthSub);
        var someoneElse = await builder.CreateUserAsync("other-user");

        var myAlbum = await builder.CreateAlbumAsync(me, encryptedName: "ZW5jLW15");
        var otherAlbum = await builder.CreateAlbumAsync(someoneElse, encryptedName: "ZW5jLW90aGVy");

        await builder.CreateShareLinkAsync(myAlbum, accessTier: 2);
        await builder.CreateShareLinkAsync(myAlbum, accessTier: 3);
        await builder.CreateShareLinkAsync(otherAlbum, accessTier: 3);

        var controller = CreateController(db);
        var result = await controller.ListMyShareLinks();

        var ok = Assert.IsType<OkObjectResult>(result);
        var paged = Assert.IsType<PagedResult<ShareLinkSummary>>(ok.Value);
        Assert.Equal(2, paged.Items.Count);
        Assert.All(paged.Items, s => Assert.Equal(myAlbum.Id, s.AlbumId));
        Assert.All(paged.Items, s => Assert.Equal("ZW5jLW15", s.AlbumName));
        Assert.Null(paged.NextSkip);
    }

    [Fact]
    public async Task ListMyShareLinks_RoleFilter_ReadReturnsTier1And2()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var me = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(me);

        await builder.CreateShareLinkAsync(album, accessTier: 1);
        await builder.CreateShareLinkAsync(album, accessTier: 2);
        await builder.CreateShareLinkAsync(album, accessTier: 3);

        var controller = CreateController(db);
        var result = await controller.ListMyShareLinks(role: "read");

        var paged = Assert.IsType<PagedResult<ShareLinkSummary>>(Assert.IsType<OkObjectResult>(result).Value);
        Assert.Equal(2, paged.Items.Count);
        Assert.All(paged.Items, s =>
        {
            Assert.Equal("read", s.Role);
            Assert.Contains(s.AccessTier, new[] { 1, 2 });
        });
    }

    [Fact]
    public async Task ListMyShareLinks_RoleFilter_WriteReturnsTier3Only()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var me = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(me);

        await builder.CreateShareLinkAsync(album, accessTier: 1);
        await builder.CreateShareLinkAsync(album, accessTier: 3);
        await builder.CreateShareLinkAsync(album, accessTier: 3);

        var controller = CreateController(db);
        var result = await controller.ListMyShareLinks(role: "write");

        var paged = Assert.IsType<PagedResult<ShareLinkSummary>>(Assert.IsType<OkObjectResult>(result).Value);
        Assert.Equal(2, paged.Items.Count);
        Assert.All(paged.Items, s =>
        {
            Assert.Equal("write", s.Role);
            Assert.Equal(3, s.AccessTier);
        });
    }

    [Fact]
    public async Task ListMyShareLinks_RoleFilter_InvalidValueReturnsProblem()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        await builder.CreateUserAsync(TestAuthSub);

        var controller = CreateController(db);
        var result = await controller.ListMyShareLinks(role: "admin");

        var obj = Assert.IsAssignableFrom<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status400BadRequest, obj.StatusCode);
    }

    [Fact]
    public async Task ListMyShareLinks_ActiveFilter_TrueExcludesRevokedExpiredMaxed()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var me = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(me);

        // Active.
        await builder.CreateShareLinkAsync(album, accessTier: 3);
        // Revoked.
        await builder.CreateShareLinkAsync(album, accessTier: 3, isRevoked: true);
        // Expired.
        await builder.CreateShareLinkAsync(album, accessTier: 3, expiresAt: DateTimeOffset.UtcNow.AddMinutes(-5));
        // Maxed out.
        await builder.CreateShareLinkAsync(album, accessTier: 3, maxUses: 3, useCount: 3);

        var controller = CreateController(db);
        var result = await controller.ListMyShareLinks(active: true);

        var paged = Assert.IsType<PagedResult<ShareLinkSummary>>(Assert.IsType<OkObjectResult>(result).Value);
        Assert.Single(paged.Items);
        Assert.False(paged.Items[0].IsRevoked);
    }

    [Fact]
    public async Task ListMyShareLinks_ActiveFilter_FalseReturnsOnlyInactive()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var me = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(me);

        await builder.CreateShareLinkAsync(album, accessTier: 3);
        await builder.CreateShareLinkAsync(album, accessTier: 3, isRevoked: true);
        await builder.CreateShareLinkAsync(album, accessTier: 3, expiresAt: DateTimeOffset.UtcNow.AddMinutes(-5));

        var controller = CreateController(db);
        var result = await controller.ListMyShareLinks(active: false);

        var paged = Assert.IsType<PagedResult<ShareLinkSummary>>(Assert.IsType<OkObjectResult>(result).Value);
        Assert.Equal(2, paged.Items.Count);
    }

    [Fact]
    public async Task ListMyShareLinks_Pagination_CapsPageSizeAt100()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var me = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(me);

        for (int i = 0; i < 105; i++)
        {
            await builder.CreateShareLinkAsync(album, accessTier: 3);
        }

        var controller = CreateController(db);
        var result = await controller.ListMyShareLinks(pageSize: 500);

        var paged = Assert.IsType<PagedResult<ShareLinkSummary>>(Assert.IsType<OkObjectResult>(result).Value);
        Assert.Equal(100, paged.Items.Count);
        // NextSkip set because there are 5 more rows past the cap.
        Assert.Equal(100, paged.NextSkip);
    }

    [Fact]
    public async Task ListMyShareLinks_Pagination_SecondPage()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        var me = await builder.CreateUserAsync(TestAuthSub);
        var album = await builder.CreateAlbumAsync(me);

        for (int i = 0; i < 7; i++)
        {
            await builder.CreateShareLinkAsync(album, accessTier: 3);
        }

        var controller = CreateController(db);
        var result = await controller.ListMyShareLinks(page: 2, pageSize: 5);

        var paged = Assert.IsType<PagedResult<ShareLinkSummary>>(Assert.IsType<OkObjectResult>(result).Value);
        Assert.Equal(2, paged.Items.Count);
        Assert.Null(paged.NextSkip);
    }

    [Fact]
    public async Task ListMyShareLinks_PageBelowOne_Returns400()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        await builder.CreateUserAsync(TestAuthSub);

        var controller = CreateController(db);
        var result = await controller.ListMyShareLinks(page: 0);

        var obj = Assert.IsAssignableFrom<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status400BadRequest, obj.StatusCode);
    }

    [Fact]
    public async Task ListMyShareLinks_EmptyResult_WhenUserHasNoAlbums()
    {
        using var db = TestDbContextFactory.Create();
        var builder = new TestDataBuilder(db);
        await builder.CreateUserAsync(TestAuthSub);

        var controller = CreateController(db);
        var result = await controller.ListMyShareLinks();

        var paged = Assert.IsType<PagedResult<ShareLinkSummary>>(Assert.IsType<OkObjectResult>(result).Value);
        Assert.Empty(paged.Items);
        Assert.Null(paged.NextSkip);
    }
}
