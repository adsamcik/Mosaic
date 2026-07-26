using System.Data.Common;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
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
    private const string ValidContentSha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
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
        await TusEventHandlers.OnBeforeCreateAsync(beforeCreate, _provider);
        Assert.False(beforeCreate.HasFailed);

        _db.ChangeTracker.Clear();
        quota = await _db.UserQuotas.FindAsync(user.Id);
        Assert.Equal(0, quota!.UsedStorageBytes);
        Assert.Empty(await _db.TusUploadReservations.ToListAsync());

        var fileId = Guid.NewGuid().ToString();
        var payload = new byte[2048];
        var metadata = CreateMetadata(album.Id, Sha256Hex(payload));
        var createComplete = CreateContext<CreateCompleteContext>(httpContext, ctx =>
        {
            ctx.FileId = fileId;
            ctx.UploadLength = 1024;
            ctx.Metadata = metadata;
        });

        await TusEventHandlers.OnCreateCompleteAsync(createComplete, _provider);
        _db.ChangeTracker.Clear();
        Assert.NotNull(await _db.TusUploadReservations.FindAsync(fileId));
        quota = await _db.UserQuotas.FindAsync(user.Id);
        Assert.Equal(1024, quota!.UsedStorageBytes);

        var store = new FakeTusStore();
        store.AddFile(fileId, payload, metadata);
        var fileComplete = CreateContext<FileCompleteContext>(TestHttpContext.Create("tus-owner"), ctx =>
        {
            ctx.FileId = fileId;
            ctx.Store = store;
        });

        await TusEventHandlers.OnFileCompleteAsync(fileComplete, _provider);

        _db.ChangeTracker.Clear();
        quota = await _db.UserQuotas.FindAsync(user.Id);
        Assert.Equal(2048, quota!.UsedStorageBytes);
        Assert.Null(await _db.TusUploadReservations.FindAsync(fileId));
        Assert.Equal(2048, _db.Shards.Single(s => s.Id == Guid.Parse(fileId)).SizeBytes);
    }

    [Fact]
    public async Task OnFileComplete_RetainsCompletedBlob_WhenCommitAcknowledgementIsLost()
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync("commit-ambiguity-user");
        var album = await builder.CreateAlbumAsync(user);
        var payload = Encoding.UTF8.GetBytes("completed encrypted shard");
        var fileId = Guid.NewGuid().ToString();
        var quota = await _db.UserQuotas.FindAsync(user.Id);
        quota!.UsedStorageBytes = payload.Length;
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

        var metadata = CreateMetadata(album.Id, Sha256Hex(payload));
        var store = new FakeTusStore();
        store.AddFile(fileId, payload, metadata);
        var fileComplete = CreateContext<FileCompleteContext>(TestHttpContext.Create(user.AuthSub), ctx =>
        {
            ctx.FileId = fileId;
            ctx.Store = store;
        });

        var services = new ServiceCollection();
        services.AddDbContext<MosaicDbContext>(opts => opts
            .UseSqlite(_connection)
            .AddInterceptors(new ThrowAfterCommitInterceptor()));
        using var faultingProvider = services.BuildServiceProvider();

        await Assert.ThrowsAsync<CommitAcknowledgementLostException>(
            () => TusEventHandlers.OnFileCompleteAsync(fileComplete, faultingProvider));

        _db.ChangeTracker.Clear();
        Assert.True(store.Files.ContainsKey(fileId));
        Assert.NotNull(await _db.Shards.FindAsync(Guid.Parse(fileId)));
        Assert.Null(await _db.TusUploadReservations.FindAsync(fileId));

        var lifecycle = await _db.TusUploadLifecycles.FindAsync(fileId);
        Assert.NotNull(lifecycle);
        Assert.Equal(TusUploadLifecycleState.COMMITTED, lifecycle!.State);

        // The client may retry after a lost commit acknowledgement. It must
        // converge on the already-committed shard without deleting the blob
        // or attempting a duplicate insert.
        await TusEventHandlers.OnFileCompleteAsync(fileComplete, _provider);
        Assert.True(store.Files.ContainsKey(fileId));
        Assert.Single(await _db.Shards.Where(shard => shard.Id == Guid.Parse(fileId)).ToListAsync());
    }

    [Fact]
    public async Task OnFileComplete_QuarantinesAndRetainsBlob_WhenDatabaseFailsBeforeCommit()
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync("precommit-failure-user");
        var album = await builder.CreateAlbumAsync(user);
        var payload = Encoding.UTF8.GetBytes("completed encrypted shard retained for operator reconciliation");
        var fileId = Guid.NewGuid().ToString();
        var quota = await _db.UserQuotas.FindAsync(user.Id);
        quota!.UsedStorageBytes = payload.Length;
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

        var store = new FakeTusStore();
        store.AddFile(fileId, payload, CreateMetadata(album.Id, Sha256Hex(payload)));
        var fileComplete = CreateContext<FileCompleteContext>(TestHttpContext.Create(user.AuthSub), ctx =>
        {
            ctx.FileId = fileId;
            ctx.Store = store;
        });
        var services = new ServiceCollection();
        services.AddDbContext<MosaicDbContext>(opts => opts
            .UseSqlite(_connection)
            .AddInterceptors(new ThrowBeforeShardCommitInterceptor()));
        using var faultingProvider = services.BuildServiceProvider();

        await Assert.ThrowsAsync<PreCommitFailureException>(
            () => TusEventHandlers.OnFileCompleteAsync(fileComplete, faultingProvider));

        _db.ChangeTracker.Clear();
        Assert.True(store.Files.ContainsKey(fileId));
        Assert.Null(await _db.Shards.FindAsync(Guid.Parse(fileId)));
        Assert.NotNull(await _db.TusUploadReservations.FindAsync(fileId));
        var lifecycle = await _db.TusUploadLifecycles.FindAsync(fileId);
        Assert.NotNull(lifecycle);
        Assert.Equal(TusUploadLifecycleState.QUARANTINED, lifecycle!.State);
        Assert.Equal("database-finalization-failed", lifecycle.QuarantineReason);
    }

    [Fact]
    public async Task OnFileComplete_AcceptsContentSha256MetadataFromWebClient()
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync("web-hash-user");
        var album = await builder.CreateAlbumAsync(user);
        var payload = Encoding.UTF8.GetBytes("encrypted shard envelope bytes");
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

        var metadata = CreateMetadata(album.Id, serverSha256Hex);
        var store = new FakeTusStore();
        store.AddFile(fileId, payload, metadata);
        var fileComplete = CreateContext<FileCompleteContext>(TestHttpContext.Create("web-hash-user"), ctx =>
        {
            ctx.FileId = fileId;
            ctx.Store = store;
        });

        await TusEventHandlers.OnFileCompleteAsync(fileComplete, _provider);

        _db.ChangeTracker.Clear();
        var shard = await _db.Shards.SingleAsync(s => s.Id == Guid.Parse(fileId));
        Assert.Equal(serverSha256Hex, shard.Sha256);
        Assert.Equal(3, shard.EnvelopeVersion);
        Assert.Null(await _db.TusUploadReservations.FindAsync(fileId));
    }

    [Fact]
    public async Task OnFileComplete_RejectsAndCleansUp_WhenContentHashDoesNotMatchBytes()
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync("hash-mismatch-user");
        var album = await builder.CreateAlbumAsync(user);
        var payload = Encoding.UTF8.GetBytes("completed encrypted bytes with a different digest");
        var quota = await _db.UserQuotas.FindAsync(user.Id);
        quota!.UsedStorageBytes = payload.Length;
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

        var store = new FakeTusStore();
        store.AddFile(fileId, payload, CreateMetadata(album.Id, ValidContentSha256));
        var fileComplete = CreateContext<FileCompleteContext>(TestHttpContext.Create(user.AuthSub), ctx =>
        {
            ctx.FileId = fileId;
            ctx.Store = store;
        });

        var error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => TusEventHandlers.OnFileCompleteAsync(fileComplete, _provider));

        Assert.Equal("Tus content-sha256 metadata does not match the completed upload bytes.", error.Message);
        _db.ChangeTracker.Clear();
        Assert.DoesNotContain(fileId, store.Files.Keys);
        Assert.Null(await _db.Shards.FindAsync(Guid.Parse(fileId)));
        Assert.Null(await _db.TusUploadReservations.FindAsync(fileId));
        Assert.Equal(0, (await _db.UserQuotas.FindAsync(user.Id))!.UsedStorageBytes);
        Assert.Equal(
            TusUploadLifecycleState.CANCELLED,
            (await _db.TusUploadLifecycles.FindAsync(fileId))!.State);
    }

    [Fact]
    public async Task OnBeforeCreate_FailsRequest_WhenContentSha256MetadataMissing()
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync("missing-hash-user");
        var album = await builder.CreateAlbumAsync(user);
        var httpContext = TestHttpContext.Create(user.AuthSub);
        var beforeCreate = CreateContext<BeforeCreateContext>(httpContext, ctx =>
        {
            ctx.UploadLength = 1024;
            ctx.Metadata = CreateMetadata(album.Id, contentSha256: null);
        });

        await TusEventHandlers.OnBeforeCreateAsync(beforeCreate, _provider);

        Assert.True(beforeCreate.HasFailed);
        Assert.Equal("Missing Tus metadata 'content-sha256'", beforeCreate.ErrorMessage);
    }

    [Theory]
    [InlineData("ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789")]
    [InlineData("0123456789abcdef")]
    [InlineData("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg")]
    public async Task OnBeforeCreate_FailsRequest_WhenContentSha256MetadataMalformed(string malformedSha256)
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync($"bad-hash-user-{Guid.NewGuid()}");
        var album = await builder.CreateAlbumAsync(user);
        var httpContext = TestHttpContext.Create(user.AuthSub);
        var beforeCreate = CreateContext<BeforeCreateContext>(httpContext, ctx =>
        {
            ctx.UploadLength = 1024;
            ctx.Metadata = CreateMetadata(album.Id, malformedSha256);
        });

        await TusEventHandlers.OnBeforeCreateAsync(beforeCreate, _provider);

        Assert.True(beforeCreate.HasFailed);
        Assert.Equal("Tus metadata 'content-sha256' must be a lowercase 64-character hex SHA-256", beforeCreate.ErrorMessage);
    }

    [Fact]
    public async Task OnBeforeCreate_FailsRequest_WhenEnvelopeVersionMissing()
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync($"missing-envelope-ver-{Guid.NewGuid()}");
        var album = await builder.CreateAlbumAsync(user);
        var beforeCreate = CreateContext<BeforeCreateContext>(TestHttpContext.Create(user.AuthSub), ctx =>
        {
            ctx.UploadLength = 1024;
            ctx.Metadata = CreateMetadata(album.Id, envelopeVersion: null);
        });

        await TusEventHandlers.OnBeforeCreateAsync(beforeCreate, _provider);

        Assert.True(beforeCreate.HasFailed);
        Assert.Equal("Missing Tus metadata 'envelope-version'", beforeCreate.ErrorMessage);
    }

    [Theory]
    [InlineData("2")]
    [InlineData("5")]
    [InlineData("not-a-number")]
    public async Task OnBeforeCreate_FailsRequest_WhenEnvelopeVersionUnsupportedOrMalformed(string value)
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync($"bad-envelope-ver-{Guid.NewGuid()}");
        var album = await builder.CreateAlbumAsync(user);
        var beforeCreate = CreateContext<BeforeCreateContext>(TestHttpContext.Create(user.AuthSub), ctx =>
        {
            ctx.UploadLength = 1024;
            ctx.Metadata = CreateMetadata(album.Id, envelopeVersion: value);
        });

        await TusEventHandlers.OnBeforeCreateAsync(beforeCreate, _provider);

        Assert.True(beforeCreate.HasFailed);
        Assert.Contains("envelope-version", beforeCreate.ErrorMessage);
    }

    [Fact]
    public async Task OnBeforeCreate_FailsRequest_WhenBlobFormatVersionMissing()
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync($"missing-blob-ver-{Guid.NewGuid()}");
        var album = await builder.CreateAlbumAsync(user);
        var httpContext = TestHttpContext.Create(user.AuthSub);
        var beforeCreate = CreateContext<BeforeCreateContext>(httpContext, ctx =>
        {
            ctx.UploadLength = 1024;
            ctx.Metadata = CreateMetadata(album.Id, blobFormatVersion: null);
        });

        await TusEventHandlers.OnBeforeCreateAsync(beforeCreate, _provider);

        Assert.True(beforeCreate.HasFailed);
        Assert.Equal("Missing Tus metadata 'blob-format-version'", beforeCreate.ErrorMessage);
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-1")]
    [InlineData("99")]
    [InlineData("not-a-number")]
    [InlineData("1.0")]
    public async Task OnBeforeCreate_FailsRequest_WhenBlobFormatVersionUnsupportedOrMalformed(string value)
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync($"bad-blob-ver-{Guid.NewGuid()}");
        var album = await builder.CreateAlbumAsync(user);
        var httpContext = TestHttpContext.Create(user.AuthSub);
        var beforeCreate = CreateContext<BeforeCreateContext>(httpContext, ctx =>
        {
            ctx.UploadLength = 1024;
            ctx.Metadata = CreateMetadata(album.Id, blobFormatVersion: value);
        });

        await TusEventHandlers.OnBeforeCreateAsync(beforeCreate, _provider);

        Assert.True(beforeCreate.HasFailed);
        Assert.Contains("blob-format-version", beforeCreate.ErrorMessage);
    }

    [Fact]
    public async Task OnBeforeCreate_Succeeds_WhenBlobFormatVersionIsCurrent()
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync($"ok-blob-ver-{Guid.NewGuid()}");
        var album = await builder.CreateAlbumAsync(user);
        var httpContext = TestHttpContext.Create(user.AuthSub);
        var beforeCreate = CreateContext<BeforeCreateContext>(httpContext, ctx =>
        {
            ctx.UploadLength = 1024;
            ctx.Metadata = CreateMetadata(album.Id, blobFormatVersion: "1");
        });

        await TusEventHandlers.OnBeforeCreateAsync(beforeCreate, _provider);

        Assert.False(beforeCreate.HasFailed);
    }

    [Fact]
    public async Task OnFileComplete_PersistsAndroidOpaqueShard_WhenMimeMetadataDoesNotMatchCiphertext()
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync("android-opaque-user");
        var album = await builder.CreateAlbumAsync(user);
        var payload = Encoding.UTF8.GetBytes("not-a-jpeg encrypted Android shard envelope; exif=private-gps");
        var serverSha256Hex = Convert.ToHexString(SHA256.HashData(payload)).ToLowerInvariant();
        var plaintextFilename = "android-cleartext-private-location.jpg";

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

        var metadata = CreateMetadata(
            album.Id,
            serverSha256Hex,
            new Dictionary<string, string>
            {
                ["contentType"] = "image/jpeg",
                ["filename"] = plaintextFilename
            });
        var store = new FakeTusStore();
        store.AddFile(fileId, payload, metadata);
        var fileComplete = CreateContext<FileCompleteContext>(TestHttpContext.Create("android-opaque-user"), ctx =>
        {
            ctx.FileId = fileId;
            ctx.Store = store;
        });

        await TusEventHandlers.OnFileCompleteAsync(fileComplete, _provider);

        _db.ChangeTracker.Clear();
        var shard = await _db.Shards.SingleAsync(s => s.Id == Guid.Parse(fileId));
        Assert.Equal(payload.Length, shard.SizeBytes);
        Assert.Equal(serverSha256Hex, shard.Sha256);
        Assert.Equal(fileId, shard.StorageKey);
        Assert.Equal(ShardStatus.PENDING, shard.Status);
        var shardEntityType = _db.Model.FindEntityType(typeof(Shard));
        Assert.NotNull(shardEntityType);
        var shardProperties = shardEntityType.GetProperties().ToList();
        Assert.DoesNotContain(shardProperties, property =>
            property.Name.Contains("filename", StringComparison.OrdinalIgnoreCase) ||
            property.Name.Contains("contenttype", StringComparison.OrdinalIgnoreCase) ||
            property.Name.Contains("mime", StringComparison.OrdinalIgnoreCase));
        var persistedShardTextValues = shardProperties
            .Where(property => property.ClrType == typeof(string))
            .Select(property => property.PropertyInfo?.GetValue(shard) as string)
            .Where(value => value != null)
            .Cast<string>();
        Assert.All(persistedShardTextValues, persistedValue =>
        {
            Assert.DoesNotContain(plaintextFilename, persistedValue, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("image/jpeg", persistedValue, StringComparison.OrdinalIgnoreCase);
        });
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

        await TusEventHandlers.OnAuthorizeAsync(context, _provider);

        Assert.True(context.HasFailed);
        Assert.Equal("Unauthorized", context.ErrorMessage);
    }

    [Fact]
    public async Task OnAuthorize_DeleteDurablyCancelsBeforeTusDeletesBlob()
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync("authorized-deleter");
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
        _db.TusUploadLifecycles.Add(new TusUploadLifecycle
        {
            FileId = reservation.FileId,
            UserId = user.Id,
            ReservedBytes = reservation.ReservedBytes,
            UploadLength = reservation.UploadLength,
            State = TusUploadLifecycleState.CREATED
        });
        await _db.SaveChangesAsync();

        var authorization = CreateContext<AuthorizeContext>(
            TestHttpContext.Create(user.AuthSub),
            context =>
            {
                context.FileId = reservation.FileId;
                context.Intent = IntentType.DeleteFile;
            });

        await TusEventHandlers.OnAuthorizeAsync(authorization, _provider);

        Assert.False(authorization.HasFailed);
        _db.ChangeTracker.Clear();
        Assert.Equal(3072, (await _db.UserQuotas.FindAsync(user.Id))!.UsedStorageBytes);
        Assert.Null(await _db.TusUploadReservations.FindAsync(reservation.FileId));
        Assert.Equal(
            TusUploadLifecycleState.CANCELLED,
            (await _db.TusUploadLifecycles.FindAsync(reservation.FileId))!.State);

        // tusdotnet calls the completion hook after physical deletion; the
        // callback must be idempotent because authorization already cancelled.
        var completion = CreateContext<DeleteCompleteContext>(
            TestHttpContext.Create(user.AuthSub),
            context => context.FileId = reservation.FileId);
        await TusEventHandlers.OnDeleteCompleteAsync(completion, _provider);

        _db.ChangeTracker.Clear();
        Assert.Equal(3072, (await _db.UserQuotas.FindAsync(user.Id))!.UsedStorageBytes);
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

        await TusEventHandlers.OnDeleteCompleteAsync(context, _provider);

        _db.ChangeTracker.Clear();
        quota = await _db.UserQuotas.FindAsync(user.Id);
        Assert.Equal(3072, quota!.UsedStorageBytes);
        Assert.Null(await _db.TusUploadReservations.FindAsync(reservation.FileId));
    }

    [Fact]
    public async Task OnDeleteComplete_RollsBackQuotaRefund_WhenReservationDeleteFails()
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync("delete-refund-rollback-user");
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
        _db.TusUploadLifecycles.Add(new TusUploadLifecycle
        {
            FileId = reservation.FileId,
            UserId = user.Id,
            ReservedBytes = reservation.ReservedBytes,
            UploadLength = reservation.UploadLength,
            State = TusUploadLifecycleState.CREATED
        });
        await _db.SaveChangesAsync();
        _db.ChangeTracker.Clear();

        var services = new ServiceCollection();
        services.AddDbContext<MosaicDbContext>(opts => opts
            .UseSqlite(_connection)
            .AddInterceptors(new ThrowBeforeReservationDeleteInterceptor()));
        using var faultingProvider = services.BuildServiceProvider();
        var context = CreateContext<DeleteCompleteContext>(TestHttpContext.Create(user.AuthSub), ctx =>
        {
            ctx.FileId = reservation.FileId;
        });

        await Assert.ThrowsAsync<ReservationDeleteFailureException>(
            () => TusEventHandlers.OnDeleteCompleteAsync(context, faultingProvider));

        _db.ChangeTracker.Clear();
        Assert.Equal(4096, (await _db.UserQuotas.FindAsync(user.Id))!.UsedStorageBytes);
        Assert.NotNull(await _db.TusUploadReservations.FindAsync(reservation.FileId));
        Assert.Equal(
            TusUploadLifecycleState.CREATED,
            (await _db.TusUploadLifecycles.FindAsync(reservation.FileId))!.State);

        await TusEventHandlers.OnDeleteCompleteAsync(context, _provider);
        _db.ChangeTracker.Clear();
        Assert.Equal(3072, (await _db.UserQuotas.FindAsync(user.Id))!.UsedStorageBytes);
        Assert.Null(await _db.TusUploadReservations.FindAsync(reservation.FileId));
        Assert.Equal(
            TusUploadLifecycleState.CANCELLED,
            (await _db.TusUploadLifecycles.FindAsync(reservation.FileId))!.State);
    }

    [Fact]
    public async Task ConcurrentFileCompleteCalls_ConvergeWithoutQuarantiningCommittedShard()
    {
        var databasePath = Path.Combine(Path.GetTempPath(), $"mosaic-tus-race-{Guid.NewGuid():N}.db");
        var connectionString = $"Data Source={databasePath}";
        try
        {
            var options = new DbContextOptionsBuilder<MosaicDbContext>()
                .UseSqlite(connectionString)
                .Options;
            Guid userId;
            Guid albumId;
            string authSub;
            var payload = Encoding.UTF8.GetBytes("concurrently finalized encrypted shard");
            var fileId = Guid.NewGuid().ToString();
            await using (var seedDb = new MosaicDbContext(options))
            {
                await seedDb.Database.EnsureCreatedAsync();
                var builder = new TestDataBuilder(seedDb);
                var user = await builder.CreateUserAsync("concurrent-finalize-user");
                var album = await builder.CreateAlbumAsync(user);
                userId = user.Id;
                albumId = album.Id;
                authSub = user.AuthSub;
                var quota = await seedDb.UserQuotas.FindAsync(user.Id);
                quota!.UsedStorageBytes = payload.Length;
                seedDb.TusUploadReservations.Add(new TusUploadReservation
                {
                    FileId = fileId,
                    UserId = user.Id,
                    AlbumId = album.Id,
                    ReservedBytes = payload.Length,
                    UploadLength = payload.Length,
                    ExpiresAt = DateTime.UtcNow.AddHours(1)
                });
                seedDb.TusUploadLifecycles.Add(new TusUploadLifecycle
                {
                    FileId = fileId,
                    UserId = user.Id,
                    AlbumId = album.Id,
                    ReservedBytes = payload.Length,
                    UploadLength = payload.Length,
                    ExpectedContentSha256 = Sha256Hex(payload),
                    EnvelopeVersion = 3,
                    State = TusUploadLifecycleState.CREATED
                });
                await seedDb.SaveChangesAsync();
            }

            var services = new ServiceCollection();
            services.AddDbContext<MosaicDbContext>(opts => opts.UseSqlite(connectionString));
            using var provider = services.BuildServiceProvider();
            var store = new FakeTusStore();
            store.AddFile(fileId, payload, CreateMetadata(albumId, Sha256Hex(payload)));
            var first = CreateContext<FileCompleteContext>(TestHttpContext.Create(authSub), ctx =>
            {
                ctx.FileId = fileId;
                ctx.Store = store;
            });
            var second = CreateContext<FileCompleteContext>(TestHttpContext.Create(authSub), ctx =>
            {
                ctx.FileId = fileId;
                ctx.Store = store;
            });

            await Task.WhenAll(
                TusEventHandlers.OnFileCompleteAsync(first, provider),
                TusEventHandlers.OnFileCompleteAsync(second, provider));

            await using var assertDb = new MosaicDbContext(options);
            Assert.Single(await assertDb.Shards.Where(shard => shard.Id == Guid.Parse(fileId)).ToListAsync());
            Assert.Null(await assertDb.TusUploadReservations.FindAsync(fileId));
            Assert.Equal(payload.Length, (await assertDb.UserQuotas.FindAsync(userId))!.UsedStorageBytes);
            var lifecycle = await assertDb.TusUploadLifecycles.FindAsync(fileId);
            Assert.Equal(TusUploadLifecycleState.COMMITTED, lifecycle!.State);
            Assert.Null(lifecycle.QuarantineReason);
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            File.Delete(databasePath);
        }
    }

    [Fact]
    public async Task CleanupExpiredReservations_DoesNotCancelUploadClaimedByFinalizer()
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync("cleanup-finalizer-race-user");
        var album = await builder.CreateAlbumAsync(user);
        var payload = Encoding.UTF8.GetBytes("expired reservation completing at the cleanup boundary");
        var fileId = Guid.NewGuid().ToString();
        var quota = await _db.UserQuotas.FindAsync(user.Id);
        quota!.UsedStorageBytes = payload.Length;
        _db.TusUploadReservations.Add(new TusUploadReservation
        {
            FileId = fileId,
            UserId = user.Id,
            AlbumId = album.Id,
            ReservedBytes = payload.Length,
            UploadLength = payload.Length,
            ExpiresAt = DateTime.UtcNow.AddMinutes(-1)
        });
        _db.TusUploadLifecycles.Add(new TusUploadLifecycle
        {
            FileId = fileId,
            UserId = user.Id,
            AlbumId = album.Id,
            ReservedBytes = payload.Length,
            UploadLength = payload.Length,
            ExpectedContentSha256 = Sha256Hex(payload),
            EnvelopeVersion = 3,
            State = TusUploadLifecycleState.CREATED
        });
        await _db.SaveChangesAsync();

        var storagePath = Path.Combine(Path.GetTempPath(), $"mosaic-tus-cleanup-race-{Guid.NewGuid():N}");
        Directory.CreateDirectory(storagePath);
        try
        {
            var services = new ServiceCollection();
            services.AddSingleton<IConfiguration>(new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Storage:Path"] = storagePath
                })
                .Build());
            services.AddDbContext<MosaicDbContext>(options => options.UseSqlite(_connection));
            using var provider = services.BuildServiceProvider();
            var readStarted = new TaskCompletionSource<bool>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            var allowRead = new TaskCompletionSource<bool>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            var store = new FakeTusStore
            {
                BeforeContentReadAsync = async cancellationToken =>
                {
                    readStarted.TrySetResult(true);
                    await allowRead.Task.WaitAsync(cancellationToken);
                }
            };
            store.AddFile(fileId, payload, CreateMetadata(album.Id, Sha256Hex(payload)));
            var fileComplete = CreateContext<FileCompleteContext>(TestHttpContext.Create(user.AuthSub), context =>
            {
                context.FileId = fileId;
                context.Store = store;
            });

            var finalizationTask = TusEventHandlers.OnFileCompleteAsync(fileComplete, provider);
            await readStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
            int cleaned;
            try
            {
                cleaned = await TusEventHandlers.CleanupExpiredReservationsAsync(provider);
            }
            finally
            {
                allowRead.TrySetResult(true);
            }

            await finalizationTask.WaitAsync(TimeSpan.FromSeconds(5));

            Assert.Equal(0, cleaned);
            _db.ChangeTracker.Clear();
            Assert.NotNull(await _db.Shards.FindAsync(Guid.Parse(fileId)));
            Assert.Null(await _db.TusUploadReservations.FindAsync(fileId));
            Assert.Equal(payload.Length, (await _db.UserQuotas.FindAsync(user.Id))!.UsedStorageBytes);
            Assert.Equal(
                TusUploadLifecycleState.COMMITTED,
                (await _db.TusUploadLifecycles.FindAsync(fileId))!.State);
        }
        finally
        {
            Directory.Delete(storagePath, recursive: true);
        }
    }

    [Fact]
    public async Task DeleteAuthorizationAndCallback_DoNotCancelReservationClaimedByFinalizer()
    {
        var builder = new TestDataBuilder(_db);
        var user = await builder.CreateUserAsync("delete-finalizer-race-user");
        var album = await builder.CreateAlbumAsync(user);
        var payload = Encoding.UTF8.GetBytes("termination callback racing completed upload finalization");
        var fileId = Guid.NewGuid().ToString();
        var quota = await _db.UserQuotas.FindAsync(user.Id);
        quota!.UsedStorageBytes = payload.Length;
        _db.TusUploadReservations.Add(new TusUploadReservation
        {
            FileId = fileId,
            UserId = user.Id,
            AlbumId = album.Id,
            ReservedBytes = payload.Length,
            UploadLength = payload.Length,
            ExpiresAt = DateTime.UtcNow.AddHours(1)
        });
        _db.TusUploadLifecycles.Add(new TusUploadLifecycle
        {
            FileId = fileId,
            UserId = user.Id,
            AlbumId = album.Id,
            ReservedBytes = payload.Length,
            UploadLength = payload.Length,
            ExpectedContentSha256 = Sha256Hex(payload),
            EnvelopeVersion = 3,
            State = TusUploadLifecycleState.CREATED
        });
        await _db.SaveChangesAsync();

        var readStarted = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var allowRead = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var store = new FakeTusStore
        {
            BeforeContentReadAsync = async cancellationToken =>
            {
                readStarted.TrySetResult(true);
                await allowRead.Task.WaitAsync(cancellationToken);
            }
        };
        store.AddFile(fileId, payload, CreateMetadata(album.Id, Sha256Hex(payload)));
        var fileComplete = CreateContext<FileCompleteContext>(TestHttpContext.Create(user.AuthSub), context =>
        {
            context.FileId = fileId;
            context.Store = store;
        });
        var deleteAuthorization = CreateContext<AuthorizeContext>(TestHttpContext.Create(user.AuthSub), context =>
        {
            context.FileId = fileId;
            context.Intent = IntentType.DeleteFile;
        });
        var deleteComplete = CreateContext<DeleteCompleteContext>(TestHttpContext.Create(user.AuthSub), context =>
        {
            context.FileId = fileId;
        });

        var finalizationTask = TusEventHandlers.OnFileCompleteAsync(fileComplete, _provider);
        await readStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var authorizationTask = TusEventHandlers.OnAuthorizeAsync(deleteAuthorization, _provider);
        try
        {
            Assert.NotSame(
                authorizationTask,
                await Task.WhenAny(authorizationTask, Task.Delay(100)));
        }
        finally
        {
            allowRead.TrySetResult(true);
        }

        await finalizationTask.WaitAsync(TimeSpan.FromSeconds(5));
        await authorizationTask.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(deleteAuthorization.HasFailed);
        Assert.Equal("Upload is already finalizing or completed", deleteAuthorization.ErrorMessage);

        // A callback that arrives after an already-authorized termination is
        // also harmless after finalization has consumed the reservation.
        await TusEventHandlers.OnDeleteCompleteAsync(deleteComplete, _provider);

        _db.ChangeTracker.Clear();
        Assert.NotNull(await _db.Shards.FindAsync(Guid.Parse(fileId)));
        Assert.Null(await _db.TusUploadReservations.FindAsync(fileId));
        Assert.Equal(payload.Length, (await _db.UserQuotas.FindAsync(user.Id))!.UsedStorageBytes);
        Assert.Equal(
            TusUploadLifecycleState.COMMITTED,
            (await _db.TusUploadLifecycles.FindAsync(fileId))!.State);
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
        var payload = new byte[1024];
        store.AddFile(reservation.FileId, payload, CreateMetadata(album.Id, Sha256Hex(payload)));

        var fileComplete = CreateContext<FileCompleteContext>(TestHttpContext.Create("revoked-user"), ctx =>
        {
            ctx.FileId = reservation.FileId;
            ctx.Store = store;
        });

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => TusEventHandlers.OnFileCompleteAsync(fileComplete, _provider));
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
            Metadata = CreateMetadata(albumId, ValidContentSha256)
        };

        SetHttpContext(ctx, httpContext);
        return ctx;
    }

    private static string Sha256Hex(byte[] content)
        => Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant();

    private static Dictionary<string, tusdotnet.Models.Metadata> CreateMetadata(
        Guid albumId,
        string? contentSha256 = ValidContentSha256,
        IReadOnlyDictionary<string, string>? extraMetadata = null,
        string? blobFormatVersion = "1",
        string? envelopeVersion = "3")
    {
        var header = $"albumId {Convert.ToBase64String(Encoding.UTF8.GetBytes(albumId.ToString()))}";
        if (contentSha256 != null)
        {
            header += $",content-sha256 {Convert.ToBase64String(Encoding.UTF8.GetBytes(contentSha256))}";
        }
        if (blobFormatVersion != null)
        {
            header += $",blob-format-version {Convert.ToBase64String(Encoding.UTF8.GetBytes(blobFormatVersion))}";
        }
        if (envelopeVersion != null)
        {
            header += $",envelope-version {Convert.ToBase64String(Encoding.UTF8.GetBytes(envelopeVersion))}";
        }
        if (extraMetadata != null)
        {
            foreach (var (key, value) in extraMetadata)
            {
                header += $",{key} {Convert.ToBase64String(Encoding.UTF8.GetBytes(value))}";
            }
        }

        return tusdotnet.Models.Metadata.Parse(header);
    }

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

    private sealed class ThrowBeforeReservationDeleteInterceptor : SaveChangesInterceptor
    {
        public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
            DbContextEventData eventData,
            InterceptionResult<int> result,
            CancellationToken cancellationToken = default)
        {
            if (eventData.Context?.ChangeTracker.Entries<TusUploadReservation>()
                .Any(entry => entry.State == EntityState.Deleted) == true)
            {
                return ValueTask.FromException<InterceptionResult<int>>(new ReservationDeleteFailureException());
            }

            return base.SavingChangesAsync(eventData, result, cancellationToken);
        }
    }

    private sealed class ReservationDeleteFailureException : Exception;

    private sealed class ThrowBeforeShardCommitInterceptor : SaveChangesInterceptor
    {
        public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
            DbContextEventData eventData,
            InterceptionResult<int> result,
            CancellationToken cancellationToken = default)
        {
            if (eventData.Context?.ChangeTracker.Entries<Shard>()
                .Any(entry => entry.State == EntityState.Added) == true)
            {
                return ValueTask.FromException<InterceptionResult<int>>(new PreCommitFailureException());
            }

            return base.SavingChangesAsync(eventData, result, cancellationToken);
        }
    }

    private sealed class PreCommitFailureException : Exception;

    private sealed class ThrowAfterCommitInterceptor : DbTransactionInterceptor
    {
        public override Task TransactionCommittedAsync(
            DbTransaction transaction,
            TransactionEndEventData eventData,
            CancellationToken cancellationToken = default)
            => eventData.Context?.ChangeTracker.Entries<Shard>().Any() == true
                ? Task.FromException(new CommitAcknowledgementLostException())
                : Task.CompletedTask;
    }

    private sealed class CommitAcknowledgementLostException : Exception;

    private sealed class FakeTusStore : ITusStore, ITusReadableStore, ITusTerminationStore
    {
        public Dictionary<string, FakeTusFile> Files { get; } = [];
        public Func<CancellationToken, Task>? BeforeContentReadAsync { get; init; }

        public void AddFile(string fileId, byte[] content, Dictionary<string, tusdotnet.Models.Metadata> metadata)
        {
            Files[fileId] = new FakeTusFile(fileId, content, metadata, BeforeContentReadAsync);
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

    private sealed class FakeTusFile(
        string id,
        byte[] content,
        Dictionary<string, tusdotnet.Models.Metadata> metadata,
        Func<CancellationToken, Task>? beforeContentReadAsync) : ITusFile
    {
        public string Id { get; } = id;
        public byte[] Content { get; } = content;
        private readonly Dictionary<string, tusdotnet.Models.Metadata> _metadata = metadata;

        public async Task<Stream> GetContentAsync(CancellationToken cancellationToken)
        {
            if (beforeContentReadAsync != null)
            {
                await beforeContentReadAsync(cancellationToken);
            }

            return new MemoryStream(Content, writable: false);
        }

        public Task<Dictionary<string, tusdotnet.Models.Metadata>> GetMetadataAsync(CancellationToken cancellationToken)
            => Task.FromResult(_metadata);
    }
}
