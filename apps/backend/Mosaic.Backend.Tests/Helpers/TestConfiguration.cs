using Microsoft.Extensions.Configuration;

namespace Mosaic.Backend.Tests.Helpers;

/// <summary>
/// Provides test configuration for controllers
/// </summary>
public static class TestConfiguration
{
    /// <summary>
    /// Creates a configuration with default quota settings
    /// </summary>
    public static IConfiguration Create(long defaultMaxBytes = 10737418240) // 10GB default
    {
        var configData = new Dictionary<string, string?>
        {
            ["Quota:DefaultMaxBytes"] = defaultMaxBytes.ToString(),
            ["Storage:Path"] = Path.GetTempPath()
        };

        return new ConfigurationBuilder()
            .AddInMemoryCollection(configData)
            .Build();
    }
}
