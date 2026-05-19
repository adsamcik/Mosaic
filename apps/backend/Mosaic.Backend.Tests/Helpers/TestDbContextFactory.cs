using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Mosaic.Backend.Data;

namespace Mosaic.Backend.Tests.Helpers;

/// <summary>
/// Factory for creating isolated in-memory database contexts for testing
/// </summary>
public static class TestDbContextFactory
{
    /// <summary>
    /// Creates a new in-memory database context with a unique database name
    /// </summary>
    public static MosaicDbContext Create()
    {
        var options = new DbContextOptionsBuilder<MosaicDbContext>()
            .UseInMemoryDatabase(databaseName: Guid.NewGuid().ToString())
            .ConfigureWarnings(w => w.Ignore(InMemoryEventId.TransactionIgnoredWarning))
            .Options;

        var context = new MosaicDbContext(options);
        context.Database.EnsureCreated();
        return context;
    }

    /// <summary>
    /// Creates an in-memory database context with a caller-supplied database name
    /// so multiple contexts can share state (used to simulate concurrent writes).
    /// Optional EF Core interceptors can be attached for race-condition tests.
    /// </summary>
    public static MosaicDbContext CreateNamed(string databaseName, params IInterceptor[] interceptors)
    {
        var builder = new DbContextOptionsBuilder<MosaicDbContext>()
            .UseInMemoryDatabase(databaseName: databaseName)
            .ConfigureWarnings(w => w.Ignore(InMemoryEventId.TransactionIgnoredWarning));

        if (interceptors.Length > 0)
        {
            builder = builder.AddInterceptors(interceptors);
        }

        var context = new MosaicDbContext(builder.Options);
        context.Database.EnsureCreated();
        return context;
    }
}
