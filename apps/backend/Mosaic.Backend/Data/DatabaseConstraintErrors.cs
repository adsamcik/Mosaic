using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Mosaic.Backend.Data;

internal static class DatabaseConstraintErrors
{
    public static bool IsUniqueViolation(DbUpdateException exception)
    {
        for (Exception? current = exception; current != null; current = current.InnerException)
        {
            if (current is PostgresException { SqlState: "23505" })
            {
                return true;
            }

            if (current is SqliteException { SqliteErrorCode: 19 })
            {
                return true;
            }
        }

        return false;
    }
}
