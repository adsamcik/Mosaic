using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Mosaic.Backend.Services;
using Xunit;

namespace Mosaic.Backend.Tests.Services;

public class IdempotencyRetentionTests
{
    [Fact]
    public void Defaults_ToAdr022ThirtyDayRetention()
    {
        var options = new IdempotencyOptions();

        Assert.Equal(TimeSpan.FromDays(30), options.RetentionPeriod);
        Assert.Equal(TimeSpan.FromDays(30), options.EffectiveRetentionPeriod);
    }

    [Fact]
    public void Validation_Fails_WhenConfiguredRetentionIsBelowAdr022Minimum()
    {
        var exception = Assert.Throws<OptionsValidationException>(() =>
            CreateOptions(new Dictionary<string, string?>
            {
                ["Idempotency:RetentionPeriod"] = "29.23:59:59"
            }).Value);

        Assert.Contains("Idempotency:RetentionPeriod", exception.Message);
        Assert.Contains("ADR-022", exception.Message);
    }

    [Theory]
    [InlineData("30.00:00:00")]
    [InlineData("31.00:00:00")]
    public void Validation_Allows_ConfiguredRetentionAtOrAboveAdr022Minimum(string retentionPeriod)
    {
        var options = CreateOptions(new Dictionary<string, string?>
        {
            ["Idempotency:RetentionPeriod"] = retentionPeriod
        }).Value;

        Assert.True(options.EffectiveRetentionPeriod >= IdempotencyOptionsValidator.MinimumRetentionPeriod);
    }

    private static IOptions<IdempotencyOptions> CreateOptions(Dictionary<string, string?> values)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();

        var services = new ServiceCollection();
        services.AddOptions<IdempotencyOptions>()
            .Bind(configuration.GetSection("Idempotency"))
            .ValidateOnStart();
        services.AddSingleton<IValidateOptions<IdempotencyOptions>, IdempotencyOptionsValidator>();

        return services.BuildServiceProvider()
            .GetRequiredService<IOptions<IdempotencyOptions>>();
    }
}
