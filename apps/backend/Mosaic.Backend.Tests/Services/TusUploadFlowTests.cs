using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;
using Mosaic.Backend.Tests.Helpers;
using tusdotnet.Interfaces;
using tusdotnet.Models;
using tusdotnet.Models.Configuration;
using Xunit;

namespace Mosaic.Backend.Tests.Services;

public sealed class TusUploadFlowTests : IDisposable
{
    private readonly SqliteConnection _connection;
    private readonly MosaicDbContext _db;
    private readonly ServiceProvider _provider;

    public TusUploadFlowTests()
    {
        _connection = new SqliteConnection("Data Source=:memory:");
        _connection.Open();

        var options = new DbContextOptionsBuilder<MosaicDbContext>()
            .UseSqlite(_connection)
            .Options;

        _db = new MosaicDbContext(options);
        _db.Database.EnsureCreated();

        var services = new ServiceCollection();
        services.AddSingleton<IConfiguration>(new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Storage:Path"] = "G:\\Github\\Mosaic\\apps\\backend\\Mosaic.Backend.Tests\\TestTusStorage"
            })
            .Build());
        services.AddDbContext<MosaicDbContext>(opts => opts.UseSqlite(_connection));
        _provider = services.BuildServiceProvider();
    }

    public void Dispose()
    {
        _provider.Dispose();
        _db.Dispose();
        _connection.Dispose();
    }

    [Fact]
    public async Task CreateComplete_AndFileComplete_PersistReservationAndReconcileQuotaExactlyOnce()
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync("tus-owner");
        var album = await builder.CreateAlbumAsync(user);
        var quota = await _db.UserQuotas.FindAsync(user.Id);
        quota!.UsedStorageBytes = 0;
        await _db.SaveChangesAsync();

        var httpContext = TestHttpContext.Create("tus-owner");
        var beforeCreate = CreateBeforeCreateContext(httpContext, album.Id, uploadLength: 1024);
        await TusEventHandlers.OnBeforeCreate(beforeCreate, _provider);
        Assert.False(beforeCreate.HasFailed);

        _db.ChangeTracker.Clear();
        quota = await _db.UserQuotas.FindAsync(user.Id);
        Assert.Equal(1024, quota!.UsedStorageBytes);

        var fileId = Guid.NewGuid().ToString();
        var metadata = CreateMetadata(album.Id);
        var createComplete = CreateContext<CreateCompleteContext>(httpContext, ctx =>
        {
            ctx.FileId = fileId;
            ctx.UploadLength = 1024;
            ctx.Metadata = metadata;
        });

        await TusEventHandlers.OnCreateComplete(createComplete, _provider);
        _db.ChangeTracker.Clear();
        Assert.NotNull(await _db.TusUploadReservations.FindAsync(fileId));

        var store = new FakeTusStore();
        store.AddFile(fileId, new byte[2048], metadata);
        var fileComplete = CreateContext<FileCompleteContext>(TestHttpContext.Create("tus-owner"), ctx =>
        {
            ctx.FileId = fileId;
            ctx.Store = store;
        });

        await TusEventHandlers.OnFileComplete(fileComplete, _provider);

        _db.ChangeTracker.Clear();
        quota = await _db.UserQuotas.FindAsync(user.Id);
        Assert.Equal(2048, quota!.UsedStorageBytes);
        Assert.Null(await _db.TusUploadReservations.FindAsync(fileId));
        Assert.Equal(2048, _db.Shards.Single(s => s.Id == Guid.Parse(fileId)).SizeBytes);
    }

    [Fact]
    public async Task OnFileComplete_AcceptsBase64UrlSha256MetadataFromWebClient()
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync("web-hash-user");
        var album = await builder.CreateAlbumAsync(user);
        var payload = Encoding.UTF8.GetBytes("encrypted shard envelope bytes");
        var clientSha256 = Base64UrlEncode(SHA256.HashData(payload));
        var serverSha256Hex = Convert.ToHexString(SHA256.HashData(payload)).ToLowerInvariant();

        var fileId = Guid.NewGuid().ToString();
        _db.TusUploadReservations.Add(new TusUploadReservation
        {
            FileId = fileId,
            UserId = user.Id,
            AlbumId = album.Id,
            ReservedBytes = payload.Length,
            UploadLength = payload.Length,
            ExpiresAt = DateTime.UtcNow.AddHours(1)
        });
        await _db.SaveChangesAsync();

        var metadata = CreateMetadata(album.Id, clientSha256);
        var store = new FakeTusStore();
        store.AddFile(fileId, payload, metadata);
        var fileComplete = CreateContext<FileCompleteContext>(TestHttpContext.Create("web-hash-user"), ctx =>
        {
            ctx.FileId = fileId;
            ctx.Store = store;
        });

        await TusEventHandlers.OnFileComplete(fileComplete, _provider);

        _db.ChangeTracker.Clear();
        var shard = await _db.Shards.SingleAsync(s => s.Id == Guid.Parse(fileId));
        Assert.Equal(serverSha256Hex, shard.Sha256);
        Assert.Null(await _db.TusUploadReservations.FindAsync(fileId));
    }

    [Fact]
    public async Task OnAuthorize_RejectsPatchFromDifferentUser()
    {
        var builder = new TestDataBuilder(_db);
        var owner = await builder.CreateUserAsync("owner");
        await builder.CreateUserAsync("other-user");

        _db.TusUploadReservations.Add(new TusUploadReservation
        {
            FileId = Guid.NewGuid().ToString(),
            UserId = owner.Id,
            ReservedBytes = 512,
            UploadLength = 512,
            ExpiresAt = DateTime.UtcNow.AddHours(1)
        });
        await _db.SaveChangesAsync();

        var reservation = _db.TusUploadReservations.Single();
        var context = CreateContext<AuthorizeContext>(TestHttpContext.Create("other-user"), ctx =>
        {
            ctx.FileId = reservation.FileId;
            ctx.Intent = IntentType.WriteFile;
        });

        await TusEventHandlers.OnAuthorize(context, _provider);

        Assert.True(context.HasFailed);
        Assert.Equal("Unauthorized", context.ErrorMessage);
    }

    [Fact]
    public async Task OnDeleteComplete_RefundsReservedQuota()
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync("deleter");
        var quota = await _db.UserQuotas.FindAsync(user.Id);
        quota!.UsedStorageBytes = 4096;

        var reservation = new TusUploadReservation
        {
            FileId = Guid.NewGuid().ToString(),
            UserId = user.Id,
            ReservedBytes = 1024,
            UploadLength = 1024,
            ExpiresAt = DateTime.UtcNow.AddHours(1)
        };
        _db.TusUploadReservations.Add(reservation);
        await _db.SaveChangesAsync();

        var context = CreateContext<DeleteCompleteContext>(TestHttpContext.Create("deleter"), ctx =>
        {
            ctx.FileId = reservation.FileId;
        });

        await TusEventHandlers.OnDeleteComplete(context, _provider);

        _db.ChangeTracker.Clear();
        quota = await _db.UserQuotas.FindAsync(user.Id);
        Assert.Equal(3072, quota!.UsedStorageBytes);
        Assert.Null(await _db.TusUploadReservations.FindAsync(reservation.FileId));
    }

    [Fact]
    public async Task OnFileComplete_RefundsAndDeletesUpload_WhenMembershipRevokedBeforeFinalPatch()
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync("revoked-user");
        var album = await builder.CreateAlbumAsync(user);
        var quota = await _db.UserQuotas.FindAsync(user.Id);
        quota!.UsedStorageBytes = 1024;

        var reservation = new TusUploadReservation
        {
            FileId = Guid.NewGuid().ToString(),
            UserId = user.Id,
            AlbumId = album.Id,
            ReservedBytes = 1024,
            UploadLength = 1024,
            ExpiresAt = DateTime.UtcNow.AddHours(1)
        };
        _db.TusUploadReservations.Add(reservation);
        await _db.SaveChangesAsync();

        var membership = _db.AlbumMembers.Single(am => am.AlbumId == album.Id && am.UserId == user.Id);
        membership.RevokedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        var store = new FakeTusStore();
        store.AddFile(reservation.FileId, new byte[1024], CreateMetadata(album.Id));

        var fileComplete = CreateContext<FileCompleteContext>(TestHttpContext.Create("revoked-user"), ctx =>
        {
            ctx.FileId = reservation.FileId;
            ctx.Store = store;
        });

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => TusEventHandlers.OnFileComplete(fileComplete, _provider));
        Assert.Equal("Access denied", ex.Message);

        _db.ChangeTracker.Clear();
        quota = await _db.UserQuotas.FindAsync(user.Id);
        Assert.Equal(0, quota!.UsedStorageBytes);
        Assert.Null(await _db.TusUploadReservations.FindAsync(reservation.FileId));
        Assert.DoesNotContain(reservation.FileId, store.Files.Keys);
    }

    private static BeforeCreateContext CreateBeforeCreateContext(HttpContext httpContext, Guid albumId, long uploadLength)
    {
        var ctx = new BeforeCreateContext
        {
            UploadLength = uploadLength,
            Metadata = CreateMetadata(albumId)
        };

        SetHttpContext(ctx, httpContext);
        return ctx;
    }

    private static Dictionary<string, tusdotnet.Models.Metadata> CreateMetadata(Guid albumId, string? sha256 = null)
    {
        var header = $"albumId {Convert.ToBase64String(Encoding.UTF8.GetBytes(albumId.ToString()))}";
        if (!string.IsNullOrWhiteSpace(sha256))
        {
            header += $",sha256 {Convert.ToBase64String(Encoding.UTF8.GetBytes(sha256))}";
        }

        return tusdotnet.Models.Metadata.Parse(header);
    }

    private static string Base64UrlEncode(byte[] bytes)
        => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static TContext CreateContext<TContext>(HttpContext httpContext, Action<TContext> configure)
        where TContext : EventContext<TContext>, new()
    {
        var context = new TContext();
        configure(context);
        SetHttpContext(context, httpContext);
        return context;
    }

    private static void SetHttpContext<TContext>(EventContext<TContext> context, HttpContext httpContext)
        where TContext : EventContext<TContext>, new()
    {
        typeof(EventContext<TContext>)
            .GetProperty("HttpContext", BindingFlags.Public | BindingFlags.Instance)!
            .SetValue(context, httpContext);
    }

    private sealed class FakeTusStore : ITusStore, ITusReadableStore, ITusTerminationStore
    {
        public Dictionary<string, FakeTusFile> Files { get; } = [];

        public void AddFile(string fileId, byte[] content, Dictionary<string, tusdotnet.Models.Metadata> metadata)
        {
            Files[fileId] = new FakeTusFile(fileId, content, metadata);
        }

        public Task<long> AppendDataAsync(string fileId, Stream stream, CancellationToken cancellationToken)
            => throw new NotSupportedException();

        public Task<bool> FileExistAsync(string fileId, CancellationToken cancellationToken)
            => Task.FromResult(Files.ContainsKey(fileId));

        public Task<ITusFile?> GetFileAsync(string fileId, CancellationToken cancellationToken)
            => Task.FromResult<ITusFile?>(Files.TryGetValue(fileId, out var file) ? file : null);

        public Task<long?> GetUploadLengthAsync(string fileId, CancellationToken cancellationToken)
            => Task.FromResult<long?>(Files.TryGetValue(fileId, out var file) ? file.Content.Length : null);

        public Task<long> GetUploadOffsetAsync(string fileId, CancellationToken cancellationToken)
            => Task.FromResult(Files.TryGetValue(fileId, out var file) ? (long)file.Content.Length : 0);

        public Task DeleteFileAsync(string fileId, CancellationToken cancellationToken)
        {
            Files.Remove(fileId);
            return Task.CompletedTask;
        }
    }

    private sealed class FakeTusFile(string id, byte[] content, Dictionary<string, tusdotnet.Models.Metadata> metadata) : ITusFile
    {
        public string Id { get; } = id;
        public byte[] Content { get; } = content;
        private readonly Dictionary<string, tusdotnet.Models.Metadata> _metadata = metadata;

        public Task<Stream> GetContentAsync(CancellationToken cancellationToken)
            => Task.FromResult<Stream>(new MemoryStream(Content, writable: false));

        public Task<Dictionary<string, tusdotnet.Models.Metadata>> GetMetadataAsync(CancellationToken cancellationToken)
            => Task.FromResult(_metadata);
    }
}
