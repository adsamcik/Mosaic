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
}
