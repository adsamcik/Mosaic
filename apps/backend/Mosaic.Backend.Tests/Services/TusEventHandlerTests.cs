using System.Reflection;
using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.AspNetCore.Http;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Data;
using Mosaic.Backend.Services;
using Mosaic.Backend.Tests.Helpers;
using tusdotnet.Models.Configuration;
using Xunit;

namespace Mosaic.Backend.Tests.Services;

/// <summary>
/// Tests for TusEventHandlers.OnBeforeCreateAsync album expiration guard.
/// Uses SQLite in-memory so the raw SQL quota queries work correctly.
/// </summary>
public class TusEventHandlerTests : IDisposable
{
    private readonly SqliteConnection _connection;
    private readonly MosaicDbContext _db;
    private readonly IServiceProvider _provider;
    private readonly string _storagePath;

    public TusEventHandlerTests()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();

        var options = new DbContextOptionsBuilder<MosaicDbContext>()
            .UseSqlite(_connection)
            .Options;

        _db = new MosaicDbContext(options);
        _db.Database.EnsureCreated();
        _storagePath = Path.Combine(Path.GetTempPath(), $"mosaic-tus-tests-{Guid.NewGuid()}");
        Directory.CreateDirectory(_storagePath);

        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Storage:Path"] = _storagePath
            })
            .Build();

        var services = new ServiceCollection();
        services.AddDbContext<MosaicDbContext>(opts => opts.UseSqlite(_connection));
        services.AddSingleton<IConfiguration>(configuration);
        _provider = services.BuildServiceProvider();
    }

    public void Dispose()
    {
        _db.Dispose();
        _connection.Dispose();
        Directory.Delete(_storagePath, recursive: true);
    }

    private static BeforeCreateContext CreateBeforeCreateContext(
        HttpContext httpContext, Guid? albumId = null, long uploadLength = 1024)
    {
        Dictionary<string, tusdotnet.Models.Metadata> metadata;
        if (albumId.HasValue)
        {
            var hdr = $"albumId {Convert.ToBase64String(Encoding.UTF8.GetBytes(albumId.Value.ToString()))}";
            metadata = tusdotnet.Models.Metadata.Parse(hdr);
        }
        else
        {
            metadata = new Dictionary<string, tusdotnet.Models.Metadata>();
        }

        var ctx = new BeforeCreateContext { UploadLength = uploadLength, Metadata = metadata };

        typeof(EventContext<BeforeCreateContext>)
            .GetProperty("HttpContext", BindingFlags.Public | BindingFlags.Instance)!
            .SetValue(ctx, httpContext);

        return ctx;
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

        await TusEventHandlers.OnBeforeCreateAsync(context, _provider);

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

        var httpContext = TestHttpContext.Create("test-user");
        var context = CreateBeforeCreateContext(httpContext, album.Id);

        await TusEventHandlers.OnBeforeCreateAsync(context, _provider);

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

        var httpContext = TestHttpContext.Create("test-user");
        var context = CreateBeforeCreateContext(httpContext, album.Id);

        await TusEventHandlers.OnBeforeCreateAsync(context, _provider);

        if (context.HasFailed)
        {
            Assert.DoesNotContain("expired", context.ErrorMessage, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public async Task CleanupExpiredReservations_ProcessesAllEligibleBatchesInOneRun()
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync("batch-user");
        var quota = await _db.UserQuotas.FindAsync(user.Id);
        quota!.UsedStorageBytes = 250_000;

        var reservations = Enumerable.Range(0, 250)
            .Select(i => new TusUploadReservation
            {
                FileId = $"expired-file-{i}",
                UserId = user.Id,
                ReservedBytes = 1_000,
                UploadLength = 1_000,
                CreatedAt = DateTime.UtcNow.AddHours(-3),
                ExpiresAt = DateTime.UtcNow.AddHours(-1)
            })
            .ToList();

        _db.TusUploadReservations.AddRange(reservations);
        await _db.SaveChangesAsync();

        var cleaned = await TusEventHandlers.CleanupExpiredReservationsAsync(_provider);

        Assert.Equal(250, cleaned);
        Assert.Empty(_db.TusUploadReservations);
        quota = await _db.UserQuotas.FindAsync(user.Id);
        await _db.Entry(quota!).ReloadAsync();
        Assert.Equal(0, quota!.UsedStorageBytes);
    }
}
