using System.Data.Common;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Data;
using Mosaic.Backend.Models;
using Mosaic.Backend.Models.ShareLinks;
using Mosaic.Backend.Tests.Helpers;
using Xunit;

namespace Mosaic.Backend.Tests.Controllers;

public sealed class ShareLinkPaginationSqlTests
{
    private const string OwnerAuthSub = "share-link-sql-owner";

    [Fact]
    public async Task List_UsesDatabaseOrderingLimitAndOffset()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var recorder = new SqlRecorder();
        var options = new DbContextOptionsBuilder<MosaicDbContext>()
            .UseSqlite(connection)
            .AddInterceptors(recorder)
            .Options;
        await using var db = new MosaicDbContext(options);
        await db.Database.EnsureCreatedAsync();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var baseline = DateTimeOffset.UtcNow.AddHours(-1);
        for (var index = 0; index < 12; index++)
        {
            var link = await builder.CreateShareLinkAsync(album, accessTier: (index % 3) + 1);
            link.CreatedAt = baseline.AddMinutes(index);
        }
        await db.SaveChangesAsync();

        var controller = CreateController(db);
        recorder.Commands.Clear();

        var result = await controller.List(album.Id, skip: 4, take: 3);

        var ok = Assert.IsType<OkObjectResult>(result);
        var page = Assert.IsType<PagedResult<ShareLinkResponse>>(ok.Value);
        Assert.Equal(3, page.Items.Count);
        Assert.Equal("12", controller.Response.Headers["X-Pagination-Total-Count"].ToString());
        var pageSql = Assert.Single(recorder.Commands, IsBoundedShareLinkSelect);
        Assert.Contains("ORDER BY", pageSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("created_at_unix_milliseconds", pageSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("LIMIT", pageSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("OFFSET", pageSql, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ListWithSecrets_FiltersCountsAndPagesEntirelyInDatabase()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var recorder = new SqlRecorder();
        var options = new DbContextOptionsBuilder<MosaicDbContext>()
            .UseSqlite(connection)
            .AddInterceptors(recorder)
            .Options;
        await using var db = new MosaicDbContext(options);
        await db.Database.EnsureCreatedAsync();
        var builder = new TestDataBuilder(db);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner);
        var secret = TestDataBuilder.GenerateRandomBytes(40);
        var baseline = DateTimeOffset.UtcNow.AddHours(-1);
        for (var index = 0; index < 8; index++)
        {
            var link = await builder.CreateShareLinkAsync(album, ownerEncryptedSecret: secret);
            link.CreatedAt = baseline.AddMinutes(index);
        }
        await builder.CreateShareLinkAsync(
            album,
            expiresAt: DateTimeOffset.UtcNow.AddMinutes(-5),
            ownerEncryptedSecret: secret);
        await builder.CreateShareLinkAsync(
            album,
            maxUses: 1,
            useCount: 1,
            ownerEncryptedSecret: secret);
        await builder.CreateShareLinkAsync(album, isRevoked: true, ownerEncryptedSecret: secret);
        await builder.CreateShareLinkAsync(album, ownerEncryptedSecret: null);
        await db.SaveChangesAsync();

        var controller = CreateController(db);
        recorder.Commands.Clear();

        var result = await controller.ListWithSecrets(album.Id, skip: 2, take: 3);

        var ok = Assert.IsType<OkObjectResult>(result);
        var page = Assert.IsType<PagedResult<ShareLinkWithSecretResponse>>(ok.Value);
        Assert.Equal(3, page.Items.Count);
        Assert.Equal("8", controller.Response.Headers["X-Pagination-Total-Count"].ToString());
        var pageSql = Assert.Single(recorder.Commands, IsBoundedShareLinkSelect);
        Assert.Contains("expires_at_unix_milliseconds", pageSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("LIMIT", pageSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("OFFSET", pageSql, StringComparison.OrdinalIgnoreCase);
    }

    private static ShareLinksController CreateController(MosaicDbContext db)
        => new(db, new MockCurrentUserService(db))
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = TestHttpContext.Create(OwnerAuthSub)
            }
        };

    private static bool IsBoundedShareLinkSelect(string command)
        => command.Contains("FROM \"share_links\"", StringComparison.OrdinalIgnoreCase)
            && command.Contains("ORDER BY", StringComparison.OrdinalIgnoreCase)
            && command.Contains("LIMIT", StringComparison.OrdinalIgnoreCase);

    private sealed class SqlRecorder : DbCommandInterceptor
    {
        public List<string> Commands { get; } = [];

        public override InterceptionResult<DbDataReader> ReaderExecuting(
            DbCommand command,
            CommandEventData eventData,
            InterceptionResult<DbDataReader> result)
        {
            Commands.Add(command.CommandText);
            return result;
        }

        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command,
            CommandEventData eventData,
            InterceptionResult<DbDataReader> result,
            CancellationToken cancellationToken = default)
        {
            Commands.Add(command.CommandText);
            return ValueTask.FromResult(result);
        }
    }
}
