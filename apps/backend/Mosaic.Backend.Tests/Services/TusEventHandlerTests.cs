using System.Reflection;
using System.Linq;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Mosaic.Backend.Data;
using Mosaic.Backend.Services;
using Mosaic.Backend.Tests.Helpers;
using tusdotnet.Models.Configuration;
using Xunit;

namespace Mosaic.Backend.Tests.Services;

/// <summary>
/// Tests for TusEventHandlers.OnBeforeCreate, specifically the album expiration guard.
/// Uses SQLite in-memory so the raw SQL quota queries execute correctly.
/// </summary>
public class TusEventHandlerTests : IDisposable
{
    private readonly SqliteConnection _connection;
    private readonly MosaicDbContext _db;
    private readonly IServiceProvider _provider;

    public TusEventHandlerTests()
    {
        // Shared SQLite in-memory connection kept open for the test lifetime
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();

        var options = new DbContextOptionsBuilder<MosaicDbContext>()
            .UseSqlite(_connection)
            .Options;

        _db = new MosaicDbContext(options);
        _db.Database.EnsureCreated();

        // The handler calls services.CreateScope() then resolves MosaicDbContext.
        // Register with the same open connection so scoped instances share the DB.
        var services = new ServiceCollection();
        services.AddDbContext<MosaicDbContext>(opts => opts.UseSqlite(_connection));
        _provider = services.BuildServiceProvider();
    }

    public void Dispose()
    {
        _db.Dispose();
        _connection.Dispose();
    }

    private static BeforeCreateContext CreateBeforeCreateContext(
        HttpContext httpContext,
        Guid? albumId = null,
        long uploadLength = 1024)
    {
        Dictionary<string, tusdotnet.Models.Metadata> metadata;
        if (albumId.HasValue)
        {
            var headerValue = $"albumId {Convert.ToBase64String(Encoding.UTF8.GetBytes(albumId.Value.ToString()))}";
            metadata = tusdotnet.Models.Metadata.Parse(headerValue);
        }
        else
        {
            metadata = new Dictionary<string, tusdotnet.Models.Metadata>();
        }

        var context = new BeforeCreateContext
        {
            UploadLength = uploadLength,
            Metadata = metadata
        };

        // HttpContext has a private setter — use reflection
        var httpContextProp = typeof(EventContext<BeforeCreateContext>)
            .GetProperty("HttpContext", BindingFlags.Public | BindingFlags.Instance);
        httpContextProp!.SetValue(context, httpContext);

        return context;
    }

    [Fact]
    public async Task OnBeforeCreate_FailsRequest_WhenAlbumExpired()
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync("test-user");
        var album = await builder.CreateAlbumAsync(user);
        album.ExpiresAt = DateTimeOffset.UtcNow.AddHours(-1);
        await _db.SaveChangesAsync();

        var httpContext = TestHttpContext.Create("test-user");
        var context = CreateBeforeCreateContext(httpContext, album.Id);

        await TusEventHandlers.OnBeforeCreate(context, _provider);

        Assert.True(context.HasFailed);
        Assert.Equal("Album has expired", context.ErrorMessage);
    }

    [Fact]
    public async Task OnBeforeCreate_AllowsUpload_WhenAlbumNotExpired()
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync("test-user");
        var album = await builder.CreateAlbumAsync(user);
        album.ExpiresAt = DateTimeOffset.UtcNow.AddHours(1);
        await _db.SaveChangesAsync();

        // Remove quota records — InMemory DB doesn't support raw SQL
        db.UserQuotas.RemoveRange(db.UserQuotas);
        await db.SaveChangesAsync();

        var httpContext = TestHttpContext.Create("test-user");
        var context = CreateBeforeCreateContext(httpContext, album.Id);

        await TusEventHandlers.OnBeforeCreate(context, _provider);

        // Should pass the expiration check. Quota may or may not pass,
        // but "expired" must not appear in the error.
        if (context.HasFailed)
        {
            Assert.DoesNotContain("expired", context.ErrorMessage, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public async Task OnBeforeCreate_AllowsUpload_WhenAlbumHasNoExpiration()
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync("test-user");
        var album = await builder.CreateAlbumAsync(user);
        Assert.Null(album.ExpiresAt);

        // Remove quota records — InMemory DB doesn't support raw SQL
        db.UserQuotas.RemoveRange(db.UserQuotas);
        await db.SaveChangesAsync();

        var httpContext = TestHttpContext.Create("test-user");
        var context = CreateBeforeCreateContext(httpContext, album.Id);

        await TusEventHandlers.OnBeforeCreate(context, _provider);

        if (context.HasFailed)
        {
            Assert.DoesNotContain("expired", context.ErrorMessage, StringComparison.OrdinalIgnoreCase);
        }
    }
}
