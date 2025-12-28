using Microsoft.Extensions.Logging;

namespace Mosaic.Backend.Tests.Helpers;

/// <summary>
/// Provides null loggers for testing that don't output anything.
/// </summary>
public static class NullLoggerFactory
{
    /// <summary>
    /// Creates a null logger for the specified type.
    /// </summary>
    public static ILogger<T> CreateNullLogger<T>()
    {
        return new Microsoft.Extensions.Logging.Abstractions.NullLogger<T>();
    }
}
