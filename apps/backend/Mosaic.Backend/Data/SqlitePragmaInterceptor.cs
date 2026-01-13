using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore.Diagnostics;
using System.Data.Common;

namespace Mosaic.Backend.Data;

/// <summary>
/// Interceptor that sets SQLite pragmas for better concurrency support.
/// This is essential for E2E tests that run multiple browser sessions in parallel.
/// </summary>
public class SqlitePragmaInterceptor : DbConnectionInterceptor
{
    public override void ConnectionOpened(DbConnection connection, ConnectionEndEventData eventData)
    {
        if (connection is SqliteConnection sqliteConnection)
        {
            ConfigureSqlitePragmas(sqliteConnection);
        }
        base.ConnectionOpened(connection, eventData);
    }

    public override async Task ConnectionOpenedAsync(
        DbConnection connection,
        ConnectionEndEventData eventData,
        CancellationToken cancellationToken = default)
    {
        if (connection is SqliteConnection sqliteConnection)
        {
            ConfigureSqlitePragmas(sqliteConnection);
        }
        await base.ConnectionOpenedAsync(connection, eventData, cancellationToken);
    }

    private static void ConfigureSqlitePragmas(SqliteConnection connection)
    {
        // WAL mode enables concurrent readers with a single writer
        // This is essential for handling parallel E2E test workers
        using var cmd1 = connection.CreateCommand();
        cmd1.CommandText = "PRAGMA journal_mode = WAL;";
        cmd1.ExecuteNonQuery();

        // Busy timeout: wait up to 30 seconds for locks instead of failing immediately
        // This handles transient lock contention during parallel writes
        using var cmd2 = connection.CreateCommand();
        cmd2.CommandText = "PRAGMA busy_timeout = 30000;";
        cmd2.ExecuteNonQuery();

        // Synchronous NORMAL is a balance between safety and performance
        // FULL would be safer but slower; OFF is faster but risks corruption
        using var cmd3 = connection.CreateCommand();
        cmd3.CommandText = "PRAGMA synchronous = NORMAL;";
        cmd3.ExecuteNonQuery();
    }
}
