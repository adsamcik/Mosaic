using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Mosaic.Backend.Controllers;
using Mosaic.Backend.Data;
using Mosaic.Backend.Data.Entities;
using Mosaic.Backend.Models.Manifests;
using Mosaic.Backend.Tests.Helpers;
using Xunit;

namespace Mosaic.Backend.Tests.Controllers;

public class ManifestControllerIfMatchTests
{
    private const string OwnerAuthSub = "manifest-if-match-owner";

    [Fact]
    public async Task UpdateMetadata_StaleIfMatch_Returns412()
    {
        using var db = TestDbContextFactory.Create();
        var (controller, manifest, signerPubkey, _) = await SeedControllerAsync(db);
        controller.HttpContext.Request.Headers.IfMatch = "\"999\"";

        var result = await controller.UpdateMetadata(
            manifest.Id,
            CreateUpdateRequest(TestDataBuilder.GenerateRandomBytes(20), signerPubkey));

        var preconditionFailed = Assert.IsType<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status412PreconditionFailed, preconditionFailed.StatusCode);
        var persisted = await db.Manifests.SingleAsync(m => m.Id == manifest.Id);
        Assert.Equal(1, persisted.MetadataVersion);
    }

    [Fact]
    public async Task UpdateMetadata_MatchingIfMatch_Succeeds_AndBumpsETag()
    {
        using var db = TestDbContextFactory.Create();
        var (controller, manifest, signerPubkey, _) = await SeedControllerAsync(db);
        controller.HttpContext.Request.Headers.IfMatch = "\"1\"";

        var result = await controller.UpdateMetadata(
            manifest.Id,
            CreateUpdateRequest(TestDataBuilder.GenerateRandomBytes(20), signerPubkey));

        Assert.IsType<OkObjectResult>(result);
        Assert.Equal("\"2\"", controller.HttpContext.Response.Headers["ETag"].ToString());
        var persisted = await db.Manifests.SingleAsync(m => m.Id == manifest.Id);
        Assert.Equal(2, persisted.MetadataVersion);
    }

    [Fact]
    public async Task UpdateMetadata_AbsentIfMatch_AcceptsWithWarning()
    {
        using var db = TestDbContextFactory.Create();
        var (controller, manifest, signerPubkey, logger) = await SeedControllerAsync(db);

        var result = await controller.UpdateMetadata(
            manifest.Id,
            CreateUpdateRequest(TestDataBuilder.GenerateRandomBytes(20), signerPubkey));

        Assert.IsType<OkObjectResult>(result);
        Assert.Equal("\"2\"", controller.HttpContext.Response.Headers["ETag"].ToString());
        Assert.Equal("true", controller.HttpContext.Response.Headers["Deprecation"].ToString());
        Assert.Contains(logger.Entries, entry => entry.LogLevel == LogLevel.Warning);
    }

    private static async Task<(ManifestsController Controller, Manifest Manifest, byte[] SignerPubkey, CapturingLogger<ManifestsController> Logger)> SeedControllerAsync(MosaicDbContext db)
    {
        var config = TestConfiguration.Create();
        var builder = new TestDataBuilder(db);
        var signerPubkey = TestDataBuilder.GenerateRandomBytes(32);
        var owner = await builder.CreateUserAsync(OwnerAuthSub);
        var album = await builder.CreateAlbumAsync(owner, currentVersion: 7);
        await builder.CreateEpochKeyAsync(album, owner, signPubkey: signerPubkey);
        var shard = await builder.CreateShardAsync(owner, ShardStatus.ACTIVE);
        var manifest = await builder.CreateManifestAsync(album, [shard], encryptedMeta: TestDataBuilder.GenerateRandomBytes(16));
        var logger = new CapturingLogger<ManifestsController>();
        var controller = new ManifestsController(
            db,
            TestConfiguration.CreateQuotaService(db, config),
            new MockCurrentUserService(db),
            logger)
        {
            ControllerContext = { HttpContext = TestHttpContext.Create(OwnerAuthSub) }
        };
        return (controller, manifest, signerPubkey, logger);
    }

    private static UpdateManifestMetadataRequest CreateUpdateRequest(byte[] encryptedMeta, byte[] signerPubkey)
        => new(
            Convert.ToBase64String(encryptedMeta),
            Convert.ToBase64String(TestDataBuilder.GenerateRandomBytes(64)),
            Convert.ToBase64String(signerPubkey));

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<(LogLevel LogLevel, string Message)> Entries { get; } = [];

        public IDisposable BeginScope<TState>(TState state) where TState : notnull => NullScope.Instance;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
            => Entries.Add((logLevel, formatter(state, exception)));

        private sealed class NullScope : IDisposable
        {
            public static readonly NullScope Instance = new();

            public void Dispose()
            {
            }
        }
    }
}
