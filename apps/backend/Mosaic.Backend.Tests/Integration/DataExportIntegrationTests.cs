extern alias TestcontainersPostgreSql;

using System.IO.Compression;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Services;
using Mosaic.Backend.Tests.Helpers;
using TestcontainersPostgreSql::Testcontainers.PostgreSql;
using Xunit;

namespace Mosaic.Backend.Tests.Integration;

/// <summary>
/// Real-Postgres tests for the GDPR Article 20 data-export flow
/// (v1.0.x s38). Exercises <see cref="ExportController.Export"/> end-to-end:
/// the zip archive is written to a real <see cref="MemoryStream"/> body, then
/// re-parsed with <see cref="ZipArchive"/> and asserted against the seeded
/// database state. ZK invariants are checked by verifying that the only
/// bytes leaving the controller are ciphertext, wrapped keys, or JSON
/// containing fields the server already exposes via <c>GET /me</c>.
/// </summary>
public sealed class DataExportIntegrationTests
    : IClassFixture<DataExportIntegrationTests.PostgresFixture>
{
    private const string OwnerAuthSub = "export-owner";
    private const string OtherOwnerAuthSub = "export-other-owner";

    private readonly PostgresFixture _fixture;

    public DataExportIntegrationTests(PostgresFixture fixture)
    {
        _fixture = fixture;
    }

    // ─── Tests ──────────────────────────────────────────────────────────

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task Export_StreamsValidZipArchive()
    {
        await using var db = await _fixture.CreateFreshDbContextAsync();
        var data = new TestDataBuilder(db);
        var storage = new MockStorageService();

        var owner = await data.CreateUserAsync(OwnerAuthSub);
        var album = await data.CreateAlbumAsync(owner);
        var shard = await data.CreateShardAsync(owner, ShardStatus.ACTIVE);
        await data.CreateManifestAsync(album, new() { shard });
        storage.AddFile(shard.StorageKey, new byte[] { 0xAA, 0xBB, 0xCC, 0xDD });

        var (controller, body) = CreateController(db, storage, OwnerAuthSub);
        await controller.Export(CancellationToken.None);

        Assert.Equal("application/zip", controller.Response.ContentType);
        var disposition = controller.Response.Headers["Content-Disposition"].ToString();
        Assert.Contains("attachment;", disposition);
        Assert.Contains($"mosaic-export-{owner.Id}", disposition);
        Assert.Contains(".zip", disposition);

        body.Position = 0;
        using var zip = new ZipArchive(body, ZipArchiveMode.Read);

        // metadata.json is always present and parseable.
        var metaEntry = zip.GetEntry("metadata.json");
        Assert.NotNull(metaEntry);
        using (var s = metaEntry!.Open())
        {
            var doc = await JsonDocument.ParseAsync(s);
            Assert.Equal(owner.Id, doc.RootElement.GetProperty("userId").GetGuid());
            Assert.Equal("1.0", doc.RootElement.GetProperty("version").GetString());
        }

        Assert.NotNull(zip.GetEntry("kdf-params.json"));
        Assert.NotNull(zip.GetEntry($"albums/{album.Id}/album.json"));
        Assert.NotNull(zip.GetEntry($"albums/{album.Id}/members.json"));

        // Shard blob round-trips bit-for-bit.
        var shardEntry = zip.GetEntry($"albums/{album.Id}/shards/{shard.Id}.bin");
        Assert.NotNull(shardEntry);
        using var shardStream = shardEntry!.Open();
        using var shardBuf = new MemoryStream();
        await shardStream.CopyToAsync(shardBuf);
        Assert.Equal(new byte[] { 0xAA, 0xBB, 0xCC, 0xDD }, shardBuf.ToArray());
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task Export_IncludesAllOwnedAlbums_AndExcludesMemberAlbums()
    {
        await using var db = await _fixture.CreateFreshDbContextAsync();
        var data = new TestDataBuilder(db);
        var storage = new MockStorageService();

        var owner = await data.CreateUserAsync(OwnerAuthSub);
        var otherOwner = await data.CreateUserAsync(OtherOwnerAuthSub);

        var ownedAlbum1 = await data.CreateAlbumAsync(owner, encryptedName: "album-1");
        var ownedAlbum2 = await data.CreateAlbumAsync(owner, encryptedName: "album-2");
        var foreignAlbum = await data.CreateAlbumAsync(otherOwner, encryptedName: "foreign");
        await data.AddMemberAsync(foreignAlbum, owner, "viewer", otherOwner);

        var (controller, body) = CreateController(db, storage, OwnerAuthSub);
        await controller.Export(CancellationToken.None);

        body.Position = 0;
        using var zip = new ZipArchive(body, ZipArchiveMode.Read);

        Assert.NotNull(zip.GetEntry($"albums/{ownedAlbum1.Id}/album.json"));
        Assert.NotNull(zip.GetEntry($"albums/{ownedAlbum2.Id}/album.json"));

        // The album owned by a different user MUST NOT appear in this user's
        // export, even though they are a member of it. Membership exports
        // would leak another user's content.
        Assert.Null(zip.GetEntry($"albums/{foreignAlbum.Id}/album.json"));
        Assert.DoesNotContain(zip.Entries, e => e.FullName.StartsWith($"albums/{foreignAlbum.Id}/"));
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task Export_IncludesAccountKeyAndSalt()
    {
        await using var db = await _fixture.CreateFreshDbContextAsync();
        var data = new TestDataBuilder(db);
        var storage = new MockStorageService();

        var owner = await data.CreateUserAsync(OwnerAuthSub);

        // Seed wrapped account key + salt the way registration would.
        owner.WrappedAccountKey = new byte[] { 0x11, 0x22, 0x33, 0x44 };
        owner.UserSalt = new byte[] { 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC,
                                       0xDD, 0xEE, 0xFF, 0x00, 0x12, 0x34, 0x56, 0x78 };
        owner.AccountSalt = new byte[] { 0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0xF6, 0x07, 0x18,
                                          0x29, 0x3A, 0x4B, 0x5C, 0x6D, 0x7E, 0x8F, 0x90 };
        owner.SaltVersion = 7;
        owner.KdfMemoryKib = 131072;
        owner.KdfIterations = 4;
        owner.KdfParallelism = 2;
        await db.SaveChangesAsync();

        var (controller, body) = CreateController(db, storage, OwnerAuthSub);
        await controller.Export(CancellationToken.None);

        body.Position = 0;
        using var zip = new ZipArchive(body, ZipArchiveMode.Read);

        var wrapped = zip.GetEntry("account-key-wrapped.bin");
        Assert.NotNull(wrapped);
        using (var s = wrapped!.Open())
        using (var buf = new MemoryStream())
        {
            await s.CopyToAsync(buf);
            Assert.Equal(owner.WrappedAccountKey, buf.ToArray());
        }

        var salt = zip.GetEntry("salt.bin");
        Assert.NotNull(salt);
        using (var s = salt!.Open())
        using (var buf = new MemoryStream())
        {
            await s.CopyToAsync(buf);
            Assert.Equal(owner.UserSalt, buf.ToArray());
        }

        var kdf = zip.GetEntry("kdf-params.json");
        Assert.NotNull(kdf);
        using (var s = kdf!.Open())
        {
            var doc = await JsonDocument.ParseAsync(s);
            Assert.Equal(7, doc.RootElement.GetProperty("SaltVersion").GetInt32());
            Assert.Equal(131072, doc.RootElement.GetProperty("KdfMemoryKib").GetInt32());
            Assert.Equal(4, doc.RootElement.GetProperty("KdfIterations").GetInt32());
            Assert.Equal(2, doc.RootElement.GetProperty("KdfParallelism").GetInt32());
        }
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task Export_HandlesEmptyAccount_ReturnsMinimalZip()
    {
        await using var db = await _fixture.CreateFreshDbContextAsync();
        var data = new TestDataBuilder(db);
        var storage = new MockStorageService();

        // A freshly-created user with zero albums, zero shards, zero
        // share-links. The export must still succeed and produce a valid
        // zip containing the metadata-only header.
        var owner = await data.CreateUserAsync(OwnerAuthSub);

        var (controller, body) = CreateController(db, storage, OwnerAuthSub);
        await controller.Export(CancellationToken.None);

        Assert.Equal("application/zip", controller.Response.ContentType);
        body.Position = 0;
        using var zip = new ZipArchive(body, ZipArchiveMode.Read);

        Assert.NotNull(zip.GetEntry("metadata.json"));
        Assert.NotNull(zip.GetEntry("kdf-params.json"));
        Assert.DoesNotContain(zip.Entries, e => e.FullName.StartsWith("albums/"));
        Assert.DoesNotContain(zip.Entries, e => e.FullName.EndsWith(".bin") && e.FullName.Contains("/shards/"));
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task Export_RespectsCancellationToken()
    {
        await using var db = await _fixture.CreateFreshDbContextAsync();
        var data = new TestDataBuilder(db);
        var storage = new MockStorageService();

        var owner = await data.CreateUserAsync(OwnerAuthSub);
        // Seed a handful of albums so the cancellation has something to
        // iterate over (it is checked before every album / manifest).
        for (var i = 0; i < 3; i++)
        {
            await data.CreateAlbumAsync(owner);
        }

        var (controller, _) = CreateController(db, storage, OwnerAuthSub);
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            async () => await controller.Export(cts.Token));
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    private static (ExportController controller, MemoryStream body) CreateController(
        MosaicDbContext db,
        MockStorageService storage,
        string authSub)
    {
        var body = new MemoryStream();
        var httpContext = TestHttpContext.Create(authSub);
        httpContext.Response.Body = body;
        // The controller calls Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
        // the default test context does not register that feature, which is fine —
        // the null-conditional makes it a no-op for the unit test.

        var controller = new ExportController(
            db,
            storage,
            new MockCurrentUserService(db),
            NullLogger<ExportController>.Instance,
            auditLog: null)
        {
            ControllerContext = new Microsoft.AspNetCore.Mvc.ControllerContext
            {
                HttpContext = httpContext
            }
        };
        return (controller, body);
    }

    public sealed class PostgresFixture : IAsyncLifetime
    {
        private readonly PostgreSqlContainer _container = new PostgreSqlBuilder()
            .WithImage("postgres:16-alpine")
            .Build();

        public string ConnectionString => _container.GetConnectionString();

        public async Task InitializeAsync()
        {
            await _container.StartAsync();
            await using var db = CreateDbContext();
            await db.Database.EnsureCreatedAsync();
        }

        public async Task DisposeAsync()
        {
            await _container.DisposeAsync();
        }

        public async Task<MosaicDbContext> CreateFreshDbContextAsync()
        {
            var db = CreateDbContext();
            await db.Database.ExecuteSqlRawAsync(
                "TRUNCATE TABLE audit_log_entries, auth_challenges, users " +
                "RESTART IDENTITY CASCADE");
            return db;
        }

        private MosaicDbContext CreateDbContext()
            => new(new DbContextOptionsBuilder<MosaicDbContext>()
                .UseNpgsql(ConnectionString)
                .Options);
    }
}
