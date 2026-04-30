using Microsoft.EntityFrameworkCore;

namespace Mosaic.Backend.Extensions;

/// <summary>
/// Extension methods for database provider capability detection.
/// Centralizes the repeated SQLite/InMemory provider checks used throughout the codebase.
/// </summary>
public static class DbContextExtensions
{
    /// <summary>
    /// Returns true if the database provider is SQLite or InMemory.
    /// These providers lack support for PostgreSQL-specific features like
    /// FOR UPDATE row locking, NOW(), GREATEST(), etc.
    /// </summary>
    public static bool UsesLiteProvider(this DbContext db)
    {
        var provider = db.Database.ProviderName;
        return provider != null
            && (provider.Contains("Sqlite", StringComparison.OrdinalIgnoreCase)
                || provider.Contains("InMemory", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// Returns true if the provider supports EF Core bulk operations
    /// (ExecuteUpdate, ExecuteDelete). The InMemory provider does not.
    /// </summary>
    public static bool SupportsBulkOperations(this DbContext db)
    {
        var provider = db.Database.ProviderName;
        return provider == null
            || !provider.Contains("InMemory", StringComparison.OrdinalIgnoreCase);
    }
}
