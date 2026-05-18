extern alias TestcontainersPostgreSql;

using System.Reflection;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using Mosaic.Backend.Data;
using Npgsql;
using TestcontainersPostgreSql::Testcontainers.PostgreSql;
using Xunit;

namespace Mosaic.Backend.Tests.Integration;

/// <summary>
/// EF Core migration integration test harness (v1.0.1 s28).
///
/// Spins up an empty PostgreSQL container per test class, then exercises the
/// full migration chain found in <c>Mosaic.Backend/Migrations/</c> against it.
/// Each test gets a fresh database (created/dropped inside the running
/// container) so migrations always run from scratch — no cross-test bleed.
///
/// Tests are gated by <see cref="DockerRequiredFactAttribute"/> so they
/// gracefully skip on machines without Docker (CI matrix supports this).
/// </summary>
public sealed class MigrationTests : IClassFixture<MigrationTests.PostgresFixture>
{
    private readonly PostgresFixture _fixture;

    public MigrationTests(PostgresFixture fixture)
    {
        _fixture = fixture;
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task Migrations_ApplyFromScratch_Succeed()
    {
        var dbName = await _fixture.CreateEmptyDatabaseAsync();
        await using var db = _fixture.CreateDbContext(dbName);

        await db.Database.MigrateAsync();

        // Post-state: a representative set of tables / columns from
        // milestone migrations must exist. We pick load-bearing columns
        // (defaults from ManifestProtocolFinalization, the audit log
        // table from a later migration) rather than asserting the entire
        // schema, which would duplicate the snapshot.
        var tables = await GetTableNamesAsync(db);
        Assert.Contains("users", tables);
        Assert.Contains("albums", tables);
        Assert.Contains("manifests", tables);
        Assert.Contains("manifest_shards", tables);
        Assert.Contains("shards", tables);
        Assert.Contains("audit_log_entries", tables);

        var manifestShardsColumns = await GetColumnNamesAsync(db, "manifest_shards");
        Assert.Contains("sha256", manifestShardsColumns);
        Assert.Contains("content_length", manifestShardsColumns);
        Assert.Contains("shard_index", manifestShardsColumns);
        Assert.Contains("envelope_version", manifestShardsColumns);

        var manifestColumns = await GetColumnNamesAsync(db, "manifests");
        Assert.Contains("asset_type", manifestColumns);
        Assert.Contains("protocol_version", manifestColumns);
        Assert.Contains("metadata_version", manifestColumns);

        // __EFMigrationsHistory tracks applied migrations — it must list all
        // of them. If a migration silently skipped, the history table would
        // be short.
        var applied = await GetAppliedMigrationsAsync(db);
        var declared = GetDeclaredMigrationIds();
        Assert.Equal(declared.Count, applied.Count);
        Assert.Equal(declared.OrderBy(x => x).ToList(), applied.OrderBy(x => x).ToList());
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task Migrations_AreIdempotent()
    {
        var dbName = await _fixture.CreateEmptyDatabaseAsync();
        await using var db = _fixture.CreateDbContext(dbName);

        await db.Database.MigrateAsync();

        // Second application: with all migrations already in
        // __EFMigrationsHistory, MigrateAsync must be a no-op and must
        // not throw "column already exists" or duplicate-key errors.
        var exception = await Record.ExceptionAsync(() => db.Database.MigrateAsync());
        Assert.Null(exception);

        var applied = await GetAppliedMigrationsAsync(db);
        Assert.Equal(GetDeclaredMigrationIds().Count, applied.Count);
    }

    [Fact]
    [Trait("Category", "Integration")]
    public void Migrations_HaveMatchingDownMethods()
    {
        // Defensive check: every Migration in the assembly must implement
        // a real Down() body — not a stubbed throw NotImplementedException.
        // We don't actually roll back here (rollback semantics for data
        // migrations are intentionally one-way), but every up MUST have
        // SOMETHING reversible declared so a future operator can attempt it.
        var migrationTypes = typeof(MosaicDbContext).Assembly
            .GetTypes()
            .Where(t => typeof(Migration).IsAssignableFrom(t) && !t.IsAbstract)
            .Where(t => t.GetCustomAttribute<MigrationAttribute>() != null)
            .ToList();

        Assert.NotEmpty(migrationTypes);

        var failures = new List<string>();
        foreach (var migrationType in migrationTypes)
        {
            var migration = (Migration)Activator.CreateInstance(migrationType)!;
            var builder = new MigrationBuilder(activeProvider: "Npgsql.EntityFrameworkCore.PostgreSQL");

            try
            {
                // Invoke protected Down(MigrationBuilder) via reflection.
                var down = migrationType.GetMethod(
                    "Down",
                    BindingFlags.NonPublic | BindingFlags.Instance)!;
                down.Invoke(migration, new object[] { builder });
            }
            catch (TargetInvocationException tie)
                when (tie.InnerException is NotImplementedException)
            {
                failures.Add($"{migrationType.Name}: Down() throws NotImplementedException");
            }
            catch (TargetInvocationException tie)
            {
                failures.Add($"{migrationType.Name}: Down() threw {tie.InnerException?.GetType().Name}: {tie.InnerException?.Message}");
            }
        }

        Assert.Empty(failures);
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task Migrations_DataPreservedAcrossUpgrade()
    {
        var dbName = await _fixture.CreateEmptyDatabaseAsync();
        await using var db = _fixture.CreateDbContext(dbName);

        // Apply migrations up to just before ManifestProtocolFinalization.
        // We pick AddManifestExpiration as the "pre" snapshot — it is the
        // immediate predecessor and contains the manifests/shards/manifest_shards
        // schema in its pre-finalization shape.
        const string preMigration = "20260428210732_AddManifestExpiration";

        var migrator = db.Database.GetInfrastructure().GetRequiredService<IMigrator>();
        await migrator.MigrateAsync(preMigration);

        // Seed: insert one row directly using ExecuteSqlRawAsync because the
        // EF model reflects the LATEST schema and would reject inserts here.
        // We need rows in users / shards / albums / manifests / manifest_shards.
        var userId = Guid.NewGuid();
        var albumId = Guid.NewGuid();
        var manifestId = Guid.NewGuid();
        var shardId = Guid.NewGuid();
        var realSha256 = new string('a', 64);
        const long realSize = 1234;

        await SeedPreFinalizationRowsAsync(db, userId, albumId, manifestId, shardId, realSha256, realSize);

        // Apply the rest of the migrations.
        await migrator.MigrateAsync();

        // Verify the pre-existing row is still there and its newly-added
        // columns carry either the original wrong defaults or — after the
        // backfill migration — the reconstructed real values.
        await using (var conn = (NpgsqlConnection)db.Database.GetDbConnection())
        {
            if (conn.State != System.Data.ConnectionState.Open)
            {
                await conn.OpenAsync();
            }

            await using var cmd = conn.CreateCommand();
            cmd.CommandText = @"
                SELECT sha256, content_length, shard_index, envelope_version
                FROM manifest_shards
                WHERE manifest_id = @manifest_id AND shard_id = @shard_id";
            cmd.Parameters.Add(new NpgsqlParameter("manifest_id", manifestId));
            cmd.Parameters.Add(new NpgsqlParameter("shard_id", shardId));

            await using var reader = await cmd.ExecuteReaderAsync();
            Assert.True(await reader.ReadAsync(), "Pre-migration manifest_shards row was lost");

            var sha256 = reader.GetString(0);
            var contentLength = reader.GetInt64(1);
            var shardIndex = reader.GetInt32(2);
            var envelopeVersion = reader.GetInt32(3);

            // The ManifestProtocolFinalizationBackfill migration reconstructs
            // sha256 / content_length from the related shard row. The seeded
            // shard carries authoritative values, so they must propagate.
            Assert.Equal(realSha256, sha256);
            Assert.Equal(realSize, contentLength);

            // shard_index has no recoverable source — it retains its
            // wrong default and the backfill migration documents this.
            Assert.Equal(0, shardIndex);

            // envelope_version=3 default is correct for v0.3-era rows.
            Assert.Equal(3, envelopeVersion);
        }
    }

    [DockerRequiredFact]
    [Trait("Category", "Integration")]
    public async Task Backfill_LeavesOrphanRowsWithSentinelDefaults()
    {
        // Orphan case: manifest_shards row whose related shard has no
        // sha256 (NULL) cannot be backfilled. The migration must NOT
        // crash and must leave the sentinel defaults in place — there
        // is no authoritative source to reconstruct from.
        var dbName = await _fixture.CreateEmptyDatabaseAsync();
        await using var db = _fixture.CreateDbContext(dbName);

        const string preMigration = "20260428210732_AddManifestExpiration";
        var migrator = db.Database.GetInfrastructure().GetRequiredService<IMigrator>();
        await migrator.MigrateAsync(preMigration);

        var userId = Guid.NewGuid();
        var albumId = Guid.NewGuid();
        var manifestId = Guid.NewGuid();
        var shardId = Guid.NewGuid();

        // Seed with shard.sha256 = NULL — backfill source is missing.
        await SeedPreFinalizationRowsAsync(db, userId, albumId, manifestId, shardId, sha256: null, sizeBytes: 0);

        await migrator.MigrateAsync();

        var conn = (NpgsqlConnection)db.Database.GetDbConnection();
        var wasClosed = conn.State != System.Data.ConnectionState.Open;
        if (wasClosed)
        {
            await conn.OpenAsync();
        }
        try
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = @"SELECT sha256, content_length FROM manifest_shards
                                WHERE manifest_id = @m AND shard_id = @s";
            cmd.Parameters.Add(new NpgsqlParameter("m", manifestId));
            cmd.Parameters.Add(new NpgsqlParameter("s", shardId));
            await using var reader = await cmd.ExecuteReaderAsync();
            Assert.True(await reader.ReadAsync());

            // Orphan rows retain the sentinel defaults — backfill is a no-op
            // here because the WHERE clause requires shards.sha256 IS NOT NULL.
            Assert.Equal(string.Empty, reader.GetString(0));
            Assert.Equal(0L, reader.GetInt64(1));
        }
        finally
        {
            if (wasClosed)
            {
                await conn.CloseAsync();
            }
        }
    }

    private static async Task SeedPreFinalizationRowsAsync(
        MosaicDbContext db,
        Guid userId,
        Guid albumId,
        Guid manifestId,
        Guid shardId,
        string? sha256,
        long sizeBytes)
    {
        // Insert minimal rows into the v0.3-era schema. The columns added
        // by ManifestProtocolFinalization do not yet exist on manifest_shards
        // at this point, so we must NOT reference them here.
        // Column lists are pinned to the InitialCreate + AddManifestExpiration
        // schema — do not "modernize" them to match the current entity model.
        await db.Database.ExecuteSqlRawAsync(
            @"INSERT INTO users (id, auth_sub, identity_pubkey, created_at, is_admin, row_version)
              VALUES ({0}, {1}, {2}, NOW(), false, 1)",
            userId, $"seed-{userId:N}", new string('b', 64));

        // shards.sha256 is nullable in v0.3 — caller passes null for orphan case.
        if (sha256 is null)
        {
            await db.Database.ExecuteSqlRawAsync(
                @"INSERT INTO shards (id, uploader_id, storage_key, size_bytes, status, status_updated_at, sha256)
                  VALUES ({0}, {1}, {2}, {3}, 'ACTIVE', NOW(), NULL)",
                shardId, userId, $"seed/{shardId:N}", sizeBytes);
        }
        else
        {
            await db.Database.ExecuteSqlRawAsync(
                @"INSERT INTO shards (id, uploader_id, storage_key, size_bytes, status, status_updated_at, sha256)
                  VALUES ({0}, {1}, {2}, {3}, 'ACTIVE', NOW(), {4})",
                shardId, userId, $"seed/{shardId:N}", sizeBytes, sha256);
        }

        await db.Database.ExecuteSqlRawAsync(
            @"INSERT INTO albums (id, owner_id, current_epoch_id, current_version, created_at, updated_at, expiration_warning_days, row_version)
              VALUES ({0}, {1}, 1, 1, NOW(), NOW(), 0, 1)",
            albumId, userId);

        await db.Database.ExecuteSqlRawAsync(
            @"INSERT INTO manifests (id, album_id, version_created, is_deleted, encrypted_meta, signature, signer_pubkey, created_at, updated_at, row_version)
              VALUES ({0}, {1}, 1, false, {2}, {3}, {4}, NOW(), NOW(), 1)",
            manifestId, albumId, new byte[16], new string('0', 64), new string('1', 64));

        await db.Database.ExecuteSqlRawAsync(
            @"INSERT INTO manifest_shards (manifest_id, shard_id, chunk_index, tier)
              VALUES ({0}, {1}, 0, 3)",
            manifestId, shardId);
    }

    private static async Task<HashSet<string>> GetTableNamesAsync(MosaicDbContext db)
    {
        var conn = (NpgsqlConnection)db.Database.GetDbConnection();
        var wasClosed = conn.State != System.Data.ConnectionState.Open;
        if (wasClosed)
        {
            await conn.OpenAsync();
        }
        try
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = @"SELECT table_name FROM information_schema.tables
                                WHERE table_schema = 'public'";
            var names = new HashSet<string>(StringComparer.Ordinal);
            await using var reader = await cmd.ExecuteReaderAsync();
            while (await reader.ReadAsync())
            {
                names.Add(reader.GetString(0));
            }
            return names;
        }
        finally
        {
            if (wasClosed)
            {
                await conn.CloseAsync();
            }
        }
    }

    private static async Task<HashSet<string>> GetColumnNamesAsync(MosaicDbContext db, string table)
    {
        var conn = (NpgsqlConnection)db.Database.GetDbConnection();
        var wasClosed = conn.State != System.Data.ConnectionState.Open;
        if (wasClosed)
        {
            await conn.OpenAsync();
        }
        try
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = @"SELECT column_name FROM information_schema.columns
                                WHERE table_schema = 'public' AND table_name = @t";
            cmd.Parameters.Add(new NpgsqlParameter("t", table));
            var names = new HashSet<string>(StringComparer.Ordinal);
            await using var reader = await cmd.ExecuteReaderAsync();
            while (await reader.ReadAsync())
            {
                names.Add(reader.GetString(0));
            }
            return names;
        }
        finally
        {
            if (wasClosed)
            {
                await conn.CloseAsync();
            }
        }
    }

    private static async Task<List<string>> GetAppliedMigrationsAsync(MosaicDbContext db)
    {
        var ids = (await db.Database.GetAppliedMigrationsAsync()).ToList();
        return ids;
    }

    private static List<string> GetDeclaredMigrationIds()
    {
        return typeof(MosaicDbContext).Assembly
            .GetTypes()
            .Select(t => t.GetCustomAttribute<MigrationAttribute>())
            .Where(a => a != null)
            .Select(a => a!.Id)
            .ToList();
    }

    public sealed class PostgresFixture : IAsyncLifetime
    {
        private readonly PostgreSqlContainer _container = new PostgreSqlBuilder()
            .WithImage("postgres:16-alpine")
            .Build();

        public Task InitializeAsync() => _container.StartAsync();

        public async Task DisposeAsync() => await _container.DisposeAsync();

        /// <summary>
        /// Creates a fresh empty database inside the running container and
        /// returns its name. Each test must get a virgin database so the
        /// migration chain runs from scratch.
        /// </summary>
        public async Task<string> CreateEmptyDatabaseAsync()
        {
            var dbName = $"mig_{Guid.NewGuid():N}";
            var adminCs = _container.GetConnectionString();
            await using var conn = new NpgsqlConnection(adminCs);
            await conn.OpenAsync();
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = $"CREATE DATABASE \"{dbName}\"";
            await cmd.ExecuteNonQueryAsync();
            return dbName;
        }

        public MosaicDbContext CreateDbContext(string dbName)
        {
            var baseBuilder = new NpgsqlConnectionStringBuilder(_container.GetConnectionString())
            {
                Database = dbName
            };
            return new MosaicDbContext(new DbContextOptionsBuilder<MosaicDbContext>()
                .UseNpgsql(baseBuilder.ConnectionString)
                .Options);
        }
    }
}
